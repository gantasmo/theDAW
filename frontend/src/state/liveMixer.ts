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
 *                                                   └▶ panner (pan, live) ─▶ comp (PDC) ─▶ ⟨routed⟩
 *
 * ⟨routed⟩ is not a constant any more: where a track's comp delay lands is an
 * EDGE in `state/routingGraph` — the master bus, or a mix bus, plus any number
 * of sends tapped off the same point. See the "Routing" section below.
 *
 * trackGain + panner are shared per track and updated in place when the EDIT
 * (or SLIDE) faders move — that's the whole point. clipGain carries each clip's
 * fade envelope. Everything routes through the shared engine master → analyser
 * → destination, so the visualizer + HUD keep working.
 *
 * Transport: a rAF clock advances a virtual playhead off the AudioContext
 * clock and mirrors it into playerStore.currentTime (footer time) and
 * editorStore.playheadSec (the moving line). Those two are not the same number
 * once a chain declares latency: the footer clock is the transport POSITION,
 * while the line is drawn back by `outputLatencySec()` so it shows the moment
 * that is AUDIBLE. See `outputLatencySec` / `publishPlayhead`. The footer is
 * UNCHANGED — it calls the usual playerStore transport methods, which delegate
 * here while a live editor session is registered (see playerStore.setLiveTransport).
 *
 * The OFFLINE bounce is kept as-is for export / commit / send-to-init — those
 * actually need a rendered file. liveMixer only replaces the live PREVIEW.
 *
 * Honesty / scope: live updates cover the MIXER params (volume/pan/mute/solo)
 * plus per-clip mute (a retained gain gate per scheduled clip). Structural clip
 * edits (add/remove/split/move) made WHILE playing take effect on the next
 * play, same as a hardware mixer wouldn't re-cut tape mid-take. The one
 * exception is a MIDI clip EDIT's synths play live: lib/editMidiScheduler
 * re-reads the clips on every tick, so its notes, program, gain and fades
 * follow an edit made while playing. A volume or pan automation lane edited
 * while playing is written onto its param again as well
 * (`rearmEditedNativeLanes`).
 */
import {
  useEditorStore,
  activeTrackInstrument,
  documentFreezeSignature,
  sampleLane,
  automationTargetKey,
  clipPeakGain,
  isFxAutomationKind,
  type AudioClip,
  type EditorTrack,
  type AutomationLane,
  type AutomationTarget,
} from './editorStore';
import { clampCurve, interpolatePoints, sampleCurve, type CurvePoint } from '../lib/automationModes';
import {
  usePlayerStore,
  getEngineCtx,
  getEngineOutputInfo,
  getMasterGain,
  setLiveTransport,
  registerChainProbe,
} from './playerStore';
import { logError, logWarn } from './logStore';
import {
  ensureEditBanks,
  editChannelPressure,
  editControllerChange,
  editNoteOn,
  editNoteOff,
  editPitchWheel,
  editPitchWheelRange,
  editAllNotesOff,
  routeEditChannel,
  parkEditRouting,
  getGlobalVoice,
} from '../lib/soundfontEngine';
import {
  EDIT_MIDI_HIDDEN_LOOKAHEAD_SEC,
  EDIT_MIDI_LOOKAHEAD_SEC,
  EDIT_MIDI_TICK_MS,
  EditMidiScheduler,
  clipLiveSlots,
  clipLiveTiming,
  type EditMidiSink,
} from '../lib/editMidiScheduler';
import {
  externalOnlyChannels,
  passMidiSink,
  startTrackRoutes,
  startTransportClock,
  stopTrackOutputs,
  tickTrackOutputs,
  trackOutputsActive,
} from './midiOutBus';
import { beatToTime, timeToBeat } from '../lib/tempoMap';
import { NO_PROGRAM, clipVoice, effectiveProgramFor, isExternalOnly, isPercussionTrack, type GlobalVoice } from '../lib/clipProgram';
import { planEditChannels, type EditChannelPlan } from '../lib/editChannels';
import { trackMembers } from '../lib/mpeRotation';
import { userBanksByEditBank } from '../lib/editBankBanks';
import { useSoundBankStore } from './soundBankStore';
import { applyFadeAutomation, type AudioParamLike, type FadeClip } from '../lib/clipFade';
import { warpSegments, type WarpMarker, type WarpSegment } from '../lib/audioWarp';
import {
  buildEffectChain,
  chainLatencyReport,
  summingDelaysSec,
  teleportXYZ,
  SPATIAL_TELEPORT,
  type ChainHandle,
  type ChainLatencyOptions,
  type ChainLatencyReport,
  type RackEffectDef,
} from '../lib/rackEffects';
import { broadcastVstTransport } from '../lib/vstLive/vstLiveNode';
import { hookVstSessionUnload, vstSessions } from '../lib/vstLive/sessionRegistry';
import { ROLL_HOLDER, createProjectSessions } from '../lib/vstLive/projectSessions';
import { InstrumentLivePass, planInstrumentTracks, type InstrumentLiveTrack } from '../lib/vstLive/instrumentLive';
import { entryLatencySamples, useVstLiveStore, type VstLiveEntryState } from './vstLiveStore';
import { sliceChunks, type AudioChunk } from '../lib/audioAnalysis';
import {
  configureDecodeCache,
  decodeClipBlob,
  defaultDecodeBudgetBytes,
  peekDecoded,
  pinDecoded,
  unpinDecoded,
} from '../lib/decodeCache';
import {
  compSegments,
  isComped,
  normalizeComp,
  type ClipTake,
  type CompRegion,
} from '../lib/clipComp';
import { isMidiClip } from '../lib/clipEditTarget';
import { clipNoteSpan } from '../lib/rollClip';
import { stepClock } from '../lib/rollTempo';
import { editTempoAtSec } from '../lib/editTimeMap';
import { hasMidiNotes } from '../lib/midiRender';
import { midiRenderPending, requestMidiRender } from './midiRenderQueue';
import type { ChainEntry } from './effectChainStore';
import {
  CONN_SIDECHAIN,
  CONN_SEND,
  MASTER_ID,
  outputOf,
  sendsFrom,
  sidechainsInto,
  topoOrder,
  type RoutingGraph,
} from './routingGraph';

const EDITOR_ENTRY_ID = 'editor-timeline'; // reuse so existing footer/playhead wiring keeps working
const RAMP_TC = 0.015; // setTargetAtTime time-constant for click-free param moves
/** Time constant the per-track compensation delay moves on. Same value the DJ
 *  decks have always used for their two-deck version of this (djEngine
 *  `updateLatencyComp`), so both alignments glide identically. */
const COMP_TC = 0.01;
/** Ceiling on the compensation `DelayNode`, in seconds. A second is orders of
 *  magnitude past any plausible insert-chain latency and costs only the node's
 *  (lazily allocated) buffer. */
const COMP_MAX_DELAY = 1.0;

// Decoded buffers live in lib/decodeCache, shared with the offline renderers,
// so a clip decoded here for playback is not decoded a second time by a bounce.

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
  /** Plugin-delay compensation, spliced panner -> comp -> the summing bus. Holds
   *  `max(chain latency) - this track's own`, so every track meets the slowest
   *  one. 0 (transparent) until some chain declares latency. See
   *  `syncTrackLatency`.
   *
   *  METERING: any future PER-TRACK meter must tap AFTER this node. The master
   *  meter is already fine because `levelsStore` taps the post-sum master chain
   *  (`playerStore.getMeterTap`), which is downstream of every comp; a tap taken
   *  from `panner` or earlier would read a track `latency + comp` early and so
   *  show tracks lighting up out of step with each other and with the master. */
  comp: DelayNode;
  /** The strip's meter tap: a LEAF analyser hung off `comp`, i.e. exactly where
   *  the METERING note above says a per-track meter has to sit. It is read by
   *  `state/stripMeters`, never by the routing pass — see `makeStripMeter`.
   *  Absent when the context cannot make one (the routing test's fakes). */
  meter?: AnalyserNode;
  /** Per-track insert FX, spliced gain -> muteGain -> [fx] -> panner. */
  fx: ChainHandle;
  fxFullSig: string; // topology + params (skip no-op reconciles)
  fxTopoSig: string; // topology only (rebuild trigger)
}

/**
 * One mix bus's live strip: `input -> [insert FX] -> gain -> muteGain -> output`.
 *
 * Three track-only stages are absent — no source (a bus is fed by other nodes,
 * not by clips), no panner (a bus sums already-panned stereo) and no
 * compensation delay (the delay that aligns a bus with its siblings belongs on
 * the TRACKS feeding it, which is where `syncTrackLatency` puts it).
 *
 * THE RACK ALSO SITS ON THE OTHER SIDE OF THE FADER. A track is
 * `gain -> muteGain -> [fx] -> panner`: post-fader inserts. A bus is
 * `[fx] -> gain -> muteGain`: PRE-fader inserts, which is the conventional bus
 * shape (you set a bus compressor once and then ride the bus fader under it),
 * but it is an inversion and it has two audible consequences:
 *
 *  - A bus MUTE is post-FX, so muting a bus CUTS ITS TAILS — a reverb on a bus
 *    stops dead. Muting a TRACK is pre-FX and its tails ring out. Same word,
 *    opposite behaviour, on purpose.
 *  - A bus FADER does not drive its own inserts. Pulling a bus fader down does
 *    not make its compressor let go, because the compressor is upstream of it;
 *    pulling a TRACK fader down does.
 *
 * `input` and `output` are separate nodes even though nothing sits outside the
 * chain: `wireRoutingGraph` needs one node it can `disconnect()` on a rewire
 * without tearing the strip apart, and one node every input can land on
 * regardless of what the rack is currently doing.
 */
export interface BusNodes {
  /** What everything routed INTO this bus connects to. */
  input: GainNode;
  /** The bus's insert rack, spliced input -> [fx] -> gain. */
  fx: ChainHandle;
  /** Volume fader. */
  gain: GainNode;
  /** Mute gate (0 or 1), driven live. */
  muteGain: GainNode;
  /** What this bus feeds downstream. */
  output: GainNode;
  /** The strip's meter tap: a LEAF analyser hung off `output`, so it reads the
   *  bus post-rack, post-fader and post-mute — the same end-of-strip point a
   *  track meters at. Read by `state/stripMeters`; see `makeStripMeter`.
   *  Absent when the context cannot make one (the routing test's fakes). */
  meter?: AnalyserNode;
  fxFullSig: string; // topology + params (skip no-op reconciles)
  fxTopoSig: string; // topology only (rebuild trigger)
}

// ---- live session state (module singletons; one editor timeline at a time) --
let trackNodes = new Map<string, TrackNodes>();
/** Live bus strips, keyed by `EditorBus.id`. */
let busNodes = new Map<string, BusNodes>();
/** One gain node per send, keyed `sendKey(from, to)`, so `setSendGain` reaches
 *  the exact node without a rebuild. */
let sendGains = new Map<string, GainNode>();
/** Reused scratch map behind `getStripMeterNodes()` — rebuilt in place once per
 *  animation frame rather than allocated. */
const stripMeterNodes = new Map<string, AnalyserNode>();
let sources: AudioBufferSourceNode[] = [];
let rafId = 0;
let startCtxTime = 0; // ctx.currentTime at the moment playback (re)started
let startOffsetSec = 0; // timeline position playback started from
let totalDur = 0;
let playing = false;
let playToken = 0; // guards against overlapping async play() calls
let unsubEditor: (() => void) | null = null;
let lastMixSig = '';
let lastCompSig = ''; // last alignment written by syncTrackLatency (skip no-op writes)
let lastTimePush = 0; // throttle playerStore.currentTime writes
let midiTimer = 0; // setInterval handle driving the live MIDI scheduler (lib/editMidiScheduler)
let clockTimer = 0; // setInterval handle sending MIDI clock ahead to the tracks' clocked ports (state/midiOutBus)
// One envelope gain per track with live MIDI: its channels -> this -> the
// track's gain node. It carries the playing clip's gain and fades.
let midiEnvGains = new Map<string, GainNode>();
// Per-clip mute gates retained at schedule time, keyed by clip id. Structural
// clip edits still require a re-schedule; muted is the one clip property gated
// live, so the editor-store subscription flips these gains mid-playback.
let clipMuteGains = new Map<string, GainNode>();
let lastClipMuteSig = '';
// The MIDI clips this pass synthesises live (planLiveMidi); every other MIDI
// clip plays its bounced audio.
let liveMidiPlan: LiveMidiPlan = emptyLiveMidiPlan();
// The MIDI clips a track's VST3 instrument plays this pass (lib/vstLive/instrumentLive): neither
// EDIT's synths nor the clip audio path touch them.
let instrumentPlan: InstrumentLiveTrack[] = [];
let instrumentClips: ReadonlySet<string> = new Set();
/** Does this pass play `clipId` some other way than its audio (EDIT's synths or a VST3 instrument)? */
const playsWithoutAudio = (clipId: string): boolean => liveMidiPlan.liveClipIds.has(clipId) || instrumentClips.has(clipId);
let autoFxTimer = 0; // setInterval handle for the FX-param automation lookahead

// Session-local master bus + psychoacoustic insert rack. Every track's panner
// feeds masterBus; masterBus -> masterChain -> the shared engine master, so the
// EDIT rack processes ONLY the editor mix and never the library/DJ/sequencer
// audio that also routes through getMasterGain().
let masterBus: GainNode | null = null;
let masterChain: ChainHandle | null = null;
let lastMasterSig = '';     // topology only (rebuild trigger)
let lastMasterFullSig = ''; // topology + params (skip no-op ticks)
// The MASTER VST rack (editorStore.masterVstChain), spliced after masterFxChain
// — see buildMasterBus for when it is built and when the frozen render already
// contains it.
let masterVstNode: GainNode | null = null;
let masterVstChainHandle: ChainHandle | null = null;
let lastMasterVstSig = '';
let lastMasterVstFullSig = '';
// Live VST sessions: their reported latency drives PDC, so a `ready` or a
// `latency` event has to re-run the same alignment a chain edit does.
let unsubVstLive: (() => void) | null = null;
let lastVstLatencySig = '';

// Routing reconciliation signatures. Split so the store subscription can tell
// a STRUCTURAL move (rebuild nodes / rewire) from a VALUE move (write a param),
// the same split the FX chains already use.
let lastBusMembershipSig = ''; // which buses exist, in order (node rebuild)
let lastRoutingSig = '';       // nodes + edges MINUS send gains (rewire)
let lastBusMixSig = '';        // bus faders + mutes (live write)
let lastSendGainSig = '';      // send amounts (live write)

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
 *  manual reconcile leaves those params to the scheduled envelope while playing.
 *  A lane with no points schedules nothing (`scheduleAutomation`), so it is not
 *  counted and its fader still decides. Exported for its test. */
export function automatedNativeKeys(): Set<string> {
  const keys = new Set<string>();
  for (const lane of useEditorStore.getState().automationLanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    const k = lane.target.kind;
    if (k === 'trackVolume' || k === 'trackPan') keys.add(automationTargetKey(lane.target));
  }
  return keys;
}

/* What the EDIT timeline's own nodes are doing, for playerStore.dumpAudioChain.
   `param` is the value the AudioParam is REALLY holding — which is not the
   fader when an automation lane owns it (scheduleAutomation writes the param,
   applyMixLive skips it), and that gap is exactly what makes a track quiet with
   its fader up. */
registerChainProbe('editTimeline', () => {
  const automated = automatedNativeKeys();
  const ed = useEditorStore.getState();
  const { maxSec, perTrack } = trackLatencyReport();
  const rowOf = new Map(perTrack.map((r) => [r.trackId, r]));
  return {
    playing,
    masterBus: masterBus ? masterBus.gain.value : null,
    // How far behind the transport the speakers are — the number the playhead is
    // drawn back by, and the one the render trim uses. See `outputLatencySec`.
    outputLatencySec: maxSec,
    tracks: ed.tracks.map((t) => {
      const n = trackNodes.get(t.id);
      const row = rowOf.get(t.id);
      return {
        name: t.name,
        fader: t.volume,
        param: n ? n.gain.gain.value : null,
        volumeAutomated: automated.has(automationTargetKey({ kind: 'trackVolume', trackId: t.id })),
        muteGate: n ? n.muteGain.gain.value : null,
        pan: n ? n.panner.pan.value : t.pan,
        // What this strip's path to the master declares it lags by, what its comp
        // must hold to meet the slowest track (`latencySec + compSec == maxSec`),
        // and what the DelayNode is REALLY holding — which trails `compSec` by
        // the 0.01 s glide, and is null for a track with no live node yet.
        latencySec: row ? row.latencySec : 0,
        compSec: row ? row.compSec : 0,
        compParam: n ? n.comp.delayTime.value : null,
        uncounted: row ? row.uncounted : [],
      };
    }),
    // The bus half of the graph (the T10b follow-up). A bus carries no comp of
    // its own: its chain's latency is counted into every track routed through it
    // (`trackCompDelays`'s downstream walk), so all the compensation is on the
    // track strips above.
    buses: ed.buses.map((b) => {
      const n = busNodes.get(b.id);
      return {
        id: b.id,
        name: b.name,
        fader: b.volume,
        param: n ? n.gain.gain.value : null,
        muteGate: n ? n.muteGain.gain.value : null,
      };
    }),
    sends: [...sendGains].map(([key, g]) => ({ key, gain: g.gain.value })),
  };
});

/** A short signature of just the mixer-relevant fields, so the editorStore
 *  subscription (which also fires on every playhead tick) only pushes live
 *  node updates when a fader/pan/mute/solo actually moved. */
function mixSignature(tracks: EditorTrack[]): string {
  let s = '';
  for (const t of tracks) s += `${t.id}:${t.volume}:${t.pan}:${t.mute}:${t.solo}|`;
  return s;
}

/** Signature of which clips are muted, so the clips-slice subscription (which
 *  also fires on drags/resizes) only touches the live gates on a mute change. */
function clipMuteSignature(clips: AudioClip[]): string {
  let s = '';
  for (const c of clips) if (c.muted) s += `${c.id}|`;
  return s;
}

/** Push each scheduled clip's live mute gate (0 or 1, click-free). Clips muted
 *  at schedule time were never scheduled, so unmuting those takes effect on the
 *  next play; muting (and re-unmuting) a playing clip is audible immediately. */
function applyClipMutesLive(): void {
  if (clipMuteGains.size === 0) return;
  const ctx = getEngineCtx();
  for (const clip of useEditorStore.getState().clips) {
    const gate = clipMuteGains.get(clip.id);
    if (!gate) continue;
    gate.gain.setTargetAtTime(clip.muted ? 0 : 1, ctx.currentTime, RAMP_TC);
  }
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
  // Bus faders and mutes are mixer values like the track ones, so they ride the
  // same push. A bus has no automation lane and no pan, so there is nothing to
  // skip and nothing else to write. (No buses: the loop inside does nothing.)
  applyBusMix(useEditorStore.getState().buses, (id) => busNodes.get(id), ctx.currentTime);
}

/* ── Decode retention: what this module must pin, and when ────────────────────
   `lib/decodeCache` can evict least-recently-used buffers to stay inside a byte
   budget, and this module is the one caller that cannot survive an eviction it
   did not expect: it PREFETCHES every clip with `decodeClipBlob` (async, one at
   a time) and then reads them all back with `peekDecoded` inside a scheduling
   loop that cannot await. A buffer dropped between those two passes does not
   re-decode — the clip is silently not scheduled.

   So every buffer this module depends on is pinned for as long as it depends on
   it, in two overlapping stages:

     1. PREFETCH. Each decode is pinned the moment it resolves, so a later
        decode in the same pass cannot evict an earlier one.
     2. SCHEDULE. Each buffer a clip actually plays takes a pin of its own,
        released when that clip's last source ends (or when the transport tears
        the pass down). The prefetch pins are dropped once scheduling is over,
        which is what releases the clips that were muted, MIDI-driven, or on a
        vanished track and so never scheduled at all.

   Pins nest, so the two stages do not interfere and two clips sharing one blob
   hold two pins on it. Only with all of this in place is it safe to turn the
   budget on at all — see `enableDecodeBudget`.

   `decodeCache.releaseDecoded(blob)` is the other half of this — telling the
   cache a clip is GONE, so its PCM and its encoded Blob are freed without
   waiting for the budget to notice. `state/editorStore.ts`'s `releaseClipAudio`
   calls it from `removeClip`, `removeTrack`, and `loadProject` (T66B) — it does
   NOT wait for a deleted clip to fall out of undo history first. The tradeoff:
   undoing a removal back in is always correct (undo restores the clip object,
   whose `audioBlob` is untouched, and never re-decodes), but if the freed
   buffer was released, the FIRST play/bounce after that undo re-decodes from
   the Blob instead of reusing a cached one — a cost, never wrong audio.
   `releaseClipAudio` also skips releasing any Blob a clip still LIVE in the
   document shares (a split's sibling, a duplicate, a shared import), so this
   only ever costs a re-decode for a Blob nothing but undo history was holding. */

/** One outstanding pin: a decoded blob at one sample rate. */
export interface DecodePin {
  blob: Blob;
  rate: number;
}

/**
 * A release for the pins in `pins` that runs at most ONCE, however many times it
 * is called. Pins are counted, so a double release would drop somebody else's
 * pin on the same blob — the live path deliberately has two ways to reach a
 * release (the last source ending, and the transport tearing the pass down) and
 * this is what makes them safe to both fire.
 *
 * `pins` is read AT RELEASE TIME, not captured here. The live path builds the
 * release before it hands `takeResolver` the array to fill — the resolver is
 * called from inside `scheduleClipSources`, so there is nothing to snapshot yet
 * — and a copy taken at construction would therefore always be empty and free
 * nothing at all. The array must not be reused for a second clip.
 */
export function releaseOnce(pins: readonly DecodePin[]): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const pin of pins) unpinDecoded(pin.blob, pin.rate);
  };
}

/** The clip fields the decode side reads: its own blob, and its takes' blobs. */
export interface DecodableClip {
  /** Absent on a piano-roll clip that holds no render: it has nothing to decode. */
  audioBlob?: Blob;
  takes?: ClipTake[];
  comp?: CompRegion[];
  activeTakeIndex?: number;
}

/**
 * Every distinct blob a clip needs decoded.
 *
 * Gated on the clip being COMPED, not on it merely having takes: switching the
 * active take rewrites the clip's own mirrored fields, so the next play decodes
 * the new blob through this same one-blob path. Decoding the alternates eagerly
 * would cost a decode and ~81 MiB per four-minute take that nothing is going to
 * play. So a clip that is not comped decodes exactly what it always did.
 */
function clipBlobs(clip: DecodableClip): Blob[] {
  if (!clip.audioBlob) return [];
  if (!isComped(clip)) return [clip.audioBlob];
  const out: Blob[] = [clip.audioBlob];
  for (const take of clip.takes ?? []) {
    if (take?.audioBlob && !out.includes(take.audioBlob)) out.push(take.audioBlob);
  }
  return out;
}

/**
 * The buffer resolver `scheduleClipSources` is handed for one clip: which
 * decoded buffer each take index plays from, PINNED as it is handed over and
 * recorded in `pins` so the caller can release exactly what it took.
 *
 * The ACTIVE take resolves to the clip's OWN blob — which the `AudioClip.takes`
 * invariant says is that take's audio — so a clip that is not comped peeks
 * exactly the blob this scheduler has always peeked, takes or no takes. Only the
 * alternates are looked up in the take list.
 */
export function takeResolver(
  ctx: BaseAudioContext,
  clip: DecodableClip,
  pins: DecodePin[],
): TakeBufferResolver {
  const rate = ctx.sampleRate;
  return (takeIndex) => {
    const blob = takeIndex === (clip.activeTakeIndex ?? 0)
      ? clip.audioBlob
      : clip.takes?.[takeIndex]?.audioBlob;
    if (!blob) return undefined;
    const buffer = peekDecoded(ctx, blob);
    if (!buffer) return undefined;
    pinDecoded(blob, rate);
    pins.push({ blob, rate });
    return buffer;
  };
}

/**
 * Decode every blob the pass will need, pinning each one as it lands.
 *
 * The pin is taken INSIDE the loop rather than afterwards because the loop is
 * the hazard: under a budget, decoding clip N can evict clip 1, which the
 * scheduler then cannot peek back. `pins` is appended to as the walk proceeds,
 * so a caller still holds (and can release) whatever was taken even if a later
 * decode rejects.
 */
export async function prefetchDecodes(
  ctx: BaseAudioContext,
  clips: readonly DecodableClip[],
  pins: DecodePin[],
): Promise<void> {
  const rate = ctx.sampleRate;
  for (const clip of clips) {
    for (const blob of clipBlobs(clip)) {
      await decodeClipBlob(ctx, blob);
      pinDecoded(blob, rate);
      pins.push({ blob, rate });
    }
  }
}

/** Prefetch pins for the pass being set up. One array for the module's lifetime
 *  — never reassigned — so a superseded `start()` still pushing into it cannot
 *  strand its pins outside the list that gets released. */
const prefetchPins: DecodePin[] = [];

function releasePrefetchPins(): void {
  for (const pin of prefetchPins) unpinDecoded(pin.blob, pin.rate);
  prefetchPins.length = 0;
}

/** One release per scheduled clip, for the transport to call when it stops the
 *  sources itself instead of letting them end. */
let clipPinReleases: (() => void)[] = [];

/** Turned on once, at editor mount. Eviction is only safe now that every buffer
 *  the scheduler depends on is pinned above; before that, a budget turned a big
 *  project into silence rather than into a smaller cache. */
let decodeBudgetEnabled = false;

/**
 * Give the shared decode cache its byte budget. Idempotent — `attach()` may run
 * many times over a session as the editor mounts and unmounts.
 *
 * ONE-WAY and GLOBAL: `lib/decodeCache` is a module singleton shared with every
 * other decoder in the app, and nothing turns the budget back off. That is safe
 * because this module is the only `peekDecoded` caller — the only one that reads
 * a buffer back synchronously and so cannot survive an eviction it did not
 * expect. `lib/renderCore` awaits `deps.decode` and holds every buffer in a Map
 * of its own for the whole render, and `WaveformEditor` only ever awaits
 * `decodeClipBlob`; an eviction is invisible to both — at worst the next request
 * decodes again. If a third kind of caller ever peeks, it has to pin first.
 */
export function enableDecodeBudget(): void {
  if (decodeBudgetEnabled) return;
  decodeBudgetEnabled = true;
  configureDecodeCache({ budgetBytes: defaultDecodeBudgetBytes() });
}

/** Decode every clip's blob we'll need (cached by Blob identity + sample rate),
 *  and every take's for a comped one. Pinned as each lands; released once
 *  `scheduleClips` has taken its own pins on the buffers that will play. */
async function ensureDecoded(clips: AudioClip[]): Promise<void> {
  const ctx = getEngineCtx();
  await prefetchDecodes(ctx, clips, prefetchPins);
}

/** Topology signature of an FX chain (order + effect + enabled), so the store
 *  subscription rebuilds the node graph only when the topology changes, and
 *  pushes param-only edits without a rebuild. */
function chainTopoSig(chain: ChainEntry[]): string {
  let s = '';
  for (const e of chain) s += `${e.id}:${e.effect}:${e.enabled ? 1 : 0}|`;
  return s;
}

/* ── Routing: buses, sends, outputTo ──────────────────────────────────────────
   Until this, `buildTrackNodes` hard-coded every track's destination to the
   session master bus. The destination is now an EDGE in `state/routingGraph`,
   and the four functions below are the whole of turning that model into Web
   Audio connections. They are pure over injected seams — no store, no engine —
   so the wiring is assertable with fake nodes (state/liveMixer.routing.test.ts)
   and the module-level wrappers further down are the only part that touches
   the singletons.

   The contract these implement is `state/routingGraph.ts`'s, and its header
   records where the DESIGN came from: Ardour `libs/ardour/internal_return.cc`
   (GPL-2.0-or-later) for "a bus is a normal node that sums its inputs, and a
   send is a post-fader tap with its own gain rather than a second output". That
   description is the only thing carried across — no Ardour source was read or
   copied while writing this file, and the taps here are post-pan/post-comp
   because that is where THIS mixer's per-track chain ends. */

/** A track's or bus's own strip, as the compensation writer sees it. */
export interface RampParam {
  setTargetAtTime(value: number, startTime: number, timeConstant: number): unknown;
}

/** The bus fields the live graph reads. `EditorBus` satisfies it. */
export interface MixBus {
  id: string;
  fxChain?: ChainEntry[];
  volume: number;
  mute: boolean;
}

/* ── strip meter taps ────────────────────────────────────────────────────────
   One analyser per strip, hung off the END of that strip — a track's `comp`, a
   bus's `output`. Read by `state/stripMeters` once per animation frame; see that
   file for where the tap point comes from.

   A LEAF, never a node in the routing graph. `wireRoutingGraph` only ever sees
   `outputNodeOf` (the comp / the output), so the analyser is invisible to
   `topoOrder` and to the send taps; it has no outgoing connection of its own,
   and it analyses anyway because its input is already being pulled toward the
   destination — the same shape `levelsStore` uses for its two channel
   analysers, which are likewise connected to nothing. */

/** Window length for a strip analyser. 2048 for `levelsStore`'s reason: ~46 ms
 *  at 44.1 kHz, so consecutive windows OVERLAP at 60 fps and no peak can slip
 *  between two reads. */
const STRIP_METER_FFT_SIZE = 2048;

/**
 * Make one strip's meter tap, or `undefined` when the context cannot.
 *
 * MONO, EXPLICITLY. An `AnalyserNode` analyses a mono down-mix of its input
 * whatever its channel settings say; `channelCount = 1` with
 * `channelCountMode = 'explicit'` and `'speakers'` interpretation does not
 * select a channel and does not change the numbers — it PINS that fold at the
 * node's declared input instead of leaving it implicit, so the reading a strip
 * bar shows is stated by this file rather than inferred. What it does NOT undo
 * is the mono sum's own cost: a hard-panned full-scale track reads 6 dB down,
 * which is the usual trade for a single-bar strip meter and is why the master
 * meter (`levelsStore`) stays per-channel.
 *
 * Guarded rather than assumed: `createBusNodes` is also driven by the fake
 * contexts in `liveMixer.routing.test.ts`, which implement only the nodes the
 * routing pass needs. A strip with no tap just never appears in
 * `getStripMeterNodes()`, and its bar sits at silence.
 */
function makeStripMeter(ctx: BaseAudioContext, source: AudioNode): AnalyserNode | undefined {
  if (typeof ctx.createAnalyser !== 'function') return undefined;
  const meter = ctx.createAnalyser();
  meter.fftSize = STRIP_METER_FFT_SIZE;
  meter.channelCount = 1;
  meter.channelCountMode = 'explicit';
  meter.channelInterpretation = 'speakers';
  source.connect(meter);
  return meter;
}

/**
 * Every live strip's meter tap, keyed by strip id (tracks first, then buses).
 *
 * The one seam `state/stripMeters` reads, so it never reaches into the private
 * `trackNodes` / `busNodes` maps. The returned map is REUSED between calls — it
 * is rebuilt in place on each one, because the caller asks for it once per
 * animation frame and a fresh Map per frame would be pure garbage.
 */
export function getStripMeterNodes(): ReadonlyMap<string, AnalyserNode> {
  stripMeterNodes.clear();
  for (const [id, n] of trackNodes) if (n.meter) stripMeterNodes.set(id, n.meter);
  for (const [id, n] of busNodes) if (n.meter) stripMeterNodes.set(id, n.meter);
  return stripMeterNodes;
}

/** Build one bus strip: `input -> [fx] -> gain -> muteGain -> output`. The
 *  output is left UNCONNECTED — `wireRoutingGraph` places it, because where a
 *  bus goes is a property of the graph, not of the strip. */
export function createBusNodes(ctx: BaseAudioContext, bus: MixBus): BusNodes {
  const input = ctx.createGain();
  const gain = ctx.createGain();
  gain.gain.value = clamp(bus.volume, 0, 1);
  const muteGain = ctx.createGain();
  // Opened at the stored value rather than at unity: a project loaded with a
  // muted bus must be muted on the first sample, not on the first live push.
  muteGain.gain.value = bus.mute ? 0 : 1;
  const output = ctx.createGain();
  const chain = bus.fxChain ?? [];
  const fx = buildEffectChain(ctx, input, gain, chain); // input -> [fx] -> gain
  gain.connect(muteGain).connect(output);
  const meter = makeStripMeter(ctx, output); // leaf tap; not part of the routing
  return {
    input,
    fx,
    gain,
    muteGain,
    output,
    meter,
    fxFullSig: JSON.stringify(chain),
    fxTopoSig: chainTopoSig(chain),
  };
}

/** Key for a send's gain node. One send per (from, to) pair, so the pair is the
 *  identity — the model refuses a second one as `'duplicate'`. */
export function sendKey(from: string, to: string): string {
  return `${from}|${to}`;
}

/** Routing complaints already made, so a rewire loop cannot spam the log with a
 *  damaged edge it re-reads on every pass. Module-level and never cleared: the
 *  same damaged edge is the same complaint for the life of the session. */
const routingWarned = new Set<string>();

/** Log `msg` the first time `key` is seen, and never again. */
function warnOnce(key: string, msg: string): void {
  if (routingWarned.has(key)) return;
  routingWarned.add(key);
  logWarn('editor', msg);
}

/** The node lookups `wireRoutingGraph` needs. The live mixer resolves them off
 *  its own maps; a test resolves them off fakes. */
export interface RoutingEndpoints {
  /** What a node FEEDS DOWNSTREAM: a track's comp delay, a bus's output. */
  outputNodeOf: (id: string) => AudioNode | undefined;
  /** What a node RECEIVES INTO: a bus's input, or the master summing bus. */
  inputNodeOf: (id: string) => AudioNode | undefined;
  /** Make a fresh gain node for one send, opened at that send's amount. */
  makeSendGain: (gain: number) => GainNode;
  /**
   * The KEY input of one effect entry on one node's rack — `RackEffectInstance.keyIn`
   * for the live (or offline) instance built for `entryId`, and `undefined` when
   * that entry has no instance, is not a keyable effect, or is not built at all.
   *
   * Optional, and the pass simply makes no key connection without it: the two
   * engines both supply it, and the older routing suites construct a
   * `RoutingEndpoints` by hand with no notion of a rack.
   */
  keyInputOf?: (nodeId: string, entryId: string) => AudioNode | undefined;
  /**
   * Every id that HAS a live strip, whatever the graph says. Read only on the
   * degraded path, and it is what makes the fallback's promise true: a damaged
   * file can be missing a node for a track that exists and is playing, and
   * iterating the graph alone would leave that track's comp delay connected to
   * nothing at all — silence, which is precisely what the fallback exists to
   * prevent.
   */
  liveIds: () => Iterable<string>;
}

/**
 * Connect the whole graph, and return the send gain nodes keyed by `sendKey`.
 *
 * Nodes are visited in `topoOrder`, so every source is connected before the
 * node that sums it. Each non-master node gets exactly one main-output edge
 * (`outputOf`, which reads a missing edge as "feeds the master" so a half-built
 * graph is still audible) plus one dedicated gain node per send, tapped off the
 * SAME output as the main path.
 *
 * `topoOrder` throws on a cycle or a malformed graph. The mutators prevent
 * both, but a `.tasmo` or an autosave manifest reaches the mixer without any
 * mutator having vetted it, so the throw degrades to the pre-routing mix —
 * every strip straight to the master, no sends — and is logged. The degraded
 * pass walks the UNION of the graph's nodes and `ends.liveIds()`, so a strip the
 * damaged graph forgot is still connected. Silence is never an outcome: a user
 * whose project file is damaged must still hear their audio.
 *
 * SIDECHAINS are a THIRD pass, after both of those. A `CONN_SIDECHAIN` edge taps
 * the source's output — the very node the main path and the sends tap, so a key
 * costs no extra strip and hears exactly what the mix hears — and lands on the
 * KEY input of one named effect entry on the destination's rack. It is walked
 * last because it is the only edge whose destination is not a strip but
 * something INSIDE one, so it needs every rack to have been built, and because
 * doing it after the outputs keeps the wire log's first two sections exactly
 * what they were.
 *
 * A key is REFUSED — skipped and logged once — when the model says the edge is
 * invalid (a `CONN_SIDECHAIN` with no `targetEntryId`, which `validateGraph`
 * names and no mutator can produce). It is skipped SILENTLY when the entry has
 * no key input right now: a bypassed entry that was never instantiated, an
 * effect that takes no key, or an entry the user has since deleted are all
 * ordinary states of a live document, not damage. Neither case can make noise:
 * an unconnected `keyIn` leaves its effect exactly as it was.
 */
export function wireRoutingGraph(
  graph: RoutingGraph,
  ends: RoutingEndpoints,
): Map<string, GainNode> {
  const gains = new Map<string, GainNode>();
  const master = ends.inputNodeOf(MASTER_ID);

  let order: string[];
  let degraded = false;
  try {
    order = topoOrder(graph);
  } catch (e) {
    degraded = true;
    // The UNION of the graph's nodes and the strips that actually exist. A
    // graph we could not order is a graph we cannot trust to be complete
    // either, so the live strips — not the file — decide who gets connected.
    const seen = new Set<string>();
    order = [];
    for (const id of [...graph.nodes.map((n) => n.id), ...ends.liveIds()]) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
    logError(
      'editor',
      `Routing graph could not be ordered (${e instanceof Error ? e.message : String(e)}) — ` +
        'falling back to every track straight to the master.',
    );
  }

  for (const id of order) {
    if (id === MASTER_ID) continue;
    const out = ends.outputNodeOf(id);
    if (!out) continue; // a node in the graph with no live strip (nothing to place)
    const destId = degraded ? MASTER_ID : (outputOf(graph, id) ?? MASTER_ID);
    const dest = ends.inputNodeOf(destId) ?? master;
    if (dest) out.connect(dest);
    if (degraded) continue; // a graph we could not order gets no send taps either
    for (const send of sendsFrom(graph, id)) {
      const target = ends.inputNodeOf(send.to);
      if (!target) continue; // a send at a node that no longer exists
      const g = ends.makeSendGain(send.gain);
      out.connect(g);
      g.connect(target);
      gains.set(sendKey(id, send.to), g);
    }
  }

  // Keys last. Not on the degraded path: a graph we could not order is one we
  // cannot trust to be acyclic either, and a key closes a Web Audio loop exactly
  // as an output does.
  if (!degraded && ends.keyInputOf) {
    for (const id of order) {
      for (const edge of sidechainsInto(graph, id)) {
        if (!edge.targetEntryId) {
          warnOnce(
            `sidechain:${edge.from}>${id}`,
            `Sidechain "${edge.from}" -> "${id}" names no effect entry (validateGraph reports it); `
              + 'the key is not connected.',
          );
          continue;
        }
        const source = ends.outputNodeOf(edge.from);
        if (!source) continue; // a key from a node with no live strip
        const key = ends.keyInputOf(id, edge.targetEntryId);
        if (!key) continue; // the entry is bypassed-and-uninstantiated, gone, or takes no key
        source.connect(key);
      }
    }
  }
  return gains;
}

/** One bus strip, as the mix writer sees it. `BusNodes` satisfies it. */
export interface BusMixNodes {
  gain: { gain: RampParam };
  muteGain: { gain: RampParam };
}

/** Push each bus's fader + mute onto its live strip (click-free). A bus with no
 *  strip yet is skipped rather than throwing, exactly as tracks are. */
export function applyBusMix(
  buses: readonly MixBus[],
  nodeFor: (busId: string) => BusMixNodes | undefined,
  nowSec: number,
): void {
  for (const b of buses) {
    const n = nodeFor(b.id);
    if (!n) continue;
    n.gain.gain.setTargetAtTime(clamp(b.volume, 0, 1), nowSec, RAMP_TC);
    n.muteGain.gain.setTargetAtTime(b.mute ? 0 : 1, nowSec, RAMP_TC);
  }
}

/** Push every send's amount onto its gain node (click-free). A send whose node
 *  is gone — a stale map between a graph edit and the rewire — is skipped. */
export function applySendGains(
  graph: RoutingGraph,
  gainFor: (key: string) => { gain: RampParam } | undefined,
  nowSec: number,
): void {
  for (const e of graph.edges) {
    if (e.connType !== CONN_SEND) continue;
    const node = gainFor(sendKey(e.from, e.to));
    if (!node) continue;
    node.gain.setTargetAtTime(e.gain, nowSec, RAMP_TC);
  }
}

/** Anything with a `disconnect()`. Every Web Audio node satisfies it. */
export interface Disconnectable { disconnect(): void }

/** A bus strip, as teardown sees it. `BusNodes` satisfies it. */
export interface DisposableBus {
  fx: { dispose(): void };
  input: Disconnectable;
  gain: Disconnectable;
  muteGain: Disconnectable;
  output: Disconnectable;
  /** The leaf meter tap, when the context could make one. */
  meter?: Disconnectable;
}

/** Tear down every bus strip and every send gain. Leaving either behind on a
 *  rebuild would leave a second, orphaned path into the master — the bus's
 *  contribution summed twice. */
export function disposeBusNodes(
  buses: Iterable<DisposableBus>,
  sends: Iterable<Disconnectable>,
): void {
  for (const b of buses) {
    try { b.fx.dispose(); b.input.disconnect(); b.gain.disconnect(); b.muteGain.disconnect(); b.output.disconnect(); b.meter?.disconnect(); } catch { /* gone */ }
  }
  for (const g of sends) {
    try { g.disconnect(); } catch { /* gone */ }
  }
}

/** (Re)build the session-local master bus + insert rack and route it into the
 *  shared engine master. Safe to call repeatedly (tears down the prior one). */
function buildMasterBus(): void {
  const ctx = getEngineCtx();
  disposeMasterVstChain();
  if (masterChain) { masterChain.dispose(); masterChain = null; }
  if (masterBus) { try { masterBus.disconnect(); } catch { /* gone */ } masterBus = null; }
  masterBus = ctx.createGain();
  const chain = useEditorStore.getState().masterFxChain;
  const vstChain = liveMasterVstChain();

  // MASTER VST RACK — where it goes, and when it is skipped.
  //
  // The two master racks are ordered the way the offline master bounce orders
  // them: `masterFxChain` (the psychoacoustic rack) first, then
  // `masterVstChain` (hosted plugins), so the live preview and the printed
  // master apply them in the same order.
  //
  // It is NOT built while a CURRENT frozen master is the preview. Freezing
  // renders the whole master, plugins included, and auditioning that render
  // through a live VST rack would process the plugins twice — the second pass
  // over a signal they have already shaped. `liveMasterVstChain` returns an
  // empty chain in exactly that case, and a stale frozen render (the signature
  // no longer matches the document) is not that case: what is being heard is
  // the live mix again, so the plugins belong in it.
  if (vstChain.length > 0) {
    masterVstNode = ctx.createGain();
    masterChain = buildEffectChain(ctx, masterBus, masterVstNode, chain);
    masterVstChainHandle = buildEffectChain(ctx, masterVstNode, getMasterGain(), vstChain);
  } else {
    masterChain = buildEffectChain(ctx, masterBus, getMasterGain(), chain);
  }
  lastMasterSig = chainTopoSig(chain);
  lastMasterFullSig = JSON.stringify(chain);
  lastMasterVstSig = chainTopoSig(vstChain);
  lastMasterVstFullSig = JSON.stringify(vstChain);
}

/**
 * The master VST entries that should SOUND right now — empty while a CURRENT
 * frozen master is the preview, because that render already contains them.
 *
 * "Current" is the freeze signature the render was made from still matching the
 * document: a stale frozen master means the user is hearing the live mix, and
 * the live mix includes its plugins.
 */
function liveMasterVstChain(): ChainEntry[] {
  const s = useEditorStore.getState();
  if (s.masterVstChain.length === 0) return [];
  if (s.previewMode === 'frozen' && s.frozenMaster) {
    const sig = documentFreezeSignature(s, getGlobalVoice());
    if (sig === s.frozenMaster.sig) return [];
  }
  return [...s.masterVstChain];
}

function disposeMasterVstChain(): void {
  if (masterVstChainHandle) { masterVstChainHandle.dispose(); masterVstChainHandle = null; }
  if (masterVstNode) { try { masterVstNode.disconnect(); } catch { /* gone */ } masterVstNode = null; }
  lastMasterVstSig = '';
  lastMasterVstFullSig = '';
}

/**
 * Reconcile the live master VST rack with the store. Adding or removing the
 * FIRST / LAST plugin changes the master's node topology (a stage node appears
 * or disappears between the two racks), so that case rebuilds the whole master
 * bus rather than trying to re-thread it in place.
 */
function applyMasterVstChainLive(): void {
  if (!masterBus) return;
  const chain = liveMasterVstChain();
  const full = JSON.stringify(chain);
  if (full === lastMasterVstFullSig) return;
  // A master VST lane reads back by the latency ahead of its plugin, and a
  // plugin added, moved or bypassed here moves that figure.
  refreshMasterAutomationDelays();
  const had = masterVstChainHandle !== null;
  if (had !== chain.length > 0) { buildMasterBus(); return; }
  lastMasterVstFullSig = full;
  const sig = chainTopoSig(chain);
  if (sig !== lastMasterVstSig) {
    lastMasterVstSig = sig;
    masterVstChainHandle?.rebuild(chain);
  } else {
    for (const e of chain) masterVstChainHandle?.updateParams(e.id, e.params);
  }
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
  // The master rack is downstream of the sum, so it has no comp row and
  // `syncTrackLatency` is never called for it — but a master FX lane still has
  // to know how much of this chain sits ahead of its entry. Master only: this
  // fires on every master knob drag and the track chains cannot have moved.
  refreshMasterAutomationDelays();
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
  let chainsMoved = false;
  const rebuilt: string[] = [];
  for (const [id, n] of trackNodes) {
    const chain = byId.get(id)?.fxChain ?? [];
    const full = JSON.stringify(chain);
    if (full === n.fxFullSig) continue;
    n.fxFullSig = full;
    chainsMoved = true;
    const topo = chainTopoSig(chain);
    if (topo !== n.fxTopoSig) { n.fxTopoSig = topo; n.fx.rebuild(chain); rebuilt.push(id); }
    else for (const e of chain) n.fx.updateParams(e.id, e.params);
  }
  rewireKeysAfterChainRebuild(rebuilt);
  // A track ADDED or REMOVED mid-playback changes the inputs of the sum without
  // moving any surviving track's signature: a new track has no node for the loop
  // above to compare against, and a removed one just stops being looked up — yet
  // `syncTrackLatency` computes `max()` over the STORE, so both change what every
  // other track must wait for. Compare the id sets so neither slips through.
  // (Equal sizes + every store id present == equal sets; both sides are unique.)
  const membershipMoved =
    tracks.length !== trackNodes.size || tracks.some((t) => !trackNodes.has(t.id));
  // Add / remove / reorder / bypass obviously changes what a chain declares, and
  // so can a param edit: `RackLatencySpec` may be a function of the entry's
  // params. So re-align on ANY of that and let `syncTrackLatency` decide whether
  // the numbers actually moved.
  if (chainsMoved || membershipMoved) syncTrackLatency();
}

/** Reconcile each BUS's live insert chain with the store — the track version
 *  above, over `buses`. A bus chain's latency lags every track routed into it,
 *  so a move here re-aligns the tracks, not the bus. */
function applyBusChainsLive(): void {
  const buses = useEditorStore.getState().buses;
  const byId = new Map<string, MixBus>(buses.map((b): [string, MixBus] => [b.id, b]));
  let chainsMoved = false;
  const rebuilt: string[] = [];
  for (const [id, n] of busNodes) {
    const chain = byId.get(id)?.fxChain ?? [];
    const full = JSON.stringify(chain);
    if (full === n.fxFullSig) continue;
    n.fxFullSig = full;
    chainsMoved = true;
    const topo = chainTopoSig(chain);
    if (topo !== n.fxTopoSig) { n.fxTopoSig = topo; n.fx.rebuild(chain); rebuilt.push(id); }
    else for (const e of chain) n.fx.updateParams(e.id, e.params);
  }
  rewireKeysAfterChainRebuild(rebuilt);
  if (chainsMoved) syncTrackLatency();
}

/**
 * Re-run the routing pass when a rack REBUILD landed on a strip something keys.
 *
 * A key connection is an edge into a node INSIDE a rack, and `buildEffectChain`
 * is free to replace that node: an entry whose effect id changed is disposed and
 * re-made, and — the case that actually bites — an entry that was BYPASSED when
 * the chain was first built has no instance at all, so it had no `keyIn` for the
 * routing pass to find, and enabling it later builds the instance without anyone
 * connecting the key. Both leave a project that says "keyed" playing unkeyed
 * until the next unrelated routing edit.
 *
 * Gated on the graph, so the overwhelming case — a rack rebuild on a strip
 * nothing keys — costs one `Set` walk and no node work. A rack edit that is only
 * a param push does not reach here at all: `rebuilt` is empty.
 */
function rewireKeysAfterChainRebuild(rebuilt: readonly string[]): void {
  if (rebuilt.length === 0) return;
  const graph = useEditorStore.getState().routing;
  const keyed = sidechainTargetIds(graph);
  if (keyed.size === 0) return;
  if (!rebuilt.some((id) => keyed.has(id))) return;
  wireRouting(graph);
}

/* Reconciliation signatures. Structure (which strips exist, and which edges
   connect them) forces node work; values (fader, mute, send amount) are pushed
   onto the running graph. Send GAINS are deliberately excluded from the
   structural signature — riding a send fader must not rebuild anything.

   Exported because that split IS the live behaviour and is worth pinning on its
   own: `applyRoutingLive` runs only inside a playing session, so a test can
   reach the decision (rebuild vs update) through these four and nothing else.
   See state/liveMixer.routing.test.ts, "the rebuild/update decision table". */

export function busMembershipSig(buses: readonly MixBus[]): string {
  let s = '';
  for (const b of buses) s += `${b.id}|`;
  return s;
}

export function routingStructureSig(g: RoutingGraph): string {
  let s = '';
  for (const n of g.nodes) s += `${n.id}:${n.kind}|`;
  s += '::';
  for (const e of g.edges) s += `${e.from}>${e.to}:${e.connType}:${e.targetEntryId ?? ''}|`;
  return s;
}

export function busMixSig(buses: readonly MixBus[]): string {
  let s = '';
  for (const b of buses) s += `${b.id}:${b.volume}:${b.mute ? 1 : 0}|`;
  return s;
}

export function sendGainSig(g: RoutingGraph): string {
  let s = '';
  for (const e of g.edges) if (e.connType === CONN_SEND) s += `${e.from}>${e.to}:${e.gain}|`;
  return s;
}

/** Seed the reconciliation signatures from the store, so the first subscription
 *  tick after a `start()` does not rebuild a graph that was just built. */
function resetRoutingSigs(): void {
  const s = useEditorStore.getState();
  lastBusMembershipSig = busMembershipSig(s.buses);
  lastRoutingSig = routingStructureSig(s.routing);
  lastBusMixSig = busMixSig(s.buses);
  lastSendGainSig = sendGainSig(s.routing);
}

/**
 * Reconcile the live routing with the store. Structural moves (a bus created or
 * deleted, an output repointed, a send added or removed) rebuild or rewire;
 * everything else is a value written onto the running graph, so riding a send
 * fader or muting a bus mid-playback costs no node work and makes no click.
 */
function applyRoutingLive(): void {
  const s = useEditorStore.getState();
  const ctx = getEngineCtx();
  let rewired = false;

  const membership = busMembershipSig(s.buses);
  if (membership !== lastBusMembershipSig) {
    lastBusMembershipSig = membership;
    buildBusNodes(s.buses);
    rewired = true; // fresh strips have no output edges at all
  }
  const structure = routingStructureSig(s.routing);
  if (rewired || structure !== lastRoutingSig) {
    lastRoutingSig = structure;
    wireRouting(s.routing);
    rewired = true;
  }

  applyBusChainsLive();

  const mix = busMixSig(s.buses);
  if (rewired || mix !== lastBusMixSig) {
    lastBusMixSig = mix;
    applyBusMix(s.buses, (id) => busNodes.get(id), ctx.currentTime);
  }
  const sends = sendGainSig(s.routing);
  if (rewired || sends !== lastSendGainSig) {
    lastSendGainSig = sends;
    applySendGains(s.routing, (key) => sendGains.get(key), ctx.currentTime);
  }

  // A reroute changes how much of the chain sits between a track and the
  // master, so the alignment moves even though no rack did.
  if (rewired) syncTrackLatency();
}

/* ── Plugin-delay compensation ────────────────────────────────────────────────
   An insert chain that looks ahead pushes its track's output LATE — a
   compressor's spec-mandated 6 ms pre-delay is the standard case — so summing a
   compressed track with a dry one smears the downbeat. The fix is the rule
   Tracktion's `SummingNode` applies (design only, from its described behaviour:
   Tracktion Engine is GPL-3/commercial and nothing is copied from it): delay
   each input of the sum by `max(latencies) - own`, so the slowest input sets the
   meeting point and never waits. `lib/rackEffects.summingDelaysSec` is that
   rule; the DJ decks apply it to their two decks and this applies it to the
   editor's tracks.

   The compensation sits on the far side of the panner, immediately before the
   summing bus, so it delays a track's whole contribution exactly once. The
   MASTER rack is downstream of the sum and therefore gets no per-track term.

   A project where nothing declares latency is UNCHANGED, not merely close: the
   spec gives `DelayNode.delayTime` a default of "0 (no delay)", and the only
   clamp on it ("If DelayNode is part of a cycle, then the value of the delayTime
   attribute is clamped to a minimum of one render quantum") does not apply here
   — panner -> comp -> summing bus is acyclic. Source: W3C Web Audio API,
   "The DelayNode Interface" > Attributes > delayTime
   (https://webaudio.github.io/web-audio-api/), read 2026-09-15. Cited by name
   because the spec's section numbers renumber as interfaces are added. */

/** One track's share of the summing alignment. */
export interface TrackCompRow {
  trackId: string;
  /** What this track's LIVE path to the master declares it lags by, in seconds:
   *  its own insert chain, plus the insert chain of every bus between it and the
   *  master. With no routing information it is just the track's own chain, which
   *  is what a graph of "everything straight to the master" evaluates to anyway. */
  latencySec: number;
  /** What its compensation delay must hold to meet the slowest track. */
  compSec: number;
  /** `ChainEntry.id`s (NOT effect names) this figure did not count, i.e. every
   *  entry `chainLatencyReport` marked `counted: false`. That is deliberately
   *  BOTH reasons an entry can be excluded, which a consumer has to tell apart
   *  itself by looking at the entry:
   *
   *   - BYPASSED. `buildEffectChain` routes it around, so it lags nothing live
   *     AND nothing at freeze/bounce. Excluded and staying excluded — this is
   *     also what makes a bypass toggle re-align the mixer.
   *   - UNRESOLVABLE. Every hosted `vst3` entry, and effects imported from
   *     another DAW: an inert passthrough in the live graph, so it lags nothing
   *     HERE, but it WILL print at freeze/bounce. This is the live/bounce gap,
   *     listed rather than silently dropped.
   *
   *  A consumer that only wants the second (a "this number excludes your
   *  plugins" warning) must filter to the entries that are `enabled`. */
  uncounted: string[];
}

/** The track fields the compensation math reads. `EditorTrack` satisfies it —
 *  and a FROZEN track satisfies it with an empty `fxChain`, because freezing
 *  prints the chain into the stem and stashes the original off to the side. */
export interface LatencyTrack {
  id: string;
  fxChain?: ChainEntry[];
}

/** The bus fields the compensation math reads. `EditorBus` satisfies it. */
export interface LatencyBus {
  id: string;
  fxChain?: ChainEntry[];
}

/** Where the signal actually goes, for the compensation math. Omit it and every
 *  track is treated as meeting at the master directly — which is both the
 *  pre-routing behaviour and what a default graph evaluates to. */
export interface LatencyRouting {
  graph: RoutingGraph;
  buses: readonly LatencyBus[];
}

/**
 * How much each track's compensation delay must hold, in the order given.
 *
 * PURE: no audio context, no store — the tracks, the registry seam, the sample
 * rate and (optionally) the routing go in, the delays come out. `resolve`
 * defaults to the real rack registry; `sampleRate` is passed through verbatim
 * for declarations expressed in samples (none today) and may be omitted.
 *
 * With buses, a track's lag is no longer just its own chain: a bus's insert
 * rack sits downstream of everything routed into it, so it lags every one of
 * those tracks equally. The figure per track is therefore
 * `chain(track) + Σ chain(bus)` along its `outputOf` path to the master, and
 * the alignment is ONE `summingDelaysSec` over those totals, written at each
 * track's own comp delay. Delaying at the track rather than at each summing
 * node is equivalent here because a bus's chain is a constant added to every
 * one of its inputs: equalising the totals at the master equalises them at
 * every intermediate sum as well.
 *
 * SENDS ARE NOT COMPENSATED in this step. A send is a second path with a
 * different length, so making both arrive together needs a delay on the send
 * tap itself, not on the track — a later §3.6 step. A send today therefore
 * arrives as early as its own path allows, which is what it did before buses
 * existed (there were no sends at all).
 */
export function trackCompDelays(
  tracks: readonly LatencyTrack[],
  resolve?: (id: string) => RackEffectDef | undefined,
  sampleRate?: number,
  routing?: LatencyRouting,
): TrackCompRow[] {
  const opts = { resolve, sampleRate };
  const reports = tracks.map((t) => chainLatencyReport(t.fxChain ?? [], opts));

  // Each bus's own chain, evaluated once however many tracks pass through it.
  const busReports = new Map<string, ChainLatencyReport>();
  for (const b of routing?.buses ?? []) busReports.set(b.id, chainLatencyReport(b.fxChain ?? [], opts));

  /** Everything downstream of `id`, up to (not including) the master. */
  const downstream = (id: string): ChainLatencyReport => {
    if (!routing) return { totalSec: 0, perEntry: [] };
    let totalSec = 0;
    const perEntry: ChainLatencyReport['perEntry'] = [];
    let cur = outputOf(routing.graph, id);
    // Bounded by the node count: `topoOrder` refuses a cyclic graph elsewhere,
    // but this must not spin on one that reached us from a project file.
    for (let hops = 0; cur !== null && cur !== MASTER_ID && hops <= routing.graph.nodes.length; hops += 1) {
      const r = busReports.get(cur);
      if (r) { totalSec += r.totalSec; perEntry.push(...r.perEntry); }
      cur = outputOf(routing.graph, cur);
    }
    return { totalSec, perEntry };
  };

  const paths = tracks.map((t, i) => {
    const below = downstream(t.id);
    return {
      totalSec: reports[i].totalSec + below.totalSec,
      // A hosted VST3 on a BUS is the same live/bounce gap as one on the track,
      // and it belongs to every track that passes through that bus.
      uncounted: [...reports[i].perEntry, ...below.perEntry].filter((e) => !e.counted).map((e) => e.id),
    };
  });

  const delays = summingDelaysSec(paths.map((p) => p.totalSec));
  return tracks.map((t, i) => ({
    trackId: t.id,
    latencySec: paths[i].totalSec,
    compSec: delays[i],
    uncounted: paths[i].uncounted,
  }));
}

/** The context surface a compensation delay needs. `AudioContext` satisfies it;
 *  so does a stand-in, which is what makes the wiring testable (the real context
 *  comes from `playerStore.ensureEngine()` off `window.AudioContext`). */
export interface CompNodeFactory {
  createDelay(maxDelayTime: number): DelayNode;
}

/** The comp node surface `applyCompDelays` writes. A `DelayNode` satisfies it. */
export interface CompDelayNode {
  delayTime: { setTargetAtTime(value: number, startTime: number, timeConstant: number): unknown };
}

/**
 * Splice one track's compensation delay in: `panner -> comp -> destination`.
 * Returns it at delayTime 0, which is a transparent passthrough — a project
 * where nothing declares latency sounds exactly as it did, one node heavier.
 *
 * `dest` is OPTIONAL since routing landed: where a track goes is an edge in the
 * graph, so `buildTrackNodes` leaves the comp's output unconnected and
 * `wireRoutingGraph` places it. Callers that already know the destination (the
 * two-node case, and the test that pins this splice) keep passing it.
 *
 * CHANNEL COUNT — why this `DelayNode` is pinned to stereo. A `DelayNode` on the
 * default `channelCountMode: 'max'` sizes its delay lines to its input's channel
 * count, so a count that DROPS mid-pass reallocates them and loses the samples
 * still inside; T18 measured that offline (max |Δ| 0.327 over the last 247
 * samples of a clip, as its sources went inactive) and pinned `channelCount = 2`
 * + `channelCountMode = 'explicit'` on the offline comp. The same pin is applied
 * here, so the live and offline comps are the same node.
 *
 * Belt and braces. Today it changes nothing: the input is ALWAYS the strip's
 * `StereoPannerNode` — `buildTrackNodes` is the only production caller and every
 * live strip has one — and per the W3C Web Audio API §1.30 "The output of this
 * node is hard-coded to stereo (2 channels) and cannot be configured" (§1.30.4
 * Channel Limitations: "producing exactly 2 channels"), read 2026-09-15, so the
 * count is already a constant 2 whatever the sources do and forcing 2 is a
 * no-op on the audio. The pin is what holds if that stops being true: `panner`
 * is typed `AudioNode`, and the offline renderer ALREADY has a panner-less strip
 * (`includeTrackMix: false` — a mono stem, where inserting a panner would
 * down-mix by 3 dB). The day a live strip does the same, the node is already
 * safe instead of depending on a caller's discipline.
 */
export function insertCompNode(ctx: CompNodeFactory, panner: AudioNode, dest?: AudioNode): DelayNode {
  const comp = ctx.createDelay(COMP_MAX_DELAY);
  // See CHANNEL COUNT above. Unconditional: the delay lines are sized once, by
  // this declaration, and no input can resize them out from under the samples
  // already in flight.
  comp.channelCount = 2;
  comp.channelCountMode = 'explicit';
  panner.connect(comp);
  if (dest) comp.connect(dest);
  return comp;
}

/**
 * Write the computed delays onto the live nodes. `setTargetAtTime` only — a
 * `setValueAtTime` jump on a `DelayNode` re-reads the delay line discontinuously
 * and clicks — and rows whose track has no live node yet are skipped rather than
 * throwing (a track added mid-playback has no nodes until the next `start()`).
 */
export function applyCompDelays(
  rows: readonly TrackCompRow[],
  nodeFor: (trackId: string) => CompDelayNode | undefined,
  nowSec: number,
): void {
  for (const r of rows) {
    const node = nodeFor(r.trackId);
    if (!node) continue;
    node.delayTime.setTargetAtTime(r.compSec, nowSec, COMP_TC);
  }
}

/* ── automation delays: where a lane's param sits INSIDE the chain ────────────
   `trackCompDelays` answers "how long until this track reaches the sum". The
   block below answers the other half, which is what automation needs: how much
   of that latency sits AHEAD of the thing a lane actually writes into. The fader
   IS the chain input and has none; the panner has the whole insert chain in
   front of it; effect k has the effects before it. Same `chainLatencyReport`
   walk, re-run at the same moments. */

/**
 * Seconds of declared latency AHEAD of each entry in one series chain, keyed by
 * `ChainEntry.id` — a prefix sum over `chainLatencyReport(...).perEntry`.
 *
 * This is the amount a param write on that entry has to be read BACK by: the
 * audio arriving at entry k right now entered the chain `prefix[k]` seconds ago,
 * so the value to write now is the one the lane held then. The first entry is
 * always 0; a bypassed or unresolvable entry contributes 0, because it is routed
 * around (or inert) and delays nothing; an id the chain does not contain is
 * absent from the record — read it as `?? 0`.
 *
 * Pure — no Web Audio, no store — so the live writer, the offline bounce and a
 * test all get the same numbers out of the same chain.
 */
export function entryPrefixLatencies(
  entries: ChainEntry[],
  opts: ChainLatencyOptions = {},
): Record<string, number> {
  return prefixFromReport(chainLatencyReport(entries, opts));
}

function prefixFromReport(report: ChainLatencyReport): Record<string, number> {
  const out: Record<string, number> = {};
  let ahead = 0;
  for (const e of report.perEntry) {
    // First occurrence wins. Chain ids are unique by construction; if a
    // malformed project ever repeats one, the EARLIER position is the
    // conservative answer (it can only under-delay, never over-).
    if (!(e.id in out)) out[e.id] = ahead;
    ahead += e.latencySec;
  }
  return out;
}

/** Where every automation target on ONE chain sits, in seconds of audio. */
interface ChainAutomationDelays {
  /** The whole chain's latency — what the PANNER, sitting after it, waits for. */
  panSec: number;
  /** Per-entry prefix sums for the FX lanes (see `entryPrefixLatencies`). */
  prefix: Record<string, number>;
}

const NO_CHAIN_DELAYS: ChainAutomationDelays = { panSec: 0, prefix: {} };

/** Cache, keyed by track id with one slot for the master rack, gated on a chain
 *  signature: the ~40 Hz FX writer reads these every frame while a chain only
 *  changes when the user edits it. Refreshed wherever the alignment is
 *  (`syncTrackLatency`, which every chain/membership/routing move already
 *  reaches) PLUS where a MASTER chain move is detected (`applyMasterChainLive`)
 *  — the master rack is downstream of the sum, so it has no comp row and the
 *  alignment pass never hears about it. */
let trackChainDelays = new Map<string, { sig: string; value: ChainAutomationDelays }>();
/** The same per BUS: a bus insert's lane reads back by what its own rack puts ahead of it. */
let busChainDelays = new Map<string, { sig: string; value: ChainAutomationDelays }>();
let masterChainDelays: { sig: string; value: ChainAutomationDelays } = { sig: '\0', value: NO_CHAIN_DELAYS };

/** The master's two racks in the order the audio meets them: the rack, then the
 *  VST chain. A master VST entry's prefix counts the whole rack ahead of it. */
const masterAutomationChain = (): ChainEntry[] => {
  const s = useEditorStore.getState();
  return s.masterVstChain.length === 0 ? s.masterFxChain : [...s.masterFxChain, ...s.masterVstChain];
};

/** Topology AND params: `RackLatencySpec` may be a function of an entry's params,
 *  so a knob turn can move these numbers. The same `JSON.stringify` gate the live
 *  chain reconcilers above already run on every store tick. */
const chainDelaySig = (entries: ChainEntry[], sampleRate: number | undefined): string =>
  `${sampleRate ?? ''}|${JSON.stringify(entries)}`;

const computeChainDelays = (
  entries: ChainEntry[], sampleRate: number | undefined,
): ChainAutomationDelays => {
  const report = chainLatencyReport(entries, { sampleRate });
  return { panSec: report.totalSec, prefix: prefixFromReport(report) };
};

/** Recompute (or re-use) the MASTER rack's automation delays. Split from the
 *  track pass so `applyMasterChainLive` — which fires on a master knob drag —
 *  does not re-stringify every track's chain to answer a question about one. */
function refreshMasterAutomationDelays(): void {
  const chain = masterAutomationChain();
  const sampleRate = getEngineOutputInfo()?.sampleRate;
  const sig = chainDelaySig(chain, sampleRate);
  if (sig === masterChainDelays.sig) return;
  masterChainDelays = { sig, value: computeChainDelays(chain, sampleRate) };
}

/** Recompute (or re-use) every live chain's automation delays. Cheap when
 *  nothing moved: one signature per chain and no walk. */
function refreshAutomationDelays(): void {
  const s = useEditorStore.getState();
  const sampleRate = getEngineOutputInfo()?.sampleRate;
  // Rebuilt rather than mutated, so a removed track's row cannot linger.
  const next = new Map<string, { sig: string; value: ChainAutomationDelays }>();
  for (const t of s.tracks) {
    const entries = t.fxChain ?? [];
    const sig = chainDelaySig(entries, sampleRate);
    const prev = trackChainDelays.get(t.id);
    next.set(t.id, prev && prev.sig === sig ? prev : { sig, value: computeChainDelays(entries, sampleRate) });
  }
  trackChainDelays = next;
  const nextBus = new Map<string, { sig: string; value: ChainAutomationDelays }>();
  for (const b of s.buses) {
    const sig = chainDelaySig(b.fxChain, sampleRate);
    const prev = busChainDelays.get(b.id);
    nextBus.set(b.id, prev && prev.sig === sig ? prev : { sig, value: computeChainDelays(b.fxChain, sampleRate) });
  }
  busChainDelays = nextBus;
  refreshMasterAutomationDelays();
}

/**
 * How much later than the clip carrying it a PAN breakpoint on `trackId` must be
 * written, in seconds.
 *
 * The track's OWN insert chain, and only that. The panner sits between the rack
 * and the comp delay, so everything downstream of it — the comp, a bus's rack,
 * the master — is BEHIND the param and cannot make it early.
 * (`TrackCompRow.latencySec` is the whole path to the sum: the right number for
 * the comp, and too big by the downstream buses' latency for this.)
 */
function panDelaySecFor(trackId: string | undefined): number {
  if (!trackId) return 0;
  return trackChainDelays.get(trackId)?.value.panSec ?? 0;
}

/** Per bus: how late the audio entering it runs behind the timeline in the
 *  live mix (`busInputLeadSec`). Refreshed by `syncTrackLatency`. */
let busInputLeads = new Map<string, number>();

/**
 * How late, in seconds, the audio ENTERING bus `busId` runs behind the timeline
 * in a compensated mix. Every track's comp holds `maxSec` less its whole path
 * to the master, so what arrives at a bus still has the bus's own rack and
 * every bus below it to pass: it is `maxSec` less those. 0 with no latency
 * anywhere. The offline render reads the same figure (lib/renderCore), so a
 * bus lane lands on the audio it was drawn for in both.
 */
export function busInputLeadSec(
  graph: RoutingGraph,
  busId: string,
  maxSec: number,
  chainSec: (busId: string) => number,
): number {
  let below = chainSec(busId);
  let cur = outputOf(graph, busId);
  for (let hops = 0; cur !== null && cur !== MASTER_ID && hops <= graph.nodes.length; hops += 1) {
    below += chainSec(cur);
    cur = outputOf(graph, cur);
  }
  return Math.max(0, maxSec - below);
}

/** How far BACK an FX lane on this entry has to read its value, in seconds.
 *  `owner` is the lane's `trackId`: the track's, or for a busFx lane the bus's. */
function fxPrefixSecFor(kind: AutomationTarget['kind'], owner: string | undefined, entryId: string): number {
  if (kind === 'masterFx') return masterChainDelays.value.prefix[entryId] ?? 0;
  if (!owner) return 0;
  if (kind === 'busFx') return (busInputLeads.get(owner) ?? 0) + (busChainDelays.get(owner)?.value.prefix[entryId] ?? 0);
  return trackChainDelays.get(owner)?.value.prefix[entryId] ?? 0;
}

/** Timeline position the FX writer reads a lane at: the frame's transport
 *  position `t`, pulled back by the latency ahead of that effect and held inside
 *  the project. Exported because it is the statement `applyFxAutomationFrame` is
 *  made of, and the frame itself cannot be driven without a live context and a
 *  rolling transport. */
export function fxLaneSampleTime(t: number, prefixSec: number, totalSec: number): number {
  const back = Number.isFinite(prefixSec) && prefixSec > 0 ? prefixSec : 0;
  return clamp(t - back, 0, totalSec);
}

/**
 * Re-align every live track against the current insert chains. Called wherever a
 * track chain is built, rebuilt or toggled — a bypassed entry contributes 0, so
 * flipping bypass re-syncs on its own.
 *
 * Computed over the STORE's tracks in store order, not over the node map, so the
 * numbers `trackLatencyReport` hands to the UI are the numbers the mixer is
 * actually holding. A store track with no node yet is simply not written.
 */
function syncTrackLatency(): void {
  // Ahead of BOTH early returns, like `refreshOutputLatency`: the automation
  // delays are read by `scheduleAutomation` (which `start()` calls immediately
  // after this) and by the FX writer, neither of which cares whether the COMP
  // values moved. Signature-gated per chain inside, so this is a no-op walk when
  // nothing changed.
  refreshAutomationDelays();
  if (trackNodes.size === 0) {
    // No live nodes to write to — but the OFFSET still has to be right, because
    // the next `start()` schedules against it before anything is rebuilt.
    refreshOutputLatency();
    return;
  }
  const ctx = getEngineCtx();
  const s = useEditorStore.getState();
  const rows = trackCompDelays(s.tracks, undefined, ctx.sampleRate, { graph: s.routing, buses: s.buses });
  // Ahead of the signature gate below, which cannot see this number move; see
  // `refreshOutputLatency`.
  refreshOutputLatency(rows);
  // Also ahead of the gate, for the same reason: a lone or already-slowest
  // track holds `compSec` at 0 no matter how far its `latencySec` sits past
  // `COMP_MAX_DELAY`, so the clamp verdict can flip without moving `sig` at
  // all. Gating this call on the write-skip below reports a clamp once and
  // then never again, and never un-reports one that clears (R1 finding 6).
  noteCompClamp(rows, s.tracks, { graph: s.routing, buses: s.buses });
  // What reaches each bus is late by the comps above it, so a bus insert's
  // lane reads back by that much more than its own rack (`fxPrefixSecFor`).
  const maxSec = rows.reduce((m, r) => Math.max(m, r.latencySec), 0);
  const busChains = new Map(s.buses.map((b) => [b.id, b.fxChain]));
  const chainSec = (id: string): number => chainLatencyReport(busChains.get(id) ?? [], { sampleRate: ctx.sampleRate }).totalSec;
  busInputLeads = new Map(s.buses.map((b) => [b.id, busInputLeadSec(s.routing, b.id, maxSec, chainSec)]));
  // Skip the writes when the alignment has not moved, so a knob turn (which
  // reaches here because a declaration MAY depend on params) does not put a
  // `setTargetAtTime` on every track for numbers that are already there.
  const sig = rows.map((r) => `${r.trackId}=${r.compSec}`).join('|');
  if (sig === lastCompSig) return;
  lastCompSig = sig;
  applyCompDelays(rows, (id) => trackNodes.get(id)?.comp, ctx.currentTime);
}

/**
 * Say so when a chain declares more latency than the mixer can compensate.
 *
 * The comp delays are `DelayNode`s built with `maxDelayTime = COMP_MAX_DELAY`
 * (1 s), and Web Audio clamps a `delayTime` above that SILENTLY: the other
 * tracks simply stay early and nothing anywhere says why. A plugin is the one
 * thing that can realistically declare that much (a mastering limiter's
 * look-ahead plus the bridge buffer), so its own row is where the warning
 * belongs.
 *
 * The flag goes on the LIVE VST entries of the PATH that declared the over-long
 * chain — the cause — not on the tracks that are waiting for it. That path is
 * the track's own insert chain PLUS every bus chain between it and the master,
 * because `row.latencySec` is the sum of all of them: a mastering limiter on a
 * bus can blow the ceiling on its own, and walking only the track chains left
 * the one row that could explain it unmarked.
 *
 * A bus is shared, so its verdict is the OR over every row that flows through
 * it: one quiet track must not clear a flag another track's path just set.
 * Reads the store and writes a boolean; it does NOT touch the compensation
 * math, which stays exactly as `trackCompDelays` computed it.
 */
export function noteCompClamp(
  rows: readonly TrackCompRow[],
  tracks: readonly EditorTrack[],
  routing?: LatencyRouting,
): void {
  const vst = useVstLiveStore.getState();
  const byTrack = new Map(tracks.map((t) => [t.id, t.fxChain ?? []]));
  const byBus = new Map((routing?.buses ?? []).map((b) => [b.id, b.fxChain ?? []]));

  /** entry id -> is it on at least one over-long path. */
  const verdict = new Map<string, boolean>();
  const judge = (entries: readonly ChainEntry[], over: boolean): void => {
    for (const e of entries) {
      if (e.effect !== 'vst3') continue;
      verdict.set(e.id, (verdict.get(e.id) ?? false) || over);
    }
  };
  /** The blamed track that caused a flag, for the one-line explanation. */
  let blame: TrackCompRow | null = null;

  for (const row of rows) {
    const over = row.latencySec > COMP_MAX_DELAY;
    if (over && !blame) blame = row;
    judge(byTrack.get(row.trackId) ?? [], over);
    if (!routing) continue;
    // Everything downstream of the track, up to (not including) the master —
    // the same walk `trackCompDelays` used to build `row.latencySec`, and
    // bounded by the node count so a cyclic graph from a project file cannot
    // spin here either.
    let cur = outputOf(routing.graph, row.trackId);
    for (let hops = 0; cur !== null && cur !== MASTER_ID && hops <= routing.graph.nodes.length; hops += 1) {
      judge(byBus.get(cur) ?? [], over);
      cur = outputOf(routing.graph, cur);
    }
  }

  for (const [entryId, over] of verdict) {
    const state = vst.entries[entryId];
    if (!state || state.status !== 'live') continue;
    if (state.clamped === over) continue;
    vst.setClamped(entryId, over);
    if (over && blame) {
      console.warn(
        `[liveMixer] track ${blame.trackId} declares ${blame.latencySec.toFixed(3)} s of latency, ` +
          `past the ${COMP_MAX_DELAY} s compensation ceiling — the other tracks cannot wait ` +
          `that long and will play early against it.`,
      );
    }
  }
}

/**
 * What the compensation is doing right now, for the UI and for the render-trim /
 * meter / automation-read offsets that build on it. Pure over the editor store
 * and the rack registry: it reads the engine's sample rate only if a graph
 * already exists, and never constructs one just to answer.
 */
export function trackLatencyReport(): { maxSec: number; perTrack: TrackCompRow[] } {
  const s = useEditorStore.getState();
  const perTrack = trackCompDelays(
    s.tracks,
    undefined,
    getEngineOutputInfo()?.sampleRate,
    { graph: s.routing, buses: s.buses },
  );
  return { maxSec: maxLatencySec(perTrack), perTrack };
}

/** The slowest path in a computed row set — the meeting point every comp delay
 *  is measured back from, and the output-wide offset of `outputLatencySec`. */
function maxLatencySec(rows: readonly TrackCompRow[]): number {
  let maxSec = 0;
  for (const r of rows) if (r.latencySec > maxSec) maxSec = r.latencySec;
  return maxSec;
}

/** Cache behind `outputLatencySec()` — see `refreshOutputLatency`. */
let outputLatency = 0;

/**
 * How far behind the transport the MIXER'S OUTPUT is, in seconds: the slowest
 * path from a track's chain input to the summing bus. 0 for a project that
 * declares no latency, so nothing built on this moves until something does.
 *
 * NOT the full mouth-to-ear figure. Two things are uncounted, both by design
 * (`trackCompDelays` walks track and bus chains only):
 *   - EVERYTHING DOWNSTREAM OF THE SUM — the master insert rack and the live
 *     master FX. A compressor on the master lags its 6 ms too, but it lags every
 *     track by the same amount and so needs no per-track comp; it is simply not
 *     in this number.
 *   - THE DEVICE ITSELF — `AudioContext.outputLatency` / `baseLatency`, the
 *     driver and buffer round trip.
 *
 * The arithmetic, which is the whole reason this is ONE number and not a
 * per-track table: audio entering track X's chain at node time `n` leaves the
 * mixer at `n + latency(X) + comp(X)`, and `comp(X)` is `maxSec - latency(X)` by
 * construction (`syncTrackLatency`, T09b) — so every track lands on `n + maxSec`.
 * That is what the comps are for. Hence:
 *
 *   - AUTOMATION READS need no per-track offset. A native VOLUME breakpoint is
 *     exact: `gain` is the chain input, so a value written at node time `n` lands
 *     on the audio that entered at `n` and the two travel the `maxSec` together
 *     (`scheduleAutomation` → `laneEnvelopeEvents` maps a breakpoint at timeline
 *     `p.t` to the same node time the clip scheduler maps it to).
 *     PAN and an in-chain FX param are a PER-PARAM offset, which a single
 *     output-wide number cannot carry and this one does not claim to — they
 *     carry their own. `panner` sits AFTER the inserts, so its envelope is
 *     scheduled `panSec` late (`laneEnvelopeEvents`'s `delaySec`, from
 *     `panDelaySecFor`); `applyFxAutomationFrame` writes into an effect that may
 *     have others ahead of it, so it reads each lane `prefix(entry)` back
 *     (`entryPrefixLatencies` → `fxLaneSampleTime`). A pan lane and a TRACK FX
 *     lane therefore land on the audio they were drawn for.
 *     TWO THINGS ARE STILL UNCOMPENSATED. A SEND: the lane on the effect a send
 *     is tapped into carries that effect's prefix and nothing about the send's
 *     own path. And a MASTER-RACK lane's remaining `maxSec`: the master chain's
 *     INPUT is the post-comp sum (`comp -> masterBus -> masterChain`), so the
 *     audio reaching a master effect entered its track's chain `maxSec` ago ON
 *     TOP OF that effect's own prefix — `prefix(entry)` alone leaves such a lane
 *     early by exactly this number. Adding it to the master prefix is a design
 *     call (it couples a per-frame read to the alignment, and the offline
 *     bounce's equivalent is the render trim), deliberately NOT taken here.
 *   - THE RECORDER'S ANCHOR needs no offset either. A take captured at transport
 *     `n` is heard at `n + maxSec` like every other source, so
 *     `currentTransportSec()` stays un-shifted and placing a take at it is
 *     already correct. (The INPUT round trip is a different number, and
 *     `recordingEngine.takeClipPlacement` already carries it.)
 *   - WHAT IS OFF is the timeline the user SEES against what is being HEARD:
 *     with the transport at `t` the output is playing `t - maxSec`. The moving
 *     line is a picture of the audible moment, so `publishPlayhead` subtracts
 *     this; the transport position does not.
 *   - METERS are already compensated: `levelsStore` taps `playerStore`'s
 *     `getMeterTap()`, which is the end of the MASTER chain — post-sum and
 *     therefore post-comp for every track. A future PER-TRACK meter would not
 *     be, and must tap after `TrackNodes.comp` (noted there).
 *
 * Reads a cache, because `tick()` asks once per animation frame and
 * `trackCompDelays` allocates a row per track. Render trim computes its own from
 * `trackLatencyReport()` in `lib/renderCore` (T14), off the transport's clock.
 */
export function outputLatencySec(): number {
  return outputLatency;
}

/**
 * Recompute the cached offset and hand it back. Pass the rows when the caller
 * has already computed them, so the alignment pass does not walk the chains
 * twice.
 *
 * This sits AHEAD of `syncTrackLatency`'s `lastCompSig` gate, not behind it,
 * because that signature is blind to this number: it is built from the COMP
 * values, and a lone track whose chain goes from 0 to 6 ms keeps `compSec` at 0
 * (it is its own meeting point) while `maxSec` moves 0 → 6 ms. Gating the
 * refresh on the signature would leave the playhead uncompensated for exactly
 * that project.
 */
export function refreshOutputLatency(rows?: readonly TrackCompRow[]): number {
  outputLatency = maxLatencySec(rows ?? trackLatencyReport().perTrack);
  return outputLatency;
}

/** Tear down every bus strip and send gain and empty both maps. Separate from
 *  `disposeTrackNodes` because the store subscription rebuilds the bus half on
 *  its own when the bus set changes and the tracks are untouched. */
function disposeBusGraph(): void {
  disposeBusNodes(busNodes.values(), sendGains.values());
  busNodes = new Map();
  sendGains = new Map();
}

/** Dispose every track's FX handle + nodes (oscillators in some effects must be
 *  stopped explicitly), and the bus/send half of the graph with them. Leaves the
 *  trackNodes map for the caller to replace. */
function disposeTrackNodes(): void {
  for (const n of trackNodes.values()) {
    try { n.fx.dispose(); n.gain.disconnect(); n.muteGain.disconnect(); n.panner.disconnect(); n.comp.disconnect(); n.meter?.disconnect(); } catch { /* gone */ }
  }
  // Buses and sends only exist to carry tracks, and a send gain left behind
  // would keep a second path into the master alive after its source is gone.
  disposeBusGraph();
}

/** (Re)build every bus strip. Call BEFORE `wireRouting`, which places them. */
function buildBusNodes(buses: MixBus[]): void {
  const ctx = getEngineCtx();
  disposeBusGraph();
  busNodes = new Map();
  for (const b of buses) busNodes.set(b.id, createBusNodes(ctx, b));
}

/**
 * Re-hang every strip's meter tap off the end of its strip.
 *
 * `wireRouting` clears the OUTPUT side of every strip with a bare
 * `disconnect()`, which takes down ALL of that node's edges — the meter tap
 * included, because it hangs off the very node the rewire is clearing. The tap
 * is not part of the routing and must not be rebuilt by it, so it is simply
 * re-attached here, after the sweep and before the graph is walked. The ONLY
 * ordering requirement is "after the disconnects", because that is what removes
 * the tap; re-attaching is idempotent, since connecting an edge that already
 * exists is ignored rather than doubled.
 */
function reconnectLeafTaps(): void {
  for (const n of trackNodes.values()) {
    if (n.meter) { try { n.comp.connect(n.meter); } catch { /* gone */ } }
  }
  for (const n of busNodes.values()) {
    if (n.meter) { try { n.output.connect(n.meter); } catch { /* gone */ } }
  }
}

/**
 * (Re)connect every track and bus according to the graph. Idempotent: the main
 * outputs are disconnected first, and the previous send gains are disposed, so
 * calling this after a routing edit rewires rather than doubling.
 *
 * Only the OUTPUT side is torn down — a strip's internal wiring
 * (`gain -> muteGain -> [fx] -> panner -> comp`) and its FX instances survive a
 * reroute, which is what keeps a reverb tail alive when the user moves a track
 * from the master to a bus mid-playback.
 */
function wireRouting(graph: RoutingGraph): void {
  const ctx = getEngineCtx();
  const master: AudioNode = masterBus ?? getMasterGain();
  for (const n of trackNodes.values()) { try { n.comp.disconnect(); } catch { /* gone */ } }
  for (const n of busNodes.values()) { try { n.output.disconnect(); } catch { /* gone */ } }
  for (const g of sendGains.values()) { try { g.disconnect(); } catch { /* gone */ } }
  reconnectLeafTaps(); // the sweep above took the meters down with the routing
  sendGains = wireRoutingGraph(graph, {
    outputNodeOf: (id) => trackNodes.get(id)?.comp ?? busNodes.get(id)?.output,
    inputNodeOf: (id) => (id === MASTER_ID ? master : busNodes.get(id)?.input),
    makeSendGain: (gain) => {
      const g = ctx.createGain();
      g.gain.value = gain;
      return g;
    },
    liveIds: () => [...trackNodes.keys(), ...busNodes.keys()],
    // The key input of one entry on one strip's rack. Tracks and buses share the
    // routing node namespace (`editorStore.removeBus` says so), so one lookup
    // over both maps is exact rather than merely convenient.
    keyInputOf: (nodeId, entryId) => {
      const fx = trackNodes.get(nodeId)?.fx ?? busNodes.get(nodeId)?.fx;
      return fx?.instances().find((i) => i.id === entryId)?.inst.keyIn;
    },
  });
}

/** Node ids that some `CONN_SIDECHAIN` edge keys. A rack REBUILD on one of these
 *  can replace the very instance a key is connected to, so the caller re-wires.
 *  Exported because it is the whole of that decision and the code around it
 *  touches the module's live singletons; see `state/liveMixer.sidechain.test.ts`. */
export function sidechainTargetIds(graph: RoutingGraph): Set<string> {
  const ids = new Set<string>();
  for (const e of graph.edges) if (e.connType === CONN_SIDECHAIN) ids.add(e.to);
  return ids;
}

/** Build (or rebuild) per track: gain -> [insert FX] -> panner -> comp. Where the
 *  comp goes is an EDGE now, not a constant, so it is left unconnected for
 *  `wireRouting` to place; the delays are aligned by `syncTrackLatency` once all
 *  of them exist. */
function buildTrackNodes(tracks: EditorTrack[]): void {
  const ctx = getEngineCtx();
  disposeTrackNodes();
  trackNodes = new Map();
  lastCompSig = ''; // fresh nodes open at 0; the alignment must be written, not skipped
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
    const comp = insertCompNode(ctx, panner); // panner -> comp; wireRouting places the rest
    const meter = makeStripMeter(ctx, comp); // leaf tap, POST-comp; see TrackNodes.comp
    trackNodes.set(t.id, {
      gain,
      muteGain,
      panner,
      comp,
      meter,
      fx,
      fxFullSig: JSON.stringify(chain),
      fxTopoSig: chainTopoSig(chain),
    });
  }
  syncTrackLatency(); // align the freshly built chains before anything plays
}

// A MIDI clip is whatever lib/clipEditTarget says it is — one classifier for UI and engine.

/* ── Per-clip schedule math ───────────────────────────────────────────────────
   One clip becomes one or more buffer-source plays. With none of T07a's fields
   that is a single play of the clip's length at unit rate, exactly as it always
   was. `timeStretchRate` rides the source's `playbackRate` instead of a
   destructive re-render; `warpMarkers` split the clip into one play per warp
   segment, each with its own rate. The computation is PURE — no audio context,
   no store — so the live scheduler here and the three offline bounces in
   WaveformEditor schedule from the same arithmetic, and so it is testable on
   its own (state/liveMixer.schedule.test.ts). */

/** The clip fields the schedule math reads. `AudioClip` satisfies it. */
export interface ScheduleClip {
  offsetIntoSource: number;
  durationSec: number;
  timeStretchRate?: number;
  stretchMode?: 'repitch' | 'offline';
  warpMarkers?: WarpMarker[];
}

/** One `AudioBufferSourceNode` worth of playback. All times are seconds. */
export interface ScheduledSegment {
  /** Offset from the clip's HEAD at which this piece starts on the timeline —
   *  add the clip's own start (live: its context time) to place it. */
  targetStart: number;
  /** Offset from the clip's head at which it ends. */
  targetEnd: number;
  /** Where in the decoded buffer this piece starts reading. */
  sourceOffset: number;
  /** How much of the buffer it reads: timeline length x `playbackRate`. */
  sourceDuration: number;
  /** `AudioBufferSourceNode.playbackRate` for this piece. */
  playbackRate: number;
}

export interface ClipSchedule {
  /** The clip's EFFECTIVE length on the timeline, once the decoded buffer's real
   *  length, the stretch rate and the warp map are known. Every fade site passes
   *  it to `applyFadeAutomation` as `effectiveDurationSec`, so a fade-out lands
   *  on the end of the audio that actually plays rather than fading past audio
   *  that is not there. (`lib/clipFade` caps it at `clip.durationSec`, so a warp
   *  map that runs the clip PAST its box still fades over the box.) Unaffected
   *  by a mid-clip start: the envelope describes the whole clip either way. */
  durationSec: number;
  /** In timeline order, and already trimmed to the requested start point. */
  segments: ScheduledSegment[];
}

/** How close to the end of a decoded buffer a clip's offset may land. Keeps a
 *  clip whose offset runs past its (re-decoded, slightly shorter) buffer
 *  audible instead of silent — the app's behaviour since before this module. */
const SOURCE_END_GUARD = 0.01;

/** The rate `playbackRate` must ride. An 'offline' stretch is already baked into
 *  the clip's blob, so it schedules like an unstretched clip; anything that is
 *  not a usable positive rate falls back to unity rather than silencing a clip. */
const stretchRateOf = (clip: ScheduleClip): number => {
  if (clip.stretchMode === 'offline') return 1;
  const rate = clip.timeStretchRate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1;
};

/**
 * Does this segment list actually bend time?
 *
 * `warpSegments` discards markers it cannot use — not finite, before the head of
 * the source, past its end — and a clip whose markers ALL go that way is handed
 * back the identity map: the whole source, once, at rate 1. So is a clip whose
 * only marker restates where the source already ends. Neither is a warp, and
 * treating them as one would silently drop the clip's `timeStretchRate`, so they
 * fall through to the ordinary stretch path instead.
 */
const isWarp = (segments: readonly WarpSegment[], sourceSpan: number): boolean => {
  if (segments.length === 0) return false;
  if (segments.length > 1) return true;
  const only = segments[0];
  return !(
    only.sourceStart === 0 && only.targetStart === 0
    && only.sourceEnd === sourceSpan && only.targetEnd === sourceSpan
  );
};

/**
 * How to play one clip out of `bufferDurationSec` seconds of decoded audio,
 * starting `fromClipSec` seconds into the clip (0 for an offline bounce, the
 * seek position for a mid-clip start). Returns `null` when there is nothing
 * left to play — no buffer, a zero-length clip, or a start past its end.
 */
export function computeClipSchedule(
  clip: ScheduleClip,
  bufferDurationSec: number,
  fromClipSec = 0,
): ClipSchedule | null {
  if (!Number.isFinite(bufferDurationSec) || bufferDurationSec <= 0) return null;
  const baseOffset = Math.min(clip.offsetIntoSource, Math.max(0, bufferDurationSec - SOURCE_END_GUARD));
  const available = bufferDurationSec - baseOffset;
  if (!(available > 0)) return null;

  // Markers are anchored against the clip's own stretch of source, so the map is
  // closed over the source the clip actually owns — a buffer shorter than the
  // clip shortens the map with it.
  const sourceSpan = Math.min(clip.durationSec, available);
  const markers = clip.warpMarkers;
  const warped = markers && markers.length > 0 ? warpSegments(markers, sourceSpan) : [];

  let segments: ScheduledSegment[];
  if (isWarp(warped, sourceSpan)) {
    // The markers already say where every moment lands, so `timeStretchRate` is
    // NOT applied on top of them. The map can re-time audio PAST the clip's own
    // box (`warpSegments` closes it by continuing at rate 1 from the last
    // marker), and the box is what the timeline draws, what the offline renders
    // are sized from, and what the fade envelope spans — so the schedule is
    // clamped to it. Without that, preview would play a tail that export cuts.
    segments = [];
    for (const seg of warped) {
      // A pathological map can place a later segment earlier, so this is a skip
      // and not a break.
      if (!(seg.targetStart < clip.durationSec)) continue;
      const targetEnd = Math.min(seg.targetEnd, clip.durationSec);
      segments.push({
        targetStart: seg.targetStart,
        targetEnd,
        sourceOffset: baseOffset + seg.sourceStart,
        // Untrimmed, the source span is the map's own — recomputing it from the
        // rate would only add float noise.
        sourceDuration: targetEnd === seg.targetEnd
          ? seg.sourceEnd - seg.sourceStart
          : (targetEnd - seg.targetStart) * seg.playbackRate,
        playbackRate: seg.playbackRate,
      });
    }
  } else {
    const playbackRate = stretchRateOf(clip);
    // At rate r, one timeline second eats r source seconds, so the buffer runs
    // out after `available / r` seconds of timeline.
    const targetEnd = Math.min(clip.durationSec, available / playbackRate);
    segments = targetEnd > 0
      ? [{
          targetStart: 0,
          targetEnd,
          sourceOffset: baseOffset,
          sourceDuration: targetEnd * playbackRate,
          playbackRate,
        }]
      : [];
  }
  if (segments.length === 0) return null;
  // The max, not the last: see the skip above.
  const durationSec = segments.reduce((end, seg) => Math.max(end, seg.targetEnd), 0);

  const from = Number.isFinite(fromClipSec) && fromClipSec > 0 ? fromClipSec : 0;
  const playable: ScheduledSegment[] = [];
  for (const seg of segments) {
    if (seg.targetEnd <= from) continue;                        // already finished
    if (seg.targetStart >= from) { playable.push(seg); continue; } // still ahead
    // The playhead is inside this one: skip into it at ITS playback rate.
    const skipped = (from - seg.targetStart) * seg.playbackRate;
    playable.push({
      targetStart: from,
      targetEnd: seg.targetEnd,
      sourceOffset: seg.sourceOffset + skipped,
      sourceDuration: seg.sourceDuration - skipped,
      playbackRate: seg.playbackRate,
    });
  }
  if (playable.length === 0) return null;
  return { durationSec, segments: playable };
}

/** Everything `scheduleClipSources` reads off a clip. `AudioClip` satisfies it
 *  structurally, and building one in a test needs no Blob. */
export type SchedulableClip = ScheduleClip & FadeClip & {
  id: string;
  startSec: number;
  gain?: number;
  /** Which of the clip's takes its mirrored source fields hold; undefined = 0.
   *  Read ONLY to ask the buffer resolver below for that take — the schedule
   *  maths never sees it. */
  activeTakeIndex?: number;
  /** Alternate recordings. Present with a `comp` naming two or more of them,
   *  this clip plays one stretch per comp region (see `compParts`); present
   *  without one, the clip's own mirrored fields ARE the active take and
   *  nothing here behaves differently. */
  takes?: ClipTake[];
  comp?: CompRegion[];
};

/** Which decoded buffer a given take plays from, for a caller that has more
 *  than one (a comped clip). Returning undefined means "nothing decoded for
 *  that take", which schedules nothing, exactly as a missing buffer always
 *  has. A caller with ONE buffer passes the `AudioBuffer` itself. */
export type TakeBufferResolver = (takeIndex: number) => AudioBuffer | undefined;

/** The audio-context surface the per-clip wiring needs — the two factories, and
 *  nothing else. `AudioContext` satisfies it; so does a stand-in. The real one
 *  is built by `playerStore.ensureEngine()` off `window.AudioContext`, which a
 *  test cannot supply, so the seam that makes this testable lives here. */
export interface ClipNodeFactory {
  createGain(): GainNode;
  createBufferSource(): AudioBufferSourceNode;
}

export interface ScheduledClipNodes {
  /** The clip's live mute gate, for the caller to key by clip id. */
  muteGate: GainNode;
  /** One source per played segment, in the schedule's order. */
  sources: AudioBufferSourceNode[];
}

export interface ScheduleClipOptions {
  /** Called ONCE, after the last of this clip's sources has ended and the
   *  shared nodes are disconnected. The live scheduler releases the clip's
   *  decode-cache pins here; an offline render passes nothing. It does NOT fire
   *  when the caller tears the sources down itself (`clearSources` nulls every
   *  `onended` before stopping), which is why the live path also holds its pins
   *  in a list it can release directly. */
  onEnded?: () => void;
}

/* ── Comping: one clip, several takes ─────────────────────────────────────────
   A comped clip plays a different take over each stretch of its length. The
   MODEL for that is `lib/clipComp` — which region owns which stretch, and how
   far the two sides of a boundary overlap — and it is pure arithmetic shared
   with the offline renderer, so preview and export cannot drift. What is here
   is only the wiring: one `computeClipSchedule` per comp segment (so every bit
   of warp/stretch/seek maths above is reused untouched), each on its own gain
   carrying the boundary crossfade, all of them feeding the clip's ONE fade
   envelope and its ONE mute gate. */

/** One stretch of a clip that plays from one buffer: a comp segment, or — for
 *  every clip that is not comped — the whole clip. */
interface ClipPart {
  buffer: AudioBuffer;
  /** Where this part opens, measured from the clip's head. 0 when not comped. */
  startSec: number;
  /** How far INTO the part playback begins (the seek position, rebased). */
  intoPart: number;
  /** The part's own schedule, with `targetStart` measured from the part's head. */
  schedule: ClipSchedule;
  /**
   * The boundary crossfades at this part's two ends, in seconds. Both 0 when not
   * comped, and at a butt cut.
   *
   * ALREADY FITTED to `schedule.durationSec`, so `clipFade.clampClipFades` never
   * has to choose a side. `lib/clipComp` guarantees the two fit inside the
   * segment's NOMINAL length, but a take whose decoded buffer runs out early
   * shortens the part under them, and the clamp's tie-break would then shrink
   * whichever side it likes — turning a seam that summed to unity into one that
   * ducks. The fade-IN wins here instead: it is the seam with audio on both
   * sides of it, while a fade-out that no longer fits is one whose audio has
   * already run out. (Where the outgoing take is the one that ran out, the seam
   * does not sum — there is no audio left there to sum with. Nothing can fix
   * that but decoding more audio.)
   */
  fadeInSec: number;
  fadeOutSec: number;
}

interface ClipParts {
  /** True only when the comp branch really produced the parts. A clip with
   *  takes but no comp, and one that fell back (warp + comp), is false — and
   *  false is what keeps the node set of every clip playing today identical. */
  comped: boolean;
  parts: ClipPart[];
  /** The clip's playable length, for the whole-clip fade envelope. Independent
   *  of where the playhead is, exactly as `ClipSchedule.durationSec` is. */
  durationSec: number;
}

/** Warnings that describe a CLIP rather than a moment, emitted once per clip:
 *  playback re-schedules on every play, seek and loop restart, and the same
 *  sentence sixty times over is noise, not a diagnostic. */
const scheduleWarned = new Set<string>();

/** A comp the app has no defined behaviour for. A PERMANENT property of the
 *  clip, so it is said once and not again until the clip is edited away. */
const WARN_WARP_COMP = 'warp-comp:';
/** A take that has not decoded. TRANSIENT — it may be there on the next play —
 *  so this class is forgotten at the top of every scheduling pass and a gap that
 *  is still there says so again. */
const WARN_TAKE_BUFFER = 'take-buffer:';

function warnOnceForClip(key: string, msg: string): void {
  if (scheduleWarned.has(key)) return;
  scheduleWarned.add(key);
  logWarn('editor', msg);
}

/**
 * Forget clip warnings so they can be said again.
 *
 * `'transient'` drops only the conditions that can come and go (a take that had
 * not decoded yet) and is what every scheduling pass does; `'all'` drops the
 * permanent ones too and belongs to `dispose()`, where the session's clips stop
 * being this module's clips.
 */
export function resetScheduleWarnings(scope: 'transient' | 'all' = 'transient'): void {
  if (scope === 'all') { scheduleWarned.clear(); return; }
  for (const key of [...scheduleWarned]) {
    if (key.startsWith(WARN_TAKE_BUFFER)) scheduleWarned.delete(key);
  }
}

/**
 * Split a clip into the parts that will play.
 *
 * Not comped — the overwhelmingly common case — is ONE part: the active take's
 * buffer and the clip's own schedule, i.e. precisely what this function's caller
 * did inline before comping existed.
 *
 * Comped is one part per `compSegments` entry. Each gets a synthetic
 * `ScheduleClip` whose source offset is its take's own offset advanced by the
 * segment's position (at the clip's stretch rate, since one timeline second eats
 * `rate` source seconds) and whose length is the segment's, so the shared
 * `computeClipSchedule` does all of the offset/rate/buffer-ran-out/seek maths
 * for a segment exactly as it does for a clip.
 *
 * v1: a clip carrying warp markers AND a comp plays its ACTIVE TAKE only. What a
 * warp map means when each stretch comes from a different recording — whether
 * the markers are the clip's or each take's — is undecided, and guessing would
 * bake the guess into saved projects. It says so once, in the log.
 */
function compParts(
  clip: SchedulableClip,
  resolve: TakeBufferResolver,
  into: number,
): ClipParts | null {
  const takes = clip.takes;
  const wantsComp = isComped(clip) && !!takes && takes.length > 1;
  const warped = (clip.warpMarkers?.length ?? 0) > 0;

  if (wantsComp && warped) {
    warnOnceForClip(
      `${WARN_WARP_COMP}${clip.id}`,
      `Clip "${clip.id}" has both warp markers and a comp; playing the active take only `
      + '(warping a comp is not defined yet).',
    );
  }

  if (wantsComp && !warped && takes) {
    const segments = compSegments(
      normalizeComp(clip.comp, takes.length, clip.durationSec),
      clip.durationSec,
    );
    if (segments.length > 0) {
      const parts: ClipPart[] = [];
      let durationSec = 0;
      let missing = false;
      for (const seg of segments) {
        const take = takes[seg.takeIndex];
        // `clipComp` sanitizes the structure but cannot know what decoded: a
        // take whose buffer is not in the cache schedules nothing, the same as
        // a clip whose own blob has not decoded. Skip it, say so once, never
        // throw — the rest of the comp still plays.
        const buffer = take ? resolve(seg.takeIndex) : undefined;
        if (!buffer) { missing = true; continue; }
        const length = seg.endSec - seg.startSec;
        const synthetic: ScheduleClip = {
          offsetIntoSource: take.offsetIntoSource + seg.startSec * stretchRateOf(clip),
          durationSec: length,
          timeStretchRate: clip.timeStretchRate,
          stretchMode: clip.stretchMode,
        };
        // From the part's head, so `durationSec` is the part's full playable
        // length whatever the playhead is doing (`computeClipSchedule` derives
        // it before it trims), and so a part the playhead has already passed
        // still contributes to the clip's effective length.
        const full = computeClipSchedule(synthetic, buffer.duration, 0);
        if (!full) continue;
        durationSec = Math.max(durationSec, seg.startSec + full.durationSec);
        const intoPart = Math.max(0, into - seg.startSec);
        const schedule = intoPart > 0
          ? computeClipSchedule(synthetic, buffer.duration, intoPart)
          : full;
        if (!schedule) continue; // the playhead is past this segment
        // Fit the two seam fades inside what this part can actually play, so
        // `clampClipFades` never has to pick a side. See `ClipPart`.
        const playable = schedule.durationSec;
        const fadeInSec = Math.min(seg.fadeInSec, playable);
        const fadeOutSec = Math.max(0, Math.min(seg.fadeOutSec, playable - fadeInSec));
        parts.push({ buffer, startSec: seg.startSec, intoPart, schedule, fadeInSec, fadeOutSec });
      }
      if (missing) {
        warnOnceForClip(
          `${WARN_TAKE_BUFFER}${clip.id}`,
          `Clip "${clip.id}": a comped take has no decoded audio; those stretches are silent.`,
        );
      }
      if (parts.length === 0) return null;
      return { comped: true, parts, durationSec };
    }
  }

  // Not comped (or fallen back): ONE buffer, the clip's own schedule.
  const buffer = resolve(clip.activeTakeIndex ?? 0);
  if (!buffer) return null; // nothing decoded for that take
  const schedule = computeClipSchedule(clip, buffer.duration, into);
  if (!schedule) return null;
  return {
    comped: false,
    durationSec: schedule.durationSec,
    parts: [{ buffer, startSec: 0, intoPart: into, schedule, fadeInSec: 0, fadeOutSec: 0 }],
  };
}

/**
 * Wire one clip up for playback and start it:
 *
 *     source(s) ─▶ clipGain (fade envelope) ─▶ muteGate ─▶ destination
 *
 * `nowSec` is the context's current time (captured once for the whole pass, so
 * every clip is placed against the same instant) and `fromSec` is the timeline
 * position playback starts at. A warped clip gets one source per warp segment;
 * they share the one envelope and the one gate, which are therefore torn down
 * only once the LAST source has ended. Returns `null` — having built nothing —
 * when the clip has nothing left to play.
 *
 * `buf` is either the one decoded buffer to play, or a resolver that maps a
 * take index to one. Both do the same thing here: a plain buffer is wrapped as
 * `() => buf`, and either way the buffer is resolved ONCE, for the clip's
 * active take. The resolver form exists so a comping caller can hand over
 * several takes' buffers through this one seam instead of a second scheduler.
 */
export function scheduleClipSources(
  ctx: ClipNodeFactory,
  clip: SchedulableClip,
  buf: AudioBuffer | TakeBufferResolver,
  destination: AudioNode,
  nowSec: number,
  fromSec: number,
  options: ScheduleClipOptions = {},
): ScheduledClipNodes | null {
  const resolve: TakeBufferResolver = typeof buf === 'function' ? buf : () => buf;
  // How far into this clip the playhead already is (0 if clip is in the future).
  const into = Math.max(0, fromSec - clip.startSec);
  // ONE part for every clip that is not comped — the active take's buffer and
  // the clip's own schedule, exactly as this read them inline before comping —
  // and one part per comp segment when it is.
  const plan = compParts(clip, resolve, into);
  if (!plan) return null;

  // Every source, across every part — the shared nodes go when the LAST of them
  // ends, not when the last one of some part does. Counted BEFORE anything is
  // built: a plan with no sources at all cannot happen (`computeClipSchedule`
  // returns null rather than an empty segment list, and `compParts` keeps no
  // part for a null schedule), and counting here means that if it ever did, it
  // would cost no nodes instead of leaving a connected pair behind.
  let pending = 0;
  for (const part of plan.parts) pending += part.schedule.segments.length;
  if (pending === 0) return null;

  const clipStartCtx = nowSec + (clip.startSec - fromSec); // may be < now when straddling

  // Per-clip fade envelope on a dedicated gain (track volume lives on trackGain).
  // `peak` is the clip's own gain — the envelope rises to it instead of to unity,
  // so clip gain lands before the track fader and its insert FX, matching the
  // three offline bounce paths in WaveformEditor. The envelope is applied ONCE,
  // over the whole clip, however many segments the clip plays as — a comp is no
  // exception: its seams are separate gains UNDER this one.
  const clipGain = ctx.createGain();
  applyFadeAutomation(clipGain.gain, clip, clipStartCtx, into, {
    peak: clipPeakGain(clip),
    effectiveDurationSec: plan.durationSec,
  });

  // Live mute gate, kept separate from clipGain so a mid-playback mute toggle
  // never clobbers the fade envelope's scheduled ramps.
  const muteGate = ctx.createGain();
  muteGate.gain.value = 1;
  clipGain.connect(muteGate).connect(destination);

  // Everything that outlives the individual sources and is torn down with the
  // last of them: the envelope, the gate, and a comp's per-seam gains.
  const shared: { disconnect(): void }[] = [clipGain, muteGate];

  const clipSources: AudioBufferSourceNode[] = [];
  for (const part of plan.parts) {
    const partStartCtx = clipStartCtx + part.startSec;
    // A comp seam is a crossfade between two takes of the SAME performance, so
    // it is the LINEAR pair (`in + out = 1`) — correlated material sums, and
    // equal power would bulge through the middle of the seam. The two sides get
    // mirror images of one fade over one window (`lib/clipComp` overlaps them by
    // exactly the crossfade and gives each the full length), so the sum across
    // the seam is unity by construction. A clip that is not comped has no seam
    // and gets no gain at all, which is what keeps its node set unchanged.
    let sink: AudioNode = clipGain;
    if (plan.comped) {
      const seamGain = ctx.createGain();
      applyFadeAutomation(
        seamGain.gain,
        {
          durationSec: part.schedule.durationSec,
          fadeInSec: part.fadeInSec,
          fadeOutSec: part.fadeOutSec,
          fadeInCurve: 'linear',
          fadeOutCurve: 'linear',
        },
        partStartCtx,
        part.intoPart,
        { peak: 1, effectiveDurationSec: part.schedule.durationSec },
      );
      seamGain.connect(clipGain);
      shared.push(seamGain);
      sink = seamGain;
    }

    for (const seg of part.schedule.segments) {
      const src = ctx.createBufferSource();
      src.buffer = part.buffer;
      src.playbackRate.value = seg.playbackRate;
      src.connect(sink);
      src.start(Math.max(nowSec, partStartCtx + seg.targetStart), seg.sourceOffset, seg.sourceDuration);
      src.onended = () => {
        pending -= 1;
        try { src.disconnect(); } catch { /* already gone */ }
        if (pending > 0) return;
        for (const node of shared) {
          try { node.disconnect(); } catch { /* already gone */ }
        }
        options.onEnded?.();
      };
      clipSources.push(src);
    }
  }
  return { muteGate, sources: clipSources };
}

/** Schedule every clip that is at or after `fromSec` (or straddling it). */
function scheduleClips(clips: AudioClip[], fromSec: number): void {
  const ctx = getEngineCtx();
  const now = ctx.currentTime;
  sources = [];
  clipMuteGains = new Map();
  clipPinReleases = [];
  // A take that had not decoded last time may have decoded since — and if it
  // still has not, this pass says so again rather than going quiet about a clip
  // that is still playing silence.
  resetScheduleWarnings('transient');
  for (const clip of clips) {
    // Muted clips are not scheduled at all; a mute toggled DURING playback is
    // handled live by the clip's mute gate (see applyClipMutesLive).
    if (clip.muted) continue;
    // A clip the live synth or a VST3 instrument plays skips its bounced audio
    // so we don't double up; scheduleMidiClips / scheduleInstrumentTracks play its notes instead.
    if (playsWithoutAudio(clip.id)) continue;
    // A MIDI clip with no render has no audio to play (start() queued its render).
    if (!clip.audioBlob) continue;
    const nodes = trackNodes.get(clip.trackId);
    if (!nodes) continue;
    // One resolver per clip. For everything that is not comped it hands over the
    // clip's own blob for the active take — which by the `AudioClip.takes`
    // invariant IS the active take's audio, and is the whole of take switching.
    // A comped clip asks it for each take in turn instead. Either way every
    // buffer it hands over is pinned, and released below.
    const pins: DecodePin[] = [];
    const release = releaseOnce(pins);
    const scheduled = scheduleClipSources(
      ctx, clip, takeResolver(ctx, clip, pins), nodes.gain, now, fromSec, { onEnded: release },
    );
    if (!scheduled) { release(); continue; }
    clipPinReleases.push(release);
    clipMuteGains.set(clip.id, scheduled.muteGate);
    for (const src of scheduled.sources) sources.push(src);
  }
  // The pass's own pins now hold everything that will play, so the prefetch's
  // can go — which is what frees the clips that were never scheduled. Safe to do
  // here rather than after `scheduleTeleports` (which also peeks, on the active
  // take): only a DECODE evicts, and the pass has no decodes left to run.
  releasePrefetchPins();
}

/** Onset-sliced chunks for a clip's decoded buffer (cached by Blob identity).
 *  On the ACTIVE take: a comped clip's onsets are a property of the performance
 *  the user is looking at, and slicing a comp's seams would make the teleport
 *  positions depend on a comp edit. (The teleport loop below reads the active
 *  take's buffer for the same reason.) */
function chunksFor(clip: AudioClip): AudioChunk[] {
  if (!clip.audioBlob) return [];
  const buf = peekDecoded(getEngineCtx(), clip.audioBlob);
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
      (c) => c.trackId === t.id && !c.muted && !playsWithoutAudio(c.id),
    );

    for (const entry of teleEntries) {
      const li = insts.find((x) => x.id === entry.id);
      if (!li?.inst.scheduleTeleport) continue;
      const spread = entry.params?.motionDepth ?? 5;
      const events: { when: number; x: number; y: number; z: number }[] = [];
      let idx = 0;
      for (const clip of trackClips) {
        if (!clip.audioBlob) continue;
        const buf = peekDecoded(ctx, clip.audioBlob);
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

/** One scheduled change on an AudioParam. `curve` is a rasterised segment for
 *  `setValueCurveAtTime`; the other two are the plain set/ramp pair the lanes
 *  have always emitted. */
export type EnvelopeEvent =
  | { kind: 'set'; when: number; v: number }
  | { kind: 'ramp'; when: number; v: number }
  | { kind: 'curve'; start: number; duration: number; values: Float32Array };

/** The part of an automation lane the envelope needs. `AutomationLane` satisfies
 *  it structurally, which keeps the event builder testable without a store. */
export interface EnvelopeLane {
  points: readonly CurvePoint[];
}

/** Rasterisation density for a curved segment, and the bounds on the count. The
 *  minimum is the spec's: fewer than 2 values throws InvalidStateError. */
const CURVE_SAMPLES_PER_SEC = 200;
const CURVE_SAMPLES_MIN = 2;
const CURVE_SAMPLES_MAX = 512;
/** Smallest gap forced between two scheduled events, so a project carrying two
 *  breakpoints at the same instant cannot produce a zero-duration curve —
 *  `setValueCurveAtTime` throws RangeError unless `duration` is strictly
 *  positive. Same 1e-4 the offline bounce has always used. */
const MIN_EVENT_DT = 1e-4;

/** True when `points` is already in ascending `t` order (the common case). */
function isAscending(points: readonly CurvePoint[]): boolean {
  for (let i = 1; i < points.length; i += 1) if (points[i].t < points[i - 1].t) return false;
  return true;
}

/**
 * The event list one automation lane puts on its AudioParam — the ONE definition,
 * shared by live playback and by the offline bounces.
 *
 * `fromSec` is the timeline position playback resumes at; `startCtxTime` /
 * `startOffsetSec` are the transport's context-clock↔timeline pinning (both 0 for
 * an OfflineAudioContext, which renders from t=0); `now` is the context clock.
 *
 * Shape: an anchor `set` at `now` carrying the lane's value under the playhead,
 * then one event per breakpoint still ahead. A segment whose LEFT point has a
 * non-zero `curve` becomes a single `curve` sampled off `interpolatePoints`;
 * every other segment stays the `ramp` it was, so a curve-less lane emits exactly
 * what it emitted before this function existed.
 *
 * The `curve` events obey the Web Audio API spec's rules for
 * `setValueCurveAtTime` (https://webaudio.github.io/web-audio-api/
 * #dom-audioparam-setvaluecurveattime, read 2026-09-15; MDN's AudioParam page
 * agrees):
 *   - "If setValueCurveAtTime() is called for time T and duration D and there are
 *     any events having a time strictly greater than T, but strictly less than
 *     T+D, then a NotSupportedError exception MUST be thrown … it's ok to schedule
 *     a value curve exactly at the time of another event." Segments here are
 *     contiguous — each curve starts exactly where the previous event lands — so
 *     nothing ever falls strictly inside a curve's window.
 *   - The anchor is placed at `now` and every later event at or after it, so the
 *     anchor precedes the first curve (and may sit exactly on its start).
 *   - `values` needs at least 2 entries and `duration` must be finite and
 *     strictly positive; hence the clamps above.
 *   - "After the end of the curve time interval the value will remain constant at
 *     the final curve value … An implicit call to setValueAtTime() is made at time
 *     T0+TD with value V[N−1]". The last sample is therefore pinned exactly to the
 *     segment's end value rather than left to the rasteriser's rounding, so the
 *     ramp that follows departs from the breakpoint the user drew.
 *   - `startTime` earlier than `currentTime` is clamped to `currentTime` by the
 *     implementation, which would silently SHIFT a curve. Rather than let that
 *     happen, a segment already under way degrades here: the anchor holds the
 *     value at `fromSec` and the curve covers only the part still ahead, sampled
 *     as a window onto the same shape.
 *
 * `delaySec` is how much AUDIO sits between the chain input and this param — the
 * reason a lane's events are not always written on the clip scheduler's clock.
 * `gain` (volume) IS the chain input, so it passes 0 and emits exactly the list
 * it always has. The PANNER is downstream of the inserts (`clipGain -> gain ->
 * muteGain -> [fx] -> panner -> comp`), so the audio reaching it at context time
 * `x` entered the chain at `x - latency(fx)`; a breakpoint authored for timeline
 * `p.t` therefore belongs at `toCtx(p.t) + latency(fx)`, which is what a non-zero
 * `delaySec` places it at. Only the FUTURE events move: the anchor is the value
 * under the param RIGHT NOW and stays at `now`. Everything downstream of that —
 * the `whenCtx <= now` collapse, the cursor spacing, a segment already under way
 * degrading to the part still ahead — falls out of the shifted map unchanged,
 * and `toTimeline` is its exact inverse so a degraded curve's sampled window
 * still describes the stretch of timeline its duration covers. A negative or
 * non-finite value is treated as 0: it could only drag an event backwards into
 * audio that has already gone past.
 */
export function laneEnvelopeEvents(
  lane: EnvelopeLane,
  fromSec: number,
  startCtxTime: number,
  startOffsetSec: number,
  now: number,
  delaySec = 0,
): EnvelopeEvent[] {
  if (lane.points.length === 0) return [];
  // Ascending order is load-bearing here — `cursor` only keeps events out of a
  // curve's window because each breakpoint is later than the last, and
  // `sampleCurve` binary-searches. The store's writers all keep lanes sorted, but a
  // hand-edited or imported project need not, and an out-of-order point would
  // otherwise drop a `set` BEHIND a curve already placed (NotSupportedError). Sort
  // a copy — stable, so points sharing a `t` keep their authored order — and only
  // when the lane actually needs it, so the normal path allocates nothing.
  const pts = isAscending(lane.points) ? lane.points : [...lane.points].sort((a, b) => a.t - b.t);
  const d = Number.isFinite(delaySec) && delaySec > 0 ? delaySec : 0;
  const toCtx = (t: number) => startCtxTime + (t - startOffsetSec) + d;
  const toTimeline = (x: number) => startOffsetSec + (x - startCtxTime) - d;

  const out: EnvelopeEvent[] = [{ kind: 'set', when: now, v: sampleCurve(pts, fromSec) ?? pts[0].v }];
  // Nothing may be scheduled at or before `cursor`: it is `now` until the first
  // future event is placed and the END of the last placed event after that. It is
  // what keeps each curve's window free of other events.
  let cursor = now;

  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (p.t <= fromSec) continue; // behind the playhead — the anchor already covers it
    const whenCtx = toCtx(p.t);
    if (whenCtx <= now) {
      // Behind the CONTEXT clock (a re-schedule that arrived late): take the value
      // immediately rather than ramping backwards into the past.
      out.push({ kind: 'set', when: now, v: p.v });
      continue;
    }
    const when = Math.max(whenCtx, cursor + MIN_EVENT_DT);
    const prev = i > 0 ? pts[i - 1] : null;
    const curve = prev ? clampCurve(prev.curve) : 0;
    if (!prev || curve === 0) {
      out.push({ kind: 'ramp', when, v: p.v });
      cursor = when;
      continue;
    }
    const segStartCtx = toCtx(prev.t);
    const start = Math.max(segStartCtx, cursor);
    const duration = when - start;
    if (!(duration > 0)) {
      out.push({ kind: 'ramp', when, v: p.v });
      cursor = when;
      continue;
    }
    // Timeline window the rasterisation covers. It starts at the segment's own left
    // point, or wherever the playhead cut into it; it ends at the right point,
    // EXCEPT when `when` was bumped off `whenCtx` to keep the event ordered, in
    // which case the window is stretched by the same amount so `duration` and the
    // sampled span describe the same stretch of time (the two clocks run 1:1, so
    // the bump is the same number of seconds on both).
    const t0 = start <= segStartCtx ? prev.t : toTimeline(start);
    const t1 = when === whenCtx ? p.t : p.t + (when - whenCtx);
    const n = Math.max(
      CURVE_SAMPLES_MIN,
      Math.min(CURVE_SAMPLES_MAX, Math.ceil(duration * CURVE_SAMPLES_PER_SEC)),
    );
    const values = new Float32Array(n);
    for (let k = 0; k < n; k += 1) {
      values[k] = interpolatePoints(prev, p, t0 + (t1 - t0) * (k / (n - 1)));
    }
    values[n - 1] = p.v; // exact end value (see the spec note above)
    out.push({ kind: 'curve', start, duration, values });
    cursor = when;
  }
  return out;
}

/** Write an event list onto a param. `clampValue` (the offline bounces' range
 *  clamp) reaches INSIDE a curve too — a curved pan lane must not be the one path
 *  that escapes it. */
export function applyEnvelopeEvents(
  param: AudioParamLike,
  events: readonly EnvelopeEvent[],
  clampValue?: (v: number) => number,
): void {
  const fix = clampValue ?? ((v: number) => v);
  for (const e of events) {
    if (e.kind === 'set') { param.setValueAtTime(fix(e.v), e.when); continue; }
    if (e.kind === 'ramp') { param.linearRampToValueAtTime(fix(e.v), e.when); continue; }
    const values = clampValue ? e.values.map(clampValue) : e.values;
    if (param.setValueCurveAtTime) { param.setValueCurveAtTime(values, e.start, e.duration); continue; }
    // No value-curve support on this param: walk the same samples as ramps, so the
    // SHAPE survives instead of the segment silently flattening to a straight line.
    // The leading `set` matters — `setValueCurveAtTime` does nothing until `start`,
    // so without it the first ramp would start sliding from the anchor at `now`,
    // which for a degraded sub-curve (start > now) is a slope the curve does not
    // have. Pinning the value at `start` makes the param HOLD until the curve
    // begins, exactly as the real call does.
    param.setValueAtTime(values[0], e.start);
    for (let k = 1; k < values.length; k += 1) {
      param.linearRampToValueAtTime(values[k], e.start + e.duration * (k / (values.length - 1)));
    }
  }
}

/** Re-arm ONE native lane's envelope on its AudioParam from `fromSec`. Used by
 *  play/seek (via `scheduleAutomation`) and by a touch punch-out, which hands the
 *  param back to the lane the gesture just wrote into. A lane edited while
 *  playing is re-armed through it as well (`rearmEditedNativeLanes`).
 *
 *  VOLUME is written at the chain input and takes no delay — its breakpoints land
 *  on the same node time the clip scheduler maps them to. PAN is written after the
 *  inserts, so its whole envelope is pushed out by the chain's own latency and
 *  lands on the audio it was drawn for. The delay is a cached lookup
 *  (`refreshAutomationDelays`), not a walk — this runs once per lane per
 *  play/seek/punch-out.
 *
 *  Which is also the limit of it: `delaySec` is BAKED INTO the event list at
 *  schedule time, so a chain edited mid-playback moves the comp delays (through
 *  `syncTrackLatency`) but leaves an already-armed pan envelope on the old shift
 *  until the next play, seek or touch punch-out re-arms it. That is the existing
 *  re-arm policy for every native lane — the envelope is written once and not
 *  rewritten per frame — not a new gap opened here. */
function scheduleLaneNative(lane: AutomationLane, fromSec: number): void {
  const param = nativeParamFor(lane.target);
  if (!param) return;
  const now = getEngineCtx().currentTime;
  const delaySec = lane.target.kind === 'trackPan' ? panDelaySecFor(lane.target.trackId) : 0;
  param.cancelScheduledValues(now);
  applyEnvelopeEvents(
    param,
    laneEnvelopeEvents(lane, fromSec, startCtxTime, startOffsetSec, now, delaySec),
  );
}

/** Schedule every enabled native lane's envelope from `fromSec`. */
function scheduleAutomation(fromSec: number): void {
  // Every lane is armed from the store here, so an edit still waiting for its
  // re-arm is covered. Its diff was taken against the pass being replaced and
  // must not be applied to this one.
  dropPendingRearm();
  const ed = useEditorStore.getState();
  const holds = ed.automationHolds;
  for (const lane of ed.automationLanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    if (lane.target.kind !== 'trackVolume' && lane.target.kind !== 'trackPan') continue;
    // A HELD target is being ridden — by a hand on the fader, or by a latch/write
    // hold that outlives the release. Its param is where the hold put it, and
    // re-scheduling the lane here would fight the hold for the same AudioParam, so
    // the hold wins and the lane stays off it. `endAutomationPass` clears the
    // holds on stop/pause, so in practice this only fires for a SEEK taken during
    // a latch or write pass — which is exactly the case where the held value is
    // meant to keep running across the seek.
    if (holds[automationTargetKey(lane.target)]) continue;
    // One bad lane must not take the transport down with it. This runs inside
    // `start()` BEFORE `playing = true`, so an exception escaping here would leave
    // the sources already scheduled and audible with no clock, no playhead and a
    // Play button that thinks nothing is running. A lane that cannot be scheduled
    // is simply a lane that does not play.
    try {
      scheduleLaneNative(lane, fromSec);
    } catch (e) {
      logError('editor', `Automation lane skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** One lookahead frame: write each enabled FX lane's current value into its live
 *  effect param. Values are grouped per effect entry first, so a multi-param
 *  effect (e.g. OWL-Pad x + y) gets ONE merged update instead of competing
 *  single-key updates that would each reset the other key to its static value.
 *
 *  Each lane is read at its OWN time. An entry with 6 ms of compressor ahead of
 *  it is being fed audio that entered the chain 6 ms ago, so it is handed the
 *  value that audio was drawn for — `fxLaneSampleTime(t, prefix, totalDur)`. The
 *  first entry in a chain has no prefix and is exact, which is why this used to
 *  be right for the common project and early for every other one. */
function applyFxAutomationFrame(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const t = clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
  // Held targets first. A latch/write hold keeps writing its value forward into
  // its lane for as long as the transport rolls, and the FX pass below reads the
  // lanes — so the hold has to land before the read, not after it. This is a
  // no-op (same state object back) when nothing is held.
  useEditorStore.getState().advanceAutomationHolds(t);
  const ed = useEditorStore.getState();

  const byEntry = new Map<string, { kind: AutomationTarget['kind']; owner?: string; entryId: string; values: Record<string, number> }>();
  for (const lane of ed.automationLanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    const { kind, trackId, entryId, paramKey } = lane.target;
    if (!isFxAutomationKind(kind) || !entryId || !paramKey) continue;
    const v = sampleLane(lane, fxLaneSampleTime(t, fxPrefixSecFor(kind, trackId, entryId), totalDur));
    if (v == null) continue;
    const mapKey = `${kind}|${trackId ?? ''}|${entryId}`;
    let acc = byEntry.get(mapKey);
    if (!acc) { acc = { kind, owner: trackId, entryId, values: {} }; byEntry.set(mapKey, acc); }
    acc.values[paramKey] = v;
  }

  for (const acc of byEntry.values()) {
    const target = fxAutomationTargetOf(acc.kind, acc.owner, acc.entryId, ed);
    if (!target) continue;
    // A `p<index>` key reaches a hosted plugin's parameter through the same
    // `updateParams` a rack knob does (lib/vstLive/vstLiveNode pushParams).
    target.handle.updateParams(acc.entryId, { ...target.entry.params, ...acc.values });
  }
}

/**
 * The live chain an FX lane's values are pushed into, and the entry they merge
 * over: the master rack or the master VST chain for a masterFx lane (the entry
 * id says which), the bus strip's rack for a busFx lane, the track strip's for
 * a trackFx lane. Null when the chain is not built or the entry is gone or
 * bypassed: a bypassed entry is not in the live graph.
 */
function fxAutomationTargetOf(
  kind: AutomationTarget['kind'],
  owner: string | undefined,
  entryId: string,
  ed: ReturnType<typeof useEditorStore.getState>,
): { handle: ChainHandle; entry: ChainEntry } | null {
  const on = (entry: ChainEntry | undefined, handle: ChainHandle | null | undefined) =>
    entry && entry.enabled && handle ? { handle, entry } : null;
  if (kind === 'masterFx') {
    const rack = ed.masterFxChain.find((e) => e.id === entryId);
    if (rack) return on(rack, masterChain);
    return on(ed.masterVstChain.find((e) => e.id === entryId), masterVstChainHandle);
  }
  if (!owner) return null;
  if (kind === 'busFx') {
    return on(ed.buses.find((b) => b.id === owner)?.fxChain.find((e) => e.id === entryId), busNodes.get(owner)?.fx);
  }
  return on(ed.tracks.find((tr) => tr.id === owner)?.fxChain?.find((e) => e.id === entryId), trackNodes.get(owner)?.fx);
}

function startFxAutomation(): void {
  stopFxAutomation();
  const ed = useEditorStore.getState();
  const hasFxLane = ed.automationLanes.some((l) => l.enabled && isFxAutomationKind(l.target.kind));
  // The same timer is the HOLD clock. An armed mode (touch/latch/write) has to run
  // it even in a project with no FX lane at all, because a latch or write hold
  // writes its value forward frame by frame — without the timer a held fader would
  // leave a single breakpoint at the moment it was released and nothing after it.
  if (hasFxLane || ed.automationMode !== 'read') {
    autoFxTimer = window.setInterval(applyFxAutomationFrame, 25); // ~40 Hz
  }
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

/**
 * Drive a native (vol/pan) param live for the BEGIN and MOVE of a gesture, so the
 * move is heard the moment the hand makes it.
 *
 * It drops whatever the lane had scheduled ahead of now and glides the param to
 * `value` — and then the param simply STAYS there. That is all this function
 * decides; it is not a mode. What happens on RELEASE is the mode's business:
 * `touch` punches out through `automationReleaseNative`, which re-arms the lane,
 * while `latch` and `write` never call it, and the value left here is the hold.
 * The breakpoints themselves are written by the store, not here.
 *
 * (The comment this replaces claimed the call WAS latch behaviour. It was not:
 * nothing held after release and nothing punched out — D15.)
 */
export function automationTouchNative(target: AutomationTarget, value: number): void {
  if (!playing) return;
  const param = nativeParamFor(target);
  if (!param) return;
  const ctx = getEngineCtx();
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, RAMP_TC);
}

/**
 * Punch out of a gesture on a native target: hand the AudioParam back to its lane
 * by re-scheduling that ONE lane's envelope from the current transport position.
 *
 * Only `touch` calls this (see `holdsAfterRelease`) — in latch and write the
 * released value is supposed to keep running, so leaving the param exactly where
 * `automationTouchNative` left it IS the hold. Safe to call for a target with no
 * lane, a disabled lane, or a stopped transport: it does nothing.
 */
export function automationReleaseNative(target: AutomationTarget): void {
  if (!playing) return;
  if (target.kind !== 'trackVolume' && target.kind !== 'trackPan') return;
  const key = automationTargetKey(target);
  const lane = useEditorStore.getState().automationLanes.find(
    (l) => automationTargetKey(l.target) === key,
  );
  if (!lane || !lane.enabled || lane.points.length === 0) return;
  scheduleLaneNative(lane, currentTransportSec());
}

/** One step of a native-lane re-arm: what happens to one volume or pan param. */
export interface NativeLaneRearmStep {
  key: string;
  target: AutomationTarget;
  action: 'schedule' | 'release';
  /** On a `schedule`, the lane to arm. On a `release`, the lane the param is
   *  taken from, read for the value it is playing. */
  lane?: AutomationLane;
}

/**
 * What an edit to the automation lanes means for the native (volume / pan)
 * params of a pass that is already playing. `prev` and `next` are the lane list
 * before and after the edit, `holds` is the store's `automationHolds`.
 *
 * Only `trackVolume` and `trackPan` lanes are read. An FX lane is sampled every
 * frame by the lookahead writer and a MIDI CC lane by the MIDI scheduler, so
 * both follow an edit already.
 *
 * A lane OWNS its param when it is enabled and has at least one point, the rule
 * `scheduleAutomation` and `automatedNativeKeys` apply. Per target:
 *
 *   - The same lane object on both sides is skipped. The store replaces only the
 *     lane it edits, so every other lane keeps its identity.
 *   - A target with a hold is skipped. A record pass is riding that param, and
 *     `scheduleAutomation` makes the same exception.
 *   - A lane that owns the param after the edit is a `schedule`: its envelope is
 *     written again from the transport position.
 *   - A lane that owned the param before and does not now (its last point
 *     deleted, the lane disabled, the lane removed) is a `release`: the param
 *     goes back to the fader, from the value that lane is playing.
 *   - A lane that owns it on neither side changes nothing. The fader had the
 *     param and keeps it.
 *
 * Pure, so the rule is tested without an AudioContext.
 */
export function nativeLaneRearmPlan(
  prev: readonly AutomationLane[],
  next: readonly AutomationLane[],
  holds: Record<string, unknown>,
): NativeLaneRearmStep[] {
  const owns = (lane: AutomationLane): boolean => lane.enabled && lane.points.length > 0;
  const nativeByKey = (lanes: readonly AutomationLane[]): Map<string, AutomationLane> => {
    const byKey = new Map<string, AutomationLane>();
    for (const lane of lanes) {
      if (lane.target.kind !== 'trackVolume' && lane.target.kind !== 'trackPan') continue;
      const key = automationTargetKey(lane.target);
      // Two lanes on one target (only a damaged file has them): the last one that
      // owns the param is the one `scheduleAutomation` leaves on it.
      const seen = byKey.get(key);
      if (!seen || owns(lane) || !owns(seen)) byKey.set(key, lane);
    }
    return byKey;
  };
  const before = nativeByKey(prev);
  const after = nativeByKey(next);
  const plan: NativeLaneRearmStep[] = [];
  for (const [key, lane] of after) {
    const was = before.get(key);
    if (was === lane || holds[key]) continue;
    if (owns(lane)) plan.push({ key, target: lane.target, action: 'schedule', lane });
    else if (was && owns(was)) plan.push({ key, target: lane.target, action: 'release', lane: was });
  }
  for (const [key, was] of before) {
    if (after.has(key) || holds[key] || !owns(was)) continue;
    plan.push({ key, target: was.target, action: 'release', lane: was }); // the lane is gone
  }
  return plan;
}

/** How long an edit waits for its re-arm, and so the shortest gap between two.
 *  A keyframe drag writes its lane on every pointer move, and each re-arm
 *  cancels and rewrites a whole envelope. */
const REARM_MIN_MS = 30;
/** The lane list the live params were last armed from, kept while an edit to it
 *  has not been applied yet. Null when the params are up to date. */
let rearmFromLanes: readonly AutomationLane[] | null = null;
let rearmTimer = 0; // setTimeout handle while a re-arm is waiting

/**
 * The automation lanes were edited while playing: put the edit on the live
 * volume / pan params. `start()` writes each envelope once, so without this an
 * edit is heard only after the next play or seek.
 *
 * ONE re-arm runs REARM_MIN_MS after the first edit it covers and reads the
 * lanes as they are then. So a drag re-arms at most once per wait, its last
 * write is always applied, and an edit made of several store writes is applied
 * whole, never from inside the first of them.
 *
 * `prev` is the lane list from before the edit. The first one not yet applied
 * is kept, so the re-arm diffs from the lanes the params are really on.
 */
function rearmEditedNativeLanes(prev: readonly AutomationLane[]): void {
  if (rearmFromLanes === null) rearmFromLanes = prev;
  if (!rearmTimer) rearmTimer = window.setTimeout(applyNativeLaneRearm, REARM_MIN_MS);
}

/** Run the waiting re-arm: plan it from the store as it is now, then write each step. */
function applyNativeLaneRearm(): void {
  rearmTimer = 0;
  const from = rearmFromLanes;
  rearmFromLanes = null;
  if (!from || !playing) return;
  const ed = useEditorStore.getState();
  const fromSec = currentTransportSec();
  for (const step of nativeLaneRearmPlan(from, ed.automationLanes, ed.automationHolds)) {
    // The guard `scheduleAutomation` uses: a lane that cannot be written is a
    // lane that does not play, and the other lanes still get theirs.
    try {
      if (step.action === 'release') releaseNativeToFader(step.target, ed.tracks, step.lane, fromSec);
      else if (step.lane) scheduleLaneNative(step.lane, fromSec);
    } catch (e) {
      logError('editor', `Automation lane skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Hand a native param back to its fader: drop what the lane had scheduled and
 *  glide to the stored value, the write `applyMixLive` makes.
 *
 *  `was` is the lane the param was armed from. Its value at `fromSec` is pinned
 *  first, the same anchor `scheduleLaneNative` writes after its cancel. A cancel
 *  in the middle of a ramp puts the param back at the ramp's start, and without
 *  the pin the glide would open with that step. */
function releaseNativeToFader(
  target: AutomationTarget,
  tracks: readonly EditorTrack[],
  was: AutomationLane | undefined,
  fromSec: number,
): void {
  const param = nativeParamFor(target);
  const track = tracks.find((t) => t.id === target.trackId);
  if (!param || !track) return; // no live strip, or the track went with its lane
  const now = getEngineCtx().currentTime;
  const leaving = was ? sampleLane(was, fromSec) : null;
  param.cancelScheduledValues(now);
  if (leaving !== null) param.setValueAtTime(leaving, now);
  param.setTargetAtTime(
    target.kind === 'trackVolume' ? volumeOf(track) : clamp(track.pan, -1, 1), now, RAMP_TC,
  );
}

/** Forget a re-arm that has not run. A pass that ended has nothing left to
 *  write to, and a pass being armed takes every lane from the store. */
function dropPendingRearm(): void {
  if (rearmTimer) { window.clearTimeout(rearmTimer); rearmTimer = 0; }
  rearmFromLanes = null;
}

/** One note of a MIDI clip on the transport, in seconds. */
export interface MidiNoteTime {
  note: number;
  velocity: number;
  onSec: number;
  offSec: number;
}

/**
 * When each note of a MIDI clip sounds on the transport, for playback from
 * `fromSec`. Notes are positioned in SOURCE time; the clip is a window onto that
 * source, so the trim offset is subtracted and the note-off clamps to the clip's
 * length, exactly as MidiClipNotes draws them. Without this, splitClipAt (which
 * copies the whole sourcePianoRoll into BOTH halves) made a split MIDI clip play
 * its entire pattern twice, while the on-screen notes showed it once. A note that
 * has finished, or is already sounding at `fromSec`, is left out of this list
 * (live playback starts a sounding note at the start point, lib/editMidiScheduler). Each note keeps
 * its own length (clipNoteSpan), so a run shorter than a 16th stays detached.
 * A clip with a tempo map (`sourceTempoMap`) times each note through it
 * (lib/rollTempo stepClock), so its ritardandos and fermatas play live as they
 * render.
 */
export function midiClipNoteTimes(
  clip: Pick<AudioClip, 'startSec' | 'durationSec' | 'offsetIntoSource' | 'sourcePianoRoll' | 'sourceBpm' | 'sourceTempoMap'>,
  fallbackBpm: number | undefined,
  fromSec: number,
): MidiNoteTime[] {
  const clock = stepClock(clip.sourceBpm ?? fallbackBpm ?? 120, clip.sourceTempoMap);
  const offsetIntoSource = clip.offsetIntoSource ?? 0;
  const out: MidiNoteTime[] = [];
  for (const n of clip.sourcePianoRoll ?? []) {
    const { relStart, relEnd } = clipNoteSpan(n, clock, offsetIntoSource);
    if (relEnd <= 0 || relStart >= clip.durationSec) continue; // outside this clip's window
    const onSec = clip.startSec + Math.max(0, relStart);
    // Clamp the note-off to the clip edge so a note running past the trim point
    // is cut there rather than sustaining beyond the clip.
    const offSec = clip.startSec + Math.min(clip.durationSec, relEnd);
    if (offSec <= fromSec || onSec < fromSec) continue; // finished, or already sounding
    out.push({ note: n.note, velocity: n.velocity, onSec, offSec });
  }
  return out;
}

/** What EDIT's live MIDI plays in one pass. */
export interface LiveMidiPlan {
  /** The clips synthesised live. Every other MIDI clip plays its bounced audio. */
  liveClipIds: Set<string>;
  /** The live channels of each track with a live clip (lib/editChannels): one, or one per bent lane and one more. */
  channels: EditChannelPlan;
}

/** A plan with nothing live: every MIDI clip plays its bounce. */
export function emptyLiveMidiPlan(): LiveMidiPlan {
  return { liveClipIds: new Set(), channels: planEditChannels([]) };
}

/**
 * The silent MIDI clips of a pass (no render, not played live) the LOG names:
 * those whose render is not already waiting or running (`pending`, the render
 * queue's midiRenderPending). A seek or a loop wrap starts a new pass while
 * those renders run, and each part is named once, when its render is asked for.
 */
export function silentMidiToReport<T extends { id: string }>(silent: readonly T[], pending: (clipId: string) => boolean): T[] {
  return silent.filter((c) => !pending(c.id));
}

/** The fields of a clip the live MIDI plan reads. */
export type LiveMidiClip = Pick<
  AudioClip,
  | 'id'
  | 'trackId'
  | 'muted'
  | 'instrumentProgram'
  | 'instrumentBank'
  | 'sourceKind'
  | 'sourcePianoRoll'
  | 'sourceRollNotes'
  | 'sourceLanes'
  | 'sourceBends'
> &
  Partial<Pick<AudioClip, 'sourceRollPart'>>;
/** The fields of a track the live MIDI plan reads. */
export type LiveMidiTrack = Pick<EditorTrack, 'id' | 'instrumentProgram' | 'isPercussion'> &
  Partial<Pick<EditorTrack, 'instrument' | 'mpeChannels' | 'instrumentBank' | 'instrumentBankId' | 'externalOnly'>>;

/**
 * Decide which MIDI clips play live and on which channels. A clip plays live
 * when it has a program (lib/clipProgram effectiveProgramFor) and its track gets
 * its channels; a clip with no program, or on a track past the last channel,
 * plays the audio it was bounced with. Tracks take channels in track order,
 * melodic tracks never on a drum channel and percussion tracks always on one.
 * A melodic track whose clips bend takes one channel per bent lane and one its
 * other lanes share (lib/editMidiScheduler clipLiveSlots), the most any of its
 * clips needs, so each lane bends on its own channel as it does in the bounce,
 * and the member channels its expressive notes rotate across (lib/mpeRotation,
 * the track's `mpeChannels`).
 */
export function planLiveMidi(
  clips: readonly LiveMidiClip[],
  tracks: readonly LiveMidiTrack[],
  global: GlobalVoice,
): LiveMidiPlan {
  const trackById = new Map(tracks.map((t): [string, LiveMidiTrack] => [t.id, t]));
  const wanted = new Map<string, string[]>();
  const slots = new Map<string, number>();
  for (const clip of clips) {
    if (clip.muted || !isMidiClip(clip)) continue;
    const track = trackById.get(clip.trackId);
    // An external-only track plays live to its MIDI port with no instrument of theDAW's.
    if (!track || (!isExternalOnly(track) && effectiveProgramFor(clip, track, global) === undefined)) continue;
    // A track whose instrument slot holds a VST3 plays through it, not on EDIT's synths
    // (activeTrackInstrument is null on an external-only track).
    if (activeTrackInstrument(track)) continue;
    const ids = wanted.get(track.id);
    if (ids) ids.push(clip.id);
    else wanted.set(track.id, [clip.id]);
    slots.set(
      track.id,
      Math.max(
        slots.get(track.id) ?? 1,
        // Counted as the scheduler times the clip: an external-only track plays with no program of theDAW's; a voice in a user bank may take more articulation channels.
        clipLiveSlots(
          clip,
          isPercussionTrack(track),
          isExternalOnly(track) ? NO_PROGRAM : effectiveProgramFor(clip, track, global),
          trackMembers(track.mpeChannels),
          null,
          isExternalOnly(track) ? 0 : (clipVoice(clip, track, global).bank ?? 0),
        ),
      ),
    );
  }
  const channels = planEditChannels(
    tracks
      .filter((t) => wanted.has(t.id))
      .map((t) => ({ id: t.id, percussion: isPercussionTrack(t), channels: slots.get(t.id) ?? 1 })),
  );
  const liveClipIds = new Set<string>();
  for (const [trackId, ids] of wanted) {
    if (channels.channelOf.has(trackId)) for (const id of ids) liveClipIds.add(id);
  }
  return { liveClipIds, channels };
}

/**
 * The MIDI clips that play live when they are heard: every clip planLiveMidi
 * plays live, and each muted clip that would play live were the muted clips of
 * its track unmuted (the other tracks as they are). Mute decides whether a
 * part sounds, not how: a muted part's header says how it plays when heard
 * (its M key says it is muted), and EDIT decides from this whether a part
 * needs a render, so muting a part never renders it or drops what it holds.
 *
 * One more plan answers every muted clip at once: with every clip unmuted, a
 * track that still gets its channels gets them with fewer tracks competing
 * too (channels go out in track order, and a track that fits keeps fitting
 * when fewer take them before it). Only a muted clip whose track that plan
 * drops past the last channel gets a plan of its own, with just its track's
 * muted clips unmuted.
 */
export function liveMidiIfHeard(
  clips: readonly LiveMidiClip[],
  tracks: readonly LiveMidiTrack[],
  global: GlobalVoice,
  plan: LiveMidiPlan = planLiveMidi(clips, tracks, global),
): Set<string> {
  const out = new Set(plan.liveClipIds);
  if (!clips.some((c) => c.muted && isMidiClip(c))) return out;
  const allHeard = planLiveMidi(clips.map((c) => (c.muted ? { ...c, muted: false } : c)), tracks, global);
  const dropped = new Set(allHeard.channels.dropped);
  const crowded = new Map<string, Set<string>>();
  for (const c of clips) {
    if (!c.muted || !isMidiClip(c)) continue;
    if (allHeard.liveClipIds.has(c.id)) out.add(c.id);
    else if (dropped.has(c.trackId)) {
      const ids = crowded.get(c.trackId);
      if (ids) ids.add(c.id);
      else crowded.set(c.trackId, new Set([c.id]));
    }
  }
  for (const ids of crowded.values()) {
    const trial = planLiveMidi(clips.map((c) => (ids.has(c.id) ? { ...c, muted: false } : c)), tracks, global);
    for (const id of ids) if (trial.liveClipIds.has(id)) out.add(id);
  }
  return out;
}

/** How a track's MIDI clips sound in EDIT, for the track header's status. */
export interface LiveMidiTrackStatus {
  /** 'live': EDIT's synths play the notes; 'bounce': the rendered audio plays. */
  mode: 'live' | 'bounce';
  /** Live to its MIDI out port alone (an external-only track): no synth of theDAW's sounds it. */
  external?: boolean;
  /** Why, in a few words, for the status's title. */
  reason: string;
  /** Channels the track plays on while live. */
  channels: number;
}

/**
 * The status of every track with a MIDI clip: live on EDIT's synths (with its
 * channel count) or on its bounce, and why. It reads the plan play() makes
 * (planLiveMidi), so the header says what the next pass will do; a soundfont
 * that fails to load still sends every clip to its bounce, which the LOG reports.
 */
export function liveMidiTrackStatus(
  clips: readonly LiveMidiClip[],
  tracks: readonly LiveMidiTrack[],
  global: GlobalVoice,
): Map<string, LiveMidiTrackStatus> {
  const plan = planLiveMidi(clips, tracks, global);
  const out = new Map<string, LiveMidiTrackStatus>();
  const midiTracks = new Set(clips.filter((c) => isMidiClip(c) && !c.muted).map((c) => c.trackId));
  const dropped = new Set(plan.channels.dropped);
  for (const t of tracks) {
    if (!midiTracks.has(t.id)) continue;
    if (activeTrackInstrument(t)) {
      out.set(t.id, {
        mode: 'live',
        channels: 1,
        reason: 'Plays live through its VST3 instrument; bounces, freezes and exports print through it',
      });
      continue;
    }
    const chans = plan.channels.channelsOf.get(t.id);
    if (chans && isExternalOnly(t)) {
      out.set(t.id, {
        mode: 'live',
        external: true,
        channels: chans.length,
        reason: "External only: its notes go to its MIDI out port on the audio clock, and no synth of theDAW's plays them",
      });
    } else if (chans) {
      out.set(t.id, {
        mode: 'live',
        channels: chans.length,
        reason: chans.length > 1
          ? `Plays live on the audio clock, on ${chans.length} channels: its bending lanes each bend on their own. A clip with no rendered audio renders when exported`
          : 'Plays live on the audio clock. A clip with no rendered audio renders when exported',
      });
    } else if (dropped.has(t.id)) {
      out.set(t.id, { mode: 'bounce', channels: 0, reason: 'Past the last live channel: plays its rendered audio, rendered for it when it has none' });
    } else {
      out.set(t.id, { mode: 'bounce', channels: 0, reason: 'No instrument: plays its rendered audio, rendered for it when it has none. Pick one to play it live' });
    }
  }
  return out;
}

/** One note EDIT's live MIDI plays, timed in seconds from the pass start. */
export interface LiveMidiNote {
  clipId: string;
  channel: number;
  program: number;
  /** The bank select sent before `program` (lib/clipProgram clipBank); 0 is the General MIDI set. */
  bank: number;
  midi: number;
  velocity: number;
  onDelaySec: number;
  offDelaySec: number;
}

/**
 * The notes of every live clip (planLiveMidi) that start at or after
 * `fromSec`, with the channel and program each plays on, timed as the live
 * scheduler times them (lib/editMidiScheduler clipLiveTiming: the notes the
 * bounce renders from, each on its lane's channel when its lanes bend). Mute
 * and solo are honoured by skipping the track. The scheduler also starts the
 * notes already sounding at `fromSec`; this list leaves them out.
 */
export function liveMidiNotes(
  clips: readonly AudioClip[],
  tracks: readonly EditorTrack[],
  plan: LiveMidiPlan,
  global: GlobalVoice,
  fromSec: number,
  projectBpm: number | undefined,
): LiveMidiNote[] {
  const anySolo = tracks.some((t) => t.solo);
  const trackById = new Map<string, EditorTrack>(tracks.map((t): [string, EditorTrack] => [t.id, t]));
  const out: LiveMidiNote[] = [];
  for (const clip of clips) {
    if (!plan.liveClipIds.has(clip.id) || clip.muted) continue;
    const track = trackById.get(clip.trackId);
    if (!track || muteSoloFactor(track, anySolo) <= 0) continue; // honor mute/solo
    const chans = plan.channels.channelsOf.get(clip.trackId);
    const program = effectiveProgramFor(clip, track, global);
    if (!chans?.length || program === undefined) continue;
    // The bank select the scheduler sends: the clip's, its track's or the picker's program's (lib/clipProgram clipVoice).
    const bank = clipVoice(clip, track, global).bank ?? 0;
    for (const n of clipLiveTiming(clip, projectBpm, isPercussionTrack(track), program, trackMembers(track.mpeChannels), null, bank).notes) {
      if (n.on < fromSec || n.off <= fromSec) continue;
      const onDelaySec = n.on - fromSec;
      out.push({
        clipId: clip.id,
        channel: chans[Math.min(n.slot, chans.length - 1)],
        program: n.program ?? program,
        bank: n.program !== undefined ? (n.bank ?? 0) : bank,
        midi: n.midi,
        velocity: n.velocity,
        onDelaySec,
        offDelaySec: Math.max(onDelaySec + 0.01, n.off - fromSec),
      });
    }
  }
  return out;
}

/** How many EDIT banks a plan's channels need once its external-only tracks' channels are left out (they sound on no synth). */
export function internalBanks(channels: EditChannelPlan, tracks: readonly LiveMidiTrack[]): number {
  let banks = 0;
  for (const t of tracks) {
    if (isExternalOnly(t)) continue;
    for (const ch of channels.channelsOf.get(t.id) ?? []) banks = Math.max(banks, Math.floor(ch / 16) + 1);
  }
  return banks;
}

/** The live MIDI scheduler, one for the session: it outlives a pass so a seek sees what the pass before it queued. */
let midiScheduler: EditMidiScheduler | null = null;

/** Seconds each tick schedules ahead: short while the page shows, long while it is hidden and timers slow to about once a second. */
const midiLookaheadSec = (): number =>
  typeof document !== 'undefined' && document.hidden ? EDIT_MIDI_HIDDEN_LOOKAHEAD_SEC : EDIT_MIDI_LOOKAHEAD_SEC;

/** This pass's track outputs (state/midiOutBus): what EDIT's synths are told also goes to each track's MIDI port. Null with none. */
let trackOut: EditMidiSink | null = null;

/** The live channels of this pass's external-only tracks: they go to the tracks' ports and to no synth of theDAW's. */
let externalChans: ReadonlySet<number> = new Set();

/** EDIT's synths, less an external-only track's channels, and the tracks' MIDI output ports while a pass has any. */
const liveSink: EditMidiSink = passMidiSink(
  {
    noteOn: editNoteOn,
    noteOff: editNoteOff,
    wheel: editPitchWheel,
    wheelRange: editPitchWheelRange,
    // Every controller number, raw: a part's, a note's timbre, the reverb send and a track's trackMidiCc lanes.
    control: editControllerChange,
    pressure: editChannelPressure,
  },
  () => trackOut,
  () => externalChans,
);

/** An audio-context time as performance.now() milliseconds, the clock Web MIDI stamps messages with. */
function contextToPerf(ctx: AudioContext): (t: number) => number {
  return (t: number) => {
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (stamp && typeof stamp.contextTime === 'number' && typeof stamp.performanceTime === 'number') {
      return stamp.performanceTime + (t - stamp.contextTime) * 1000;
    }
    return performance.now() + (t - ctx.currentTime) * 1000;
  };
}

function liveMidiScheduler(): EditMidiScheduler {
  if (!midiScheduler) {
    midiScheduler = new EditMidiScheduler({
      now: () => getEngineCtx().currentTime,
      sink: liveSink,
      clips: () => useEditorStore.getState().clips,
      tracks: () => useEditorStore.getState().tracks,
      global: getGlobalVoice,
      projectBpm: () => useEditorStore.getState().bpm,
      envelope: (trackId) => midiEnvGains.get(trackId)?.gain ?? null,
      lookaheadSec: midiLookaheadSec,
      // A MIDI track's controller lanes (trackMidiCc) play with its notes.
      automation: () => useEditorStore.getState().automationLanes,
    });
  }
  return midiScheduler;
}

/** Where this pass's live MIDI stops scheduling: the loop's end while the loop plays, else the song's end. */
function liveMidiEndSec(fromSec: number): () => number {
  return () => {
    const ed = useEditorStore.getState();
    const loop = ed.loopEnabled && ed.loopEnd - ed.loopStart > 0.05 && fromSec < ed.loopEnd;
    return loop ? Math.min(ed.loopEnd, totalDur) : totalDur;
  };
}

/**
 * Play every live MIDI clip from `fromSec` on EDIT's synths, on the audio
 * clock (lib/editMidiScheduler): each track's channels feed an envelope gain
 * that carries the playing clip's gain and fades, then the track's gain node,
 * so live MIDI runs through the same fader -> insert FX -> panner -> master rack
 * path its bounced audio takes on export. The scheduler is anchored where the
 * pass's audio is (startCtxTime, startOffsetSec) and ticks every
 * EDIT_MIDI_TICK_MS.
 */
function scheduleMidiClips(fromSec: number, plan: LiveMidiPlan): void {
  const ctx = getEngineCtx();
  for (const [trackId, chans] of plan.channels.channelsOf) {
    const node = trackNodes.get(trackId);
    if (!node) continue;
    const env = ctx.createGain();
    env.gain.value = 1;
    env.connect(node.gain);
    midiEnvGains.set(trackId, env);
    for (const ch of chans) routeEditChannel(ch, env);
  }
  const scheduler = liveMidiScheduler();
  // A track with a MIDI output sends what it plays to that port too; an external-only track sends it there alone.
  const ed = useEditorStore.getState();
  externalChans = externalOnlyChannels(ed.tracks, plan.channels.channelsOf);
  trackOut = startTrackRoutes({ tracks: ed.tracks, channelsOf: plan.channels.channelsOf, now: () => ctx.currentTime, toPerf: contextToPerf(ctx) });
  scheduler.start(
    { liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf },
    fromSec,
    startCtxTime,
    liveMidiEndSec(fromSec),
  );
  midiTimer = window.setInterval(() => scheduler.tick(), EDIT_MIDI_TICK_MS);
}

/**
 * MIDI clock, song position and Start/Continue to every port a track sends
 * clock to, for a pass that plays `fromSec` at the pass's anchor, on EDIT's
 * tempo map, whatever the pass plays (an arrangement of audio alone too),
 * ticked ahead on its own timer until the pass stops.
 */
function startPassClock(fromSec: number): void {
  const ctx = getEngineCtx();
  const ed = useEditorStore.getState();
  const tempoMap = ed.tempoMap;
  const started = startTransportClock({
    tracks: ed.tracks,
    fromSec,
    anchorCtx: startCtxTime,
    now: () => ctx.currentTime,
    toPerf: contextToPerf(ctx),
    beatAt: (sec) => timeToBeat(tempoMap, sec),
    secAt: (beat) => beatToTime(tempoMap, beat),
    lookaheadSec: midiLookaheadSec(),
  });
  if (started) clockTimer = window.setInterval(() => tickTrackOutputs(midiLookaheadSec()), EDIT_MIDI_TICK_MS);
}

/** Stop the live MIDI scheduler and silence EDIT's synths. The preview synth (the roll, the arpeggiator, the keyboard) keeps sounding. */
function clearMidiTimers(): void {
  if (midiTimer) {
    clearInterval(midiTimer);
    midiTimer = 0;
  }
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = 0;
  }
  if (midiScheduler?.isRunning) {
    midiScheduler.stop();
    const { late, skipped } = midiScheduler.stats;
    if (late + skipped > 0) {
      logWarn('editor', `Live MIDI fell behind the audio clock: ${late} note(s) started late, ${skipped} skipped (the app was busy or hidden)`);
    }
  }
  // The tracks' MIDI ports: every note they were sent ends, and a clocked port gets Stop.
  if (trackOutputsActive()) {
    const ctx = getEngineCtx();
    stopTrackOutputs(contextToPerf(ctx)(ctx.currentTime));
  }
  trackOut = null;
  externalChans = new Set();
  editAllNotesOff();
  clearInstrumentTracks();
}

/* ── VST3 instruments, live ──────────────────────────────────────────────────
   A track whose instrument slot holds a VST3 plays its MIDI through that plugin's
   live host session (lib/vstLive/instrumentLive). Its branch: a silent source
   feeds the instrument's `vst3` node (the same live node every hosted plugin
   uses, keyed by the entry id, so the session outlives the pass), whose output
   goes through an envelope gain (the playing clip's gain and fades) into the
   track's fader, inserts and panner, like the synths' channels. Audio clips on
   the same track keep their own path and never pass through the instrument. */

export interface InstrumentBranch {
  source: ConstantSourceNode;
  env: GainNode;
  chain: ChainHandle;
}

/**
 * One instrument track's live branch: a silent source feeds the instrument's
 * `vst3` node (the plugin makes the sound from the notes it is sent), whose
 * output passes an envelope gain into `trackGain`. Nothing else enters the
 * source, so the track's audio clips, which liveMixer schedules straight into
 * `trackGain`, play dry beside the instrument and never through it.
 */
export function buildInstrumentBranch(
  ctx: BaseAudioContext,
  trackGain: AudioNode,
  entry: ChainEntry,
  build: typeof buildEffectChain = buildEffectChain,
): InstrumentBranch {
  const source = ctx.createConstantSource();
  source.offset.value = 0;
  const env = ctx.createGain();
  env.gain.value = 1;
  env.connect(trackGain);
  const chain = build(ctx, source, env, [entry]);
  source.start();
  return { source, env, chain };
}
let instrumentBranches = new Map<string, InstrumentBranch>();
let instrumentPass: InstrumentLivePass | null = null;
let instrumentTimer = 0;

function liveInstrumentPass(): InstrumentLivePass {
  if (!instrumentPass) {
    instrumentPass = new InstrumentLivePass({
      now: () => getEngineCtx().currentTime,
      clips: () => useEditorStore.getState().clips,
      tracks: () => useEditorStore.getState().tracks,
      global: getGlobalVoice,
      projectBpm: () => useEditorStore.getState().bpm,
      port: (entryId) => {
        const client = vstSessions.get(entryId)?.client;
        if (!client?.sendMidi || !client.midiPanic) return null;
        // A host built before the midi op answers it with an error: leave it alone.
        if (client.ready && client.acceptsMidi !== true) return null;
        return { sendMidi: (events) => client.sendMidi?.(events), midiPanic: () => client.midiPanic?.() };
      },
      sampleRate: (entryId) => vstSessions.get(entryId)?.client.sampleRate || getEngineCtx().sampleRate,
      latencySamples: (entryId) => entryLatencySamples(useVstLiveStore.getState().entries[entryId]),
      envelope: (trackId) => instrumentBranches.get(trackId)?.env.gain ?? null,
      lookaheadSec: midiLookaheadSec,
    });
  }
  return instrumentPass;
}

/** Build each instrument track's branch and start its notes, anchored with the pass's audio. */
function scheduleInstrumentTracks(fromSec: number, plan: readonly InstrumentLiveTrack[]): void {
  const ctx = getEngineCtx();
  for (const t of plan) {
    const node = trackNodes.get(t.trackId);
    if (!node) continue;
    instrumentBranches.set(t.trackId, buildInstrumentBranch(ctx, node.gain, t.entry));
  }
  liveInstrumentPass().start(plan, fromSec, startCtxTime, liveMidiEndSec(fromSec));
  instrumentTimer = window.setInterval(() => instrumentPass?.tick(), EDIT_MIDI_TICK_MS);
}

/** End the instrument pass (each plugin releases what it holds) and take the branches down. */
function clearInstrumentTracks(): void {
  if (instrumentTimer) {
    clearInterval(instrumentTimer);
    instrumentTimer = 0;
  }
  instrumentPass?.stop();
  for (const b of instrumentBranches.values()) {
    try { b.source.stop(); } catch { /* never started */ }
    try { b.chain.dispose(); b.source.disconnect(); b.env.disconnect(); } catch { /* gone */ }
  }
  instrumentBranches = new Map();
}

/** Stop + disconnect every scheduled source (does not tear down track nodes). */
function clearSources(): void {
  for (const s of sources) {
    try { s.onended = null; s.stop(); s.disconnect(); } catch { /* already stopped */ }
  }
  sources = [];
  for (const g of clipMuteGains.values()) {
    try { g.disconnect(); } catch { /* already gone */ }
  }
  clipMuteGains = new Map();
  // Nulling `onended` above means no source will announce its own end, so the
  // decode-cache pins this pass took are released here instead. `releaseOnce`
  // makes that safe for the clips whose sources DID end first.
  for (const release of clipPinReleases) release();
  clipPinReleases = [];
  releasePrefetchPins();
  clearMidiTimers();
  // Release per-channel synth routing while the track nodes it points at are
  // still alive. clearSources() runs at the top of every start() and from
  // stop/pause/dispose, so this is always ahead of disposeTrackNodes(). The
  // banks are parked off the master too: a note the scheduler had already
  // queued then sounds nowhere (soundfontEngine parkEditRouting).
  parkEditRouting();
  for (const env of midiEnvGains.values()) {
    try { env.disconnect(); } catch { /* already gone */ }
  }
  midiEnvGains = new Map();
  stopFxAutomation();
  dropPendingRearm(); // stop, pause, the end and a restart all end the pass here
}

function stopClock(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/**
 * Write the moving line for a transport position of `elapsedSec` in a pass that
 * began at `fromSec`, and hand back what it wrote.
 *
 * This is the ONE place `playheadSec` moves during playback, and the only place
 * the compensation offset is taken off the timeline: the line is a picture of
 * what is AUDIBLE, and with the transport at `elapsedSec` the speakers are
 * playing `elapsedSec - outputLatencySec()`. Everything that wants the transport
 * POSITION — `currentTransportSec()` and the footer's `currentTime` beside this
 * call — keeps the un-shifted number, for the reasons on `outputLatencySec`.
 *
 * The floor at `fromSec` is what keeps the press of Play from looking like a
 * rewind: for the first `maxSec` of a pass the transport has not yet run the
 * offset, and an unclamped cursor would sit BEHIND where playback started. The
 * line simply holds there until the audio catches up with it, which is exactly
 * what is true — nothing from this pass is audible yet.
 *
 * `playheadSec` is read for more than drawing, and those readers move with it
 * deliberately. `WaveformEditor` anchors add-marker and insert-at-playhead on
 * it, so a marker dropped while rolling now lands on the moment the user HEARD
 * (up to `maxSec` earlier than before this) rather than on the moment the engine
 * had already scheduled — which is the point. It also renders this beside the
 * footer's transport timecode, so with a latent chain the two now differ by
 * `maxSec`: one is where the ear is, the other is where the clock is, and both
 * are honest.
 *
 * Exported because `tick()` cannot be driven headless (it needs a real
 * AudioContext and a rAF); this is the statement the pin in
 * `liveMixer.output.test.ts` exercises.
 */
export function publishPlayhead(elapsedSec: number, fromSec: number): number {
  const cursor = Math.max(fromSec, elapsedSec - outputLatencySec());
  useEditorStore.getState().setPlayhead(cursor);
  return cursor;
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

  // Playhead every frame (smooth line); footer time ~10 Hz is plenty. The line
  // is compensated (it shows the audible moment); the footer clock is the
  // transport position, the same number `currentTransportSec()` reports.
  publishPlayhead(elapsed, startOffsetSec);
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
  useEditorStore.getState().endAutomationPass(); // running off the end ends the pass too
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

  // Decide which MIDI clips play live. A clip with a program (its own, its
  // track's, or the global picker's while soundfonts are on) is synthesised on
  // EDIT's synths; a clip with none keeps playing its bounced audio, so users
  // who never touch soundfonts see no behavior change or surprise soundfont
  // load. When the synths cannot load, every clip plays its bounce.
  const plan = planLiveMidi(clips, ed.tracks, getGlobalVoice());
  if (plan.channels.dropped.length > 0) {
    logWarn('editor', `${plan.channels.dropped.length} MIDI track(s) past the last live channel play their bounced audio`);
  }
  if (plan.liveClipIds.size > 0) {
    // The synths the pass sounds: none for an external-only track's channels, which only its port hears.
    // Each synth holds only the user banks its tracks select (lib/editBankBanks).
    const needs = userBanksByEditBank(plan.channels.channelsOf, clips, ed.tracks, getGlobalVoice(), useSoundBankStore.getState().banks);
    const ready = await ensureEditBanks(internalBanks(plan.channels, ed.tracks), needs);
    if (token !== playToken) return;
    liveMidiPlan = ready ? plan : emptyLiveMidiPlan();
  } else {
    liveMidiPlan = plan;
  }
  // A MIDI clip that holds no render and will not play live this pass (the
  // synths did not load, or its track is past the last live channel) has
  // nothing to sound: it is rendered, one clip at a time, and plays from the
  // next pass on. One the plan plays live whose synths did not load keeps its
  // render ('keep'): EDIT's upkeep ('cache') renders nothing for, and drops the
  // automatic render of, a clip the plan plays live.
  // The tracks whose instrument slot plays their MIDI through a VST3.
  instrumentPlan = planInstrumentTracks(clips, ed.tracks);
  instrumentClips = new Set(instrumentPlan.flatMap((t) => [...t.liveClipIds]));
  const silent = clips.filter((c) => !c.muted && hasMidiNotes(c) && !c.audioBlob && !playsWithoutAudio(c.id));
  if (silent.length > 0) {
    // A seek or a loop wrap starts a new pass while those renders run: the
    // LOG names a part once, when its render is first asked for.
    const fresh = silentMidiToReport(silent, midiRenderPending);
    if (fresh.length > 0) {
      logWarn('editor', `${fresh.length} MIDI clip(s) cannot play live this pass and hold no render; rendering them now: ${fresh.slice(0, 4).map((c) => c.label).join(', ')}${fresh.length > 4 ? ', …' : ''}`);
    }
    for (const c of silent) {
      requestMidiRender(c.id, plan.liveClipIds.has(c.id) ? 'keep' : 'cache').catch((e) => logError('editor', `MIDI render failed for "${c.label}": ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  // Only what this pass plays from audio is decoded: a clip the synths play
  // live skips its cached render, so a 24-part score does not decode 24 renders
  // nobody hears.
  try {
    await ensureDecoded(clips.filter((c) => !playsWithoutAudio(c.id)));
  } catch (e) {
    // The clips that DID decode before the failure are pinned; nothing is going
    // to schedule them now, so they are released here rather than held until the
    // next stop or play.
    releasePrefetchPins();
    logError('editor', `Live decode failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (token !== playToken) return; // superseded by a newer start()

  // (Re)assert ourselves as the live transport — a library track played in the
  // meantime may have cleared it via playerStore.load().
  setLiveTransport({ play, pause, stop, seek });

  buildMasterBus();
  // Order matters: buildTrackNodes tears the whole graph down (buses and sends
  // included), so the buses are built after it, and the wiring pass last — it
  // is the only thing that connects a track or a bus to anything downstream.
  buildTrackNodes(ed.tracks);
  buildBusNodes(ed.buses);
  wireRouting(ed.routing);
  resetRoutingSigs();
  // Now that the paths through the buses are known. This is also what refreshes
  // `outputLatencySec()` for the pass about to start — the playhead reads it
  // every frame and must not open on the previous project's number.
  syncTrackLatency();
  // Time the live MIDI clips before the anchor is taken, so a long score's
  // note walk is not charged to its first window.
  if (liveMidiPlan.liveClipIds.size > 0) {
    liveMidiScheduler().prepare({ liveClipIds: liveMidiPlan.liveClipIds, channelsOf: liveMidiPlan.channels.channelsOf });
  }
  startCtxTime = ctx.currentTime;
  startOffsetSec = begin;
  lastTimePush = 0;
  lastMixSig = mixSignature(ed.tracks);
  lastClipMuteSig = clipMuteSignature(clips);
  scheduleClips(clips, begin);
  scheduleTeleports(clips, begin);
  scheduleAutomation(begin); // native vol/pan envelopes onto their AudioParams
  startFxAutomation();        // ~40 Hz lookahead writer for FX-param lanes
  if (liveMidiPlan.liveClipIds.size > 0) scheduleMidiClips(begin, liveMidiPlan);
  if (instrumentPlan.length > 0) scheduleInstrumentTracks(begin, instrumentPlan);
  startPassClock(begin);

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

  // Live mixer-param updates. Gate on the FX-bearing slices changing BY REFERENCE
  // so the 60Hz playhead tick (which only sets playheadSec, leaving tracks/
  // masterFxChain refs intact) never triggers the per-frame JSON.stringify
  // reconciliation. editorStore updates these slices immutably, so a real edit
  // always swaps the reference.
  if (!unsubEditor) {
    unsubEditor = useEditorStore.subscribe((state, prev) => {
      if (!playing) return;
      if (state.tracks !== prev.tracks) {
        const sig = mixSignature(state.tracks);
        if (sig !== lastMixSig) {
          lastMixSig = sig;
          applyMixLive();
        }
        applyTrackChainsLive(); // live per-track rack edits
      }
      if (state.masterFxChain !== prev.masterFxChain) {
        applyMasterChainLive(); // live master rack edits (add/remove/reorder/param)
      }
      // The master VST rack, and the two things that decide whether it should
      // be sounding at all (see `liveMasterVstChain`).
      if (
        state.masterVstChain !== prev.masterVstChain ||
        state.previewMode !== prev.previewMode ||
        state.frozenMaster !== prev.frozenMaster
      ) {
        applyMasterVstChainLive();
      }
      // Routing and the bus strips: rebuild/rewire on a structural move, push
      // values otherwise. Gated on the slice references for the same reason the
      // others are — the 60 Hz playhead tick leaves both untouched.
      if (state.routing !== prev.routing || state.buses !== prev.buses) {
        applyRoutingLive();
      }
      // Arming (or disarming) a record mode MID-PLAYBACK. The hold clock's gate is
      // evaluated once per `start()`, so without this a user who presses play and
      // THEN picks latch, in a project with no FX lane, gets no timer at all and no
      // hold ever advances. Re-running the starter re-evaluates the gate in both
      // directions — it stops the timer again when the mode goes back to read and
      // nothing else needs it.
      if (state.automationMode !== prev.automationMode) {
        startFxAutomation();
        // Arming `write` mid-play has to mean what arming it before play means:
        // every enabled lane is seeded from here on. (`beginAutomationPass` is a
        // no-op in the other three modes, but the check keeps that visible.)
        if (state.automationMode === 'write') {
          useEditorStore.getState().beginAutomationPass(currentTransportSec());
        }
      }
      // A volume or pan lane edited mid-playback: a keyframe added, dragged or
      // deleted, a lane bypassed or cleared, an undo. Gated on the slice
      // reference like the others, so the 60 Hz playhead tick never reaches it.
      // The plan then skips every lane object the edit left alone.
      if (state.automationLanes !== prev.automationLanes) {
        rearmEditedNativeLanes(prev.automationLanes);
      }
      // Clip mute is the one clip property applied live; every other clip edit
      // is structural and lands on the next (re)schedule.
      if (state.clips !== prev.clips) {
        const sig = clipMuteSignature(state.clips);
        if (sig !== lastClipMuteSig) {
          lastClipMuteSig = sig;
          applyClipMutesLive();
        }
      }
    });
  }
  subscribeVstLiveLatency();
  hookVstSessionUnload();

  // Where the transport is, for every live plugin's AudioPlayHead. `start` is
  // the ONE entry point for play, seek and every loop wrap, so a single
  // discontinuity here is what makes a hosted plugin reset its tails instead of
  // smearing them across the jump.
  broadcastVstTransport({
    playing: true,
    positionSamples: Math.round(begin * ctx.sampleRate),
    // The tempo the arrangement's tempo map plays where the pass starts.
    tempoBpm: currentBpm(begin),
    discontinuity: true,
    // `begin` is where the timeline is at this context time, so a plugin whose
    // host goes live later in the pass is told where the pass has got to.
    atSec: startCtxTime,
  });

  rafId = requestAnimationFrame(tick);
}

/**
 * Re-align the mixer whenever a live plugin's declared latency moves.
 *
 * PDC is driven by STORE state, not by the audio graph, and a hosted plugin's
 * latency is not known until its host answers `ready` — seconds after the chain
 * was built — and can change again at any time (`restartComponent`
 * (kLatencyChanged)). Without this the compensation would be computed once
 * against a latency of zero and never corrected, so every OTHER track would
 * play early by exactly the plugin's latency.
 *
 * Signature-gated on the per-entry SAMPLE totals rather than on the store
 * object: an xrun counter ticking or an editor opening must not re-write a
 * `setTargetAtTime` on every comp delay in the project.
 */
function subscribeVstLiveLatency(): void {
  if (unsubVstLive) return;
  const sigOf = (entries: Record<string, VstLiveEntryState>): string =>
    Object.keys(entries)
      .sort()
      .map((id) => `${id}=${entryLatencySamples(entries[id])}`)
      .join('|');
  lastVstLatencySig = sigOf(useVstLiveStore.getState().entries);
  unsubVstLive = useVstLiveStore.subscribe((state) => {
    const sig = sigOf(state.entries);
    if (sig === lastVstLatencySig) return;
    lastVstLatencySig = sig;
    syncTrackLatency();
  });
}

/* ------------------------------- public API ------------------------------- */

/** Open a record pass at `fromSec`. In `write` this arms every enabled lane so the
 *  pass overwrites what it rides over; every other mode is untouched by it. Both
 *  play entries do it — the footer transport calls `play`, the editor's own Play
 *  button calls `playAsync`, and a write pass has to start either way. Loop
 *  restarts and seeks go through `start` directly and so do NOT re-arm: they are
 *  the same pass. */
function beginPass(fromSec: number): void {
  useEditorStore.getState().beginAutomationPass(fromSec);
}

/** Begin live playback from the current editor playhead. */
export function play(): void {
  const from = useEditorStore.getState().playheadSec;
  beginPass(from);
  void start(from);
}

/** Awaitable play (resolves once decode + scheduling are done) — lets the
 *  editor show a brief "Rendering" state on the first play of new clips. */
export async function playAsync(): Promise<void> {
  const from = useEditorStore.getState().playheadSec;
  beginPass(from);
  await start(from);
}

/** Pause in place (keeps the playhead). */
export function pause(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const elapsed = clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
  clearSources();
  stopClock();
  playing = false;
  // The pass ends with the transport: holds are released, and a `write` mode
  // demotes itself to `latch` so the next play does not overwrite everything again.
  useEditorStore.getState().endAutomationPass();
  useEditorStore.getState().setPlayhead(elapsed);
  usePlayerStore.setState({ isPlaying: false, currentTime: elapsed });
  // Pause holds position, so this is NOT a discontinuity: a plugin keeps its
  // tail and resumes where it was.
  broadcastVstTransport({
    playing: false,
    positionSamples: Math.round(elapsed * getEngineCtx().sampleRate),
    tempoBpm: currentBpm(elapsed),
    discontinuity: false,
  });
}

/** Stop and rewind to 0. */
export function stop(): void {
  clearSources();
  stopClock();
  playing = false;
  useEditorStore.getState().endAutomationPass();
  useEditorStore.getState().setPlayhead(0);
  usePlayerStore.setState({ isPlaying: false, currentTime: 0 });
  // Rewinding to 0 is a jump, so hosted plugins reset rather than carrying a
  // tail from the end of the song into the top of it.
  broadcastVstTransport({ playing: false, positionSamples: 0, tempoBpm: currentBpm(), discontinuity: true });
}

/** The tempo at timeline second `atSec` under the arrangement's tempo map, for
 *  the plugin play head; 0 when there is none to give. */
function currentBpm(atSec = 0): number {
  const bpm = editTempoAtSec(useEditorStore.getState().tempoMap, atSec);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : 0;
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

/**
 * The Edit project's hosted plugins, held for as long as they sit in a rack — see
 * lib/vstLive/projectSessions.ts. The graph below is only built on Play; without this a plugin
 * was spawned BY the first Play (the song opened dry until it had loaded) and a plugin removed
 * with the transport stopped kept its host process until the next Play.
 */
/**
 * Every chain entry of the EDIT project a plugin host may be held for: the
 * master VST chain, each track's instrument and inserts, and each bus's
 * inserts. A bus's plugins are held the same way as a track's: loaded with the
 * project, not first spawned by Play. `createProjectSessions` keeps the hosted
 * ones among them.
 */
export function projectVstEntries(
  ed: Pick<ReturnType<typeof useEditorStore.getState>, 'masterVstChain' | 'tracks' | 'buses'>,
): ChainEntry[] {
  const out: ChainEntry[] = [...ed.masterVstChain];
  for (const t of ed.tracks) {
    if (t.instrument) out.push(t.instrument);
    if (t.fxChain) out.push(...t.fxChain);
  }
  for (const b of ed.buses) out.push(...b.fxChain);
  return out;
}

const projectSessions = createProjectSessions({
  registry: vstSessions,
  entries: () => projectVstEntries(useEditorStore.getState()),
  sampleRate: () => getEngineCtx().sampleRate,
});
let unsubProjectSessions: (() => void) | null = null;

/** Register this module as playerStore's live transport so the footer's normal
 *  transport buttons drive it. Call on editor mount. Returns an unregister. */
export function attach(): () => void {
  // Safe now: `prefetchDecodes` and `takeResolver` pin every buffer this module
  // will peek back, so eviction can only take clips nothing is playing.
  enableDecodeBudget();
  setLiveTransport({ play, pause, stop, seek });
  // Hosts can be running before the first Play now, so the page-unload cleanup cannot wait for it.
  hookVstSessionUnload();
  if (!unsubProjectSessions) {
    // Gated on the rack-bearing slices BY REFERENCE, like the live-edit subscription in start():
    // the 60 Hz playhead tick leaves both untouched.
    unsubProjectSessions = useEditorStore.subscribe((state, prev) => {
      if (
        state.tracks !== prev.tracks
        || state.masterVstChain !== prev.masterVstChain
        || state.buses !== prev.buses
      ) projectSessions.reconcile();
    });
  }
  projectSessions.reconcile();
  return () => {
    dispose();
  };
}

/** Tear everything down (editor unmount, or superseded by a library track). */
export function dispose(): void {
  clearSources();
  stopClock();
  playing = false;
  // The session's clips stop being ours, so the permanent warnings about them go
  // too: the next project's clip with the same id is a different clip.
  resetScheduleWarnings('all');
  if (unsubEditor) { unsubEditor(); unsubEditor = null; }
  if (unsubVstLive) { unsubVstLive(); unsubVstLive = null; }
  lastVstLatencySig = '';
  disposeTrackNodes();
  trackNodes = new Map();
  disposeMasterVstChain();
  if (masterChain) { masterChain.dispose(); masterChain = null; }
  if (masterBus) { try { masterBus.disconnect(); } catch { /* gone */ } masterBus = null; }
  lastMasterSig = '';
  lastMasterFullSig = '';
  // The project is going away with the editor, so the host processes go too —
  // this is the "closing the project closes the session" half of the registry's
  // contract, and `dispose()` is the only place that knows it happened. The
  // instances above have already called `release()`, but that only arms a
  // 10 s grace timer meant for a rebuild; nothing is coming back here.
  if (unsubProjectSessions) { unsubProjectSessions(); unsubProjectSessions = null; }
  projectSessions.reset(); // closeAll takes the sessions; the next attach() holds them afresh
  // The piano roll's part instruments are not EDIT's: the MIDI tab keeps playing them.
  vstSessions.closeAll({ keepHeldBy: ROLL_HOLDER });
  broadcastVstTransport({ playing: false, positionSamples: 0, tempoBpm: 0, discontinuity: true });
  // Cleared, not re-seeded: the next start() builds a fresh graph and calls
  // resetRoutingSigs itself, and a stale signature here would let the first
  // subscription tick of that session skip a rewire it needs.
  lastBusMembershipSig = '';
  lastRoutingSig = '';
  lastBusMixSig = '';
  lastSendGainSig = '';
  setLiveTransport(null);
  // Mirror stop()/pause() and leave the shared player store consistent. Without
  // this, a dispose() while rolling left `isPlaying` stuck true: the footer kept
  // rendering a Pause button forever, and pause() early-returns on `!playing`, so
  // pressing it could never clear the state — only a full Stop recovered.
  // Guarded on the entry id so disposing the editor mixer never clobbers the
  // transport state of a library track playing through the same store.
  if (usePlayerStore.getState().currentEntryId === EDITOR_ENTRY_ID) {
    usePlayerStore.setState({ isPlaying: false });
  }
}
