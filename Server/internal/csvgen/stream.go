package csvgen

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

// The calls stream (stream: true): the answer arrives as server-sent events, which shows progress while the model
// writes and lets a silent generation be given up long before the deadline. A provider that ignores the flag
// answers with plain JSON, which is read as before.

// stallTimeout is how long a streaming answer may go without an event once the model has started. Before that,
// the provider's keep-alives also count: it is still queueing the request, and a retry would only queue again.
const stallTimeout = 90 * time.Second

var errStalled = errors.New("no output for too long")

// stallWatchdog fires stalled when seen has not been called for limit.
type stallWatchdog struct {
	timer   *time.Timer
	limit   time.Duration
	started bool
}

func newStallWatchdog(limit time.Duration, stalled func()) *stallWatchdog {
	return &stallWatchdog{timer: time.AfterFunc(limit, stalled), limit: limit}
}

// seen records something read from the stream: an event, or a keep-alive (real false).
func (w *stallWatchdog) seen(real bool) {
	if real {
		w.started = true
	}
	if real || !w.started {
		w.timer.Reset(w.limit)
	}
}

func (w *stallWatchdog) stop() { w.timer.Stop() }

func isEventStream(contentType string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "text/event-stream")
}

// maxEventSize bounds one event; the final event of a response carries the whole answer.
const maxEventSize = 32 << 20

// readEvents calls onEvent with the data of each server-sent event and seen(false) for each comment, the
// keep-alive DeepSeek sends while the request waits. An error from onEvent stops the reading and is returned
// as it is; a failed read is a transportError.
func readEvents(body io.Reader, seen func(real bool), onEvent func(data []byte) error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64<<10), maxEventSize)
	var data []byte
	dispatch := func() error {
		if data == nil {
			return nil
		}
		event := data
		data = nil
		return onEvent(event)
	}
	for scanner.Scan() {
		line := bytes.TrimSuffix(scanner.Bytes(), []byte("\r"))
		switch {
		case len(line) == 0:
			if err := dispatch(); err != nil {
				return err
			}
		case line[0] == ':':
			seen(false)
		case bytes.HasPrefix(line, []byte("data:")):
			value := bytes.TrimPrefix(bytes.TrimPrefix(line, []byte("data:")), []byte(" "))
			if data != nil {
				data = append(data, '\n')
			}
			data = append(data, value...)
		}
	}
	if err := scanner.Err(); err != nil {
		return &transportError{fmt.Errorf("reading LLM stream: %w", err)}
	}
	return dispatch()
}

// streamCompletion reads a streamed chat completion: content deltas, a finish_reason, and usage in the last chunk
// (stream_options.include_usage), then [DONE].
func streamCompletion(body io.Reader, seen func(bool), rows *rowCounter) (string, tokenUsage, error) {
	var (
		text   strings.Builder
		tokens tokenUsage
		finish string
	)
	err := readEvents(body, seen, func(data []byte) error {
		if string(bytes.TrimSpace(data)) == "[DONE]" {
			return nil
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Usage *tokenUsage `json:"usage"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(data, &chunk); err != nil {
			return &badOutputError{fmt.Errorf("decoding LLM stream: %w", err)}
		}
		if chunk.Error != nil {
			return &interruptedError{"stream error: " + chunk.Error.Message}
		}
		seen(true)
		if chunk.Usage != nil {
			tokens = *chunk.Usage
		}
		if len(chunk.Choices) > 0 {
			choice := chunk.Choices[0]
			text.WriteString(choice.Delta.Content)
			rows.write(choice.Delta.Content)
			if choice.FinishReason != nil && *choice.FinishReason != "" {
				finish = *choice.FinishReason
			}
		}
		return nil
	})
	if err != nil {
		return "", tokens, err
	}
	if finish == "" {
		return "", tokens, &interruptedError{"stream ended before the answer did"}
	}
	content, err := completionOutcome(text.String(), finish)
	return content, tokens, err
}

// streamResponse reads a streamed /responses answer: output_text deltas for progress, then a response.completed,
// .incomplete or .failed event whose response is read like a non-streamed one.
func streamResponse(body io.Reader, seen func(bool), rows *rowCounter) (string, tokenUsage, error) {
	var (
		text  strings.Builder
		final json.RawMessage
	)
	err := readEvents(body, seen, func(data []byte) error {
		var event struct {
			Type     string          `json:"type"`
			Delta    string          `json:"delta"`
			Response json.RawMessage `json:"response"`
			Message  string          `json:"message"`
		}
		if err := json.Unmarshal(data, &event); err != nil {
			return &badOutputError{fmt.Errorf("decoding LLM stream: %w", err)}
		}
		switch event.Type {
		case "keep_alive":
			seen(false)
			return nil
		case "error":
			return &interruptedError{"stream error: " + event.Message}
		case "response.output_text.delta":
			text.WriteString(event.Delta)
			rows.write(event.Delta)
		case "response.completed", "response.incomplete", "response.failed":
			final = event.Response
		}
		seen(true)
		return nil
	})
	if err != nil {
		return "", tokenUsage{}, err
	}
	if final == nil {
		return "", tokenUsage{}, &interruptedError{"stream ended before the answer did"}
	}
	answer, tokens, err := parseResponse(final)
	if err == nil && answer == "" {
		// The final event may leave the output out; the deltas are the same text.
		answer = text.String()
	}
	return answer, tokens, err
}

// rowCounter counts the rows of a CSV answer as it streams in, for progress: complete lines that are not
// empty, a markdown fence, or the simple mode's header. A nil rowCounter counts nothing.
type rowCounter struct {
	partial string
	rows    int
	report  func(rows int)
}

var simpleHeaderLine = regexp.MustCompile(`(?i)^Câu hỏi\s*,\s*Đáp án`)

func (r *rowCounter) write(delta string) {
	if r == nil {
		return
	}
	for {
		i := strings.IndexByte(delta, '\n')
		if i < 0 {
			r.partial += delta
			return
		}
		line := strings.TrimSpace(r.partial + delta[:i])
		r.partial, delta = "", delta[i+1:]
		if line == "" || strings.HasPrefix(line, "```") || simpleHeaderLine.MatchString(line) {
			continue
		}
		r.rows++
		r.report(r.rows)
	}
}
