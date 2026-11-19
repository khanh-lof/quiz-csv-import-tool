package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

//go:embed templates static
var assets embed.FS

type pager struct {
	Page    int
	Pages   int
	Total   int64
	From    int
	To      int
	PrevURL string
	NextURL string
}

func newPager(r *http.Request, page int, total int64, shown int) pager {
	p := pager{Page: page, Total: total, Pages: max(1, int((total+pageSize-1)/pageSize))}
	if shown > 0 {
		p.From = (page-1)*pageSize + 1
		p.To = p.From + shown - 1
	}
	link := func(n int) string {
		q := r.URL.Query()
		q.Del("ok")
		q.Del("err")
		q.Set("page", strconv.Itoa(n))
		return r.URL.Path + "?" + q.Encode()
	}
	if page > 1 {
		p.PrevURL = link(page - 1)
	}
	if page < p.Pages {
		p.NextURL = link(page + 1)
	}
	return p
}

func pageParam(r *http.Request) int {
	n, err := strconv.Atoi(r.URL.Query().Get("page"))
	if err != nil || n < 1 {
		return 1
	}
	return n
}

func (a *app) loadTemplates() (map[string]*template.Template, error) {
	funcs := a.templateFuncs()
	paths, err := fs.Glob(assets, "templates/*.html")
	if err != nil {
		return nil, err
	}
	out := map[string]*template.Template{}
	for _, path := range paths {
		name := strings.TrimSuffix(strings.TrimPrefix(path, "templates/"), ".html")
		if name == "layout" || name == "partials" {
			continue
		}
		t, err := template.New(name).Funcs(funcs).ParseFS(assets, "templates/layout.html", "templates/partials.html", path)
		if err != nil {
			return nil, fmt.Errorf("parsing %s: %w", path, err)
		}
		out[name] = t
	}
	return out, nil
}

func (a *app) templateFuncs() template.FuncMap {
	return template.FuncMap{
		"dt":  formatTime,
		"ago": ago,
		"dur": formatDuration,
		"ms": func(ms any) string {
			switch v := ms.(type) {
			case int64:
				return formatDuration(time.Duration(v) * time.Millisecond)
			case float64:
				return formatDuration(time.Duration(v * float64(time.Millisecond)))
			}
			return ""
		},
		"num":      formatNumber,
		"path":     url.PathEscape,
		"join":     strings.Join,
		"ints":     joinInts,
		"truncate": truncate,
		"pretty":   prettyBSON,
		"today":    func() string { return time.Now().Format("Monday, 2 January 2006") },
		"plural": func(n any, one, many string) string {
			s := formatNumber(n)
			if s == "1" {
				return s + " " + one
			}
			return s + " " + many
		},
		"dict": dict,
		"prettyJSON": func(s string) string {
			var buf bytes.Buffer
			if json.Indent(&buf, []byte(s), "", "  ") != nil {
				return s
			}
			return buf.String()
		},
		"percent": func(part, whole int) int {
			if whole == 0 {
				return 0
			}
			return part * 100 / whole
		},
		"barWidth": func(part, whole int) string {
			if whole == 0 {
				return "0%"
			}
			return strconv.FormatFloat(float64(part)*100/float64(whole), 'f', 1, 64) + "%"
		},
		"english":  func(language int) bool { return language == int(csvgen.English) },
		"platform": platform,
		"exportTypes": func() []string {
			var names []string
			for t := csvgen.GimKit; t <= csvgen.Radicals; t++ {
				names = append(names, t.Name())
			}
			return names
		},
		"course":    course,
		"duration":  jobDuration,
		"stale":     func(j store.Job) bool { return a.abandonedCutoffs(time.Now()).Expires(j) },
		"staleRule": a.staleRule,
		"sessions":  func(u store.User) int { return len(activeSessions(u)) },
		"hasRole":   hasRole,
		"open":      func(asg store.Assignment) bool { return asg.OpenAt(time.Now()) },
		"stages":    stagesOf,
		"passed":    passedStages,
		"score":     score,
		"runs":      func(p store.Player, stage string) int { return p.RunsStarted(stage) },
		"studentURL": func(code string) string {
			return a.clientURL + "/play/s/" + url.PathEscape(code)
		},
		"localInput": func(t *time.Time) string {
			if t == nil {
				return ""
			}
			return t.In(time.Local).Format("2006-01-02T15:04")
		},
	}
}

func dict(pairs ...any) (map[string]any, error) {
	if len(pairs)%2 != 0 {
		return nil, errors.New("dict needs key and value pairs")
	}
	m := make(map[string]any, len(pairs)/2)
	for i := 0; i < len(pairs); i += 2 {
		key, ok := pairs[i].(string)
		if !ok {
			return nil, errors.New("dict keys must be strings")
		}
		m[key] = pairs[i+1]
	}
	return m, nil
}

func platform(j store.Job) string {
	switch {
	case j.ExportType != nil:
		return csvgen.ExportType(*j.ExportType).Name()
	case j.Creative:
		return "?"
	default:
		return "Formatted"
	}
}

func course(j store.Job) string {
	if j.CourseType == nil {
		return ""
	}
	courseType := csvgen.CourseType(*j.CourseType)
	name := courseType.Name()
	if courseType == csvgen.Other && j.CourseName != "" {
		name = j.CourseName
	}
	if j.HskStandard != nil {
		name += " " + strconv.Itoa(*j.HskStandard) + ".0"
	}
	if j.Level != nil {
		name += " L" + strconv.Itoa(*j.Level)
	}
	return name
}

func jobDuration(j store.Job) time.Duration {
	if j.FinishedAt == nil {
		return time.Since(j.CreatedAt)
	}
	return j.FinishedAt.Sub(j.CreatedAt)
}

func activeSessions(u store.User) []store.RefreshToken {
	now := time.Now()
	var active []store.RefreshToken
	for _, t := range u.RefreshTokens {
		if t.ExpiresAt.After(now) {
			active = append(active, t)
		}
	}
	return active
}

func hasRole(u store.User, role string) bool {
	return slices.ContainsFunc(u.Roles, func(r string) bool { return strings.EqualFold(r, role) })
}

func stagesOf(asg store.Assignment) []string {
	var stages []string
	for stage := range asg.StageCounts {
		stages = append(stages, stage)
	}
	slices.Sort(stages)
	return stages
}

func passedStages(p store.Player) int {
	passed := 0
	for _, r := range p.Stages {
		if r.Passed {
			passed++
		}
	}
	return passed
}

func score(p store.Player) int {
	total := 0
	for _, r := range p.Stages {
		total += r.Correct
	}
	return total
}

func formatTime(v any) string {
	t, ok := asTime(v)
	if !ok {
		return ""
	}
	return t.In(time.Local).Format("2006-01-02 15:04:05")
}

func ago(v any) string {
	t, ok := asTime(v)
	if !ok {
		return ""
	}
	d := time.Since(t)
	if d < 0 {
		return "in " + roughDuration(-d)
	}
	if d < 10*time.Second {
		return "just now"
	}
	return roughDuration(d) + " ago"
}

func roughDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return strconv.Itoa(int(d.Seconds())) + "s"
	case d < time.Hour:
		return strconv.Itoa(int(d.Minutes())) + "m"
	case d < 48*time.Hour:
		return strconv.Itoa(int(d.Hours())) + "h"
	default:
		return strconv.Itoa(int(d.Hours()/24)) + "d"
	}
}

func formatDuration(d time.Duration) string {
	switch {
	case d <= 0:
		return "0s"
	case d < time.Second:
		return strconv.Itoa(int(d.Milliseconds())) + "ms"
	case d < time.Minute:
		return strconv.FormatFloat(d.Seconds(), 'f', 1, 64) + "s"
	case d < time.Hour:
		return fmt.Sprintf("%dm %02ds", int(d.Minutes()), int(d.Seconds())%60)
	default:
		return fmt.Sprintf("%dh %02dm", int(d.Hours()), int(d.Minutes())%60)
	}
}

func asTime(v any) (time.Time, bool) {
	switch t := v.(type) {
	case time.Time:
		return t, !t.IsZero()
	case *time.Time:
		if t == nil || t.IsZero() {
			return time.Time{}, false
		}
		return *t, true
	}
	return time.Time{}, false
}

func formatNumber(v any) string {
	var n int64
	switch x := v.(type) {
	case int:
		n = int64(x)
	case int64:
		n = x
	}
	s := strconv.FormatInt(max(n, -n), 10)
	var b strings.Builder
	if n < 0 {
		b.WriteByte('-')
	}
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}

func joinInts(values []int) string {
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = strconv.Itoa(v)
	}
	return strings.Join(parts, ", ")
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

func prettyBSON(doc bson.M) string {
	out, err := bson.MarshalExtJSONIndent(doc, false, false, "", "  ")
	if err != nil {
		return err.Error()
	}
	return string(out)
}
