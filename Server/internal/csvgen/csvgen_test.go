package csvgen

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestParseCreativeOptions(t *testing.T) {
	tests := []struct {
		query   string
		wantErr string
		check   func(Options) bool
	}{
		{query: "exportType=2&courseType=0&level=3&lessonNumber=7", check: func(o Options) bool {
			return o.ExportType == Wayground && o.CourseType == Hsk && *o.Level == 3 && *o.LessonNumber == 7 &&
				o.CourseDisplayName() == "HSK, taught from 《HSK标准教程》 HSK Standard Course (Giáo trình chuẩn HSK)" && o.Intelligence == 1
		}},
		{query: "exportType=0&courseType=0&level=1&lessonNumber=1&intelligence=1", check: func(o Options) bool {
			return o.Intelligence == 1
		}},
		{query: "exportType=0&courseType=0&level=1&lessonNumber=1&intelligence=2", check: func(o Options) bool {
			return o.Intelligence == 2
		}},
		{query: "exportType=Blooket&courseType=yct&level=1&lessonNumber=2", check: func(o Options) bool {
			return o.ExportType == Blooket && o.CourseType == Yct
		}},
		{query: "exportType=0&courseType=2&courseName=+Boya+&lessonNumber=4", check: func(o Options) bool {
			return o.CourseType == Other && o.Level == nil && o.CourseDisplayName() == "Boya"
		}},
		{query: "exportType=0&courseType=0&courseName=Boya&level=1&lessonNumber=1", check: func(o Options) bool {
			return o.CourseName == "" // courseName only applies to Other
		}},
		{query: "courseType=0&level=1&lessonNumber=1", wantErr: "Invalid or missing exportType parameter."},
		{query: "exportType=3&courseType=0&level=1&lessonNumber=1", wantErr: "Invalid or missing exportType parameter."},
		{query: "exportType=0&courseType=9&level=1&lessonNumber=1", wantErr: "Invalid or missing courseType parameter."},
		{query: "exportType=0&courseType=2&lessonNumber=1", wantErr: "Invalid or missing courseName parameter."},
		{query: "exportType=0&courseType=0&level=x&lessonNumber=1", wantErr: "Invalid level parameter."},
		{query: "exportType=0&courseType=1&lessonNumber=1", wantErr: "Invalid or missing level parameter."},
		{query: "exportType=0&courseType=0&level=1", wantErr: "Invalid or missing lessonNumber parameter."},
		{query: "exportType=0&courseType=0&level=1&lessonNumber=1&intelligence=0", wantErr: "Invalid intelligence parameter."},
		{query: "exportType=0&courseType=0&level=1&lessonNumber=1&intelligence=3", wantErr: "Invalid intelligence parameter."},
		{query: "exportType=0&courseType=0&level=1&lessonNumber=1&intelligence=x", wantErr: "Invalid intelligence parameter."},
	}
	for _, tt := range tests {
		q, _ := url.ParseQuery(tt.query)
		opts, err := ParseCreativeOptions(q)
		if tt.wantErr != "" {
			if err == nil || err.Error() != tt.wantErr {
				t.Errorf("%s: want error %q, got %v", tt.query, tt.wantErr, err)
			}
			continue
		}
		if err != nil || !tt.check(opts) {
			t.Errorf("%s: unexpected result %+v, %v", tt.query, opts, err)
		}
	}
}

func TestExtractCSVContent(t *testing.T) {
	tests := map[string]string{
		"":                                      "",
		"  a,b\nc,d  ":                          "a,b\nc,d",
		"Here you go:\n```csv\na,b\n```\nEnjoy": "a,b",
		"```\na,b\n```":                         "a,b",
		"Sure!\nCâu hỏi, Đáp án\nxin chào,你好": "Câu hỏi, Đáp án\nxin chào,你好",
		"câu hỏi,đáp án\nx,y":                 "câu hỏi,đáp án\nx,y",
		"Question,Correct Answer\nWhat?,That": "Question,Correct Answer\nWhat?,That",
	}
	for in, want := range tests {
		if got := ExtractCSVContent(in); got != want {
			t.Errorf("ExtractCSVContent(%q) = %q, want %q", in, got, want)
		}
	}
}

func textsOf(t *testing.T, req responsesRequest) []string {
	t.Helper()
	var texts []string
	for _, p := range req.Input[0].Content {
		if p.Type == "input_text" {
			texts = append(texts, p.Text)
		}
	}
	return texts
}

func TestBuildCreativeRequest(t *testing.T) {
	level, lesson := 2, 5
	req := buildCreativeRequest("m", nil, Options{ExportType: Wayground, CourseType: Yct, Level: &level, LessonNumber: &lesson})
	if req.Model != "m" || req.MaxOutputTokens != 16000 || req.Input[0].Role != "user" ||
		len(req.Tools) != 1 || req.Tools[0].Type != "web_search" {
		t.Fatalf("unexpected request %+v", req)
	}
	system := req.Instructions
	if !strings.HasPrefix(system, "You are an expert Chinese-language teacher") ||
		!strings.HasSuffix(system, "The final response must contain nothing except the CSV rows.") ||
		strings.Contains(system, "\r") {
		t.Fatal("creative system prompt not loaded intact")
	}

	texts := textsOf(t, req)
	if len(texts) != 8 {
		t.Fatalf("want 8 text parts (intro, 4 Wayground, 3 lesson), got %d: %q", len(texts), texts)
	}
	if !strings.HasPrefix(texts[0], "No image is provided.") ||
		!strings.HasPrefix(texts[3], `"Text of the question`) || !strings.HasSuffix(texts[3], "(optional)") ||
		!strings.HasPrefix(texts[4], "Image Link:") ||
		texts[5] != "Course: YCT (Youth Chinese Test), taught from 《YCT标准教程》 YCT Standard Course (Giáo trình chuẩn YCT)" || texts[6] != "Level: 2" || texts[7] != "Lesson number: 5" {
		t.Fatalf("unexpected text parts %q", texts)
	}

	withImage := buildCreativeRequest("m", []Image{{ContentType: "image/png", Data: []byte{1, 2}}},
		Options{ExportType: GimKit, CourseType: Other, CourseName: "Boya", LessonNumber: &lesson})
	texts = textsOf(t, withImage)
	if texts[0] != "Convert the images to CSV using the required format." ||
		texts[3] != "Level: this course has no level, none was given." {
		t.Fatalf("unexpected text parts %q", texts)
	}
	// No image column on GimKit, so no search.
	if withImage.Tools != nil || withImage.MaxOutputTokens != 10000 {
		t.Fatalf("unexpected request %+v", withImage)
	}
	parts := withImage.Input[0].Content
	if last := parts[len(parts)-1]; last.Type != "input_image" || last.ImageURL != "data:image/png;base64,AQI=" {
		t.Fatalf("unexpected image part %+v", last)
	}
}

func TestGenerateCallsChatCompletions(t *testing.T) {
	var got map[string]any
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer key" {
			t.Errorf("unexpected request %s %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"`+"```csv\\nCâu hỏi,Đáp án\\na,b\\n```"+`"}}]}`)
	}))
	defer llm.Close()

	c := NewClient(llm.URL+"/v1/", "key", "gpt-x", nil, slog.New(slog.DiscardHandler))
	csv, err := c.Generate(context.Background(), []Image{{ContentType: "image/jpeg", Data: []byte("img")}}, false, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if csv != "Câu hỏi,Đáp án\na,b" {
		t.Fatalf("unexpected csv %q", csv)
	}
	if got["model"] != "gpt-x" || got["max_completion_tokens"] != float64(10000) || got["reasoning_effort"] != "low" {
		t.Fatalf("unexpected payload %v", got)
	}
}

func TestGenerateCreativeCallsResponses(t *testing.T) {
	var got map[string]any
	reply := `{"status":"completed","output":[{"type":"reasoning"},{"type":"web_search_call","status":"completed"},` +
		`{"type":"message","content":[{"type":"output_text","text":"` + "```csv\\na,b\\n```" + `"}]}]}`
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_, _ = io.WriteString(w, reply)
	}))
	defer llm.Close()

	level, lesson := 1, 1
	c := NewClient(llm.URL+"/v1", "key", "gpt-x", nil, slog.New(slog.DiscardHandler))
	csv, err := c.Generate(context.Background(), nil, true, Options{ExportType: Wayground, CourseType: Hsk, Level: &level, LessonNumber: &lesson})
	if err != nil {
		t.Fatal(err)
	}
	if csv != "a,b" {
		t.Fatalf("unexpected csv %q", csv)
	}
	if got["model"] != "gpt-x" || got["max_output_tokens"] != float64(16000) || got["instructions"] == "" {
		t.Fatalf("unexpected payload %v", got)
	}
}

func TestGenerateFailsOnIncompleteResponse(t *testing.T) {
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"a,b"}]}]}`)
	}))
	defer llm.Close()
	c := NewClient(llm.URL, "key", "m", nil, slog.New(slog.DiscardHandler))
	if _, err := c.Generate(context.Background(), nil, true, Options{}); err == nil || !strings.Contains(err.Error(), "max_output_tokens") {
		t.Fatalf("want incomplete error, got %v", err)
	}
}

func TestGenerateFailsOnErrorStatus(t *testing.T) {
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	}))
	defer llm.Close()
	c := NewClient(llm.URL, "key", "m", nil, slog.New(slog.DiscardHandler))
	if _, err := c.Generate(context.Background(), nil, true, Options{}); err == nil {
		t.Fatal("want error on non-2xx status")
	}
}

func TestModelForIntelligence(t *testing.T) {
	models := []string{"m1", "m2"}
	c := NewClient("http://x", "key", "base", models, slog.New(slog.DiscardHandler))
	for level, want := range map[int]string{1: "m1", 2: "m2", 0: "m1", 3: "m1"} {
		if got := c.modelFor(Options{Intelligence: level}); got != want {
			t.Errorf("intelligence %d: want %q, got %q", level, want, got)
		}
	}
	if got := NewClient("http://x", "key", "base", nil, slog.New(slog.DiscardHandler)).modelFor(Options{Intelligence: 2}); got != "base" {
		t.Errorf("without intelligence models want the base model, got %q", got)
	}
}
