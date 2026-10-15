package gesturequiz

import (
	"regexp"
	"strings"
)

// isJSSpace is what JavaScript's String.prototype.trim and the \s class of its regular expressions treat
// as white space: its WhiteSpace and LineTerminator sets. Go's own notions differ at the edges (they
// include U+0085 and leave out U+FEFF, and RE2's \s is ASCII only), and the client's parser trims every
// cell, so the port uses the client's set to read a CSV the same way.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// jsWS is the class of those characters, for the two expressions below.
const jsWS = `[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	fencedCSV    = regexp.MustCompile("(?i)```(?:csv)?" + jsWS + `*([\s\S]*?)` + "```")
	simpleHeader = regexp.MustCompile(`(?i)(?:^|\n)(Câu hỏi` + jsWS + `*,` + jsWS + `*Đáp án[\s\S]*)`)
)

// byteOrderMark is what a file saved by some spreadsheets starts with; the page drops it before reading.
var byteOrderMark = string(rune(0xFEFF))

// ExtractCSV is the client's extractCsvContent plus its byte-order-mark strip: the model sometimes wraps
// the CSV in a code fence or puts a sentence before it. The text is trimmed; a ``` or ```csv fenced block
// wins; else everything from a "Câu hỏi , Đáp án" header line on; else the trimmed text itself.
func ExtractCSV(raw string) string {
	trimmed := jsTrim(raw)
	if trimmed == "" {
		return ""
	}
	text := trimmed
	if m := fencedCSV.FindStringSubmatch(trimmed); m != nil && m[1] != "" {
		text = jsTrim(m[1])
	} else if m := simpleHeader.FindStringSubmatch(trimmed); m != nil && m[1] != "" {
		text = jsTrim(m[1])
	}
	return strings.TrimPrefix(text, byteOrderMark)
}

// SplitRows is the client's parseCsvRows: the cells of every row, with no header handling. A cell may be
// quoted, with "" for a quote inside it and commas and line breaks kept as they are; a row ends at \n, \r
// or \r\n outside quotes; every cell is trimmed. A final row without a line break counts, and a break at
// the very end does not add an empty row.
func SplitRows(content string) [][]string {
	var rows [][]string
	var row []string
	var value []rune
	inQuotes := false

	runes := []rune(content)
	for i := 0; i < len(runes); i++ {
		char := runes[i]
		switch {
		case char == '"':
			if inQuotes && i+1 < len(runes) && runes[i+1] == '"' {
				value = append(value, '"')
				i++
			} else {
				inQuotes = !inQuotes
			}
		case char == ',' && !inQuotes:
			row = append(row, jsTrim(string(value)))
			value = value[:0]
		case (char == '\n' || char == '\r') && !inQuotes:
			if char == '\r' && i+1 < len(runes) && runes[i+1] == '\n' {
				i++
			}
			row = append(row, jsTrim(string(value)))
			rows = append(rows, row)
			row, value = nil, value[:0]
		default:
			value = append(value, char)
		}
	}
	if len(value) > 0 || len(row) > 0 {
		row = append(row, jsTrim(string(value)))
		rows = append(rows, row)
	}
	return rows
}
