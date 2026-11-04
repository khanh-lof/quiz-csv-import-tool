package radicals

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Colours of the page: a few hex colours become every CSS variable (dark, light, border), adjusted so that text stays
// readable (theme.py). Only presets are offered, the default being "jade".

type rgb [3]float64

func hexToRGB(h string) rgb {
	h = strings.TrimPrefix(strings.TrimSpace(h), "#")
	var c rgb
	for i := range c {
		v, _ := strconv.ParseUint(h[i*2:i*2+2], 16, 8)
		c[i] = float64(v)
	}
	return c
}

func rgbToHex(c rgb) string {
	var b [3]int
	for i, x := range c {
		b[i] = int(math.Max(0, math.Min(255, math.RoundToEven(x))))
	}
	return fmt.Sprintf("#%02x%02x%02x", b[0], b[1], b[2])
}

func mix(a, b string, t float64) string {
	x, y := hexToRGB(a), hexToRGB(b)
	var out rgb
	for i := range out {
		out[i] = x[i]*(1-t) + y[i]*t
	}
	return rgbToHex(out)
}

func luminance(h string) float64 {
	channel := func(c float64) float64 {
		c /= 255
		if c <= 0.03928 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	c := hexToRGB(h)
	return 0.2126*channel(c[0]) + 0.7152*channel(c[1]) + 0.0722*channel(c[2])
}

func contrast(a, b string) float64 {
	la, lb := luminance(a), luminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// rgbToHLS and hlsToRGB are Python's colorsys.
func rgbToHLS(r, g, b float64) (h, l, s float64) {
	maxc, minc := math.Max(r, math.Max(g, b)), math.Min(r, math.Min(g, b))
	sumc, rangec := maxc+minc, maxc-minc
	l = sumc / 2.0
	if minc == maxc {
		return 0, l, 0
	}
	if l <= 0.5 {
		s = rangec / sumc
	} else {
		s = rangec / (2.0 - maxc - minc)
	}
	rc, gc, bc := (maxc-r)/rangec, (maxc-g)/rangec, (maxc-b)/rangec
	switch maxc {
	case r:
		h = bc - gc
	case g:
		h = 2.0 + rc - bc
	default:
		h = 4.0 + gc - rc
	}
	return pyMod(h/6.0, 1.0), l, s
}

func pyMod(x, y float64) float64 {
	m := math.Mod(x, y)
	if m < 0 {
		m += y
	}
	return m
}

func hlsHue(m1, m2, hue float64) float64 {
	hue = pyMod(hue, 1.0)
	switch {
	case hue < 1.0/6.0:
		return m1 + (m2-m1)*hue*6.0
	case hue < 0.5:
		return m2
	case hue < 2.0/3.0:
		return m1 + (m2-m1)*(2.0/3.0-hue)*6.0
	}
	return m1
}

func hlsToRGB(h, l, s float64) (float64, float64, float64) {
	if s == 0 {
		return l, l, l
	}
	var m2 float64
	if l <= 0.5 {
		m2 = l * (1.0 + s)
	} else {
		m2 = l + s - l*s
	}
	m1 := 2.0*l - m2
	return hlsHue(m1, m2, h+1.0/3.0), hlsHue(m1, m2, h), hlsHue(m1, m2, h-1.0/3.0)
}

func hlsOf(h string) (float64, float64, float64) {
	c := hexToRGB(h)
	return rgbToHLS(c[0]/255, c[1]/255, c[2]/255)
}

func fromHLS(h, l, s float64) string {
	l, s = math.Max(0, math.Min(1, l)), math.Max(0, math.Min(1, s))
	r, g, b := hlsToRGB(h, l, s)
	return rgbToHex(rgb{r * 255, g * 255, b * 255})
}

func rgba(h string, alpha string) string {
	c := hexToRGB(h)
	return fmt.Sprintf("rgba(%d,%d,%d,%s)", int(c[0]), int(c[1]), int(c[2]), alpha)
}

// cssVar is one CSS custom property.
type cssVar struct{ name, value string }

// palette is the seven colours of a preset.
type palette struct{ primary, accent, background, tray, highlight, tile, ink string }

var palettes = map[string]palette{
	"jade":       {primary: "#0e7a67", accent: "#d23a26", background: "#edf0ec", tray: "#162637", highlight: "#f2a81d", tile: "#fdf9ec", ink: "#14202b"},
	"blue":       {primary: "#1f5fbf", accent: "#d94f30", background: "#eef1f6", tray: "#14233b", highlight: "#f5b021", tile: "#fbf8ee", ink: "#14202b"},
	"lilac":      {primary: "#6a3fb5", accent: "#d6336c", background: "#f2eff7", tray: "#231a3a", highlight: "#f2a81d", tile: "#fdf8ee", ink: "#1d1a2b"},
	"terracotta": {primary: "#c2570c", accent: "#a3262a", background: "#f6f0e8", tray: "#2b1f17", highlight: "#e8b100", tile: "#fffaf0", ink: "#2a1d14"},
	"rose":       {primary: "#c2185b", accent: "#7c3aed", background: "#fbeff2", tray: "#3a1a2a", highlight: "#f2a81d", tile: "#fff7f0", ink: "#2b1620"},
	"red_black":  {primary: "#b3261e", accent: "#b3261e", background: "#f4f1ee", tray: "#1f1f23", highlight: "#f2a81d", tile: "#fdf9ec", ink: "#1c1c1f"},
}

// DefaultPreset is the colour preset of a page that names none.
const DefaultPreset = "jade"

var presetNames = []string{DefaultPreset, "blue", "lilac", "terracotta", "rose", "red_black"}

// Presets lists the colour preset names in order, "jade" first.
func Presets() []string { return append([]string(nil), presetNames...) }

// The default palette uses the page's original colour codes exactly, instead of recomputing them.
var originalVars = map[string][]cssVar{
	"ink":        {{"--ink", "#14202b"}, {"--ink-2", "#33434f"}, {"--muted", "#5b6a77"}, {"--line", "#1d2a36"}},
	"background": {{"--bg", "#edf0ec"}, {"--hair", "#d5dbd6"}, {"--bg-0", "rgba(237,240,236,0)"}, {"--soft", "#f1f4f1"}, {"--soft-2", "#e4e9e5"}, {"--soft-3", "#f4f6f3"}, {"--soft-4", "#dde3de"}},
	"tray":       {{"--tray", "#162637"}, {"--tray-2", "#21405c"}},
	"tile":       {{"--tile", "#fdf9ec"}, {"--tile-2", "#f0e6c8"}, {"--tile-edge", "#c5b484"}, {"--tile-ink", "#7d6c3f"}},
	"primary": {{"--jade", "#0e7a67"}, {"--jade-d", "#095647"}, {"--jade-l", "#def2ec"}, {"--jade-b", "#3ddcb2"},
		{"--okc-1", "#eafaf3"}, {"--okc-2", "#c9ecdd"}, {"--okc-edge", "#86c7b1"}, {"--jade-a", "rgba(14,122,103,.28)"}, {"--jade-line", "#a7dccd"}},
	"accent":    {{"--seal", "#d23a26"}, {"--seal-d", "#9d2615"}, {"--seal-l", "#fdece8"}},
	"highlight": {{"--amber", "#f2a81d"}, {"--amber-l", "#fff3d1"}, {"--amber-d", "#7b5200"}},
}

var fixedVars = []cssVar{{"--paper", "#fff"}, {"--grid", "#a8b3bb"}, {"--bad", "#d23a26"}, {"--bad-d", "#9d2615"}, {"--bad-l", "#fdece8"}}

func inkVars(c string) []cssVar {
	ink := c
	if contrast(ink, "#ffffff") < 10 {
		h, l, s := hlsOf(ink)
		ink = fromHLS(h, math.Min(l, 0.12), math.Min(s, 0.5))
	}
	return []cssVar{{"--ink", ink}, {"--ink-2", mix(ink, "#ffffff", 0.15)}, {"--muted", mix(ink, "#ffffff", 0.38)}, {"--line", mix(ink, "#ffffff", 0.04)}}
}

func backgroundVars(c string) []cssVar {
	bg := c
	if luminance(bg) < 0.55 {
		bg = mix(bg, "#ffffff", 0.8)
	}
	return []cssVar{{"--bg", bg}, {"--hair", mix(bg, "#000000", 0.10)}, {"--bg-0", rgba(bg, "0")}, {"--soft", mix(bg, "#ffffff", 0.45)},
		{"--soft-2", mix(bg, "#000000", 0.04)}, {"--soft-3", mix(bg, "#ffffff", 0.6)}, {"--soft-4", mix(bg, "#000000", 0.07)}}
}

func trayVars(c string) []cssVar {
	t := c
	if luminance(t) > 0.12 {
		h, _, s := hlsOf(t)
		t = fromHLS(h, 0.16, math.Min(s, 0.55))
	}
	h, l, s := hlsOf(t)
	return []cssVar{{"--tray", t}, {"--tray-2", fromHLS(h, l+0.10, math.Min(1, s+0.05))}}
}

func tileVars(c string) []cssVar {
	t := c
	if luminance(t) < 0.6 {
		t = mix(t, "#ffffff", 0.7)
	}
	h, l, s := hlsOf(t)
	return []cssVar{{"--tile", t}, {"--tile-2", fromHLS(h, l-0.07, math.Min(1, s+0.05))},
		{"--tile-edge", fromHLS(h, l-0.26, math.Min(1, s*0.9+0.05))}, {"--tile-ink", fromHLS(h, 0.33, math.Min(1, s*0.6+0.1))}}
}

func primaryVars(c string) []cssVar {
	p := c
	for n := 0; contrast(p, "#ffffff") < 4.6 && n < 30; n++ {
		p = mix(p, "#000000", 0.06)
	}
	h, _, s := hlsOf(p)
	d := mix(p, "#000000", 0.30)
	for m := 0; contrast(d, "#ffffff") < 7 && m < 20; m++ {
		d = mix(d, "#000000", 0.08)
	}
	return []cssVar{{"--jade", p}, {"--jade-d", d}, {"--jade-l", mix(p, "#ffffff", 0.87)},
		{"--jade-b", fromHLS(h, 0.58, math.Max(0.55, math.Min(0.85, s)))},
		{"--okc-1", mix(p, "#ffffff", 0.93)}, {"--okc-2", mix(p, "#ffffff", 0.80)}, {"--okc-edge", mix(p, "#ffffff", 0.52)},
		{"--jade-a", rgba(p, "0.28")}, {"--jade-line", mix(p, "#ffffff", 0.68)}}
}

func accentVars(c string) []cssVar {
	a := c
	for n := 0; contrast(a, "#ffffff") < 3.6 && n < 30; n++ {
		a = mix(a, "#000000", 0.06)
	}
	return []cssVar{{"--seal", a}, {"--seal-d", mix(a, "#000000", 0.25)}, {"--seal-l", mix(a, "#ffffff", 0.9)}}
}

func highlightVars(c string) []cssVar {
	return []cssVar{{"--amber", c}, {"--amber-l", mix(c, "#ffffff", 0.83)}, {"--amber-d", mix(c, "#000000", 0.55)}}
}

// themeCSS resolves a preset to the text of a `:root{...}` override. An unknown preset is an error.
func themeCSS(preset string) (string, error) {
	if preset == "" {
		preset = DefaultPreset
	}
	cur, ok := palettes[preset]
	if !ok {
		return "", fmt.Errorf("Unknown colour preset %q. Choose one of: %s.", preset, strings.Join(presetNames, ", "))
	}
	def := palettes[DefaultPreset]
	vars := append([]cssVar(nil), fixedVars...)
	for _, step := range []struct {
		key        string
		value, def string
		compute    func(string) []cssVar
	}{
		{"ink", cur.ink, def.ink, inkVars},
		{"background", cur.background, def.background, backgroundVars},
		{"tray", cur.tray, def.tray, trayVars},
		{"tile", cur.tile, def.tile, tileVars},
		{"primary", cur.primary, def.primary, primaryVars},
		{"accent", cur.accent, def.accent, accentVars},
		{"highlight", cur.highlight, def.highlight, highlightVars},
	} {
		if step.value == step.def {
			vars = append(vars, originalVars[step.key]...)
		} else {
			vars = append(vars, step.compute(step.value)...)
		}
	}
	var b strings.Builder
	b.WriteString(":root{")
	for _, v := range vars {
		b.WriteString(v.name + ":" + v.value + ";")
	}
	b.WriteString("}")
	return b.String(), nil
}
