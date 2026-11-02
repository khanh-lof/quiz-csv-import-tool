package radicals

import (
	"bytes"
	"compress/gzip"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"

	"golang.org/x/text/unicode/norm"
)

//go:embed data/mmah.jsonl.gz data/gb2312_level1.txt data/common_chars.txt data/pool_chars.json data/pool_components.json
//go:embed data/pool_word_meanings.json data/template/head.html data/template/logic.js
var dataFiles embed.FS

// etymology is Make Me a Hanzi's account of how a character was formed.
type etymology struct {
	Type     string `json:"type"`
	Hint     string `json:"hint"`
	Semantic string `json:"semantic"`
	Phonetic string `json:"phonetic"`
}

// mmahEntry is one line of data/mmah.jsonl.gz without its strokes, which are read from the line when drawn.
type mmahEntry struct {
	Char       string     `json:"c"`
	Decomposed string     `json:"d"`
	Matches    [][]int    `json:"m"`
	Pinyin     []string   `json:"p"`
	Etymology  *etymology `json:"e"`
	Definition string     `json:"f"`
}

// poolChar is a curated character of the pool: reading, meaning, stroke count and, for a split one, its parts.
type poolChar struct {
	Pinyin     string   `json:"py"`
	Vietnamese string   `json:"vi"`
	Strokes    int      `json:"st"`
	Parts      []string `json:"parts"`
	Structure  string   `json:"struct"`
}

// poolComponent is a curated component of the pool.
type poolComponent struct {
	Name       string `json:"name"`
	Zh         string `json:"zh"`
	Pinyin     string `json:"py"`
	Vietnamese string `json:"vi"`
	Strokes    int    `json:"st"`
	Tip        string `json:"tip"`
	NoGlyph    bool   `json:"noGlyph"`
	From       string `json:"from"`
	BaseRole   string `json:"base_role"`
}

// dataset is everything embedded, loaded once.
type dataset struct {
	entries        map[string]*mmahEntry
	lines          map[string][]byte // the raw JSON line of each character, for its strokes
	gb2312Level1   map[string]bool
	commonChars    map[string]bool
	poolChars      map[string]poolChar
	poolComponents map[string]poolComponent
	poolWords      map[string]string
	head, logic    string
}

var (
	loadOnce sync.Once
	loaded   *dataset
	loadErr  error
)

// loadData decompresses and indexes the embedded data on first use.
func loadData() (*dataset, error) {
	loadOnce.Do(func() { loaded, loadErr = readDataset() })
	return loaded, loadErr
}

func readDataset() (*dataset, error) {
	d := &dataset{entries: map[string]*mmahEntry{}, lines: map[string][]byte{}}

	compressed, err := dataFiles.ReadFile("data/mmah.jsonl.gz")
	if err != nil {
		return nil, err
	}
	zr, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, fmt.Errorf("data/mmah.jsonl.gz: %w", err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, fmt.Errorf("data/mmah.jsonl.gz: %w", err)
	}
	for len(raw) > 0 {
		line := raw
		if end := bytes.IndexByte(raw, '\n'); end >= 0 {
			line, raw = raw[:end], raw[end+1:]
		} else {
			raw = nil
		}
		if len(line) == 0 {
			continue
		}
		var e mmahEntry
		if err := json.Unmarshal(line, &e); err != nil {
			return nil, fmt.Errorf("data/mmah.jsonl.gz: %w", err)
		}
		d.entries[e.Char] = &e
		d.lines[e.Char] = line
	}

	if d.gb2312Level1, err = readCharSet("data/gb2312_level1.txt"); err != nil {
		return nil, err
	}
	if d.commonChars, err = readCharSet("data/common_chars.txt"); err != nil {
		return nil, err
	}
	for name, target := range map[string]any{
		"data/pool_chars.json":         &d.poolChars,
		"data/pool_components.json":    &d.poolComponents,
		"data/pool_word_meanings.json": &d.poolWords,
	} {
		content, err := dataFiles.ReadFile(name)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(content, target); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
	}
	head, err := dataFiles.ReadFile("data/template/head.html")
	if err != nil {
		return nil, err
	}
	logic, err := dataFiles.ReadFile("data/template/logic.js")
	if err != nil {
		return nil, err
	}
	d.head, d.logic = string(head), string(logic)
	return d, nil
}

func readCharSet(name string) (map[string]bool, error) {
	content, err := dataFiles.ReadFile(name)
	if err != nil {
		return nil, err
	}
	return setOf(strings.TrimSpace(string(content))), nil
}

// strokes returns the stroke paths of a character as MMAH has them (1024 box, y up), or nil.
func (d *dataset) strokes(char string) []string {
	line, ok := d.lines[char]
	if !ok {
		return nil
	}
	var e struct {
		Strokes []string `json:"s"`
	}
	if err := json.Unmarshal(line, &e); err != nil {
		return nil
	}
	return e.Strokes
}

// readings lists the readings of a character, tone marks kept: those of MMAH and of the curated pool.
func (d *dataset) readings(char string) []string {
	normalize := func(s string) string { return norm.NFC.String(strings.ToLower(strings.TrimSpace(s))) }
	var readings []string
	add := func(r string) {
		if r = normalize(r); r != "" && !slices.Contains(readings, r) {
			readings = append(readings, r)
		}
	}
	if entry := d.entries[char]; entry != nil {
		for _, p := range entry.Pinyin {
			add(p)
		}
	}
	for _, p := range strings.Split(d.poolChars[char].Pinyin, "/") {
		add(p)
	}
	return readings
}
