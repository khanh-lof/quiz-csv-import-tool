import { Injectable, signal } from '@angular/core';

export type GameSound =
  | 'correct'
  | 'wrong'
  | 'select'
  | 'charge'
  | 'start'
  | 'finish'
  | 'slice'
  | 'tick'
  | 'timeout';

// The master level. A compressor sits after it so the layered chords of 'correct' and 'finish' do
// not clip.
const MASTER_VOLUME = 0.7;

// All sounds are synthesized with the Web Audio API: no files to ship, nothing to download. Every
// entry point swallows errors, because a missing or blocked audio device must never interrupt a
// game.
@Injectable({ providedIn: 'root' })
export class GameAudio {
  readonly muted = signal(false);

  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private unsupported = false;

  setMuted(value: boolean): void {
    this.muted.set(value);
    try {
      if (this.context && this.master) {
        const { currentTime } = this.context;
        this.master.gain.cancelScheduledValues(currentTime);
        this.master.gain.setTargetAtTime(value ? 0 : MASTER_VOLUME, currentTime, 0.015);
      }
      if (!value) {
        this.resume();
      }
    } catch {
      // No audio device.
    }
  }

  // Browsers keep an AudioContext suspended until the page has seen a user gesture, so the page
  // calls this from a click handler (turning on the camera, starting the quiz).
  resume(): void {
    try {
      const context = this.ensureContext();
      if (context && context.state === 'suspended') {
        context.resume().catch(() => undefined);
      }
    } catch {
      // No audio device.
    }
  }

  // `streak` only matters for 'correct': from the third right answer in a row it adds a flourish.
  play(kind: GameSound, streak = 0): void {
    if (this.muted()) {
      return;
    }
    try {
      const context = this.ensureContext();
      if (!context) {
        return;
      }
      if (context.state === 'suspended') {
        context.resume().catch(() => undefined);
      }
      const t = context.currentTime + 0.015;
      switch (kind) {
        case 'charge':
          this.note(560, t, 0.055, 'sine', 0.035, 780);
          break;
        case 'select':
          this.note(260, t, 0.1, 'triangle', 0.08, 920);
          break;
        case 'wrong':
          this.drum(t, 0.12);
          this.note(220, t, 0.22, 'sawtooth', 0.055, 130);
          this.note(233, t, 0.22, 'sawtooth', 0.04, 138);
          this.note(164.81, t + 0.23, 0.22, 'triangle', 0.1);
          this.note(130.81, t + 0.44, 0.23, 'triangle', 0.09);
          break;
        case 'start':
          [261.63, 329.63, 392, 523.25].forEach((f, i) =>
            this.note(f, t + i * 0.085, 0.2, 'triangle', 0.11),
          );
          this.drum(t);
          this.shimmer(t + 0.26);
          break;
        case 'finish':
          [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5].forEach((f, i) =>
            this.note(f, t + i * 0.13, 0.27, 'triangle', 0.12),
          );
          [261.63, 329.63, 392].forEach(f => this.note(f, t + 0.8, 0.7, 'sine', 0.07));
          this.drum(t);
          this.drum(t + 0.39);
          this.shimmer(t + 0.8);
          break;
        case 'correct':
          this.drum(t, 0.13);
          [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
            this.note(f, t + i * 0.095, 0.21, 'triangle', 0.12);
            this.note(f * 2, t + i * 0.095, 0.14, 'sine', 0.025);
          });
          [523.25, 659.25, 783.99].forEach(f => this.note(f, t + 0.4, 0.45, 'sine', 0.06));
          this.shimmer(t + 0.35);
          if (streak >= 3) {
            this.note(1318.5, t + 0.64, 0.16, 'sine', 0.08);
            this.note(1568, t + 0.77, 0.25, 'sine', 0.065);
          }
          break;
        case 'slice':
          this.noiseSweep(t, 0.14, 0.12, 3600, 900);
          break;
        case 'tick':
          this.note(1000, t, 0.05, 'sine', 0.06);
          break;
        case 'timeout':
          this.note(440, t, 0.18, 'triangle', 0.12);
          this.note(330, t + 0.17, 0.3, 'triangle', 0.12);
          break;
      }
    } catch {
      // An unavailable audio device never interrupts play.
    }
  }

  // Created on first use: the page may never play a sound, and creating it earlier than a user
  // gesture only gets it suspended.
  private ensureContext(): AudioContext | null {
    if (this.context) {
      return this.context;
    }
    if (this.unsupported) {
      return null;
    }
    const Ctor: typeof AudioContext | undefined =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.unsupported = true;
      return null;
    }
    const context = new Ctor();
    const master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 14;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.16;
    master.gain.value = this.muted() ? 0 : MASTER_VOLUME;
    master.connect(compressor);
    compressor.connect(context.destination);
    this.context = context;
    this.master = master;
    return context;
  }

  // One oscillator note with a fast attack and an exponential decay, optionally gliding to
  // `endFreq`.
  private note(
    freq: number,
    start: number,
    duration = 0.16,
    type: OscillatorType = 'sine',
    gain = 0.13,
    endFreq: number | null = null,
  ): void {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, start);
    if (endFreq) {
      oscillator.frequency.exponentialRampToValueAtTime(endFreq, start + duration);
    }
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master!);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }

  // A low thump: a sine dropping from 130 Hz to 38 Hz.
  private drum(start: number, gain = 0.12): void {
    this.note(130, start, 0.16, 'sine', gain, 38);
  }

  // A short high-passed noise burst that fades out linearly: the sparkle on chords.
  private shimmer(start: number): void {
    const context = this.context!;
    const duration = 0.13;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    source.buffer = this.noise();
    filter.type = 'highpass';
    filter.frequency.value = 5500;
    envelope.gain.setValueAtTime(0.07, start);
    envelope.gain.linearRampToValueAtTime(0, start + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master!);
    source.start(start, 0, duration);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
  }

  // White noise through a band-pass filter whose centre glides down: the whoosh of a blade.
  private noiseSweep(
    start: number,
    duration: number,
    gain: number,
    from: number,
    to: number,
  ): void {
    const context = this.context!;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    source.buffer = this.noise();
    filter.type = 'bandpass';
    filter.Q.value = 1.1;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to, start + duration);
    envelope.gain.setValueAtTime(gain, start);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master!);
    source.start(start);
    source.stop(start + duration + 0.02);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
  }

  // 0.3 s of white noise, built once and shared by the shimmer and the slice.
  private noise(): AudioBuffer {
    if (!this.noiseBuffer) {
      const context = this.context!;
      const length = Math.floor(context.sampleRate * 0.3);
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
    }
    return this.noiseBuffer;
  }
}
