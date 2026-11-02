package radicals

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// RenderHTML returns the standalone page of an exercise: the template, the colours, the data and the outlines of
// the characters, drawn from MMAH's strokes. Fonts come from a CDN.
func RenderHTML(ex *Exercise) (string, error) {
	if ex == nil {
		return "", errors.New("No exercise to render.")
	}
	data, err := loadData()
	if err != nil {
		return "", err
	}
	css, err := themeCSS(ex.Preset)
	if err != nil {
		return "", err
	}
	glyphs, err := renderGlyphs(data, ex.Glyphs)
	if err != nil {
		return "", err
	}
	parts, chars, words, lessons := objectOrEmpty(ex.Parts), objectOrEmpty(ex.Chars), objectOrEmpty(ex.Words), objectOrEmpty(ex.Lessons)
	for name, raw := range map[string]json.RawMessage{"parts": parts, "chars": chars, "words": words, "lessons": lessons} {
		if !json.Valid(raw) {
			return "", fmt.Errorf("The exercise's %s are not valid JSON.", name)
		}
	}

	var js strings.Builder
	js.WriteString("/* Data generated automatically — do not edit by hand. */\n")
	js.WriteString("const CFG = " + scriptSafe(marshal(ex.Config)) + ";\n")
	js.WriteString("const GLYPHS = " + scriptSafe(glyphs) + ";\n\n")
	js.WriteString("const LESSON_TITLES = " + scriptSafe(marshal(ex.LessonTitles)) + ";\n\n")
	js.WriteString("/* ---- Components / structural parts ---- */\nconst PARTS = " + scriptSafe(parts) + ";\n\n")
	js.WriteString("/* ---- Characters: meaning, strokes, structure (parts: [left|top, right|bottom]) ---- */\nconst CHARS = " + scriptSafe(chars) + ";\n\n")
	js.WriteString("/* ---- Words: pinyin of each syllable ---- */\nconst WORDS = " + scriptSafe(words) + ";\n\n")
	js.WriteString("/* ---- Lessons ---- */\nconst LESSONS = " + scriptSafe(lessons) + ";\n")

	head := strings.NewReplacer("{{TITLE}}", pyEscape(ex.Title), "/*THEME_OVERRIDE*/", css, "{{FOOTER}}", ex.Footer).Replace(data.head)
	return head + js.String() + "\n" + data.logic, nil
}

func objectOrEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return json.RawMessage("{}")
	}
	return raw
}

// scriptSafe makes JSON safe inside a <script> element: no "<" can close it or open a comment.
func scriptSafe(raw []byte) string {
	return strings.NewReplacer("<", `<`, " ", ` `, " ", ` `).Replace(string(raw))
}

// renderGlyphs draws the characters of an exercise as SVG path data, one path per component name. "*" is every
// stroke no listed component owns.
func renderGlyphs(data *dataset, glyphs map[string][]string) (json.RawMessage, error) {
	chars := make([]string, 0, len(glyphs))
	for c := range glyphs {
		chars = append(chars, c)
	}
	slices.Sort(chars)
	out := newObjectWriter()
	for _, c := range chars {
		strokes := data.strokes(c)
		if len(strokes) == 0 {
			continue
		}
		owned := map[int]bool{}
		paths := newObjectWriter()
		var split *decomposition
		for _, name := range glyphs[c] {
			if name == "*" {
				continue
			}
			if split == nil {
				var err error
				if split, err = data.split(c); err != nil {
					return nil, fmt.Errorf("Character %s cannot be split into components.", c)
				}
			}
			indexes := split.strokesOf(name)
			if len(indexes) == 0 {
				return nil, fmt.Errorf("Character %s has no component %s.", c, name)
			}
			for _, i := range indexes {
				owned[i] = true
			}
			paths.add(name, joinStrokes(strokes, indexes))
		}
		if slices.Contains(glyphs[c], "*") {
			var rest []int
			for i := range strokes {
				if !owned[i] {
					rest = append(rest, i)
				}
			}
			if len(rest) > 0 {
				paths.add("*", joinStrokes(strokes, rest))
			}
		}
		out.add(c, json.RawMessage(paths.json()))
	}
	return out.json(), nil
}

func joinStrokes(strokes []string, indexes []int) string {
	var parts []string
	for _, i := range indexes {
		if i >= 0 && i < len(strokes) {
			parts = append(parts, transformPath(strokes[i]))
		}
	}
	return strings.Join(parts, " ")
}

// transformPath moves a path from MMAH's 1024 box (y up, baseline at 900) to the page's 1000-unit box (y down).
func transformPath(path string) string {
	tokens := strings.Fields(path)
	out := make([]string, 0, len(tokens))
	var pending []float64
	for _, t := range tokens {
		v, err := strconv.ParseFloat(t, 64)
		if err != nil {
			out = append(out, t)
			continue
		}
		pending = append(pending, v)
		if len(pending) == 2 {
			out = append(out, formatNumber(pending[0]*1000/1024), formatNumber((900-pending[1])*1000/1024))
			pending = pending[:0]
		}
	}
	return strings.Join(out, " ")
}

func formatNumber(v float64) string {
	s := strconv.FormatFloat(v, 'f', 1, 64)
	s = strings.TrimRight(s, "0")
	return strings.TrimRight(s, ".")
}
