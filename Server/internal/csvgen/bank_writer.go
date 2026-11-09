package csvgen

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The question bank (package bank) builds quizzes from stored questions and asks the model only for the questions
// it lacks. This file is its way to the model: WriteQuestions sends the lessons, a numbered list of their words and
// the questions wanted, and reads back JSON, one object per question, which package bank checks and stores.

// QuestionSpec is one question the bank asks the model to write: the word it must test (a LessonWord.Key of the
// request's Vocabulary), its format, the skills that suit it (any when empty), its difficulty (1 to 3), the least
// number of options a multiple-choice question must have (2 to 4; zero means 4), and whether it must be a visual
// question with an image (Wayground only).
type QuestionSpec struct {
	Word       string
	Format     string
	Skills     []string
	Difficulty int
	Options    int
	Visual     bool
}

// QuestionDraft is one question as the model wrote it, its targets already turned from the numbered list's ids
// into word keys. Package bank checks it before storing it.
type QuestionDraft struct {
	Targets      []string    `json:"targets"`
	Format       string      `json:"format"`
	Skill        string      `json:"skill"`
	Difficulty   int         `json:"difficulty"`
	Stem         string      `json:"stem"`
	StemPinyin   string      `json:"stemPinyin"`
	Answer       string      `json:"answer"`
	AnswerPinyin string      `json:"answerPinyin"`
	Distractors  []DraftText `json:"distractors"`
	Chunks       []DraftText `json:"chunks"`
	Explanation  string      `json:"explanation"`
	ImageURL     string      `json:"imageUrl"`
}

// DraftText is a text of a draft with its pinyin.
type DraftText struct {
	Text   string `json:"text"`
	Pinyin string `json:"pinyin"`
}

// WriteQuestions asks the model, in one call, for the questions specs describes, about the lessons of opts, and
// returns them with their targets as word keys. A question naming no word of the list is left out, logged. Usage
// is filled in whether or not it failed. onRows is told how many lines of the answer have streamed in: one per
// question, since the prompt asks for each on a line of its own.
func (c *Client) WriteQuestions(ctx context.Context, opts Options, vocabulary Vocabulary, specs []QuestionSpec, onRows func(int)) ([]QuestionDraft, Usage, error) {
	usage := Usage{Model: c.modelFor(opts)}
	req, ids, err := buildBankRequest(usage.Model, c.timeLimit, opts, vocabulary, specs)
	if err != nil {
		return nil, usage, err
	}
	text, err := c.respond(ctx, req, &usage, onRows)
	if err != nil {
		return nil, usage, err
	}
	var answer struct {
		Questions []rawDraft `json:"questions"`
	}
	if err := decodeJSONAnswer(text, &answer); err != nil {
		return nil, usage, err
	}
	keys := make(map[string]string, len(ids))
	for key, id := range ids {
		keys[strings.ToUpper(id)] = key
	}
	drafts := make([]QuestionDraft, 0, len(answer.Questions))
	for i, raw := range answer.Questions {
		draft := raw.QuestionDraft
		draft.Difficulty = int(raw.Difficulty)
		draft.Targets = nil
		for _, id := range raw.Targets {
			if key, ok := keys[strings.ToUpper(strings.TrimSpace(id))]; ok && !slices.Contains(draft.Targets, key) {
				draft.Targets = append(draft.Targets, key)
			}
		}
		if len(draft.Targets) == 0 {
			c.logger.Warn("the model wrote a question for no word of the list", "question", i+1, "targets", raw.Targets)
			continue
		}
		drafts = append(drafts, draft)
	}
	if len(drafts) == 0 {
		return nil, usage, &badOutputError{errors.New("the model's answer has no question for a word of the list")}
	}
	return drafts, usage, nil
}

// rawDraft is a question as the model's JSON has it: its targets are the word list's ids, and its difficulty may
// come as a number or a string.
type rawDraft struct {
	QuestionDraft
	Difficulty lenientInt `json:"difficulty"`
}

// lenientInt reads a JSON number, or a string holding one, since a model sometimes quotes it.
type lenientInt int

func (n *lenientInt) UnmarshalJSON(data []byte) error {
	text := strings.Trim(strings.TrimSpace(string(data)), `"`)
	if text == "" || text == "null" {
		*n = 0
		return nil
	}
	value, err := strconv.Atoi(text)
	if err != nil {
		return err
	}
	*n = lenientInt(value)
	return nil
}

// buildBankRequest is the call that asks for the specs' questions, and the id each word key is given in the word
// list (W1, W2, ...). The words are those of the vocabulary; a spec about any other word is an error, since the
// caller plans from the same vocabulary.
func buildBankRequest(model string, timeLimit time.Duration, opts Options, vocabulary Vocabulary, specs []QuestionSpec) (responsesRequest, map[string]string, error) {
	book := textbookFor(opts)
	if book == nil || book.dir != vocabulary.Book {
		return responsesRequest{}, nil, fmt.Errorf("csvgen: the request's course is not the book %s", vocabulary.Book)
	}
	ids := make(map[string]string, len(vocabulary.Words))
	var list strings.Builder
	list.WriteString("WORD LIST (the words a question may test: id, word, " + languageSpecs[opts.Language].forms + ", part of speech, English, Vietnamese):")
	for i, w := range vocabulary.Words {
		id := fmt.Sprintf("W%d", i+1)
		ids[w.Key()] = id
		fmt.Fprintf(&list, "\n%s %s | %s | %s | %s | %s", id, w.Word, w.Pinyin, w.POS, w.English, w.Vietnamese)
	}

	visual := false
	var request strings.Builder
	fmt.Fprintf(&request, "REQUEST (write these %d questions, in this order):", len(specs))
	for i, spec := range specs {
		id, ok := ids[spec.Word]
		if !ok {
			return responsesRequest{}, nil, fmt.Errorf("csvgen: a question about %q, which is not a word of the lessons", spec.Word)
		}
		format := spec.Format
		if format == "" {
			format = "mc or word_order"
		}
		fmt.Fprintf(&request, "\n%d. %s, format %s, difficulty %d", i+1, id, format, spec.Difficulty)
		if len(spec.Skills) > 0 {
			fmt.Fprintf(&request, ", skill %s", joinWords(spec.Skills, "or"))
		}
		if spec.Visual {
			visual = true
			request.WriteString(", a visual question with an image")
		}
	}

	intro := "Write the questions of the REQUEST below as the JSON object described in your instructions. The LESSON MATERIAL message holds the lessons, taken from the textbook, and the WORD LIST names the words to test by their ids."
	texts := append([]string{intro}, lessonMessages(opts)...)
	texts = append(texts, lessonMaterial(book, vocabulary.Lessons), list.String(), request.String())
	req := responsesRequest{
		Model:        model,
		Instructions: bankSystemPrompt(opts.Language, timeLimit),
		Input:        []responsesInput{{Role: "user", Content: inputParts(texts, nil)}},
		// A long list of questions in JSON is a long answer.
		MaxOutputTokens: maxOutputTokensLarge,
	}
	if visual {
		// Web search lets the model find real photos for the visual questions, as for a Wayground quiz.
		req.Tools = []responsesTool{{Type: "web_search"}}
	}
	return req, ids, nil
}
