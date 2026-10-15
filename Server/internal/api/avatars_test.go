package api

import (
	"slices"
	"testing"
)

// The client lists the same ids in the same order (AVATARS in Client/src/models/avatar.ts, pinned by its
// own spec), so changing, adding or reordering one here means changing both.
func TestAvatarIDsAreThePinnedSet(t *testing.T) {
	want := []string{
		"rat", "ox", "tiger", "rabbit", "cat", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog",
		"pig", "panda", "fox", "frog", "koala", "lion", "bear", "penguin", "owl", "unicorn", "octopus", "turtle",
	}
	if !slices.Equal(avatarIDs, want) {
		t.Fatalf("avatar ids %q, want %q", avatarIDs, want)
	}
	if len(avatarIDs) != 24 {
		t.Fatalf("%d avatars, want 24", len(avatarIDs))
	}
}

func TestValidAvatar(t *testing.T) {
	for _, id := range avatarIDs {
		if !validAvatar(id) {
			t.Errorf("%q should be valid", id)
		}
	}
	// An id is matched exactly: not trimmed, not case-folded, and "no avatar" is not an avatar.
	for _, id := range []string{"", " ", "cow", "Panda", "PANDA", " panda", "panda ", "pand", "pandas", "🐼", "panda\n", "fox,frog"} {
		if validAvatar(id) {
			t.Errorf("%q should not be valid", id)
		}
	}
}
