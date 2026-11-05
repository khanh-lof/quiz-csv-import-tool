package csvgen

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// sseServer answers attempt n (from 1) by calling write with a flushing event writer.
func sseServer(t *testing.T, write func(n int, w *sseWriter, r *http.Request)) (*Client, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(calls.Add(1))
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		write(n, &sseWriter{w: w}, r)
	}))
	t.Cleanup(llm.Close)
	c := NewClient(llm.URL, "key", "m", nil, 0, slog.New(slog.DiscardHandler))
	c.baseBackoff = time.Millisecond
	return c, &calls
}

type sseWriter struct{ w http.ResponseWriter }

func (s *sseWriter) raw(text string) {
	_, _ = io.WriteString(s.w, text)
	s.w.(http.Flusher).Flush()
}

func (s *sseWriter) event(v any) {
	data, _ := json.Marshal(v)
	s.raw("data: " + string(data) + "\n\n")
}

func textDelta(text string) map[string]any {
	return map[string]any{"type": "response.output_text.delta", "delta": text}
}

func completed(text string) map[string]any {
	return map[string]any{"type": "response.completed", "response": map[string]any{
		"status": "completed", "usage": map[string]any{"input_tokens": 10, "output_tokens": 4},
		"output": []any{map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": text}}}},
	}}
}

func TestGenerateStreamsAChatCompletion(t *testing.T) {
	c, _ := sseServer(t, func(_ int, w *sseWriter, r *http.Request) {
		var req struct {
			Stream        bool `json:"stream"`
			StreamOptions struct {
				IncludeUsage bool `json:"include_usage"`
			} `json:"stream_options"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if !req.Stream || !req.StreamOptions.IncludeUsage {
			t.Errorf("request does not ask for a stream with usage: %+v", req)
		}
		w.raw(": keep-alive\n\n")
		for _, part := range []string{"```csv\nCâu hỏi,Đáp án\n", "你,bạn\n好", ",tốt\n```"} {
			w.event(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": part}}}})
		}
		w.event(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{}, "finish_reason": "stop"}}})
		w.event(map[string]any{"choices": []any{}, "usage": map[string]any{"prompt_tokens": 7, "completion_tokens": 3}})
		w.raw("data: [DONE]\n\n")
	})

	var rows []int
	result, err := c.GenerateWithProgress(context.Background(), []Image{{ContentType: "image/png", Data: []byte("x")}}, false, Options{},
		func(n int) { rows = append(rows, n) })
	if err != nil || result.CSV != "Câu hỏi,Đáp án\n你,bạn\n好,tốt" {
		t.Fatalf("got %q, %v", result.CSV, err)
	}
	if !slices.Equal(rows, []int{1, 2}) {
		t.Errorf("rows reported %v, want [1 2]", rows)
	}
	if want := (Usage{Model: "m", Calls: 1, InputTokens: 7, OutputTokens: 3}); result.Usage != want {
		t.Errorf("usage %+v, want %+v", result.Usage, want)
	}
}

func TestGenerateStreamsAResponse(t *testing.T) {
	c, _ := sseServer(t, func(_ int, w *sseWriter, r *http.Request) {
		var req struct {
			Stream bool `json:"stream"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if !req.Stream {
			t.Error("request does not ask for a stream")
		}
		w.event(map[string]any{"type": "response.created"})
		w.event(map[string]any{"type": "keep_alive"})
		w.event(textDelta("a,1\nb,"))
		w.event(textDelta("2\n"))
		w.event(completed("a,1\nb,2\n"))
	})

	var rows []int
	result, err := c.GenerateWithProgress(context.Background(), nil, true, Options{}, func(n int) { rows = append(rows, n) })
	if err != nil || result.CSV != "a,1\nb,2" || !slices.Equal(rows, []int{1, 2}) {
		t.Fatalf("got %q, %v, rows %v", result.CSV, err, rows)
	}
	if result.Usage.InputTokens != 10 || result.Usage.OutputTokens != 4 {
		t.Errorf("usage %+v", result.Usage)
	}
}

func TestStreamedResponseWithoutOutputInTheFinalEventUsesTheDeltas(t *testing.T) {
	c, _ := sseServer(t, func(_ int, w *sseWriter, _ *http.Request) {
		w.event(textDelta("a,1\n"))
		w.event(map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed"}})
	})
	if result, err := c.Generate(context.Background(), nil, true, Options{}); err != nil || result.CSV != "a,1" {
		t.Fatalf("got %q, %v", result.CSV, err)
	}
}

func TestStreamedIncompleteResponseIsTruncated(t *testing.T) {
	c, calls := sseServer(t, func(_ int, w *sseWriter, _ *http.Request) {
		w.event(textDelta("a,1\n"))
		w.event(map[string]any{"type": "response.incomplete", "response": map[string]any{
			"status": "incomplete", "incomplete_details": map[string]any{"reason": "max_output_tokens"}}})
	})
	_, err := c.Generate(context.Background(), nil, true, Options{})
	if FailureCode(err) != FailureTruncated || calls.Load() != 1 {
		t.Fatalf("got %v (%s) after %d calls", err, FailureCode(err), calls.Load())
	}
}

func TestStreamThatEndsEarlyIsRetriedAndProgressStartsOver(t *testing.T) {
	c, calls := sseServer(t, func(n int, w *sseWriter, _ *http.Request) {
		w.event(textDelta("a,1\n"))
		if n == 1 {
			return // the connection closes before the answer is complete
		}
		w.event(completed("a,1\n"))
	})
	var rows []int
	result, err := c.GenerateWithProgress(context.Background(), nil, true, Options{}, func(n int) { rows = append(rows, n) })
	if err != nil || result.CSV != "a,1" || calls.Load() != 2 {
		t.Fatalf("got %q, %v after %d calls", result.CSV, err, calls.Load())
	}
	if !slices.Equal(rows, []int{1, 0, 1}) {
		t.Errorf("rows reported %v, want [1 0 1]", rows)
	}
}

func TestStreamErrorEventIsRetried(t *testing.T) {
	c, calls := sseServer(t, func(n int, w *sseWriter, _ *http.Request) {
		if n == 1 {
			w.event(map[string]any{"type": "error", "message": "overloaded"})
			return
		}
		w.event(completed("a,1"))
	})
	if result, err := c.Generate(context.Background(), nil, true, Options{}); err != nil || result.CSV != "a,1" || calls.Load() != 2 {
		t.Fatalf("got %q, %v after %d calls", result.CSV, err, calls.Load())
	}
}

func TestStalledStreamIsGivenUpAndRetried(t *testing.T) {
	c, calls := sseServer(t, func(n int, w *sseWriter, r *http.Request) {
		w.event(textDelta("a,1\n"))
		if n == 1 {
			// Started, then silent but for keep-alives, which no longer count once the model has started.
			for {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(10 * time.Millisecond):
					w.raw(": keep-alive\n\n")
				}
			}
		}
		w.event(completed("a,1"))
	})
	c.stallTimeout = 50 * time.Millisecond
	result, err := c.Generate(context.Background(), nil, true, Options{})
	if err != nil || result.CSV != "a,1" || calls.Load() != 2 {
		t.Fatalf("got %q, %v after %d calls", result.CSV, err, calls.Load())
	}
}

func TestKeepAlivesHoldAStreamThatHasNotStarted(t *testing.T) {
	c, calls := sseServer(t, func(_ int, w *sseWriter, _ *http.Request) {
		// Queued for longer than the stall timeout, with keep-alives.
		for range 10 {
			time.Sleep(15 * time.Millisecond)
			w.raw(": keep-alive\n\n")
		}
		w.event(completed("a,1"))
	})
	c.stallTimeout = 50 * time.Millisecond
	if result, err := c.Generate(context.Background(), nil, true, Options{}); err != nil || result.CSV != "a,1" || calls.Load() != 1 {
		t.Fatalf("got %q, %v after %d calls", result.CSV, err, calls.Load())
	}
}

func TestReadEventsJoinsDataLinesAndSkipsComments(t *testing.T) {
	stream := ": hi\r\nevent: x\r\ndata: one\r\ndata:two\r\n\r\ndata: three\n"
	var events []string
	keepAlives := 0
	err := readEvents(strings.NewReader(stream), func(real bool) {
		if !real {
			keepAlives++
		}
	}, func(data []byte) error {
		events = append(events, string(data))
		return nil
	})
	if err != nil || !slices.Equal(events, []string{"one\ntwo", "three"}) || keepAlives != 1 {
		t.Fatalf("events %q, keep-alives %d, %v", events, keepAlives, err)
	}
}

func TestRowCounterSkipsFencesBlankLinesAndTheHeader(t *testing.T) {
	var got []int
	counter := &rowCounter{report: func(n int) { got = append(got, n) }}
	for _, delta := range []string{"```", "csv\n\nCâu hỏi, Đáp án\n", "a,", "1\n", "\n", "b,2\n```\n", "c,3"} {
		counter.write(delta)
	}
	if !slices.Equal(got, []int{1, 2}) {
		t.Fatalf("rows %v, want [1 2]", got)
	}
	var nilCounter *rowCounter
	nilCounter.write("a\n") // counts nothing, and does not panic
}
