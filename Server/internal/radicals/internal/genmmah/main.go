// Command genmmah trims Make Me a Hanzi down to the characters package radicals can use and writes it as
// data/mmah.jsonl.gz, next to a list of the GB2312 level 1 characters (data/gb2312_level1.txt).
//
// Usage, from Server/:
//
//	go run ./internal/radicals/internal/genmmah <dictionary.txt> <graphics.txt> <out.jsonl.gz>
//
// It keeps every GB2312 character (levels 1 and 2), every character of the pool files that sit next to the output
// (pool_chars.json, pool_components.json, pool_word_meanings.json, common_chars.txt), and every character that
// appears in the decomposition of a kept one, recursively. The output is deterministic.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

type dictionaryEntry struct {
	Character     string   `json:"character"`
	Definition    string   `json:"definition"`
	Pinyin        []string `json:"pinyin"`
	Decomposition string   `json:"decomposition"`
	Etymology     *struct {
		Type     string `json:"type"`
		Hint     string `json:"hint"`
		Semantic string `json:"semantic"`
		Phonetic string `json:"phonetic"`
	} `json:"etymology"`
	Matches [][]int `json:"matches"`
}

type graphicsEntry struct {
	Character string   `json:"character"`
	Strokes   []string `json:"strokes"`
}

type etymology struct {
	Type     string `json:"type,omitempty"`
	Hint     string `json:"hint,omitempty"`
	Semantic string `json:"semantic,omitempty"`
	Phonetic string `json:"phonetic,omitempty"`
}

type outputEntry struct {
	Char       string     `json:"c"`
	Decomposed string     `json:"d"`
	Matches    [][]int    `json:"m"`
	Pinyin     []string   `json:"p"`
	Etymology  *etymology `json:"e,omitempty"`
	Definition string     `json:"f,omitempty"`
	Strokes    []string   `json:"s,omitempty"`
}

const idsOperators = "⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻"

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: genmmah <dictionary.txt> <graphics.txt> <out.jsonl.gz>")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, "genmmah:", err)
		os.Exit(1)
	}
}

func run(dictionaryPath, graphicsPath, outPath string) error {
	dataDir := filepath.Dir(outPath)
	dictionary, order, err := readDictionary(dictionaryPath)
	if err != nil {
		return err
	}
	level1, level2, err := gb2312()
	if err != nil {
		return err
	}
	poolChars, err := readPoolChars(dataDir)
	if err != nil {
		return err
	}

	keep := map[string]bool{}
	var queue []string
	add := func(c string) {
		if !keep[c] {
			if _, ok := dictionary[c]; ok {
				keep[c] = true
				queue = append(queue, c)
			}
		}
	}
	for _, c := range level1 {
		add(c)
	}
	for _, c := range level2 {
		add(c)
	}
	for _, c := range poolChars {
		add(c)
	}
	for len(queue) > 0 {
		c := queue[0]
		queue = queue[1:]
		for _, r := range dictionary[c].Decomposition {
			if !strings.ContainsRune(idsOperators, r) {
				add(string(r))
			}
		}
	}

	strokes, err := readStrokes(graphicsPath, keep)
	if err != nil {
		return err
	}

	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return err
	}
	kept, drawn := 0, 0
	for _, c := range order {
		if !keep[c] {
			continue
		}
		d := dictionary[c]
		out := outputEntry{Char: c, Decomposed: d.Decomposition, Matches: d.Matches, Pinyin: d.Pinyin, Definition: d.Definition, Strokes: strokes[c]}
		if out.Pinyin == nil {
			out.Pinyin = []string{}
		}
		if d.Etymology != nil {
			e := etymology(*d.Etymology)
			out.Etymology = &e
		}
		line, err := marshal(out)
		if err != nil {
			return err
		}
		zw.Write(line)
		zw.Write([]byte{'\n'})
		kept++
		if len(out.Strokes) > 0 {
			drawn++
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := os.WriteFile(outPath, buf.Bytes(), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dataDir, "gb2312_level1.txt"), []byte(strings.Join(level1, "")), 0o644); err != nil {
		return err
	}
	fmt.Printf("kept %d characters (%d with strokes), %d GB2312 level 1; wrote %s (%d bytes)\n", kept, drawn, len(level1), outPath, buf.Len())
	return nil
}

func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

func readDictionary(path string) (map[string]dictionaryEntry, []string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	dictionary := map[string]dictionaryEntry{}
	var order []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<26)
	for scanner.Scan() {
		var e dictionaryEntry
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			return nil, nil, fmt.Errorf("%s: %w", path, err)
		}
		if utf8.RuneCountInString(e.Character) != 1 {
			continue
		}
		if _, dup := dictionary[e.Character]; !dup {
			order = append(order, e.Character)
		}
		dictionary[e.Character] = e
	}
	return dictionary, order, scanner.Err()
}

func readStrokes(path string, keep map[string]bool) (map[string][]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	strokes := map[string][]string{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<26)
	const prefix = `{"character":"`
	for scanner.Scan() {
		line := scanner.Bytes()
		if !bytes.HasPrefix(line, []byte(prefix)) {
			continue
		}
		r, _ := utf8.DecodeRune(line[len(prefix):])
		if !keep[string(r)] {
			continue
		}
		var e graphicsEntry
		if err := json.Unmarshal(line, &e); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		strokes[e.Character] = e.Strokes
	}
	return strokes, scanner.Err()
}

// gb2312 returns the characters of GB2312 level 1 (3755) and level 2 (3008), each in code order.
func gb2312() (level1, level2 []string, err error) {
	decoder := simplifiedchinese.GBK.NewDecoder()
	for hi := 0xB0; hi <= 0xF7; hi++ {
		for lo := 0xA1; lo <= 0xFE; lo++ {
			decoded, err := decoder.Bytes([]byte{byte(hi), byte(lo)})
			if err != nil {
				continue
			}
			r, size := utf8.DecodeRune(decoded)
			if size != len(decoded) || r < 0x4E00 || r > 0x9FFF {
				continue
			}
			if hi <= 0xD7 {
				level1 = append(level1, string(r))
			} else {
				level2 = append(level2, string(r))
			}
		}
	}
	if len(level1) != 3755 || len(level2) != 3008 {
		return nil, nil, fmt.Errorf("GB2312 decoded to %d + %d characters, want 3755 + 3008", len(level1), len(level2))
	}
	return level1, level2, nil
}

// readPoolChars lists every character the pool files mention.
func readPoolChars(dir string) ([]string, error) {
	seen := map[string]bool{}
	var chars []string
	add := func(s string) {
		for _, r := range s {
			if r >= 0x2E80 && !strings.ContainsRune(idsOperators, r) && !seen[string(r)] {
				seen[string(r)] = true
				chars = append(chars, string(r))
			}
		}
	}
	for _, name := range []string{"pool_chars.json", "pool_word_meanings.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			add(k)
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, "pool_components.json"))
	if err != nil {
		return nil, err
	}
	var components map[string]struct {
		From string `json:"from"`
		Zh   string `json:"zh"`
	}
	if err := json.Unmarshal(raw, &components); err != nil {
		return nil, fmt.Errorf("pool_components.json: %w", err)
	}
	keys := make([]string, 0, len(components))
	for k := range components {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		add(k)
		add(components[k].From)
	}
	common, err := os.ReadFile(filepath.Join(dir, "common_chars.txt"))
	if err != nil {
		return nil, err
	}
	add(string(common))
	return chars, nil
}
