/**
 * DJ tab — pro-DJ console (see MIX.png). Top: two full-width scrolling-overview
 * waveforms (the hero). Below, five regions edge-to-edge:
 *
 *   SAMPLER rail │ DECK A · MIXER · DECK B │ SOURCE TREE
 *                │ FX/STEMS-A · TRACK BROWSER · FX/STEMS-B │
 *
 * Decks carry their own header (art · title · BPM/KEY/Camelot · elapsed/remain),
 * a jog wheel with an inner PITCH fader, a compact transport, and the hotcue /
 * loop / roll / beat-jump performance pads. The narrow center MIXER holds GAIN,
 * 3-band EQ + single-knob FILTER, channel VOL faders, the crossfader, the
 * quantize / auto-gain toggles and the harmonic key-match chip. The center-
 * bottom TRACK BROWSER lists the selected source (the live Library or a set)
 * as a table; rows drag onto a deck or load via →A / →B. A slim NEXT staging
 * lane sits above the browser — drag tracks in to queue them play-next, reorder,
 * fire onto a deck, or push the queue into the active Automix set. The right
 * SOURCE TREE selects what the browser shows.
 *
 * Every below-waveform control is on the SLIDE surface (SlideKnob / SlideFader /
 * SlidePad / SlideCrossfader / RoundToggle) + the JogWheel — all lag-free. The
 * engine (djEngine) is the real 2-deck AudioBuffer transport. Per-deck logic
 * lives in `useDeck`, shared by the waveform lane and the deck column.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Disc, Play, Pause, Plus, Save, Trash2, Cast, Music2, Square,
  ChevronDown, ChevronRight, Magnet, Gauge, Lock,
  KeyRound, Pencil, Search, Library as LibraryIcon, ListMusic, Layers, Sparkles, Download, Link2, Loader2, Shield, Headphones, Piano, X, Scissors, ArrowDownAZ, Plug, Wand2, Ban,
} from 'lucide-react';
import { subscribeToMidi } from '../state/midiBus';
import { useDjControlMap, sigLabel, type MidiKind, type MidiSig } from '../state/djControlMap';
import { midiIgnoreLabel, useMidiIgnoreStore } from '../state/midiIgnoreStore';
import { enableMidi } from '../state/midiTriggerStore';
import { useMidiDevicesStore } from '../state/midiDevicesStore';
import { useDjSampler } from '../state/djSamplerStore';
import { useDjSideList } from '../state/djSideListStore';
import { useFeatureToggleStore } from '../state/featureToggleStore';
import { ControlSurface } from '../components/surface/ControlSurface';
import { DJ_TARGETS } from '../state/bindableTargets';
import type { WidgetRegistry } from '../components/surface/widgetTypes';
import type { SurfaceLayout } from '../state/surfaceLayoutStore';
import { useAppUiStore } from '../state/appUiStore';
import { useSetlistStore, type SetlistEntry } from '../state/setlistStore';
import { useLibraryStore } from '../state/libraryStore';
import type { LibraryEntry } from '../state/libraryStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';
import { useDjCuesStore, HOTCUE_SLOTS } from '../state/djCuesStore';
import { toCamelot, keyLabel } from '../lib/camelot';
import { buildBeatgrid } from '../lib/beatgrid';
import { rgb, rgba, type RGB } from '../lib/trackColor';
import { DJSemanticWaveform } from '../components/audio/DJSemanticWaveform';
import { SlideKnob } from '../components/audio/SlideKnob';
import { SlideFader } from '../components/audio/SlideFader';
import { SlidePad } from '../components/audio/SlidePad';
import { SlideCrossfader } from '../components/audio/SlideCrossfader';
import { RoundToggle } from '../components/audio/RoundToggle';
import { JogWheel } from '../components/audio/JogWheel';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu';
import { sendSetToVj, sendTrackToVj, isVjSetTargetActive, type VjSetItem } from '../state/vjSetBus';
import { registerDjMasterHandler, reportDjMasterState } from '../state/djMasterBus';
import { importUrlToLibrary } from '../lib/onlineImport';
import { listStems, prepareStems } from '../lib/djStems';
import * as djEngine from '../state/djEngine';

const DJ_TRACK_MIME = 'application/x-thedaw-djtrack';
const AUDIO_FILE_EXTENSIONS = new Set(['aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'weba', 'webm']);

const DECK_RGB: Record<'purple' | 'cyan', RGB> = { purple: [34, 141, 211], cyan: [239, 68, 68] };

const EjectSymbol: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" {...props}>
    <path d="M12 5 5 14h14L12 5Z" fill="currentColor" />
    <path d="M5 19h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

const BEAT_SIZES: Array<{ beats: number; label: string }> = [
  { beats: 0.25, label: '¼' }, { beats: 0.5, label: '½' }, { beats: 1, label: '1' }, { beats: 2, label: '2' }, { beats: 4, label: '4' },
];
const ROLL_SIZES: Array<{ beats: number; label: string }> = [
  { beats: 0.25, label: '¼' }, { beats: 0.5, label: '½' }, { beats: 1, label: '1' },
];
const STEM_PAD_SLOTS = 6;
const AUTO_GAIN_TARGET_DB = -12;
const AUTOMIX_TAIL = 18;   // s before a track ends to begin the blend
const AUTOMIX_XFADE = 10;  // s the auto-crossfade takes
const STOP_CUE_EPS = 0.05; // treat cue hits inside 50ms as "at this cue"
const PITCH_RANGES = [10, 15] as const;
type PitchRange = typeof PITCH_RANGES[number];

/* DJ MIDI-learn (D6): the bindable actions, grouped for the map panel. CC →
 * continuous (xfader/vol/eq/filter/pitch); note → trigger (play/cue/sync/hotcue). */
const deckMidiActions = (d: 'A' | 'B'): Array<{ id: string; label: string; group: string; kind: MidiKind }> =>
  ([
    { id: `play${d}`, label: 'Play', kind: 'note' as MidiKind },
    { id: `cue${d}`, label: 'Cue', kind: 'note' as MidiKind },
    { id: `stop${d}`, label: 'Stop', kind: 'note' as MidiKind },
    { id: `sync${d}`, label: 'Sync', kind: 'note' as MidiKind },
    { id: `headcue${d}`, label: 'Cue (HP)', kind: 'note' as MidiKind },
    { id: `vol${d}`, label: 'Volume', kind: 'cc' as MidiKind },
    { id: `gain${d}`, label: 'Gain', kind: 'cc' as MidiKind },
    { id: `filter${d}`, label: 'Filter', kind: 'cc' as MidiKind },
    { id: `pitch${d}`, label: 'Pitch', kind: 'cc' as MidiKind },
    { id: `eq${d}.high`, label: 'EQ Hi', kind: 'cc' as MidiKind },
    { id: `eq${d}.mid`, label: 'EQ Mid', kind: 'cc' as MidiKind },
    { id: `eq${d}.low`, label: 'EQ Lo', kind: 'cc' as MidiKind },
    ...Array.from({ length: STEM_PAD_SLOTS }, (_, i) => ({ id: `stem${d}${i}`, label: `Stem ${i + 1}`, kind: 'note' as MidiKind })),
    ...[1, 2, 3, 4].map((n) => ({ id: `hotcue${d}${n}`, label: `Hotcue ${n}`, kind: 'note' as MidiKind })),
  ]).map((a) => ({ ...a, group: `Deck ${d}` }));

const MIDI_ACTIONS: Array<{ id: string; label: string; group: string; kind: MidiKind }> = [
  { id: 'xfader', label: 'Crossfader', group: 'Mixer', kind: 'cc' },
  ...deckMidiActions('A'),
  ...deckMidiActions('B'),
];
const MIDI_ACTION_BY_ID = new Map(MIDI_ACTIONS.map((a) => [a.id, a]));

type DjMidiPreset = {
  id: string;
  label: string;
  match: string[];
  bindings: Record<string, MidiSig>;
};

const cc = (number: number, channel: number | null = null): MidiSig => ({ kind: 'cc', number, channel });
const note = (number: number, channel: number | null = null): MidiSig => ({ kind: 'note', number, channel });

const DJ_MIDI_PRESETS: DjMidiPreset[] = [
  {
    id: 'novation-launch-control-xl-user1',
    label: 'Novation Launch Control XL',
    match: ['launch control xl', 'lcxl'],
    bindings: {
      // Common User Template 1 layout. Channels are intentionally "any" because
      // Launch Control XL templates can be edited or shifted per user template.
      'eqA.high': cc(13),
      'eqA.mid': cc(14),
      'eqA.low': cc(15),
      filterA: cc(16),
      'eqB.high': cc(17),
      'eqB.mid': cc(18),
      'eqB.low': cc(19),
      filterB: cc(20),
      volA: cc(77),
      pitchA: cc(78),
      gainA: cc(79),
      xfader: cc(80),
      gainB: cc(82),
      pitchB: cc(83),
      volB: cc(84),
      playA: note(41),
      cueA: note(42),
      syncA: note(43),
      headcueA: note(44),
      playB: note(45),
      cueB: note(46),
      syncB: note(47),
      headcueB: note(48),
      hotcueA1: note(57),
      hotcueA2: note(58),
      hotcueA3: note(59),
      hotcueA4: note(60),
      hotcueB1: note(61),
      hotcueB2: note(62),
      hotcueB3: note(63),
      hotcueB4: note(64),
    },
  },
];

/** Source feeding the center Track Browser. The non-set kinds are live filtered
 *  views over the library (favorites / by origin) — all real, no placeholders. */
type LibSourceKind = 'library' | 'favorites' | 'gen' | 'import';
type Source = { kind: LibSourceKind } | { kind: 'set'; id: string };

const LIB_SOURCE_LABEL: Record<LibSourceKind, string> = {
  library: 'Library', favorites: 'Favorites', gen: 'Generated', import: 'Imports',
};
const libSourceFilter = (entries: LibraryEntry[], kind: LibSourceKind): LibraryEntry[] => {
  switch (kind) {
    case 'favorites': return entries.filter((e) => e.favorite);
    case 'gen': return entries.filter((e) => e.source === 'generate');
    case 'import': return entries.filter((e) => e.source === 'import');
    default: return entries;
  }
};

const isExternalAudioFile = (file: File): boolean => {
  if (file.type.startsWith('audio/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_FILE_EXTENSIONS.has(ext);
};

const hasDeckLoadDragData = (event: React.DragEvent): boolean => {
  const dt = event.dataTransfer;
  if (Array.from(dt.types).includes(DJ_TRACK_MIME)) return true;
  return Array.from(dt.items ?? []).some((item) => item.kind === 'file' && (item.type.startsWith('audio/') || item.type === ''));
};

const decodeAudioDuration = async (file: File): Promise<number | undefined> => {
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return undefined;
  const ctx = new AudioContextCtor();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    return decoded.duration;
  } finally {
    await ctx.close().catch(() => undefined);
  }
};

const importAudioFileToLibrary = async (file: File): Promise<LibraryEntry> => {
  const duration = await decodeAudioDuration(file).catch(() => undefined);
  return useLibraryStore.getState().importEntry({
    blob: file,
    filename: file.name,
    mimeType: file.type || undefined,
    metadata: {
      title: file.name.replace(/\.[^.]+$/, '') || file.name,
      prompt: 'Imported from Finder drop',
      model: 'imported',
      duration,
      source: 'import',
      tags: ['finder-drop'],
    },
  });
};

const sameStringArray = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const sameNumberRecord = (a: Record<string, number>, b: Record<string, number>) => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 0.0001);
};

function sortedCuePoints(cues: Array<number | null> | undefined): number[] {
  return (cues ?? [])
    .filter((c): c is number => c != null && Number.isFinite(c))
    .sort((a, b) => a - b);
}

function nextCueAfter(cues: Array<number | null> | undefined, currentTime: number): number | null {
  const points = sortedCuePoints(cues);
  if (points.length === 0) return null;
  return points.find((c) => c > currentTime + STOP_CUE_EPS) ?? points[0];
}

/* ═══════════════════════════ per-deck controller ═══════════════════════════ */

function useDeck(deckId: djEngine.DeckId, entryId: string | null, hasTrack: boolean, quantize: boolean, autoGain: boolean, manualGain: number) {
  const ensureAnalyzed = useDjAnalysisStore((s) => s.ensureAnalyzed);
  const analysisEntry = useDjAnalysisStore((s) => (entryId ? s.byId[entryId] ?? null : null));
  useEffect(() => { if (entryId) void ensureAnalyzed(entryId); }, [entryId, ensureAnalyzed]);

  const a = analysisEntry?.data ?? null;
  const analyzing = analysisEntry?.status === 'running';
  const cam = a ? toCamelot(a.key, a.scale) : null;
  const bpm = a?.bpm ?? null;
  const beats = a?.beats ?? null;
  const beatLen = bpm && bpm > 0 ? 60 / bpm : null;
  const grid = useMemo(() => buildBeatgrid({ bpm, beats, duration: a?.duration_sec }), [bpm, beats, a?.duration_sec]);
  const gridBeats = grid?.beats ?? beats;
  const firstBeat = beats && beats.length > 0 ? beats[0] : null;

  const cues = useDjCuesStore((s) => (entryId ? s.byEntry[entryId] : undefined));
  const setCue = useDjCuesStore((s) => s.setCue);
  const clearCue = useDjCuesStore((s) => s.clearCue);

  const [loopActive, setLoopActiveSt] = useState(false);
  const [activeLoopBeats, setActiveLoopBeats] = useState<number | null>(null);
  const [slip, setSlipSt] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [keylock, setKeylockSt] = useState(false);
  const [stemNames, setStemNames] = useState<string[]>(() => djEngine.getDeckStemNames(deckId));
  const [stemLevels, setStemLevels] = useState<Record<string, number>>({});
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    setLoopActiveSt((p) => (p === st.loopActive ? p : st.loopActive));
    setSlipSt((p) => (p === st.slip ? p : st.slip));
    setDecoding((p) => (p === st.decoding ? p : st.decoding));
    setKeylockSt((p) => (p === st.keylock ? p : st.keylock));
    setStemNames((p) => (sameStringArray(p, st.stems) ? p : st.stems));
    setStemLevels((p) => (sameNumberRecord(p, st.stemLevels) ? p : st.stemLevels));
  }), [deckId]);
  useEffect(() => { if (!loopActive) setActiveLoopBeats(null); }, [loopActive]);

  const autoCuedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!entryId || autoCuedRef.current === entryId) return;
    if (firstBeat == null || firstBeat <= 0.05) return;
    const st = djEngine.getStatus(deckId);
    if (st.duration <= 0) return;
    if (!st.playing && st.currentTime <= 0.05) djEngine.seekDeck(deckId, firstBeat);
    autoCuedRef.current = entryId;
  }, [entryId, firstBeat, deckId, decoding]);

  // Trim follows loudness-matched auto-gain when enabled, else the manual GAIN knob.
  const autoTrim = a?.rms_db != null ? Math.max(-15, Math.min(15, AUTO_GAIN_TARGET_DB - a.rms_db)) : 0;
  const trimDb = autoGain ? autoTrim : manualGain;
  useEffect(() => { djEngine.setDeckTrim(deckId, trimDb); }, [deckId, trimDb]);

  const setHotcue = (i: number) => {
    if (!entryId) return;
    const c = cues?.[i] ?? null;
    if (c == null) { const pos = djEngine.getStatus(deckId).currentTime; setCue(entryId, i, quantize ? nearestBeat(pos, gridBeats) : pos); }
    else djEngine.seekDeck(deckId, quantize ? nearestBeat(c, gridBeats) : c);
  };
  const dropHotcue = (i: number) => { if (entryId) clearCue(entryId, i); };

  const effBeatLen = beatLen ?? 0.5;
  const toggleBeatLoop = (loopBeats: number) => {
    if (!hasTrack) return;
    if (loopActive && activeLoopBeats === loopBeats) { djEngine.exitLoop(deckId); return; }
    const len = loopBeats * effBeatLen;
    const pos = djEngine.getStatus(deckId).currentTime;
    let inPt = pos;
    if (gridBeats && gridBeats.length) {
      const anchor = snapToBeat(pos, gridBeats);
      inPt = anchor;
      if (loopBeats < 1 && len > 0) inPt = anchor + Math.max(0, Math.floor((pos - anchor) / len)) * len;
    }
    djEngine.setLoop(deckId, inPt, inPt + len);
    setActiveLoopBeats(loopBeats);
  };
  const rollDown = (loopBeats: number) => { if (hasTrack) djEngine.startLoopRoll(deckId, loopBeats * effBeatLen); };
  const rollUp = () => djEngine.endLoopRoll(deckId);
  const beatJump = (n: number) => {
    if (!hasTrack) return;
    const pos = djEngine.getStatus(deckId).currentTime;
    let target = pos + n * effBeatLen;
    if (gridBeats && gridBeats.length) {
      let idx = 0;
      for (let i = 0; i < gridBeats.length; i++) { if (gridBeats[i] <= pos + 0.001) idx = i; else break; }
      target = gridBeats[Math.max(0, Math.min(gridBeats.length - 1, idx + n))];
    }
    djEngine.seekDeck(deckId, target);
  };

  return {
    a, analyzing, cam, bpm, beats, beatLen, gridBeats, firstBeat, cues, trimDb, stemNames, stemLevels,
    loopActive, activeLoopBeats, slip, decoding, keylock,
    setHotcue, dropHotcue, toggleBeatLoop, rollDown, rollUp, beatJump,
    exitLoop: () => djEngine.exitLoop(deckId),
    setKeylock: (on: boolean) => void djEngine.setDeckKeylock(deckId, on),
    setSlip: (on: boolean) => djEngine.setSlip(deckId, on),
  };
}

type DeckCtl = ReturnType<typeof useDeck>;

function EditableBpmField({
  deck,
  sourceBpm,
  pitchPct,
  analyzing,
  color,
  onCommit,
}: {
  deck: 'A' | 'B';
  sourceBpm: number | null;
  pitchPct: number;
  analyzing: boolean;
  color: RGB;
  onCommit: (bpm: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const effectiveBpm = sourceBpm != null && sourceBpm > 0 ? sourceBpm * (1 + pitchPct / 100) : null;

  const beginEdit = () => {
    if (sourceBpm == null || sourceBpm <= 0 || editing) return;
    setDraft((effectiveBpm ?? sourceBpm).toFixed(1));
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [editing]);

  const commit = () => {
    const bpm = Number.parseFloat(draft.trim());
    if (Number.isFinite(bpm) && bpm > 0) onCommit(bpm);
    setEditing(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
    }
  };

  return (
    <div className="h-full w-full grid place-items-center px-1 overflow-hidden">
      <div
        className="flex items-baseline gap-1.5 px-2.5 py-1 rounded-md border tabular-nums"
        style={{
          borderColor: rgba(color, editing ? 0.85 : 0.5),
          background: `linear-gradient(180deg, ${rgba(color, editing ? 0.28 : 0.18)}, ${rgba(color, 0.04)})`,
          boxShadow: `0 0 12px ${rgba(color, editing ? 0.45 : 0.3)}, inset 0 0 6px ${rgba(color, 0.12)}`,
        }}
        title={sourceBpm != null ? 'Hover and type target BPM, then press Enter' : 'Detected tempo'}
        onMouseEnter={beginEdit}
        onClick={beginEdit}
      >
        <span className="text-[7px] font-black uppercase tracking-[0.22em]" style={{ color: rgba(color, 0.85) }}>BPM</span>
        {editing ? (
          <input
            ref={inputRef}
            aria-label={`Deck ${deck} target BPM`}
            className="w-[5.5ch] bg-transparent text-right text-[15px] font-black leading-none text-white outline-none"
            inputMode="decimal"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => setEditing(false)}
            style={{ textShadow: `0 0 8px ${rgba(color, 0.6)}` }}
          />
        ) : (
          <span className="w-[5.5ch] text-right text-[15px] font-black leading-none text-white" style={{ textShadow: `0 0 8px ${rgba(color, 0.6)}` }}>
            {effectiveBpm != null ? effectiveBpm.toFixed(1) : analyzing ? '...' : '-'}
          </span>
        )}
      </div>
    </div>
  );
}

/* ═══ Control-surface default layout ═════════════════════════════════════════
 * Reproduces the console arrangement as a structured rows/columns tree. Pinned
 * panels (hero waveforms, sampler, FX racks, Next lane, source tree, library)
 * host a whole component; every mixer + deck control is an individual widget the
 * user can relocate in Design Mode. Nothing moves until the user drags. */
const DJ_LAYOUT_VERSION = 21;

const defaultDjLayout: SurfaceLayout = {
  version: DJ_LAYOUT_VERSION,
  root: 'root',
  nodes: {
    root: { id: 'root', type: 'container', axis: 'column', children: ['topDecks', 'heroP', 'browserDock'], fr: { topDecks: 5.25, heroP: 1.45, browserDock: 3.45 } },
    topDecks: { id: 'topDecks', type: 'container', axis: 'row', children: ['deckAcont', 'mixer', 'deckBcont'], fr: { deckAcont: 4.25, mixer: 2.75, deckBcont: 4.25 }, framed: true, frameTitle: 'Decks' },
    heroP: { id: 'heroP', type: 'panel', title: 'Waveforms', flow: 'row', widgets: [], pinned: 'hero' },
    browserDock: { id: 'browserDock', type: 'container', axis: 'row', children: ['browserLeft', 'libraryP'], fr: { browserLeft: 2.45, libraryP: 9.6 }, framed: true, frameTitle: 'Browser' },
    browserLeft: { id: 'browserLeft', type: 'container', axis: 'column', children: ['sourceTreeP', 'nextP'], fr: { sourceTreeP: 3.4, nextP: 1.25 } },
    // Left/right rails equalized by default (samplerP == browser).
    body: { id: 'body', type: 'container', axis: 'row', children: ['samplerP', 'center', 'browser'], fr: { samplerP: 2.0, center: 14.963177570093462, browser: 2.0 } },
    samplerP: { id: 'samplerP', type: 'panel', title: 'Sampler', flow: 'row', widgets: [], pinned: 'sampler', uniform: false },
    center: { id: 'center', type: 'container', axis: 'column', children: ['deckmix', 'fxrow'], fr: { deckmix: 5, fxrow: 2 } },
    deckmix: { id: 'deckmix', type: 'container', axis: 'row', children: ['deckAcont', 'mixer', 'deckBcont'], fr: { deckAcont: 4.17953863997903, mixer: 5.180662235484642, deckBcont: 4.439799124536327 } },
    // ── Deck A (pad-rows wrapped with spacer panels in cont-* containers) ──
    deckAcont: { id: 'deckAcont', type: 'container', axis: 'column', children: ['pdA-head', 'waveAOverview', 'cont-10-e11250c4', 'cont-A-transport', 'cont-A-stems', 'fxAP', 'perfAP'], fr: { 'pdA-head': 1.12, waveAOverview: 0.72, 'cont-10-e11250c4': 4.9, 'cont-A-transport': 1.02, 'cont-A-stems': 1.1, fxAP: 3.15, perfAP: 1.35 }, framed: true },
    'pdA-head': { id: 'pdA-head', type: 'panel', title: 'Deck A', flow: 'row', widgets: ['spacer:s-2-7f6f8905', 'keylockA', 'keyA', 'bpmA', 'headerA'], widgetFr: { keylockA: 0.49871465295629847, keyA: 0.8892624085426142, bpmA: 0.8514435436029266, headerA: 2.255932370970932, 'spacer:s-2-7f6f8905': 0.8892624085426142 }, widgetJustify: { headerA: 'start' }, widgetMargins: { 'spacer:s-2-7f6f8905': { t: 0, r: 8, b: 0, l: 0 } }, mirror: false, uniform: false },
    'pdA-jog': { id: 'pdA-jog', type: 'panel', title: 'A · Jog', flow: 'row', widgets: ['jogA'], widgetMargins: { jogA: { t: 2, r: 4, b: 8, l: 4 } }, mirror: true },
    'pdA-mode': { id: 'pdA-mode', type: 'panel', title: 'A · Mode', flow: 'column', widgets: ['syncLockA', 'headCueA'], mirror: true, uniform: true },
    'pdA-trans': { id: 'pdA-trans', type: 'panel', title: 'A · Transport', flow: 'row', widgets: ['cueA', 'playA', 'stopA', 'ejectA', 'syncA'], uniform: true, mirror: true },
    'pdA-stems': { id: 'pdA-stems', type: 'panel', title: 'A · Stems', flow: 'row', widgets: ['stemBankA'], mirror: true },
    'pdA-hc': { id: 'pdA-hc', type: 'panel', title: 'A · Hotcues', flow: 'row', widgets: ['hcA1', 'hcA2', 'hcA3', 'hcA4'], uniform: true, mirror: true },
    'pdA-loop': { id: 'pdA-loop', type: 'panel', title: 'A · Loop', flow: 'row', widgets: ['loopA_0', 'loopA_1', 'loopA_2', 'loopA_3', 'loopA_4', 'loopOutA'], uniform: true, mirror: true },
    'pdA-perf': { id: 'pdA-perf', type: 'panel', title: 'A · Perf', flow: 'row', widgets: ['rollA_0', 'rollA_1', 'rollA_2', 'slipA', 'jumpA_0', 'jumpA_1', 'jumpA_2', 'jumpA_3'], uniform: true, mirror: true },
    // ── Deck B ──
    deckBcont: { id: 'deckBcont', type: 'container', axis: 'column', children: ['pdB-head', 'waveBOverview', 'cont-2-a0e79010', 'cont-B-transport', 'cont-B-stems', 'fxBP', 'perfBP'], fr: { 'pdB-head': 1.12, waveBOverview: 0.72, 'cont-2-a0e79010': 4.9, 'cont-B-transport': 1.02, 'cont-B-stems': 1.1, fxBP: 3.15, perfBP: 1.35 }, framed: true },
    waveAOverview: { id: 'waveAOverview', type: 'panel', title: 'A · Overview', flow: 'row', widgets: [], pinned: 'waveAOverview', mirror: true },
    waveBOverview: { id: 'waveBOverview', type: 'panel', title: 'B · Overview', flow: 'row', widgets: [], pinned: 'waveBOverview' },
    'pdB-head': { id: 'pdB-head', type: 'panel', title: 'Deck B', flow: 'row', widgets: ['spacer:s-1-95993441', 'keylockB', 'keyB', 'bpmB', 'headerB'], widgetFr: { keylockB: 0.5522110739502047, keyB: 1.1040505388331472, bpmB: 1.039483463396507, headerB: 2.209123002601264, 'spacer:s-1-95993441': 0.4797473058342624 }, widgetJustify: { headerB: 'end' }, widgetMargins: { 'spacer:s-1-95993441': { t: 0, r: 0, b: 0, l: 64 } }, mirror: true, uniform: false },
    'pdB-jog': { id: 'pdB-jog', type: 'panel', title: 'B · Jog', flow: 'row', widgets: ['jogB'], widgetMargins: { jogB: { t: 2, r: 4, b: 8, l: 4 } } },
    'pdB-mode': { id: 'pdB-mode', type: 'panel', title: 'B · Mode', flow: 'column', widgets: ['syncLockB', 'headCueB'], uniform: true },
    'pdB-trans': { id: 'pdB-trans', type: 'panel', title: 'B · Transport', flow: 'row', widgets: ['cueB', 'playB', 'stopB', 'ejectB', 'syncB'], uniform: true },
    'pdB-stems': { id: 'pdB-stems', type: 'panel', title: 'B · Stems', flow: 'row', widgets: ['stemBankB'] },
    'pdB-hc': { id: 'pdB-hc', type: 'panel', title: 'B · Hotcues', flow: 'row', widgets: ['hcB1', 'hcB2', 'hcB3', 'hcB4'], uniform: true },
    'pdB-loop': { id: 'pdB-loop', type: 'panel', title: 'B · Loop', flow: 'row', widgets: ['loopB_0', 'loopB_1', 'loopB_2', 'loopB_3', 'loopB_4', 'loopOutB'], uniform: true },
    'pdB-perf': { id: 'pdB-perf', type: 'panel', title: 'B · Perf', flow: 'row', widgets: ['rollB_0', 'rollB_1', 'rollB_2', 'slipB', 'jumpB_0', 'jumpB_1', 'jumpB_2', 'jumpB_3'], uniform: true },
    // ── Mixer ──
    mixer: { id: 'mixer', type: 'container', axis: 'column', children: ['mixToggles', 'mixChans', 'mixXfade'], fr: { mixToggles: 1, mixChans: 6, mixXfade: 1.6 }, framed: true },
    mixToggles: { id: 'mixToggles', type: 'panel', title: 'Modes', flow: 'row', widgets: ['spacer:s-24-02c5d864', 'pitchRange', 'qtz', 'autoGain', 'automix', 'lim', 'midiMap', 'spacer:s-23-936b468e'], uniform: true },
    mixChans: { id: 'mixChans', type: 'container', axis: 'row', children: ['eqAP', 'chAP', 'chBP', 'eqBP'], fr: { eqAP: 1.35, chAP: 1.15, chBP: 1.15, eqBP: 1.35 } },
    pchAP: { id: 'pchAP', type: 'panel', title: 'Pitch A', flow: 'column', widgets: ['pitchA'], widgetMargins: { pitchA: { t: 8, r: 4, b: 8, l: 4 } }, mirror: true },
    eqAP: { id: 'eqAP', type: 'panel', title: 'EQ A', flow: 'column', widgets: ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'], mirror: true },
    chAP: { id: 'chAP', type: 'panel', title: 'Ch A', flow: 'column', widgets: ['volA', 'gainA'], widgetFr: { gainA: 1, volA: 3 }, widgetMargins: { volA: { t: 8, r: 0, b: 8, l: 24 } }, mirror: true },
    chBP: { id: 'chBP', type: 'panel', title: 'Ch B', flow: 'column', widgets: ['gainB', 'volB'], widgetFr: { gainB: 1, volB: 3 }, widgetMargins: { volB: { t: 8, r: 24, b: 8, l: 0 } } },
    eqBP: { id: 'eqBP', type: 'panel', title: 'EQ B', flow: 'column', widgets: ['eqB.hi', 'eqB.mid', 'eqB.lo', 'fltB'] },
    pchBP: { id: 'pchBP', type: 'panel', title: 'Pitch B', flow: 'column', widgets: ['pitchB'], widgetMargins: { pitchB: { t: 8, r: 4, b: 8, l: 4 } }, uniform: false },
    mixXfade: { id: 'mixXfade', type: 'panel', title: 'Crossfade', flow: 'row', widgets: ['spacer:s-22-ffca8259', 'crossfader', 'spacer:s-21-cb584c7d'], widgetFr: { 'spacer:s-22-ffca8259': 0.4556701030927834, crossfader: 2.039175257731959, 'spacer:s-21-cb584c7d': 0.5051546391752577 }, widgetMargins: { crossfader: { t: 16, r: 0, b: 0, l: 0 } }, uniform: false },
    // ── FX row + rails ──
    fxrow: { id: 'fxrow', type: 'container', axis: 'row', children: ['fxAP', 'nextP', 'fxBP'], fr: { fxAP: 0.7703206562266971, nextP: 1.9175988068605512, fxBP: 0.812080536912752 } },
    fxAP: { id: 'fxAP', type: 'panel', title: 'Onboard FX A', flow: 'row', widgets: [], pinned: 'fxA', mirror: true },
    perfAP: { id: 'perfAP', type: 'panel', title: 'Performance Pads A', flow: 'row', widgets: [], pinned: 'perfA', mirror: true },
    nextP: { id: 'nextP', type: 'panel', title: 'Next', flow: 'row', widgets: [], pinned: 'next' },
    fxBP: { id: 'fxBP', type: 'panel', title: 'Onboard FX B', flow: 'row', widgets: [], pinned: 'fxB', uniform: false },
    perfBP: { id: 'perfBP', type: 'panel', title: 'Performance Pads B', flow: 'row', widgets: [], pinned: 'perfB', uniform: false },
    browser: { id: 'browser', type: 'container', axis: 'column', children: ['sourceTreeP', 'libraryP'], fr: { sourceTreeP: 2, libraryP: 3 } },
    sourceTreeP: { id: 'sourceTreeP', type: 'panel', title: 'Sources', flow: 'row', widgets: [], pinned: 'sourceTree' },
    libraryP: { id: 'libraryP', type: 'panel', title: 'Library', flow: 'row', widgets: [], pinned: 'library', uniform: true },
    // ── Deck B pad-row wrappers (pad row + spacer panel) ──
    'panel-1-eff655d2': { id: 'panel-1-eff655d2', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-25-e6518f32'] },
    'cont-2-a0e79010': { id: 'cont-2-a0e79010', type: 'container', axis: 'row', children: ['pdB-mode', 'pdB-jog', 'pchBP', 'panel-1-eff655d2'], fr: { 'pdB-mode': 0.38, 'pdB-jog': 1.56, pchBP: 0.45, 'panel-1-eff655d2': 0.6 } },
    'panel-B-transport-tail': { id: 'panel-B-transport-tail', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-B-transport-tail'] },
    'cont-B-transport': { id: 'cont-B-transport', type: 'container', axis: 'row', children: ['panel-B-transport-tail', 'pdB-trans'], fr: { 'panel-B-transport-tail': 0.48, 'pdB-trans': 2.51 } },
    'panel-B-stems-tail': { id: 'panel-B-stems-tail', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-B-stems-tail'] },
    'cont-B-stems': { id: 'cont-B-stems', type: 'container', axis: 'row', children: ['panel-B-stems-tail', 'pdB-stems'], fr: { 'panel-B-stems-tail': 0.48, 'pdB-stems': 2.51 } },
    'panel-3-e0911657': { id: 'panel-3-e0911657', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-32-4c52fb39'] },
    'cont-4-4f4c96d2': { id: 'cont-4-4f4c96d2', type: 'container', axis: 'row', children: ['pdB-hc', 'panel-3-e0911657'], fr: { 'pdB-hc': 1, 'panel-3-e0911657': 1 } },
    'panel-5-e8707245': { id: 'panel-5-e8707245', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-31-c7e28dbf'] },
    'cont-6-29de8ab7': { id: 'cont-6-29de8ab7', type: 'container', axis: 'row', children: ['pdB-loop', 'panel-5-e8707245'], fr: { 'pdB-loop': 1.3444976076555022, 'panel-5-e8707245': 0.6555023923444977 } },
    'panel-8-81228019': { id: 'panel-8-81228019', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-30-3282c3a3'] },
    'cont-9-aebcd780': { id: 'cont-9-aebcd780', type: 'container', axis: 'row', children: ['pdB-perf', 'panel-8-81228019'], fr: { 'pdB-perf': 1.5358851674641145, 'panel-8-81228019': 0.46411483253588537 } },
    // ── Deck A pad-row wrappers ──
    'cont-10-e11250c4': { id: 'cont-10-e11250c4', type: 'container', axis: 'row', children: ['panel-11-95a4a261', 'pchAP', 'pdA-jog', 'pdA-mode'], fr: { 'panel-11-95a4a261': 0.7, pchAP: 0.45, 'pdA-jog': 1.87, 'pdA-mode': 0.5 } },
    'panel-11-95a4a261': { id: 'panel-11-95a4a261', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-26-79f129b0'] },
    'panel-A-transport-head': { id: 'panel-A-transport-head', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-A-transport-head'] },
    'cont-A-transport': { id: 'cont-A-transport', type: 'container', axis: 'row', children: ['panel-A-transport-head', 'pdA-trans'], fr: { 'panel-A-transport-head': 1.15, 'pdA-trans': 2.37 } },
    'panel-A-stems-head': { id: 'panel-A-stems-head', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-A-stems-head'] },
    'cont-A-stems': { id: 'cont-A-stems', type: 'container', axis: 'row', children: ['panel-A-stems-head', 'pdA-stems'], fr: { 'panel-A-stems-head': 1.15, 'pdA-stems': 2.37 } },
    'panel-12-8772ebc6': { id: 'panel-12-8772ebc6', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-29-e3c2d4fe'] },
    'cont-13-90c67ecb': { id: 'cont-13-90c67ecb', type: 'container', axis: 'row', children: ['panel-12-8772ebc6', 'pdA-hc'], fr: { 'pdA-hc': 1.0814249363867683, 'panel-12-8772ebc6': 0.9185750636132315 } },
    'panel-15-4eb1b108': { id: 'panel-15-4eb1b108', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-28-3698f484'] },
    'cont-16-c9fc3a59': { id: 'cont-16-c9fc3a59', type: 'container', axis: 'row', children: ['panel-15-4eb1b108', 'pdA-loop'], fr: { 'pdA-loop': 1.3664122137404573, 'panel-15-4eb1b108': 0.6335877862595417 } },
    'panel-17-44cba1fb': { id: 'panel-17-44cba1fb', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-27-8799ff7e'] },
    'cont-18-cd01de17': { id: 'cont-18-cd01de17', type: 'container', axis: 'row', children: ['panel-17-44cba1fb', 'pdA-perf'], fr: { 'pdA-perf': 1.4885496183206104, 'panel-17-44cba1fb': 0.5114503816793893 } },
  },
};

/* ═══════════════════════════════ DJView ════════════════════════════════════ */

export const DJView: React.FC = () => {
  const [deckATrack, setDeckATrack] = useState<string | null>(null);
  const [deckBTrack, setDeckBTrack] = useState<string | null>(null);
  const [deckAPlaying, setDeckAPlaying] = useState(false);
  const [deckBPlaying, setDeckBPlaying] = useState(false);
  const [crossfader, setCrossfader] = useState(() => djEngine.getCrossfade());
  const [deckAPitch, setDeckAPitch] = useState(0);
  const [deckBPitch, setDeckBPitch] = useState(0);
  const [pitchRange, setPitchRange] = useState<PitchRange>(10);
  const [syncLock, setSyncLock] = useState<djEngine.DeckId | null>(null);
  const [quantize, setQuantize] = useState(false);
  const [autoGain, setAutoGain] = useState(true);
  const [vinylSpinA, setVinylSpinA] = useState(false);
  const [vinylSpinB, setVinylSpinB] = useState(false);
  const [gainA, setGainA] = useState(0);
  const [gainB, setGainB] = useState(0);
  const [eqA, setEqA] = useState({ low: 0, mid: 0, high: 0 });
  const [eqB, setEqB] = useState({ low: 0, mid: 0, high: 0 });
  const [filterA, setFilterA] = useState(0);
  const [filterB, setFilterB] = useState(0);
  const [stemKnobModeA, setStemKnobModeA] = useState(false);
  const [stemKnobModeB, setStemKnobModeB] = useState(false);
  const [volA, setVolA] = useState(1);
  const [volB, setVolB] = useState(1);
  const [cueA, setCueA] = useState(false);
  const [cueB, setCueB] = useState(false);
  const [midiMapOpen, setMidiMapOpen] = useState(false);
  const [automixOn, setAutomixOn] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const automixRef = useRef<{ current: djEngine.DeckId; fading: boolean; fadeStart: number; fadeFrom: number; fadeTo: number } | null>(null);
  const [source, setSource] = useState<Source>({ kind: 'library' });
  // Lifted out of the old Mixer so the surface widget closures can drive them.
  const [limiterOn, setLimiterOn] = useState(() => djEngine.getLimiter());
  const cueSupported = djEngine.isCueSupported();
  const [cueDevices, setCueDevices] = useState<Array<{ id: string; label: string }>>([]);
  const [cueDev, setCueDev] = useState(() => djEngine.getCueSinkId());
  useEffect(() => {
    if (!cueSupported || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((ds) =>
        setCueDevices(
          ds.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label || 'Output' })),
        ),
      )
      .catch(() => {
        /* labels need permission; ids still resolve */
      });
  }, [cueSupported]);

  const entries = useLibraryStore((s) => s.entries);
  const analyzeAll = useDjAnalysisStore((s) => s.analyzeAll);
  const djTabActive = useAppUiStore((s) => s.centerTab === 'dj');
  const setlists = useSetlistStore((s) => s.setlists);
  const activeId = useSetlistStore((s) => s.activeId);
  const appendToSet = useSetlistStore((s) => s.append);
  const importBundledSetlists = useSetlistStore((s) => s.importBundled);
  const activeSet = activeId ? setlists[activeId] : null;
  useEffect(() => { void importBundledSetlists(); }, [importBundledSetlists]);

  const trackById = (id: string | null): LibraryEntry | null => (id ? entries.find((e) => e.id === id) ?? null : null);
  const deckATitle = trackById(deckATrack)?.title ?? null;
  const deckBTitle = trackById(deckBTrack)?.title ?? null;
  const deckAUrl = trackById(deckATrack)?.audioUrl ?? null;
  const deckBUrl = trackById(deckBTrack)?.audioUrl ?? null;

  const ctlA = useDeck('A', deckATrack, !!deckATrack, quantize, autoGain, gainA);
  const ctlB = useDeck('B', deckBTrack, !!deckBTrack, quantize, autoGain, gainB);

  const camA = ctlA.cam;
  const camB = ctlB.cam;
  const harmonic = camA && camB ? camA.compatible.includes(camB.code) : null;
  const canSync = !!ctlA.a?.bpm && !!ctlB.a?.bpm;
  const clampToPitchRange = (v: number) => clamp(v, -pitchRange, pitchRange);

  const deckATrackRef = useRef<string | null>(deckATrack);
  const deckBTrackRef = useRef<string | null>(deckBTrack);
  deckATrackRef.current = deckATrack;
  deckBTrackRef.current = deckBTrack;
  const pendingPlayRef = useRef<djEngine.DeckId | null>(null);
  const masterPlayingRef = useRef(false);

  const loadDeck = (entryId: string, deck: djEngine.DeckId) => { if (deck === 'A') setDeckATrack(entryId); else setDeckBTrack(entryId); };
  const loadDropOntoDeck = async (event: React.DragEvent, deck: djEngine.DeckId): Promise<boolean> => {
    const entryId = event.dataTransfer.getData(DJ_TRACK_MIME);
    if (entryId) {
      event.preventDefault();
      loadDeck(entryId, deck);
      return true;
    }

    const file = Array.from(event.dataTransfer.files).find(isExternalAudioFile);
    if (!file) return false;

    event.preventDefault();
    setFlash(`Importing "${file.name}" to Deck ${deck}…`);
    try {
      const entry = await importAudioFileToLibrary(file);
      loadDeck(entry.id, deck);
      setFlash(`Loaded "${entry.title}" on Deck ${deck}`);
      return true;
    } catch (e) {
      setFlash(`Deck ${deck} import failed`);
      return false;
    }
  };
  const ejectDeck = (deck: djEngine.DeckId) => {
    djEngine.stopDeck(deck);
    if (deck === 'A') setDeckATrack(null);
    else setDeckBTrack(null);
    setFlash(`Deck ${deck} ejected`);
  };

  useEffect(() => {
    return djEngine.subscribe((a, b) => {
      setDeckAPlaying(a.playing);
      setDeckBPlaying(b.playing);
      const pend = pendingPlayRef.current;
      if (pend) {
        const st = pend === 'A' ? a : b;
        if (st.hasBuffer && !st.decoding && !st.playing) { djEngine.playDeck(pend); pendingPlayRef.current = null; }
      }
      const playing = a.playing || b.playing;
      if (playing !== masterPlayingRef.current) { masterPlayingRef.current = playing; reportDjMasterState(playing ? 'playing' : 'paused'); }
    });
  }, []);

  useEffect(() => {
    const startSet = () => {
      const aHas = !!deckATrackRef.current;
      const bHas = !!deckBTrackRef.current;
      if (aHas || bHas) { if (aHas) djEngine.playDeck('A'); if (bHas) djEngine.playDeck('B'); return; }
      const sl = useSetlistStore.getState();
      const set = sl.activeId ? sl.setlists[sl.activeId] : null;
      const first = set?.entries.find((e) => e.entryId) ?? null;
      if (first?.entryId) { pendingPlayRef.current = 'A'; setDeckATrack(first.entryId); }
    };
    return registerDjMasterHandler({
      toggle: () => {
        const aPlaying = djEngine.getStatus('A').playing;
        const bPlaying = djEngine.getStatus('B').playing;
        if (aPlaying || bPlaying) { if (aPlaying) djEngine.pauseDeck('A'); if (bPlaying) djEngine.pauseDeck('B'); reportDjMasterState('paused'); }
        else { startSet(); reportDjMasterState('playing'); }
      },
      getState: () => djEngine.getStatus('A').playing || djEngine.getStatus('B').playing ? 'playing' : 'paused',
    });
  }, []);

  useEffect(() => { if (djTabActive && entries.length) void analyzeAll(entries.map((e) => e.id)); }, [djTabActive, entries, analyzeAll]);

  useEffect(() => {
    setDeckAPitch((prev) => {
      const next = clamp(prev, -pitchRange, pitchRange);
      if (next !== prev) djEngine.setDeckPitch('A', next);
      return next;
    });
    setDeckBPitch((prev) => {
      const next = clamp(prev, -pitchRange, pitchRange);
      if (next !== prev) djEngine.setDeckPitch('B', next);
      return next;
    });
  }, [pitchRange]);

  useEffect(() => {
    const t = trackById(deckATrack);
    void djEngine.loadDeck('A', t ? (t.audioUrl ?? null) : null, t?.title ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckATrack]);
  useEffect(() => {
    const t = trackById(deckBTrack);
    void djEngine.loadDeck('B', t ? (t.audioUrl ?? null) : null, t?.title ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckBTrack]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const addDeckToSet = (which: 'A' | 'B') => {
    if (!activeId) { setFlash('Create a set first (Lists & Advice ›)'); return; }
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    appendToSet(activeId, [{ entryId: track.id, label: track.title, kind: 'audio' }]);
    setFlash(`Added "${track.title}" to ${activeSet?.name ?? 'set'}`);
  };
  const sendDeckToVj = (which: 'A' | 'B') => {
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    sendTrackToVj({ entryId: track.id, label: track.title, url: track.audioUrl, kind: 'audio' });
    setFlash(isVjSetTargetActive() ? `Sent "${track.title}" to VJ` : `Queued "${track.title}" — opens with VJ tab`);
  };

  const syncDeck = (which: djEngine.DeckId): djEngine.DeckId | null => {
    const aStatus = djEngine.getStatus('A');
    const bStatus = djEngine.getStatus('B');
    const oneDeckPlaying = aStatus.playing !== bStatus.playing;
    const follower: djEngine.DeckId = oneDeckPlaying
      ? (aStatus.playing ? 'B' : 'A')
      : which;
    const master: djEngine.DeckId = follower === 'A' ? 'B' : 'A';

    const followerCtl = follower === 'A' ? ctlA : ctlB;
    const masterCtl = master === 'A' ? ctlA : ctlB;
    const followerBpm = followerCtl.a?.bpm ?? null;
    const masterBpm = masterCtl.a?.bpm ?? null;
    if (!followerBpm || !masterBpm) return null;
    const masterPitch = master === 'A' ? deckAPitch : deckBPitch;
    const masterEffBpm = masterBpm * (1 + masterPitch / 100);
    let rate = masterEffBpm / followerBpm;
    while (rate > Math.SQRT2) rate /= 2;
    while (rate < Math.SQRT1_2) rate *= 2;
    const pct = clampToPitchRange((rate - 1) * 100);
    if (follower === 'A') setDeckAPitch(pct); else setDeckBPitch(pct);
    djEngine.setDeckPitch(follower, pct);
    const followerBeats = followerCtl.a?.beats ?? null;
    const masterBeats = masterCtl.a?.beats ?? null;
    const masterStatus = master === 'A' ? aStatus : bStatus;
    const followerStatus = follower === 'A' ? aStatus : bStatus;
    if (followerBeats && masterBeats && masterStatus.playing && followerStatus.playing) {
      const interval = 60 / (followerBpm * rate);
      let delta = (beatPhase(masterStatus.currentTime, masterBeats) - beatPhase(followerStatus.currentTime, followerBeats)) * interval;
      if (delta > interval / 2) delta -= interval;
      if (delta < -interval / 2) delta += interval;
      djEngine.seekDeck(follower, followerStatus.currentTime + delta);
    }
    setFlash(`BPM Sync: Deck ${follower} follows Deck ${master} at ${masterEffBpm.toFixed(1)} BPM`);
    return follower;
  };
  const toggleSyncLock = (which: djEngine.DeckId) => {
    const synced = syncDeck(which);
    if (!synced) return;
    if (syncLock === synced) { setSyncLock(null); return; }
    setSyncLock(synced);
    setFlash(`Sync-Lock: Deck ${synced} follows Deck ${synced === 'A' ? 'B' : 'A'}`);
  };

  const aData = ctlA.a;
  const bData = ctlB.a;
  useEffect(() => {
    if (!syncLock) return;
    const follower = syncLock;
    const fBpm = (follower === 'A' ? aData : bData)?.bpm ?? null;
    const mBpm = (follower === 'A' ? bData : aData)?.bpm ?? null;
    const fBeats = (follower === 'A' ? aData : bData)?.beats ?? null;
    const mBeats = (follower === 'A' ? bData : aData)?.beats ?? null;
    if (!fBpm || !mBpm || !fBeats || !mBeats) return;
    const KP = 12, MAX_BEND = 4, DEADBAND = 0.02;
    const master: djEngine.DeckId = follower === 'A' ? 'B' : 'A';
    const id = window.setInterval(() => {
      const fs = djEngine.getStatus(follower);
      const ms = djEngine.getStatus(master);
      if (!fs.playing || !ms.playing) return;
      const mEff = mBpm * (1 + ms.pitchPct / 100);
      let rate = mEff / fBpm;
      while (rate > Math.SQRT2) rate /= 2;
      while (rate < Math.SQRT1_2) rate *= 2;
      let dPhase = beatPhase(ms.currentTime, mBeats) - beatPhase(fs.currentTime, fBeats);
      if (dPhase > 0.5) dPhase -= 1;
      if (dPhase < -0.5) dPhase += 1;
      const bend = Math.abs(dPhase) > DEADBAND ? Math.max(-MAX_BEND, Math.min(MAX_BEND, dPhase * KP)) : 0;
      const pct = clampToPitchRange((rate - 1) * 100 + bend);
      djEngine.setDeckPitch(follower, pct);
      if (follower === 'A') setDeckAPitch(pct); else setDeckBPitch(pct);
    }, 350);
    return () => window.clearInterval(id);
  }, [syncLock, aData, bData, pitchRange]);

  const onPitch = (which: djEngine.DeckId, v: number) => {
    const pitch = clampToPitchRange(v);
    if (syncLock === which) setSyncLock(null);
    if (which === 'A') setDeckAPitch(pitch); else setDeckBPitch(pitch);
    djEngine.setDeckPitch(which, pitch);
  };
  const onTargetBpm = (which: djEngine.DeckId, bpm: number) => {
    const sourceBpm = (which === 'A' ? ctlA.bpm : ctlB.bpm) ?? null;
    if (!sourceBpm || sourceBpm <= 0) return;
    const rawPitch = (bpm / sourceBpm - 1) * 100;
    const pitch = clampToPitchRange(rawPitch);
    onPitch(which, pitch);
    const effectiveBpm = sourceBpm * (1 + pitch / 100);
    if (Math.abs(effectiveBpm - bpm) > 0.05) {
      setFlash(`Deck ${which}: ${bpm.toFixed(1)} BPM is outside pitch range; set ${effectiveBpm.toFixed(1)} BPM`);
    } else {
      setFlash(`Deck ${which}: ${effectiveBpm.toFixed(1)} BPM`);
    }
  };
  const onEq = (which: djEngine.DeckId, band: 'low' | 'mid' | 'high', v: number) => {
    if (which === 'A') setEqA((p) => ({ ...p, [band]: v })); else setEqB((p) => ({ ...p, [band]: v }));
    djEngine.setDeckEq(which, band, v);
  };
  const onFilter = (which: djEngine.DeckId, v: number) => { if (which === 'A') setFilterA(v); else setFilterB(v); djEngine.setDeckFilter(which, v); };
  const onVol = (which: djEngine.DeckId, v: number) => { if (which === 'A') setVolA(v); else setVolB(v); djEngine.setDeckVolume(which, v); };
  const onGain = (which: djEngine.DeckId, v: number) => { if (which === 'A') setGainA(v); else setGainB(v); };
  const toggleCue = (which: djEngine.DeckId) => {
    const next = which === 'A' ? !cueA : !cueB;
    if (which === 'A') setCueA(next); else setCueB(next);
    djEngine.setDeckCue(which, next);
  };
  const toggleDeckWithSpin = (which: djEngine.DeckId) => {
    const spin = which === 'A' ? vinylSpinA : vinylSpinB;
    if (djEngine.getStatus(which).playing) djEngine.pauseDeck(which);
    else djEngine.playDeck(which, { spinUp: spin });
  };
  const stopDeckAtNextCue = (which: djEngine.DeckId) => {
    const spin = which === 'A' ? vinylSpinA : vinylSpinB;
    const ctl = which === 'A' ? ctlA : ctlB;
    const status = djEngine.getStatus(which);
    const cue = nextCueAfter(ctl.cues, status.currentTime);
    if (cue == null) {
      djEngine.stopDeck(which, { windDown: spin });
      return;
    }
    const target = quantize ? nearestBeat(cue, ctl.gridBeats) : cue;
    djEngine.stopDeck(which, { windDown: spin, targetOffset: target });
    setFlash(`Deck ${which} cue -> ${fmtTime(target)}`);
  };
  const applyCrossfade = (v: number) => { setCrossfader(v); djEngine.setCrossfade(v); };

  // DJ MIDI-learn (D6): rebuild the action→handler map each render (cheap; closes
  // over current state) and read it from a ref inside the one midiBus subscriber.
  const midiHandlersRef = useRef<Record<string, (v: number) => void>>({});
  midiHandlersRef.current = (() => {
    const h: Record<string, (v: number) => void> = { xfader: (v) => applyCrossfade((v / 127) * 2 - 1) };
    for (const d of ['A', 'B'] as djEngine.DeckId[]) {
      const ctl = d === 'A' ? ctlA : ctlB;
      h[`play${d}`] = () => toggleDeckWithSpin(d);
      h[`cue${d}`] = () => djEngine.cueDeck(d);
      h[`stop${d}`] = () => stopDeckAtNextCue(d);
      h[`sync${d}`] = () => syncDeck(d);
      h[`headcue${d}`] = () => toggleCue(d);
      h[`vol${d}`] = (v) => onVol(d, v / 127);
      h[`gain${d}`] = (v) => onGain(d, (v / 127) * 24 - 12);
      h[`filter${d}`] = (v) => {
        const mode = d === 'A' ? stemKnobModeA : stemKnobModeB;
        const stem = mode ? findStemForSlot(ctl.stemNames, STEM_MIXER_KNOB_SLOTS.flt.aliases) : null;
        if (stem) djEngine.setStemGain(d, stem, v / 127);
        else onFilter(d, (v / 127) * 2 - 1);
      };
      h[`pitch${d}`] = (v) => onPitch(d, (v / 127) * (pitchRange * 2) - pitchRange);
      h[`eq${d}.high`] = (v) => {
        const mode = d === 'A' ? stemKnobModeA : stemKnobModeB;
        const stem = mode ? findStemForSlot(ctl.stemNames, STEM_MIXER_KNOB_SLOTS.hi.aliases) : null;
        if (stem) djEngine.setStemGain(d, stem, v / 127);
        else onEq(d, 'high', (v / 127) * 24 - 12);
      };
      h[`eq${d}.mid`] = (v) => {
        const mode = d === 'A' ? stemKnobModeA : stemKnobModeB;
        const stem = mode ? findStemForSlot(ctl.stemNames, STEM_MIXER_KNOB_SLOTS.mid.aliases) : null;
        if (stem) djEngine.setStemGain(d, stem, v / 127);
        else onEq(d, 'mid', (v / 127) * 24 - 12);
      };
      h[`eq${d}.low`] = (v) => {
        const mode = d === 'A' ? stemKnobModeA : stemKnobModeB;
        const stem = mode ? findStemForSlot(ctl.stemNames, STEM_MIXER_KNOB_SLOTS.lo.aliases) : null;
        if (stem) djEngine.setStemGain(d, stem, v / 127);
        else onEq(d, 'low', (v / 127) * 24 - 12);
      };
      for (let i = 0; i < STEM_PAD_SLOTS; i++) {
        h[`stem${d}${i}`] = () => {
          const name = ctl.stemNames[i];
          if (!name) return;
          const cur = djEngine.getStemGain(d, name);
          djEngine.setStemGain(d, name, cur > 0.001 ? 0 : 1);
        };
      }
      for (const n of [1, 2, 3, 4]) h[`hotcue${d}${n}`] = () => ctl.setHotcue(n - 1);
    }
    return h;
  })();
  useEffect(() => {
    return subscribeToMidi((msg) => {
      const data = msg.data;
      if (!data || data.length < 2) return;
      const status = data[0] & 0xf0;
      const channel = data[0] & 0x0f;
      const number = data[1];
      const value = data.length > 2 ? data[2] : 0;
      const kind: MidiKind | null = status === 0xb0 ? 'cc' : (status === 0x90 || status === 0x80) ? 'note' : null;
      if (!kind) return;
      const store = useDjControlMap.getState();
      if (store.learnAction) { store.bind(store.learnAction, { kind, number, channel }); return; }
      for (const actionId in store.bindings) {
        const sig = store.bindings[actionId];
        if (sig.kind !== kind || sig.number !== number || (sig.channel !== null && sig.channel !== channel)) continue;
        const fn = midiHandlersRef.current[actionId];
        if (!fn) continue;
        const action = MIDI_ACTION_BY_ID.get(actionId);
        if (kind === 'note') { if (status === 0x90 && value > 0) fn(value); }
        else if (action?.kind === 'note') { if (value > 0) fn(value); }
        else fn(value);
      }
    });
  }, []);

  // Automix (D7): auto-sequence the active set across the 2 decks — beatmatch
  // the next track and crossfade at each tail, then advance. Pure orchestration
  // over the existing engine (no new deps). Drives the real deck loaders + sync.
  useEffect(() => {
    if (!automixOn) { automixRef.current = null; return; }
    const seq = (): string[] => {
      const sl = useSetlistStore.getState();
      const set = sl.activeId ? sl.setlists[sl.activeId] : null;
      return (set?.entries ?? []).map((e) => e.entryId).filter((x): x is string => !!x);
    };
    const list = seq();
    if (list.length < 2) { setFlash('Automix needs an active set with ≥2 tracks'); setAutomixOn(false); return; }
    const other = (d: djEngine.DeckId): djEngine.DeckId => (d === 'A' ? 'B' : 'A');
    const loadOnto = (d: djEngine.DeckId, entryId: string) => (d === 'A' ? setDeckATrack : setDeckBTrack)(entryId);
    const loadNextAfter = (entryId: string | null, onto: djEngine.DeckId) => {
      const l = seq();
      const i = entryId ? l.indexOf(entryId) : -1;
      const ni = i >= 0 ? i + 1 : 1;
      if (ni < l.length && l[ni] !== deckATrackRef.current && l[ni] !== deckBTrackRef.current) loadOnto(onto, l[ni]);
    };

    // Init: current = a playing deck, else Deck A seeded with the first track.
    const current: djEngine.DeckId = djEngine.getStatus('A').playing ? 'A' : djEngine.getStatus('B').playing ? 'B' : 'A';
    const curEntry = current === 'A' ? deckATrackRef.current : deckBTrackRef.current;
    if (!curEntry) { loadOnto(current, list[0]); pendingPlayRef.current = current; }
    automixRef.current = { current, fading: false, fadeStart: 0, fadeFrom: 0, fadeTo: 0 };
    loadNextAfter(curEntry ?? list[0], other(current));
    setFlash('Automix on — sequencing the set');

    const id = window.setInterval(() => {
      const mix = automixRef.current;
      if (!mix) return;
      const cur = mix.current;
      const nxt = other(cur);
      const cs = djEngine.getStatus(cur);
      const ns = djEngine.getStatus(nxt);
      const now = performance.now();
      if (!mix.fading) {
        if (cs.playing && cs.duration > 0 && cs.duration - cs.currentTime <= AUTOMIX_TAIL && ns.hasBuffer) {
          syncDeck(nxt);              // beatmatch the incoming deck to the outgoing tempo + phase
          djEngine.seekDeck(nxt, 0);
          djEngine.playDeck(nxt);
          mix.fading = true; mix.fadeStart = now; mix.fadeFrom = djEngine.getCrossfade(); mix.fadeTo = nxt === 'B' ? 1 : -1;
          setFlash(`Automix: blending → Deck ${nxt}`);
        }
      } else {
        const t = Math.min(1, (now - mix.fadeStart) / (AUTOMIX_XFADE * 1000));
        applyCrossfade(mix.fadeFrom + (mix.fadeTo - mix.fadeFrom) * t);
        if (t >= 1 || !cs.playing) {
          if (cs.playing) djEngine.pauseDeck(cur);
          mix.current = nxt;
          mix.fading = false;
          loadNextAfter(nxt === 'A' ? deckATrackRef.current : deckBTrackRef.current, cur); // queue the following track on the freed deck
        }
      }
    }, 500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automixOn]);

  // Build the surface widget registry every render so each control's closure
  // carries live state/wiring; relocating a widget only changes where it draws.
  const registry = buildDjRegistry({
    ctlA, ctlB,
    deckATitle, deckBTitle, camA, camB, harmonic,
    hasA: !!deckATrack, hasB: !!deckBTrack,
    playingA: deckAPlaying, playingB: deckBPlaying,
    cueA, cueB, syncLock, canSync,
    onPlayA: () => toggleDeckWithSpin('A'), onPlayB: () => toggleDeckWithSpin('B'),
    onCueA: () => djEngine.cueDeck('A'), onCueB: () => djEngine.cueDeck('B'),
    onStop: stopDeckAtNextCue, onEject: ejectDeck,
    onSync: syncDeck, onSyncLock: toggleSyncLock, onHeadCue: toggleCue,
    onSendVj: sendDeckToVj, onAddSet: addDeckToSet,
    deckAUrl, deckBUrl, deckATrack, deckBTrack, setDeckATrack, setDeckBTrack,
    source, setSource, libCount: entries.length, loadDeck, loadDropOntoDeck,
    gainA, gainB, eqA, eqB, filterA, filterB, volA, volB,
    stemKnobModeA, stemKnobModeB, setStemKnobModeA, setStemKnobModeB,
    pitchA: deckAPitch, pitchB: deckBPitch, bpmA: ctlA.bpm ?? null, bpmB: ctlB.bpm ?? null,
    pitchRange, setPitchRange,
    onGain, onEq, onFilter, onVol, onPitch, onTargetBpm,
    crossfader, onCrossfade: applyCrossfade,
    quantize, setQuantize, autoGain, setAutoGain,
    vinylSpinA, setVinylSpinA, vinylSpinB, setVinylSpinB,
    limiterOn, setLimiterOn, cueSupported, cueDevices, cueDev, setCueDev,
    midiMapOn: midiMapOpen, onToggleMidiMap: () => setMidiMapOpen((v) => !v),
    automixOn, onToggleAutomix: () => setAutomixOn((v) => !v),
  });

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#07050a] text-white">
      <ControlSurface
        surfaceId="dj"
        registry={registry}
        defaultLayout={defaultDjLayout}
        targets={DJ_TARGETS}
        legacyKeyToClear="thedaw.dj.layout.v1"
        className="p-1.5"
      />
      {midiMapOpen && (
        <DjMidiMap
          onClose={() => {
            setMidiMapOpen(false);
            useDjControlMap.getState().arm(null);
          }}
        />
      )}
    </div>
  );
};

/* ═══════════════════════════════ WaveLane ═══════════════════════════════════ */

interface WaveLaneProps {
  deckId: djEngine.DeckId; accent: 'purple' | 'cyan'; entryId: string | null;
  hasTrack: boolean; audioUrl: string | null; ctl: DeckCtl; onLoadDrop: (event: React.DragEvent, deck: djEngine.DeckId) => Promise<boolean>;
  mode?: 'overview' | 'detail';
  compact?: boolean;
}

const WaveLane: React.FC<WaveLaneProps> = ({ deckId, accent, hasTrack, audioUrl, ctl, onLoadDrop, mode = 'detail', compact = false }) => {
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const accentBorder = accent === 'purple' ? 'border-purple-500/30' : 'border-cyan-500/30';
  const [dropHover, setDropHover] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    if (!hasDeckLoadDragData(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHover(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropHover(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    setDropHover(false);
    if (!hasDeckLoadDragData(e)) return;
    e.stopPropagation();
    await onLoadDrop(e, deckId);
  };
  const height = compact ? 34 : mode === 'overview' ? 44 : 62;
  return (
    <div
      className={`flex-1 min-h-0 relative rounded border ${accentBorder} bg-black/40 overflow-hidden ${dropHover ? 'ring-2 ring-inset ring-white/50' : ''}`}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => { void onDrop(e); }}
    >
      {!compact && (
        <span className={`absolute top-1 left-2 z-30 flex items-center gap-1 text-[8px] font-black uppercase tracking-[0.18em] pointer-events-none ${accentText}`}>
          <Disc className="w-2.5 h-2.5" /> Deck {deckId} · {mode === 'overview' ? 'overview' : 'scroll'}
        </span>
      )}
      {audioUrl ? <DeckWaveform deckId={deckId} audioUrl={audioUrl} beats={ctl.gridBeats} cues={ctl.cues ?? null} accent={accent} height={height} mode={mode} />
        : <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-700">{hasTrack ? '…' : 'drop a song here →'}</div>}
    </div>
  );
};

const PlatterDropTarget: React.FC<{
  deckId: djEngine.DeckId;
  color: RGB;
  hasTrack: boolean;
  bpm: number | null;
  pitchPct: number;
  onLoadDrop: (event: React.DragEvent, deck: djEngine.DeckId) => Promise<boolean>;
}> = ({ deckId, color, hasTrack, bpm, pitchPct, onLoadDrop }) => {
  const [dropHover, setDropHover] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    if (!hasDeckLoadDragData(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHover(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropHover(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    setDropHover(false);
    if (!hasDeckLoadDragData(e)) return;
    e.stopPropagation();
    await onLoadDrop(e, deckId);
  };

  return (
    <div
      className={`relative h-full w-full grid place-items-center rounded overflow-hidden transition-colors ${dropHover ? 'bg-white/6 ring-2 ring-inset' : ''}`}
      style={{ '--deck-ring': rgba(color, 0.9), '--deck-glow': rgba(color, 0.28) } as React.CSSProperties}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => { void onDrop(e); }}
      title={`Drop a track on Deck ${deckId} platter`}
    >
      <div className={`absolute inset-1 rounded-full pointer-events-none transition-opacity ${dropHover ? 'opacity-100' : 'opacity-0'}`} style={{ border: `1px solid ${rgba(color, 0.75)}`, boxShadow: `0 0 22px ${rgba(color, 0.45)}, inset 0 0 18px ${rgba(color, 0.16)}` }} />
      <JogWheel deckId={deckId} color={color} bpm={bpm} pitchPct={pitchPct} disabled={!hasTrack} fill fillScale={0.88} />
      {dropHover && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="rounded bg-black/75 border px-2 py-1 text-[8px] font-black uppercase tracking-wider" style={{ borderColor: rgba(color, 0.7), color: rgb(color), boxShadow: `0 0 14px ${rgba(color, 0.35)}` }}>
            Drop on {deckId}
          </div>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════ SamplerRail ════════════════════════════════ */

const SAMPLER_SLOTS = 10;

/** Sampler bank (D7): 10 one-shot pads. Drop a library track onto a pad to load
 *  it; click fires it (polyphonic, through the DJ master); right-click clears.
 *  Pad→track assignments persist (djSamplerStore); buffers re-decode on mount. */
const SamplerRail: React.FC = () => {
  const pads = useDjSampler((s) => s.pads);
  const setPad = useDjSampler((s) => s.setPad);
  const clearPad = useDjSampler((s) => s.clearPad);
  const entries = useLibraryStore((s) => s.entries);
  const [over, setOver] = useState<number | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  // Decode each persisted pad's sample into the engine once (after a reload).
  useEffect(() => {
    for (const [k, pad] of Object.entries(pads)) {
      const i = Number(k);
      const tag = `sampler:${i}:${pad.entryId}`;
      if (loadedRef.current.has(tag)) continue;
      const entry = entries.find((e) => e.id === pad.entryId);
      if (!entry?.audioUrl) continue;
      loadedRef.current.add(tag);
      void djEngine.loadSample(`sampler:${i}`, entry.audioUrl).catch(() => loadedRef.current.delete(tag));
    }
  }, [pads, entries]);

  const drop = async (i: number, e: React.DragEvent) => {
    setOver(null);
    const entryId = e.dataTransfer.getData(DJ_TRACK_MIME);
    if (!entryId) return;
    e.preventDefault();
    const entry = entries.find((x) => x.id === entryId);
    if (!entry?.audioUrl) return;
    try {
      await djEngine.loadSample(`sampler:${i}`, entry.audioUrl);
      loadedRef.current.add(`sampler:${i}:${entryId}`);
      setPad(i, { entryId, name: entry.title });
    } catch { /* decode/fetch failed — leave the pad empty */ }
  };

  return (
    <div className="hardware-card flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        <Sparkles className="w-3 h-3 text-amber-300 shrink-0" />
        <span className="text-[9px] font-black uppercase tracking-wider text-amber-200 leading-tight">Sampler</span>
        <span className="ml-auto text-[7px] font-mono text-zinc-600">drag tracks →</span>
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-1 p-1.5 content-start">
        {Array.from({ length: SAMPLER_SLOTS }, (_, i) => {
          const pad = pads[i];
          return (
            <button key={i} type="button"
              onClick={() => { if (pad) djEngine.triggerSample(`sampler:${i}`); }}
              onContextMenu={(e) => { e.preventDefault(); if (pad) { djEngine.clearSample(`sampler:${i}`); clearPad(i); } }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes(DJ_TRACK_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(i); } }}
              onDragLeave={() => setOver((o) => (o === i ? null : o))}
              onDrop={(e) => void drop(i, e)}
              title={pad ? `${pad.name} — click to fire, right-click to clear` : 'Drop a library track here to load a one-shot'}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-md border py-1.5 transition-colors active:scale-95 ${
                over === i ? 'border-amber-400/70 bg-amber-500/15'
                  : pad ? 'border-amber-500/40 bg-amber-500/8 text-amber-200 hover:bg-amber-500/15'
                    : 'border-white/10 bg-black/40 text-zinc-600 hover:border-white/20'
              }`}>
              <span className="text-[11px] font-black leading-none">{i === 9 ? 0 : i + 1}</span>
              <span className="text-[7px] font-mono uppercase tracking-wide leading-none truncate max-w-full px-0.5">{pad ? pad.name : '—'}</span>
            </button>
          );
        })}
      </div>
      <div className="shrink-0 px-1.5 pb-1.5 text-[7px] font-mono text-zinc-600 text-center">click fires · right-click clears</div>
    </div>
  );
};

/* elapsed / remaining time — updated imperatively off the engine (no re-render). */
const DeckTimes: React.FC<{ deckId: djEngine.DeckId; mirror?: boolean }> = ({ deckId, mirror }) => {
  const elapRef = useRef<HTMLSpanElement>(null);
  const remRef = useRef<HTMLSpanElement>(null);
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    if (elapRef.current) elapRef.current.textContent = fmtTime(st.currentTime);
    if (remRef.current) remRef.current.textContent = '-' + fmtTime(Math.max(0, st.duration - st.currentTime));
  }), [deckId]);
  return (
    <span className={`flex items-center gap-1.5 text-[8px] font-mono tabular-nums text-zinc-500 leading-tight ${mirror ? 'flex-row-reverse' : ''}`}>
      <span ref={elapRef}>0:00</span>
      <span className="text-zinc-700" ref={remRef}>-0:00</span>
    </span>
  );
};

/* ═══════════════════════════════ DeckRack (FX + STEMS, scaffold) ════════════ */

const DJ_FX: Array<{ key: djEngine.DjFx; label: string }> = [
  { key: 'flanger', label: 'Flng' }, { key: 'reverb', label: 'Verb' }, { key: 'wahwah', label: 'Wah' },
];
const FX_PAD_BT = 'w-full h-full px-1 py-1 text-[7px] min-w-0 tracking-normal leading-tight';
const STEM_COUNT_OPTIONS = [2, 4, 6, 12] as const;
type StemCount = typeof STEM_COUNT_OPTIONS[number];
const toStemCount = (n: number | undefined): StemCount =>
  STEM_COUNT_OPTIONS.includes(n as StemCount) ? (n as StemCount) : 4;
const STEM_LABEL: Record<string, string> = {
  vocals: 'Voc', drums: 'Drm', bass: 'Bass', other: 'Oth', guitar: 'Gtr', piano: 'Pno',
  accompaniment: 'Instr', instrumental: 'Instr', instrument: 'Instr', instr: 'Instr',
  kick: 'Kick', snare: 'Snr', hihat: 'Hat', hats: 'Hat', cymbals: 'Cym', toms: 'Tom',
};
const stemLabel = (n: string) => {
  const key = n.toLowerCase().replace(/^drums?[_-]/, '');
  return STEM_LABEL[key] ?? (n.charAt(0).toUpperCase() + n.slice(1, 4));
};
const STEM_PAD_FALLBACKS = ['vocals', 'drums', 'bass', 'other', 'kick', 'hihat'];
const STEM_MIXER_KNOB_SLOTS = {
  hi: { id: 'hi', fallback: 'Vocal', aliases: ['vocals', 'vocal', 'voice', 'singing'], tint: 0.83 },
  mid: { id: 'mid', fallback: 'Kick', aliases: ['kick', 'kick drum', 'bd', 'drums', 'drum'], tint: 0.62 },
  lo: { id: 'lo', fallback: 'Bass', aliases: ['bass', 'sub', 'sub bass'], tint: 0.36 },
  flt: { id: 'flt', fallback: 'Other', aliases: ['other', 'instrumental', 'accompaniment', 'music'], tint: 0.12 },
} as const;
const STEM_MIXER_KNOB_SLOT_LIST = [
  STEM_MIXER_KNOB_SLOTS.hi,
  STEM_MIXER_KNOB_SLOTS.mid,
  STEM_MIXER_KNOB_SLOTS.lo,
  STEM_MIXER_KNOB_SLOTS.flt,
] as const;
const findStemForSlot = (names: string[], aliases: readonly string[]) => {
  const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').trim();
  const normalized = names.map((name) => ({ name, key: norm(name) }));
  return aliases
    .map(norm)
    .map((alias) => normalized.find((stem) => stem.key === alias || stem.key.includes(alias))?.name)
    .find((name): name is string => !!name) ?? null;
};
const STEM_PAD_COLORS: RGB[] = [
  [34, 197, 94],
  [245, 158, 11],
  [239, 68, 68],
  [168, 85, 247],
  [244, 114, 182],
  [45, 212, 191],
];

const StemLoadPad: React.FC<{ deck: djEngine.DeckId; entryId: string | null; color: RGB; shape?: React.ComponentProps<typeof SlidePad>['shape'] }> = ({ deck, entryId, color, shape }) => {
  const stemSettings = useFeatureToggleStore((s) => s.settings.stems);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const stemCount = toStemCount(stemSettings.default_count);
  const load = async () => {
    if (!entryId || busy) return;
    setBusy(true);
    setMsg('checking');
    try {
      const refs = await prepareStems(
        entryId,
        {
          stems: stemCount,
          device: stemSettings.device || 'auto',
          quality: stemSettings.quality || 'balanced',
        },
        (pct, phase) => setMsg(pct > 0 ? `${pct}%` : phase.replace(/_/g, ' ')),
      );
      setMsg('loading');
      await djEngine.loadDeckStems(deck, refs);
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message.slice(0, 18) : 'failed');
      window.setTimeout(() => setMsg(null), 2600);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SlidePad
      color={color}
      on={busy}
      disabled={!entryId || busy}
      onClick={() => void load()}
      className="w-full h-full px-1 py-1 text-[7px] min-w-0"
      shape={shape}
      title={entryId ? `Load or separate ${stemCount} stems for Deck ${deck}` : 'Load a track first'}
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Scissors className="w-3 h-3" />}
      <span className="truncate">{busy ? (msg ?? 'Run') : 'Stems'}</span>
    </SlidePad>
  );
};

const StemTogglePad: React.FC<{
  deck: djEngine.DeckId;
  name: string | null;
  label: string;
  level: number;
  color: RGB;
  preparing?: boolean;
  onPrepare?: () => void;
  prepareLabel?: string | null;
}> = ({ deck, name, label, level, color, preparing = false, onPrepare, prepareLabel }) => {
  const on = !!name && level > 0.001;
  const canPrepare = !name && !!onPrepare;
  const shownLabel = preparing && !name ? (prepareLabel ?? 'Prep') : label;
  return (
    <SlidePad
      color={color}
      on={on || preparing}
      disabled={!name && !canPrepare}
      onClick={() => {
        if (name) {
          const current = djEngine.getStemGain(deck, name);
          djEngine.setStemGain(deck, name, current > 0.001 ? 0 : 1);
        }
        else onPrepare?.();
      }}
      className="w-full h-full px-1 py-1 text-[7px] min-w-0"
      title={name ? `Deck ${deck} ${name}: ${on ? 'click to mute' : 'click to restore'}` : canPrepare ? `Prepare stems for Deck ${deck}` : 'Load a track first'}
    >
      {preparing && !name ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
      <span className="truncate">{shownLabel}</span>
    </SlidePad>
  );
};

const StemPadBank: React.FC<{ deck: djEngine.DeckId; entryId: string | null; color: RGB; ctl: DeckCtl; mirror?: boolean }> = ({ deck, entryId, color, ctl, mirror }) => {
  const stemSettings = useFeatureToggleStore((s) => s.settings.stems);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const stemCount = toStemCount(stemSettings.default_count);
  const prepare = async () => {
    if (!entryId || busy) return;
    setBusy(true);
    setBusyLabel('Check');
    try {
      const refs = await prepareStems(entryId, {
        stems: stemCount,
        device: stemSettings.device || 'auto',
        quality: stemSettings.quality || 'balanced',
      }, (pct, phase) => setBusyLabel(pct > 0 ? `${pct}%` : phase.replace(/_/g, ' ')));
      setBusyLabel('Load');
      await djEngine.loadDeckStems(deck, refs);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  };
  const cells: React.ReactNode[] = [
    <StemLoadPad key="load" deck={deck} entryId={entryId} color={color} />,
    ...Array.from({ length: STEM_PAD_SLOTS }, (_, i) => {
      const name = ctl.stemNames[i] ?? null;
      const label = stemLabel(name ?? STEM_PAD_FALLBACKS[i] ?? `Stem ${i + 1}`);
      const level = name ? (ctl.stemLevels[name] ?? djEngine.getStemGain(deck, name)) : 0;
      return (
        <StemTogglePad
          key={i}
          deck={deck}
          name={name}
          label={label}
          level={level}
          color={STEM_PAD_COLORS[i] ?? color}
          preparing={busy}
          prepareLabel={busyLabel}
          onPrepare={entryId ? () => void prepare() : undefined}
        />
      );
    }),
    <SlidePad key="fx" disabled className="w-full h-full px-1 py-1 text-[7px] min-w-0" title="Open slot for the next stem layer">
      FX
    </SlidePad>,
  ];
  return (
    <div className="h-full w-full min-w-0 min-h-0 grid grid-cols-4 grid-rows-2 gap-1 p-0.5">
      {(mirror ? [...cells].reverse() : cells).map((cell) => cell)}
    </div>
  );
};

const DeckRack: React.FC<{ deck: 'A' | 'B'; accent: 'purple' | 'cyan'; entryId: string | null; ctl: DeckCtl }> = ({ deck, accent, entryId, ctl }) => {
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const color = DECK_RGB[accent];
  const hasTrack = !!entryId;
  // Deck A's rack sits on the left — push its contents to the right (toward the
  // center) so A and B mirror symmetrically around the browser.
  const toCenter = deck === 'A';
  // Per-deck FX wet amounts (0..1), wired live to the engine (D5). Lazy-builds
  // the deck's FX rack on first non-zero touch.
  const [fx, setFx] = useState<Record<string, number>>({ flanger: 0, reverb: 0, wahwah: 0 });
  const onFx = (k: djEngine.DjFx, v: number) => { setFx((p) => ({ ...p, [k]: v })); djEngine.setDeckFx(deck, k, v); };
  const triggerFx = (k: djEngine.DjFx, amount = 0.72) => onFx(k, fx[k] > 0.001 ? 0 : amount);

  // Live stems (D4): load (separate if needed) cached stems, then per-stem faders.
  const stemSettings = useFeatureToggleStore((s) => s.settings.stems);
  const [stemNames, setStemNames] = useState<string[]>(() => djEngine.getDeckStemNames(deck));
  const [stemLevels, setStemLevels] = useState<Record<string, number>>({});
  const [stemCount, setStemCount] = useState<StemCount>(() => toStemCount(stemSettings.default_count));
  const [stemBusy, setStemBusy] = useState(false);
  const [stemMsg, setStemMsg] = useState<string | null>(null);
  useEffect(() => { setStemCount(toStemCount(stemSettings.default_count)); }, [stemSettings.default_count]);
  // The engine clears stems on track change (loadDeck) and pad toggles can change
  // levels outside this rack, so mirror the live engine stem state here.
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deck === 'A' ? sa : sb;
    setStemNames((p) => (sameStringArray(p, st.stems) ? p : st.stems));
    setStemLevels((p) => (sameNumberRecord(p, st.stemLevels) ? p : st.stemLevels));
  }), [deck]);
  useEffect(() => { setStemMsg(null); }, [entryId]);
  const loadStems = async () => {
    if (!entryId || stemBusy) return;
    setStemBusy(true); setStemMsg('checking cached stems');
    try {
      const device = stemSettings.device || 'auto';
      const quality = stemSettings.quality || 'balanced';
      const refs = await prepareStems(
        entryId,
        { stems: stemCount, device, quality },
        (pct, phase) => setStemMsg(`${phase.replace(/_/g, ' ')}${pct > 0 ? ` ${pct}%` : ''}`),
      );
      if (!refs.length) { setStemMsg('no stems'); return; }
      setStemMsg('loading stems');
      const names = await djEngine.loadDeckStems(deck, refs);
      setStemNames(names);
      setStemLevels(Object.fromEntries(names.map((n) => [n, 1])));
      setStemMsg(null);
    } catch (e) {
      setStemMsg(e instanceof Error ? e.message.slice(0, 36) : 'failed');
    } finally { setStemBusy(false); }
  };
  const abortStems = async () => {
    if (!entryId || !stemBusy) return;
    setStemMsg('aborting');
    try { await fetch(`/api/stems/${encodeURIComponent(entryId)}/abort`, { method: 'POST' }); }
    catch { /* the running request will surface the final state */ }
  };
  const onStem = (name: string, v: number) => { setStemLevels((p) => ({ ...p, [name]: v })); djEngine.setStemGain(deck, name, v); };
  const stemActionLabel = stemBusy ? 'Running' : stemNames.length >= stemCount ? 'Reload' : 'Separate';

  return (
    <div className="hardware-card flex flex-col min-h-0 overflow-hidden">
      <div className={`shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5 ${toCenter ? 'flex-row-reverse' : ''}`}>
        <Layers className={`w-3 h-3 shrink-0 ${accentText}`} />
        <span className={`text-[9px] font-black uppercase tracking-wider ${accentText}`}>Onboard FX · Stems {deck}</span>
      </div>
      <div className={`flex-1 min-h-0 flex flex-col gap-1.5 p-1.5 overflow-hidden ${toCenter ? 'items-end' : 'items-start'}`}>
        <div className="w-full min-w-0 border-b border-white/5 pb-1.5">
          <div className={`mb-1 flex items-center gap-1.5 ${toCenter ? 'flex-row-reverse text-right' : ''}`}>
            <Sparkles className={`w-3 h-3 ${accentText}`} />
            <span className={`text-[8px] font-black uppercase tracking-widest ${accentText}`}>Onboard FX</span>
          </div>
          <div className="w-full min-w-0 grid grid-cols-2 gap-1">
            <div className={`min-w-0 ${toCenter ? 'text-right' : ''}`}>
              <div className="mb-0.5 flex items-center gap-1 text-[7px] font-black uppercase tracking-widest text-zinc-500">
                <Magnet className="w-2.5 h-2.5" />
                <span>Beat Grid</span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {([[-4, '«4'], [-1, '‹1'], [1, '1›'], [4, '4»']] as const).map(([n, label]) => (
                  <SlidePad key={label} className={FX_PAD_BT} color={color} disabled={!hasTrack} onClick={() => ctl.beatJump(n)} title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'} on the beat grid`}>
                    {label}
                  </SlidePad>
                ))}
              </div>
            </div>
            <div className={`min-w-0 ${toCenter ? 'text-right' : ''}`}>
              <div className="mb-0.5 flex items-center gap-1 text-[7px] font-black uppercase tracking-widest text-zinc-500">
                <Link2 className="w-2.5 h-2.5" />
                <span>Loop Roll</span>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {ROLL_SIZES.map((b) => (
                  <SlidePad
                    key={b.label}
                    className={FX_PAD_BT}
                    color={color}
                    disabled={!hasTrack}
                    onPointerDown={(e) => { e.preventDefault(); ctl.rollDown(b.beats); }}
                    onPointerUp={ctl.rollUp}
                    onPointerLeave={(e) => { if (e.buttons) ctl.rollUp(); }}
                    title={`${b.label}-beat loop-roll (hold)`}
                  >
                    {b.label}
                  </SlidePad>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-1 grid grid-cols-[1fr_auto] gap-1 items-center">
            <div className="grid grid-cols-2 gap-1">
              <SlidePad className={FX_PAD_BT} on={fx.flanger > 0.001} color={color} disabled={!hasTrack} onClick={() => triggerFx('flanger')} title="Trigger deck flanger">
                Flanger
              </SlidePad>
              <SlidePad className={FX_PAD_BT} on={fx.reverb > 0.001} color={color} disabled={!hasTrack} onClick={() => triggerFx('reverb', 0.65)} title="Trigger deck reverb">
                Reverb
              </SlidePad>
            </div>
            <div className={`grid grid-cols-3 gap-1 place-items-center w-fit ${toCenter ? 'justify-self-start' : 'justify-self-end'}`}>
              {DJ_FX.map(({ key, label }) => (
                <SlideKnob key={key} label={label} value={fx[key]} onChange={(v) => onFx(key, v)} min={0} max={1} step={0.01} size={30} centerReadout />
              ))}
            </div>
          </div>
        </div>
        {/* Live stems (D4) — per-stem gain faders, or a load/separate button */}
        <div className="mt-auto w-full min-h-0">
          <div className={`flex flex-wrap items-center gap-1 mb-1 min-w-0 ${toCenter ? 'flex-row-reverse' : ''}`}>
            <span className="text-[7px] font-black uppercase tracking-widest text-zinc-500">Stems</span>
            <div className={`flex items-center gap-0.5 ${toCenter ? 'flex-row-reverse' : ''}`}>
              {STEM_COUNT_OPTIONS.map((count) => (
                <button
                  key={count}
                  onClick={() => setStemCount(count)}
                  disabled={stemBusy}
                  className={`h-5 min-w-5 rounded border px-1 text-[7px] font-black tabular-nums leading-none ${
                    stemCount === count
                      ? `${accentText} border-current bg-white/10`
                      : 'border-white/10 text-zinc-500 hover:text-zinc-200 hover:border-white/25'
                  } disabled:opacity-40`}
                  title={`${count} stem separation`}
                >
                  {count}
                </button>
              ))}
            </div>
            <button onClick={() => void loadStems()} disabled={!entryId || stemBusy}
              className="text-[7px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/20 disabled:opacity-30 disabled:pointer-events-none flex items-center gap-1"
              title={entryId ? `Separate or load cached ${stemCount}-stem split using ${stemSettings.device || 'auto'} / ${stemSettings.quality || 'balanced'}` : 'Load a track first'}>
              <Scissors className="w-2.5 h-2.5" />
              {stemActionLabel}
            </button>
            {stemBusy ? (
              <button
                onClick={() => void abortStems()}
                className="h-5 w-5 grid place-items-center rounded border border-rose-400/30 text-rose-300 hover:bg-rose-500/15"
                title="Abort stem separation"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            ) : null}
          </div>
          {stemMsg && (
            <div className={`mb-1 text-[8px] font-mono truncate ${stemBusy ? 'text-zinc-500' : 'text-rose-300'} ${toCenter ? 'text-right' : ''}`} title={stemMsg}>
              {stemMsg}
            </div>
          )}
          {stemNames.length > 0 ? (
            <div className="max-h-[88px] min-h-0 overflow-y-auto pr-0.5">
              <div className="grid gap-1 place-items-center" style={{ gridTemplateColumns: `repeat(${Math.min(stemNames.length, 4)}, minmax(0,1fr))` }}>
                {stemNames.map((name) => (
                  <SlideKnob key={name} label={stemLabel(name)} value={stemLevels[name] ?? 1} onChange={(v) => onStem(name, v)} min={0} max={1} step={0.01} size={28} centerReadout />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const OnboardFxPanel: React.FC<{ deck: 'A' | 'B'; accent: 'purple' | 'cyan'; entryId: string | null; ctl: DeckCtl }> = ({ deck, accent, entryId, ctl }) => {
  const color = DECK_RGB[accent];
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const hasTrack = !!entryId;
  const [fx, setFx] = useState<Record<string, number>>({ flanger: 0, reverb: 0, wahwah: 0 });
  const onFx = (k: djEngine.DjFx, v: number) => {
    setFx((p) => ({ ...p, [k]: v }));
    djEngine.setDeckFx(deck, k, v);
  };
  const triggerFx = (k: djEngine.DjFx, amount = 0.72) => onFx(k, fx[k] > 0.001 ? 0 : amount);
  const padLabel = (top: string, bottom: string) => (
    <span className="flex flex-col items-center gap-0.5 leading-none">
      <span className="text-[7px] font-black">{top}</span>
      <span className="text-[8px] font-black">{bottom}</span>
    </span>
  );

  return (
    <div className="hardware-card h-full w-full min-h-0 min-w-0 overflow-hidden p-1.5">
      <div className="h-full w-full min-h-0 grid grid-cols-[1.15fr_1.2fr_1.05fr_1.15fr] gap-1.5 items-stretch">
        <div className="min-w-0 flex flex-col gap-1">
          <div className={`flex items-center gap-1 text-[8px] font-black uppercase tracking-widest ${accentText}`}>
            <Sparkles className="w-3 h-3 shrink-0" />
            <span className="truncate">Onboard FX {deck}</span>
          </div>
          <div className="grid grid-cols-2 gap-1 flex-1 min-h-0">
            <SlidePad className={FX_PAD_BT} on={fx.flanger > 0.001} color={color} disabled={!hasTrack} onClick={() => triggerFx('flanger')} title="Toggle flanger">
              {padLabel('FX', 'Flanger')}
            </SlidePad>
            <SlidePad className={FX_PAD_BT} on={fx.reverb > 0.001} color={color} disabled={!hasTrack} onClick={() => triggerFx('reverb', 0.65)} title="Toggle reverb">
              {padLabel('FX', 'Reverb')}
            </SlidePad>
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-1 text-[7px] font-black uppercase tracking-widest text-zinc-500">
            <Magnet className="w-2.5 h-2.5" />
            <span>Beat Grid</span>
          </div>
          <div className="grid grid-cols-4 gap-1 flex-1 min-h-0">
            {([[-4, '«4'], [-1, '‹1'], [1, '1›'], [4, '4»']] as const).map(([n, label]) => (
              <SlidePad key={label} className={FX_PAD_BT} color={color} disabled={!hasTrack} onClick={() => ctl.beatJump(n)} title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'}`}>
                {padLabel('Jump', `${n > 0 ? '+' : ''}${n}`)}
              </SlidePad>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-1 text-[7px] font-black uppercase tracking-widest text-zinc-500">
            <Link2 className="w-2.5 h-2.5" />
            <span>Loop Roll</span>
          </div>
          <div className="grid grid-cols-3 gap-1 flex-1 min-h-0">
            {ROLL_SIZES.map((b) => (
              <SlidePad
                key={b.label}
                className={FX_PAD_BT}
                color={color}
                disabled={!hasTrack}
                onPointerDown={(e) => { e.preventDefault(); ctl.rollDown(b.beats); }}
                onPointerUp={ctl.rollUp}
                onPointerLeave={(e) => { if (e.buttons) ctl.rollUp(); }}
                title={`${b.label}-beat loop-roll (hold)`}
              >
                {padLabel('Roll', b.label)}
              </SlidePad>
            ))}
          </div>
        </div>
        <div className="min-w-0 grid grid-cols-3 gap-1 place-items-center">
          <SlideKnob label="Reverb" value={fx.reverb} onChange={(v) => onFx('reverb', v)} min={0} max={1} step={0.01} size={34} centerReadout />
          <SlideKnob label="Flanger" value={fx.flanger} onChange={(v) => onFx('flanger', v)} min={0} max={1} step={0.01} size={34} centerReadout />
          <SlideKnob label="Wah" value={fx.wahwah} onChange={(v) => onFx('wahwah', v)} min={0} max={1} step={0.01} size={34} centerReadout />
        </div>
      </div>
    </div>
  );
};

const PERF_PAD_BT = 'w-full h-full px-1 py-0.5 text-[7px] min-w-0 tracking-normal leading-tight';

const CompactPerformancePads: React.FC<{ deck: 'A' | 'B'; accent: 'purple' | 'cyan'; entryId: string | null; ctl: DeckCtl }> = ({ deck, accent, entryId, ctl }) => {
  const color = DECK_RGB[accent];
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const hasTrack = !!entryId;
  const padLabel = (top: string, bottom: string) => (
    <span className="flex flex-col items-center gap-0.5 leading-none">
      <span className="text-[6px] font-black opacity-80">{top}</span>
      <span className="text-[8px] font-black">{bottom}</span>
    </span>
  );
  return (
    <div className="hardware-card h-full w-full min-h-0 min-w-0 overflow-hidden p-1.5">
      <div className="h-full w-full min-h-0 grid grid-cols-[0.8fr_1.15fr_1.35fr] gap-1.5 items-stretch">
        <div className="min-w-0 flex flex-col gap-1">
          <div className={`text-[7px] font-black uppercase tracking-widest ${accentText}`}>Hot Cues</div>
          <div className="grid grid-cols-4 gap-1 flex-1 min-h-0">
            {Array.from({ length: HOTCUE_SLOTS }, (_, i) => {
              const c = ctl.cues?.[i] ?? null;
              const set = c != null;
              return (
                <SlidePad
                  key={i}
                  on={set}
                  color={color}
                  disabled={!hasTrack}
                  className={PERF_PAD_BT}
                  onClick={() => ctl.setHotcue(i)}
                  onContextMenu={(e) => { e.preventDefault(); ctl.dropHotcue(i); }}
                  title={set ? `Hot cue ${i + 1} at ${fmtTime(c)} — click to jump, right-click to clear` : `Set hot cue ${i + 1}`}
                >
                  {padLabel('Cue', String(i + 1))}
                </SlidePad>
              );
            })}
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="text-[7px] font-black uppercase tracking-widest text-zinc-500">Beat Loops</div>
          <div className="grid grid-cols-6 gap-1 flex-1 min-h-0">
            {BEAT_SIZES.map((b) => (
              <SlidePad key={b.label} className={PERF_PAD_BT} on={ctl.loopActive && ctl.activeLoopBeats === b.beats} color={color} disabled={!hasTrack} onClick={() => ctl.toggleBeatLoop(b.beats)} title={`${b.label}-beat loop`}>
                {padLabel('Loop', b.label)}
              </SlidePad>
            ))}
            <SlidePad className={PERF_PAD_BT} danger disabled={!ctl.loopActive} onClick={ctl.exitLoop} title="Exit beat loop">
              {padLabel('Loop', 'Out')}
            </SlidePad>
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="text-[7px] font-black uppercase tracking-widest text-zinc-500">Roll / Jump</div>
          <div className="grid grid-cols-8 gap-1 flex-1 min-h-0">
            {ROLL_SIZES.map((b) => (
              <SlidePad
                key={b.label}
                className={PERF_PAD_BT}
                color={color}
                disabled={!hasTrack}
                onPointerDown={(e) => { e.preventDefault(); ctl.rollDown(b.beats); }}
                onPointerUp={ctl.rollUp}
                onPointerLeave={(e) => { if (e.buttons) ctl.rollUp(); }}
                title={`${b.label}-beat loop-roll (hold)`}
              >
                {padLabel('Roll', b.label)}
              </SlidePad>
            ))}
            <SlidePad className={PERF_PAD_BT} on={ctl.slip} color={[245, 158, 11]} disabled={!hasTrack} onClick={() => ctl.setSlip(!ctl.slip)} title="Slip mode">
              {padLabel('Mode', 'Slip')}
            </SlidePad>
            {([[-4, '-4'], [-1, '-1'], [1, '+1'], [4, '+4']] as const).map(([n, label]) => (
              <SlidePad key={label} className={PERF_PAD_BT} color={color} disabled={!hasTrack} onClick={() => ctl.beatJump(n)} title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'}`}>
                {padLabel('Jump', label)}
              </SlidePad>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════ SideListLane ═══════════════════════════════ */

/** Staging queue ("prepare / play-next") — a compact card in the center-bottom
 *  rack row, flanked by the FX racks. Drag library/set rows in to stage them;
 *  reorder into play order; fire each onto a deck (→A/→B) or push the whole
 *  queue into the active Automix set. Staged rows re-emit the shared
 *  DJ_TRACK_MIME so they also drop straight onto the waveform lanes / sampler.
 *  Backed by the ephemeral useDjSideList store. */
const SideListLane: React.FC<{ onLoadDeck: (entryId: string, deck: djEngine.DeckId) => void }> = ({ onLoadDeck }) => {
  const items = useDjSideList((s) => s.items);
  const add = useDjSideList((s) => s.add);
  const setItems = useDjSideList((s) => s.setItems);
  const remove = useDjSideList((s) => s.remove);
  const reorder = useDjSideList((s) => s.reorder);
  const clear = useDjSideList((s) => s.clear);
  const entries = useLibraryStore((s) => s.entries);
  const analysisById = useDjAnalysisStore((s) => s.byId);
  const activeId = useSetlistStore((s) => s.activeId);
  const appendToSet = useSetlistStore((s) => s.append);
  const [over, setOver] = useState(false);
  const [queueSort, setQueueSort] = useState<{ key: 'title' | 'bpm'; dir: 'asc' | 'desc' } | null>(null);

  const stage = (id: string) => { const lib = entries.find((e) => e.id === id); if (lib) add({ entryId: id, label: lib.title }); };
  const onDrop = (e: React.DragEvent) => {
    setOver(false);
    const id = e.dataTransfer.getData(DJ_TRACK_MIME);
    if (id) { e.preventDefault(); stage(id); }
  };
  const pushToSet = () => {
    if (!activeId || items.length === 0) return;
    appendToSet(activeId, items.map((it) => ({ entryId: it.entryId, label: it.label, kind: 'audio' as const })));
  };
  const sortQueue = (key: 'title' | 'bpm') => {
    if (items.length < 2) return;
    const dir: 'asc' | 'desc' = queueSort?.key === key && queueSort.dir === 'asc' ? 'desc' : 'asc';
    const signed = dir === 'asc' ? 1 : -1;
    const sorted = [...items].sort((a, b) => {
      if (key === 'title') {
        const byTitle = a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
        return byTitle !== 0 ? byTitle * signed : a.entryId.localeCompare(b.entryId);
      }
      const abpm = analysisById[a.entryId]?.data?.bpm ?? null;
      const bbpm = analysisById[b.entryId]?.data?.bpm ?? null;
      if (abpm == null && bbpm == null) {
        return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (abpm == null) return 1;
      if (bbpm == null) return -1;
      const byBpm = abpm - bbpm;
      return byBpm !== 0 ? byBpm * signed : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
    });
    setItems(sorted);
    setQueueSort({ key, dir });
  };
  const sortIconClass = (key: 'title' | 'bpm') =>
    `transition-transform ${queueSort?.key === key ? 'opacity-100 text-purple-200' : 'opacity-45'} ${queueSort?.key === key && queueSort.dir === 'desc' ? 'rotate-180' : ''}`;

  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes(DJ_TRACK_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`hardware-card min-h-0 overflow-hidden transition-colors ${over ? 'ring-1 ring-purple-400/60 bg-purple-500/5' : ''}`}
    >
      {/* header band */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        <ListMusic className="w-3.5 h-3.5 text-purple-400 shrink-0" />
        <span className="text-[9px] font-black uppercase tracking-widest text-purple-300">Next</span>
        <span className="text-[8px] font-mono text-zinc-600 tabular-nums">{items.length}</span>
        <div className="flex items-center gap-0.5 ml-auto">
          <button onClick={() => sortQueue('title')} disabled={items.length < 2} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-25" title="Sort queue by title"><ArrowDownAZ className={`w-3 h-3 ${sortIconClass('title')}`} /></button>
          <button onClick={() => sortQueue('bpm')} disabled={items.length < 2} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-25" title="Sort queue by BPM"><Gauge className={`w-3 h-3 ${sortIconClass('bpm')}`} /></button>
          <button onClick={pushToSet} disabled={!activeId || items.length === 0} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-25" title={activeId ? 'Append the whole queue to the active set' : 'Open or create a set first (Source Tree ›)'}><Plus className="w-3 h-3" /></button>
          <button onClick={clear} disabled={items.length === 0} className="p-0.5 text-zinc-500 hover:text-rose-400 disabled:opacity-25" title="Clear the queue"><Trash2 className="w-3 h-3" /></button>
        </div>
      </div>

      {/* staged-track list (vertical, fills the cell) */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 ? (
          <div className="h-full grid place-items-center text-[9px] font-mono text-zinc-600 px-3 text-center">Drag tracks here to stage them play-next.</div>
        ) : items.map((it, i) => {
          const lib = entries.find((e) => e.id === it.entryId) ?? null;
          const bpm = analysisById[it.entryId]?.data?.bpm ?? null;
          return (
            <div
              key={it.entryId}
              draggable={!!lib}
              onDragStart={(ev) => { if (!lib) return; ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData(DJ_TRACK_MIME, it.entryId); ev.dataTransfer.setData('text/plain', it.label); }}
              className={`group/chip grid items-center gap-1 px-2 py-0.5 border-b border-white/3 hover:bg-white/5 ${lib ? 'cursor-grab active:cursor-grabbing' : 'opacity-40'}`}
              style={{ gridTemplateColumns: '1.4rem minmax(0,1fr) 2.4rem 3.6rem' }}
              title={lib ? it.label : `${it.label} — no longer in library`}
            >
              <span className="text-[8px] font-mono text-zinc-600 tabular-nums text-right">{String(i + 1).padStart(2, '0')}</span>
              <span className="text-[10px] font-mono text-zinc-300 truncate">{it.label}</span>
              <span className="text-[8px] font-mono text-zinc-500 tabular-nums text-right">{bpm != null ? bpm.toFixed(0) : '—'}</span>
              <span className="flex items-center justify-end gap-0.5">
                <span className="hidden group-hover/chip:flex items-center gap-0.5">
                  <button onClick={() => reorder(i, i - 1)} disabled={i === 0} className="text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move earlier"><ChevronDown className="w-2.5 h-2.5 rotate-180" /></button>
                  <button onClick={() => reorder(i, i + 1)} disabled={i === items.length - 1} className="text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move later"><ChevronDown className="w-2.5 h-2.5" /></button>
                  <button onClick={() => remove(it.entryId)} className="text-zinc-600 hover:text-rose-400" title="Remove from queue"><X className="w-2.5 h-2.5" /></button>
                </span>
                <button onClick={() => lib && onLoadDeck(it.entryId, 'A')} disabled={!lib} className="px-0.5 rounded text-[8px] font-black text-purple-300 hover:bg-purple-500/20 disabled:opacity-30" title="Load onto Deck A">→A</button>
                <button onClick={() => lib && onLoadDeck(it.entryId, 'B')} disabled={!lib} className="px-0.5 rounded text-[8px] font-black text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-30" title="Load onto Deck B">→B</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ═══════════════════════════════ TrackBrowser ═══════════════════════════════ */

const TrackBrowser: React.FC<{ source: Source; setSource: (s: Source) => void; onLoadDeck: (entryId: string, deck: djEngine.DeckId) => void }> = ({ source, setSource, onLoadDeck }) => {
  const entries = useLibraryStore((s) => s.entries);
  const analysisById = useDjAnalysisStore((s) => s.byId);
  const stemSettings = useFeatureToggleStore((s) => s.settings.stems);
  const setlists = useSetlistStore((s) => s.setlists);
  const renameSetlist = useSetlistStore((s) => s.rename);
  const removeSetlist = useSetlistStore((s) => s.remove);
  const setEntries = useSetlistStore((s) => s.setEntries);
  const appendToSet = useSetlistStore((s) => s.append);
  const stage = useDjSideList((s) => s.add);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [dropOverSet, setDropOverSet] = useState(false);
  type SortKey = 'order' | 'bpm' | 'title' | 'key' | 'dur' | 'date' | 'source';
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'order', dir: 'asc' });
  const [appliedSetSort, setAppliedSetSort] = useState<{ key: 'title' | 'bpm'; dir: 'asc' | 'desc' } | null>(null);
  type StemCache = { status: 'checking' | 'none' | 'ready' | 'running' | 'error'; count?: number; message?: string };
  const [stemCache, setStemCache] = useState<Record<string, StemCache>>({});
  const [stemRun, setStemRun] = useState<{ entryId: string; title: string; phase: string; progress: number } | null>(null);

  const set = source.kind === 'set' ? setlists[source.id] ?? null : null;
  const isSet = source.kind === 'set' && !!set;

  // Rows: either library entries or a set's entries (resolved against the library for metadata).
  type Row = { entryId: string | null; title: string; bpm: number | null; key: string | null; dur: number | null; date: string | null; source: string; order: number; setIndex?: number };
  const rowMenu = useContextMenu<{ row: Row }>();
  const baseRows: Row[] = isSet
    ? set!.entries.map((e, i) => {
        const lib = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null;
        const d = e.entryId ? analysisById[e.entryId]?.data ?? null : null;
        return {
          entryId: e.entryId,
          title: e.label,
          bpm: d?.bpm ?? null,
          key: d?.key ? keyLabel(d.key, d.scale) : null,
          dur: d?.duration_sec ?? lib?.duration ?? null,
          date: lib?.timestamp ?? null,
          source: lib?.source ?? 'set',
          order: i + 1,
          setIndex: i,
        };
      })
    : libSourceFilter(entries, source.kind as LibSourceKind).map((e, i) => {
        const d = analysisById[e.id]?.data ?? null;
        return {
          entryId: e.id,
          title: e.title,
          bpm: d?.bpm ?? null,
          key: d?.key ? keyLabel(d.key, d.scale) : null,
          dur: d?.duration_sec ?? e.duration ?? null,
          date: e.timestamp,
          source: e.source,
          order: i + 1,
        };
      });
  const sourceLabel = isSet ? set!.name : (LIB_SOURCE_LABEL[source.kind as LibSourceKind] ?? 'Library');
  const filteredRows = q.trim() ? baseRows.filter((r) => r.title.toLowerCase().includes(q.trim().toLowerCase())) : baseRows;
  const rows = useMemo(() => {
    const value = (r: Row) => {
      if (sort.key === 'date') return r.date ? Date.parse(r.date) : null;
      return r[sort.key];
    };
    return [...filteredRows].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av == null && bv == null) return a.order - b.order;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [filteredRows, sort]);
  const setSortKey = (key: SortKey) => setSort((p) => (p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'order' || key === 'title' ? 'asc' : 'desc' }));
  const dateLabel = (v: string | null) => {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const SortHeader: React.FC<{ id: SortKey; children: React.ReactNode; align?: 'left' | 'right' }> = ({ id, children, align = 'left' }) => (
    <button
      type="button"
      onClick={() => setSortKey(id)}
      className={`min-w-0 flex items-center gap-1 truncate hover:text-zinc-300 ${align === 'right' ? 'justify-end text-right' : ''} ${sort.key === id ? 'text-zinc-200' : ''}`}
      title={`Sort by ${String(children)}`}
    >
      <span className="truncate">{children}</span>
      <ChevronDown className={`w-2.5 h-2.5 shrink-0 transition-transform ${sort.key === id ? 'opacity-100' : 'opacity-20'} ${sort.key === id && sort.dir === 'asc' ? 'rotate-180' : ''}`} />
    </button>
  );

  const commitRename = () => { if (set && editName.trim()) renameSetlist(set.id, editName.trim()); setEditing(false); };
  const reorder = (from: number, to: number) => {
    if (!set || to < 0 || to >= set.entries.length) return;
    const arr = [...set.entries];
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
    setEntries(set.id, arr);
  };
  const removeEntry = (i: number) => { if (set) setEntries(set.id, set.entries.filter((_, idx) => idx !== i)); };
  const hasSetDropData = (e: React.DragEvent): boolean => {
    if (!set) return false;
    if (e.dataTransfer.types.includes(DJ_TRACK_MIME)) return true;
    return Array.from(e.dataTransfer.files).some(isExternalAudioFile)
      || Array.from(e.dataTransfer.items ?? []).some((item) => item.kind === 'file' && (item.type.startsWith('audio/') || item.type === ''));
  };
  const onSetDragOver = (e: React.DragEvent) => {
    if (!hasSetDropData(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropOverSet(true);
  };
  const onSetDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropOverSet(false);
  };
  const onSetDrop = async (e: React.DragEvent) => {
    setDropOverSet(false);
    if (!set || !hasSetDropData(e)) return;
    e.preventDefault();
    e.stopPropagation();

    const entryId = e.dataTransfer.getData(DJ_TRACK_MIME);
    if (entryId) {
      const lib = entries.find((x) => x.id === entryId);
      appendToSet(set.id, [{ entryId, label: lib?.title || e.dataTransfer.getData('text/plain') || 'Untitled', kind: 'audio' }]);
      return;
    }

    const imported: SetlistEntry[] = [];
    for (const file of Array.from(e.dataTransfer.files).filter(isExternalAudioFile)) {
      const entry = await importAudioFileToLibrary(file);
      imported.push({ entryId: entry.id, label: entry.title, kind: 'audio' });
    }
    if (imported.length > 0) appendToSet(set.id, imported);
  };
  const sendEntry = (e: SetlistEntry) => { const lib = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null; sendTrackToVj({ entryId: e.entryId, label: e.label, url: lib?.audioUrl ?? e.url, kind: e.kind ?? 'audio' }); };
  const sendWholeSet = () => {
    if (!set) return;
    const items: VjSetItem[] = set.entries.map((e) => { const lib = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null; return { entryId: e.entryId, label: e.label, url: lib?.audioUrl ?? e.url, kind: e.kind ?? 'audio' }; });
    sendSetToVj({ setId: set.id, name: set.name, items });
  };
  const sortSetEntries = (key: 'title' | 'bpm') => {
    if (!set || set.entries.length < 2) return;
    const dir: 'asc' | 'desc' = appliedSetSort?.key === key && appliedSetSort.dir === 'asc' ? 'desc' : 'asc';
    const signed = dir === 'asc' ? 1 : -1;
    const next = [...set.entries].sort((a, b) => {
      if (key === 'title') {
        return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) * signed;
      }
      const abpm = a.entryId ? analysisById[a.entryId]?.data?.bpm ?? null : null;
      const bbpm = b.entryId ? analysisById[b.entryId]?.data?.bpm ?? null : null;
      if (abpm == null && bbpm == null) {
        return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (abpm == null) return 1;
      if (bbpm == null) return -1;
      const byBpm = abpm - bbpm;
      return byBpm !== 0 ? byBpm * signed : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
    });
    setEntries(set.id, next);
    setSort({ key: 'order', dir: 'asc' });
    setAppliedSetSort({ key, dir });
  };
  const setSortIconClass = (key: 'title' | 'bpm') =>
    `w-3 h-3 transition-transform ${appliedSetSort?.key === key ? 'opacity-100 text-purple-200' : 'opacity-55'} ${appliedSetSort?.key === key && appliedSetSort.dir === 'desc' ? 'rotate-180' : ''}`;

  const stemCount = toStemCount(stemSettings.default_count);
  const refreshStemCache = async (entryId: string) => {
    setStemCache((p) => ({ ...p, [entryId]: { status: 'checking' } }));
    try {
      const refs = await listStems(entryId);
      setStemCache((p) => ({
        ...p,
        [entryId]: refs.length >= stemCount
          ? { status: 'ready', count: refs.length }
          : { status: 'none', count: refs.length },
      }));
    } catch (e) {
      setStemCache((p) => ({
        ...p,
        [entryId]: { status: 'error', message: e instanceof Error ? e.message : 'Stem check failed' },
      }));
    }
  };
  const openSetRowMenu = (e: React.MouseEvent, row: Row) => {
    if (!isSet || !row.entryId) return;
    rowMenu.open(e, { row });
    const cached = stemCache[row.entryId];
    if (!cached || cached.status === 'error') void refreshStemCache(row.entryId);
  };
  const separateSetRowStems = async (row: Row) => {
    if (!row.entryId) return;
    const entryId = row.entryId;
    setStemCache((p) => ({ ...p, [entryId]: { status: 'running', count: p[entryId]?.count } }));
    setStemRun({ entryId, title: row.title, phase: 'starting', progress: 0 });
    try {
      const refs = await prepareStems(
        entryId,
        {
          stems: stemCount,
          device: stemSettings.device || 'auto',
          quality: stemSettings.quality || 'balanced',
        },
        (pct, phase) => {
          setStemRun({ entryId, title: row.title, phase: phase.replace(/_/g, ' '), progress: pct });
        },
      );
      setStemCache((p) => ({ ...p, [entryId]: { status: 'ready', count: refs.length } }));
      setStemRun({ entryId, title: row.title, phase: 'complete', progress: 100 });
      window.setTimeout(() => {
        setStemRun((cur) => (cur?.entryId === entryId ? null : cur));
      }, 2200);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Stem separation failed';
      setStemCache((p) => ({ ...p, [entryId]: { status: 'error', message, count: p[entryId]?.count } }));
      setStemRun({ entryId, title: row.title, phase: message.slice(0, 36), progress: 0 });
      window.setTimeout(() => {
        setStemRun((cur) => (cur?.entryId === entryId ? null : cur));
      }, 3600);
    }
  };
  const menuRow = rowMenu.payload?.row ?? null;
  const menuStem = menuRow?.entryId ? stemCache[menuRow.entryId] : null;
  const menuItems: ContextMenuItem[] = menuRow ? [
    {
      type: 'item',
      label: menuStem?.status === 'checking'
        ? 'Checking stems…'
        : menuStem?.status === 'running'
          ? 'Running stems…'
          : menuStem?.status === 'ready'
            ? 'Stems already cached'
            : (menuStem?.count ? `Upgrade to ${stemCount} stems…` : `Separate ${stemCount} stems…`),
      icon: menuStem?.status === 'checking' || menuStem?.status === 'running'
        ? <Loader2 className="w-3 h-3 animate-spin" />
        : <Scissors className="w-3 h-3" />,
      hint: menuStem?.count ? `${menuStem.count}` : undefined,
      disabled: !menuRow.entryId || menuStem?.status === 'checking' || menuStem?.status === 'running' || menuStem?.status === 'ready',
      onSelect: () => { void separateSetRowStems(menuRow); },
    },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Load on Deck A',
      onSelect: () => { if (menuRow.entryId) onLoadDeck(menuRow.entryId, 'A'); },
    },
    {
      type: 'item',
      label: 'Load on Deck B',
      onSelect: () => { if (menuRow.entryId) onLoadDeck(menuRow.entryId, 'B'); },
    },
    {
      type: 'item',
      label: 'Remove from set',
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      disabled: menuRow.setIndex == null,
      onSelect: () => { if (menuRow.setIndex != null) removeEntry(menuRow.setIndex); },
    },
  ] : [];

  return (
    <div
      className={`hardware-card h-full w-full flex flex-col min-h-0 overflow-hidden ${dropOverSet ? 'ring-2 ring-inset ring-purple-300/60' : ''}`}
      onDragEnter={isSet ? onSetDragOver : undefined}
      onDragOver={isSet ? onSetDragOver : undefined}
      onDragLeave={isSet ? onSetDragLeave : undefined}
      onDrop={isSet ? (e) => { void onSetDrop(e); } : undefined}
    >
      {/* header: source name + count + search + (set actions) */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        {isSet ? <ListMusic className="w-3.5 h-3.5 text-purple-400 shrink-0" /> : <LibraryIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
        {editing && set ? (
          <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false); }} onBlur={commitRename} className="bg-black/50 border border-purple-400/50 rounded px-1.5 py-0.5 text-[10px] text-zinc-100 focus:outline-none w-36" />
        ) : (
          <span className="text-[10px] font-black uppercase tracking-wider text-purple-300 truncate max-w-40" title={sourceLabel}>{sourceLabel}</span>
        )}
        <span className="text-[8px] font-mono text-zinc-600">{rows.length} {isSet ? 'tracks' : 'files'}</span>
        {stemRun && (
          <span className="min-w-0 max-w-48 truncate text-[8px] font-mono text-emerald-300" title={`${stemRun.title}: ${stemRun.phase}`}>
            stems · {stemRun.progress > 0 ? `${Math.round(stemRun.progress)}%` : stemRun.phase}
          </span>
        )}
        <div className="flex items-center gap-1 ml-auto bg-black/40 border border-white/10 rounded px-1.5 w-36 max-w-[40%]">
          <Search className="w-3 h-3 text-zinc-600 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" className="flex-1 min-w-0 bg-transparent text-[10px] font-mono text-zinc-200 py-1 focus:outline-none placeholder:text-zinc-600" />
        </div>
        {isSet && set && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => sortSetEntries('title')} disabled={set.entries.length < 2} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-30" title="Reorder this playlist by title"><ArrowDownAZ className={setSortIconClass('title')} /></button>
            <button onClick={() => sortSetEntries('bpm')} disabled={set.entries.length < 2} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-30" title="Reorder this playlist by BPM"><Gauge className={setSortIconClass('bpm')} /></button>
            <button onClick={() => { setEditName(set.name); setEditing(true); }} className="p-0.5 text-zinc-500 hover:text-zinc-200" title="Rename set"><Pencil className="w-3 h-3" /></button>
            <button onClick={sendWholeSet} disabled={set.entries.length === 0} className="p-0.5 text-zinc-500 hover:text-cyan-300 disabled:opacity-30" title="Send whole set to VJ"><Cast className="w-3.5 h-3.5" /></button>
            <button onClick={() => { removeSetlist(set.id); setSource({ kind: 'library' }); }} className="p-0.5 text-zinc-500 hover:text-rose-400" title="Delete set"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>

      {/* column header */}
      <div className="shrink-0 grid items-center gap-1 px-2 py-0.5 border-b border-white/5 text-[7px] font-black uppercase tracking-wider text-zinc-600" style={{ gridTemplateColumns: '1.8rem 4.1rem minmax(10rem,1fr) 2.7rem 2.5rem 2.9rem 3.3rem 4.2rem' }}>
        <SortHeader id="order" align="right">#</SortHeader>
        <SortHeader id="date">Date</SortHeader>
        <SortHeader id="title">Title</SortHeader>
        <SortHeader id="bpm" align="right">BPM</SortHeader>
        <SortHeader id="key">Key</SortHeader>
        <SortHeader id="dur" align="right">Len</SortHeader>
        <SortHeader id="source">Source</SortHeader>
        <span className="text-right pr-1">Load</span>
      </div>

      {/* rows */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {rows.length === 0 ? (
          <div className="h-full grid place-items-center text-[9px] font-mono text-zinc-600 px-3 text-center">
            {isSet ? 'Empty set — drag tracks here, or Save a loaded deck.' : (entries.length === 0 ? 'Library empty — generate or import audio.' : 'No matches.')}
          </div>
        ) : rows.map((r, i) => (
          <div key={(r.entryId ?? 'x') + i} draggable={!!r.entryId}
            onContextMenu={(e) => openSetRowMenu(e, r)}
            onDragStart={(ev) => { if (!r.entryId) return; ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData(DJ_TRACK_MIME, r.entryId); ev.dataTransfer.setData('text/plain', r.title); }}
            className="grid items-center gap-1 px-2 py-0.5 text-[9px] font-mono text-zinc-400 hover:bg-white/5 border-b border-white/3 group/row cursor-grab active:cursor-grabbing"
            style={{ gridTemplateColumns: '1.8rem 4.1rem minmax(10rem,1fr) 2.7rem 2.5rem 2.9rem 3.3rem 4.2rem' }}>
            <span className="text-right text-zinc-600">{String(r.order).padStart(2, '0')}</span>
            <span className="truncate text-zinc-600" title={r.date ?? undefined}>{dateLabel(r.date)}</span>
            <span className="truncate text-zinc-300" title={r.title}>{r.title}</span>
            <span className="text-right tabular-nums text-zinc-500">{r.bpm != null ? r.bpm.toFixed(0) : '—'}</span>
            <span className="text-zinc-500">{r.key ?? '—'}</span>
            <span className="text-right tabular-nums text-zinc-600">{r.dur != null ? fmtTime(r.dur) : '—'}</span>
            <span className="truncate text-zinc-600 capitalize">{r.source}</span>
            <span className="flex items-center gap-0.5 justify-end pr-0.5">
              {isSet ? (
                <span className="hidden group-hover/row:flex items-center gap-0.5">
                  <button onClick={() => reorder(r.setIndex!, r.setIndex! - 1)} disabled={r.setIndex === 0} className="p-0.5 text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move up"><ChevronDown className="w-2.5 h-2.5 rotate-180" /></button>
                  <button onClick={() => reorder(r.setIndex!, r.setIndex! + 1)} className="p-0.5 text-zinc-600 hover:text-zinc-200" title="Move down"><ChevronDown className="w-2.5 h-2.5" /></button>
                  <button onClick={() => set && removeEntry(r.setIndex!)} className="p-0.5 text-zinc-600 hover:text-rose-400" title="Remove from set"><Trash2 className="w-2.5 h-2.5" /></button>
                </span>
              ) : null}
              {r.entryId && <button onClick={() => stage({ entryId: r.entryId!, label: r.title })} className="hidden group-hover/row:inline p-0.5 text-zinc-600 hover:text-purple-300" title="Stage in Next queue"><ListMusic className="w-2.5 h-2.5" /></button>}
              <button onClick={() => r.entryId && onLoadDeck(r.entryId, 'A')} disabled={!r.entryId} className="px-1 py-0.5 rounded text-[8px] font-black text-purple-300 hover:bg-purple-500/20 disabled:opacity-30" title="Load onto Deck A">→A</button>
              <button onClick={() => r.entryId && onLoadDeck(r.entryId, 'B')} disabled={!r.entryId} className="px-1 py-0.5 rounded text-[8px] font-black text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-30" title="Load onto Deck B">→B</button>
              {!isSet && r.entryId && <button onClick={() => sendEntry({ entryId: r.entryId, label: r.title, kind: 'audio' })} className="hidden group-hover/row:inline p-0.5 text-zinc-600 hover:text-cyan-300" title="Send to VJ"><Cast className="w-2.5 h-2.5" /></button>}
            </span>
          </div>
        ))}
      </div>
      <ContextMenu
        position={rowMenu.position}
        onClose={rowMenu.close}
        items={menuItems}
        title={menuRow ? `Set track · ${menuRow.title}` : undefined}
        minWidth="14rem"
      />
    </div>
  );
};

/* ═══════════════════════════════ SourceTree ═════════════════════════════════ */

/** Source tree — every entry is live: filtered views over the library
 *  (Library / Favorites / Generated / Imports), real Online Download, and the
 *  user's Sets. No placeholder/streaming stubs. */
const SourceTree: React.FC<{ source: Source; setSource: (s: Source) => void; libCount: number }> = ({ source, setSource, libCount }) => {
  const entries = useLibraryStore((s) => s.entries);
  const setlists = useSetlistStore((s) => s.setlists);
  const createSetlist = useSetlistStore((s) => s.create);
  const setActive = useSetlistStore((s) => s.setActive);
  const sets = Object.values(setlists).sort((a, b) => b.updatedAt - a.updatedAt);
  const favCount = entries.filter((e) => e.favorite).length;
  const genCount = entries.filter((e) => e.source === 'generate').length;
  const impCount = entries.filter((e) => e.source === 'import').length;

  // Online Download — same backend as the Media tab (/api/ytimport/fetch),
  // routed straight into the library so the imported track appears below.
  const [dlOpen, setDlOpen] = useState(false);
  const [dlUrl, setDlUrl] = useState('');
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState<string | null>(null);
  const runImport = async () => {
    const u = dlUrl.trim();
    if (!u || dlBusy) return;
    setDlBusy(true); setDlErr(null);
    try {
      await importUrlToLibrary(u);
      setDlUrl(''); setDlOpen(false);
      setSource({ kind: 'library' });
    } catch (e) {
      setDlErr(e instanceof Error ? e.message : 'Import failed');
    } finally { setDlBusy(false); }
  };

  const Item: React.FC<{ active?: boolean; soon?: boolean; onClick?: () => void; children: React.ReactNode; right?: React.ReactNode; title?: string }> = ({ active, soon, onClick, children, right, title }) => (
    <button type="button" disabled={soon} onClick={onClick} title={title ?? (soon ? 'Source — coming soon' : undefined)}
      className={`w-full flex items-center gap-1.5 pl-4 pr-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${active ? 'bg-purple-500/15 text-purple-200' : soon ? 'text-zinc-700 cursor-default' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}>
      <span className={`w-1 h-1 rounded-full shrink-0 ${active ? 'bg-purple-300' : 'bg-zinc-700'}`} />
      <span className="flex-1 truncate text-left">{children}</span>
      {right}
    </button>
  );
  const Group: React.FC<{ icon?: React.ReactNode; label: string; right?: React.ReactNode }> = ({ icon, label, right }) => (
    <div className="flex items-center gap-1 px-1 mt-1.5 mb-0.5 text-[8px] font-black uppercase tracking-widest text-zinc-500">
      <ChevronRight className="w-2.5 h-2.5" />{icon}{label}{right}
    </div>
  );

  return (
    <div className="hardware-card h-full w-full flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        <LibraryIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
        <span className="text-[10px] font-black uppercase tracking-wider text-purple-300 leading-tight">Source Tree</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-1">
        <Group label="Library" />
        <Item active={source.kind === 'library'} onClick={() => setSource({ kind: 'library' })} right={<span className="text-[8px] text-zinc-600">{libCount}</span>} title="All of your generated + imported audio">Library</Item>
        <Item active={source.kind === 'favorites'} onClick={() => setSource({ kind: 'favorites' })} right={<span className="text-[8px] text-zinc-600">{favCount}</span>} title="Tracks you've starred">Favorites</Item>
        <Item active={source.kind === 'gen'} onClick={() => setSource({ kind: 'gen' })} right={<span className="text-[8px] text-zinc-600">{genCount}</span>} title="Tracks made in MAKE / MIX">Generated</Item>
        <Item active={source.kind === 'import'} onClick={() => setSource({ kind: 'import' })} right={<span className="text-[8px] text-zinc-600">{impCount}</span>} title="Tracks imported from disk or online">Imports</Item>

        <Group label="Online Music" />
        <Item active={dlOpen} onClick={() => setDlOpen((v) => !v)} title="Download a track from a YouTube / SoundCloud / Bandcamp URL straight into your library">
          <span className="inline-flex items-center gap-1.5"><Download className="w-3 h-3" /> Online Download</span>
        </Item>
        {dlOpen && (
          <div className="px-2 py-1 flex flex-col gap-1">
            <div className="flex items-center gap-1 bg-black/40 border border-white/10 rounded px-1.5">
              <Link2 className="w-3 h-3 text-zinc-600 shrink-0" />
              <input value={dlUrl} onChange={(e) => setDlUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runImport(); }}
                placeholder="paste URL…" disabled={dlBusy} aria-label="Online import URL"
                className="flex-1 min-w-0 bg-transparent text-[9px] font-mono text-zinc-200 py-1 focus:outline-none placeholder:text-zinc-600 disabled:opacity-50" />
              <button onClick={() => void runImport()} disabled={dlBusy || !dlUrl.trim()} className="shrink-0 text-purple-300 hover:text-purple-100 disabled:opacity-30" title="Download into library">
                {dlBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              </button>
            </div>
            {dlErr && <span className="text-[8px] font-mono text-rose-400 px-1 truncate" title={dlErr}>{dlErr}</span>}
            <span className="text-[7px] font-mono text-zinc-600 px-1 leading-tight">YouTube · SoundCloud · Bandcamp — Spotify is DRM-locked</span>
          </div>
        )}

        <Group label="Sets" right={<button onClick={() => { const id = createSetlist(`Set ${new Date().toLocaleDateString()}`); setActive(id); setSource({ kind: 'set', id }); }} className="ml-auto p-0.5 text-purple-300 hover:text-purple-100" title="New set"><Plus className="w-3 h-3" /></button>} />
        {sets.length === 0 ? (
          <div className="pl-4 pr-1.5 py-0.5 text-[9px] font-mono text-zinc-700">No sets — click +</div>
        ) : sets.map((s) => (
          <Item key={s.id} active={source.kind === 'set' && source.id === s.id} onClick={() => { setActive(s.id); setSource({ kind: 'set', id: s.id }); }} right={<span className="text-[8px] text-zinc-600">{s.entries.length}</span>} title={`Open set "${s.name}"`}>{s.name}</Item>
        ))}
      </div>
    </div>
  );
};

/* ═══════════════════════════════ DjMidiMap (D6) ═════════════════════════════ */

const DJ_MIDI_GROUPS = ['Mixer', 'Deck A', 'Deck B'];

/** Learn overlay: arm an action, move a control on your MIDI gear, it binds.
 *  Binding + dispatch run in DJView's one midiBus subscriber. */
const DjMidiMap: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const bindings = useDjControlMap((s) => s.bindings);
  const learnAction = useDjControlMap((s) => s.learnAction);
  const arm = useDjControlMap((s) => s.arm);
  const clear = useDjControlMap((s) => s.clear);
  const clearAll = useDjControlMap((s) => s.clearAll);
  const replaceAll = useDjControlMap((s) => s.replaceAll);
  const midiInputs = useMidiDevicesStore((s) => s.inputs);
  const ignoredControls = useMidiIgnoreStore((s) => s.controls);
  const ignoreControl = useMidiIgnoreStore((s) => s.ignoreControl);
  const ignoreChannel = useMidiIgnoreStore((s) => s.ignoreChannel);
  const removeIgnoredControl = useMidiIgnoreStore((s) => s.removeIgnoredControl);
  const clearIgnoredControls = useMidiIgnoreStore((s) => s.clearIgnoredControls);
  const detectedPreset = useMemo(() => {
    const names = midiInputs.map((n) => n.toLowerCase());
    return DJ_MIDI_PRESETS.find((p) => p.match.some((m) => names.some((n) => n.includes(m)))) ?? null;
  }, [midiInputs]);
  const [selectedPresetId, setSelectedPresetId] = useState(() => detectedPreset?.id ?? DJ_MIDI_PRESETS[0]?.id ?? '');
  const [lastSeen, setLastSeen] = useState<MidiSig | null>(null);
  const selectedPreset = DJ_MIDI_PRESETS.find((p) => p.id === selectedPresetId) ?? null;

  useEffect(() => {
    enableMidi();
  }, []);

  useEffect(() => {
    if (detectedPreset) setSelectedPresetId(detectedPreset.id);
  }, [detectedPreset]);

  useEffect(() => subscribeToMidi((msg) => {
    const [rawStatus, data1] = msg.data;
    if (typeof rawStatus !== 'number' || typeof data1 !== 'number') return;
    const status = rawStatus & 0xf0;
    const channel = rawStatus & 0x0f;
    if (status === 0xb0) setLastSeen({ kind: 'cc', number: data1, channel });
    else if (status === 0x90 || status === 0x80) setLastSeen({ kind: 'note', number: data1, channel });
  }), []);

  const applyPreset = () => {
    if (!selectedPreset) return;
    replaceAll(selectedPreset.bindings);
  };

  return (
    <div className="fixed inset-0 z-200 grid place-items-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-115 max-h-[82%] overflow-y-auto rounded-lg border border-purple-500/30 bg-[#0c0a14] shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/5 sticky top-0 bg-[#0c0a14]">
          <Piano className="w-3.5 h-3.5 text-purple-300 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 shrink-0">DJ MIDI Map</span>
          <span className="text-[8px] font-mono text-zinc-500 truncate">Click Learn, then move a control</span>
          <button onClick={clearAll} className="ml-auto shrink-0 text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-rose-300">Clear all</button>
          <button onClick={onClose} className="shrink-0 p-1 text-zinc-500 hover:text-white rounded hover:bg-white/5"><X className="w-3.5 h-3.5" /></button>
        </div>
        <div className="p-3 flex flex-col gap-2">
          <div className="rounded border border-white/8 bg-black/30 p-2 flex flex-col gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Plug className={`w-3.5 h-3.5 shrink-0 ${midiInputs.length ? 'text-emerald-300' : 'text-zinc-600'}`} />
              <span className="flex-1 min-w-0 text-[8px] font-mono text-zinc-500 truncate">
                {midiInputs.length ? midiInputs.join(', ') : 'Waiting for a MIDI input'}
              </span>
              {lastSeen && (
                <>
                  <span className="shrink-0 text-[8px] font-mono text-emerald-300">
                    {sigLabel(lastSeen)}
                  </span>
                  <button
                    type="button"
                    onClick={() => ignoreControl({ kind: lastSeen.kind, number: lastSeen.number, channel: lastSeen.channel ?? 0 })}
                    className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-rose-500/30 bg-rose-500/10 text-[8px] font-black uppercase tracking-wider text-rose-200 hover:bg-rose-500/20"
                    title={`Ignore ${sigLabel(lastSeen)}`}
                  >
                    <Ban className="w-2.5 h-2.5" /> Ignore
                  </button>
                  <button
                    type="button"
                    onClick={() => ignoreControl({ kind: lastSeen.kind, number: lastSeen.number, channel: lastSeen.channel ?? 0 }, { anyChannel: true })}
                    className="shrink-0 px-1.5 py-0.5 rounded border border-rose-500/20 bg-rose-500/5 text-[8px] font-black uppercase tracking-wider text-rose-200 hover:bg-rose-500/15"
                    title={`Ignore ${lastSeen.kind.toUpperCase()} ${lastSeen.number} on any MIDI channel`}
                  >
                    Any ch
                  </button>
                  {lastSeen.channel !== null && (
                    <button
                      type="button"
                      onClick={() => ignoreChannel(lastSeen.kind, lastSeen.channel)}
                      className="shrink-0 px-1.5 py-0.5 rounded border border-rose-500/20 bg-rose-500/5 text-[8px] font-black uppercase tracking-wider text-rose-200 hover:bg-rose-500/15"
                      title={`Ignore all ${lastSeen.kind.toUpperCase()} messages on channel ${lastSeen.channel + 1}`}
                    >
                      Ch
                    </button>
                  )}
                </>
              )}
            </div>
            {ignoredControls.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {ignoredControls.map((control) => (
                  <button
                    key={control.id}
                    type="button"
                    onClick={() => removeIgnoredControl(control.id)}
                    className="inline-flex items-center gap-1 rounded border border-rose-500/25 bg-rose-500/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-wider text-rose-200 hover:bg-rose-500/20"
                    title="Stop ignoring this MIDI control"
                  >
                    <Ban className="w-2.5 h-2.5" />
                    {midiIgnoreLabel(control)}
                    <X className="w-2.5 h-2.5" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearIgnoredControls}
                  className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-wider text-zinc-500 hover:text-zinc-200 hover:bg-white/5"
                  title="Clear all ignored MIDI controls"
                >
                  Clear
                </button>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <label htmlFor="dj-midi-preset" className="sr-only">MIDI preset</label>
              <select
                id="dj-midi-preset"
                value={selectedPresetId}
                onChange={(e) => setSelectedPresetId(e.target.value)}
                className="min-w-0 flex-1 bg-black/50 border border-white/10 rounded px-2 py-1 text-[9px] font-mono text-zinc-200 focus:outline-none focus:border-purple-400"
              >
                {DJ_MIDI_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <button
                onClick={applyPreset}
                disabled={!selectedPreset}
                className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border border-purple-500/30 bg-purple-500/10 text-[8px] font-black uppercase tracking-wider text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
                title="Load the selected preset mappings"
              >
                <Wand2 className="w-3 h-3" /> Apply
              </button>
            </div>
          </div>
          {DJ_MIDI_GROUPS.map((g) => (
            <div key={g}>
              <div className="text-[8px] font-black uppercase tracking-widest text-zinc-500 mb-1">{g}</div>
              <div className="grid grid-cols-2 gap-1">
                {MIDI_ACTIONS.filter((a) => a.group === g).map((a) => {
                  const sig = bindings[a.id];
                  const learning = learnAction === a.id;
                  return (
                    <div key={a.id} className={`flex items-center gap-1 px-1.5 py-1 rounded border ${learning ? 'border-amber-400/60 bg-amber-500/10' : 'border-white/8 bg-black/30'}`}>
                      <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-300 truncate" title={a.label}>{a.label}</span>
                      <span className={`text-[8px] font-mono shrink-0 ${sig ? 'text-emerald-300' : 'text-zinc-600'}`}>{sigLabel(sig)}</span>
                      <button onClick={() => arm(learning ? null : a.id)} className={`shrink-0 text-[8px] font-bold uppercase px-1 py-0.5 rounded border ${learning ? 'border-amber-400 text-amber-300 animate-pulse' : 'border-white/10 text-zinc-400 hover:text-zinc-100'}`}>{learning ? '…' : 'Learn'}</button>
                      {sig && <button onClick={() => clear(a.id)} className="shrink-0 text-zinc-600 hover:text-rose-400" title="Clear binding"><X className="w-2.5 h-2.5" /></button>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------- helpers ----------------------------------- */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));

function snapToBeat(t: number, beats: number[] | null): number {
  if (!beats || beats.length === 0) return t;
  let best = beats[0];
  for (const b of beats) { if (b <= t) best = b; else break; }
  return best;
}

function nearestBeat(t: number, beats: number[] | null): number {
  if (!beats || beats.length === 0) return t;
  let best = beats[0];
  let bestD = Math.abs(t - best);
  for (const b of beats) { const d = Math.abs(t - b); if (d < bestD) { best = b; bestD = d; } if (b > t && d > bestD) break; }
  return best;
}

function beatPhase(t: number, beats: number[] | null): number {
  if (!beats || beats.length < 2) return 0;
  let i = 0;
  while (i < beats.length - 1 && beats[i + 1] <= t) i++;
  const prev = beats[i];
  const next = beats[i + 1] ?? prev + (beats[i] - (beats[i - 1] ?? prev - 0.5));
  const interval = next - prev || 0.5;
  return clamp01((t - prev) / interval);
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function sameLoop(a: { in: number; out: number } | null, b: { in: number; out: number } | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.in === b.in && a.out === b.out;
}

const DeckWaveform: React.FC<{
  deckId: djEngine.DeckId;
  audioUrl: string;
  beats: number[] | null;
  cues: (number | null)[] | null;
  accent: 'purple' | 'cyan';
  height?: number;
  mode?: 'overview' | 'detail';
}> = ({ deckId, audioUrl, beats, cues, accent, height = 48, mode = 'overview' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(0);
  const [loop, setLoop] = useState<{ in: number; out: number } | null>(null);
  const [zoom, setZoom] = useState(mode === 'detail' ? 8 : 1);
  const [viewStart, setViewStart] = useState(0);
  const visibleFrac = 1 / zoom;
  const viewEnd = viewStart + visibleFrac;
  const viewMin = mode === 'detail' ? -visibleFrac / 2 : 0;
  const viewMax = mode === 'detail' ? 1 - visibleFrac / 2 : Math.max(0, 1 - visibleFrac);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const viewStartRef = useRef(viewStart);
  const visibleFracRef = useRef(visibleFrac);
  viewStartRef.current = viewStart;
  visibleFracRef.current = visibleFrac;

  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    const d = st.duration || 0;
    setDur((p) => (p === d ? p : d));
    const currentNorm = d > 0 ? clamp01(st.currentTime / d) : 0;
    if (modeRef.current === 'detail') {
      const vf = visibleFracRef.current;
      const nextStart = clamp(currentNorm - vf / 2, -vf / 2, 1 - vf / 2);
      if (Math.abs(nextStart - viewStartRef.current) > 0.0008) setViewStart(nextStart);
      if (playheadRef.current) {
        playheadRef.current.style.left = '50%';
        playheadRef.current.style.opacity = '0';
      }
    } else if (playheadRef.current) {
      const vs = viewStartRef.current;
      const vf = visibleFracRef.current;
      const pos = vf > 0 ? (currentNorm - vs) / vf : 0;
      playheadRef.current.style.left = `${clamp01(pos) * 100}%`;
      playheadRef.current.style.opacity = pos >= 0 && pos <= 1 ? '1' : '0';
    }
    const nl = st.loopActive && st.loopIn != null && st.loopOut != null ? { in: st.loopIn, out: st.loopOut } : null;
    setLoop((p) => (sameLoop(p, nl) ? p : nl));
  }), [deckId]);

  useEffect(() => {
    const nextZoom = mode === 'detail' ? 8 : 1;
    setZoom(nextZoom);
    setViewStart(mode === 'detail' ? -(1 / nextZoom) / 2 : 0);
  }, [audioUrl, mode]);

  const beatMarks = useMemo(() => {
    if (!beats || beats.length === 0 || dur <= 0) return null;
    const dense = beats.length <= 400;
    const out: Array<{ left: number; down: boolean }> = [];
    for (let i = 0; i < beats.length; i++) {
      const pos = beats[i] / dur;
      if (pos < viewStart || pos > viewEnd) continue;
      const down = i % 4 === 0;
      if (!dense && !down) continue;
      out.push({ left: ((pos - viewStart) / visibleFrac) * 100, down });
    }
    return out;
  }, [beats, dur, viewEnd, viewStart, visibleFrac]);

  const loopView = useMemo(() => {
    if (!loop || dur <= 0) return null;
    const start = Math.max(loop.in / dur, viewStart);
    const end = Math.min(loop.out / dur, viewEnd);
    if (end <= start) return null;
    return { left: ((start - viewStart) / visibleFrac) * 100, width: ((end - start) / visibleFrac) * 100 };
  }, [dur, loop, viewEnd, viewStart, visibleFrac]);

  const accentColor = accent === 'purple' ? '#a855f7' : '#22d3ee';
  const scrubbing = useRef(false);
  const pendingX = useRef<number | null>(null);
  const scrubRaf = useRef(0);
  const seekToClientX = (clientX: number) => {
    const el = containerRef.current; if (!el) return;
    const d = djEngine.getStatus(deckId).duration; if (d <= 0) return;
    const rect = el.getBoundingClientRect();
    djEngine.seekDeck(deckId, clamp01(viewStart + clamp01((clientX - rect.left) / rect.width) * visibleFrac) * d);
  };
  const onWheelZoom = (e: React.WheelEvent) => {
    const el = containerRef.current; if (!el || dur <= 0) return;
    e.preventDefault();
    const minZoom = mode === 'detail' ? 2 : 1;
    const maxZoom = mode === 'detail' ? 36 : 24;
    const rect = el.getBoundingClientRect();
    const pointer = clamp01((e.clientX - rect.left) / rect.width);
    const panIntent = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (panIntent && zoom > 1) {
      const delta = (e.deltaX || e.deltaY) / Math.max(160, rect.width);
      setViewStart((s) => clamp(s + delta * visibleFrac, viewMin, viewMax));
      return;
    }
    const nextZoom = clamp(zoom * Math.exp(-e.deltaY * 0.002), 1, maxZoom);
    const snappedZoom = nextZoom < minZoom + 0.04 ? minZoom : Math.max(minZoom, nextZoom);
    const underPointer = viewStart + pointer * visibleFrac;
    const nextVisible = 1 / snappedZoom;
    const nextMin = mode === 'detail' ? -nextVisible / 2 : 0;
    const nextMax = mode === 'detail' ? 1 - nextVisible / 2 : Math.max(0, 1 - nextVisible);
    setZoom(snappedZoom);
    setViewStart(clamp(underPointer - pointer * nextVisible, nextMin, nextMax));
  };
  const applyScrub = () => { scrubRaf.current = 0; const x = pendingX.current; pendingX.current = null; if (x != null) seekToClientX(x); };
  const queueScrub = (clientX: number) => { pendingX.current = clientX; if (!scrubRaf.current) scrubRaf.current = requestAnimationFrame(applyScrub); };
  const onScrubDown = (e: React.PointerEvent) => { if (djEngine.getStatus(deckId).duration <= 0) return; scrubbing.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); seekToClientX(e.clientX); };
  const onScrubMove = (e: React.PointerEvent) => { if (scrubbing.current) queueScrub(e.clientX); };
  const onScrubUp = (e: React.PointerEvent) => { scrubbing.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); };
  useEffect(() => () => { if (scrubRaf.current) cancelAnimationFrame(scrubRaf.current); }, []);

  return (
    <div ref={containerRef} className="relative h-full" style={{ minHeight: height }} onWheel={onWheelZoom}>
      <DJSemanticWaveform audioUrl={audioUrl} height={height} viewportStart={viewStart} viewportEnd={viewEnd} />
      <div className="absolute inset-0 z-10 cursor-ew-resize touch-none" onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp} title="Scroll to zoom · Shift-scroll to pan · drag to scrub" />
      {beatMarks && (<div className="absolute inset-0 z-20 pointer-events-none">{beatMarks.map((m, i) => (<div key={i} className="absolute top-0 bottom-0" style={{ left: `${m.left}%`, width: '1px', background: m.down ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)' }} />))}</div>)}
      {loopView && (<div className="absolute top-0 bottom-0 z-20 pointer-events-none" style={{ left: `${loopView.left}%`, width: `${loopView.width}%`, background: 'rgba(245,200,66,0.18)', borderLeft: '1px solid rgba(245,200,66,0.7)', borderRight: '1px solid rgba(245,200,66,0.7)' }} />)}
      {dur > 0 && cues && cues.map((c, i) => {
        if (c == null) return null;
        const pos = c / dur;
        if (pos < viewStart || pos > viewEnd) return null;
        return (<div key={i} className="absolute top-0 bottom-0 z-20 pointer-events-none" style={{ left: `${((pos - viewStart) / visibleFrac) * 100}%`, width: '2px', background: accentColor }}><span className="absolute top-0 left-0 text-[6px] font-black text-black px-0.5 leading-tight" style={{ background: accentColor }}>{i + 1}</span></div>);
      })}
      {zoom > 1.04 && <div className="absolute bottom-1 right-1 z-30 rounded bg-black/70 px-1.5 py-0.5 text-[8px] font-mono text-white/70 pointer-events-none">{zoom.toFixed(1)}x</div>}
      <div ref={playheadRef} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: '0%', width: '2px', background: '#ffffff', boxShadow: '0 0 4px rgba(255,255,255,0.8)' }} />
    </div>
  );
};

/* ═══════════════════════════ control-surface registry ═══════════════════════
 * Every relocatable DJ control as a WidgetDef. Built each render (inside DJView)
 * so each `render` closure carries live state + wiring; relocating a widget only
 * changes where it draws, never what it calls. Pinned composites (hero, sampler,
 * FX racks, Next lane, source tree, library) host a whole component and stay out
 * of the palette; the source/library are never decomposed (per the design). */
interface DjRegArgs {
  ctlA: DeckCtl; ctlB: DeckCtl;
  deckATitle: string | null; deckBTitle: string | null;
  camA: ReturnType<typeof toCamelot> | null; camB: ReturnType<typeof toCamelot> | null; harmonic: boolean | null;
  hasA: boolean; hasB: boolean;
  playingA: boolean; playingB: boolean;
  cueA: boolean; cueB: boolean;
  syncLock: djEngine.DeckId | null; canSync: boolean;
  onPlayA: () => void; onPlayB: () => void;
  onCueA: () => void; onCueB: () => void;
  onStop: (d: djEngine.DeckId) => void; onEject: (d: djEngine.DeckId) => void;
  onSync: (d: djEngine.DeckId) => void; onSyncLock: (d: djEngine.DeckId) => void; onHeadCue: (d: djEngine.DeckId) => void;
  onSendVj: (d: 'A' | 'B') => void; onAddSet: (d: 'A' | 'B') => void;
  deckAUrl: string | null; deckBUrl: string | null;
  deckATrack: string | null; deckBTrack: string | null;
  setDeckATrack: (id: string) => void; setDeckBTrack: (id: string) => void;
  source: Source; setSource: (s: Source) => void; libCount: number; loadDeck: (entryId: string, deck: djEngine.DeckId) => void;
  loadDropOntoDeck: (event: React.DragEvent, deck: djEngine.DeckId) => Promise<boolean>;
  gainA: number; gainB: number;
  eqA: { low: number; mid: number; high: number }; eqB: { low: number; mid: number; high: number };
  filterA: number; filterB: number; volA: number; volB: number;
  stemKnobModeA: boolean; stemKnobModeB: boolean;
  setStemKnobModeA: (v: boolean) => void; setStemKnobModeB: (v: boolean) => void;
  pitchA: number; pitchB: number; bpmA: number | null; bpmB: number | null;
  pitchRange: PitchRange; setPitchRange: (range: PitchRange) => void;
  onGain: (which: djEngine.DeckId, v: number) => void;
  onEq: (which: djEngine.DeckId, band: 'low' | 'mid' | 'high', v: number) => void;
  onFilter: (which: djEngine.DeckId, v: number) => void; onVol: (which: djEngine.DeckId, v: number) => void;
  onPitch: (which: djEngine.DeckId, v: number) => void;
  onTargetBpm: (which: djEngine.DeckId, bpm: number) => void;
  crossfader: number; onCrossfade: (v: number) => void;
  quantize: boolean; setQuantize: (v: boolean) => void; autoGain: boolean; setAutoGain: (v: boolean) => void;
  vinylSpinA: boolean; setVinylSpinA: (v: boolean) => void;
  vinylSpinB: boolean; setVinylSpinB: (v: boolean) => void;
  limiterOn: boolean; setLimiterOn: (v: boolean) => void;
  cueSupported: boolean; cueDevices: Array<{ id: string; label: string }>; cueDev: string; setCueDev: (v: string) => void;
  midiMapOn: boolean; onToggleMidiMap: () => void;
  automixOn: boolean; onToggleAutomix: () => void;
}

const PAD_SM = 'px-1.5 py-1 text-[8px] min-w-0';
const PAD_HC = 'w-8 py-1 text-[8px]';
const PAD_BT = 'w-7 py-1 text-[8px]';

function buildDjRegistry(p: DjRegArgs): WidgetRegistry {
  const reg: WidgetRegistry = {};
  type SizeOpts = { match?: boolean; flow?: 'row' | 'column' } | undefined;
  // Control sizing: grow to fill the cell. When `match` is on, size to the
  // SHARED cross-axis (row → cell height, column → cell width) so same-kind
  // controls line up (equal height across a row / width down a column), clamped
  // so a narrow cell never overflows.
  const fitDim = (s: { w: number; h: number }, opts: SizeOpts, labelH: number, cap: number) => {
    const byH = s.h - labelH;
    const byW = s.w - 6;
    const base = opts?.match
      ? opts.flow === 'row'
        ? byH
        : opts.flow === 'column'
          ? byW
          : Math.min(byW, byH)
      : Math.min(byW, byH);
    return Math.min(base, byW, byH, cap);
  };
  const knobSize = (s: { w: number; h: number }, opts?: SizeOpts) => Math.max(20, fitDim(s, opts, 26, 112));
  const toggleBox = (s: { w: number; h: number }, opts?: SizeOpts) => Math.max(24, fitDim(s, opts, 12, 84));
  const center = (node: React.ReactNode) => <div className="h-full w-full grid place-items-center overflow-hidden">{node}</div>;
  // Pads render LANDSCAPE (like CUE/PLAY): fill the cell width, cap the height so
  // the button stays wider than tall, centred vertically in its cell.
  const padBox = (s: { w: number; h: number }, node: React.ReactNode) => (
    <div className="h-full w-full grid place-items-center overflow-hidden">
      <div className="w-full grid" style={{ height: Math.max(22, Math.min(s.h, s.w * 0.6)) }}>{node}</div>
    </div>
  );
  const faderWrap = (node: React.ReactNode) => <div className="h-full w-full min-h-0 flex justify-center">{node}</div>;
  const pinned = (id: string, label: string, node: React.ReactNode) => {
    reg[id] = { id, label, group: 'Panels', kind: 'fixed', source: 'builtin', render: () => <div className="h-full w-full min-h-0 overflow-hidden">{node}</div> };
  };
  const knob = (
    id: string,
    label: string,
    group: string,
    value: number,
    onChange: (v: number) => void,
    min: number,
    max: number,
    step: number,
    extra?: { center?: boolean; onLabelClick?: () => void; onLabelDoubleClick?: () => void; labelTitle?: string; tint?: number },
  ) => {
    reg[id] = {
      id,
      label,
      group,
      kind: 'knob',
      source: 'builtin',
      render: (s, opts) => center(
        <SlideKnob
          label={label}
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          size={knobSize(s, opts)}
          center={extra?.center ?? true}
          centerReadout
          onLabelClick={extra?.onLabelClick}
          onLabelDoubleClick={extra?.onLabelDoubleClick}
          labelTitle={extra?.labelTitle}
          tint={extra?.tint}
        />,
      ),
    };
  };

  /* ── pinned composites ── */
  pinned('waveAOverview', 'Deck A Overview', (
    <WaveLane deckId="A" accent="purple" entryId={p.deckATrack} hasTrack={p.hasA} audioUrl={p.deckAUrl} ctl={p.ctlA} onLoadDrop={p.loadDropOntoDeck} mode="overview" compact />
  ));
  pinned('waveBOverview', 'Deck B Overview', (
    <WaveLane deckId="B" accent="cyan" entryId={p.deckBTrack} hasTrack={p.hasB} audioUrl={p.deckBUrl} ctl={p.ctlB} onLoadDrop={p.loadDropOntoDeck} mode="overview" compact />
  ));
  pinned('hero', 'Waveforms', (
    <div className="relative h-full w-full flex flex-col gap-1.5">
      <WaveLane deckId="A" accent="purple" entryId={p.deckATrack} hasTrack={p.hasA} audioUrl={p.deckAUrl} ctl={p.ctlA} onLoadDrop={p.loadDropOntoDeck} mode="detail" />
      <WaveLane deckId="B" accent="cyan" entryId={p.deckBTrack} hasTrack={p.hasB} audioUrl={p.deckBUrl} ctl={p.ctlB} onLoadDrop={p.loadDropOntoDeck} mode="detail" />
      <div className="absolute top-0 bottom-0 left-1/2 z-40 w-px -translate-x-1/2 pointer-events-none bg-white shadow-[0_0_7px_rgba(255,255,255,0.95)]">
        <div className="absolute -top-0.5 left-1/2 h-0 w-0 -translate-x-1/2 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-white" />
      </div>
    </div>
  ));
  pinned('sampler', 'Sampler', <SamplerRail />);
  pinned('fxA', 'Onboard FX A', <OnboardFxPanel deck="A" accent="purple" entryId={p.deckATrack} ctl={p.ctlA} />);
  pinned('fxB', 'Onboard FX B', <OnboardFxPanel deck="B" accent="cyan" entryId={p.deckBTrack} ctl={p.ctlB} />);
  pinned('perfA', 'Performance Pads A', <CompactPerformancePads deck="A" accent="purple" entryId={p.deckATrack} ctl={p.ctlA} />);
  pinned('perfB', 'Performance Pads B', <CompactPerformancePads deck="B" accent="cyan" entryId={p.deckBTrack} ctl={p.ctlB} />);
  pinned('next', 'Next / Staging', <SideListLane onLoadDeck={p.loadDeck} />);
  pinned('sourceTree', 'Source Tree', <SourceTree source={p.source} setSource={p.setSource} libCount={p.libCount} />);
  pinned('library', 'Library', <TrackBrowser source={p.source} setSource={p.setSource} onLoadDeck={p.loadDeck} />);

  /* ── per-deck performance controls ── */
  const addDeck = (d: 'A' | 'B') => {
    const accent = d === 'A' ? 'purple' : 'cyan';
    const rgbc = DECK_RGB[accent];
    const ctl = d === 'A' ? p.ctlA : p.ctlB;
    const hasTrack = d === 'A' ? p.hasA : p.hasB;
    const isPlaying = d === 'A' ? p.playingA : p.playingB;
    const title = d === 'A' ? p.deckATitle : p.deckBTitle;
    const entryId = d === 'A' ? p.deckATrack : p.deckBTrack;
    const cam = d === 'A' ? p.camA : p.camB;
    const headCued = d === 'A' ? p.cueA : p.cueB;
    const pitch = d === 'A' ? p.pitchA : p.pitchB;
    const onPlay = d === 'A' ? p.onPlayA : p.onPlayB;
    const onCue = d === 'A' ? p.onCueA : p.onCueB;
    const vinylSpin = d === 'A' ? p.vinylSpinA : p.vinylSpinB;
    const setVinylSpin = d === 'A' ? p.setVinylSpinA : p.setVinylSpinB;
    const stopTitle = sortedCuePoints(ctl.cues).length > 0 ? 'Stop and jump to next hotcue' : 'Stop and return to start';
    const syncLocked = p.syncLock === d;
    const grp = `Deck ${d}`;

    reg[`header${d}`] = { id: `header${d}`, label: `Deck ${d} Info`, group: grp, kind: 'fixed', source: 'builtin', render: (_s, opts) => (
      <div className={`h-full w-full flex items-center gap-1.5 px-1 overflow-hidden ${opts?.mirror ? 'flex-row-reverse' : ''}`}>
        <div className="shrink-0 grid place-items-center rounded border w-7 h-7" style={{ borderColor: rgba(rgbc, 0.4), background: rgba(rgbc, 0.12) }} title={`Deck ${d}`}>
          <Music2 className="w-3.5 h-3.5" style={{ color: rgb(rgbc) }} />
        </div>
        <div className={`min-w-0 flex-1 flex flex-col ${opts?.mirror ? 'items-end text-right' : ''}`}>
          <span
            draggable={!!entryId}
            onDragStart={(ev) => {
              if (!entryId) return;
              ev.dataTransfer.effectAllowed = 'copy';
              ev.dataTransfer.setData(DJ_TRACK_MIME, entryId);
              ev.dataTransfer.setData('text/plain', title ?? `Deck ${d} track`);
            }}
            className={`text-[10px] font-bold text-zinc-200 truncate max-w-full leading-tight ${entryId ? 'cursor-grab active:cursor-grabbing hover:text-white' : ''}`}
            title={entryId ? `Drag "${title ?? 'this track'}" into a set or playlist` : ''}
          >
            {title ?? 'Empty deck'}
          </span>
          <DeckTimes deckId={d} mirror={opts?.mirror} />
        </div>
        <div className="shrink-0 flex flex-col gap-0.5">
          <button onClick={() => p.onSendVj(d)} disabled={!hasTrack} className="p-0.5 text-zinc-600 hover:text-cyan-300 disabled:opacity-30 disabled:pointer-events-none transition-colors" title="Send this deck's track to the VJ"><Cast className="w-3 h-3" /></button>
          <button onClick={() => p.onAddSet(d)} disabled={!hasTrack} className="p-0.5 text-zinc-600 hover:text-emerald-300 disabled:opacity-30 disabled:pointer-events-none transition-colors" title="Add this deck's track to the active set"><Save className="w-3 h-3" /></button>
        </div>
      </div>
    ) };

    reg[`bpm${d}`] = { id: `bpm${d}`, label: `BPM ${d}`, group: grp, kind: 'fixed', source: 'builtin', render: () => (
      <EditableBpmField
        deck={d}
        sourceBpm={ctl.bpm}
        pitchPct={pitch}
        analyzing={ctl.analyzing}
        color={rgbc}
        onCommit={(bpm) => p.onTargetBpm(d, bpm)}
      />
    ) };

    reg[`key${d}`] = { id: `key${d}`, label: `Key ${d}`, group: grp, kind: 'fixed', source: 'builtin', render: () => (
      <div className="h-full w-full grid place-items-center px-1 overflow-hidden">
        {cam ? (
          <div
            className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-md border"
            style={{
              borderColor: `hsl(${cam.hue} 70% 55% / 0.6)`,
              background: `linear-gradient(180deg, hsl(${cam.hue} 70% 50% / 0.22), hsl(${cam.hue} 70% 50% / 0.05))`,
              boxShadow: `0 0 12px hsl(${cam.hue} 80% 55% / 0.4)`,
            }}
            title={`Camelot ${cam.code} — mixes with ${cam.compatible.join(', ')}`}
          >
            <span className="grid place-items-center w-5 h-5 rounded-full text-[8px] font-black shrink-0" style={{ background: `hsl(${cam.hue} 85% 62%)`, color: '#0a0a0a', boxShadow: `0 0 6px hsl(${cam.hue} 85% 60% / 0.7)` }}>
              {cam.code.replace(/[AB]/i, '')}
            </span>
            <span className="text-[15px] font-black leading-none" style={{ color: `hsl(${cam.hue} 85% 70%)`, textShadow: `0 0 8px hsl(${cam.hue} 80% 55% / 0.55)` }}>{cam.code}</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-1.5 px-2.5 py-1 rounded-md border border-white/10 bg-black/40">
            <span className="text-[7px] font-black uppercase tracking-[0.22em] text-zinc-500">KEY</span>
            <span className="text-[13px] font-black leading-none text-zinc-300">{ctl.a?.key ? keyLabel(ctl.a.key, ctl.a.scale) : '—'}</span>
          </div>
        )}
      </div>
    ) };

    reg[`jog${d}`] = { id: `jog${d}`, label: `Jog ${d}`, group: grp, kind: 'jog', source: 'builtin', render: () => (
      <PlatterDropTarget deckId={d} color={rgbc} hasTrack={hasTrack} bpm={ctl.bpm ?? null} pitchPct={d === 'A' ? p.pitchA : p.pitchB} onLoadDrop={p.loadDropOntoDeck} />
    ) };
    reg[`stemBank${d}`] = { id: `stemBank${d}`, label: `Stem Pads ${d}`, group: grp, kind: 'fixed', source: 'builtin', render: (_s, opts) => (
      <StemPadBank deck={d} entryId={entryId} color={rgbc} ctl={ctl} mirror={opts?.mirror} />
    ) };

    // Each pad is its own relocatable widget (atomized transport / hotcues / loop / perf).
    const padW = (id: string, label: string, node: React.ReactElement) => {
      reg[id] = {
        id, label, group: grp, kind: 'pad', source: 'builtin',
        // Pads render LANDSCAPE filling the cell width. Forward the per-widget
        // shape (Design-Mode shape grip) into the pad.
        render: (s, opts) =>
          padBox(
            s,
            opts?.shape && opts.shape !== 'default'
              ? React.cloneElement(node as React.ReactElement<{ shape?: typeof opts.shape }>, { shape: opts.shape })
              : node,
          ),
      };
    };
    const StopSpinPad: React.FC<{ shape?: unknown }> = ({ shape: _shape }) => (
      <div className="h-full w-full grid grid-cols-[1fr_1.35rem] gap-0.5">
        <SlidePad color={rgbc} disabled={!hasTrack} onClick={() => p.onStop(d)} className="px-2 py-1 min-w-0" title={stopTitle}>
          <Square className="w-3 h-3 fill-current" />
        </SlidePad>
        <SlidePad
          color={rgbc}
          on={vinylSpin}
          disabled={!hasTrack}
          onClick={() => setVinylSpin(!vinylSpin)}
          className="px-1 py-1 min-w-0"
          title={vinylSpin ? 'Turntable spin-up/down on' : 'Turntable spin-up/down off'}
        >
          <Disc className="w-2.5 h-2.5" />
        </SlidePad>
      </div>
    );

    padW(`cue${d}`, `Cue ${d}`, <SlidePad color={rgbc} disabled={!hasTrack} onClick={onCue} className={PAD_SM} title="Cue to start">Cue</SlidePad>);
    padW(`play${d}`, `Play ${d}`, <SlidePad color={rgbc} disabled={!hasTrack} onClick={onPlay} className="px-3 py-1" title={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}</SlidePad>);
    padW(`stop${d}`, `Stop ${d}`, <StopSpinPad />);
    padW(`eject${d}`, `Eject ${d}`, <SlidePad danger disabled={!hasTrack} onClick={() => p.onEject(d)} className={`px-2 py-1 ${hasTrack ? 'dj-eject-heartbeat' : ''}`} title="Eject this deck"><EjectSymbol className="w-3 h-3" /></SlidePad>);
    padW(`sync${d}`, `Sync ${d}`, <SlidePad color={rgbc} disabled={!p.canSync} onClick={() => p.onSync(d)} className={PAD_SM} title={p.canSync ? 'BPM Sync — when one deck is playing, match the stopped incoming deck to it' : 'SYNC needs BPM on both decks'}>Sync</SlidePad>);
    padW(`syncLock${d}`, `Sync-Lock ${d}`, <SlidePad color={rgbc} on={syncLocked} disabled={!p.canSync} onClick={() => p.onSyncLock(d)} className="px-1.5 py-1" title="Sync-Lock — hold tempo + phase"><Lock className="w-3 h-3" /></SlidePad>);
    padW(`headCue${d}`, `HP Cue ${d}`, <SlidePad color={[34, 211, 238]} on={headCued} disabled={!hasTrack} onClick={() => p.onHeadCue(d)} className="px-1.5 py-1" title="Cue — pre-listen in the headphone output"><Headphones className="w-3 h-3" /></SlidePad>);
    padW(`stemLoad${d}`, `Load Stems ${d}`, <StemLoadPad deck={d} entryId={entryId} color={rgbc} />);
    for (let i = 0; i < STEM_PAD_SLOTS; i++) {
      const name = ctl.stemNames[i] ?? null;
      const label = stemLabel(name ?? STEM_PAD_FALLBACKS[i] ?? `Stem ${i + 1}`);
      const level = name ? (ctl.stemLevels[name] ?? djEngine.getStemGain(d, name)) : 0;
      const on = !!name && level > 0.001;
      const color = STEM_PAD_COLORS[i] ?? rgbc;
      padW(`stem${d}${i}`, `${label} ${d}`, (
        <SlidePad
          color={color}
          on={on}
          disabled={!name}
          onClick={() => {
            if (!name) return;
            const current = djEngine.getStemGain(d, name);
            djEngine.setStemGain(d, name, current > 0.001 ? 0 : 1);
          }}
          className="px-1 py-1 text-[7px] min-w-0"
          title={name ? `Deck ${d} ${name}: ${on ? 'click to mute' : 'click to restore'}` : 'Load stems first'}
        >
          <span className="truncate">{label}</span>
        </SlidePad>
      ));
    }

    for (let i = 0; i < HOTCUE_SLOTS; i++) {
      const c = ctl.cues?.[i] ?? null; const set = c != null;
      padW(`hc${d}${i + 1}`, `Hotcue ${d}${i + 1}`, <SlidePad on={set} color={rgbc} disabled={!hasTrack} className={PAD_HC} onClick={() => ctl.setHotcue(i)} onContextMenu={(e) => { e.preventDefault(); ctl.dropHotcue(i); }} title={set ? `Cue ${i + 1} @ ${fmtTime(c)} — click to jump, right-click to clear` : `Set cue ${i + 1} at the playhead`}>{set ? `▶${i + 1}` : `○${i + 1}`}</SlidePad>);
    }

    BEAT_SIZES.forEach((b, bi) => padW(`loop${d}_${bi}`, `Loop ${b.label} ${d}`, <SlidePad className={PAD_BT} on={ctl.loopActive && ctl.activeLoopBeats === b.beats} color={rgbc} disabled={!hasTrack} onClick={() => ctl.toggleBeatLoop(b.beats)} title={`${b.label}-beat loop`}>{b.label}</SlidePad>));
    padW(`loopOut${d}`, `Loop Out ${d}`, <SlidePad className={PAD_BT} danger disabled={!ctl.loopActive} onClick={ctl.exitLoop} title="Exit loop">Out</SlidePad>);

    ROLL_SIZES.forEach((b, ri) => padW(`roll${d}_${ri}`, `Roll ${b.label} ${d}`, <SlidePad className={PAD_BT} color={rgbc} disabled={!hasTrack} onPointerDown={(e) => { e.preventDefault(); ctl.rollDown(b.beats); }} onPointerUp={ctl.rollUp} onPointerLeave={(e) => { if (e.buttons) ctl.rollUp(); }} title={`${b.label}-beat loop-roll (hold)`}>{b.label}</SlidePad>));
    padW(`slip${d}`, `Slip ${d}`, <SlidePad className={PAD_BT} on={ctl.slip} color={[245, 158, 11]} disabled={!hasTrack} onClick={() => ctl.setSlip(!ctl.slip)} title="Slip mode">Slip</SlidePad>);
    ([[-4, '«4'], [-1, '‹1'], [1, '1›'], [4, '4»']] as const).forEach(([n, lbl], ji) => padW(`jump${d}_${ji}`, `Jump ${lbl} ${d}`, <SlidePad className={PAD_BT} color={rgbc} disabled={!hasTrack} onClick={() => ctl.beatJump(n)} title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'}`}>{lbl}</SlidePad>));
    padW(`keylock${d}`, `Keylock ${d}`, <SlidePad className="px-1.5 py-1" on={ctl.keylock} color={rgbc} disabled={!hasTrack} onClick={() => ctl.setKeylock(!ctl.keylock)} title="Key-lock / Master Tempo"><KeyRound className="w-3 h-3" /></SlidePad>);
  };
  addDeck('A');
  addDeck('B');

  /* ── per-deck mixer controls ── */
  const addMixerDeck = (d: 'A' | 'B') => {
    const grp = `Mixer ${d}`;
    const eq = d === 'A' ? p.eqA : p.eqB;
    const ctl = d === 'A' ? p.ctlA : p.ctlB;
    const stemKnobMode = d === 'A' ? p.stemKnobModeA : p.stemKnobModeB;
    const setStemKnobMode = d === 'A' ? p.setStemKnobModeA : p.setStemKnobModeB;
    const toggleStemKnobs = () => setStemKnobMode(!stemKnobMode);
    const modeTitle = stemKnobMode
      ? 'Click to return these knobs to deck EQ/filter'
      : 'Click to make these knobs control stem volumes';

    const eqKnob = (id: string, label: string, value: number, onChange: (v: number) => void, min: number, max: number, step: number) =>
      knob(id, label, grp, value, onChange, min, max, step, { onLabelClick: toggleStemKnobs, labelTitle: modeTitle });

    const stemVolKnob = (widgetId: string, fallback: string, aliases: readonly string[], tint: number) => {
      const name = findStemForSlot(ctl.stemNames, aliases);
      const label = name ? stemLabel(name) : fallback;
      const value = name ? (ctl.stemLevels[name] ?? djEngine.getStemGain(d, name)) : 0;
      knob(
        widgetId,
        label,
        grp,
        value,
        (v) => { if (name) djEngine.setStemGain(d, name, v); },
        0,
        1,
        0.01,
        { center: false, onLabelClick: toggleStemKnobs, labelTitle: modeTitle, tint },
      );
    };

    if (stemKnobMode) {
      for (const slot of STEM_MIXER_KNOB_SLOT_LIST) {
        const widgetId = slot.id === 'flt' ? `flt${d}` : `eq${d}.${slot.id}`;
        stemVolKnob(widgetId, slot.fallback, slot.aliases, slot.tint);
      }
    } else {
      eqKnob(`eq${d}.hi`, 'Hi', eq.high, (v) => p.onEq(d, 'high', v), -12, 12, 0.5);
      eqKnob(`eq${d}.mid`, 'Mid', eq.mid, (v) => p.onEq(d, 'mid', v), -12, 12, 0.5);
      eqKnob(`eq${d}.lo`, 'Lo', eq.low, (v) => p.onEq(d, 'low', v), -12, 12, 0.5);
      eqKnob(`flt${d}`, 'Flt', d === 'A' ? p.filterA : p.filterB, (v) => p.onFilter(d, v), -1, 1, 0.01);
    }
    knob(`gain${d}`, 'Gain', grp, d === 'A' ? p.gainA : p.gainB, (v) => p.onGain(d, v), -12, 12, 0.5);
    reg[`vol${d}`] = { id: `vol${d}`, label: `Vol ${d}`, group: grp, kind: 'fader', source: 'builtin', render: () => faderWrap(<SlideFader label={d} value={d === 'A' ? p.volA : p.volB} onChange={(v) => p.onVol(d, v)} min={0} max={1} step={0.01} rulerSide={d === 'B' ? 'right' : 'left'} />) };
    const pitch = d === 'A' ? p.pitchA : p.pitchB;
    const bpm = d === 'A' ? p.bpmA : p.bpmB;
    const effBpm = bpm != null ? (bpm * (1 + pitch / 100)).toFixed(1) : '—';
    reg[`pitch${d}`] = { id: `pitch${d}`, label: `Pitch ${d}`, group: grp, kind: 'fader', source: 'builtin', render: () => (
      <div className="h-full w-full min-h-0 flex flex-col items-center">
        <div className="flex-1 min-h-0 flex justify-center"><SlideFader label={`Pch ${d}`} value={pitch} onChange={(v) => p.onPitch(d, v)} min={-p.pitchRange} max={p.pitchRange} step={0.1} rulerSide={d === 'A' ? 'left' : 'right'} /></div>
        <span className="shrink-0 text-[8px] font-mono tabular-nums text-zinc-500" title="Effective BPM at this pitch">{effBpm}</span>
      </div>
    ) };
  };
  addMixerDeck('A');
  addMixerDeck('B');

  /* ── shared mixer controls ── */
  reg.pitchRange = { id: 'pitchRange', label: 'Pitch Range', group: 'Mixer', kind: 'button', source: 'builtin', render: () => center(
    <button
      type="button"
      onClick={() => p.setPitchRange(p.pitchRange === 10 ? 15 : 10)}
      title="Pitch range"
      className="flex flex-col items-center justify-center gap-0.5 min-w-12 px-2 py-1 rounded-md border border-amber-400/50 bg-amber-500/15 text-amber-100 shadow-[0_0_14px_rgba(245,158,11,0.25)] hover:bg-amber-500/25 transition-colors"
    >
      <span className="text-[7px] font-black uppercase tracking-wider leading-none">Range</span>
      <span className="text-[12px] font-black font-mono tabular-nums leading-none">±{p.pitchRange}%</span>
    </button>
  ) };
  reg.qtz = { id: 'qtz', label: 'Quantize', group: 'Mixer', kind: 'toggle', source: 'builtin', render: (s, opts) => center(<RoundToggle label="Qtz" icon={Magnet} on={p.quantize} onChange={p.setQuantize} box={toggleBox(s, opts)} />) };
  reg.autoGain = { id: 'autoGain', label: 'Auto-gain', group: 'Mixer', kind: 'toggle', source: 'builtin', render: (s, opts) => center(<RoundToggle label="Gain" icon={Gauge} on={p.autoGain} onChange={p.setAutoGain} box={toggleBox(s, opts)} />) };
  reg.lim = { id: 'lim', label: 'Limiter', group: 'Mixer', kind: 'toggle', source: 'builtin', render: (s, opts) => center(<RoundToggle label="Lim" icon={Shield} on={p.limiterOn} onChange={(v) => { p.setLimiterOn(v); djEngine.setLimiter(v); }} box={toggleBox(s, opts)} />) };
  reg.midiMap = { id: 'midiMap', label: 'MIDI Map', group: 'Mixer', kind: 'toggle', source: 'builtin', render: (s, opts) => center(<RoundToggle label="MIDI" icon={Piano} on={p.midiMapOn} onChange={() => p.onToggleMidiMap()} box={toggleBox(s, opts)} />) };

  reg.crossfader = { id: 'crossfader', label: 'Crossfader', group: 'Mixer', kind: 'crossfader', source: 'builtin', render: () => (
    <div className="h-full w-full flex flex-col justify-center px-1">
      <div className="flex items-center gap-1">
        <span className="text-[9px] font-black text-purple-300">A</span>
        <div className="flex-1"><SlideCrossfader value={p.crossfader} onChange={p.onCrossfade} ariaLabel="Crossfader" title="Crossfade A ↔ B (double-click to center)" /></div>
        <span className="text-[9px] font-black text-cyan-300">B</span>
      </div>
      <div className="text-center text-[8px] font-mono text-zinc-600 tabular-nums leading-tight mt-0.5">{p.crossfader < -0.05 ? `A ${Math.round(-p.crossfader * 100)}%` : p.crossfader > 0.05 ? `B ${Math.round(p.crossfader * 100)}%` : 'CENTER'}</div>
    </div>
  ) };

  reg.automix = { id: 'automix', label: 'Automix', group: 'Mixer', kind: 'button', source: 'builtin', render: () => center(
    <button onClick={p.onToggleAutomix} title="Automix — auto-sequence + beatmatch-crossfade the active set" className={`px-3 py-0.5 rounded text-[8px] font-black uppercase tracking-widest border transition-colors ${p.automixOn ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200 animate-pulse' : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/25'}`}>{p.automixOn ? 'Automix ●' : 'Automix'}</button>
  ) };

  reg.keymatch = { id: 'keymatch', label: 'Key Match', group: 'Mixer', kind: 'button', source: 'builtin', render: () => center(
    p.camA && p.camB ? (
      <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold border ${p.harmonic ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`} title={p.harmonic ? `In key — ${p.camA.code} / ${p.camB.code}` : `Key clash — ${p.camA.code} vs ${p.camB.code}`}><Music2 className="w-2.5 h-2.5" />{p.harmonic ? 'In Key' : 'Clash'}</div>
    ) : <span className="text-[7px] font-mono text-zinc-700">key</span>
  ) };

  reg.cueDevice = { id: 'cueDevice', label: 'Cue Output', group: 'Mixer', kind: 'button', source: 'builtin', render: () => (
    <div className="h-full w-full grid place-items-center px-1">
      {p.cueSupported ? (
        <div className="flex items-center gap-1 w-full" title="Headphone (cue) output device">
          <Headphones className="w-2.5 h-2.5 text-zinc-500 shrink-0" />
          <select value={p.cueDev} onChange={(e) => { p.setCueDev(e.target.value); void djEngine.setCueSinkId(e.target.value); }} className="flex-1 min-w-0 bg-[#0e0c18] border border-white/10 text-zinc-300 text-[8px] font-mono px-1 py-0.5 rounded focus:outline-none" style={{ colorScheme: 'dark' }} title="Cue output device">
            <option value="">Default out</option>
            {p.cueDevices.map((dv) => <option key={dv.id} value={dv.id}>{dv.label}</option>)}
          </select>
        </div>
      ) : <span className="text-[7px] font-mono text-zinc-700">cue n/a</span>}
    </div>
  ) };

  return reg;
}
