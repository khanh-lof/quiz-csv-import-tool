package csvgen

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"quiz-csv-import-tool/server/internal/gesturequiz"
)

var (
	threeColumns = csvShape{columns: "A,B,C"}
	gimKitShape  = csvShape{columns: creativeColumns(GimKit)}
	byteOrder    = string(rune(0xFEFF))
)

// waygroundURL is an image link as the model writes it, with the query string Pexels sizes it by.
const waygroundURL = "https://images.pexels.com/photos/102104/pexels-photo-102104.jpeg?auto=compress&cs=tinysrgb&w=600"

// fixableCSVs are answers normalizeCSV fixes on its own, and what it writes for each.
var fixableCSVs = []struct {
	name  string
	shape csvShape
	in    string
	want  string
}{
	// The basics.
	{"already quoted stays", threeColumns, `"a","b, c","d"`, `"a","b, c","d"`},
	{"bare cells are quoted", threeColumns, "a,b,c\nd,e,f", `"a","b","c"` + "\n" + `"d","e","f"`},
	{"an empty CSV is left alone", threeColumns, "  ", "  "},

	// Quotes inside a cell.
	{"a doubled quote stays doubled", threeColumns, `"say ""hi""",b,c`, `"say ""hi""","b","c"`},
	{"a bare quote inside a quoted cell is escaped", threeColumns, `"say "hi" now",b,c`, `"say ""hi"" now","b","c"`},
	{"a quote inside a bare cell is escaped", threeColumns, `say "hi",b,c`, `"say ""hi""","b","c"`},
	{"a quote not before a comma is text", threeColumns, `"a" b",c,d`, `"a"" b","c","d"`},
	{"a quote and spaces not before a comma are text", threeColumns, `"a " b",c,d`, `"a "" b","c","d"`},
	{"a cell that is one quote", threeColumns, `"""",b,c`, `"""","b","c"`},
	{"a cell that is one comma", threeColumns, `",",b,c`, `",","b","c"`},
	{"a quoted cell holding a quoted comma", threeColumns, `"a"",""b",c,d`, `"a"",""b","c","d"`},
	{"an inch mark at the start of a bare cell", threeColumns, `5" screen,b,c`, `"5"" screen","b","c"`},
	{"markup with quotes", threeColumns, `<b class="x">"hi"</b>,b,c`, `"<b class=""x"">""hi""</b>","b","c"`},
	{"a backslash does not escape a quote", threeColumns, `C:\new\path,b\"c,d`, `"C:\new\path","b\""c","d"`},
	{"apostrophes are text", threeColumns, `it's,don't,"can't"`, `"it's","don't","can't"`},
	{"curly, CJK and guillemet quotes are text", threeColumns, `“hi”,「好」,«y»`, `"“hi”","「好」","«y»"`},

	// Other special characters.
	{"a full-width comma is not a separator", threeColumns, `你好，世界,"a, b, c",d`, `"你好，世界","a, b, c","d"`},
	{"punctuation and symbols", threeColumns, `a; b|c / d,(e) [f] {g},h&i<j>%#@!~^*`, `"a; b|c / d","(e) [f] {g}","h&i<j>%#@!~^*"`},
	{"a tab inside a cell stays", threeColumns, "a\tb,c,d", "\"a\tb\",\"c\",\"d\""},
	{"emoji and combining marks", threeColumns, "😀👍,ñ,e\u0301", "\"😀👍\",\"ñ\",\"e\u0301\""},
	{"pinyin tones, numbers and a quoted list", threeColumns, `nǐ hǎo,30,"1,2"`, `"nǐ hǎo","30","1,2"`},
	{"a URL with a query string", threeColumns, waygroundURL + ",b,c", `"` + waygroundURL + `","b","c"`},
	{"formula-like text is kept as text", threeColumns, `=SUM(A1:A2),+1,-1`, `"=SUM(A1:A2)","+1","-1"`},
	{"an apostrophe in pinyin and quotes in Vietnamese", threeColumns,
		`Xī'ān,西安,"Thủ đô cũ của ""Trung Quốc"", nổi tiếng"`, `"Xī'ān","西安","Thủ đô cũ của ""Trung Quốc"", nổi tiếng"`},

	// White space, line breaks and empty cells.
	{"spaces around cells go", threeColumns, ` "a" , b ,c `, `"a","b","c"`},
	{"spaces inside a quoted cell are trimmed at its ends only", threeColumns, `"  a  b  ",c,d`, `"a  b","c","d"`},
	{"spaces and tabs after a closing quote", threeColumns, "\"a\"  ,\"b\"\t,\"c\"  \n\"d\",\"e\",\"f\"", `"a","b","c"` + "\n" + `"d","e","f"`},
	{"ideographic and no-break spaces are trimmed", threeColumns, "\u3000你好\u3000,\u00a0b,c", `"你好","b","c"`},
	{"a byte-order mark goes", threeColumns, byteOrder + "a,b,c", `"a","b","c"`},
	{"CRLF, blank and empty rows go", threeColumns, "a,b,c\r\n\r\n , , \r\nd,e,f\r\n", `"a","b","c"` + "\n" + `"d","e","f"`},
	{"a line break inside a quoted cell stays", threeColumns, "\"line 1\nline 2\",b,c", "\"line 1\nline 2\",\"b\",\"c\""},
	{"empty quoted cells stay", threeColumns, `"a","",""`, `"a","",""`},
	{"bare empty cells are quoted", threeColumns, `a,,c`, `"a","","c"`},
	{"extra empty trailing cells go", threeColumns, "a,b,c,,", `"a","b","c"`},
	{"missing trailing cells of a quoted row are added", threeColumns, `"a","b"` + "\nd,e,f", `"a","b",""` + "\n" + `"d","e","f"`},

	// Rows as the platforms' prompts ask for them.
	{"Wayground multiple choice", csvShape{columns: creativeColumns(Wayground)},
		`Chọn nghĩa đúng của "苹果",Multiple Choice,quả táo,quả lê,"quả chuối, chín",,,1,30,` + waygroundURL +
			`,"""苹果"" (píngguǒ) nghĩa là ""quả táo"", không phải ""quả lê""."`,
		`"Chọn nghĩa đúng của ""苹果""","Multiple Choice","quả táo","quả lê","quả chuối, chín","","","1","30","` + waygroundURL +
			`","""苹果"" (píngguǒ) nghĩa là ""quả táo"", không phải ""quả lê""."`},
	{"Wayground fill-in-the-blank without its empty cells", csvShape{columns: creativeColumns(Wayground)},
		`"Điền vào chỗ trống: 我___学生。","Fill-in-the-Blank","是"`,
		`"Điền vào chỗ trống: 我___学生。","Fill-in-the-Blank","是","","","","","","","",""`},
	{"Blooket", csvShape{columns: creativeColumns(Blooket)},
		`1,"Từ nào nghĩa là ""cảm ơn""?",谢谢,你好,再见,对不起,20,1`,
		`"1","Từ nào nghĩa là ""cảm ơn""?","谢谢","你好","再见","对不起","20","1"`},
	{"GestureQuiz sentence ordering", csvShape{columns: creativeColumns(GestureQuiz)},
		`6,我 / 是 / 学生,wǒ / shì / xuéshēng,我是学生,wǒ shì xuéshēng,我学生是,wǒ xuéshēng shì,是我学生,shì wǒ xuéshēng,学生是我,xuéshēng shì wǒ,"Câu đúng: chủ ngữ + ""是"" + danh từ."`,
		`"6","我 / 是 / 学生","wǒ / shì / xuéshēng","我是学生","wǒ shì xuéshēng","我学生是","wǒ xuéshēng shì","是我学生","shì wǒ xuéshēng","学生是我","xuéshēng shì wǒ","Câu đúng: chủ ngữ + ""是"" + danh từ."`},
	{"the simple mode with its header", shapeFor(false, Options{}),
		"\"Câu hỏi\",\"Đáp án\"\n\"Xin chào, nǐ hǎo. Chữ Hán là gì?\",\"你好\"\nCảm ơn (xièxie) Chữ Hán là gì?,谢谢",
		`"Câu hỏi","Đáp án"` + "\n" + `"Xin chào, nǐ hǎo. Chữ Hán là gì?","你好"` + "\n" + `"Cảm ơn (xièxie) Chữ Hán là gì?","谢谢"`},
}

// brokenCSVs are answers normalizeCSV cannot split into their columns, and what the problem names.
var brokenCSVs = []struct {
	name  string
	shape csvShape
	in    string
	want  string
}{
	{"an unquoted comma", threeColumns, "a,b,c\nhello, world,b,c\nd,e,f", "line 2 has 4 cells"},
	{"an unquoted comma in a Vietnamese explanation", threeColumns, `a,b,Đúng, vì "ăn" là động từ`, "line 1 has 4 cells"},
	{"curly quotes do not protect a comma", threeColumns, `“a, b”,c,d`, "line 1 has 4 cells"},
	{"single quotes do not protect a comma", threeColumns, `'a, b',c,d`, "line 1 has 4 cells"},
	{"a full-width comma cell beside an unquoted comma", threeColumns, `你好，世界, 朋友,b,c`, "line 1 has 4 cells"},
	{"a bare quote before a comma ends the cell early", threeColumns, `"say "hi", then go",b,c`, "line 1 has 4 cells"},
	{"a non-empty extra cell", threeColumns, "a,b,c,d", "line 1 has 4 cells"},
	{"a short row with a bare cell", threeColumns, "a,b", "line 1 has 2 cells"},
	{"an unquoted comma hidden by a missing optional cell", gimKitShape, "Chào, bạn,Xin chào,你好", "line 1 has 4 cells"},
	{"an unclosed quote", threeColumns, "a,b,c\n\"d,e,f\ng,h,i", "line 2 has a quote that is never closed"},
	{"an unclosed quote in the last cell", threeColumns, `a,b,"c`, "line 1 has a quote that is never closed"},
	{"text after a closing quote", threeColumns, `"a" b,c,d`, "line 1 has a quote that is never closed"},
	{"a missing closing quote closed by a later quote", threeColumns, "a,b,c\n\"d,e,f\ng,\"h\",i", "line 2 has 2 cells"},
	{"line numbers count the line breaks inside quoted cells", threeColumns, "\"x\ny\",b,c\nd,e,f,g", "line 3 has 4 cells"},
	{"CRLF line numbers", threeColumns, "a,b,c\r\nd,e,f\r\ng,h,i,j", "line 3 has 4 cells"},
	{"Wayground explanation with an unquoted comma", csvShape{columns: creativeColumns(Wayground)},
		`Câu hỏi,Multiple Choice,a,b,c,d,,1,30,,Đúng, vì a là đáp án`, "line 1 has 12 cells"},
	{"GestureQuiz explanation with an unquoted comma", csvShape{columns: creativeColumns(GestureQuiz)},
		`1,你好,nǐ hǎo,对,duì,错,cuò,,,,,Đúng, vì "你好" là xin chào`, "line 1 has 13 cells"},
	{"an unquoted comma followed by a quoted word", csvShape{columns: creativeColumns(GestureQuiz)},
		`1,你好,nǐ hǎo,对,duì,错,cuò,,,,,Đúng, "你好" là xin chào`, "line 1 has a quote that is never closed"},
	{"the simple mode question with an unquoted comma", shapeFor(false, Options{}),
		"Câu hỏi,Đáp án\nXin chào, nǐ hǎo,你好", "line 2 has 3 cells"},
}

func TestNormalizeCSV(t *testing.T) {
	for _, tc := range fixableCSVs {
		got, problem := normalizeCSV(tc.in, tc.shape)
		if problem != nil || got != tc.want {
			t.Errorf("%s:\n got %q, %v\nwant %q", tc.name, got, problem, tc.want)
		}
	}
}

func TestNormalizeCSVRejectsRowsItCannotSplit(t *testing.T) {
	for _, tc := range brokenCSVs {
		got, problem := normalizeCSV(tc.in, tc.shape)
		if problem == nil || !strings.Contains(problem.Error(), tc.want) {
			t.Errorf("%s: got %q, %v; want a problem with %q", tc.name, got, problem, tc.want)
		}
		if got != "" {
			t.Errorf("%s: the rows it could read were returned: %q", tc.name, got)
		}
	}
}

// Whatever normalizeCSV writes is a strict RFC 4180 CSV of the shape's width with every cell quoted, which the
// client's parser (gesturequiz.SplitRows is its port) reads into the same cells, and which normalizeCSV leaves
// as it is.
func TestNormalizedCSVReadsBackTheSame(t *testing.T) {
	for _, tc := range fixableCSVs {
		out, problem := normalizeCSV(tc.in, tc.shape)
		if problem != nil || strings.TrimSpace(out) == "" {
			continue
		}
		reader := csv.NewReader(strings.NewReader(out))
		reader.FieldsPerRecord = tc.shape.width()
		strict, err := reader.ReadAll()
		if err != nil {
			t.Errorf("%s: not a strict CSV of %d columns: %v\n%s", tc.name, tc.shape.width(), err, out)
			continue
		}
		if client := gesturequiz.SplitRows(out); !reflect.DeepEqual(client, strict) {
			t.Errorf("%s: the client reads %q, a strict reader %q", tc.name, client, strict)
		}
		for _, row := range readCSV(out) {
			if row.bare || row.unclosed {
				t.Errorf("%s: line %d is not fully quoted: %q", tc.name, row.line, out)
			}
		}
		if again, problem := normalizeCSV(out, tc.shape); problem != nil || again != out {
			t.Errorf("%s: normalizing twice gives %q, %v", tc.name, again, problem)
		}
	}
}

func TestQuotingErrorShowsTheFirstRows(t *testing.T) {
	_, problem := normalizeCSV(strings.Repeat("a,b,c,d\n", 7), threeColumns)
	if problem == nil {
		t.Fatal("no problem")
	}
	if msg := problem.Error(); !strings.Contains(msg, "line 1 has 4 cells") || !strings.Contains(msg, "line 5 has 4 cells") ||
		strings.Contains(msg, "line 6") || !strings.HasSuffix(msg, "and 2 more") {
		t.Errorf("unexpected message %q", msg)
	}
	if len(problem.rows) != 7 {
		t.Errorf("rows %q, want all 7 for the repair call", problem.rows)
	}
}

func TestShapeForEveryExportType(t *testing.T) {
	widths := map[ExportType]int{GimKit: 5, Blooket: 8, Wayground: 11, GestureQuiz: 12}
	for exportType, want := range widths {
		if got := shapeFor(true, Options{ExportType: exportType}).width(); got != want {
			t.Errorf("export type %d: %d columns, want %d", exportType, got, want)
		}
	}
	if simple := shapeFor(false, Options{}); simple.width() != 2 || !simple.hasHeader {
		t.Errorf("simple shape %+v", simple)
	}
}

// recordingLLM answers each call with the next of answers, the model's text, as a /responses or a chat
// completion answer by the path, and keeps every request's body.
func recordingLLM(t *testing.T, answers ...string) (*Client, *[]map[string]any) {
	t.Helper()
	var (
		mu       sync.Mutex
		requests []map[string]any
	)
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &req)
		mu.Lock()
		requests = append(requests, req)
		answer := answers[min(len(requests), len(answers))-1]
		mu.Unlock()
		text, _ := json.Marshal(answer)
		if strings.HasSuffix(r.URL.Path, "/responses") {
			_, _ = w.Write([]byte(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":` + string(text) + `}]}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":` + string(text) + `},"finish_reason":"stop"}]}`))
	}))
	t.Cleanup(llm.Close)
	c := NewClient(llm.URL, "key", "m", nil, 0, slog.New(slog.DiscardHandler))
	c.baseBackoff = time.Millisecond
	return c, &requests
}

func TestGenerateAsksTheModelToRequoteACSVItCannotFix(t *testing.T) {
	broken := "Hello, world,Xin chào,a,b,c\nGood,Tốt,a,b,c"
	c, requests := recordingLLM(t, broken, "```csv\n\"Hello, world\",\"Xin chào\",\"a\",\"b\",\"c\"\n\"Good\",\"Tốt\",\"a\",\"b\",\"c\"\n```")
	result, err := c.Generate(context.Background(), nil, true, Options{ExportType: GimKit})
	want := `"Hello, world","Xin chào","a","b","c"` + "\n" + `"Good","Tốt","a","b","c"`
	if err != nil || result.CSV != want {
		t.Fatalf("got %q, %v; want %q", result.CSV, err, want)
	}
	if result.Usage.Calls != 2 || len(*requests) != 2 {
		t.Fatalf("usage %+v after %d requests, want 2 calls", result.Usage, len(*requests))
	}
	repair := (*requests)[1]
	instructions, _ := repair["instructions"].(string)
	input, _ := json.Marshal(repair["input"])
	if !strings.Contains(instructions, "exactly 5 cells") || !strings.Contains(instructions, "no header row") ||
		repair["tools"] != nil || repair["model"] != "m" {
		t.Errorf("unexpected repair request %v", repair)
	}
	if !strings.Contains(string(input), "line 1 has 6 cells") || !strings.Contains(string(input), "Hello, world,Xin chào") {
		t.Errorf("the repair request does not carry the CSV and its problem: %s", input)
	}
}

func TestGenerateRepairsASimpleCSVOverChatCompletions(t *testing.T) {
	c, requests := recordingLLM(t, "Câu hỏi,Đáp án\nxin chào, nǐ hǎo,你好", `"Câu hỏi","Đáp án"`+"\n"+`"xin chào, nǐ hǎo","你好"`)
	result, err := c.Generate(context.Background(), nil, false, Options{})
	if err != nil || result.CSV != `"Câu hỏi","Đáp án"`+"\n"+`"xin chào, nǐ hǎo","你好"` {
		t.Fatalf("got %q, %v", result.CSV, err)
	}
	messages, _ := json.Marshal((*requests)[1]["messages"])
	if len(*requests) != 2 || !strings.Contains(string(messages), "The first row is the header") {
		t.Errorf("unexpected repair request %s", messages)
	}
}

func TestGenerateFailsWhenTheRepairIsStillWrong(t *testing.T) {
	c, requests := recordingLLM(t, "a,b,c,d,e,f")
	result, err := c.Generate(context.Background(), nil, true, Options{ExportType: GimKit})
	if FailureCode(err) != FailureBadOutput || result.Usage.Calls != 2 || len(*requests) != 2 {
		t.Fatalf("got %v (%s), usage %+v after %d requests", err, FailureCode(err), result.Usage, len(*requests))
	}
}

func TestGenerateSkipsTheRepairWithoutTimeForIt(t *testing.T) {
	c, requests := recordingLLM(t, "a,b,c,d,e,f")
	ctx, cancel := context.WithTimeout(context.Background(), minRepairBudget/2)
	defer cancel()
	_, err := c.Generate(ctx, nil, true, Options{ExportType: GimKit})
	var badOutput *badOutputError
	if !errors.As(err, &badOutput) || len(*requests) != 1 {
		t.Fatalf("got %v after %d requests", err, len(*requests))
	}
}

func TestGenerateRepairKeepsQuotesCommasAndChinese(t *testing.T) {
	// A GimKit row with a quoted word and a comma in the question, unquoted, and the optional cells left out.
	broken := `Chọn từ đúng: "你好", nghĩa là gì?,Xin chào,Tạm biệt` + "\n" + `"Số ""三"" là?","ba","hai, bốn"`
	repaired := `"Chọn từ đúng: ""你好"", nghĩa là gì?","Xin chào","Tạm biệt","",""` + "\n" + `"Số ""三"" là?","ba","hai, bốn"`
	c, requests := recordingLLM(t, broken, repaired)
	result, err := c.Generate(context.Background(), nil, true, Options{ExportType: GimKit})
	want := `"Chọn từ đúng: ""你好"", nghĩa là gì?","Xin chào","Tạm biệt","",""` + "\n" + `"Số ""三"" là?","ba","hai, bốn","",""`
	if err != nil || result.CSV != want {
		t.Fatalf("got %q, %v; want %q", result.CSV, err, want)
	}
	input, _ := json.Marshal((*requests)[1]["input"])
	var parts []struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	_ = json.Unmarshal(input, &parts)
	if len(parts) != 1 || len(parts[0].Content) != 1 {
		t.Fatalf("unexpected repair input %s", input)
	}
	if text := parts[0].Content[0].Text; !strings.Contains(text, "line 1 has 4 cells") || strings.Contains(text, "line 2") ||
		!strings.HasSuffix(text, broken) {
		t.Errorf("the repair input does not carry the answer as it was and only its broken line: %q", text)
	}
	cells := gesturequiz.SplitRows(result.CSV)
	if cells[0][0] != `Chọn từ đúng: "你好", nghĩa là gì?` || cells[1][2] != "hai, bốn" {
		t.Errorf("the client would read %q", cells)
	}
}
