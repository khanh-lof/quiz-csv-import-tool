package csvgen

import (
	"context"
	_ "embed"
	"fmt"
	"strings"
	"text/template"
	"time"
)

// Every CSV the model writes is checked before it is stored: the prompts ask for every cell in double quotes,
// because a comma or a quote inside an unquoted question, option or explanation splits the cell and shifts
// every cell after it. What the server can fix for certain it fixes itself (normalizeCSV); a row whose cells
// it cannot tell apart is sent back to the model once to re-quote (repairCSV), and a CSV still wrong after
// that fails the job as bad_output.

// simpleColumns are the columns of the simple mode's CSV, which, unlike the creative mode's, has its header row.
const simpleColumns = "Câu hỏi,Đáp án"

// creativeColumns are the columns of a creative export type's rows, as the prompt names them: the CsvHeader of
// the client-side CsvBuilder, or for GestureQuiz the columns the game's own CSV parser reads. Radicals is not
// a CSV and has none.
func creativeColumns(t ExportType) string {
	switch t {
	case GimKit:
		return "Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2 (Optional),Incorrect Answer 3 (Optional)"
	case Blooket:
		return "Question #,Question Text,Answer 1,Answer 2,Answer 3,Answer 4,Time Limit (sec),Correct Answer(s)"
	case Wayground:
		return "Question Text,Question Type,Option 1,Option 2,Option 3,Option 4,Option 5,Correct Answer,Time in seconds,Image Link,Answer explanation"
	case GestureQuiz:
		return "Stage,Question,Question Pinyin,Correct Answer,Correct Answer Pinyin,Wrong Answer 1,Wrong Answer 1 Pinyin,Wrong Answer 2,Wrong Answer 2 Pinyin,Wrong Answer 3,Wrong Answer 3 Pinyin,Explanation"
	}
	panic(fmt.Sprintf("csvgen: no CSV columns for export type %d", t))
}

// csvShape is what a generation's CSV must look like: its columns and whether its first row is their header.
type csvShape struct {
	columns   string
	hasHeader bool
}

func (s csvShape) width() int { return strings.Count(s.columns, ",") + 1 }

func shapeFor(creative bool, opts Options) csvShape {
	if !creative {
		return csvShape{columns: simpleColumns, hasHeader: true}
	}
	return csvShape{columns: creativeColumns(opts.ExportType)}
}

// quotingError is a CSV with rows whose cells the server cannot tell apart, most often because a cell holding a
// comma was not quoted. rows says, for each, its line in the CSV and what is wrong with it.
type quotingError struct {
	width int
	rows  []string
}

func (e *quotingError) Error() string {
	const shown = 5
	rows := e.rows
	more := ""
	if len(rows) > shown {
		rows, more = rows[:shown], fmt.Sprintf(" and %d more", len(e.rows)-shown)
	}
	return fmt.Sprintf("CSV rows do not split into %d cells: %s%s", e.width, strings.Join(rows, "; "), more)
}

// normalizeCSV reads the model's CSV leniently (readCSV) and writes it back with every cell in double quotes, ""
// for a quote inside one, one row per line. It fixes for certain only what does not change which text is in
// which cell: missing quotes around cells that hold no comma, a bare quote inside a cell, spaces around cells,
// blank rows, a byte-order mark, extra empty cells at the end of a row, and missing ones at the end of a row
// whose cells are all quoted (a writer often leaves out trailing empty cells). A row with more cells than
// columns, the extra ones not empty, a quote that is never closed, or fewer cells than columns when a cell is
// not quoted (an unquoted comma that also hides a missing cell) or holds a line break (a missing closing quote
// that ran into the next rows), is a quotingError: only the meaning of the text says where its cells end. An
// empty CSV is returned as it is.
func normalizeCSV(content string, shape csvShape) (string, *quotingError) {
	if strings.TrimSpace(content) == "" {
		return content, nil
	}
	content = strings.TrimPrefix(content, string(rune(0xFEFF)))
	width := shape.width()
	var out strings.Builder
	var bad []string
	for _, row := range readCSV(content) {
		cells := row.cells
		for len(cells) > 0 && cells[len(cells)-1] == "" && (len(cells) > width || allEmpty(cells)) {
			cells = cells[:len(cells)-1]
		}
		switch {
		case len(cells) == 0:
			continue
		case row.unclosed:
			bad = append(bad, fmt.Sprintf("line %d has a quote that is never closed", row.line))
			continue
		case len(cells) != width && (len(cells) > width || row.bare || hasLineBreak(cells)):
			bad = append(bad, fmt.Sprintf("line %d has %d cells", row.line, len(cells)))
			continue
		}
		for len(cells) < width {
			cells = append(cells, "")
		}
		if out.Len() > 0 {
			out.WriteByte('\n')
		}
		writeQuotedRow(&out, cells)
	}
	if len(bad) > 0 {
		return "", &quotingError{width: width, rows: bad}
	}
	return out.String(), nil
}

// csvRow is a row as readCSV found it: the line it starts on, its trimmed cells, whether a quoted cell in it is
// never closed, and whether a cell with text in it is not quoted.
type csvRow struct {
	line     int
	cells    []string
	unclosed bool
	bare     bool
}

// readCSV splits a CSV into rows and cells the way a forgiving reader would. A cell that starts with a quote
// (after spaces) is quoted: "" in it is one quote, and a quote ends it only when what follows, past any spaces,
// is a comma, a line break or the end; any other quote is kept as text. In a cell that does not start with a
// quote, quotes are text. A row ends at a line break (\r\n or \n) outside quotes.
func readCSV(content string) []csvRow {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	n := len(content)
	isSpace := func(c byte) bool { return c == ' ' || c == '\t' }
	var rows []csvRow
	line := 1
	for i := 0; i < n; {
		row := csvRow{line: line}
		for {
			for i < n && isSpace(content[i]) {
				i++
			}
			var cell strings.Builder
			if i < n && content[i] == '"' {
				i++
				closed := false
				for i < n && !closed {
					c := content[i]
					switch {
					case c == '"' && i+1 < n && content[i+1] == '"':
						cell.WriteByte('"')
						i += 2
					case c == '"':
						j := i + 1
						for j < n && isSpace(content[j]) {
							j++
						}
						if j == n || content[j] == ',' || content[j] == '\n' {
							i, closed = j, true
						} else {
							cell.WriteByte('"')
							i++
						}
					default:
						if c == '\n' {
							line++
						}
						cell.WriteByte(c)
						i++
					}
				}
				row.unclosed = row.unclosed || !closed
			} else {
				for i < n && content[i] != ',' && content[i] != '\n' {
					cell.WriteByte(content[i])
					i++
				}
				row.bare = row.bare || strings.TrimSpace(cell.String()) != ""
			}
			row.cells = append(row.cells, strings.TrimSpace(cell.String()))
			if i < n && content[i] == ',' {
				i++
				continue
			}
			break
		}
		if i < n && content[i] == '\n' {
			i++
			line++
		}
		rows = append(rows, row)
	}
	return rows
}

func allEmpty(cells []string) bool {
	for _, cell := range cells {
		if cell != "" {
			return false
		}
	}
	return true
}

func hasLineBreak(cells []string) bool {
	for _, cell := range cells {
		if strings.ContainsAny(cell, "\r\n") {
			return true
		}
	}
	return false
}

func writeQuotedRow(out *strings.Builder, cells []string) {
	for i, cell := range cells {
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteByte('"')
		out.WriteString(strings.ReplaceAll(cell, `"`, `""`))
		out.WriteByte('"')
	}
}

//go:embed prompts/csv_repair.txt
var csvRepairTemplate string

var csvRepairPrompt = template.Must(template.New("csv_repair").Option("missingkey=error").Parse(normalizePrompt(csvRepairTemplate)))

// minRepairBudget is the least time left before the deadline worth starting the repair call with: it only
// rewrites the CSV, with no thinking about the lesson and no searches, so it needs less than a generation.
const minRepairBudget = 20 * time.Second

// checkedCSV is the generation's CSV normalized (see normalizeCSV). When the server cannot fix it, the same
// model, on the same endpoint, is asked once to re-quote it, and its answer is normalized in turn; a CSV still
// wrong after that, or too little time left for the call, is a badOutputError. A failed repair call is
// returned as its own error, so a deadline or an outage reads as what it is.
func (c *Client) checkedCSV(ctx context.Context, content string, creative bool, opts Options, usage *Usage) (string, error) {
	shape := shapeFor(creative, opts)
	fixed, problem := normalizeCSV(content, shape)
	if problem == nil {
		return fixed, nil
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < minRepairBudget {
		return "", &badOutputError{problem}
	}
	c.logger.Warn("asking the LLM to re-quote its CSV", "model", usage.Model, "problem", problem.Error())
	repaired, err := c.repairCSV(ctx, content, shape, problem, creative, usage)
	if err != nil {
		return "", err
	}
	if fixed, problem = normalizeCSV(ExtractCSVContent(repaired), shape); problem != nil {
		return "", &badOutputError{fmt.Errorf("after the repair call: %w", problem)}
	}
	return fixed, nil
}

// repairCSV asks the model to put content's cells in double quotes, changing nothing else. Its progress is not
// reported: the job already showed the rows the generation wrote.
func (c *Client) repairCSV(ctx context.Context, content string, shape csvShape, problem *quotingError, creative bool, usage *Usage) (string, error) {
	system := executePrompt(csvRepairPrompt, map[string]any{
		"Width":     shape.width(),
		"Columns":   shape.columns,
		"HasHeader": shape.hasHeader,
	})
	user := fmt.Sprintf("Rows that do not split into %d cells: %s.\n\nCSV to fix:\n%s",
		shape.width(), strings.Join(problem.rows, "; "), content)
	if creative {
		return c.respond(ctx, responsesRequest{
			Model:           usage.Model,
			Instructions:    system,
			Input:           []responsesInput{{Role: "user", Content: inputParts([]string{user}, nil)}},
			MaxOutputTokens: maxOutputTokensLarge,
		}, usage, nil)
	}
	return c.complete(ctx, newRequest(usage.Model, system, "low", []contentPart{textPart(user)}), usage, nil)
}
