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
	logger             *slog.Logger
}

func NewClient(baseURL, apiKey, model string, intelligenceModels []string, logger *slog.Logger) *Client {
	return &Client{
		// Long outputs (up to 10k tokens) can take minutes.
		http:               &http.Client{Timeout: 5 * time.Minute},
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
func (c *Client) Generate(ctx context.Context, images []Image, creative bool, opts Options) (string, error) {
	req := buildSimpleRequest(c.model, images)
	if creative {
		req = buildCreativeRequest(c.modelFor(opts), images, opts)
	}
	body, err := json.Marshal(req)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("calling LLM: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading LLM response: %w", err)
	}
	c.logger.Info("LLM response", "status", resp.StatusCode, "body", string(respBody))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("LLM returned status %d", resp.StatusCode)
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
	return ExtractCSVContent(content), nil
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
