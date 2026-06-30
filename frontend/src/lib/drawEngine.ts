/**
 * drawEngine.ts - generative draw-to-music engine, ported from the standalone
 * "art2music" (paper.js + Tone.js) into the app's shared Web Audio graph so the
 * output can be recorded into the library / EDIT.
 *
 * Two orthogonal axes shape what you draw:
 *
 *  - BRUSH = the character of a stroke: its visual growth model, its sonic
 *    articulation, and how it samples grains. Four brushes:
 *      organic   - L-system vines; a swelling drone that branches.
 *      fibonacci - phyllotaxis spiral of dots; notes step by Fibonacci intervals,
 *                  pulsed amplitude, grains taken at golden-ratio buffer offsets.
 *      neural    - a wireframe node/edge graph with travelling pulses; a rigid,
 *                  gated, glitchy voice and tiny stuttered grains.
 *      nebulous  - a soft drifting particle cloud; a smooth pad that twinkles, with
 *                  long overlapping grains.
 *
 *  - MODE = the post effect every voice is routed through. A wide, deliberately
 *    distinct palette (compressor / tremolo / distortion / echo / reverb /
 *    bitcrush / ring-mod / stereo widen / exciter / HRTF orbit / formant / lowpass),
 *    several ported from the MIX rack so they don't all sound alike.
 *
 * Sound sources: a filtered-noise DRONE, held notes on the shared SpessaSynth GM
 * engine (SOUNDFONT), or grains sampled from a library song (GRANULAR). The whole
 * master is soft-clipped and tapped into a MediaStreamDestination; DrawPanel
 * records that with a MediaRecorder. Each drawn note is also logged into a melody
 * buffer so the session can be handed to Magenta to jam over.
 */

import { getEngineCtx, getMasterGain } from '../state/playerStore';
import { pollMagentaJob } from '../state/instrumentStore';
import {
  buildEffectChain, ensureChopModule, getRackEffect, rackEffectDefaults, RACK_EFFECTS,
  type ChainHandle, type RackEffectInstance,
} from './rackEffects';
import type { ChainEntry } from '../state/effectChainStore';
import { ensureSoundfontReady, liveNoteOff, liveNoteOn } from './soundfontEngine';

// ── musical constants (from art2music) ────────────────────────────────────────
const SCALE = ['B3', 'Db4', 'Eb4', 'F4', 'G4', 'A4', 'B4', 'Db5', 'Eb5', 'F5', 'G5', 'A5', 'B5', 'Db6'];
const INTERVALS = [1, 2, 3, 6];
const FIB = [1, 1, 2, 3, 5, 8, 13];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad (137.5 deg)
const GOLDEN_FRAC = 0.6180339887498949;
const SPAWN_RATE: [number, number] = [10, 30];
const MAX_GROWTH_TIME = 10;
/** Cap concurrent drawn paths so render + audio cost stays bounded under heavy
 *  drawing; the oldest path is retired when the cap is exceeded. */
const MAX_PATHS = 18;
/** Release time-constant for the smooth voice fade-out (seconds). */
const VOICE_RELEASE = 0.4;

const SEMI: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6,
  Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};
const noteToMidi = (n: string): number => {
  const m = n.match(/^([A-G][#b]?)(-?\d+)$/);
  if (!m) return 60;
  return (parseInt(m[2], 10) + 1) * 12 + (SEMI[m[1]] ?? 0);
};
const midiToFreq = (m: number): number => 440 * 2 ** ((m - 69) / 12);

// ── tiny vec + rng helpers ────────────────────────────────────────────────────
interface Pt { x: number; y: number }
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const rand = ([min, max]: [number, number]): number => min + Math.random() * (max - min);
const randItem = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const scale01 = (v: number, [lo, hi]: [number, number]): number => lo + (hi - lo) * v;
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const easeOutQuart = (t: number): number => 1 - --t * t * t * t;

// ── waveshaper curves ─────────────────────────────────────────────────────────
const driveCurve = (k: number): Float32Array => {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * 2 - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return c;
};
const bitCurve = (bits: number): Float32Array => {
  const n = 2048;
  const c = new Float32Array(n);
  const levels = Math.pow(2, clampN(bits, 1, 16));
  const half = levels / 2;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * half) / half;
  }
  return c;
};
const softClipCurve = (drive: number): Float32Array => {
  const n = 1024;
  const c = new Float32Array(n);
  const d = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * 2 - 1;
    c[i] = Math.tanh(x * drive) / d;
  }
  return c;
};

// ── L-system types (organic brush) ────────────────────────────────────────────
interface LItem { symbol: string; params?: (p: any, age: number) => any }
interface LChar { symbol: string; birthTime: number; age: number; terminalAge: number; params?: any }
interface Production { terminalAge: [number, number]; successors: { p: number; items: LItem[] }[] }
interface LSystem { axiom: { symbol: string; terminalAge: number; params?: any }[]; productions: Record<string, Production> }

/** Organic synthesis + growth tuning. maxLineLength is deliberately small so the
 *  drone reaches full level quickly (the old 10000 kept it near-silent). */
const ORG = {
  lengthRange: [10, 25] as [number, number],
  angleRange: [20, 25] as [number, number],
  growthFactor: 5,
};

const orgF = (): LItem => ({ symbol: 'F', params: () => ({ l: rand(ORG.lengthRange), lInit: 0 }) });
const orgTurn = (sign: '+' | '-'): LItem => ({ symbol: sign, params: () => ({ a: rand(ORG.angleRange) }) });
const grow: LItem = {
  symbol: 'F',
  params: ({ l, ageAcc }: any, prev: number) => ({ l, lInit: 1, ageAcc: prev + (ageAcc || 0) }),
};

const buildOrganicSystem = (): LSystem => {
  const tA: [number, number] = [MAX_GROWTH_TIME / 3, MAX_GROWTH_TIME / 2];
  const F = orgF;
  const T = orgTurn;
  return {
    axiom: [{ symbol: 'X', terminalAge: 0 }],
    productions: {
      X: {
        terminalAge: tA,
        successors: [
          { p: 0.34, items: [F(), T('-'), { symbol: '[' }, { symbol: '[' }, { symbol: 'X' }, { symbol: ']' }, T('+'), { symbol: 'X' }, { symbol: ']' }, T('+'), F(), { symbol: '[' }, T('+'), F(), { symbol: 'X' }, { symbol: ']' }, T('-'), { symbol: 'X' }] },
          { p: 0.33, items: [F(), T('+'), { symbol: '[' }, { symbol: '[' }, { symbol: 'X' }, { symbol: ']' }, T('+'), { symbol: 'X' }, { symbol: ']' }, T('+'), F(), F(), { symbol: '[' }, T('-'), F(), { symbol: 'X' }, { symbol: ']' }] },
          { p: 0.33, items: [F(), T('-'), { symbol: '[' }, { symbol: '[' }, { symbol: 'X' }, { symbol: ']' }, T('-'), { symbol: 'X' }, { symbol: ']' }, T('-'), F(), { symbol: '[' }, T('+'), F(), { symbol: 'X' }, { symbol: ']' }, T('+'), { symbol: '[' }, F(), { symbol: 'X' }, { symbol: ']' }] },
        ],
      },
      F: { terminalAge: tA, successors: [{ p: 0.5, items: [grow, orgF()] }, { p: 0.5, items: [grow] }] },
    },
  };
};
const ORGANIC_SYSTEM = buildOrganicSystem();

// ── effects (MODE axis) ───────────────────────────────────────────────────────
export type DrawEffect =
  | 'clean' | 'tremolo' | 'distortion' | 'echo' | 'reverb' | 'bitcrush'
  | 'ringmod' | 'widen' | 'exciter' | 'orbit' | 'formant' | 'lowpass';

/** Mode buttons, in order. `hue` tints the button; `effect` is the routed node;
 *  `desc` is the hover tooltip. Order matches the constructor's effect graph. */
export const DRAW_MODE_META: { label: string; hue: number; effect: DrawEffect; desc: string }[] = [
  { label: 'Clean', hue: 200, effect: 'clean', desc: 'No colour: a gentle compressor that keeps the level even' },
  { label: 'Tremolo', hue: 280, effect: 'tremolo', desc: 'Amplitude wobbles up and down at a steady rate' },
  { label: 'Distort', hue: 350, effect: 'distortion', desc: 'Overdriven, gritty waveshaping' },
  { label: 'Echo', hue: 170, effect: 'echo', desc: 'Discrete feedback repeats trailing each stroke' },
  { label: 'Reverb', hue: 240, effect: 'reverb', desc: 'A long smooth tail, like a big room' },
  { label: 'Crush', hue: 30, effect: 'bitcrush', desc: 'Lo-fi bit-depth reduction for digital crunch' },
  { label: 'Ring', hue: 310, effect: 'ringmod', desc: 'Metallic, clangorous ring-modulation sidebands' },
  { label: 'Widen', hue: 90, effect: 'widen', desc: 'True mid/side stereo widening with a mono-safe low end' },
  { label: 'Air', hue: 55, effect: 'exciter', desc: 'Adds high harmonic air and presence' },
  { label: 'Orbit', hue: 210, effect: 'orbit', desc: 'Spins the sound around your head in 3D (HRTF)' },
  { label: 'Vowel', hue: 15, effect: 'formant', desc: 'Vowel-like formant filtering, a talk-box colour' },
  { label: 'Lowpass', hue: 35, effect: 'lowpass', desc: 'Warms everything down by rolling off the highs' },
];

/** The default per-stroke mode slots: 8 slots, the first 8 built-in effects. Each
 *  slot is user-reassignable to any effect value (see DrawEngine.setModeSlots). */
export const DEFAULT_MODE_SLOTS: string[] = DRAW_MODE_META.slice(0, 8).map((m) => m.effect);

/** Every effect a mode slot can be assigned to: the built-in draw effects plus
 *  the live psychoacoustic inserts (prefixed `rack:`). All run in real time per
 *  stroke. (Studio modules and the backend MIX effects are offline, so they are
 *  not live mode options — they live in the FX panel's Studio section instead.) */
export interface DrawEffectOption { value: string; label: string; group: string; hue: number; desc: string }
export const DRAW_EFFECT_OPTIONS: DrawEffectOption[] = [
  ...DRAW_MODE_META.map((m) => ({ value: m.effect, label: m.label, group: 'Draw', hue: m.hue, desc: m.desc })),
  ...RACK_EFFECTS.map((d, i) => ({
    value: `rack:${d.id}`, label: d.label, group: 'Psychoacoustic',
    hue: Math.round((i * 360) / RACK_EFFECTS.length), desc: d.description,
  })),
];
const EFFECT_META_BY_VALUE = new Map(DRAW_EFFECT_OPTIONS.map((o) => [o.value, o]));
/** Label / hue / desc for a mode slot value (built-in or `rack:` insert). */
export const drawEffectMeta = (value: string): DrawEffectOption | undefined => EFFECT_META_BY_VALUE.get(value);

// ── brushes (BRUSH axis) ──────────────────────────────────────────────────────
export type BrushId = 'organic' | 'fibonacci' | 'neural' | 'nebulous';
type BrushVisual = 'lsystem' | 'phyllotaxis' | 'graph' | 'cloud';
type BrushVoice = 'swell' | 'pulse' | 'gate' | 'twinkle';
type NoteStep = 'scale' | 'fib';

/** How a brush carves grains out of the granular source buffer. */
export interface GrainProfile {
  durRange: [number, number];
  density: number;      // grains spawned per audio tick at full energy
  rateSteps: number[];  // playbackRate choices (pitch / time-stretch)
  attack: number;       // fraction of the grain spent fading in
  spread: number;       // stereo spread 0..1
  peak: number;         // per-grain peak gain
  golden?: boolean;     // sample offsets at golden-ratio positions in the buffer
}

export interface BrushDef {
  id: BrushId;
  label: string;
  hue: number;
  desc: string;
  visual: BrushVisual;
  voice: BrushVoice;
  noteStep: NoteStep;
  filterQ: number;
  gainRange: [number, number];
  maxEnergy: number;    // raw measure that maps to full level
  tau: number;          // gain smoothing time-constant
  grain: GrainProfile;
}

export const BRUSHES: BrushDef[] = [
  {
    id: 'organic', label: 'Organic', hue: 135,
    desc: 'Vine-like L-system growth; a swelling drone that branches as it spreads',
    visual: 'lsystem', voice: 'swell', noteStep: 'scale',
    filterQ: 1600, gainRange: [0.5, 4.6], maxEnergy: 2600, tau: 0.03,
    grain: { durRange: [0.12, 0.26], density: 1, rateSteps: [1], attack: 0.3, spread: 0.85, peak: 0.6 },
  },
  {
    id: 'fibonacci', label: 'Fibonacci', hue: 45,
    desc: 'Sunflower phyllotaxis spirals; notes step by Fibonacci intervals with a pulsing amplitude',
    visual: 'phyllotaxis', voice: 'pulse', noteStep: 'fib',
    filterQ: 1200, gainRange: [0.4, 4.0], maxEnergy: 230, tau: 0.05,
    grain: { durRange: [0.07, 0.3], density: 2, rateSteps: [1, 1.5, 1.6667, 2], attack: 0.25, spread: 0.9, peak: 0.45, golden: true },
  },
  {
    id: 'neural', label: 'Neural', hue: 190,
    desc: 'A wireframe node-and-edge net with travelling pulses; rigid, gated, glitchy sound',
    visual: 'graph', voice: 'gate', noteStep: 'scale',
    filterQ: 900, gainRange: [0.35, 3.6], maxEnergy: 52, tau: 0.02,
    grain: { durRange: [0.03, 0.08], density: 4, rateSteps: [0.5, 1, 2, 4], attack: 0.04, spread: 0.6, peak: 0.5 },
  },
  {
    id: 'nebulous', label: 'Nebulous', hue: 290,
    desc: 'Soft drifting nebula clouds; a smooth pad that twinkles, with long overlapping grains',
    visual: 'cloud', voice: 'twinkle', noteStep: 'scale',
    filterQ: 700, gainRange: [0.6, 3.4], maxEnergy: 26, tau: 0.4,
    grain: { durRange: [0.5, 1.1], density: 3, rateSteps: [0.5, 0.75, 1], attack: 0.5, spread: 1, peak: 0.3 },
  },
];

const findProduction = (productions: Record<string, Production>, symbol: string) => {
  const prod = productions[symbol];
  if (!prod) return null;
  let total = 0;
  const rnd = Math.random();
  for (const s of prod.successors) {
    total += s.p;
    if (rnd <= total) return { terminalAge: prod.terminalAge, items: s.items };
  }
  return null;
};

const lExpand = (ls: LSystem, str: LChar[], elapsed: number): void => {
  for (let i = str.length - 1; i >= 0; i--) {
    const chr = str[i];
    chr.age = elapsed - chr.birthTime;
    if (chr.age >= chr.terminalAge) {
      const prod = findProduction(ls.productions, chr.symbol);
      if (prod) {
        const childBirth = chr.birthTime + chr.terminalAge;
        const next: LChar[] = prod.items.map((it) => ({
          symbol: it.symbol,
          birthTime: childBirth,
          age: elapsed - childBirth,
          terminalAge: rand(prod.terminalAge),
          params: it.params && it.params(chr.params, chr.age),
        }));
        str.splice(i, 1, ...next);
      }
    }
  }
};

const turtle = (str: LChar[], origin: Pt, rotate: number, onF: (chr: LChar, from: Pt, to: Pt) => void): void => {
  let loc = { ...origin };
  let angle = rotate;
  const stack: { loc: Pt; angle: number }[] = [];
  for (const chr of str) {
    switch (chr.symbol) {
      case 'F': {
        const { l, lInit } = chr.params;
        const ageCoef = Math.min(lInit + chr.age / chr.terminalAge, 1);
        const len = l * ageCoef;
        const to = { x: loc.x + len * Math.cos((angle / 180) * Math.PI), y: loc.y + len * Math.sin((angle / 180) * Math.PI) };
        onF(chr, loc, to);
        loc = to;
        break;
      }
      case '-': angle -= chr.params.a; break;
      case '+': angle += chr.params.a; break;
      case '[': stack.push({ loc: { ...loc }, angle }); break;
      case ']': { const s = stack.pop(); if (s) { loc = s.loc; angle = s.angle; } break; }
    }
  }
};

const noteColor = (hue: number, noteIndex: number, alpha = 1): string => {
  const light = scale01(noteIndex / SCALE.length, [38, 74]);
  return `hsla(${hue}, 85%, ${light}%, ${alpha})`;
};
const nextNoteScale = (cur: number): number => {
  const interval = randItem(INTERVALS) * randItem([-1, 1]);
  const n = cur + interval;
  return n >= 0 && n < SCALE.length ? n : cur - interval;
};
const nextNoteFib = (cur: number): number => {
  const step = randItem(FIB) * randItem([-1, 1]);
  return ((cur + step) % SCALE.length + SCALE.length) % SCALE.length;
};

// ── per-path state ────────────────────────────────────────────────────────────
interface Voice {
  filters: BiquadFilterNode[];
  gain: GainNode;          // energy-driven level
  panner: StereoPannerNode;
  extra: AudioNode[];      // articulation nodes (shaper / lp / gate / twinkle gains)
  lfos: OscillatorNode[];
}
interface Stroke { lastPoint: Pt; point: Pt; addedAt: number }
interface Offshoot { str: LChar[]; age: number; point: Pt; angle: number; growthTime: number; lines?: Record<number, { from: Pt; to: Pt }[]>; alpha?: number }
/** A particle for the non-organic brushes. Fields are reused per brush:
 *  phyllotaxis -> n is the grown dot count; cloud -> life/vx/vy/a drive drift +
 *  twinkle; graph -> r is the node square size. */
interface Particle { x: number; y: number; vx: number; vy: number; born: number; life: number; seed: number; n: number; r: number; a: number }
interface DrawPath {
  brush: BrushDef;
  effect: string;
  hue: number;
  strokes: Stroke[];
  offshoots: Offshoot[];
  particles: Particle[];
  edges: [number, number][];
  pulses: { a: number; b: number; t: number }[];
  noteIndex: number;
  lastActivityAt: number;
  voice?: Voice;
  sfChannel?: number;
  sfMidi?: number;
  melodyIdx?: number;
}

export type SoundMode = 'drone' | 'soundfont' | 'granular';

export class DrawEngine {
  private ctx = getEngineCtx();
  private canvas: HTMLCanvasElement;
  private c2d: CanvasRenderingContext2D;
  brush: BrushDef = BRUSHES[0];
  currentMode = 0;
  /** Per-stroke mode slots; each holds an effect value (built-in or `rack:`). */
  private modeSlots: string[] = DEFAULT_MODE_SLOTS.slice();
  /** Lazily-built psychoacoustic insert instances, shared across strokes. */
  private rackInsts = new Map<string, RackEffectInstance>();
  soundMode: SoundMode = 'drone';
  sfProgram = 89; // GM 90 = Pad 2 (warm); a soft default for drawn notes
  private paths: DrawPath[] = [];
  /** Voices fading out: torn down a few per frame once their tail has decayed,
   *  so a wave of expiring strokes never disconnects everything in one hitch. */
  private dying: { nodes: AudioNode[]; lfos: OscillatorNode[]; at: number }[] = [];
  private noteIndex = Math.floor(Math.random() * SCALE.length);
  private spawnTarget = 0;
  private sinceSpawn = 0;
  private active: DrawPath | null = null;
  private last: Pt | null = null;
  private raf = 0;
  private audioTimer = 0;
  private noise!: AudioBufferSourceNode;
  private master: GainNode;
  private fxBus: GainNode;
  private chainHandle: ChainHandle | null = null;
  private effects: Record<string, AudioNode> = {};
  private fxOsc: OscillatorNode[] = [];
  private sfChannelSeq = 1;
  private grainBuffer: AudioBuffer | null = null;
  private grainSeq = 0;
  private magentaLoop = false;
  private magentaToken = 0;
  /** Panel-supplied status sink for the live Magenta loop. */
  onMagentaStatus?: (s: string) => void;
  private melody: { pitch: number; start: number; end: number }[] = [];
  readonly recordDest: MediaStreamAudioDestinationNode;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.c2d = canvas.getContext('2d')!;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

    // Master -> soft clip -> app master. The soft clip keeps loud drones from
    // harshly clipping now that the levels are higher.
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve(1.4);
    clip.oversample = '2x';
    this.master.connect(clip);
    clip.connect(getMasterGain());
    // Tap the FULL app master so every source lands in the recording.
    this.recordDest = ctx.createMediaStreamDestination();
    getMasterGain().connect(this.recordDest);

    // Per-stroke built-in effects feed this bus, which then runs through the
    // user-configurable global FX chain on its way to the master.
    this.fxBus = ctx.createGain();
    this.buildEffects(ctx);
    this.chainHandle = buildEffectChain(ctx, this.fxBus, this.master, []);
    // The Chop effect needs its worklet on this context before it can be chosen.
    void ensureChopModule(ctx).catch(() => {});

    // Looping white noise feeding every drone voice.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;
    this.noise.start();

    this.attach();
    this.audioTimer = window.setInterval(() => this.audioTick(), 200);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Build the per-stroke MODE effect graph. Each entry connects to the FX bus,
   *  which then runs through the user-configurable global chain to the master. */
  private buildEffects(ctx: AudioContext): void {
    const master = this.fxBus;

    // 1. Clean — gentle compressor.
    const comp = ctx.createDynamicsCompressor();
    comp.connect(master);
    this.effects.clean = comp;

    // 2. Tremolo — bus gain modulated by an LFO.
    const trem = ctx.createGain();
    trem.gain.value = 0.6;
    const tlfo = ctx.createOscillator();
    tlfo.frequency.value = 9;
    const tdepth = ctx.createGain();
    tdepth.gain.value = 0.4;
    tlfo.connect(tdepth).connect(trem.gain);
    tlfo.start();
    trem.connect(master);
    this.effects.tremolo = trem;
    this.fxOsc.push(tlfo);

    // 3. Distortion.
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(12);
    shaper.oversample = '2x';
    shaper.connect(master);
    this.effects.distortion = shaper;

    // 4. Echo — discrete feedback repeats.
    const echoIn = ctx.createGain();
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.34;
    const fb = ctx.createGain();
    fb.gain.value = 0.45;
    echoIn.connect(master);
    echoIn.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(master);
    this.effects.echo = echoIn;

    // 5. Reverb — long smooth convolver tail (distinct from the discrete echo).
    const reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    const irLen = Math.floor(ctx.sampleRate * 3.4);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / irLen) ** 2.4;
    }
    conv.buffer = ir;
    const revWet = ctx.createGain();
    revWet.gain.value = 0.9;
    const revDry = ctx.createGain();
    revDry.gain.value = 0.5;
    reverbIn.connect(revDry).connect(master);
    reverbIn.connect(conv).connect(revWet).connect(master);
    this.effects.reverb = reverbIn;

    // 6. Bitcrush — stepped waveshaper, mostly wet.
    const crushIn = ctx.createGain();
    const crush = ctx.createWaveShaper();
    crush.curve = bitCurve(5);
    const crushWet = ctx.createGain();
    crushWet.gain.value = 0.9;
    const crushDry = ctx.createGain();
    crushDry.gain.value = 0.2;
    crushIn.connect(crushDry).connect(master);
    crushIn.connect(crush).connect(crushWet).connect(master);
    this.effects.bitcrush = crushIn;

    // 7. Ring modulator — signal x sine carrier.
    const ringIn = ctx.createGain();
    const ring = ctx.createGain();
    ring.gain.value = 0; // carrier drives the value
    const carrier = ctx.createOscillator();
    carrier.frequency.value = 180;
    carrier.connect(ring.gain);
    const ringWet = ctx.createGain();
    ringWet.gain.value = 0.9;
    const ringDry = ctx.createGain();
    ringDry.gain.value = 0.25;
    ringIn.connect(ringDry).connect(master);
    ringIn.connect(ring).connect(ringWet).connect(master);
    carrier.start();
    this.effects.ringmod = ringIn;
    this.fxOsc.push(carrier);

    // 8. Stereo widen — true mid/side (the voices arrive stereo via their panner).
    const widenIn = ctx.createGain();
    const wSplit = ctx.createChannelSplitter(2);
    widenIn.connect(wSplit);
    const mid = ctx.createGain();
    const lMid = ctx.createGain(); lMid.gain.value = 0.5;
    const rMid = ctx.createGain(); rMid.gain.value = 0.5;
    wSplit.connect(lMid, 0); lMid.connect(mid);
    wSplit.connect(rMid, 1); rMid.connect(mid);
    const side = ctx.createGain();
    const lSide = ctx.createGain(); lSide.gain.value = 0.5;
    const rSide = ctx.createGain(); rSide.gain.value = -0.5;
    wSplit.connect(lSide, 0); lSide.connect(side);
    wSplit.connect(rSide, 1); rSide.connect(side);
    const sideW = ctx.createGain(); sideW.gain.value = 1.9;
    side.connect(sideW);
    const sideWneg = ctx.createGain(); sideWneg.gain.value = -1;
    sideW.connect(sideWneg);
    const outL = ctx.createGain();
    const outR = ctx.createGain();
    mid.connect(outL); sideW.connect(outL);
    mid.connect(outR); sideWneg.connect(outR);
    const merger = ctx.createChannelMerger(2);
    outL.connect(merger, 0, 0);
    outR.connect(merger, 0, 1);
    merger.connect(master);
    this.effects.widen = widenIn;

    // 9. Exciter — high-passed harmonics blended back as "air".
    const exIn = ctx.createGain();
    exIn.connect(master); // dry through
    const exHp = ctx.createBiquadFilter();
    exHp.type = 'highpass';
    exHp.frequency.value = 3200;
    const exShaper = ctx.createWaveShaper();
    exShaper.curve = driveCurve(8);
    exShaper.oversample = '4x';
    const exWet = ctx.createGain();
    exWet.gain.value = 0.5;
    exIn.connect(exHp).connect(exShaper).connect(exWet).connect(master);
    this.effects.exciter = exIn;

    // 10. Orbit — HRTF panner spun by two slow LFOs (3D movement).
    const orbitIn = ctx.createGain();
    const oPan = ctx.createPanner();
    oPan.panningModel = 'HRTF';
    oPan.distanceModel = 'inverse';
    oPan.refDistance = 1;
    oPan.positionY.value = 0;
    orbitIn.connect(oPan).connect(master);
    const orbit = (rate: number, target: AudioParam, radius: number) => {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const g = ctx.createGain();
      g.gain.value = radius;
      lfo.connect(g).connect(target);
      lfo.start();
      this.fxOsc.push(lfo);
    };
    orbit(0.25, oPan.positionX, 2.2);
    orbit(0.19, oPan.positionZ, 2.2);
    this.effects.orbit = orbitIn;

    // 11. Formant — parallel vowel-band bandpass filters (talk-box colour).
    const fmIn = ctx.createGain();
    const fmDry = ctx.createGain();
    fmDry.gain.value = 0.3;
    fmIn.connect(fmDry).connect(master);
    const formants: Array<[number, number, number]> = [[800, 8, 1], [1150, 9, 0.7], [2900, 10, 0.4]];
    for (const [freq, q, amp] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = amp;
      fmIn.connect(bp).connect(g).connect(master);
    }
    this.effects.formant = fmIn;

    // 12. Lowpass — warm everything down.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = 0.7;
    lp.connect(master);
    this.effects.lowpass = lp;
  }

  setMode(i: number): void { if (i >= 0 && i < this.modeSlots.length) this.currentMode = i; }
  /** Reassign the per-stroke mode slots (each slot can be any effect value). */
  setModeSlots(slots: string[]): void {
    if (slots.length) this.modeSlots = slots.slice();
    if (this.currentMode >= this.modeSlots.length) this.currentMode = 0;
  }
  setBrush(id: BrushId): void {
    const b = BRUSHES.find((x) => x.id === id);
    if (b) this.brush = b;
  }
  /** Rewire the global FX chain (add/remove/reorder/toggle of MIX inserts). */
  setChain(entries: ChainEntry[]): void { this.chainHandle?.rebuild(entries); }
  /** Push a live param change into one running chain effect without a rebuild. */
  updateChainParam(entryId: string, params: Record<string, number>): void {
    this.chainHandle?.updateParams(entryId, params);
  }
  setSoundMode(m: SoundMode): void {
    this.soundMode = m;
    if (m === 'soundfont') void ensureSoundfontReady();
  }
  setInstrument(program: number): void { this.sfProgram = program; }
  setMasterVolume(v: number): void { this.master.gain.setTargetAtTime(clampN(v, 0, 1.5), this.ctx.currentTime, 0.02); }

  /** Load an audio URL (e.g. a library song) as the granular grain source. */
  async loadGrainSource(url: string): Promise<boolean> {
    try {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      this.grainBuffer = await this.ctx.decodeAudioData(arr);
      return true;
    } catch {
      this.grainBuffer = null;
      return false;
    }
  }
  get hasGrainSource(): boolean { return this.grainBuffer !== null; }
  get magentaLive(): boolean { return this.magentaLoop; }

  /** Stream Magenta in real time (Collider-style): a continuous generation loop
   *  feeds each freshly generated ~4s chunk in as the live granular grain source.
   *  Reuses the batch /api/magenta/generate endpoint with extend=true, so there is
   *  no backend change. The sidecar serialises generation, so this and the iframe
   *  Jam/Collider tools are mutually exclusive (one live generative source at a time). */
  async startMagentaGrain(prompt: string): Promise<void> {
    if (this.magentaLoop) return;
    this.magentaLoop = true;
    const token = ++this.magentaToken;
    let first = true;
    this.onMagentaStatus?.('Magenta warming up...');
    while (this.magentaLoop && this.magentaToken === token) {
      try {
        const form = new FormData();
        form.append('prompt', prompt || 'evolving instrumental texture');
        form.append('duration', '4');
        form.append('model_size', 'small');
        if (!first) form.append('extend', 'true');
        const res = await fetch('/api/magenta/generate', { method: 'POST', body: form });
        if (res.status === 412) { this.onMagentaStatus?.('Magenta not installed - run Setup-MRT2'); break; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { job } = await res.json();
        const arr = await pollMagentaJob(job.id);
        if (!this.magentaLoop || this.magentaToken !== token) break;
        this.grainBuffer = await this.ctx.decodeAudioData(arr);
        first = false;
        this.onMagentaStatus?.('Magenta live - draw to granulate it');
      } catch (e) {
        this.onMagentaStatus?.(`Magenta error: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((r) => setTimeout(r, 900));
      }
    }
    if (this.magentaToken === token) this.magentaLoop = false;
  }

  stopMagentaGrain(): void {
    this.magentaLoop = false;
    this.magentaToken++;
    this.onMagentaStatus?.('Magenta live stopped');
  }

  /** Drawn-note melody captured this session (seconds, normalised to the first
   *  note). Open notes are closed at "now". Used to hand the session to Magenta. */
  getMelody(): { pitch: number; start: number; end: number }[] {
    if (!this.melody.length) return [];
    const now = performance.now() / 1000;
    const t0 = this.melody[0].start;
    return this.melody.map((e) => ({
      pitch: e.pitch,
      start: Math.max(0, e.start - t0),
      end: Math.max(e.start - t0 + 0.05, (e.end < 0 ? now : e.end) - t0),
    }));
  }

  private spawnGrain(profile: GrainProfile, energy: number, pan: number): void {
    const buf = this.grainBuffer;
    if (!buf) return;
    const ctx = this.ctx;
    const count = Math.max(1, Math.round(profile.density * (0.4 + energy)));
    for (let i = 0; i < count; i++) {
      const dur = rand(profile.durRange);
      const span = Math.max(0, buf.duration - dur);
      const offset = profile.golden ? ((this.grainSeq++ * GOLDEN_FRAC) % 1) * span : Math.random() * span;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = randItem(profile.rateSteps);
      const g = ctx.createGain();
      const panner = ctx.createStereoPanner();
      panner.pan.value = clampN(pan * profile.spread + (Math.random() - 0.5) * profile.spread, -1, 1);
      src.connect(g).connect(panner).connect(this.effectTarget(this.effectKey()));
      const t = ctx.currentTime;
      const atk = dur * profile.attack;
      const peak = Math.min(profile.peak, profile.peak * (0.3 + energy));
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + atk);
      g.gain.linearRampToValueAtTime(0, t + dur);
      src.start(t, offset, dur);
      src.stop(t + dur + 0.02);
      src.onended = () => {
        try { src.disconnect(); g.disconnect(); panner.disconnect(); } catch { /* gone */ }
      };
    }
  }

  private effectKey(): string { return this.modeSlots[this.currentMode] ?? 'clean'; }

  /** Resolve a mode value to the live AudioNode input voices route into. Built-in
   *  effects use the pre-built nodes; `rack:` values build (and cache) a live
   *  psychoacoustic insert whose output feeds the FX bus. */
  private effectTarget(value: string): AudioNode {
    if (value.startsWith('rack:')) {
      const id = value.slice(5);
      let inst = this.rackInsts.get(id);
      if (!inst) {
        const def = getRackEffect(id);
        if (!def) return this.effects.clean;
        inst = def.make(this.ctx, rackEffectDefaults(id));
        inst.output.connect(this.fxBus);
        this.rackInsts.set(id, inst);
      }
      return inst.input;
    }
    return this.effects[value] ?? this.effects.clean;
  }

  clear(immediate = false): void {
    for (const p of this.paths) this.killVoice(p, immediate);
    this.paths = [];
    this.melody = [];
    this.c2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    clearInterval(this.audioTimer);
    this.magentaLoop = false;
    this.magentaToken++;
    this.detach();
    this.clear(true);
    try { this.noise.stop(); } catch { /* already stopped */ }
    for (const d of this.dying) {
      for (const o of d.lfos) { try { o.stop(); } catch { /* not started */ } }
      for (const n of d.nodes) { try { n.disconnect(); } catch { /* gone */ } }
    }
    this.dying = [];
    for (const inst of this.rackInsts.values()) { try { inst.dispose(); } catch { /* gone */ } }
    this.rackInsts.clear();
    for (const o of this.fxOsc) { try { o.stop(); } catch { /* not started */ } }
    try { this.chainHandle?.dispose(); } catch { /* gone */ }
    try { getMasterGain().disconnect(this.recordDest); } catch { /* gone */ }
    try { this.master.disconnect(); } catch { /* gone */ }
  }

  // ── pointer handling ────────────────────────────────────────────────────────
  private toLocal(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.canvas.width, y: ((e.clientY - r.top) / r.height) * this.canvas.height };
  }
  private down = (e: PointerEvent): void => {
    this.canvas.setPointerCapture?.(e.pointerId);
    const pt = this.toLocal(e);
    this.spawnTarget = rand(SPAWN_RATE);
    this.sinceSpawn = 0;
    this.last = pt;
    const path: DrawPath = {
      brush: this.brush,
      effect: this.effectKey(),
      hue: this.brush.hue,
      strokes: [{ lastPoint: pt, point: pt, addedAt: Date.now() }],
      offshoots: [],
      particles: [],
      edges: [],
      pulses: [],
      noteIndex: this.noteIndex,
      lastActivityAt: Date.now(),
    };
    // Log the note so the session can be handed to Magenta.
    path.melodyIdx = this.melody.length;
    this.melody.push({ pitch: noteToMidi(SCALE[this.noteIndex]), start: performance.now() / 1000, end: -1 });
    // Retire the oldest path(s) so the live set stays bounded under heavy drawing.
    while (this.paths.length >= MAX_PATHS) {
      const old = this.paths.shift();
      if (old) this.killVoice(old);
    }
    this.active = path;
    this.paths.push(path);
    this.noteIndex = this.brush.noteStep === 'fib' ? nextNoteFib(this.noteIndex) : nextNoteScale(this.noteIndex);
  };
  private move = (e: PointerEvent): void => {
    if (!this.active || !this.last) return;
    const pt = this.toLocal(e);
    const delta = dist(pt, this.last);
    const angle = (Math.atan2(pt.y - this.last.y, pt.x - this.last.x) * 180) / Math.PI;
    this.active.strokes.push({ lastPoint: this.last, point: pt, addedAt: Date.now() });
    this.sinceSpawn += delta;
    if (this.sinceSpawn >= this.spawnTarget) {
      if (this.active.brush.visual === 'lsystem') {
        const growth = Math.min(1, Math.max(0.2, ORG.growthFactor / Math.max(0.5, delta)));
        this.active.offshoots.push({
          str: ORGANIC_SYSTEM.axiom.map((a) => ({ symbol: a.symbol, birthTime: 0, age: 0, terminalAge: a.terminalAge, params: a.params })),
          age: 0, point: this.last, angle, growthTime: MAX_GROWTH_TIME * growth,
        });
      } else {
        this.spawnParticles(this.active, this.last);
      }
      this.active.lastActivityAt = Date.now();
      this.spawnTarget = rand(SPAWN_RATE);
      this.sinceSpawn = 0;
    }
    this.last = pt;
  };
  private up = (): void => { this.active = null; this.last = null; };
  private attach(): void {
    this.canvas.addEventListener('pointerdown', this.down);
    this.canvas.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
  }
  private detach(): void {
    this.canvas.removeEventListener('pointerdown', this.down);
    this.canvas.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
  }

  // ── particle spawning (non-organic brushes) ───────────────────────────────────
  private spawnParticles(path: DrawPath, at: Pt): void {
    const now = performance.now();
    const mk = (x: number, y: number, vx = 0, vy = 0, life = 0, r = 2): Particle =>
      ({ x, y, vx, vy, born: now, life, seed: Math.random(), n: 0, r, a: 1 });
    switch (path.brush.visual) {
      case 'phyllotaxis':
        if (path.particles.length < 16) path.particles.push(mk(at.x, at.y));
        break;
      case 'graph': {
        if (path.particles.length >= 46) break;
        const node = mk(at.x + (Math.random() - 0.5) * 6, at.y + (Math.random() - 0.5) * 6, 0, 0, 0, 2 + Math.random() * 2);
        const idx = path.particles.length;
        path.particles.push(node);
        const near = path.particles
          .map((p, i) => ({ i, d: i === idx ? Infinity : dist(p, node) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 2);
        for (const nb of near) if (nb.d < 220) path.edges.push([idx, nb.i]);
        if (path.edges.length && Math.random() < 0.7) {
          const e = path.edges[path.edges.length - 1];
          path.pulses.push({ a: e[0], b: e[1], t: 0 });
        }
        break;
      }
      case 'cloud': {
        const k = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < k; i++) {
          if (path.particles.length >= 64) break;
          const ang = Math.random() * Math.PI * 2;
          const sp = 4 + Math.random() * 10;
          path.particles.push(mk(at.x, at.y, Math.cos(ang) * sp, Math.sin(ang) * sp, 3 + Math.random() * 3, 18 + Math.random() * 40));
        }
        break;
      }
      default:
        break;
    }
  }

  // ── render loop ───────────────────────────────────────────────────────────────
  private prevT = 0;
  private frame = (t: number): void => {
    const dt = this.prevT ? (t - this.prevT) / 1000 : 0;
    this.prevT = t;
    const ctx = this.c2d;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.processDying(performance.now());
    for (let i = this.paths.length - 1; i >= 0; i--) {
      const p = this.paths[i];
      if (p.lastActivityAt < Date.now() - MAX_GROWTH_TIME * 1000) {
        this.killVoice(p);
        this.paths.splice(i, 1);
        continue;
      }
      // fading freehand strokes (immediate feedback, all brushes)
      ctx.lineWidth = 2;
      for (let j = p.strokes.length - 1; j >= 0; j--) {
        const s = p.strokes[j];
        const alpha = 1 - (Date.now() - s.addedAt) / 1000;
        if (alpha > 0) {
          ctx.strokeStyle = noteColor(p.hue, p.noteIndex, alpha);
          ctx.beginPath();
          ctx.moveTo(s.lastPoint.x, s.lastPoint.y);
          ctx.lineTo(s.point.x, s.point.y);
          ctx.stroke();
        } else p.strokes.splice(j, 1);
      }
      if (p.brush.visual === 'lsystem') this.drawOffshoots(p, dt);
      else this.drawParticles(p, dt);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private drawOffshoots(p: DrawPath, dt: number): void {
    const ctx = this.c2d;
    for (let k = p.offshoots.length - 1; k >= 0; k--) {
      const o = p.offshoots[k];
      o.age += dt;
      if (o.age >= MAX_GROWTH_TIME) { p.offshoots.splice(k, 1); continue; }
      if (o.age < o.growthTime) {
        const eased = easeOutQuart(o.age / o.growthTime) * o.growthTime;
        lExpand(ORGANIC_SYSTEM, o.str, eased);
        o.lines = {};
        turtle(o.str, o.point, o.angle, (chr, from, to) => {
          const w = Math.ceil(((chr.age + (chr.params?.ageAcc || 0)) / MAX_GROWTH_TIME) * 10);
          (o.lines![w] ||= []).push({ from, to });
        });
      }
      o.alpha = Math.min(1, 1 - (o.age - MAX_GROWTH_TIME / 2) / 5);
      ctx.strokeStyle = noteColor(p.hue, p.noteIndex, o.alpha);
      for (const w of Object.keys(o.lines || {})) {
        ctx.beginPath();
        ctx.lineWidth = Number(w) / 5;
        for (const ln of o.lines![Number(w)]) { ctx.moveTo(ln.from.x, ln.from.y); ctx.lineTo(ln.to.x, ln.to.y); }
        ctx.stroke();
      }
    }
  }

  private drawParticles(p: DrawPath, dt: number): void {
    const ctx = this.c2d;
    const hue = p.hue;
    const now = performance.now();
    if (p.brush.visual === 'phyllotaxis') {
      for (const bl of p.particles) {
        const age = (now - bl.born) / 1000;
        bl.n = Math.min(78, Math.floor((age / 3.0) * 78));
        for (let k = 0; k < bl.n; k++) {
          const a = k * GOLDEN_ANGLE;
          const rr = 4.2 * Math.sqrt(k);
          const px = bl.x + Math.cos(a) * rr;
          const py = bl.y + Math.sin(a) * rr;
          const tt = k / Math.max(1, bl.n);
          const alpha = Math.min(1, 1.1 - age / 6) * (0.5 + 0.5 * tt);
          if (alpha <= 0) continue;
          ctx.fillStyle = `hsla(${hue}, 88%, ${55 + tt * 20}%, ${alpha})`;
          ctx.beginPath();
          ctx.arc(px, py, 1.2 + tt * 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (p.brush.visual === 'graph') {
      ctx.lineWidth = 1;
      for (const [a, b] of p.edges) {
        const pa = p.particles[a];
        const pb = p.particles[b];
        if (!pa || !pb) continue;
        const age = (now - pa.born) / 1000;
        const alpha = Math.min(0.6, Math.max(0, 0.7 - age / 9));
        if (alpha <= 0) continue;
        ctx.strokeStyle = `hsla(${hue}, 90%, 60%, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
      for (let i = p.pulses.length - 1; i >= 0; i--) {
        const pu = p.pulses[i];
        pu.t += dt * 1.6;
        if (pu.t >= 1) { p.pulses.splice(i, 1); continue; }
        const pa = p.particles[pu.a];
        const pb = p.particles[pu.b];
        if (!pa || !pb) { p.pulses.splice(i, 1); continue; }
        ctx.fillStyle = `hsla(${hue}, 100%, 78%, ${1 - pu.t})`;
        ctx.beginPath();
        ctx.arc(pa.x + (pb.x - pa.x) * pu.t, pa.y + (pb.y - pa.y) * pu.t, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const nd of p.particles) {
        if (Math.random() < 0.04) { nd.x += (Math.random() - 0.5) * 2; nd.y += (Math.random() - 0.5) * 2; } // glitch jitter
        const flick = Math.random() < 0.08 ? 0.4 : 1;
        ctx.fillStyle = `hsla(${hue}, 95%, 66%, ${0.9 * flick})`;
        ctx.fillRect(nd.x - nd.r / 2, nd.y - nd.r / 2, nd.r, nd.r);
      }
    } else {
      // cloud / nebula
      ctx.globalCompositeOperation = 'lighter';
      for (let i = p.particles.length - 1; i >= 0; i--) {
        const pr = p.particles[i];
        const age = (now - pr.born) / 1000;
        if (age >= pr.life) { p.particles.splice(i, 1); continue; }
        pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.vx *= 0.985; pr.vy *= 0.985;
        const lifeFrac = 1 - age / pr.life;
        const twinkle = 0.6 + 0.4 * Math.sin(now * 0.004 * (1 + pr.seed) + pr.seed * 6.28);
        pr.a = lifeFrac * twinkle;
        const grad = ctx.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, pr.r);
        grad.addColorStop(0, `hsla(${hue}, 80%, 72%, ${0.5 * pr.a})`);
        grad.addColorStop(1, `hsla(${hue}, 80%, 50%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, pr.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ── audio loop (every 200ms) ───────────────────────────────────────────────────
  private measure(p: DrawPath): { raw: number; avgX: number; count: number } {
    let raw = 0;
    let sx = 0;
    let c = 0;
    if (p.brush.visual === 'lsystem') {
      for (const o of p.offshoots) {
        for (const w of Object.keys(o.lines || {})) {
          for (const ln of o.lines![Number(w)]) {
            raw += dist(ln.to, ln.from) * (o.alpha ?? 1);
            sx += ln.to.x;
            c++;
          }
        }
      }
    } else if (p.brush.visual === 'phyllotaxis') {
      for (const bl of p.particles) { raw += bl.n; sx += bl.x; c++; }
    } else if (p.brush.visual === 'graph') {
      raw = p.particles.length + 2 * p.pulses.length;
      for (const nd of p.particles) { sx += nd.x; c++; }
    } else {
      for (const pr of p.particles) { raw += Math.max(0, pr.a); sx += pr.x; c++; }
    }
    return { raw, avgX: c > 0 ? sx / c : 0, count: c };
  }

  private audioTick(): void {
    const ctx = this.ctx;
    for (const p of this.paths) {
      const { raw, avgX, count } = this.measure(p);
      const energy = Math.min(1, raw / p.brush.maxEnergy);
      const pan = count > 0 ? (avgX / this.canvas.width) * 2 - 1 : 0;
      if (this.soundMode === 'drone') {
        if (!p.voice) p.voice = this.makeVoice(p);
        const g = Math.max(scale01(energy, p.brush.gainRange), 0.0001);
        p.voice.gain.gain.setTargetAtTime(g, ctx.currentTime, p.brush.tau);
        p.voice.panner.pan.setTargetAtTime(pan, ctx.currentTime, 0.03);
      } else if (this.soundMode === 'soundfont') {
        if (p.sfMidi === undefined) {
          const channel = (this.sfChannelSeq = (this.sfChannelSeq % 15) + 1);
          const midi = noteToMidi(SCALE[p.noteIndex]);
          const vel = Math.round(scale01(energy, [44, 118]));
          p.sfChannel = channel;
          p.sfMidi = midi;
          try { liveNoteOn(channel, this.sfProgram, midi, vel); } catch { /* engine warming */ }
        }
      } else {
        if (!this.grainBuffer) continue;
        if (energy < 0.02) continue;
        this.spawnGrain(p.brush.grain, energy, pan);
      }
    }
  }

  private makeVoice(p: DrawPath): Voice {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = p.brush.gainRange[0];
    const panner = ctx.createStereoPanner();
    const baseMidi = noteToMidi(SCALE[p.noteIndex]);
    const filters = [baseMidi, baseMidi - 12, baseMidi - 24].map((m) => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = midiToFreq(m);
      f.Q.value = p.brush.filterQ;
      this.noise.connect(f);
      f.connect(gain);
      return f;
    });

    // Brush articulation between the energy gain and the panner.
    const extra: AudioNode[] = [];
    const lfos: OscillatorNode[] = [];
    let tail: AudioNode = gain;
    if (p.brush.voice === 'twinkle') {
      // soft pad: lowpass + a slow gentle amplitude shimmer
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      lp.Q.value = 0.6;
      const tw = ctx.createGain();
      tw.gain.value = 0.85;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.15 + Math.random() * 0.25;
      const depth = ctx.createGain();
      depth.gain.value = 0.18;
      lfo.connect(depth).connect(tw.gain);
      lfo.start();
      gain.connect(lp).connect(tw);
      extra.push(lp, tw, depth);
      lfos.push(lfo);
      tail = tw;
    } else if (p.brush.voice === 'gate') {
      // rigid glitch: a touch of drive into a hard square gate
      const sh = ctx.createWaveShaper();
      sh.curve = driveCurve(6);
      const gt = ctx.createGain();
      gt.gain.value = 0.62;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 8 + Math.random() * 6;
      const depth = ctx.createGain();
      depth.gain.value = 0.38;
      lfo.connect(depth).connect(gt.gain);
      lfo.start();
      gain.connect(sh).connect(gt);
      extra.push(sh, gt, depth);
      lfos.push(lfo);
      tail = gt;
    } else if (p.brush.voice === 'pulse') {
      // fibonacci pulse: a sine tremolo at a Fibonacci-derived rate
      const pg = ctx.createGain();
      pg.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = randItem([2, 3, 5]) * 0.8;
      const depth = ctx.createGain();
      depth.gain.value = 0.45;
      lfo.connect(depth).connect(pg.gain);
      lfo.start();
      gain.connect(pg);
      extra.push(pg, depth);
      lfos.push(lfo);
      tail = pg;
    }
    tail.connect(panner);
    panner.connect(this.effectTarget(p.effect));
    return { filters, gain, panner, extra, lfos };
  }

  /** Tear down a few decayed voices per frame to avoid a teardown burst. */
  private processDying(now: number, budget = 3): void {
    let n = 0;
    for (let i = this.dying.length - 1; i >= 0 && n < budget; i--) {
      const d = this.dying[i];
      if (now >= d.at) {
        for (const o of d.lfos) { try { o.stop(); } catch { /* not started */ } }
        for (const node of d.nodes) { try { node.disconnect(); } catch { /* gone */ } }
        this.dying.splice(i, 1);
        n++;
      }
    }
  }

  private killVoice(p: DrawPath, immediate = false): void {
    if (p.voice) {
      const v = p.voice;
      const lfos = v.lfos;
      const nodes: AudioNode[] = [...v.filters, ...v.extra, v.panner, v.gain];
      if (immediate) {
        for (const o of lfos) { try { o.stop(); } catch { /* not started */ } }
        for (const n of nodes) { try { n.disconnect(); } catch { /* gone */ } }
      } else {
        // Smooth release: ramp the voice down, then hand the nodes to the graveyard
        // so teardown is spread across frames (no setTimeout storm when many
        // strokes expire at once, which was the end-of-sound hitch).
        const t = this.ctx.currentTime;
        try {
          v.gain.gain.cancelScheduledValues(t);
          v.gain.gain.setTargetAtTime(0, t, VOICE_RELEASE);
        } catch { /* param busy */ }
        this.dying.push({ nodes, lfos, at: performance.now() + VOICE_RELEASE * 4 * 1000 + 80 });
      }
      p.voice = undefined;
    }
    if (p.sfMidi !== undefined && p.sfChannel !== undefined) {
      try { liveNoteOff(p.sfChannel, p.sfMidi); } catch { /* gone */ }
      p.sfMidi = undefined;
    }
    if (p.melodyIdx !== undefined && this.melody[p.melodyIdx] && this.melody[p.melodyIdx].end < 0) {
      this.melody[p.melodyIdx].end = performance.now() / 1000;
    }
  }
}
