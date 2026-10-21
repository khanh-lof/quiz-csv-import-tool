package csvgen

import (
	_ "embed"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"text/template"
)

var (
	//go:embed prompts/simple_system.txt
	simpleSystemPrompt string
	//go:embed prompts/creative_system.txt
	creativeSystemPrompt string
	//go:embed prompts/wayground_template.txt
	waygroundTemplate string
	// The Game message is built from two files: the framing, a text/template that fills in the
	// chosen stages, and the six stage rules, of which only the chosen ones are sent.
	//go:embed prompts/gesture_quiz_template.txt
	gestureQuizTemplate string
	//go:embed prompts/gesture_quiz_stages.txt
	gestureQuizStages string
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
	maxOutputTokens = 32000
	// maxOutputTokensLarge is for requests whose answer or reasoning is longer than the usual budget
	// covers: Wayground's image searches add reasoning between the searches, and a gesture quiz of
	// more than gestureRowsInBaseBudget rows is a long answer. It is a ceiling, billing follows what
	// the model actually writes. Reasoning counts as output, so a quiz close to the base budget would
	// otherwise risk an incomplete response, which fails the whole call.
	maxOutputTokensLarge = 64000
	// gestureRowsInBaseBudget is the size of the default gesture quiz (six stages of five questions),
	// the largest one the base budget was sized for.
	gestureRowsInBaseBudget = 30
)

// buildSimpleRequest asks for a two-column CSV (Câu hỏi / Đáp án), header included, that the client
// loads into its vocabulary table.
func buildSimpleRequest(model string, images []Image) chatRequest {
	parts := []contentPart{textPart("Convert the image to CSV using the required format.")}
	// Plain transcription: low reasoning effort is enough and is the cheapest rate.
	return newRequest(model, simpleSystemPrompt, "low", append(parts, imageParts(images)...))
}

// buildCreativeRequest asks for ready-to-import rows, without a header, laid out for the target
// platform; the client prepends the header and downloads the file directly (or, for GestureQuiz,
// plays it itself).
func buildCreativeRequest(model string, images []Image, opts Options) responsesRequest {
	intro := "Convert the images to CSV using the required format."
	if len(images) == 0 {
		intro = "No image is provided. Follow the LESSON SOURCE section: identify the textbook for the course and level below, recall the new words of that lesson, and generate the CSV using the required format."
	}
	// A lesson of an embedded textbook is sent as the LESSON MATERIAL, after the course, level and
	// lesson number and before the images, and replaces the model's recall of the lesson.
	material := ""
	if book, lesson := textbookFor(opts), opts.LessonNumber; book != nil && lesson != nil {
		material = lessonMaterial(book, *lesson)
	}
	if material != "" {
		intro = "The LESSON MATERIAL message below is the lesson, taken from the textbook; the images show the part of it to focus on. Generate the CSV using the required format."
		if len(images) == 0 {
			intro = "Follow the LESSON SOURCE section: the LESSON MATERIAL message below is the lesson, taken from the textbook. Generate the CSV using the required format."
		}
	}
	texts := append([]string{intro}, exportTypeMessages(opts)...)
	texts = append(texts, lessonMessages(opts)...)
	if material != "" {
		texts = append(texts, material)
	}
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
		req.MaxOutputTokens = maxOutputTokensLarge
	}
	if opts.ExportType == GestureQuiz && len(opts.GestureQuizStages())*opts.GestureQuizQuestions() > gestureRowsInBaseBudget {
		req.MaxOutputTokens = maxOutputTokensLarge
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
// CsvHeader of the corresponding client-side CsvBuilder, or for GestureQuiz the columns the game's
// own CSV parser reads. The options only matter to GestureQuiz, whose stages the teacher chooses.
func exportTypeMessages(opts Options) []string {
	switch opts.ExportType {
	case GimKit:
		return []string{"CSV columns: Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2 (Optional),Incorrect Answer 3 (Optional)"}
	case Blooket:
		return []string{"CSV columns: Question #,Question Text,Answer 1,Answer 2,Answer 3,Answer 4,Time Limit (sec),Correct Answer(s)"}
	case Wayground:
		return []string{
			"CSV columns: Question Text,Question Type,Option 1,Option 2,Option 3,Option 4,Option 5,Correct Answer,Time in seconds,Image Link,Answer explanation",
			`Question type will be ""Multiple Choice"" or ""Fill-in-the-Blank"". The option 2-5 must be empty for ""Fill-in-the-Blank"", the option 1 is the correct answer`,
			normalizePrompt(waygroundTemplate),
			"Image Link: fill it only for questions that cannot be answered without the image, and make at least half of the rows such visual questions, following the IMAGE USAGE section. Plan the images before writing the questions.",
		}
	case GestureQuiz:
		// The stage rules carry the whole format, including how many rows to write, so unlike
		// Wayground there is no message after the template.
		return []string{
			"CSV columns: Stage,Question,Correct Answer,Wrong Answer 1,Wrong Answer 2,Wrong Answer 3,Explanation",
			buildGestureQuizMessage(opts),
		}
	}
	panic(fmt.Sprintf("csvgen: unknown export type %d", opts.ExportType))
}

// gestureStage is what the prompt says about one game, beside its rule paragraph.
type gestureStage struct {
	// name is how the opening paragraph names the game; it has no commas, so a list of them reads.
	name string
	// hasOptions is whether the game shows answer options on screen (stages 2 to 5), which is what the
	// short-options paragraph is about. True or false and sentence ordering have none.
	hasOptions bool
}

// gestureStages is indexed by stage number minus one, in the order of the client's STAGES.
var gestureStages = [GestureStageCount]gestureStage{
	{"true or false", false},
	{"two choices answered by tilting the head", true},
	{"three choices answered by biting with the mouth", true},
	{"three choices answered by slicing fruit", true},
	{"four choices answered by showing fingers", true},
	{"sentence ordering", false},
}

var (
	// gestureStageRules holds the six rule paragraphs of prompts/gesture_quiz_stages.txt, indexed by
	// stage number minus one. They are tuned text and are sent word for word, only the chosen ones.
	gestureStageRules = splitGestureStageRules(gestureQuizStages)
	// gestureQuizPrompt is the framing of prompts/gesture_quiz_template.txt.
	gestureQuizPrompt = template.Must(template.New("gesture_quiz").Option("missingkey=error").Parse(normalizePrompt(gestureQuizTemplate)))
)

// splitGestureStageRules cuts the stage rules file into its paragraphs, one per stage in order. A file
// that does not hold exactly one "Stage N – " paragraph per stage would silently send the wrong rules,
// so it panics at start-up instead, like the unknown export type above.
func splitGestureStageRules(file string) [GestureStageCount]string {
	paragraphs := strings.Split(normalizePrompt(file), "\n\n")
	if len(paragraphs) != GestureStageCount {
		panic(fmt.Sprintf("csvgen: gesture_quiz_stages.txt has %d paragraphs, want %d", len(paragraphs), GestureStageCount))
	}
	var rules [GestureStageCount]string
	for i, paragraph := range paragraphs {
		if !strings.HasPrefix(paragraph, fmt.Sprintf("Stage %d – ", i+1)) {
			panic(fmt.Sprintf("csvgen: paragraph %d of gesture_quiz_stages.txt does not start with its stage number", i+1))
		}
		rules[i] = strings.TrimSpace(paragraph)
	}
	return rules
}

// buildGestureQuizMessage fills prompts/gesture_quiz_template.txt for the stages and the number of
// questions the teacher chose, so the model is only told about the games it has to write. The template
// holds the framing and its single/several-stage variants, the stage rules come from the second file,
// and the short-options paragraph is left out when no chosen stage shows options.
func buildGestureQuizMessage(opts Options) string {
	stages := opts.GestureQuizStages()
	questions := opts.GestureQuizQuestions()

	rules := make([]string, 0, len(stages))
	stageList := make([]string, 0, len(stages))
	var withOptions []int
	for _, n := range stages {
		rules = append(rules, gestureStageRules[n-1])
		stageList = append(stageList, fmt.Sprintf("stage %d (%s)", n, gestureStages[n-1].name))
		if gestureStages[n-1].hasOptions {
			withOptions = append(withOptions, n)
		}
	}
	optionStages := ""
	if len(withOptions) > 0 {
		optionStages = describeStages(withOptions)
	}

	var out strings.Builder
	err := gestureQuizPrompt.Execute(&out, map[string]any{
		"Single":       len(stages) == 1,
		"Skipped":      len(stages) < GestureStageCount,
		"Count":        len(stages),
		"StageList":    joinWords(stageList, "and"),
		"Numbers":      joinWords(stageNumbers(stages), "or"),
		"Rules":        strings.Join(rules, "\n\n"),
		"OptionStages": optionStages,
		"Questions":    questions,
		"Total":        len(stages) * questions,
		"First":        stages[0],
	})
	if err != nil {
		panic(fmt.Sprintf("csvgen: gesture quiz template: %v", err))
	}
	return normalizePrompt(out.String())
}

func stageNumbers(stages []int) []string {
	numbers := make([]string, len(stages))
	for i, n := range stages {
		numbers[i] = strconv.Itoa(n)
	}
	return numbers
}

// describeStages names a set of stage numbers for a sentence: "stage 4", "stages 3 and 5", and, for a
// run of three or more, "stages 2 to 5" as the prompt has always said it.
func describeStages(stages []int) string {
	if len(stages) == 1 {
		return fmt.Sprintf("stage %d", stages[0])
	}
	if first, last := stages[0], stages[len(stages)-1]; len(stages) >= 3 && last-first == len(stages)-1 {
		return fmt.Sprintf("stages %d to %d", first, last)
	}
	return "stages " + joinWords(stageNumbers(stages), "and")
}

// joinWords joins items as "a", "a and b" or "a, b and c".
func joinWords(items []string, conjunction string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " " + conjunction + " " + items[len(items)-1]
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
