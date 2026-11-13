package csvgen

import (
	"fmt"
	"strings"
	"testing"
)

func TestPromptsStateTheVisualShare(t *testing.T) {
	want := fmt.Sprintf("%d%%", VisualPercent)
	for language := range languagePrompts {
		prompt := creativeSystemPrompt(Language(language), 0)
		if strings.Count(prompt, want) < 3 {
			t.Errorf("language %d: the creative prompt states %s too few times", language, want)
		}
		if strings.Contains(prompt, "<no value>") {
			t.Errorf("language %d: the creative prompt has an unfilled value", language)
		}
	}
	for _, message := range exportTypeMessages(Options{ExportType: Wayground}) {
		if strings.Contains(message, "Image Link:") && !strings.Contains(message, "at least "+want+" of the rows") {
			t.Errorf("the Wayground message does not state %s: %s", want, message)
		}
	}
}
