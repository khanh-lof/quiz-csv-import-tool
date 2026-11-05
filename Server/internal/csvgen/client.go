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
	logger      *slog.Logger
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
	usage := &Usage{Model: c.model}
	if creative {
		usage.Model = c.modelFor(opts)
	}
	result, err := c.generate(ctx, images, creative, opts, usage)
	result.Usage = *usage
	return result, err
}

func (c *Client) generate(ctx context.Context, images []Image, creative bool, opts Options, usage *Usage) (Result, error) {
	if creative && opts.ExportType == Radicals {
		return c.generateRadicals(ctx, images, opts, usage)
	}
	var (
		content string
		err     error
	)
	if creative {
		content, err = c.respond(ctx, buildCreativeRequest(usage.Model, c.timeLimit, images, opts), usage)
	} else {
		content, err = c.complete(ctx, buildSimpleRequest(usage.Model, images, opts.Language), usage)
	}
	if err != nil {
		return Result{}, err
	}
	return Result{CSV: ExtractCSVContent(content)}, nil
}

// post sends req as JSON to path and returns the model's text, read by parse from the body of a 2xx
// response. It retries transient failures, including a generation interrupted inside a 2xx response
// (see withRetry), which is why parse runs in each attempt. Every attempt is counted in usage and logged in one
// line, with the body only when the attempt failed, or at Debug.
func (c *Client) post(ctx context.Context, path string, req any, parse func([]byte) (string, tokenUsage, error), usage *Usage) (string, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	return c.withRetry(ctx, path, func() (string, error) {
		usage.Calls++
		started := time.Now()
		reply, err := c.postOnce(ctx, path, body)
		attrs := []any{"path", path, "model", usage.Model, "attempt", usage.Calls, "durationMs", time.Since(started).Milliseconds()}
		if reply != nil {
			// x-request-id identifies this attempt to the provider's support.
			attrs = append(attrs, "status", reply.status, "requestId", reply.requestID, "bytes", len(reply.body))
		}
		if err != nil {
			if reply != nil {
				attrs = append(attrs, "body", bodyForLog(reply.body))
			}
			c.logger.Warn("LLM call failed", append(attrs, "error", err)...)
			return "", err
		}
		text, tokens, err := parse(reply.body)
		usage.add(tokens)
		attrs = append(attrs, "inputTokens", tokens.input(), "cachedTokens", tokens.cached(), "outputTokens", tokens.output())
		if err != nil {
			c.logger.Warn("LLM call failed", append(attrs, "error", err, "body", bodyForLog(reply.body))...)
			return "", err
		}
		c.logger.Info("LLM call", attrs...)
		c.logger.Debug("LLM answer", "path", path, "body", bodyForLog(reply.body))
		return text, nil
	})
}

// maxLoggedBody is how much of an LLM response a log line keeps: enough for an error envelope or the start of
// an answer, not a whole quiz, which is user content and can be hundreds of KB.
const maxLoggedBody = 2048

func bodyForLog(body []byte) string {
	if len(body) <= maxLoggedBody {
		return string(body)
	}
	return string(body[:maxLoggedBody]) + "…"
}

// llmReply is one HTTP answer from the provider.
type llmReply struct {
	status    int
	requestID string
	body      []byte
}

// postOnce returns the reply along with the error of a non-2xx or empty answer, so the caller can log it.
func (c *Client) postOnce(ctx context.Context, path string, body []byte) (*llmReply, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, &transportError{err}
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &transportError{fmt.Errorf("reading LLM response: %w", err)}
	}
	reply := &llmReply{status: resp.StatusCode, requestID: resp.Header.Get("X-Request-Id"), body: respBody}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var envelope struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(respBody, &envelope)
		return reply, &StatusError{
			Status:     resp.StatusCode,
			Code:       envelope.Error.Code,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
	}
	if len(bytes.TrimSpace(respBody)) == 0 {
		// Only the keep-alive blank lines came: the connection closed before the answer.
		return reply, &interruptedError{"empty response"}
	}
	return reply, nil
}

func (c *Client) complete(ctx context.Context, req chatRequest, usage *Usage) (string, error) {
	return c.post(ctx, "/chat/completions", req, parseCompletion, usage)
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
	switch choice.FinishReason {
	case "insufficient_system_resource", "aborted":
		return "", tokens, &interruptedError{choice.FinishReason}
	case "length", "content_filter":
		// The rows are cut off; answering with them would import a broken quiz.
		return "", tokens, &incompleteError{choice.FinishReason}
	}
	content := ""
	if msg := choice.Message.Content; msg != nil {
		content = *msg
	}
	return content, tokens, nil
}

func (c *Client) respond(ctx context.Context, req responsesRequest, usage *Usage) (string, error) {
	return c.post(ctx, "/responses", req, parseResponse, usage)
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
