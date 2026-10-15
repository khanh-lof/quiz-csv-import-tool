package api

import "slices"

// avatarIDs is the fixed set of avatars a student can pick: animals the client draws as emoji on a
// coloured disc. `AVATARS` in Client/src/models/avatar.ts lists the same ids in the same order, and the
// two are kept in step by hand. Only the id is stored and sent, so the picture stays the client's to change.
var avatarIDs = []string{
	"rat", "ox", "tiger", "rabbit", "cat", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog",
	"pig", "panda", "fox", "frog", "koala", "lion", "bear", "penguin", "owl", "unicorn", "octopus", "turtle",
}

// validAvatar reports whether id is one of avatarIDs, exactly as written. The empty string is not an
// avatar: the handlers that allow "no avatar" check for it themselves.
func validAvatar(id string) bool {
	return slices.Contains(avatarIDs, id)
}
