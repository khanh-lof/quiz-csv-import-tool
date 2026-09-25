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

// buildSimpleRequest asks for a two-column CSV (Câu hỏi / Đáp án), header included, that the client
// loads into its vocabulary table.
func buildSimpleRequest(model string, images []Image) chatRequest {
	parts := []contentPart{textPart("Convert the image to CSV using the required format.")}
	// Plain transcription: low reasoning effort is enough and is the cheapest rate.
	return newRequest(model, simpleSystemPrompt, "low", append(parts, imageParts(images)...))
}

// buildCreativeRequest asks for ready-to-import rows, without a header, laid out for the target
// platform; the client prepends the header and downloads the file directly.
func buildCreativeRequest(model string, images []Image, opts Options) chatRequest {
	intro := "Convert the images to CSV using the required format."
	if len(images) == 0 {
		intro = "No image is provided. Use the standard vocabulary list of the lesson identified below, and generate the CSV using the required format."
	}
	parts := []contentPart{textPart(intro)}
	for _, msg := range exportTypeMessages(opts.ExportType) {
		parts = append(parts, textPart(msg))
	}
	for _, msg := range lessonMessages(opts) {
		parts = append(parts, textPart(msg))
	}
	// No reasoning effort: the model is picked by "Độ thông minh" and some of them (gpt-6-astra) have
	// no effort levels, so each runs at its own default.
	return newRequest(model, creativeSystemPrompt, "", append(parts, imageParts(images)...))
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
		MaxCompletionTokens: 10000,
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
			ImageURL: &imageURL{URL: "data:" + img.ContentType + ";base64," + base64.StdEncoding.EncodeToString(img.Data)},
		})
	}
	return parts
}

// normalizePrompt undoes a CRLF checkout of the embedded prompt files and drops the trailing newline.
func normalizePrompt(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
}
