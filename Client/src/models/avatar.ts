import type { MessageKey } from '../i18n/messages';

// The avatars a student can pick in "Giao bài": 24 animals, an emoji on a soft coloured disc. The list is a
// fixed set, not an upload, and the server (Server/internal/api/avatars.go, `avatarIDs`) lists the same ids in
// the same order and refuses any other, kept in step by hand. The id is what travels and is stored; the emoji,
// the name and the colour are only how this client draws it.
export interface AvatarDef {
  id: string;
  emoji: string;
  nameKey: MessageKey;
  // The disc's background: a pastel the emoji reads well on, cycling through eight tones down the list.
  color: string;
}

const TONES: readonly string[] = [
  '#ffd9e8', '#d9e8ff', '#fff1c2', '#d8f5dc', '#e6dcff', '#ffe0cc', '#d3f3f0', '#f3dff5',
];

const ANIMALS: readonly (readonly [string, string])[] = [
  ['rat', '🐭'],
  ['ox', '🐮'],
  ['tiger', '🐯'],
  ['rabbit', '🐰'],
  ['cat', '🐱'],
  ['dragon', '🐲'],
  ['snake', '🐍'],
  ['horse', '🐴'],
  ['goat', '🐐'],
  ['monkey', '🐵'],
  ['rooster', '🐔'],
  ['dog', '🐶'],
  ['pig', '🐷'],
  ['panda', '🐼'],
  ['fox', '🦊'],
  ['frog', '🐸'],
  ['koala', '🐨'],
  ['lion', '🦁'],
  ['bear', '🐻'],
  ['penguin', '🐧'],
  ['owl', '🦉'],
  ['unicorn', '🦄'],
  ['octopus', '🐙'],
  ['turtle', '🐢'],
];

export const AVATARS: readonly AvatarDef[] = ANIMALS.map(([id, emoji], i) => ({
  id,
  emoji,
  nameKey: `play.avatar.name.${id}` as MessageKey,
  color: TONES[i % TONES.length],
}));

// The avatar with this id, or undefined for an empty or unknown one (a student who joined before avatars
// existed, or an id a newer server added), which the caller draws as a letter instead.
export function avatarDef(id: string | null | undefined): AvatarDef | undefined {
  return AVATARS.find(avatar => avatar.id === id);
}

// A random avatar's id, other than `except` when it is one of the set (so a "random" button always changes
// the picture). `rand` is a parameter so a spec can make the choice deterministic.
export function randomAvatar(rand: () => number = Math.random, except?: string): string {
  const pool = AVATARS.filter(avatar => avatar.id !== except);
  const index = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
  return pool[index].id;
}
