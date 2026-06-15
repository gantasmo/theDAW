/**
 * djEngine — a real, independent 2-deck DJ audio engine (AudioBuffer hybrid).
 *
 * Performance decks decode their track to an AudioBuffer and play through an
 * AudioBufferSourceNode, so loops / hotcues / slip are SAMPLE-ACCURATE (the
 * source node's native loopStart/loopEnd wrap on the audio thread, click-free):
 *
 *   bufSrc A ─▶ lowA ─▶ midA ─▶ highA ─▶ gainA ─┐
 *                                               ├▶ djMaster ─▶ engine master
 *   bufSrc B ─▶ lowB ─▶ midB ─▶ highB ─▶ gainB ─┘        (shared: playerStore)
 *
 * Memory: a decoded full song is ~100 MB. We decode ONLY a loaded deck and free
 * the buffer the moment the deck is cleared, so at most ~2 are resident — bounded
 * and released on unload. Browsing/preview elsewhere still streams (wavesurfer
 * fetches its own peaks); the deck engine itself is pure Web Audio.
 *
 * `playbackRate` on the source doubles as the turntable pitch (speed+pitch
 * together, like a real deck's pitch fader).
 *
 * INDEPENDENT of the footer player: both mix at the shared engine master, so the
 * visualizer/HUD see DJ audio and the global volume/mute still apply, but the
 * footer's single-track transport is untouched ("independent DJ engine").
 *
 * Crossfader uses an equal-power curve so perceived loudness stays constant
 * across the sweep (center = both at ~-3 dB).
 *
 * SLIP: while a loop (or loop-roll) is engaged, a virtual clock keeps advancing
 * underneath. On loop exit with slip on, playback jumps to where it WOULD be —
 * as if the loop never happened. Loop-roll always slip-resumes.
 */
import type { StretchNode } from 'signalsmith-stretch';
import { getEngineCtx, getMasterGain } from './playerStore';
import { logError } from './logStore';

export type DeckId = 'A' | 'B';

export interface DeckStatus {
  loadedUrl: string | null;
  label: string | null;
  playing: boolean;
  decoding: boolean;
  hasBuffer: boolean;
  currentTime: number;
  duration: number;
  loopActive: boolean;
  loopIn: number | null;
  loopOut: number | null;
  slip: boolean;
  pitchPct: number;
  keylock: boolean;
  stems: string[]; // loaded stem names (D4); empty = full-track mode
  stemLevels: Record<string, number>; // per-stem live gains, 0 = muted, 1 = full
}

export type DjFx = 'flanger' | 'reverb' | 'wahwah';

/** Per-deck FX rack (lazy-built on first use): a dry path plus parallel
 *  flanger / wah / reverb branches, each summed at `out` via its own wet gain. */
interface DeckFx {
  input: GainNode;
  out: GainNode;
  flangerWet: GainNode;
  reverbWet: GainNode;
  wahWet: GainNode;
  lfoFlanger: OscillatorNode;
  lfoWah: OscillatorNode;
  nodes: AudioNode[];
}

/** One separated stem playing in sync on a deck (D4): its own gain (live fader)
 *  feeds the deck's srcBus alongside the other stems. */
interface DeckStem {
  name: string;
  buffer: AudioBuffer;
  gain: GainNode;
  level: number;
}

interface Deck {
  delayComp: DelayNode; // A/B latency match when one deck is key-locked
  trim: GainNode; // auto-gain / leveling trim (independent of crossfader)
  vol: GainNode; // channel volume fader (manual), post-trim
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  filter: BiquadFilterNode; // single-knob DJ filter (LP↔HP sweep), post-EQ
  gain: GainNode; // crossfader-controlled
  // Key-lock (master tempo): a Signalsmith Stretch node inserted as a LIVE pitch
  // corrector. The source still rides playbackRate for speed; the insert shifts
  // pitch by -12·log2(rate) to cancel the resulting pitch change. Lazily created
  // on first enable; bypassed (source → delayComp directly) when off.
  stretch: StretchNode | null;
  stretchLatency: number; // live-input latency (sec) of the stretch node
  keylock: boolean;
  buffer: AudioBuffer | null;
  srcBus: GainNode; // fixed sum node all sources feed → [stretch?] → delayComp
  srcs: AudioBufferSourceNode[]; // current playing source(s): 1 full / N stems, recreated per start
  stems: DeckStem[] | null; // D4 live stems (per-stem gain → srcBus); null = full-track mode
  stemMode: boolean;
  playing: boolean;
  startCtxTime: number; // ctx.currentTime when src started
  startOffset: number; // buffer position (sec) at that start / paused position
  rate: number; // playbackRate (speed+pitch)
  loadedUrl: string | null;
  label: string | null;
  pitchPct: number;
  decoding: boolean;
  // loop
  loopActive: boolean;
  loopIn: number;
  loopOut: number;
  rollResume: boolean; // a loop-roll: always slip-resume on exit
  // slip virtual clock (valid while loopActive)
  slip: boolean;
  virtualBase: number;
  virtualStart: number;
  // FX rack (D5) — lazily built on first setDeckFx; spliced filter → fx → gain.
  fx: DeckFx | null;
  // Cue/headphone send (D6): filter → cueSend → cueBus → headphone sink. 0 = off.
  cueSend: GainNode;
  // Vinyl/scratch mode (jog wheel): a worklet that reads the full-track buffer
  // at a hand-driven velocity (forward/reverse), feeding delayComp directly so
  // it rides the EQ/filter/crossfader but bypasses key-lock (scratch must pitch-
  // bend). Lazily created; null when never scratched.
  vinyl: AudioWorkletNode | null;
  vinylActive: boolean;
  vinylPos: number; // last read-head position (sec) the worklet reported
  vinylWasPlaying: boolean; // deck playing state captured on grab, to restore
  vinylLoadedUrl: string | null; // which track's samples the worklet holds
}

const RAMP_TC = 0.012;

let djMaster: GainNode | null = null;
let limiter: DynamicsCompressorNode | null = null;
let limiterEnabled = true; // brickwall on the DJ bus for clip safety (D5)
// Cue/headphone bus (D6): per-deck cueSend → cueBus → MediaStreamDestination →
// a hidden <audio> whose setSinkId routes pre-listen to a second (headphone) output.
let cueBus: GainNode | null = null;
let cueDest: MediaStreamAudioDestinationNode | null = null;
let cueAudioEl: HTMLAudioElement | null = null;
let cueSinkId = '';
// Sampler bank (D7): one-shot pads routed through djMaster (so they ride the DJ
// mix + limiter + visualizer). Decoded buffers keyed by pad id.
const samples = new Map<string, AudioBuffer>();
let samplerGain: GainNode | null = null;
const decks: Partial<Record<DeckId, Deck>> = {};
let crossfade = 0; // -1 = full A, 0 = center, +1 = full B
let rafId = 0;

const listeners = new Set<(a: DeckStatus, b: DeckStatus) => void>();

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const ctxNow = () => getEngineCtx().currentTime;

function ensureMaster(): GainNode {
  if (djMaster) return djMaster;
  const ctx = getEngineCtx();
  djMaster = ctx.createGain();
  djMaster.gain.value = 1;
  // Brickwall limiter on the DJ bus (clip safety). Bypassable via setLimiter().
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.08;
  limiter.connect(getMasterGain());
  djMaster.connect(limiterEnabled ? limiter : getMasterGain());
  return djMaster;
}

/** The cue (headphone) bus: a MediaStreamDestination fed by per-deck cue sends,
 *  played through a hidden <audio> we can route to a 2nd output via setSinkId. */
function ensureCueBus(): GainNode {
  if (cueBus) return cueBus;
  const ctx = getEngineCtx();
  cueBus = ctx.createGain();
  cueDest = ctx.createMediaStreamDestination();
  cueBus.connect(cueDest);
  cueAudioEl = new Audio();
  cueAudioEl.srcObject = cueDest.stream;
  return cueBus;
}

function ensureSamplerGain(): GainNode {
  if (samplerGain) return samplerGain;
  samplerGain = getEngineCtx().createGain();
  samplerGain.connect(ensureMaster());
  return samplerGain;
}

/** The node a playing source feeds into: the key-lock pitch insert when engaged,
 *  else the deck's delay-comp input (insert bypassed). */
function deckInputNode(d: Deck): AudioNode {
  return d.keylock && d.stretch ? d.stretch : d.delayComp;
}

/** Re-balance the two decks' output latency so a key-locked deck (which adds the
 *  stretch node's latency) stays beat-aligned with a non-key-locked one: delay
 *  each deck up to the larger of the two engaged stretch latencies. */
function updateLatencyComp(): void {
  const ctx = getEngineCtx();
  const da = decks['A'];
  const db = decks['B'];
  const la = da?.keylock ? da.stretchLatency : 0;
  const lb = db?.keylock ? db.stretchLatency : 0;
  const maxL = Math.max(la, lb);
  if (da) da.delayComp.delayTime.setTargetAtTime(Math.max(0, maxL - la), ctx.currentTime, 0.01);
  if (db) db.delayComp.delayTime.setTargetAtTime(Math.max(0, maxL - lb), ctx.currentTime, 0.01);
}

/** Push the key-lock pitch correction (cancel the playbackRate pitch shift). */
function applyKeylockPitch(d: Deck): void {
  if (d.keylock && d.stretch) {
    void d.stretch.schedule({ semitones: -12 * Math.log2(d.rate) });
  }
}

/** Equal-power crossfader gains for a position in [-1, 1]. */
function crossGains(x: number): { a: number; b: number } {
  const t = (clamp(x, -1, 1) + 1) / 2; // 0 (A) … 1 (B)
  return { a: Math.cos(t * Math.PI * 0.5), b: Math.sin(t * Math.PI * 0.5) };
}

function buildDeck(id: DeckId): Deck {
  const ctx = getEngineCtx();
  const master = ensureMaster();

  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 1;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 3200;
  // Single-knob DJ filter: flat (allpass) at center, sweeps to LP / HP.
  const filter = ctx.createBiquadFilter();
  filter.type = 'allpass';
  filter.frequency.value = 1000;
  filter.Q.value = 0.0001;
  const gain = ctx.createGain();
  const trim = ctx.createGain(); // auto-gain / leveling, before the channel fader
  trim.gain.value = 1;
  const vol = ctx.createGain(); // channel volume fader (manual), post-trim
  vol.gain.value = 1;
  const delayComp = ctx.createDelay(1.0); // 0 normally; matches A/B key-lock latency
  const srcBus = ctx.createGain(); // all sources (full or stems) sum here → insert → delayComp
  const cueSend = ctx.createGain(); // pre-listen send → cue bus (headphones); 0 = off
  cueSend.gain.value = 0;

  const cg = crossGains(crossfade);
  gain.gain.value = id === 'A' ? cg.a : cg.b;

  // srcBus → [stretch?] → delayComp → trim → vol → low → mid → high → filter → [fx?] → gain(crossfader) → djMaster
  srcBus.connect(delayComp);
  delayComp.connect(trim);
  trim.connect(vol);
  vol.connect(low);
  low.connect(mid).connect(high).connect(filter).connect(gain).connect(master);
  filter.connect(cueSend); // post-EQ/filter pre-listen tap (survives the FX splice)
  cueSend.connect(ensureCueBus());

  const deck: Deck = {
    delayComp, trim, vol, low, mid, high, filter, gain, srcBus, cueSend,
    stretch: null, stretchLatency: 0, keylock: false,
    buffer: null, srcs: [], stems: null, stemMode: false, playing: false, startCtxTime: 0, startOffset: 0, rate: 1,
    loadedUrl: null, label: null, pitchPct: 0, decoding: false,
    loopActive: false, loopIn: 0, loopOut: 0, rollResume: false,
    slip: false, virtualBase: 0, virtualStart: 0,
    fx: null,
    vinyl: null, vinylActive: false, vinylPos: 0, vinylWasPlaying: false, vinylLoadedUrl: null,
  };
  decks[id] = deck;
  return deck;
}

function getDeck(id: DeckId): Deck {
  return decks[id] ?? buildDeck(id);
}

/** Track duration (sec) — from the loaded stems in stem mode, else the buffer. */
function deckDuration(d: Deck): number {
  if (d.stemMode && d.stems && d.stems[0]) return d.stems[0].buffer.duration;
  return d.buffer?.duration ?? 0;
}

/** Current audible buffer position (sec), mirroring native loop wrap. */
function audiblePos(d: Deck): number {
  const dur = deckDuration(d);
  if (!d.playing) return clamp(d.startOffset, 0, dur);
  let pos = d.startOffset + (ctxNow() - d.startCtxTime) * d.rate;
  if (d.loopActive && d.loopOut > d.loopIn && pos >= d.loopOut) {
    const span = d.loopOut - d.loopIn;
    pos = d.loopIn + ((pos - d.loopIn) % span);
  }
  return clamp(pos, 0, dur);
}

/** Virtual (slip) position — where playback would be if no loop were engaged. */
function virtualPos(d: Deck): number {
  const dur = deckDuration(d);
  if (!d.loopActive) return audiblePos(d);
  return clamp(d.virtualBase + (ctxNow() - d.virtualStart) * d.rate, 0, dur);
}

function stopSource(d: Deck): void {
  if (d.srcs.length === 0) return;
  const srcs = d.srcs;
  d.srcs = [];
  for (const s of srcs) {
    try { s.onended = null; s.stop(); } catch { /* already stopped */ }
    try { s.disconnect(); } catch { /* gone */ }
  }
}

/** (Re)start the deck's source(s) from `offset`, honoring loop state. In stem
 *  mode this starts N stem sources in lock-step (each → its stem gain → srcBus);
 *  in full mode a single source → srcBus. */
function startSource(d: Deck, offset: number): void {
  if ((d.stemMode && (!d.stems || d.stems.length === 0)) || (!d.stemMode && !d.buffer)) return;
  stopSource(d);
  const ctx = getEngineCtx();
  const dur = deckDuration(d);
  const start = clamp(offset, 0, dur);
  const mk = (buffer: AudioBuffer, dest: AudioNode): AudioBufferSourceNode => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = d.rate;
    if (d.loopActive && d.loopOut > d.loopIn) { s.loop = true; s.loopStart = d.loopIn; s.loopEnd = d.loopOut; }
    s.connect(dest);
    s.start(0, start);
    return s;
  };
  d.srcs = d.stemMode && d.stems
    ? d.stems.map((st) => mk(st.buffer, st.gain))
    : d.buffer ? [mk(d.buffer, d.srcBus)] : [];
  // Park on a NATURAL end (not our stop/restart, not a loop). Stems end together,
  // so watch the first source.
  const ender = d.srcs[0];
  if (ender) ender.onended = () => {
    if (d.srcs[0] === ender && !d.loopActive) {
      stopSource(d);
      d.playing = false;
      d.startOffset = deckDuration(d);
      emit();
    }
  };
  d.startCtxTime = ctx.currentTime;
  d.startOffset = start;
  d.playing = true;
}

function statusOf(id: DeckId): DeckStatus {
  const d = decks[id];
  if (!d) {
    return {
      loadedUrl: null, label: null, playing: false, decoding: false, hasBuffer: false,
      currentTime: 0, duration: 0, loopActive: false, loopIn: null, loopOut: null,
      slip: false, pitchPct: 0, keylock: false, stems: [], stemLevels: {},
    };
  }
  return {
    loadedUrl: d.loadedUrl,
    label: d.label,
    playing: d.playing,
    decoding: d.decoding,
    hasBuffer: !!d.buffer || (d.stemMode && !!d.stems?.length),
    // During a scratch the worklet drives playback, so the read-head it
    // reports (vinylPos) is the true position for the platter + waveform.
    currentTime: d.vinylActive ? clamp(d.vinylPos, 0, deckDuration(d)) : audiblePos(d),
    duration: deckDuration(d),
    loopActive: d.loopActive,
    loopIn: d.loopActive ? d.loopIn : null,
    loopOut: d.loopActive ? d.loopOut : null,
    slip: d.slip,
    pitchPct: d.pitchPct,
    keylock: d.keylock,
    stems: d.stems?.map((s) => s.name) ?? [],
    stemLevels: Object.fromEntries((d.stems ?? []).map((s) => [s.name, s.level])),
  };
}

function emit(): void {
  const a = statusOf('A');
  const b = statusOf('B');
  for (const cb of listeners) cb(a, b);
  const anyPlaying = a.playing || b.playing;
  if (anyPlaying && !rafId) rafId = requestAnimationFrame(tick);
  if (!anyPlaying && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function tick(): void {
  const a = statusOf('A');
  const b = statusOf('B');
  for (const cb of listeners) cb(a, b);
  if (a.playing || b.playing) rafId = requestAnimationFrame(tick);
  else rafId = 0;
}

/* -------------------------------- public API ------------------------------- */

/** Subscribe to deck-status changes (transport + ~rAF time while playing).
 *  Fires immediately with current status. Returns an unsubscribe. */
export function subscribe(cb: (a: DeckStatus, b: DeckStatus) => void): () => void {
  listeners.add(cb);
  cb(statusOf('A'), statusOf('B'));
  return () => { listeners.delete(cb); };
}

export function getStatus(id: DeckId): DeckStatus {
  return statusOf(id);
}

/** Load a track URL into a deck: fetch + decode to an AudioBuffer (frees the
 *  prior one). Pass null to clear + free. */
export async function loadDeck(id: DeckId, url: string | null, label: string | null): Promise<void> {
  const d = getDeck(id);
  stopSource(d);
  teardownStems(d); // the previous track's stems no longer apply
  d.playing = false;
  d.startOffset = 0;
  d.loopActive = false;
  d.rollResume = false;

  if (!url) {
    d.buffer = null; // free decoded audio
    d.loadedUrl = null;
    d.label = null;
    d.decoding = false;
    emit();
    return;
  }

  d.loadedUrl = url;
  d.label = label;
  d.buffer = null;
  d.decoding = true;
  emit();

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const arr = await resp.arrayBuffer();
    const ctx = getEngineCtx();
    const buf = await ctx.decodeAudioData(arr);
    // Guard: the deck may have been re-loaded with a different track meanwhile.
    if (d.loadedUrl !== url) return;
    d.buffer = buf;
    d.startOffset = 0;
  } catch (e) {
    if (d.loadedUrl === url) d.buffer = null;
    logError('dj', `Deck ${id} load failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (d.loadedUrl === url) d.decoding = false;
  }
  emit();
}

export function playDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode) || d.playing) return;
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* retry next gesture */ });
  startSource(d, d.startOffset);
  emit();
}

export function pauseDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || !d.playing) return;
  const pos = audiblePos(d);
  stopSource(d);
  d.playing = false;
  d.startOffset = pos;
  emit();
}

/** Stop transport and return the deck to the beginning. */
export function stopDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode)) return;
  stopSource(d);
  d.playing = false;
  d.startOffset = 0;
  d.loopActive = false;
  d.rollResume = false;
  emit();
}

export function toggleDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode)) return;
  if (d.playing) pauseDeck(id);
  else playDeck(id);
}

/** Cue back to the start (keeps playing if it was). */
export function cueDeck(id: DeckId): void {
  seekDeck(id, 0);
}

export function seekDeck(id: DeckId, sec: number): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode) || !Number.isFinite(sec)) return;
  const pos = clamp(sec, 0, deckDuration(d));
  if (d.playing) startSource(d, pos);
  else d.startOffset = pos;
  emit();
}

/** Turntable pitch in percent (±). Drives playbackRate (speed+pitch together). */
export function setDeckPitch(id: DeckId, pct: number): void {
  const d = getDeck(id);
  const rate = clamp(1 + pct / 100, 0.25, 4);
  if (d.playing) {
    // Re-anchor the position + slip clocks so they stay continuous at the new rate.
    const pos = audiblePos(d);
    if (d.loopActive) {
      const vp = virtualPos(d);
      d.virtualBase = vp;
      d.virtualStart = ctxNow();
    }
    d.startOffset = pos;
    d.startCtxTime = ctxNow();
    for (const s of d.srcs) s.playbackRate.setValueAtTime(rate, ctxNow());
  }
  d.rate = rate;
  d.pitchPct = pct;
  // Key-lock: cancel the speed-induced pitch change so only tempo moves.
  applyKeylockPitch(d);
}

const _stretchPending: Partial<Record<DeckId, boolean>> = {};

/** Key-lock / master tempo: speed changes (pitch fader / SYNC) keep the original
 *  pitch. Inserts a Signalsmith Stretch node as a live pitch corrector; bypassed
 *  when off. Async because the worklet + WASM load lazily on first enable. */
export async function setDeckKeylock(id: DeckId, on: boolean): Promise<void> {
  const d = getDeck(id);
  if (d.keylock === on) return;

  if (on && !d.stretch && !_stretchPending[id]) {
    _stretchPending[id] = true;
    try {
      // Lazy-load the WASM stretcher only when key-lock is first enabled, so its
      // ~100 KB (embedded WASM) never weighs down initial load for users who
      // don't use it. Cached by the bundler after the first import.
      const { default: SignalsmithStretch } = await import('signalsmith-stretch');
      const node = await SignalsmithStretch(getEngineCtx());
      node.connect(d.delayComp);
      d.stretch = node;
      try {
        d.stretchLatency = await node.latency();
      } catch {
        d.stretchLatency = 0;
      }
    } catch (e) {
      logError('dj', `Deck ${id} key-lock unavailable: ${e instanceof Error ? e.message : String(e)}`);
      _stretchPending[id] = false;
      return; // leave key-lock off; turntable mode still works
    }
    _stretchPending[id] = false;
  }
  if (on && !d.stretch) return; // creation lost a race / failed

  d.keylock = on;
  if (on && d.stretch) {
    void d.stretch.start();
    applyKeylockPitch(d);
  } else if (!on && d.stretch) {
    void d.stretch.stop(); // idle the worklet so it costs ~0 CPU while bypassed
  }
  updateLatencyComp();
  // Route the source bus through (or around) the stretch insert — no restart needed
  // (works for both full-track and live-stem sources, which all feed srcBus).
  try { d.srcBus.disconnect(); } catch { /* not connected */ }
  d.srcBus.connect(deckInputNode(d));
  emit();
}

export function setDeckEq(id: DeckId, band: 'low' | 'mid' | 'high', db: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const node = band === 'low' ? d.low : band === 'mid' ? d.mid : d.high;
  node.gain.setTargetAtTime(clamp(db, -24, 24), ctx.currentTime, RAMP_TC);
}

/** Auto-gain / leveling trim in dB (independent of the crossfader). 0 = unity. */
export function setDeckTrim(id: DeckId, db: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const lin = Math.pow(10, clamp(db, -15, 15) / 20);
  d.trim.gain.setTargetAtTime(lin, ctx.currentTime, RAMP_TC);
}

/** Channel volume fader (linear, 0..1). 1 = unity. */
export function setDeckVolume(id: DeckId, level: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  d.vol.gain.setTargetAtTime(clamp(level, 0, 1), ctx.currentTime, RAMP_TC);
}

/** Single-knob DJ filter. amount in [-1, 1]: 0 = bypass (flat), <0 sweeps a
 *  lowpass down toward 200 Hz, >0 sweeps a highpass up toward 8 kHz. Resonance
 *  rises with travel for the classic filter "bite". */
export function setDeckFilter(id: DeckId, amount: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const a = clamp(amount, -1, 1);
  const f = d.filter;
  const now = ctx.currentTime;
  if (Math.abs(a) < 0.02) {
    f.type = 'allpass';
    f.frequency.setTargetAtTime(1000, now, RAMP_TC);
    f.Q.setTargetAtTime(0.0001, now, RAMP_TC);
  } else if (a < 0) {
    f.type = 'lowpass';
    f.frequency.setTargetAtTime(20000 * Math.pow(200 / 20000, -a), now, RAMP_TC);
    f.Q.setTargetAtTime(1 + -a * 6, now, RAMP_TC);
  } else {
    f.type = 'highpass';
    f.frequency.setTargetAtTime(20 * Math.pow(8000 / 20, a), now, RAMP_TC);
    f.Q.setTargetAtTime(1 + a * 6, now, RAMP_TC);
  }
}

/* -------------------------------- FX rack (D5) ----------------------------- */

/** A short decaying-noise impulse response for the reverb convolver — generated
 *  so we don't bundle an IR file. ~1.8 s, exponential decay. */
function makeReverbIR(ctx: BaseAudioContext, seconds = 1.8, decay = 3): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return ir;
}

/** Build the per-deck FX rack on first use and splice it into the chain between
 *  the filter and the crossfader gain: filter → fx.input → (dry + wet) → out → gain. */
function ensureDeckFx(d: Deck): DeckFx {
  if (d.fx) return d.fx;
  const ctx = getEngineCtx();
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1;
  input.connect(dry).connect(out);

  // Flanger: short modulated delay + feedback (comb sweep), summed via wet.
  const flDelay = ctx.createDelay(0.05); flDelay.delayTime.value = 0.003;
  const flFb = ctx.createGain(); flFb.gain.value = 0.35;
  const flDepth = ctx.createGain(); flDepth.gain.value = 0.002;
  const lfoFlanger = ctx.createOscillator(); lfoFlanger.type = 'sine'; lfoFlanger.frequency.value = 0.2;
  lfoFlanger.connect(flDepth).connect(flDelay.delayTime);
  input.connect(flDelay);
  flDelay.connect(flFb).connect(flDelay);
  const flangerWet = ctx.createGain(); flangerWet.gain.value = 0;
  flDelay.connect(flangerWet).connect(out);

  // Wah: LFO-swept resonant bandpass.
  const wahBp = ctx.createBiquadFilter(); wahBp.type = 'bandpass'; wahBp.frequency.value = 800; wahBp.Q.value = 5;
  const wahDepth = ctx.createGain(); wahDepth.gain.value = 600;
  const lfoWah = ctx.createOscillator(); lfoWah.type = 'sine'; lfoWah.frequency.value = 1.2;
  lfoWah.connect(wahDepth).connect(wahBp.frequency);
  input.connect(wahBp);
  const wahWet = ctx.createGain(); wahWet.gain.value = 0;
  wahBp.connect(wahWet).connect(out);

  // Reverb: convolver with a generated IR.
  const conv = ctx.createConvolver(); conv.buffer = makeReverbIR(ctx);
  const reverbWet = ctx.createGain(); reverbWet.gain.value = 0;
  input.connect(conv).connect(reverbWet).connect(out);

  // Splice between the filter and the crossfader gain (one-time; a brief click
  // is possible if done mid-playback — acceptable for a first FX-knob touch).
  try { d.filter.disconnect(d.gain); } catch { /* not connected */ } // keep the filter → cueSend tap
  d.filter.connect(input);
  out.connect(d.gain);

  lfoFlanger.start();
  lfoWah.start();
  const fx: DeckFx = {
    input, out, flangerWet, reverbWet, wahWet, lfoFlanger, lfoWah,
    nodes: [input, out, dry, flDelay, flFb, flDepth, flangerWet, wahBp, wahDepth, wahWet, conv, reverbWet],
  };
  d.fx = fx;
  return fx;
}

/** Set a per-deck FX wet amount in [0, 1] (0 = off). Builds the FX rack lazily. */
export function setDeckFx(id: DeckId, fx: DjFx, amount: number): void {
  const d = getDeck(id);
  const f = ensureDeckFx(d);
  const ctx = getEngineCtx();
  const a = clamp(amount, 0, 1);
  const wet = fx === 'flanger' ? f.flangerWet : fx === 'reverb' ? f.reverbWet : f.wahWet;
  const scale = fx === 'reverb' ? 0.6 : 0.8; // keep a full twist musical, not overpowering
  wet.gain.setTargetAtTime(a * scale, ctx.currentTime, RAMP_TC);
}

/** Master brickwall limiter on the DJ bus (clip safety). On by default. */
export function setLimiter(on: boolean): void {
  limiterEnabled = on;
  ensureMaster();
  if (!djMaster || !limiter) return;
  try { djMaster.disconnect(); } catch { /* gone */ }
  djMaster.connect(on ? limiter : getMasterGain());
}

export function getLimiter(): boolean {
  return limiterEnabled;
}

/* -------------------------------- cue / headphones (D6) -------------------- */

/** Whether the runtime supports per-element output routing (`setSinkId`). */
export function isCueSupported(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

/** Pre-listen a deck in the cue (headphone) bus — independent of the crossfader. */
export function setDeckCue(id: DeckId, on: boolean): void {
  const d = getDeck(id);
  ensureCueBus();
  d.cueSend.gain.setTargetAtTime(on ? 1 : 0, ctxNow(), RAMP_TC);
  if (on && cueAudioEl) void cueAudioEl.play().catch(() => { /* needs a gesture — the toggle click is one */ });
}

/** Route the cue bus to a specific output device (headphones). '' = default. */
export async function setCueSinkId(deviceId: string): Promise<void> {
  ensureCueBus();
  cueSinkId = deviceId;
  const el = cueAudioEl as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
  if (el?.setSinkId) {
    try { await el.setSinkId(deviceId); } catch (e) { logError('dj', `cue setSinkId failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

export function getCueSinkId(): string {
  return cueSinkId;
}

/* -------------------------------- sampler bank (D7) ------------------------ */

/** Load a one-shot sample into a pad (decode the URL to a buffer). */
export async function loadSample(padId: string, url: string): Promise<void> {
  const ctx = getEngineCtx();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`sample fetch ${r.status}`);
  samples.set(padId, await ctx.decodeAudioData(await r.arrayBuffer()));
}

// Live sampler voices per pad (so loops can stop + choke groups can cut).
const sampleVoices = new Map<string, AudioBufferSourceNode[]>();
// Pads currently set to choke (mutually exclusive): firing one cuts the others.
const chokePads = new Set<string>();

export interface TriggerOpts { gain?: number; loop?: boolean; choke?: boolean }

/** Fire a pad's sample through the DJ master. One-shot by default (polyphonic);
 *  a `loop` pad toggles (re-trigger stops it); a `choke` pad cuts every other
 *  choke pad first (monophonic group, e.g. open/closed hat). `gain` is 0..1. */
export function triggerSample(padId: string, opts: TriggerOpts = {}): void {
  const buf = samples.get(padId);
  if (!buf) return;
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* retry next gesture */ });

  // A looping pad that's already playing stops on the next press.
  if (opts.loop && (sampleVoices.get(padId)?.length ?? 0) > 0) { stopSample(padId); return; }

  // Choke: cut every OTHER choke pad's voices before firing this one.
  if (opts.choke) {
    chokePads.add(padId);
    for (const id of chokePads) if (id !== padId) stopSample(id);
  } else {
    chokePads.delete(padId);
  }

  const g = ctx.createGain();
  g.gain.value = clamp(opts.gain ?? 1, 0, 1);
  g.connect(ensureSamplerGain());
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = !!opts.loop;
  s.connect(g);
  const arr = sampleVoices.get(padId) ?? [];
  arr.push(s);
  sampleVoices.set(padId, arr);
  s.onended = () => {
    try { s.disconnect(); g.disconnect(); } catch { /* gone */ }
    const live = sampleVoices.get(padId);
    if (live) { const i = live.indexOf(s); if (i >= 0) live.splice(i, 1); }
  };
  s.start();
}

/** Stop a pad's currently-playing voices (loops, or a long one-shot). */
export function stopSample(padId: string): void {
  const arr = sampleVoices.get(padId);
  if (!arr) return;
  for (const s of [...arr]) { try { s.stop(); } catch { /* already ended */ } }
  sampleVoices.set(padId, []);
}

/** True if a pad has any voice currently sounding (used for loop pad lit state). */
export function sampleIsPlaying(padId: string): boolean {
  return (sampleVoices.get(padId)?.length ?? 0) > 0;
}

export function clearSample(padId: string): void {
  stopSample(padId);
  chokePads.delete(padId);
  samples.delete(padId);
}
export function hasSample(padId: string): boolean { return samples.has(padId); }

/** Crossfader position in [-1, 1] (equal-power). */
export function setCrossfade(x: number): void {
  crossfade = clamp(x, -1, 1);
  const ctx = getEngineCtx();
  const { a, b } = crossGains(crossfade);
  const da = decks['A'];
  const db = decks['B'];
  if (da) da.gain.gain.setTargetAtTime(a, ctx.currentTime, RAMP_TC);
  if (db) db.gain.gain.setTargetAtTime(b, ctx.currentTime, RAMP_TC);
}

export function getCrossfade(): number {
  return crossfade;
}

/* -------------------------- loops / slip / roll ---------------------------- */

function engageLoop(d: Deck, inSec: number, outSec: number, roll: boolean): void {
  const dur = deckDuration(d);
  const lin = clamp(inSec, 0, dur);
  const lout = clamp(outSec, lin + 0.02, dur); // keep a sane minimum span
  // Capture the audible position BEFORE engaging the loop (so it isn't wrapped).
  const cur = audiblePos(d);
  d.virtualBase = cur;
  d.virtualStart = ctxNow();
  d.loopIn = lin;
  d.loopOut = lout;
  d.loopActive = true;
  d.rollResume = roll;
  if (d.playing) {
    // Make sure the loop actually engages: if the head is outside the region
    // (e.g. a short beat-loop whose out-point is already behind us), jump to
    // the in-point so playback loops instead of running straight past loopEnd.
    const startAt = cur >= lin && cur < lout ? cur : lin;
    startSource(d, startAt); // restart with native loop bounds
  }
  emit();
}

/** Engage a sustained loop between two times (sec). */
export function setLoop(id: DeckId, inSec: number, outSec: number): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode)) return;
  engageLoop(d, inSec, outSec, false);
}

/** Engage a momentary loop-roll of `lengthSec` from the current position.
 *  Always slip-resumes on end (jumps to where playback would have reached). */
export function startLoopRoll(id: DeckId, lengthSec: number): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode) || lengthSec <= 0) return;
  const inPt = audiblePos(d);
  engageLoop(d, inPt, inPt + lengthSec, true);
}

export function endLoopRoll(id: DeckId): void {
  exitLoop(id);
}

/** Disengage the loop. Slip-aware: with slip on (or a loop-roll), resume where
 *  playback would be; otherwise continue from the current looped position. */
export function exitLoop(id: DeckId): void {
  const d = decks[id];
  if (!d || !d.loopActive) return;
  const resumeSlip = d.slip || d.rollResume;
  const resumePos = resumeSlip ? virtualPos(d) : audiblePos(d);
  d.loopActive = false;
  d.rollResume = false;
  if (d.playing) startSource(d, resumePos);
  else d.startOffset = resumePos;
  emit();
}

export function setSlip(id: DeckId, on: boolean): void {
  const d = getDeck(id);
  d.slip = on;
  emit();
}

export function isLooping(id: DeckId): boolean {
  return !!decks[id]?.loopActive;
}

/* -------------------------------- live stems (D4) -------------------------- */

function teardownStems(d: Deck): void {
  if (d.stems) for (const st of d.stems) { try { st.gain.disconnect(); } catch { /* gone */ } }
  d.stems = null;
  d.stemMode = false;
}

/** Load N separated stems onto a deck and switch it to stem mode: each stem
 *  plays in lock-step through its own gain (the live faders) summed at srcBus.
 *  Frees the full-track buffer (stems are the playback source now). D4 Tier 1 —
 *  the stems must already be separated + cached; `url` = /api/library/stems/…/audio.
 *  Returns the loaded stem names. */
export async function loadDeckStems(id: DeckId, stems: Array<{ name: string; url: string }>): Promise<string[]> {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const decoded = await Promise.all(stems.map(async (s) => {
    const r = await fetch(s.url);
    if (!r.ok) throw new Error(`stem "${s.name}" fetch ${r.status}`);
    return { name: s.name, buffer: await ctx.decodeAudioData(await r.arrayBuffer()) };
  }));
  if (decoded.length === 0) return [];
  const wasPlaying = d.playing;
  const pos = audiblePos(d);
  stopSource(d);
  teardownStems(d);
  d.stems = decoded.map(({ name, buffer }) => {
    const g = ctx.createGain();
    g.gain.value = 1;
    g.connect(d.srcBus);
    return { name, buffer, gain: g, level: 1 };
  });
  d.stemMode = true;
  d.buffer = null; // stems replace the full buffer for playback (frees ~85 MB)
  const dur = deckDuration(d);
  if (wasPlaying) startSource(d, clamp(pos, 0, dur));
  else d.startOffset = clamp(pos, 0, dur);
  emit();
  return d.stems.map((s) => s.name);
}

/** Turn stem mode OFF: reload the full-track buffer from the deck's loadedUrl
 *  and restore single-source playback, preserving the playhead. The inverse of
 *  loadDeckStems (which freed the full buffer to play stems). No-op off stems. */
export async function unloadDeckStems(id: DeckId): Promise<void> {
  const d = decks[id];
  if (!d || !d.stemMode) return;
  const url = d.loadedUrl;
  const wasPlaying = d.playing;
  const pos = audiblePos(d);
  if (!url) {
    // Nothing to restore — just drop stem mode (deck goes silent until reload).
    stopSource(d);
    teardownStems(d);
    emit();
    return;
  }
  d.decoding = true;
  emit();
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const buf = await getEngineCtx().decodeAudioData(await resp.arrayBuffer());
    if (d.loadedUrl !== url) return; // re-loaded with a different track meanwhile
    stopSource(d);
    teardownStems(d);
    d.buffer = buf;
    const dur = deckDuration(d);
    if (wasPlaying) startSource(d, clamp(pos, 0, dur));
    else d.startOffset = clamp(pos, 0, dur);
  } catch (e) {
    logError('dj', `Deck ${id} stem-off reload failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (d.loadedUrl === url) d.decoding = false;
  }
  emit();
}

/** Set a stem's live gain (0..1). 0 = pulled out (e.g. mute the vocals). */
export function setStemGain(id: DeckId, name: string, level: number): void {
  const st = decks[id]?.stems?.find((s) => s.name === name);
  if (!st) return;
  const next = clamp(level, 0, 1);
  if (Math.abs(st.level - next) < 0.0001) return;
  st.level = next;
  st.gain.gain.setTargetAtTime(st.level, ctxNow(), RAMP_TC);
  emit();
}

export function getStemGain(id: DeckId, name: string): number {
  return decks[id]?.stems?.find((s) => s.name === name)?.level ?? 0;
}

export function getDeckStemNames(id: DeckId): string[] {
  return decks[id]?.stems?.map((s) => s.name) ?? [];
}

export function hasStems(id: DeckId): boolean {
  return !!decks[id]?.stemMode;
}

/* -------------------------------- vinyl / scratch (jog) -------------------- */

let _vinylModule: Promise<void> | null = null;
let _scratchMode: 'classic' | 'cyber' = 'classic';

function ensureVinylModule(ctx: AudioContext): Promise<void> {
  if (!_vinylModule) {
    _vinylModule = ctx.audioWorklet.addModule('/vinyl-scratch.worklet.js').catch((e) => {
      _vinylModule = null; // allow a later retry
      throw e;
    });
  }
  return _vinylModule;
}

/** Scratch character for all decks: 'classic' (clean turntable) or 'cyber'
 *  (fragmented, bit-crushed glitch). Pushed live to any active vinyl node. */
export function setScratchMode(mode: 'classic' | 'cyber'): void {
  _scratchMode = mode;
  for (const id of ['A', 'B'] as DeckId[]) {
    decks[id]?.vinyl?.port.postMessage({ type: 'mode', mode });
  }
}
export function getScratchMode(): 'classic' | 'cyber' {
  return _scratchMode;
}

/** True when a deck can scratch: it needs a decoded full-track buffer. Stem
 *  mode and empty decks fall back to plain jog-seek. */
export function canScratch(id: DeckId): boolean {
  const d = decks[id];
  return !!d && !!d.buffer && !d.stemMode;
}

/** Grab the platter: hand playback to the scratch worklet at the current
 *  position. The jog then drives velocity via setVinylVelocity; release spins
 *  up and hands back to the normal source (exitVinyl). */
export async function enterVinyl(id: DeckId): Promise<boolean> {
  const d = decks[id];
  if (!d || !d.buffer || d.stemMode || d.vinylActive) return false;
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* retry next gesture */ });
  try {
    await ensureVinylModule(ctx);
  } catch (e) {
    logError('dj', `Deck ${id} scratch unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  // The deck may have been re-loaded / gone to stems while the module loaded.
  if (!d.buffer || d.stemMode || d.vinylActive) return false;
  if (d.vinyl == null) {
    d.vinyl = new AudioWorkletNode(ctx, 'vinyl-scratch', { numberOfInputs: 0, outputChannelCount: [2] });
    d.vinyl.port.onmessage = (e) => { if (e.data?.type === 'pos') d.vinylPos = e.data.sec; };
  }
  // (Re)load the track's samples into the worklet when the track changed.
  if (d.vinylLoadedUrl !== d.loadedUrl) {
    const mono = d.buffer.numberOfChannels <= 1;
    const lc = new Float32Array(d.buffer.getChannelData(0));
    const rc = mono ? lc : new Float32Array(d.buffer.getChannelData(1));
    d.vinyl.port.postMessage(
      { type: 'load', l: lc, r: rc, len: d.buffer.length },
      mono ? [lc.buffer] : [lc.buffer, rc.buffer],
    );
    d.vinylLoadedUrl = d.loadedUrl;
  }
  const pos = audiblePos(d);
  d.vinylWasPlaying = d.playing;
  d.vinylPos = pos;
  stopSource(d); // silence the normal source; the worklet sounds now
  d.vinyl.port.postMessage({ type: 'mode', mode: _scratchMode });
  d.vinyl.port.postMessage({ type: 'pos', sec: pos });
  d.vinyl.port.postMessage({ type: 'vel', vel: d.vinylWasPlaying ? d.rate : 0, immediate: true });
  d.vinyl.port.postMessage({ type: 'ease', ease: 0.4 });
  d.vinyl.port.postMessage({ type: 'play', on: true });
  // Feed straight into delayComp so it rides EQ/filter/crossfader but bypasses
  // the key-lock stretch (a scratch must be allowed to pitch-bend).
  try { d.vinyl.connect(d.delayComp); } catch { /* already connected */ }
  d.vinylActive = true;
  d.playing = true;
  emit();
  return true;
}

/** Drive scratch velocity from the jog: 1 = normal forward, -1 = reverse, 0 =
 *  stopped. `ease` is high for hand scratches (snappy) and low for the
 *  wind-down / spin-up ramps. */
export function setVinylVelocity(id: DeckId, vel: number, ease = 0.4): void {
  const d = decks[id];
  if (!d?.vinyl || !d.vinylActive) return;
  d.vinyl.port.postMessage({ type: 'ease', ease });
  d.vinyl.port.postMessage({ type: 'vel', vel });
}

/** Release the platter: spin back up to speed (if it was playing) then hand
 *  playback back to the normal source at the read-head. `spinUp=false` settles
 *  immediately. */
export function exitVinyl(id: DeckId, spinUp = true): void {
  const d = decks[id];
  if (!d?.vinyl || !d.vinylActive) return;
  const finalize = () => {
    const dd = decks[id];
    if (!dd?.vinyl || !dd.vinylActive) return;
    const pos = clamp(dd.vinylPos, 0, deckDuration(dd));
    dd.vinyl.port.postMessage({ type: 'play', on: false });
    try { dd.vinyl.disconnect(); } catch { /* gone */ }
    dd.vinylActive = false;
    dd.startOffset = pos;
    if (dd.vinylWasPlaying) startSource(dd, pos);
    else dd.playing = false;
    emit();
  };
  if (spinUp && d.vinylWasPlaying) {
    setVinylVelocity(id, d.rate, 0.06); // slow ramp back to speed = spin-up
    setTimeout(finalize, 320);
  } else {
    setVinylVelocity(id, 0, 0.08); // wind down to a stop
    setTimeout(finalize, spinUp ? 240 : 0);
  }
}

/** Tear everything down (DJ tab unmount). Rarely called — the tab is warmed. */
export function dispose(): void {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  for (const id of ['A', 'B'] as DeckId[]) {
    const d = decks[id];
    if (!d) continue;
    try {
      stopSource(d);
      teardownStems(d);
      try { d.srcBus.disconnect(); } catch { /* gone */ }
      try { d.cueSend.disconnect(); } catch { /* gone */ }
      if (d.fx) {
        try { d.fx.lfoFlanger.stop(); } catch { /* gone */ }
        try { d.fx.lfoWah.stop(); } catch { /* gone */ }
        for (const n of d.fx.nodes) { try { n.disconnect(); } catch { /* gone */ } }
        d.fx = null;
      }
      if (d.stretch) { try { void d.stretch.stop(); } catch { /* gone */ } d.stretch.disconnect(); }
      d.delayComp.disconnect();
      d.trim.disconnect();
      d.vol.disconnect();
      d.low.disconnect();
      d.mid.disconnect();
      d.high.disconnect();
      d.filter.disconnect();
      d.gain.disconnect();
    } catch { /* already gone */ }
    d.buffer = null;
    d.stretch = null;
    delete decks[id];
  }
  if (limiter) { try { limiter.disconnect(); } catch { /* gone */ } limiter = null; }
  if (cueBus) { try { cueBus.disconnect(); } catch { /* gone */ } cueBus = null; }
  if (cueAudioEl) { try { cueAudioEl.pause(); cueAudioEl.srcObject = null; } catch { /* gone */ } cueAudioEl = null; }
  cueDest = null;
  if (samplerGain) { try { samplerGain.disconnect(); } catch { /* gone */ } samplerGain = null; }
  samples.clear();
  if (djMaster) { try { djMaster.disconnect(); } catch { /* gone */ } djMaster = null; }
  listeners.clear();
}
