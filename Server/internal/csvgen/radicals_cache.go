package csvgen

import (
	"context"
	"strings"
	"time"

	"quiz-csv-import-tool/server/internal/radicals"
	"quiz-csv-import-tool/server/internal/store"
)

// The notes the second Radicals call asks for (word and character meanings, component names) are the same from one
// exercise to the next, so the model's answers are kept in a shared store (Client.RadicalDetails) and an exercise
// asks the model only for the notes neither the curated pools nor that store hold. The store is a help, never a
// requirement: when it fails, the exercise asks the model as before.

// wordDetailKey is a word's key in the store: its characters and its pinyin, since a polyphonic word means
// something else read another way.
func wordDetailKey(need radicals.WordNeed) string {
	return need.Hanzi + "|" + strings.TrimSpace(need.Pinyin)
}

// cachedDetails is what the store holds of needs, as an answer to the details request, and the needs it leaves.
// With no store, or a store that fails, it holds nothing and leaves every need.
func (c *Client) cachedDetails(ctx context.Context, needs radicals.Needs) (detailsAnswer, radicals.Needs) {
	hits := detailsAnswer{Words: map[string]string{}, Chars: map[string]string{}, Components: map[string]radicals.ComponentInfo{}}
	if c.RadicalDetails == nil {
		return hits, needs
	}
	var ids []string
	for _, n := range needs.Words {
		ids = append(ids, store.RadicalDetailID(store.RadicalWord, wordDetailKey(n)))
	}
	for _, n := range needs.Chars {
		ids = append(ids, store.RadicalDetailID(store.RadicalChar, n.Char))
	}
	for _, n := range needs.Components {
		ids = append(ids, store.RadicalDetailID(store.RadicalComponent, n.Component))
	}
	found, err := c.RadicalDetails.Lookup(ctx, ids)
	if err != nil {
		c.logger.Warn("reading the stored Radicals notes failed; asking the model", "error", err)
		return hits, needs
	}
	left := radicals.Needs{Words: []radicals.WordNeed{}, Chars: []radicals.CharNeed{}, Components: []radicals.ComponentNeed{}}
	for _, n := range needs.Words {
		if d, ok := found[store.RadicalDetailID(store.RadicalWord, wordDetailKey(n))]; ok {
			hits.Words[n.Hanzi] = d.Meaning
		} else {
			left.Words = append(left.Words, n)
		}
	}
	for _, n := range needs.Chars {
		if d, ok := found[store.RadicalDetailID(store.RadicalChar, n.Char)]; ok {
			hits.Chars[n.Char] = d.Meaning
		} else {
			left.Chars = append(left.Chars, n)
		}
	}
	for _, n := range needs.Components {
		if d, ok := found[store.RadicalDetailID(store.RadicalComponent, n.Component)]; ok {
			hits.Components[n.Component] = radicals.ComponentInfo{Name: d.Name, Pinyin: d.Pinyin, Meaning: d.Meaning}
		} else {
			left.Components = append(left.Components, n)
		}
	}
	return hits, left
}

// saveDetails keeps the notes of the model's answer that answer one of needs, for the next exercises. A failure
// is only logged: the exercise has its notes already.
func (c *Client) saveDetails(ctx context.Context, answer detailsAnswer, needs radicals.Needs, model string) {
	if c.RadicalDetails == nil {
		return
	}
	now := time.Now()
	detail := func(kind, key string) store.RadicalDetail {
		return store.RadicalDetail{ID: store.RadicalDetailID(kind, key), Kind: kind, Key: key, Model: model,
			Status: store.RadicalActive, CreatedAt: now}
	}
	var details []store.RadicalDetail
	for _, n := range needs.Words {
		if meaning := strings.TrimSpace(answer.Words[n.Hanzi]); meaning != "" {
			d := detail(store.RadicalWord, wordDetailKey(n))
			d.Meaning = meaning
			details = append(details, d)
		}
	}
	for _, n := range needs.Chars {
		if meaning := strings.TrimSpace(answer.Chars[n.Char]); meaning != "" {
			d := detail(store.RadicalChar, n.Char)
			d.Meaning = meaning
			details = append(details, d)
		}
	}
	for _, n := range needs.Components {
		if info, ok := answer.Components[n.Component]; ok && strings.TrimSpace(info.Name+info.Meaning) != "" {
			d := detail(store.RadicalComponent, n.Component)
			d.Name, d.Pinyin, d.Meaning = strings.TrimSpace(info.Name), strings.TrimSpace(info.Pinyin), strings.TrimSpace(info.Meaning)
			details = append(details, d)
		}
	}
	if err := c.RadicalDetails.Save(ctx, details); err != nil {
		c.logger.Warn("storing the Radicals notes failed", "error", err)
	}
}

func needCount(n radicals.Needs) int { return len(n.Words) + len(n.Chars) + len(n.Components) }
