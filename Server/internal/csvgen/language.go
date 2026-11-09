package csvgen

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"strings"
	"text/template"
	"time"
)

// Language is the language a quiz teaches. Sent by ordinal; keep in the same order as
// Client/src/models/quiz-language.ts. Absent means Chinese, what every request was before English.
type Language int

const (
	Chinese Language = iota
	English
	languageCount
)

var languageNames = []string{"Chinese", "English"}

// languageSpec is what the shared prompts fill in for a language: its name, with its indefinite article, the
// word for the written form a learner must get right beside the meaning, and the folder under prompts/ holding
// its own parts.
type languageSpec struct {
	name, article string
	forms         string
	dir           string
}

var languageSpecs = [languageCount]languageSpec{
	{name: "Chinese", article: "a", forms: "pinyin", dir: "chinese"},
	{name: "English", article: "an", forms: "spelling", dir: "english"},
}

func (l Language) String() string {
	return languageSpecs[l].name
}

// courseLanguages says which language each course teaches. Other, a course typed in by hand, belongs to every
// language. Adding a course means a CourseType member here and in the client, and its language.
var courseLanguages = map[CourseType]Language{
	Hsk:           Chinese,
	Yct:           Chinese,
	VocabReview10: English,
}

// Teaches says whether the course is one of the language's.
func (c CourseType) Teaches(l Language) bool {
	language, fixed := courseLanguages[c]
	return !fixed || language == l
}

// ParseLanguage reads the language query parameter of both modes, Chinese when it is absent. The error text is
// returned to the client as-is.
func ParseLanguage(q url.Values) (Language, error) {
	if q.Get("language") == "" {
		return Chinese, nil
	}
	language, ok := parseEnum(q.Get("language"), languageNames)
	if !ok {
		return Chinese, errors.New("Invalid language parameter.")
	}
	return Language(language), nil
}

// The parts of the prompts that differ by language, in prompts/<dir>/: the simple system prompt, the blocks of
// the creative system prompt and of the Game message, and the six stage rules of the Game.
//
//go:embed prompts/chinese prompts/english
var languagePromptFiles embed.FS

// languagePrompt is everything the requests send that depends on the language.
type languagePrompt struct {
	simpleSystem string
	// creativeSystem is filled per call by creativeSystemPrompt, since its TIME LIMIT comes from the config.
	creativeSystem *template.Template
	// bankSystem is the question bank's system prompt (see WriteQuestions), filled per call like creativeSystem.
	bankSystem        *template.Template
	gestureQuiz       *template.Template
	gestureStageRules [GestureStageCount]string
}

// languagePrompts is indexed by Language. The files are tuned text loaded when the package is: a missing file
// or block would silently send the wrong prompt, so it panics at start-up instead.
var languagePrompts = loadLanguagePrompts()

func loadLanguagePrompts() [languageCount]languagePrompt {
	creative := withGuidance(template.Must(template.New("creative").Option("missingkey=error").Parse(normalizePrompt(creativeSystemTemplate))))
	bank := withGuidance(template.Must(template.New("bank").Option("missingkey=error").Parse(normalizePrompt(bankSystemTemplate))))
	gesture := template.Must(template.New("gesture_quiz").Option("missingkey=error").Parse(normalizePrompt(gestureQuizTemplate)))
	var prompts [languageCount]languagePrompt
	for l := range languageCount {
		spec := languageSpecs[l]
		file := func(name string) string {
			raw, err := fs.ReadFile(languagePromptFiles, "prompts/"+spec.dir+"/"+name)
			if err != nil {
				panic(fmt.Sprintf("csvgen: %v", err))
			}
			return normalizePrompt(string(raw))
		}
		prompts[l] = languagePrompt{
			simpleSystem:      file("simple_system.txt"),
			creativeSystem:    withBlocks(creative, file("creative.txt")),
			bankSystem:        withBlocks(withBlocks(bank, file("creative.txt")), file("bank.txt")),
			gestureQuiz:       withBlocks(gesture, file("gesture_quiz.txt")),
			gestureStageRules: splitGestureStageRules(file("gesture_quiz_stages.txt")),
		}
		// Fill it once now, with a time limit so the TIME LIMIT section is checked too, so a broken prompt
		// panics at start-up rather than on the first request.
		executePrompt(prompts[l].creativeSystem, creativeSystemData(spec, time.Minute))
		executePrompt(prompts[l].bankSystem, creativeSystemData(spec, time.Minute))
	}
	return prompts
}

// withGuidance adds the quiz-guidance block (prompts/quiz_guidance.txt) to a system prompt's template.
func withGuidance(system *template.Template) *template.Template {
	return template.Must(system.Parse(normalizePrompt(quizGuidanceTemplate)))
}

// withBlocks is a copy of the shared template with a language's {{define}} blocks added.
func withBlocks(shared *template.Template, blocks string) *template.Template {
	return template.Must(template.Must(shared.Clone()).Parse(blocks))
}

// creativeSystemPrompt is the creative system prompt for a language. timeLimit is the deadline the server gives
// one generation call (LLM_TIMEOUT_SECONDS); zero leaves out the TIME LIMIT section.
func creativeSystemPrompt(language Language, timeLimit time.Duration) string {
	return executePrompt(languagePrompts[language].creativeSystem, creativeSystemData(languageSpecs[language], timeLimit))
}

// bankSystemPrompt is the question bank's system prompt for a language, timeLimit as for creativeSystemPrompt.
func bankSystemPrompt(language Language, timeLimit time.Duration) string {
	return executePrompt(languagePrompts[language].bankSystem, creativeSystemData(languageSpecs[language], timeLimit))
}

func creativeSystemData(spec languageSpec, timeLimit time.Duration) map[string]any {
	return map[string]any{
		"Lang":             spec.name,
		"ALang":            spec.article + " " + spec.name,
		"ALangCapital":     strings.ToUpper(spec.article[:1]) + spec.article[1:] + " " + spec.name,
		"Forms":            spec.forms,
		"TimeLimitSeconds": int(timeLimit / time.Second),
	}
}
