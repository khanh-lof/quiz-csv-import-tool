package csvgen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Client calls an OpenAI-compatible /chat/completions endpoint.
type Client struct {
	http    *http.Client
	baseURL string
	apiKey  string
	model   string
	// intelligenceModels are the creative-mode models for "Độ thông minh" 1..IntelligenceLevels.
	// Empty means every level uses model.
	intelligenceModels []string
	// timeLimit is the deadline the caller gives one call (LLM_TIMEOUT_SECONDS), told to the model in the
	// creative prompt. The caller's context still enforces it.
	timeLimit time.Duration
	// baseBackoff is the first retry delay, doubled per attempt; tests shrink it.
	baseBackoff time.Duration
	// stallTimeout is how long a streamed answer may stay silent (see stallTimeout); tests shrink it.
	stallTimeout time.Duration
	logger       *slog.Logger
}

func NewClient(baseURL, apiKey, model string, intelligenceModels []string, timeLimit time.Duration, logger *slog.Logger) *Client {
	return &Client{
		// No client-level timeout: the caller's context carries the deadline (LLM_TIMEOUT_SECONDS),
		// so a timeout surfaces as context.DeadlineExceeded rather than an opaque transport error.
		http:               &http.Client{},
		baseURL:            strings.TrimRight(baseURL, "/"),
		apiKey:             apiKey,
		model:              model,
		intelligenceModels: intelligenceModels,
		timeLimit:          timeLimit,
		baseBackoff:        defaultBaseBackoff,
		stallTimeout:       stallTimeout,
		logger:             logger,
	}
}

// modelFor returns the creative-mode model for the requested intelligence level.
func (c *Client) modelFor(opts Options) string {
	if len(c.intelligenceModels) == 0 {
		return c.model
	}
	level := opts.Intelligence
	if level < 1 || level > len(c.intelligenceModels) {
		level = DefaultIntelligence
	}
	return c.intelligenceModels[level-1]
}

// Result is what Generate produced: the CSV, which for a Radicals job is the exercise's JSON, and for a Radicals
// job only, the Source it was built from (see ReviseRadicals). Usage is filled in whether or not Generate failed.
type Result struct {
	CSV    string
	Source string
	Usage  Usage
}

// Usage is the model a generation asked and, over all its attempts, the calls made and the tokens billed.
type Usage struct {
	Model        string
	Calls        int
	InputTokens  int
	CachedTokens int
	OutputTokens int
}

func (u *Usage) add(tokens tokenUsage) {
	u.InputTokens += tokens.input()
	u.CachedTokens += tokens.cached()
	u.OutputTokens += tokens.output()
}

// tokenUsage is the usage object of a chat completion (prompt_/completion_tokens; DeepSeek reports its cache
// hits as prompt_cache_hit_tokens) or of a response (input_/output_tokens).
type tokenUsage struct {
	PromptTokens         int `json:"prompt_tokens"`
	CompletionTokens     int `json:"completion_tokens"`
	PromptCacheHitTokens int `json:"prompt_cache_hit_tokens"`
	PromptTokensDetails  struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	InputTokens        int `json:"input_tokens"`
	OutputTokens       int `json:"output_tokens"`
	InputTokensDetails struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
}

func (t tokenUsage) input() int  { return t.PromptTokens + t.InputTokens }
func (t tokenUsage) output() int { return t.CompletionTokens + t.OutputTokens }
func (t tokenUsage) cached() int {
	return max(t.PromptCacheHitTokens, t.PromptTokensDetails.CachedTokens, t.InputTokensDetails.CachedTokens)
}

// Generate returns the CSV the model produced. creative selects the platform-specific prompt
// (rows only, no header) over the simple two-column vocabulary prompt (header included).
// The creative mode goes through /responses, whose web search tool finds the Wayground images; the
// simple mode stays on /chat/completions. A Radicals exercise is not a CSV: Generate returns its JSON
// (see generateRadicals).
func (c *Client) Generate(ctx context.Context, images []Image, creative bool, opts Options) (Result, error) {
	return c.GenerateWithProgress(ctx, images, creative, opts, nil)
}

// GenerateWithProgress is Generate that also reports, through onRows when it is not nil, how many rows of the CSV
// the model has written so far; a retry starts again from 0. A Radicals exercise reports none.
func (c *Client) GenerateWithProgress(ctx context.Context, images []Image, creative bool, opts Options, onRows func(rows int)) (Result, error) {
	usage := &Usage{Model: c.model}
	if creative {
		usage.Model = c.modelFor(opts)
	}
	result, err := c.generate(ctx, images, creative, opts, usage, onRows)
	result.Usage = *usage
	return result, err
}

func (c *Client) generate(ctx context.Context, images []Image, creative bool, opts Options, usage *Usage, onRows func(int)) (Result, error) {
	if creative && opts.ExportType == Radicals {
		return c.generateRadicals(ctx, images, opts, usage)
	}
	var (
		content string
		err     error
	)
	if creative {
		content, err = c.respond(ctx, buildCreativeRequest(usage.Model, c.timeLimit, images, opts), usage, onRows)
	} else {
		content, err = c.complete(ctx, buildSimpleRequest(usage.Model, images, opts.Language), usage, onRows)
	}
	if err != nil {
		return Result{}, err
	}
	csv, err := c.checkedCSV(ctx, ExtractCSVContent(content), creative, opts, usage)
	if err != nil {
		return Result{}, err
	}
	return Result{CSV: csv}, nil
}

// answerFormat reads the 2xx answer of one endpoint, whole (parse) or streamed (stream).
type answerFormat struct {
	parse  func([]byte) (string, tokenUsage, error)
	stream func(body io.Reader, seen func(real bool), rows *rowCounter) (string, tokenUsage, error)
}

var (
	completionFormat = answerFormat{parse: parseCompletion, stream: streamCompletion}
	responseFormat   = answerFormat{parse: parseResponse, stream: streamResponse}
)

// post sends req as JSON to path and returns the model's text. It retries transient failures, including a
// generation interrupted or stalled inside a 2xx answer (see withRetry), which is why the answer is read in each
// attempt. Every attempt is counted in usage and logged in one line, with the start of the body only when the
// attempt failed, or at Debug.
func (c *Client) post(ctx context.Context, path string, req any, format answerFormat, usage *Usage, onRows func(int)) (string, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	reported := false
	return c.withRetry(ctx, path, func() (string, error) {
		usage.Calls++
		var rows *rowCounter
		if onRows != nil {
			if reported {
				onRows(0)
			}
			rows = &rowCounter{report: func(n int) {
				reported = true
				onRows(n)
			}}
		}
		started := time.Now()
		text, tokens, reply, err := c.postOnce(ctx, path, body, format, rows)
		usage.add(tokens)
		attrs := []any{"path", path, "model", usage.Model, "attempt", usage.Calls, "durationMs", time.Since(started).Milliseconds()}
		if reply != nil {
			// x-request-id identifies this attempt to the provider's support.
			attrs = append(attrs, "status", reply.status, "requestId", reply.requestID, "streamed", reply.streamed,
				"bytes", reply.bytes)
		}
		attrs = append(attrs, "inputTokens", tokens.input(), "cachedTokens", tokens.cached(), "outputTokens", tokens.output())
		if err != nil {
			if reply != nil {
				attrs = append(attrs, "body", reply.bodyForLog())
			}
			c.logger.Warn("LLM call failed", append(attrs, "error", err)...)
			return "", err
		}
		c.logger.Info("LLM call", attrs...)
		c.logger.Debug("LLM answer", "path", path, "body", reply.bodyForLog())
		return text, nil
	})
}

// maxLoggedBody is how much of an LLM response a log line keeps: enough for an error envelope or the start of
// an answer, not a whole quiz, which is user content and can be hundreds of KB.
const maxLoggedBody = 2048

// llmReply is what one HTTP answer from the provider was, for the log: its first maxLoggedBody bytes only.
type llmReply struct {
	status    int
	requestID string
	streamed  bool
	bytes     int
	head      []byte
}

func (r *llmReply) bodyForLog() string {
	if r.bytes > len(r.head) {
		return string(r.head) + "…"
	}
	return string(r.head)
}

// headRecorder passes a body through, counting its bytes and keeping its start in reply.
type headRecorder struct {
	body  io.Reader
	reply *llmReply
}

func (h *headRecorder) Read(p []byte) (int, error) {
	n, err := h.body.Read(p)
	h.reply.bytes += n
	if room := maxLoggedBody - len(h.reply.head); room > 0 {
		h.reply.head = append(h.reply.head, p[:min(n, room)]...)
	}
	return n, err
}

// postOnce makes one attempt and reads its answer: the model's text and the tokens billed, and the reply for the
// log whenever there was one. A streamed answer that goes silent for stallTimeout is given up as interrupted, so
// the retry can try again while time is left.
func (c *Client) postOnce(ctx context.Context, path string, body []byte, format answerFormat, rows *rowCounter) (string, tokenUsage, *llmReply, error) {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return "", tokenUsage{}, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return "", tokenUsage{}, nil, &transportError{err}
	}
	defer resp.Body.Close()
	reply := &llmReply{
		status: resp.StatusCode, requestID: resp.Header.Get("X-Request-Id"), streamed: isEventStream(resp.Header.Get("Content-Type")),
	}
	recorder := &headRecorder{body: resp.Body, reply: reply}

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		respBody, err := io.ReadAll(recorder)
		if err != nil {
			return "", tokenUsage{}, reply, &transportError{fmt.Errorf("reading LLM response: %w", err)}
		}
		var envelope struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(respBody, &envelope)
		return "", tokenUsage{}, reply, &StatusError{
			Status:     resp.StatusCode,
			Code:       envelope.Error.Code,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
	}

	if reply.streamed {
		watchdog := newStallWatchdog(c.stallTimeout, func() { cancel(errStalled) })
		defer watchdog.stop()
		text, tokens, err := format.stream(recorder, watchdog.seen, rows)
		if err != nil && errors.Is(context.Cause(ctx), errStalled) {
			err = &interruptedError{errStalled.Error()}
		}
		return text, tokens, reply, err
	}

	respBody, err := io.ReadAll(recorder)
	if err != nil {
		return "", tokenUsage{}, reply, &transportError{fmt.Errorf("reading LLM response: %w", err)}
	}
	if len(bytes.TrimSpace(respBody)) == 0 {
		// Only the keep-alive blank lines came: the connection closed before the answer.
		return "", tokenUsage{}, reply, &interruptedError{"empty response"}
	}
	text, tokens, err := format.parse(respBody)
	return text, tokens, reply, err
}

func (c *Client) complete(ctx context.Context, req chatRequest, usage *Usage, onRows func(int)) (string, error) {
	req.Stream, req.StreamOptions = true, &streamOptions{IncludeUsage: true}
	return c.post(ctx, "/chat/completions", req, completionFormat, usage, onRows)
}

func parseCompletion(respBody []byte) (string, tokenUsage, error) {
	var completion struct {
		Usage   tokenUsage `json:"usage"`
		Choices []struct {
			Message struct {
				Content *string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &completion); err != nil {
		return "", tokenUsage{}, &badOutputError{fmt.Errorf("decoding LLM response: %w", err)}
	}
	tokens := completion.Usage
	if len(completion.Choices) == 0 {
		return "", tokens, &badOutputError{errors.New("LLM response has no choices")}
	}
	choice := completion.Choices[0]
	content := ""
	if msg := choice.Message.Content; msg != nil {
		content = *msg
	}
	content, err := completionOutcome(content, choice.FinishReason)
	return content, tokens, err
}

// completionOutcome is the answer of a chat completion that finished for finish.
func completionOutcome(content, finish string) (string, error) {
	switch finish {
	case "insufficient_system_resource", "aborted":
		return "", &interruptedError{finish}
	case "length", "content_filter":
		// The rows are cut off; answering with them would import a broken quiz.
		return "", &incompleteError{finish}
	}
	return content, nil
}

func (c *Client) respond(ctx context.Context, req responsesRequest, usage *Usage, onRows func(int)) (string, error) {
	req.Stream = true
	return c.post(ctx, "/responses", req, responseFormat, usage, onRows)
}

func parseResponse(respBody []byte) (string, tokenUsage, error) {
	var response struct {
		Usage  tokenUsage `json:"usage"`
		Status string     `json:"status"`
		Error  struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
		Output []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(respBody, &response); err != nil {
		return "", tokenUsage{}, &badOutputError{fmt.Errorf("decoding LLM response: %w", err)}
	}
	tokens := response.Usage
	if response.Status == "failed" {
		// A request the provider refuses is a 4xx; this one was accepted and broke while generating.
		return "", tokens, &interruptedError{fmt.Sprintf("response failed (%s): %s", response.Error.Code, response.Error.Message)}
	}
	if response.Status == "incomplete" {
		reason := ""
		if response.IncompleteDetails != nil {
			reason = response.IncompleteDetails.Reason
		}
		// The rows are cut off; answering with them would import a broken quiz.
		return "", tokens, &incompleteError{reason}
	}
	// Tool calls and reasoning are output items too; the answer is the text of the message items.
	var text strings.Builder
	for _, item := range response.Output {
		if item.Type != "message" {
			continue
		}
		for _, part := range item.Content {
			if part.Type == "output_text" {
				text.WriteString(part.Text)
			}
		}
	}
	return text.String(), tokens, nil
}

var (
	fencedCSV    = regexp.MustCompile("(?i)```(?:csv)?\\s*([\\s\\S]*?)```")
	simpleHeader = regexp.MustCompile(`(?i)(?:^|\n)(Câu hỏi\s*,\s*Đáp án[\s\S]*)`)
)

// ExtractCSVContent strips markdown code fences or leading prose the model sometimes adds despite
// being told to return CSV only.
func ExtractCSVContent(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if m := fencedCSV.FindStringSubmatch(trimmed); m != nil {
		return strings.TrimSpace(m[1])
	}
	if m := simpleHeader.FindStringSubmatch(trimmed); m != nil {
		return strings.TrimSpace(m[1])
	}
	return trimmed
}
