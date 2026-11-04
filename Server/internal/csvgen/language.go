package csvgen

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"strings"
	"text/template"
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
	simpleSystem      string
	creativeSystem    string
	gestureQuiz       *template.Template
	gestureStageRules [GestureStageCount]string
}

// languagePrompts is indexed by Language. The files are tuned text loaded when the package is: a missing file
// or block would silently send the wrong prompt, so it panics at start-up instead.
var languagePrompts = loadLanguagePrompts()

func loadLanguagePrompts() [languageCount]languagePrompt {
	creative := template.Must(template.New("creative").Option("missingkey=error").Parse(normalizePrompt(creativeSystemTemplate)))
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
			creativeSystem:    renderCreativeSystem(creative, file("creative.txt"), spec),
			gestureQuiz:       withBlocks(gesture, file("gesture_quiz.txt")),
			gestureStageRules: splitGestureStageRules(file("gesture_quiz_stages.txt")),
		}
	}
	return prompts
}

// withBlocks is a copy of the shared template with a language's {{define}} blocks added.
func withBlocks(shared *template.Template, blocks string) *template.Template {
	return template.Must(template.Must(shared.Clone()).Parse(blocks))
}

func renderCreativeSystem(shared *template.Template, blocks string, spec languageSpec) string {
	return executePrompt(withBlocks(shared, blocks), map[string]any{
		"Lang":         spec.name,
		"ALang":        spec.article + " " + spec.name,
		"ALangCapital": strings.ToUpper(spec.article[:1]) + spec.article[1:] + " " + spec.name,
		"Forms":        spec.forms,
	})
}
