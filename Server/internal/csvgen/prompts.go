package csvgen

import (
	_ "embed"
	"encoding/base64"
	"fmt"
	"strings"
)

var (
	//go:embed prompts/simple_system.txt
	simpleSystemPrompt string
	//go:embed prompts/creative_system.txt
	creativeSystemPrompt string
	//go:embed prompts/wayground_template.txt
	waygroundTemplate string
)

// Image is one uploaded lesson photo.
type Image struct {
	ContentType string
	Data        []byte
}

type chatRequest struct {
	Model               string        `json:"model"`
	Messages            []chatMessage `json:"messages"`
	MaxCompletionTokens int           `json:"max_completion_tokens"`
	ReasoningEffort     string        `json:"reasoning_effort,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // string, or []contentPart for multimodal user messages
}

type contentPart struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *imageURL `json:"image_url,omitempty"`
}

type imageURL struct {
	URL string `json:"url"`
}

// responsesRequest is an OpenAI /responses call, used by the creative mode because web search is a
// Responses API tool.
type responsesRequest struct {
	Model           string           `json:"model"`
	Instructions    string           `json:"instructions"`
	Input           []responsesInput `json:"input"`
	MaxOutputTokens int              `json:"max_output_tokens"`
	Tools           []responsesTool  `json:"tools,omitempty"`
}

type responsesInput struct {
	Role    string      `json:"role"`
	Content []inputPart `json:"content"`
}

type inputPart struct {
	Type     string `json:"type"` // input_text or input_image
	Text     string `json:"text,omitempty"`
	ImageURL string `json:"image_url,omitempty"`
}

type responsesTool struct {
	Type string `json:"type"`
}

const (
	maxOutputTokens = 10000
	// Searching for images adds reasoning between the searches, which counts as output.
	maxOutputTokensWithSearch = 16000
)

// buildSimpleRequest asks for a two-column CSV (Câu hỏi / Đáp án), header included, that the client
// loads into its vocabulary table.
func buildSimpleRequest(model string, images []Image) chatRequest {
	parts := []contentPart{textPart("Convert the image to CSV using the required format.")}
	// Plain transcription: low reasoning effort is enough and is the cheapest rate.
	return newRequest(model, simpleSystemPrompt, "low", append(parts, imageParts(images)...))
}

// buildCreativeRequest asks for ready-to-import rows, without a header, laid out for the target
// platform; the client prepends the header and downloads the file directly.
func buildCreativeRequest(model string, images []Image, opts Options) responsesRequest {
	intro := "Convert the images to CSV using the required format."
	if len(images) == 0 {
		intro = "No image is provided. Follow the LESSON SOURCE section: identify the textbook for the course and level below, recall the new words of that lesson, and generate the CSV using the required format."
	}
	texts := append([]string{intro}, exportTypeMessages(opts.ExportType)...)
	texts = append(texts, lessonMessages(opts)...)
	content := make([]inputPart, 0, len(texts)+len(images))
	for _, text := range texts {
		content = append(content, inputPart{Type: "input_text", Text: text})
	}
	for _, img := range images {
		content = append(content, inputPart{Type: "input_image", ImageURL: dataURL(img)})
	}
	// No reasoning effort: the model is picked by "Độ thông minh" and some of them (gpt-6-astra) have
	// no effort levels, so each runs at its own default.
	req := responsesRequest{
		Model:           model,
		Instructions:    normalizePrompt(creativeSystemPrompt),
		Input:           []responsesInput{{Role: "user", Content: content}},
		MaxOutputTokens: maxOutputTokens,
	}
	// Only Wayground has an image column; web search lets the model find real Pexels photos for it.
	if opts.ExportType == Wayground {
		req.Tools = []responsesTool{{Type: "web_search"}}
		req.MaxOutputTokens = maxOutputTokensWithSearch
	}
	return req
}

func lessonMessages(opts Options) []string {
	msgs := []string{"Course: " + opts.CourseDisplayName()}
	if opts.Level != nil {
		msgs = append(msgs, fmt.Sprintf("Level: %d", *opts.Level))
	} else {
		msgs = append(msgs, "Level: this course has no level, none was given.")
	}
	if opts.LessonNumber != nil {
		msgs = append(msgs, fmt.Sprintf("Lesson number: %d", *opts.LessonNumber))
	}
	return msgs
}

// exportTypeMessages describes the platform's import columns to the model. They must match the
// CsvHeader of the corresponding client-side CsvBuilder.
func exportTypeMessages(t ExportType) []string {
	switch t {
	case GimKit:
		return []string{"CSV columns: Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2 (Optional),Incorrect Answer 3 (Optional)"}
	case Blooket:
		return []string{"CSV columns: Question #,Question Text,Answer 1,Answer 2,Answer 3,Answer 4,Time Limit (sec),Correct Answer(s)"}
	case Wayground:
		return []string{
			"CSV columns: Question Text,Question Type,Option 1,Option 2,Option 3,Option 4,Option 5,Correct Answer,Time in seconds,Image Link,Answer explanation",
			`Question type will be ""Multiple Choice"" or ""Fill-in-the-Blank"". The option 2-5 must be empty for ""Fill-in-the-Blank"", the option 1 is the correct answer`,
			normalizePrompt(waygroundTemplate),
			"Image Link: fill it for at least half of the rows, following the IMAGE USAGE section. Plan the images before writing the questions.",
		}
	}
	panic(fmt.Sprintf("csvgen: unknown export type %d", t))
}

func newRequest(model, systemPrompt, reasoningEffort string, userParts []contentPart) chatRequest {
	return chatRequest{
		Model: model,
		Messages: []chatMessage{
			{Role: "system", Content: normalizePrompt(systemPrompt)},
			{Role: "user", Content: userParts},
		},
		MaxCompletionTokens: maxOutputTokens,
		ReasoningEffort:     reasoningEffort,
	}
}

func textPart(text string) contentPart {
	return contentPart{Type: "text", Text: text}
}

func imageParts(images []Image) []contentPart {
	parts := make([]contentPart, 0, len(images))
	for _, img := range images {
		parts = append(parts, contentPart{
			Type:     "image_url",
			ImageURL: &imageURL{URL: dataURL(img)},
		})
	}
	return parts
}

func dataURL(img Image) string {
	return "data:" + img.ContentType + ";base64," + base64.StdEncoding.EncodeToString(img.Data)
}

// normalizePrompt undoes a CRLF checkout of the embedded prompt files and drops the trailing newline.
func normalizePrompt(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
}
