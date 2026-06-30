/**
 * liveMixer — real-time multi-track playback for the EDIT timeline.
 *
 * Until now, pressing Play in the editor did an OFFLINE bounce (mix every clip
 * into one WAV, then play that WAV through the footer's <audio>). That meant a
 * per-track fader / pan / mute / solo only changed the mix on the NEXT play.
 *
 * This module instead schedules each clip as a live Web Audio node graph so
 * track volume / pan / mute / solo are audible MID-playback:
 *
 *     BufferSource ─▶ clipGain (fade in/out) ─▶ trackGain (volume, live)
 *                                                   └▶ panner (pan, live) ─▶ master
 *
 * trackGain + panner are shared per track and updated in place when the EDIT
 * (or SLIDE) faders move — that's the whole point. clipGain carries each clip's
 * fade envelope. Everything routes through the shared engine master → analyser
 * → destination, so the visualizer + HUD keep working.
 *
 * Transport: a rAF clock advances a virtual playhead off the AudioContext
 * clock and mirrors it into playerStore.currentTime (footer time) and
 * editorStore.playheadSec (the moving line). The footer is UNCHANGED — it calls
 * the usual playerStore transport methods, which delegate here while a live
 * editor session is registered (see playerStore.setLiveTransport).
 *
 * The OFFLINE bounce is kept as-is for export / commit / send-to-init — those
 * genuinely need a rendered file. liveMixer only replaces the live PREVIEW.
 *
 * Honesty / scope: live updates cover the MIXER params (volume/pan/mute/solo).
 * Structural clip edits (add/remove/split/move) made WHILE playing take effect
 * on the next play, same as a hardware mixer wouldn't re-cut tape mid-take.
 */
import {
  useEditorStore,
  sampleLane,
  automationTargetKey,
  type AudioClip,
  type EditorTrack,
  type AutomationTarget,
} from './editorStore';
import {
  usePlayerStore,
  getEngineCtx,
  getMasterGain,
  setLiveTransport,
} from './playerStore';
import { logError } from './logStore';
import {
  ensureSoundfontReady,
  isLiveSynthReady,
  liveNoteOn,
  liveNoteOff,
  liveAllNotesOff,
  useSoundfontStore,
} from '../lib/soundfontEngine';
import { buildEffectChain, teleportXYZ, SPATIAL_TELEPORT, type ChainHandle } from '../lib/rackEffects';
import { sliceChunks, type AudioChunk } from '../lib/audioAnalysis';
import type { ChainEntry } from './effectChainStore';

const DECODE_TIMEOUT_MS = 15000;
const EDITOR_ENTRY_ID = 'editor-timeline'; // reuse so existing footer/playhead wiring keeps working
const RAMP_TC = 0.015; // setTargetAtTime time-constant for click-free param moves

// Decoded buffers cached by Blob identity. A WeakMap means a clip's buffer is
// reclaimed once its Blob is gone, and an edited clip (new Blob) re-decodes.
const decodeCache = new WeakMap<Blob, AudioBuffer>();

// Onset-sliced chunks cached by Blob identity (for the spatializer Teleport mode),
// so the (cheap but non-trivial) analysis runs once per clip, not per play/seek.
const analysisCache = new WeakMap<Blob, AudioChunk[]>();

interface TrackNodes {
  /** Volume fader (manual OR automated). Split from mute/solo so a volume
   *  automation lane can own this param while mute/solo stay live. */
  gain: GainNode;
  /** Mute/solo factor (0 or 1), always driven live (never automated). */
  muteGain: GainNode;
  panner: StereoPannerNode;
  /** Per-track insert FX, spliced gain -> muteGain -> [fx] -> panner. */
  fx: ChainHandle;
  fxFullSig: string; // topology + params (skip no-op reconciles)
  fxTopoSig: string; // topology only (rebuild trigger)
}

// ---- live session state (module singletons; one editor timeline at a time) --
let trackNodes = new Map<string, TrackNodes>();
let sources: AudioBufferSourceNode[] = [];
let rafId = 0;
let startCtxTime = 0; // ctx.currentTime at the moment playback (re)started
let startOffsetSec = 0; // timeline position playback started from
let totalDur = 0;
let playing = false;
let playToken = 0; // guards against overlapping async play() calls
let unsubEditor: (() => void) | null = null;
let lastMixSig = '';
let lastTimePush = 0; // throttle playerStore.currentTime writes
let midiTimers: number[] = []; // setTimeout handles for scheduled MIDI note on/off
let liveMidiActive = false; // true while MIDI clips play via the live synth (vs their bounce)
let autoFxTimer = 0; // setInterval handle for the FX-param automation lookahead

// Session-local master bus + psychoacoustic insert rack. Every track's panner
// feeds masterBus; masterBus -> masterChain -> the shared engine master, so the
// EDIT rack processes ONLY the editor mix and never the library/DJ/sequencer
// audio that also routes through getMasterGain().
let masterBus: GainNode | null = null;
let masterChain: ChainHandle | null = null;
let lastMasterSig = '';     // topology only (rebuild trigger)
let lastMasterFullSig = ''; // topology + params (skip no-op ticks)

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Clamped manual fader value (the volume automation lane overrides this live). */
function volumeOf(t: EditorTrack): number {
  return clamp(t.volume, 0, 1);
}

/** Mute/solo gate: 0 when muted or hidden by an active solo, else 1. */
function muteSoloFactor(t: EditorTrack, anySolo: boolean): number {
  if (t.mute) return 0;
  if (anySolo && !t.solo) return 0;
  return 1;
}

/** Effective track gain honoring mute + (exclusive) solo (volume x gate). */
function effectiveVol(t: EditorTrack, anySolo: boolean): number {
  return volumeOf(t) * muteSoloFactor(t, anySolo);
}

/** Keys of native (vol/pan) targets that have an enabled automation lane, so the
 *  manual reconcile leaves those params to the scheduled envelope while playing. */
function automatedNativeKeys(): Set<string> {
  const keys = new Set<string>();
  for (const lane of useEditorStore.getState().automationLanes) {
    if (!lane.enabled) continue;
    const k = lane.target.kind;
    if (k === 'trackVolume' || k === 'trackPan') keys.add(automationTargetKey(lane.target));
  }
  return keys;
}

/** A short signature of just the mixer-relevant fields, so the editorStore
 *  subscription (which also fires on every playhead tick) only pushes live
 *  node updates when a fader/pan/mute/solo actually moved. */
function mixSignature(tracks: EditorTrack[]): string {
  let s = '';
  for (const t of tracks) s += `${t.id}:${t.volume}:${t.pan}:${t.mute}:${t.solo}|`;
  return s;
}

/** Push current track volume/pan/mute/solo onto the live nodes (click-free).
 *  Volume and pan are left to their scheduled envelope when an enabled lane owns
 *  them; the mute/solo gate is always applied live. */
function applyMixLive(): void {
  const ctx = getEngineCtx();
  const tracks = useEditorStore.getState().tracks;
  const anySolo = tracks.some((t) => t.solo);
  const automated = automatedNativeKeys();
  for (const t of tracks) {
    const n = trackNodes.get(t.id);
    if (!n) continue;
    const volKey = automationTargetKey({ kind: 'trackVolume', trackId: t.id });
    const panKey = automationTargetKey({ kind: 'trackPan', trackId: t.id });
    if (!automated.has(volKey)) n.gain.gain.setTargetAtTime(volumeOf(t), ctx.currentTime, RAMP_TC);
    n.muteGain.gain.setTargetAtTime(muteSoloFactor(t, anySolo), ctx.currentTime, RAMP_TC);
    if (!automated.has(panKey)) n.panner.pan.setTargetAtTime(clamp(t.pan, -1, 1), ctx.currentTime, RAMP_TC);
  }
}

/** Decode every clip's blob we'll need (cached by Blob identity). */
async function ensureDecoded(clips: AudioClip[]): Promise<void> {
  const ctx = getEngineCtx();
  for (const clip of clips) {
    if (decodeCache.has(clip.audioBlob)) continue;
    const ab = await clip.audioBlob.arrayBuffer();
    const decoded = await Promise.race([
      ctx.decodeAudioData(ab.slice(0)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS),
      ),
    ]);
    decodeCache.set(clip.audioBlob, decoded);
  }
}

/** Topology signature of an FX chain (order + effect + enabled), so the store
 *  subscription rebuilds the node graph only when the topology changes, and
 *  pushes param-only edits without a rebuild. */
function chainTopoSig(chain: ChainEntry[]): string {
  let s = '';
  for (const e of chain) s += `${e.id}:${e.effect}:${e.enabled ? 1 : 0}|`;
  return s;
}

/** (Re)build the session-local master bus + insert rack and route it into the
 *  shared engine master. Safe to call repeatedly (tears down the prior one). */
function buildMasterBus(): void {
  const ctx = getEngineCtx();
  if (masterChain) { masterChain.dispose(); masterChain = null; }
  if (masterBus) { try { masterBus.disconnect(); } catch { /* gone */ } masterBus = null; }
  masterBus = ctx.createGain();
  const chain = useEditorStore.getState().masterFxChain;
  masterChain = buildEffectChain(ctx, masterBus, getMasterGain(), chain);
  lastMasterSig = chainTopoSig(chain);
  lastMasterFullSig = JSON.stringify(chain);
}

/** Reconcile the live master rack with the store: rebuild on topology change,
 *  otherwise push each entry's params live. Cheap no-op when nothing changed
 *  (this runs on every store tick, including the 60 Hz playhead). */
function applyMasterChainLive(): void {
  if (!masterChain) return;
  const chain = useEditorStore.getState().masterFxChain;
  const full = JSON.stringify(chain);
  if (full === lastMasterFullSig) return;
  lastMasterFullSig = full;
  const sig = chainTopoSig(chain);
  if (sig !== lastMasterSig) {
    lastMasterSig = sig;
    masterChain.rebuild(chain);
  } else {
    for (const e of chain) masterChain.updateParams(e.id, e.params);
  }
}

/** Reconcile each track's live insert chain with the store (rebuild on topology
 *  change, push params otherwise). Runs on every store tick while playing. */
function applyTrackChainsLive(): void {
  const tracks = useEditorStore.getState().tracks;
  const byId = new Map<string, EditorTrack>(tracks.map((t): [string, EditorTrack] => [t.id, t]));
  for (const [id, n] of trackNodes) {
    const chain = byId.get(id)?.fxChain ?? [];
    const full = JSON.stringify(chain);
    if (full === n.fxFullSig) continue;
    n.fxFullSig = full;
    const topo = chainTopoSig(chain);
    if (topo !== n.fxTopoSig) { n.fxTopoSig = topo; n.fx.rebuild(chain); }
    else for (const e of chain) n.fx.updateParams(e.id, e.params);
  }
}

/** Dispose every track's FX handle + nodes (oscillators in some effects must be
 *  stopped explicitly). Leaves the trackNodes map for the caller to replace. */
function disposeTrackNodes(): void {
  for (const n of trackNodes.values()) {
    try { n.fx.dispose(); n.gain.disconnect(); n.muteGain.disconnect(); n.panner.disconnect(); } catch { /* gone */ }
  }
}

/** Build (or rebuild) per track: gain -> [insert FX] -> panner -> master bus.
 *  Panners feed the session master bus (built first), not the engine master. */
function buildTrackNodes(tracks: EditorTrack[]): void {
  const ctx = getEngineCtx();
  const dest: AudioNode = masterBus ?? getMasterGain();
  disposeTrackNodes();
  trackNodes = new Map();
  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    const gain = ctx.createGain();
    gain.gain.value = volumeOf(t);
    const muteGain = ctx.createGain();
    muteGain.gain.value = muteSoloFactor(t, anySolo);
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(t.pan, -1, 1);
    const chain = t.fxChain ?? [];
    gain.connect(muteGain);
    const fx = buildEffectChain(ctx, muteGain, panner, chain); // gain -> muteGain -> [fx] -> panner
    panner.connect(dest);
    trackNodes.set(t.id, {
      gain,
      muteGain,
      panner,
      fx,
      fxFullSig: JSON.stringify(chain),
      fxTopoSig: chainTopoSig(chain),
    });
  }
}

/** A MIDI clip = a piano-roll clip carrying its editable notes. */
function isMidiClip(clip: AudioClip): boolean {
  return clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll && clip.sourcePianoRoll.length > 0;
}

/** Schedule every clip that is at or after `fromSec` (or straddling it). */
function scheduleClips(clips: AudioClip[], fromSec: number): void {
  const ctx = getEngineCtx();
  const now = ctx.currentTime;
  sources = [];
  for (const clip of clips) {
    // When the live synth drives MIDI, skip the clip's bounced audio so we don't
    // double up; scheduleMidiClips plays its notes instead.
    if (liveMidiActive && isMidiClip(clip)) continue;
    const nodes = trackNodes.get(clip.trackId);
    if (!nodes) continue;
    const buf = decodeCache.get(clip.audioBlob);
    if (!buf) continue;

    const safeOffset = Math.min(clip.offsetIntoSource, Math.max(0, buf.duration - 0.01));
    const safeDur = Math.min(clip.durationSec, buf.duration - safeOffset);
    if (safeDur <= 0) continue;

    const clipEndSec = clip.startSec + safeDur;
    if (clipEndSec <= fromSec) continue; // already finished before the start point

    // How far into this clip the playhead already is (0 if clip is in the future).
    const into = Math.max(0, fromSec - clip.startSec);
    const remaining = safeDur - into;
    if (remaining <= 0) continue;

    const clipStartCtx = now + (clip.startSec - fromSec); // may be < now when straddling
    const when = Math.max(now, clipStartCtx);

    // Per-clip fade envelope on a dedicated gain (track volume lives on trackGain).
    const clipGain = ctx.createGain();
    const fadeIn = clip.fadeInSec ?? 0;
    const fadeOut = clip.fadeOutSec ?? 0;
    const g = clipGain.gain;
    if (clipStartCtx >= now) {
      // Clip begins in the future — full envelope.
      g.setValueAtTime(fadeIn > 0 ? 0 : 1, when);
      if (fadeIn > 0) g.linearRampToValueAtTime(1, when + Math.min(fadeIn, safeDur));
    } else {
      // Starting mid-clip — set the current envelope value now.
      const cur = fadeIn > 0 && into < fadeIn ? into / fadeIn : 1;
      g.setValueAtTime(cur, now);
      if (fadeIn > 0 && into < fadeIn) g.linearRampToValueAtTime(1, clipStartCtx + fadeIn);
    }
    if (fadeOut > 0) {
      const foStartCtx = clipStartCtx + safeDur - Math.min(fadeOut, safeDur);
      if (foStartCtx > now) g.setValueAtTime(1, foStartCtx);
      g.linearRampToValueAtTime(0, clipStartCtx + safeDur);
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(clipGain).connect(nodes.gain);
    src.start(when, safeOffset + into, remaining);
    src.onended = () => {
      try { src.disconnect(); clipGain.disconnect(); } catch { /* already gone */ }
    };
    sources.push(src);
  }
}

/** Onset-sliced chunks for a clip's decoded buffer (cached by Blob identity). */
function chunksFor(clip: AudioClip): AudioChunk[] {
  const buf = decodeCache.get(clip.audioBlob);
  if (!buf) return [];
  let chunks = analysisCache.get(clip.audioBlob);
  if (!chunks) {
    chunks = sliceChunks(buf);
    analysisCache.set(clip.audioBlob, chunks);
  }
  return chunks;
}

/**
 * For every track whose spatializer is in Teleport mode, slice that track's clips
 * on their onsets and schedule one panner jump per chunk — the position comes from
 * the chunk's loudness (closer when louder) and brightness (higher when brighter),
 * spread by the effect's Depth. Runs after scheduleClips, on every (re)start; the
 * golden-angle index advances across passed chunks too, so a mid-timeline start
 * lands the same positions a from-zero play would.
 */
function scheduleTeleports(clips: AudioClip[], fromSec: number): void {
  const ctx = getEngineCtx();
  const now = ctx.currentTime;
  const tracks = useEditorStore.getState().tracks;
  for (const t of tracks) {
    const chain = t.fxChain ?? [];
    const teleEntries = chain.filter(
      (e) =>
        e.enabled &&
        e.effect === 'spatializer' &&
        Math.round(e.params?.motion ?? 0) === SPATIAL_TELEPORT,
    );
    if (teleEntries.length === 0) continue;
    const nodes = trackNodes.get(t.id);
    if (!nodes) continue;
    const insts = nodes.fx.instances();
    const trackClips = clips.filter(
      (c) => c.trackId === t.id && !(liveMidiActive && isMidiClip(c)),
    );

    for (const entry of teleEntries) {
      const li = insts.find((x) => x.id === entry.id);
      if (!li?.inst.scheduleTeleport) continue;
      const spread = entry.params?.motionDepth ?? 5;
      const events: { when: number; x: number; y: number; z: number }[] = [];
      let idx = 0;
      for (const clip of trackClips) {
        const buf = decodeCache.get(clip.audioBlob);
        if (!buf) continue;
        const offset = Math.min(clip.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const dur = Math.min(clip.durationSec, buf.duration - offset);
        if (dur <= 0) continue;
        for (const chunk of chunksFor(clip)) {
          if (chunk.tSec < offset || chunk.tSec >= offset + dur) continue;
          const timelineSec = clip.startSec + (chunk.tSec - offset);
          if (timelineSec < fromSec - 0.001) { idx += 1; continue; } // already passed
          const pos = teleportXYZ(idx, chunk.loudness, chunk.brightness, spread);
          const whenCtx = startCtxTime + (timelineSec - startOffsetSec);
          events.push({ when: Math.max(whenCtx, now), x: pos.x, y: pos.y, z: pos.z });
          idx += 1;
        }
      }
      if (events.length > 0) {
        events.sort((a, b) => a.when - b.when);
        li.inst.scheduleTeleport(events);
      }
    }
  }
}

/* ── Automation (Phase E) ─────────────────────────────────────────────────────
   Native vol/pan lanes schedule their whole breakpoint envelope onto the real
   AudioParam at play/seek (sample-accurate, zero ongoing cost). FX-param lanes
   ride a ~40 Hz lookahead writer because they sit behind the rack's setParams. */

/** Resolve a native (vol/pan) automation target to its live AudioParam. */
function nativeParamFor(target: AutomationTarget): AudioParam | null {
  if (!target.trackId) return null;
  const n = trackNodes.get(target.trackId);
  if (!n) return null;
  if (target.kind === 'trackVolume') return n.gain.gain;
  if (target.kind === 'trackPan') return n.panner.pan;
  return null;
}

/** Schedule each enabled native lane's envelope onto its AudioParam from `fromSec`:
 *  anchor the value at the playhead, then ramp through every later breakpoint. */
function scheduleAutomation(fromSec: number): void {
  const ctx = getEngineCtx();
  const now = ctx.currentTime;
  for (const lane of useEditorStore.getState().automationLanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    if (lane.target.kind !== 'trackVolume' && lane.target.kind !== 'trackPan') continue;
    const param = nativeParamFor(lane.target);
    if (!param) continue;
    param.cancelScheduledValues(now);
    param.setValueAtTime(sampleLane(lane, fromSec) ?? param.value, now);
    for (const p of lane.points) {
      if (p.t <= fromSec) continue;
      const whenCtx = startCtxTime + (p.t - startOffsetSec);
      if (whenCtx <= now) param.setValueAtTime(p.v, now);
      else param.linearRampToValueAtTime(p.v, whenCtx);
    }
  }
}

/** One lookahead frame: write each enabled FX lane's current value into its live
 *  effect param. Values are grouped per effect entry first, so a multi-param
 *  effect (e.g. OWL-Pad x + y) gets ONE merged update instead of competing
 *  single-key updates that would each reset the other key to its static value. */
function applyFxAutomationFrame(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const t = clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
  const ed = useEditorStore.getState();

  const byEntry = new Map<string, { master: boolean; trackId?: string; entryId: string; values: Record<string, number> }>();
  for (const lane of ed.automationLanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    const { kind, trackId, entryId, paramKey } = lane.target;
    if ((kind !== 'trackFx' && kind !== 'masterFx') || !entryId || !paramKey) continue;
    const v = sampleLane(lane, t);
    if (v == null) continue;
    const mapKey = `${kind}|${trackId ?? ''}|${entryId}`;
    let acc = byEntry.get(mapKey);
    if (!acc) { acc = { master: kind === 'masterFx', trackId, entryId, values: {} }; byEntry.set(mapKey, acc); }
    acc.values[paramKey] = v;
  }

  for (const acc of byEntry.values()) {
    if (acc.master) {
      if (!masterChain) continue;
      const entry = ed.masterFxChain.find((e) => e.id === acc.entryId);
      if (!entry || !entry.enabled) continue;
      masterChain.updateParams(acc.entryId, { ...entry.params, ...acc.values });
    } else {
      if (!acc.trackId) continue;
      const n = trackNodes.get(acc.trackId);
      const entry = ed.tracks.find((tr) => tr.id === acc.trackId)?.fxChain?.find((e) => e.id === acc.entryId);
      if (!n || !entry || !entry.enabled) continue;
      n.fx.updateParams(acc.entryId, { ...entry.params, ...acc.values });
    }
  }
}

function startFxAutomation(): void {
  stopFxAutomation();
  const hasFxLane = useEditorStore.getState().automationLanes.some(
    (l) => l.enabled && (l.target.kind === 'trackFx' || l.target.kind === 'masterFx'),
  );
  if (hasFxLane) autoFxTimer = window.setInterval(applyFxAutomationFrame, 25); // ~40 Hz
}

function stopFxAutomation(): void {
  if (autoFxTimer) { clearInterval(autoFxTimer); autoFxTimer = 0; }
}

/** Current transport position in timeline seconds (for recording timestamps). */
export function currentTransportSec(): number {
  if (!playing) return useEditorStore.getState().playheadSec;
  const ctx = getEngineCtx();
  return clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
}

/** Drive a native param live while recording, so the move is heard immediately;
 *  cancels the scheduled envelope for the rest of this pass (latch behavior). The
 *  caller records the point into the lane, which is re-scheduled on the next play. */
export function automationTouchNative(target: AutomationTarget, value: number): void {
  if (!playing) return;
  const param = nativeParamFor(target);
  if (!param) return;
  const ctx = getEngineCtx();
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, RAMP_TC);
}

/**
 * Schedule live-synth note on/off for every MIDI clip at or after `fromSec`.
 * Notes fire via timers aligned to the transport (preview-accurate); the offline
 * export keeps using the sample-accurate render path. One synth channel per track
 * (16-channel cap); per-track volume/pan are not yet applied to MIDI, but mute and
 * solo are honored by skipping the track.
 */
function scheduleMidiClips(clips: AudioClip[], fromSec: number): void {
  const ed = useEditorStore.getState();
  const tracks = ed.tracks;
  const anySolo = tracks.some((t) => t.solo);
  const trackById = new Map<string, EditorTrack>(tracks.map((t): [string, EditorTrack] => [t.id, t]));
  const globalProgram = useSoundfontStore.getState().activeProgram;

  // One synth channel per track that has MIDI clips (16-channel cap).
  const channelOf = new Map<string, number>();
  let nextCh = 0;
  for (const clip of clips) {
    if (!isMidiClip(clip) || channelOf.has(clip.trackId)) continue;
    if (nextCh > 15) break;
    channelOf.set(clip.trackId, nextCh++);
  }

  for (const clip of clips) {
    if (!isMidiClip(clip)) continue;
    const track = trackById.get(clip.trackId);
    if (!track || effectiveVol(track, anySolo) <= 0) continue; // honor mute/solo
    const channel = channelOf.get(clip.trackId);
    if (channel === undefined) continue; // beyond the 16-instrument cap
    const program = clip.instrumentProgram ?? track.instrumentProgram ?? globalProgram;
    const bpm = clip.sourceBpm ?? ed.bpm ?? 120;
    const stepSec = 60 / Math.max(40, bpm) / 4;
    for (const n of clip.sourcePianoRoll ?? []) {
      const onSec = clip.startSec + n.step * stepSec;
      const offSec = onSec + Math.max(1, n.length) * stepSec;
      if (offSec <= fromSec || onSec < fromSec) continue; // finished, or already sounding
      const onDelay = Math.max(0, (onSec - fromSec) * 1000);
      const offDelay = Math.max(onDelay + 10, (offSec - fromSec) * 1000);
      const midi = n.note;
      const vel = n.velocity;
      midiTimers.push(window.setTimeout(() => liveNoteOn(channel, program, midi, vel), onDelay));
      midiTimers.push(window.setTimeout(() => liveNoteOff(channel, midi), offDelay));
    }
  }
}

/** Cancel pending MIDI note timers and silence the synth. */
function clearMidiTimers(): void {
  for (const id of midiTimers) clearTimeout(id);
  midiTimers = [];
  liveAllNotesOff();
}

/** Stop + disconnect every scheduled source (does not tear down track nodes). */
function clearSources(): void {
  for (const s of sources) {
    try { s.onended = null; s.stop(); s.disconnect(); } catch { /* already stopped */ }
  }
  sources = [];
  clearMidiTimers();
  stopFxAutomation();
}

function stopClock(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/** rAF transport clock — advances the playhead off the AudioContext clock. */
function tick(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const elapsed = startOffsetSec + (ctx.currentTime - startCtxTime);

  // Loop region (Phase F): cycle within [loopStart, loopEnd] when enabled + valid.
  const ed = useEditorStore.getState();
  const loopRegion = ed.loopEnabled && ed.loopEnd - ed.loopStart > 0.05;
  if (loopRegion && elapsed >= ed.loopEnd) {
    void start(ed.loopStart);
    return;
  }

  if (elapsed >= totalDur) {
    if (loopRegion) {
      void start(ed.loopStart); // region loop also catches the timeline end
      return;
    }
    if (usePlayerStore.getState().isLooping) {
      void start(0); // seamless-ish loop from the top
      return;
    }
    finishAtEnd();
    return;
  }

  // Playhead every frame (smooth line); footer time ~10 Hz is plenty.
  useEditorStore.getState().setPlayhead(elapsed);
  if (ctx.currentTime - lastTimePush > 0.1) {
    lastTimePush = ctx.currentTime;
    usePlayerStore.setState({ currentTime: elapsed });
  }
  rafId = requestAnimationFrame(tick);
}

/** Reached the end with looping off — park at end, mark stopped. */
function finishAtEnd(): void {
  clearSources();
  stopClock();
  playing = false;
  usePlayerStore.setState({ isPlaying: false, currentTime: totalDur });
  useEditorStore.getState().setPlayhead(totalDur);
}

/** (Re)start playback from `fromSec`. Decodes, builds nodes, schedules, runs. */
async function start(fromSec: number): Promise<void> {
  const token = ++playToken;
  const ed = useEditorStore.getState();
  const clips = ed.clips;
  if (clips.length === 0) return;

  totalDur = ed.getTotalDurationSec();
  const begin = fromSec >= totalDur - 0.05 ? 0 : Math.max(0, fromSec);

  // Tear down any previous run first.
  clearSources();
  stopClock();

  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* will retry on next gesture */ }
  }

  try {
    await ensureDecoded(clips);
  } catch (e) {
    logError('editor', `Live decode failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (token !== playToken) return; // superseded by a newer start()

  // Decide MIDI playback mode. Drive notes through the live synth only when the
  // user opted into a soundfont (global picker) or assigned an instrument to a
  // clip/track; otherwise keep playing the clip's bounced audio, so users who
  // never touch soundfonts see no behavior change or surprise soundfont load.
  const wantLiveMidi =
    clips.some(isMidiClip) &&
    (useSoundfontStore.getState().useSoundfont ||
      clips.some((c) => isMidiClip(c) && c.instrumentProgram !== undefined) ||
      ed.tracks.some((t) => t.instrumentProgram !== undefined));
  if (wantLiveMidi) {
    liveMidiActive = isLiveSynthReady() ? true : await ensureSoundfontReady();
    if (token !== playToken) return;
  } else {
    liveMidiActive = false;
  }

  // (Re)assert ourselves as the live transport — a library track played in the
  // meantime may have cleared it via playerStore.load().
  setLiveTransport({ play, pause, stop, seek });

  buildMasterBus();
  buildTrackNodes(ed.tracks);
  startCtxTime = ctx.currentTime;
  startOffsetSec = begin;
  lastTimePush = 0;
  lastMixSig = mixSignature(ed.tracks);
  scheduleClips(clips, begin);
  scheduleTeleports(clips, begin);
  scheduleAutomation(begin); // native vol/pan envelopes onto their AudioParams
  startFxAutomation();        // ~40 Hz lookahead writer for FX-param lanes
  if (liveMidiActive) scheduleMidiClips(clips, begin);

  playing = true;
  usePlayerStore.setState({
    isPlaying: true,
    duration: totalDur,
    currentTime: begin,
    currentLabel: 'Editor Timeline',
    currentEntryId: EDITOR_ENTRY_ID,
    hasTrack: true,
  });
  useEditorStore.getState().setPlayhead(begin);

  // Live mixer-param updates (skip the churny playhead-only store ticks).
  if (!unsubEditor) {
    unsubEditor = useEditorStore.subscribe(() => {
      if (!playing) return;
      const sig = mixSignature(useEditorStore.getState().tracks);
      if (sig !== lastMixSig) {
        lastMixSig = sig;
        applyMixLive();
      }
      applyMasterChainLive(); // live master rack edits (add/remove/reorder/param)
      applyTrackChainsLive(); // live per-track rack edits
    });
  }

  rafId = requestAnimationFrame(tick);
}

/* ------------------------------- public API ------------------------------- */

/** Begin live playback from the current editor playhead. */
export function play(): void {
  void start(useEditorStore.getState().playheadSec);
}

/** Awaitable play (resolves once decode + scheduling are done) — lets the
 *  editor show a brief "Rendering" state on the first play of new clips. */
export async function playAsync(): Promise<void> {
  await start(useEditorStore.getState().playheadSec);
}

/** Pause in place (keeps the playhead). */
export function pause(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const elapsed = clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
  clearSources();
  stopClock();
  playing = false;
  useEditorStore.getState().setPlayhead(elapsed);
  usePlayerStore.setState({ isPlaying: false, currentTime: elapsed });
}

/** Stop and rewind to 0. */
export function stop(): void {
  clearSources();
  stopClock();
  playing = false;
  useEditorStore.getState().setPlayhead(0);
  usePlayerStore.setState({ isPlaying: false, currentTime: 0 });
}

/** Seek to `sec`; reschedules from there if currently playing. */
export function seek(sec: number): void {
  const target = clamp(sec, 0, totalDur || useEditorStore.getState().getTotalDurationSec());
  useEditorStore.getState().setPlayhead(target);
  usePlayerStore.setState({ currentTime: target });
  if (playing) void start(target);
}

/** True while live playback is running. */
export function isPlaying(): boolean {
  return playing;
}

/** Re-assert liveMixer as the active transport after a frozen-master audition.
 *  Auditioning the rendered VST master loads a non-editor track into the player
 *  (which clears the live hook), so switching EDIT back to Live mode calls this
 *  to route the footer transport at the live multitrack mix again. */
export function reactivate(): void {
  setLiveTransport({ play, pause, stop, seek });
  usePlayerStore.setState({ currentEntryId: EDITOR_ENTRY_ID, currentLabel: 'Editor Timeline' });
}

/** Register this module as playerStore's live transport so the footer's normal
 *  transport buttons drive it. Call on editor mount. Returns an unregister. */
export function attach(): () => void {
  setLiveTransport({ play, pause, stop, seek });
  return () => {
    dispose();
  };
}

/** Tear everything down (editor unmount, or superseded by a library track). */
export function dispose(): void {
  clearSources();
  stopClock();
  playing = false;
  if (unsubEditor) { unsubEditor(); unsubEditor = null; }
  disposeTrackNodes();
  trackNodes = new Map();
  if (masterChain) { masterChain.dispose(); masterChain = null; }
  if (masterBus) { try { masterBus.disconnect(); } catch { /* gone */ } masterBus = null; }
  lastMasterSig = '';
  lastMasterFullSig = '';
  setLiveTransport(null);
}
