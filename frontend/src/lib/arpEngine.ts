/**
 * Chord-progression arpeggiator engine.
 *
 * A faithful TypeScript port of Jake Albaugh's "Musical Chord Progression
 * Arpeggiator" (the MusicalScale scale generator + ArpeggioPatterns permutation
 * generator), rehosted on this app's Web Audio stack instead of Tone.js. The
 * original Tone.Transport.scheduleRepeat loop is replaced by a lookahead clock
 * on the shared engine AudioContext, and notes are voiced through the same
 * `triggerActiveVoice` synth the piano roll uses — so the arpeggiator shares the
 * app's instrument, master gain and effect rack, and its progression can be
 * dumped straight into the piano roll's note model.
 *
 * No Tone.js, no CDN: pure data + the standard AudioContext surface.
 */
import { getEngineCtx, getMasterGain } from '../state/playerStore';
import { triggerActiveVoice } from './midiSynth';
import { isSoundfontActive, getActiveProgram } from './soundfontEngine';
import { previewNoteSF } from './soundfontEngine';

/* ── music theory ─────────────────────────────────────────────────────────── */

export interface TriadNote {
  note: string;
  rel_octave: number;
}
export interface Triad {
  type: string;
  interval: string;
  notes: TriadNote[];
}
export interface ScaleNote {
  step: number;
  note: string;
  rel_octave: number;
  triad: Triad;
}

interface ScaleDef {
  name: string;
  steps: number[];
  dominance: number[];
  triads: string[];
}
interface ScaleDict {
  keys: string[];
  scales: Record<string, ScaleDef>;
  modes: string[];
  flat_sharp: Record<string, string>;
  triads: Record<string, number[]>;
}

/**
 * Generate a scale and its diatonic triads for a key + mode.
 * Port of https://codepen.io/jakealbaugh/pen/NrdEYL/
 */
export class MusicalScale {
  dict: ScaleDict;
  key = 'C';
  mode = 'ionian';
  notes: ScaleNote[] = [];
  _scale!: ScaleDef;

  constructor(params: { key: string; mode: string }) {
    this.dict = MusicalScale._loadDictionary();
    this._loadScale(params);
  }

  updateScale(params: { key: string; mode: string }): void {
    this._loadScale(params);
  }

  private _loadScale(params: { key: string; mode: string }): void {
    this.key = this._paramKey(params.key);
    this.mode = params.mode;
    this.notes = [];
    this._scale = this.dict.scales[this._paramMode(this.mode)];

    const keys = this.dict.keys;
    const offset = keys.indexOf(this.key);
    for (let s = 0; s < this._scale.steps.length; s++) {
      const step = this._scale.steps[s];
      const idx = (offset + step) % keys.length;
      const rel_octave = offset + step > keys.length - 1 ? 1 : 0;
      const triad = this._genTriad(s, idx, rel_octave, this._scale.triads[s]);
      this.notes.push({ step: s, note: keys[idx], rel_octave, triad });
    }
  }

  private _genTriad(s: number, offset: number, octave: number, t: string): Triad {
    const steps = this.dict.triads[t];
    const chord: Triad = { type: t, interval: this._intervalFromType(s, t), notes: [] };
    const keys = this.dict.keys;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const idx = (offset + step) % keys.length;
      const rel_octave = offset + step > keys.length - 1 ? octave + 1 : octave;
      chord.notes.push({ note: keys[idx], rel_octave });
    }
    return chord;
  }

  private _intervalFromType(step: number, type: string): string {
    const steps = 'i ii iii iv v vi vii'.split(' ');
    let s = steps[step];
    switch (type) {
      case 'maj':
        s = s.toUpperCase();
        break;
      case 'aug':
        s = s.toUpperCase() + '+';
        break;
      case 'dim':
        s = s + '°';
        break;
    }
    return s;
  }

  private _paramMode(mode: string): string {
    return (
      {
        minor: 'aeo',
        major: 'ion',
        ionian: 'ion',
        dorian: 'dor',
        phrygian: 'phr',
        lydian: 'lyd',
        mixolydian: 'mix',
        aeolian: 'aeo',
        locrian: 'loc',
        melodic: 'mel',
        harmonic: 'har',
      } as Record<string, string>
    )[mode];
  }

  private _paramKey(key: string): string {
    if (this.dict.flat_sharp[key]) return this.dict.flat_sharp[key];
    return key;
  }

  private static _genTriads(offset: number): string[] {
    const base = 'maj min min maj maj min dim'.split(' ');
    const triads: string[] = [];
    for (let i = 0; i < base.length; i++) triads.push(base[(i + offset) % base.length]);
    return triads;
  }

  private static _genSteps(steps_str: string): number[] {
    const arr = steps_str.split(' ');
    const steps = [0];
    let step = 0;
    for (let i = 0; i < arr.length - 1; i++) {
      let inc = 0;
      switch (arr[i]) {
        case 'W':
          inc = 2;
          break;
        case 'H':
          inc = 1;
          break;
        case 'WH':
          inc = 3;
          break;
      }
      step += inc;
      steps.push(step);
    }
    return steps;
  }

  private static _loadDictionary(): ScaleDict {
    return {
      keys: 'C C# D D# E F F# G G# A A# B'.split(' '),
      scales: {
        ion: { name: 'Ionian', steps: MusicalScale._genSteps('W W H W W W H'), dominance: [3, 0, 1, 0, 2, 0, 1], triads: MusicalScale._genTriads(0) },
        dor: { name: 'Dorian', steps: MusicalScale._genSteps('W H W W W H W'), dominance: [3, 0, 1, 0, 2, 2, 1], triads: MusicalScale._genTriads(1) },
        phr: { name: 'Phrygian', steps: MusicalScale._genSteps('H W W W H W W'), dominance: [3, 2, 1, 0, 2, 0, 1], triads: MusicalScale._genTriads(2) },
        lyd: { name: 'Lydian', steps: MusicalScale._genSteps('W W W H W W H'), dominance: [3, 0, 1, 2, 2, 0, 1], triads: MusicalScale._genTriads(3) },
        mix: { name: 'Mixolydian', steps: MusicalScale._genSteps('W W H W W H W'), dominance: [3, 0, 1, 0, 2, 0, 2], triads: MusicalScale._genTriads(4) },
        aeo: { name: 'Aeolian', steps: MusicalScale._genSteps('W H W W H W W'), dominance: [3, 0, 1, 0, 2, 0, 1], triads: MusicalScale._genTriads(5) },
        loc: { name: 'Locrian', steps: MusicalScale._genSteps('H W W H W W W'), dominance: [3, 0, 1, 0, 3, 0, 0], triads: MusicalScale._genTriads(6) },
        mel: { name: 'Melodic Minor', steps: MusicalScale._genSteps('W H W W W W H'), dominance: [3, 0, 1, 0, 3, 0, 0], triads: 'min min aug maj maj dim dim'.split(' ') },
        har: { name: 'Harmonic Minor', steps: MusicalScale._genSteps('W H W W H WH H'), dominance: [3, 0, 1, 0, 3, 0, 0], triads: 'min dim aug min maj maj dim'.split(' ') },
      },
      modes: ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian', 'major', 'minor', 'melodic', 'harmonic'],
      flat_sharp: { Cb: 'B', Db: 'C#', Eb: 'D#', Fb: 'E', Gb: 'F#', Ab: 'G#', Bb: 'A#' },
      triads: { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8] },
    };
  }
}

/**
 * All arpeggio index patterns for a given number of steps.
 * Port of https://codepen.io/jakealbaugh/pen/PzpzEO/
 */
export class ArpeggioPatterns {
  steps: number;
  patterns: { straight: number[][]; looped: number[][] } = { straight: [], looped: [] };
  private arr: number[] = [];
  private _used: number[] = [];
  private permutations: number[][] = [];

  constructor(params: { steps: number }) {
    this.steps = params.steps;
    this._loadPatterns();
  }

  updatePatterns(params: { steps: number }): void {
    this.steps = params.steps;
    this._loadPatterns();
  }

  private _loadPatterns(): void {
    this.arr = [];
    for (let i = 0; i < this.steps; i++) this.arr.push(i);
    this._used = [];
    this.permutations = this._permute(this.arr);
    this.patterns = { straight: this.permutations, looped: this._loop() };
  }

  private _permute(input: number[], permutations: number[][] = []): number[][] {
    for (let i = 0; i < input.length; i++) {
      const ch = input.splice(i, 1)[0];
      this._used.push(ch);
      if (input.length === 0) permutations.push(this._used.slice());
      this._permute(input, permutations);
      input.splice(i, 0, ch);
      this._used.pop();
    }
    return permutations;
  }

  private _loop(): number[][] {
    const looped: number[][] = [];
    for (let p = 0; p < this.permutations.length; p++) {
      const perm = this.permutations[p];
      const arr = Array.from(perm);
      for (let x = 1; x < perm.length - 1; x++) arr.push(perm[perm.length - 1 - x]);
      looped.push(arr);
    }
    return looped;
  }
}

/* ── note naming ──────────────────────────────────────────────────────────── */

const KEYS = 'C C# D D# E F F# G G# A A# B'.split(' ');

/** "C#4" / chord note + absolute octave -> MIDI number (C4 = 60). */
export const noteNameToMidi = (note: string, octave: number): number => {
  const pc = KEYS.indexOf(note);
  if (pc < 0) return 60;
  return (octave + 1) * 12 + pc;
};

/* ── live engine ──────────────────────────────────────────────────────────── */

export type PatternType = 'straight' | 'looped';

export interface ArpConfig {
  chords: number[]; // scale-degree index per progression slot
  key: string;
  mode: string;
  steps: number; // arpeggio note count (3-6)
  patternType: PatternType;
  patternId: number;
  bpm: number;
  octaveBase: number;
  arpRepeat: number;
  bassOn: boolean; // whether to voice the bass synth
  /** Timing feel (mirrors the piano roll): 1 = dead-on grid, <1 humanizes the
   *  note timing; swing delays the off-16ths (+) or pushes them early (-). */
  quantize: number; // 0..1
  swing: number; // -0.5..0.5
}

export const DEFAULT_ARP_CONFIG: ArpConfig = {
  chords: [0, 2, 6, 3, 4, 2, 5, 1],
  key: 'G',
  mode: 'locrian',
  steps: 6,
  patternType: 'straight',
  patternId: 0,
  bpm: 135,
  octaveBase: 4,
  arpRepeat: 2,
  bassOn: true,
  quantize: 1,
  swing: 0,
};

/** A scheduled highlight event the UI can react to (keyboard + chord lamps). */
export interface ArpTick {
  when: number; // AudioContext time the note sounds
  chordIndex: number; // active progression slot
  trebleMidi: number;
  bassMidi: number | null; // non-null only on the tick the bass (re)triggers
}

/** Convert one progression pass to absolute-seconds piano-roll-style notes. */
export interface ArpRenderNote {
  midi: number;
  step: number; // 16th-note step
  length: number; // in 16th-note steps
  velocity: number;
}

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12; // seconds

export class ArpPlayerEngine {
  cfg: ArpConfig;
  MS: MusicalScale;
  AP: ArpeggioPatterns;
  arpeggio: number[] = [];

  private playing = false;
  private timer: number | null = null;
  private nextNoteTime = 0;
  private step = 0;
  private chordStep = 0;
  private bassActive = false;

  onTick: ((t: ArpTick) => void) | null = null;
  onStop: (() => void) | null = null;

  constructor(cfg: Partial<ArpConfig> = {}) {
    this.cfg = { ...DEFAULT_ARP_CONFIG, ...cfg };
    this.MS = new MusicalScale({ key: this.cfg.key, mode: this.cfg.mode });
    this.AP = new ArpeggioPatterns({ steps: this.cfg.steps });
    this._refreshArpeggio();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  private _refreshArpeggio(): void {
    const list = this.AP.patterns[this.cfg.patternType];
    if (this.cfg.patternId > list.length - 1) this.cfg.patternId = 0;
    this.arpeggio = list[this.cfg.patternId] ?? [];
  }

  /** Patch config; rebuilds scale/patterns as needed. Safe while playing. */
  setConfig(patch: Partial<ArpConfig>): void {
    const prev = this.cfg;
    this.cfg = { ...prev, ...patch };
    if (patch.key !== undefined || patch.mode !== undefined) {
      this.MS.updateScale({ key: this.cfg.key, mode: this.cfg.mode });
    }
    if (patch.steps !== undefined) {
      this.AP.updatePatterns({ steps: this.cfg.steps });
    }
    this._refreshArpeggio();
  }

  /** The "Output" view: the chosen chords as {note, type, interval}. */
  outputChords(): { note: string; type: string; interval: string }[] {
    return this.cfg.chords.map((c) => {
      const n = this.MS.notes[c] ?? this.MS.notes[0];
      return { note: n.note, type: n.triad.type, interval: n.triad.interval };
    });
  }

  private stepDur(): number {
    return 60 / this.cfg.bpm / 4;
  }

  start(): void {
    if (this.playing) return;
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    this.playing = true;
    this.step = 0;
    this.chordStep = 0;
    this.bassActive = false;
    this.nextNoteTime = ctx.currentTime + 0.06;
    this._tick();
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.onStop?.();
  }

  private _voice(midi: number, when: number, duration: number, velocity: number): void {
    const ctx = getEngineCtx();
    if (isSoundfontActive()) {
      const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
      window.setTimeout(() => void previewNoteSF(midi, velocity, duration), delayMs);
      return;
    }
    void getActiveProgram();
    triggerActiveVoice(ctx, getMasterGain(), midi, velocity, when, duration, 0.85);
  }

  /** Schedule one 16th step, mirroring the original scheduleRepeat body. */
  private _scheduleStep(when: number): void {
    const chordCount = this.cfg.chords.length;
    const arpLen = Math.max(1, this.arpeggio.length);
    const currChord = this.chordStep % chordCount;
    const chord = this.MS.notes[this.cfg.chords[currChord]] ?? this.MS.notes[0];

    // Build the arpeggiable note pool: the triad, stacked up by octaves.
    let pool: TriadNote[] = chord.triad.notes;
    const octaveLifts = Math.ceil(this.cfg.steps / 3);
    for (let i = 0; i < octaveLifts; i++) {
      pool = pool.concat(pool.map((n) => ({ note: n.note, rel_octave: n.rel_octave + (i + 1) })));
    }
    const arpNote = pool[this.arpeggio[this.step % arpLen]] ?? pool[0];

    let bassMidi: number | null = null;
    if (this.cfg.bassOn && !this.bassActive) {
      this.bassActive = true;
      const bassOctave = chord.rel_octave + 2;
      const bassMidiVal = noteNameToMidi(chord.note, bassOctave);
      const bassDur = arpLen * this.cfg.arpRepeat * this.stepDur();
      this._voice(bassMidiVal, when, bassDur * 0.96, 96);
      bassMidi = bassMidiVal;
    }

    this.step++;
    if (this.step % (arpLen * this.cfg.arpRepeat) === 0) {
      this.chordStep++;
      this.bassActive = false;
    }

    const trebleMidi = noteNameToMidi(arpNote.note, arpNote.rel_octave + this.cfg.octaveBase);
    this._voice(trebleMidi, when, this.stepDur() * 0.9, 104);

    this.onTick?.({ when, chordIndex: currChord, trebleMidi, bassMidi });
  }

  private _tick = (): void => {
    if (this.timer === null) {
      this.timer = window.setInterval(this._tick, LOOKAHEAD_MS);
    }
    if (!this.playing) return;
    const ctx = getEngineCtx();
    while (this.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
      const dur = this.stepDur();
      // Swing delays the off-16ths; lower quantize adds a touch of humanized
      // jitter. `this.step` is the upcoming step (incremented inside _scheduleStep).
      const swingOff = this.step % 2 === 1 ? this.cfg.swing * dur : 0;
      const humanize = (1 - this.cfg.quantize) * (Math.random() - 0.5) * dur * 0.5;
      this._scheduleStep(this.nextNoteTime + swingOff + humanize);
      this.nextNoteTime += dur;
    }
  };

  /**
   * Render the full progression (all chords, one arp_repeat pass each) to
   * step-grid notes for the piano roll. Treble arp notes only; the grid is
   * 16th-note steps so it lines up with the roll's bpm.
   */
  renderProgression(): ArpRenderNote[] {
    const out: ArpRenderNote[] = [];
    const chordCount = this.cfg.chords.length;
    const arpLen = Math.max(1, this.arpeggio.length);
    const stepsPerChord = arpLen * this.cfg.arpRepeat;
    let gridStep = 0;
    for (let c = 0; c < chordCount; c++) {
      const chord = this.MS.notes[this.cfg.chords[c]] ?? this.MS.notes[0];
      let pool: TriadNote[] = chord.triad.notes;
      const octaveLifts = Math.ceil(this.cfg.steps / 3);
      for (let i = 0; i < octaveLifts; i++) {
        pool = pool.concat(pool.map((n) => ({ note: n.note, rel_octave: n.rel_octave + (i + 1) })));
      }
      // bass for the whole chord span
      if (this.cfg.bassOn) {
        out.push({
          midi: noteNameToMidi(chord.note, chord.rel_octave + 2),
          step: gridStep,
          length: stepsPerChord,
          velocity: 88,
        });
      }
      for (let s = 0; s < stepsPerChord; s++) {
        const arpNote = pool[this.arpeggio[s % arpLen]] ?? pool[0];
        out.push({
          midi: noteNameToMidi(arpNote.note, arpNote.rel_octave + this.cfg.octaveBase),
          step: gridStep + s,
          length: 1,
          velocity: 104,
        });
      }
      gridStep += stepsPerChord;
    }
    return out;
  }

  dispose(): void {
    this.stop();
    this.onTick = null;
    this.onStop = null;
  }
}
