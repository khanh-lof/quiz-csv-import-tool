import { inject, Injectable, signal } from '@angular/core';
import { GameAudio } from '../../game/game-audio';

const STORAGE_KEY = 'gesture-quiz-settings';

// How long a question lasts: the stage's own seconds, half as long again, or no timer at all.
export type TimeMode = 'standard' | 'extra' | 'unlimited';

export interface GestureSettings {
  timeMode: TimeMode;
  sound: boolean;
  // Whether the camera was on last time, so the next stage or visit starts it again by itself.
  useCamera: boolean;
}

const DEFAULTS: GestureSettings = { timeMode: 'standard', sound: true, useCamera: false };

const TIME_MODES: TimeMode[] = ['standard', 'extra', 'unlimited'];

// Fills in whatever a stored value lacks or has the wrong type for, so an older or hand-edited value
// still gives a usable set of settings.
export function parseSettings(raw: string | null): GestureSettings {
  try {
    const value = (raw ? JSON.parse(raw) : null) as Partial<Record<keyof GestureSettings, unknown>> | null;
    return {
      timeMode: TIME_MODES.find(mode => mode === value?.timeMode) ?? DEFAULTS.timeMode,
      sound: typeof value?.sound === 'boolean' ? value.sound : DEFAULTS.sound,
      useCamera: typeof value?.useCamera === 'boolean' ? value.useCamera : DEFAULTS.useCamera,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// The player's choices for the gesture page, remembered in localStorage. The sound choice is applied to
// the shared GameAudio here, so the stage map's switch and the game's button stay one setting.
@Injectable({ providedIn: 'root' })
export class GestureSettingsService {
  private readonly audio = inject(GameAudio);

  readonly settings = signal<GestureSettings>(GestureSettingsService.load());

  constructor() {
    // The sound is on until the player turns it off, so only an "off" has to be passed on.
    if (!this.settings().sound) {
      this.audio.setMuted(true);
    }
  }

  update(patch: Partial<GestureSettings>): void {
    const next = { ...this.settings(), ...patch };
    if (next.sound !== this.settings().sound) {
      this.audio.setMuted(!next.sound);
    }
    this.settings.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked or full: the choice then lasts until the page is closed.
    }
  }

  private static load(): GestureSettings {
    try {
      return parseSettings(localStorage.getItem(STORAGE_KEY));
    } catch {
      return { ...DEFAULTS };
    }
  }
}
