package csvgen

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
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
	logger             *slog.Logger
}

func NewClient(baseURL, apiKey, model string, intelligenceModels []string, logger *slog.Logger) *Client {
	return &Client{
		// No client-level timeout: the caller's context carries the deadline (LLM_TIMEOUT_SECONDS),
		// so a timeout surfaces as context.DeadlineExceeded rather than an opaque transport error.
		http:               &http.Client{},
		baseURL:            strings.TrimRight(baseURL, "/"),
		apiKey:             apiKey,
		model:              model,
		intelligenceModels: intelligenceModels,
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

// Generate returns the CSV the model produced. creative selects the platform-specific prompt
// (rows only, no header) over the simple two-column vocabulary prompt (header included).
// The creative mode goes through /responses, whose web search tool finds the Wayground images; the
// simple mode stays on /chat/completions.
func (c *Client) Generate(ctx context.Context, images []Image, creative bool, opts Options) (string, error) {
	var (
		content string
		err     error
	)
	if creative {
		content, err = c.respond(ctx, buildCreativeRequest(c.modelFor(opts), images, opts))
	} else {
		content, err = c.complete(ctx, buildSimpleRequest(c.model, images))
	}
	if err != nil {
		return "", err
	}
	return ExtractCSVContent(content), nil
}

// post sends req as JSON to path and returns the body of a 2xx response.
func (c *Client) post(ctx context.Context, path string, req any) ([]byte, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("calling LLM: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading LLM response: %w", err)
	}
	c.logger.Info("LLM response", "path", path, "status", resp.StatusCode, "body", string(respBody))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("LLM returned status %d", resp.StatusCode)
	}
	return respBody, nil
}

func (c *Client) complete(ctx context.Context, req chatRequest) (string, error) {
	respBody, err := c.post(ctx, "/chat/completions", req)
	if err != nil {
		return "", err
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content *string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &completion); err != nil {
		return "", fmt.Errorf("decoding LLM response: %w", err)
	}
	if len(completion.Choices) == 0 {
		return "", fmt.Errorf("LLM response has no choices")
	}
	content := ""
	if msg := completion.Choices[0].Message.Content; msg != nil {
		content = *msg
	}
	return content, nil
}

func (c *Client) respond(ctx context.Context, req responsesRequest) (string, error) {
	respBody, err := c.post(ctx, "/responses", req)
	if err != nil {
		return "", err
	}
	var response struct {
		Status            string `json:"status"`
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
		return "", fmt.Errorf("decoding LLM response: %w", err)
	}
	if response.Status == "incomplete" {
		reason := ""
		if response.IncompleteDetails != nil {
			reason = response.IncompleteDetails.Reason
		}
		// The rows are cut off; answering with them would import a broken quiz.
		return "", fmt.Errorf("LLM response is incomplete: %s", reason)
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
	return text.String(), nil
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
