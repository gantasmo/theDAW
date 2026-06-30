import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Scissors, Play, Pause, Square, ZoomIn, ZoomOut,
  Magnet, Trash2, Move, Plus, Volume2, Upload, Save, Piano, Paintbrush, X, Wand2, Layers,
  SlidersHorizontal, Undo2, Redo2, Gauge, Repeat, Flag, Circle, Copy, Music,
  Plug, Snowflake, Loader2, ChevronUp, ChevronDown, RefreshCw,
} from 'lucide-react';
import { deriveStyle, deriveLyrics } from '../../catalog/catalogSearch';
import { addBlobsToChimera } from '../../lib/chimeraClient';
import { SlideTrack } from './SlideTrack';
import { FxRack } from './FxRack';
import { MetamorphPanel } from './MetamorphPanel';
import { MagentaToolStage } from './MagentaToolStage';
import { MAGENTA_TOOLS, magentaToolById, type MagentaTool } from '../../lib/magentaToolCatalog';
import { AutomationLane } from './AutomationLane';
import { RACK_EFFECTS, getRackEffect, buildEffectChain, ensureChopModule, teleportXYZ, SPATIAL_TELEPORT, type ChainHandle } from '../../lib/rackEffects';
import { sliceChunks } from '../../lib/audioAnalysis';
import { encodeWav } from '../../lib/wavEncode';
import type { AudioDragItem } from '../../lib/audioDnD';
import { useExternalDragStore } from '../../state/externalDragStore';
import { useEditorStore, computePeaks, sampleLane, type AudioClip, type EditorTrack, type SnapDivision, type AutomationTarget, type AutomationLane as AutomationLaneT, type TimelineMarker } from '../../state/editorStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useVstStore } from '../../state/vstStore';
import type { Vst3PluginInfo } from '../../lib/vstClient';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx, getMasterGain, usePlayerStore } from '../../state/playerStore';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { GM_NAMES, gmShortName } from '../../lib/gmInstruments';
import { useSoundfontStore, ensureSoundfontReady, isSoundfontActive, getActiveProgram } from '../../lib/soundfontEngine';
import { renderStepNotesToBlob } from '../../lib/midiSynth';
import { parseMidi } from '../../utils/midi';
import type { PianoNote } from '../../state/pianoRollStore';
import { LibraryMidiPicker } from './LibraryMidiPicker';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { logError, logInfo } from '../../state/logStore';
import { registerEditorPlayback, unregisterEditorPlayback } from '../../state/editorPlaybackBridge';
import * as liveMixer from '../../state/liveMixer';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';

const TRACK_HEADER_PX = 180;
const TRACK_HEIGHT = 104;
const DECODE_TIMEOUT_MS = 15000;

const formatTimecode = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${Math.floor(ms / 10).toString().padStart(2, '0')}`;
};

const isEditorTimelinePlaying = (): boolean => {
  const player = usePlayerStore.getState();
  return player.isPlaying && player.currentEntryId === 'editor-timeline';
};

// Preview routes through the shared engine context so the visualizer sees it too.

// --- WAV encoder for the offline mixdown output. ---

/**
 * Tiny silent WAV placeholder used when creating large MIDI clips. The real
 * bounced audio is rendered asynchronously after the editable MIDI clip appears,
 * so users are not stuck waiting on an OfflineAudioContext + peak extraction.
 */
const silentWavBlob = (): Blob => {
  const sampleRate = 44100;
  const channels = 1;
  const samples = Math.ceil(sampleRate * 0.1);
  const bytesPerSample = 2;
  const dataBytes = samples * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Blob([buffer], { type: 'audio/wav' });
};

/**
 * Decode an audio Blob, extract the portion [offsetSec, offsetSec+durationSec],
 * and return it as a fresh WAV Blob. Used so inpaint submissions always receive
 * exactly the visible clip region, with mask coords relative to its start.
 */
const cropAudioBlob = async (
  blob: Blob,
  offsetSec: number,
  durationSec: number,
): Promise<Blob> => {
  const arrayBuf = await blob.arrayBuffer();
  const tmpCtx = new AudioContext({ sampleRate: 44100 });
  try {
    const audioBuf = await tmpCtx.decodeAudioData(arrayBuf.slice(0));
    const safeOffset = Math.max(0, Math.min(offsetSec, audioBuf.duration - 0.001));
    const safeDur = Math.max(0.001, Math.min(durationSec, audioBuf.duration - safeOffset));
    const sr = 44100;
    const offline = new OfflineAudioContext(
      audioBuf.numberOfChannels,
      Math.ceil(safeDur * sr),
      sr,
    );
    const src = offline.createBufferSource();
    src.buffer = audioBuf;
    src.connect(offline.destination);
    src.start(0, safeOffset, safeDur);
    const rendered = await offline.startRendering();
    return encodeWav(rendered);
  } finally {
    tmpCtx.close().catch(() => {});
  }
};

/**
 * Draw a MIDI clip's notes inside the clip body (FL-style playlist preview).
 * X maps note time (relative to the clip's source offset) to pixels via `zoom`;
 * Y stacks pitches lowest-to-highest across the body. Velocity sets brightness.
 * Read-only — editing happens in the Piano Roll (double-click / context menu).
 */
const MidiClipNotes: React.FC<{ clip: AudioClip; zoom: number; selected: boolean }> = ({ clip, zoom, selected }) => {
  const notes = clip.sourcePianoRoll;
  if (!notes || notes.length === 0) return null;
  const bpm = clip.sourceBpm ?? 120;
  const stepSec = 60 / Math.max(40, bpm) / 4;
  const offset = clip.offsetIntoSource ?? 0;
  const clipDur = clip.durationSec;

  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    if (n.note < lo) lo = n.note;
    if (n.note > hi) hi = n.note;
  }
  if (!Number.isFinite(lo)) return null;
  // One row per semitone in the used range, with a little headroom top/bottom.
  lo -= 1;
  hi += 1;
  const rows = Math.max(1, hi - lo);
  const rowPct = 100 / (rows + 1);

  return (
    <div className="absolute inset-x-0 bottom-0 top-3.5 overflow-hidden pointer-events-none">
      {notes.map((n) => {
        const relStart = n.step * stepSec - offset;
        const relEnd = relStart + Math.max(1, n.length) * stepSec;
        if (relEnd <= 0 || relStart >= clipDur) return null; // outside the visible window
        const vStart = Math.max(0, relStart);
        const vEnd = Math.min(clipDur, relEnd);
        const x = vStart * zoom;
        const w = Math.max(1.5, (vEnd - vStart) * zoom);
        const topPct = (hi - n.note) * rowPct;
        const hPct = Math.max(rowPct - 0.5, 2);
        const vel = Math.max(1, Math.min(127, n.velocity));
        return (
          <div
            key={n.id}
            className="absolute rounded-[1px]"
            style={{
              left: x,
              width: w,
              top: `${topPct}%`,
              height: `${hPct}%`,
              backgroundColor: clip.color,
              opacity: (selected ? 0.6 : 0.42) + (vel / 127) * 0.4,
            }}
          />
        );
      })}
    </div>
  );
};

/**
 * Compact per-track instrument selector (channel-rack style). "Default" leaves
 * the track on the global Piano Roll instrument; picking a GM program assigns it
 * to the track, which makes its MIDI clips play that voice live on the timeline.
 */
const TrackInstrumentSelect: React.FC<{ track: EditorTrack }> = ({ track }) => {
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const globalProgram = useSoundfontStore((s) => s.activeProgram);
  const globalSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const value = track.instrumentProgram === undefined ? 'default' : String(track.instrumentProgram);
  const defaultLabel = globalSoundfont ? `Default (${gmShortName(globalProgram)})` : 'Default (Basic)';

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'default') {
      updateTrack(track.id, { instrumentProgram: undefined });
      return;
    }
    updateTrack(track.id, { instrumentProgram: Number(v) });
    void ensureSoundfontReady(); // warm worklet + soundfont while the user looks
  };

  return (
    <div className="flex items-center gap-1.5">
      <Piano className="w-2.5 h-2.5 text-emerald-400/70 shrink-0" />
      <label htmlFor={`editor-track-instrument-${track.id}`} className="sr-only">{`Track ${track.name} instrument`}</label>
      <select
        id={`editor-track-instrument-${track.id}`}
        name={`editor-track-instrument-${track.id}`}
        aria-label={`Track ${track.name} instrument`}
        value={value}
        onChange={onChange}
        className="flex-1 min-w-0 form-select px-1 py-0.5 text-[9px]"
        style={{ colorScheme: 'dark' }}
      >
        <option value="default">{defaultLabel}</option>
        {GM_NAMES.map((nm, i) => (
          <option key={nm} value={i}>{`${i + 1}. ${nm}`}</option>
        ))}
      </select>
    </div>
  );
};

/**
 * Per-clip instrument override. "Track default" leaves the clip on its track's
 * instrument (or the global one); picking a GM program assigns it to this clip
 * only, so its MIDI notes play that voice live regardless of the track default.
 */
const ClipInstrumentSelect: React.FC<{ clip: AudioClip }> = ({ clip }) => {
  const updateClip = useEditorStore((s) => s.updateClip);
  const track = useEditorStore((s) => s.tracks.find((t) => t.id === clip.trackId));
  const globalProgram = useSoundfontStore((s) => s.activeProgram);
  const globalSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const value = clip.instrumentProgram === undefined ? 'default' : String(clip.instrumentProgram);
  const effective = track?.instrumentProgram ?? (globalSoundfont ? globalProgram : undefined);
  const defaultLabel = effective === undefined ? 'Track default (Basic)' : `Track default (${gmShortName(effective)})`;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'default') {
      updateClip(clip.id, { instrumentProgram: undefined });
      return;
    }
    updateClip(clip.id, { instrumentProgram: Number(v) });
    void ensureSoundfontReady(); // warm worklet + soundfont while the user looks
  };

  return (
    <div className="flex items-center gap-1.5">
      <Piano className="w-3 h-3 text-emerald-400/70 shrink-0" />
      <label htmlFor={`editor-clip-instrument-${clip.id}`} className="sr-only">{`Clip ${clip.label} instrument`}</label>
      <select
        id={`editor-clip-instrument-${clip.id}`}
        name={`editor-clip-instrument-${clip.id}`}
        aria-label={`Clip ${clip.label} instrument`}
        value={value}
        onChange={onChange}
        className="flex-1 min-w-0 form-select px-1.5 py-1 text-[10px]"
        style={{ colorScheme: 'dark' }}
      >
        <option value="default">{defaultLabel}</option>
        {GM_NAMES.map((nm, i) => (
          <option key={nm} value={i}>{`${i + 1}. ${nm}`}</option>
        ))}
      </select>
    </div>
  );
};

interface PointerOp {
  kind: 'move' | 'resize-left' | 'resize-right' | 'ctrl-drag-pending';
  clipId: string;
  startPxX: number;
  startPxY: number;
  initialStartSec: number;
  initialDurationSec: number;
  initialOffsetIntoSource: number;
  initialTrackIndex: number;
  initialClips?: Array<{ id: string; startSec: number; trackIndex: number }>;
  dragItems?: AudioDragItem[];
}

const CTRL_DRAG_MOVE_THRESHOLD_PX = 4;

/** Tempo + pitch controls for the per-clip Time/Pitch popover. Tempo time-stretches
 *  (pitch preserved); pitch transposes in semitones (length preserved). */
const TimePitchControls: React.FC<{ busy: boolean; onApply: (tempo: number, semitones: number) => void }> = ({ busy, onApply }) => {
  const [tempo, setTempo] = useState(1);
  const [semitones, setSemitones] = useState(0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono text-zinc-500 w-14 shrink-0">Tempo</span>
        <SlideTrack value={tempo} min={0.25} max={4} step={0.01} defaultValue={1} ariaLabel="Tempo (time-stretch)" className="flex-1" onChange={setTempo} />
        <span className="text-[9px] font-mono text-zinc-400 w-12 shrink-0 text-right tabular-nums">{tempo.toFixed(2)}x</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono text-zinc-500 w-14 shrink-0">Pitch</span>
        <SlideTrack value={semitones} min={-12} max={12} step={1} defaultValue={0} ariaLabel="Pitch (semitones)" className="flex-1" onChange={(v) => setSemitones(Math.round(v))} />
        <span className="text-[9px] font-mono text-zinc-400 w-12 shrink-0 text-right tabular-nums">{semitones >= 0 ? '+' : ''}{semitones} st</span>
      </div>
      <p className="text-[8px] font-mono text-zinc-600 leading-relaxed">
        Tempo keeps pitch; pitch keeps length. Rendered on the backend and baked into the clip.
      </p>
      <button
        onClick={() => onApply(tempo, Math.round(semitones))}
        disabled={busy || (tempo === 1 && semitones === 0)}
        className="w-full py-1.5 rounded bg-purple-600/30 border border-purple-500/40 text-purple-200 text-[9px] font-black uppercase tracking-widest hover:bg-purple-600/50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
      >
        {busy ? 'Rendering…' : 'Apply'}
      </button>
    </div>
  );
};

/** A draggable-free timeline marker flag: click to seek, double-click to rename,
 *  Alt-click or right-click to delete. */
const MarkerFlag: React.FC<{
  marker: TimelineMarker; zoom: number;
  onSeek: () => void; onRename: (label: string) => void; onDelete: () => void;
}> = ({ marker, zoom, onSeek, onRename, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(marker.label);
  const commit = () => { onRename(draft.trim() || marker.label); setEditing(false); };
  return (
    <div className="absolute top-0 bottom-0 z-30" style={{ left: marker.t * zoom }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="absolute top-3.5 bottom-0 w-px bg-cyan-400/50 pointer-events-none" />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          aria-label="Marker name"
          className="absolute top-0 left-0 w-20 bg-zinc-900 border border-cyan-500/50 rounded px-1 text-[8px] font-mono text-cyan-100 outline-none"
        />
      ) : (
        <button
          onClick={(e) => { if (e.altKey) onDelete(); else onSeek(); }}
          onDoubleClick={() => { setDraft(marker.label); setEditing(true); }}
          onContextMenu={(e) => { e.preventDefault(); onDelete(); }}
          title={`${marker.label} — click to seek, double-click to rename, Alt or right-click to delete`}
          className="absolute top-0 left-0 flex items-center gap-0.5 px-1 h-3.5 bg-cyan-500/20 border border-cyan-400/40 rounded-br text-[8px] font-mono text-cyan-200 hover:bg-cyan-500/35 whitespace-nowrap max-w-24"
        >
          <Flag className="w-2 h-2 shrink-0" /> <span className="truncate">{marker.label}</span>
        </button>
      )}
    </div>
  );
};

export const WaveformEditor: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const tool = useEditorStore((s) => s.tool);
  const zoom = useEditorStore((s) => s.zoom);
  const playheadSec = useEditorStore((s) => s.playheadSec);
  const snap = useEditorStore((s) => s.snap);
  const setSelected = useEditorStore((s) => s.setSelected);
  const setTool = useEditorStore((s) => s.setTool);
  const setZoom = useEditorStore((s) => s.setZoom);
  const setSnap = useEditorStore((s) => s.setSnap);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const addTrack = useEditorStore((s) => s.addTrack);
  const removeTrack = useEditorStore((s) => s.removeTrack);
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const toggleSolo = useEditorStore((s) => s.toggleSolo);
  const updateClip = useEditorStore((s) => s.updateClip);
  const removeClip = useEditorStore((s) => s.removeClip);
  const splitClipAt = useEditorStore((s) => s.splitClipAt);
  const cachePeaks = useEditorStore((s) => s.cachePeaks);
  const addClipToTrack = useEditorStore((s) => s.addClipToTrack);
  const snapSec = useEditorStore((s) => s.snapSec);
  const getTotalDurationSec = useEditorStore((s) => s.getTotalDurationSec);
  const masterGain = usePlaybackStore((s) => (s.muted ? 0 : s.volume / 100));
  const inpaintSelection = useEditorStore((s) => s.inpaintSelection);
  const setInpaintSelection = useEditorStore((s) => s.setInpaintSelection);
  const clearInpaintSelection = useEditorStore((s) => s.clearInpaintSelection);
  const masterFxChain = useEditorStore((s) => s.masterFxChain);
  // Master VST3 chain (rendered/frozen, hosted via pedalboard) + scan list.
  const masterVstChain = useEditorStore((s) => s.masterVstChain);
  const addMasterVst = useEditorStore((s) => s.addMasterVst);
  const removeMasterVst = useEditorStore((s) => s.removeMasterVst);
  const reorderMasterVst = useEditorStore((s) => s.reorderMasterVst);
  const clearMasterVst = useEditorStore((s) => s.clearMasterVst);
  const previewMode = useEditorStore((s) => s.previewMode);
  const setPreviewMode = useEditorStore((s) => s.setPreviewMode);
  const frozenMaster = useEditorStore((s) => s.frozenMaster);
  const setFrozenMaster = useEditorStore((s) => s.setFrozenMaster);
  const vstPlugins = useVstStore((s) => s.plugins);
  const vstScanning = useVstStore((s) => s.scanning);
  const scanVst = useVstStore((s) => s.scan);
  const automationWrite = useEditorStore((s) => s.automationWrite);
  const setAutomationWrite = useEditorStore((s) => s.setAutomationWrite);
  const recordAutomationPoint = useEditorStore((s) => s.recordAutomationPoint);
  const automationLanes = useEditorStore((s) => s.automationLanes);
  const addAutomationPoint = useEditorStore((s) => s.addAutomationPoint);
  const updateAutomationPoint = useEditorStore((s) => s.updateAutomationPoint);
  const removeAutomationPoint = useEditorStore((s) => s.removeAutomationPoint);
  const toggleAutomationLane = useEditorStore((s) => s.toggleAutomationLane);
  const clearAutomationLane = useEditorStore((s) => s.clearAutomationLane);
  const removeAutomationLane = useEditorStore((s) => s.removeAutomationLane);
  const projectBpm = useEditorStore((s) => s.bpm);
  const loopEnabled = useEditorStore((s) => s.loopEnabled);
  const loopStart = useEditorStore((s) => s.loopStart);
  const loopEnd = useEditorStore((s) => s.loopEnd);
  const markers = useEditorStore((s) => s.markers);
  const setLoopEnabled = useEditorStore((s) => s.setLoopEnabled);
  const setLoopRegion = useEditorStore((s) => s.setLoopRegion);
  const clearLoop = useEditorStore((s) => s.clearLoop);
  const addMarker = useEditorStore((s) => s.addMarker);
  const removeMarker = useEditorStore((s) => s.removeMarker);
  const renameMarker = useEditorStore((s) => s.renameMarker);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s._undo.length > 0);
  const canRedo = useEditorStore((s) => s._redo.length > 0);
  // Automation edit mode: when on, the selected lane's curve becomes editable
  // (add / drag / delete breakpoints) and the lane panel is shown.
  const [automationEdit, setAutomationEdit] = useState(false);
  const [activeLaneId, setActiveLaneId] = useState<string | null>(null);

  // Move a track fader. While automation write is on and the transport is rolling,
  // the move records a breakpoint (timestamped off the audio clock) and is driven
  // onto the live param so it is heard as it is recorded.
  const writeFader = (kind: 'trackVolume' | 'trackPan', trackId: string, v: number) => {
    updateTrack(trackId, kind === 'trackVolume' ? { volume: v } : { pan: v });
    if (automationWrite && liveMixer.isPlaying()) {
      const target = { kind, trackId };
      recordAutomationPoint(target, liveMixer.currentTransportSec(), v);
      liveMixer.automationTouchNative(target, v);
    }
  };

  // Apply an FX param change, and while writing + playing, record each param key
  // that actually changed into its own lane (an OWL-Pad drag moves x and y at once,
  // so both are captured). Playback is driven by the FX lookahead writer.
  const writeFxParams = (
    scope: { kind: 'master' } | { kind: 'track'; trackId: string },
    entryId: string,
    p: Record<string, number>,
  ) => {
    const prev =
      scope.kind === 'master'
        ? masterFxChain.find((e) => e.id === entryId)?.params
        : tracks.find((t) => t.id === scope.trackId)?.fxChain?.find((e) => e.id === entryId)?.params;
    if (scope.kind === 'master') updateMasterEffectParams(entryId, p);
    else updateTrackEffectParams(scope.trackId, entryId, p);
    if (!automationWrite || !liveMixer.isPlaying() || !prev) return;
    const t = liveMixer.currentTransportSec();
    for (const key of Object.keys(p)) {
      if (prev[key] === p[key]) continue;
      const target: AutomationTarget =
        scope.kind === 'master'
          ? { kind: 'masterFx', entryId, paramKey: key }
          : { kind: 'trackFx', trackId: scope.trackId, entryId, paramKey: key };
      recordAutomationPoint(target, t, p[key]);
    }
  };
  const addMasterEffect = useEditorStore((s) => s.addMasterEffect);
  const removeMasterEffect = useEditorStore((s) => s.removeMasterEffect);
  const reorderMasterEffect = useEditorStore((s) => s.reorderMasterEffect);
  const toggleMasterEffect = useEditorStore((s) => s.toggleMasterEffect);
  const updateMasterEffectParams = useEditorStore((s) => s.updateMasterEffectParams);
  const addTrackEffect = useEditorStore((s) => s.addTrackEffect);
  const removeTrackEffect = useEditorStore((s) => s.removeTrackEffect);
  const reorderTrackEffect = useEditorStore((s) => s.reorderTrackEffect);
  const toggleTrackEffect = useEditorStore((s) => s.toggleTrackEffect);
  const updateTrackEffectParams = useEditorStore((s) => s.updateTrackEffectParams);
  // Footer player — the live engine mirrors its own playhead; we just read
  // entry id + playing state to drive the editor's local transport button.
  const playerEntryId = usePlayerStore((s) => s.currentEntryId);
  const playerIsPlaying = usePlayerStore((s) => s.isPlaying);
  // Derived: are we currently playing the editor's rendered timeline?
  const isEditorPlaying = playerIsPlaying && playerEntryId === 'editor-timeline';

  // Sampled FX-param overrides for a rack entry at the current playhead, so its
  // controls visually follow automation during playback (display only; edits still
  // write the stored params).
  const fxDisplayParams = useCallback(
    (scope: { kind: 'master' } | { kind: 'track'; trackId: string }, entryId: string): Record<string, number> | undefined => {
      if (!isEditorPlaying || automationWrite) return undefined; // read mode follows; write mode shows your hands
      const out: Record<string, number> = {};
      for (const lane of automationLanes) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const tgt = lane.target;
        if (!tgt.paramKey || tgt.entryId !== entryId) continue;
        if (scope.kind === 'master') {
          if (tgt.kind !== 'masterFx') continue;
        } else if (tgt.kind !== 'trackFx' || tgt.trackId !== scope.trackId) {
          continue;
        }
        const v = sampleLane(lane, playheadSec);
        if (v != null) out[tgt.paramKey] = v;
      }
      return Object.keys(out).length ? out : undefined;
    },
    [isEditorPlaying, automationWrite, automationLanes, playheadSec],
  );

  // Displayed value for a native (volume/pan) track fader: follows its lane during
  // playback, otherwise shows the stored value.
  const faderDisplay = (kind: 'trackVolume' | 'trackPan', trackId: string, stored: number): number => {
    if (!isEditorPlaying || automationWrite) return stored; // read mode follows; write mode shows your hands
    const lane = automationLanes.find(
      (l) => l.enabled && l.points.length > 0 && l.target.kind === kind && l.target.trackId === trackId,
    );
    if (!lane) return stored;
    const v = sampleLane(lane, playheadSec);
    return v == null ? stored : v;
  };

  // Color + value<->normalized mapping for a lane, used by both the overlay and the
  // breakpoint editor. Returns null when the lane's effect/param no longer exists.
  const laneVisual = (
    lane: AutomationLaneT,
  ): { color: string; toNorm: (v: number) => number; fromNorm: (n: number) => number } | null => {
    const c01 = (x: number) => Math.max(0, Math.min(1, x));
    const k = lane.target.kind;
    if (k === 'trackVolume') return { color: '#34d399', toNorm: (v) => c01(v), fromNorm: (n) => c01(n) };
    if (k === 'trackPan') return { color: '#60a5fa', toNorm: (v) => (Math.max(-1, Math.min(1, v)) + 1) / 2, fromNorm: (n) => c01(n) * 2 - 1 };
    const entry =
      k === 'trackFx'
        ? tracks.find((t) => t.id === lane.target.trackId)?.fxChain?.find((e) => e.id === lane.target.entryId)
        : masterFxChain.find((e) => e.id === lane.target.entryId);
    if (!entry) return null;
    const desc = getRackEffect(entry.effect)?.params.find((p) => p.key === lane.target.paramKey);
    if (!desc) return null;
    const span = Math.max(1e-6, desc.max - desc.min);
    return { color: '#f59e0b', toNorm: (v) => c01((v - desc.min) / span), fromNorm: (n) => desc.min + c01(n) * span };
  };

  // Human label for the lane panel.
  const laneLabel = (lane: AutomationLaneT): string => {
    const k = lane.target.kind;
    const trackName = tracks.find((t) => t.id === lane.target.trackId)?.name ?? 'Track';
    if (k === 'trackVolume') return `${trackName} · Volume`;
    if (k === 'trackPan') return `${trackName} · Pan`;
    const chain = k === 'trackFx' ? tracks.find((t) => t.id === lane.target.trackId)?.fxChain ?? [] : masterFxChain;
    const entry = chain.find((e) => e.id === lane.target.entryId);
    const effLabel = entry ? getRackEffect(entry.effect)?.label ?? entry.effect : '?';
    const paramLabel = entry ? getRackEffect(entry.effect)?.params.find((p) => p.key === lane.target.paramKey)?.label ?? lane.target.paramKey : lane.target.paramKey;
    return `${k === 'masterFx' ? 'Master' : trackName} · ${effLabel} ${paramLabel ?? ''}`.trim();
  };

  const MASTER_STRIP_H = 80;
  const masterLanes = automationLanes.filter((l) => l.target.kind === 'masterFx');

  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const trackHeaderScrollRef = useRef<HTMLDivElement>(null);
  const opRef = useRef<PointerOp | null>(null);
  const inpaintDragRef = useRef<{ clipId: string; anchorSec: number } | null>(null);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Playhead drag
  const playheadDragRef = useRef<{ startX: number; startSec: number; wasPlaying: boolean } | null>(null);
  // Fade handle drag
  const fadeDragRef = useRef<{ clipId: string; edge: 'in' | 'out'; startX: number; initialFade: number } | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [mixdownName, setMixdownName] = useState('');
  const [showMasterFx, setShowMasterFx] = useState(false);
  const [showMasterVst, setShowMasterVst] = useState(false);
  const [isFreezing, setIsFreezing] = useState(false);
  // Magenta RT2 generative tool open in the floating panel (Collider/Jam/MRT2), or null.
  const [magentaToolId, setMagentaToolId] = useState<string | null>(null);
  const magentaTool: MagentaTool | null = magentaToolId ? magentaToolById[magentaToolId] ?? null : null;
  const [showMetamorph, setShowMetamorph] = useState(false);
  const [fxPanelTrackId, setFxPanelTrackId] = useState<string | null>(null);
  const [instrPanel, setInstrPanel] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const instrPanelRef = useRef<HTMLDivElement>(null);
  // Outside-click / Escape dismiss the clip-instrument popover. Deferred a
  // macrotask so the context-menu click that opens it does not immediately
  // bubble to window and close it (same race the ContextMenu primitive handles).
  useEffect(() => {
    if (!instrPanel) return;
    const onDown = (e: MouseEvent) => {
      if (instrPanelRef.current?.contains(e.target as Node)) return;
      setInstrPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInstrPanel(null);
    };
    let attached = false;
    const attach = () => {
      attached = true;
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey);
    };
    const timer = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) {
        window.removeEventListener('mousedown', onDown);
        window.removeEventListener('keydown', onKey);
      }
    };
  }, [instrPanel]);

  // Time/Pitch popover (per-clip stretch + transpose, baked via the FFmpeg backend).
  const [timePitchPanel, setTimePitchPanel] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const timePitchRef = useRef<HTMLDivElement>(null);
  const [timePitchBusy, setTimePitchBusy] = useState(false);
  useEffect(() => {
    if (!timePitchPanel) return;
    const onDown = (e: MouseEvent) => {
      if (timePitchRef.current?.contains(e.target as Node)) return;
      setTimePitchPanel(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTimePitchPanel(null); };
    let attached = false;
    const attach = () => { attached = true; window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey); };
    const timer = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); }
    };
  }, [timePitchPanel]);

  // Render the clip's current region (offset..offset+duration) to a WAV File so the
  // backend stretches only what the clip actually plays, not the whole source.
  const extractRegionWav = useCallback(async (clip: AudioClip): Promise<File> => {
    const ac = new AudioContext({ sampleRate: 44100 });
    try {
      const ab = await clip.audioBlob.arrayBuffer();
      const buf = await ac.decodeAudioData(ab.slice(0));
      const sr = buf.sampleRate;
      const start = Math.max(0, Math.floor((clip.offsetIntoSource ?? 0) * sr));
      const len = Math.max(1, Math.min(buf.length - start, Math.ceil(clip.durationSec * sr)));
      const seg = ac.createBuffer(buf.numberOfChannels, len, sr);
      for (let ch = 0; ch < buf.numberOfChannels; ch += 1) {
        seg.copyToChannel(buf.getChannelData(ch).subarray(start, start + len), ch);
      }
      return new File([encodeWav(seg)], 'clip.wav', { type: 'audio/wav' });
    } finally {
      ac.close().catch(() => {});
    }
  }, []);

  // Time-stretch (tempo, pitch preserved) + transpose (semitones, tempo preserved)
  // through the FFmpeg backend (rubberband when available), then replace the clip's
  // audio with the result. tempo > 1 shortens the clip; pitch leaves length alone.
  const applyTimePitch = useCallback(async (clipId: string, tempo: number, semitones: number) => {
    const clip = useEditorStore.getState().clips.find((c) => c.id === clipId);
    if (!clip) return;
    setTimePitchBusy(true);
    try {
      const file = await extractRegionWav(clip);
      const fd = new FormData();
      fd.append('audio', file);
      fd.append('effect', 'time_pitch');
      fd.append('params', JSON.stringify({ tempo, semitones }));
      fd.append('output_format', 'wav');
      const res = await fetch('/api/studio/process', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`process ${res.status}`);
      // arrayBuffer (not res.blob) keeps the body in RAM — disk-backed blobs fail on a full drive.
      const blob = new Blob([await res.arrayBuffer()], { type: 'audio/wav' });
      const { peaks, duration } = await computePeaks(blob, 240);
      updateClip(clipId, {
        audioBlob: blob, mimeType: 'audio/wav', offsetIntoSource: 0, durationSec: duration, peaks,
      });
      logInfo('editor', `Time/Pitch: ${tempo.toFixed(2)}x, ${semitones >= 0 ? '+' : ''}${semitones} st -> ${duration.toFixed(2)}s`);
    } catch (e) {
      logError('editor', `Time/Pitch failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setTimePitchBusy(false);
    }
  }, [extractRegionWav, updateClip]);

  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);

  // --- Inpaint panel state ---
  type InpaintPhase =
    | { kind: 'params' }
    | { kind: 'generating'; jobId: string }
    | { kind: 'review'; blob: Blob; blobUrl: string };
  const [inpaintPanel, setInpaintPanel] = useState<InpaintPhase | null>(null);
  // When set, the LibraryMidiPicker is open; `sec` is the drop time, x/y anchor the panel.
  const [midiDrop, setMidiDrop] = useState<{ sec: number; x: number; y: number } | null>(null);
  const [inpaintPrompt, setInpaintPrompt] = useState('');
  const [inpaintSteps, setInpaintSteps] = useState(8);
  const [inpaintSeed, setInpaintSeed] = useState(-1);

  // Preload the chop worklet on the live engine context so a Chop insert builds
  // its real worklet node the first time playback starts (instead of one silent
  // passthrough play while the module loads).
  useEffect(() => {
    void ensureChopModule(getEngineCtx()).catch(() => {});
  }, []);

  // Undo / redo keyboard shortcuts, scoped to when the EDIT view is visible and not
  // typing in a field. Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      if (!containerRef.current?.offsetParent) return; // EDIT tab hidden -> ignore
      const tgt = e.target as HTMLElement | null;
      if (tgt?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Revoke the object URL when the review phase ends or the panel closes.
  useEffect(() => {
    return () => {
      if (inpaintPanel?.kind === 'review') URL.revokeObjectURL(inpaintPanel.blobUrl);
    };
  }, [inpaintPanel]);

  // Drive polling reactively: starts when phase is 'generating', stops on cleanup.
  useEffect(() => {
    if (inpaintPanel?.kind !== 'generating') return;
    const { jobId } = inpaintPanel;
    const intervalId = setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/jobs/${jobId}`);
          const job = await r.json() as { status: string; result?: { item?: { audio_base64: string; mime_type: string } }; error?: string };
          if (job.status === 'completed' && job.result?.item) {
            const { audio_base64, mime_type } = job.result.item;
            const bytes = atob(audio_base64);
            const arr = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
            const blob = new Blob([arr], { type: mime_type });
            setInpaintPanel({ kind: 'review', blob, blobUrl: URL.createObjectURL(blob) });
          } else if (job.status === 'failed') {
            logError('editor', `Inpaint job failed: ${job.error ?? 'unknown'}`);
            setInpaintPanel({ kind: 'params' });
          }
        } catch (e) {
          logError('editor', `Inpaint poll error: ${e instanceof Error ? e.message : e}`);
        }
      })();
    }, 1500);
    return () => clearInterval(intervalId);
  }, [inpaintPanel]);

  const openInpaintPanel = useCallback(() => {
    const sel = useEditorStore.getState().inpaintSelection;
    if (!sel) return;
    setInpaintPanel({ kind: 'params' });
  }, []);

  const submitInpaint = async () => {
    const sel = useEditorStore.getState().inpaintSelection;
    if (!sel) return;
    const clip = useEditorStore.getState().clips.find((c) => c.id === sel.clipId);
    if (!clip) return;

    // Always crop the audio to exactly the visible clip region before sending.
    // This guarantees mask coordinates are relative to the start of the audio
    // the model receives, regardless of offsetIntoSource (split/trim clips).
    let croppedAudio: Blob;
    try {
      croppedAudio = await cropAudioBlob(clip.audioBlob, clip.offsetIntoSource, clip.durationSec);
    } catch (e) {
      logError('editor', `Inpaint: failed to crop audio: ${e instanceof Error ? e.message : e}`);
      return;
    }

    // Mask coords are now relative to the start of the cropped (visible) audio.
    const maskStart = sel.startSec - clip.startSec;
    const maskEnd   = sel.endSec   - clip.startSec;

    const fd = new FormData();
    fd.append('prompt', inpaintPrompt);
    fd.append('steps', String(inpaintSteps));
    fd.append('seed', String(inpaintSeed));
    fd.append('cfg_scale', '1.0');
    fd.append('duration', String(clip.durationSec));
    fd.append('mask_start', String(Math.max(0, maskStart)));
    fd.append('mask_end', String(Math.min(clip.durationSec, maskEnd)));
    fd.append('inpaint_audio', new File([croppedAudio], 'inpaint.wav', { type: 'audio/wav' }));
    try {
      const res = await fetch('/api/generate-jobs', { method: 'POST', body: fd });
      if (!res.ok) {
        logError('editor', `Inpaint submit HTTP ${res.status}`);
        return;
      }
      const data = await res.json() as { job?: { id: string } };
      const jobId = data.job?.id;
      if (!jobId) {
        logError('editor', 'Inpaint submit: no job id in response');
        return;
      }
      setInpaintPanel({ kind: 'generating', jobId });
    } catch (e) {
      logError('editor', `Inpaint submit failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const acceptInpaint = (blob: Blob) => {
    const sel = useEditorStore.getState().inpaintSelection;
    if (!sel) return;
    updateClip(sel.clipId, { audioBlob: blob, mimeType: 'audio/wav', peaks: undefined });
    
    // Auto-save the accepted inpaint to the library (via the storage provider).
    void useLibraryStore.getState().importEntry({
      blob,
      filename: `inpaint_${inpaintPrompt.slice(0, 15) || 'result'}.wav`,
      mimeType: 'audio/wav',
      metadata: {
        title: `inpaint_${inpaintPrompt.slice(0, 15) || 'result'}.wav`,
        prompt: inpaintPrompt,
        model: 'inpaint',
        duration: sel.endSec - sel.startSec,
        steps: inpaintSteps,
        cfg: 1.0,
        seed: inpaintSeed,
        source: 'generate',
        tags: ['inpaint'],
      },
    }).catch((e) => logError('editor', `Inpaint library save failed: ${e}`));

    clearInpaintSelection();
    setInpaintPanel(null);
  };

  const rejectInpaint = () => setInpaintPanel(null);

  const totalDuration = getTotalDurationSec();
  const timelineWidthPx = Math.max(totalDuration * zoom, 1000);

  const trackById = useMemo(
    () => new Map(tracks.map((t) => [t.id, t] as const)),
    [tracks],
  );
  const selectedClipIdSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);

  const selectedClipCount = selectedClipIds.length || (selectedClipId ? 1 : 0);

  useEffect(() => {
    setSelectedClipIds((prev) => prev.filter((id) => clips.some((clip) => clip.id === id)));
    setSelectedTrackIds((prev) => prev.filter((id) => tracks.some((track) => track.id === id)));
  }, [clips, tracks]);

  const deleteSelectedClips = useCallback(() => {
    const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    if (ids.length === 0) return;
    ids.forEach((id) => removeClip(id));
    setSelectedClipIds([]);
    setSelectedTrackIds([]);
    setSelected(null);
  }, [removeClip, selectedClipId, selectedClipIds, setSelected]);

  const duplicateSelectedClips = useCallback(() => {
    const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    if (ids.length === 0) return;
    const selected = clips.filter((c) => ids.includes(c.id));
    const newIds = selected.map((clip) => addClipToTrack({
      ...clip,
      startSec: clip.startSec + clip.durationSec,
    }));
    setSelectedClipIds(newIds);
    setSelectedTrackIds([]);
    setSelected(newIds[0] ?? null);
    logInfo('editor', `Duplicated ${newIds.length} clip${newIds.length === 1 ? '' : 's'}`);
  }, [addClipToTrack, clips, selectedClipId, selectedClipIds, setSelected]);

  const selectClipSingle = useCallback((clipId: string | null) => {
    setSelectedClipIds(clipId ? [clipId] : []);
    setSelectedTrackIds([]);
    setSelected(clipId);
  }, [setSelected]);

  const selectTrackSingle = useCallback((trackId: string | null) => {
    setSelectedTrackIds(trackId ? [trackId] : []);
    setSelectedClipIds([]);
    setSelected(null);
  }, [setSelected]);

  const toggleTrackSelection = useCallback((trackId: string) => {
    setSelectedTrackIds((prev) => (
      prev.includes(trackId) ? prev.filter((id) => id !== trackId) : [...prev, trackId]
    ));
    setSelectedClipIds([]);
    setSelected(null);
  }, [setSelected]);

  const selectTrackWithModifiers = useCallback((trackId: string, e?: { metaKey?: boolean; ctrlKey?: boolean }) => {
    if (e?.metaKey || e?.ctrlKey) toggleTrackSelection(trackId);
    else selectTrackSingle(trackId);
  }, [selectTrackSingle, toggleTrackSelection]);

  const selectClipWithModifiers = useCallback((clipId: string, e?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
    const additive = !!(e?.metaKey || e?.ctrlKey);
    const range = !!e?.shiftKey;

    if (range && selectedClipId) {
      const orderedIds = [...clips].sort((a, b) => a.startSec - b.startSec).map((c) => c.id);
      const a = orderedIds.indexOf(selectedClipId);
      const b = orderedIds.indexOf(clipId);
      if (a >= 0 && b >= 0) {
        const [start, end] = a < b ? [a, b] : [b, a];
        const rangeIds = orderedIds.slice(start, end + 1);
        setSelectedClipIds((prev) => (additive ? Array.from(new Set([...prev, ...rangeIds])) : rangeIds));
        setSelectedTrackIds([]);
        setSelected(clipId);
        return;
      }
    }

    if (additive) {
      setSelectedClipIds((prev) => (
        prev.includes(clipId) ? prev.filter((id) => id !== clipId) : [...prev, clipId]
      ));
      setSelectedTrackIds([]);
      setSelected(clipId);
      return;
    }

    selectClipSingle(clipId);
  }, [clips, selectedClipId, selectClipSingle, setSelected]);

  const getSelectionForInit = useCallback((): AudioClip[] => {
    if (selectedClipIds.length > 0) return clips.filter((c) => selectedClipIds.includes(c.id));
    if (selectedTrackIds.length > 0) return clips.filter((c) => selectedTrackIds.includes(c.trackId));
    if (selectedClipId) {
      const clip = clips.find((c) => c.id === selectedClipId);
      return clip ? [clip] : [];
    }
    return [];
  }, [clips, selectedClipIds, selectedTrackIds, selectedClipId]);

  const sendSelectionToInit = useCallback(async () => {
    const selection = getSelectionForInit();
    if (selection.length === 0) {
      logError('editor', 'Select at least one clip or track first.');
      return;
    }
    setIsRendering(true);
    try {
      const sr = 44100;
      const totalDur = Math.max(...selection.map((c) => c.startSec + c.durationSec), 1);
      const offline = new OfflineAudioContext(2, Math.ceil(totalDur * sr), sr);
      const blobCache = new Map<Blob, AudioBuffer>();
      const decodeCtx = new AudioContext({ sampleRate: 44100 });
      try {
        for (const clip of selection) {
          if (blobCache.has(clip.audioBlob)) continue;
          const ab = await clip.audioBlob.arrayBuffer();
          const decoded = await Promise.race([
            decodeCtx.decodeAudioData(ab.slice(0)),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS)),
          ]);
          blobCache.set(clip.audioBlob, decoded);
        }
      } finally {
        decodeCtx.close().catch(() => {});
      }

      for (const clip of selection) {
        const track = trackById.get(clip.trackId);
        if (!track || track.mute) continue;
        const buf = blobCache.get(clip.audioBlob);
        if (!buf) continue;
        const src = offline.createBufferSource();
        src.buffer = buf;
        const gain = offline.createGain();
        const panner = offline.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, track.pan));
        src.connect(gain).connect(panner).connect(offline.destination);

        const vol = track.volume;
        const fadeIn = clip.fadeInSec ?? 0;
        const fadeOut = clip.fadeOutSec ?? 0;
        const safeOffset = Math.min(clip.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const safeDur = Math.min(clip.durationSec, buf.duration - safeOffset);
        if (safeDur <= 0) continue;
        gain.gain.setValueAtTime(fadeIn > 0 ? 0 : vol, clip.startSec);
        if (fadeIn > 0) gain.gain.linearRampToValueAtTime(vol, clip.startSec + Math.min(fadeIn, safeDur));
        if (fadeOut > 0) {
          const foStart = clip.startSec + safeDur - Math.min(fadeOut, safeDur);
          gain.gain.setValueAtTime(vol, foStart);
          gain.gain.linearRampToValueAtTime(0, clip.startSec + safeDur);
        }
        src.start(clip.startSec, safeOffset, safeDur);
      }

      const rendered = await offline.startRendering();
      const blob = encodeWav(rendered);
      const clipLabels = selection.map((c) => c.label);
      const mixDur = rendered.duration;
      const fileName = selection.length === 1
        ? `editor-clip-${Date.now()}.wav`
        : `editor-mashup-${selection.length}clips-${Date.now()}.wav`;
      const file = new File([blob], fileName, { type: 'audio/wav' });
      const summary = selection.length === 1
        ? `Editor clip · ${mixDur.toFixed(2)}s`
        : `Editor mashup · ${selection.length} clips · ${mixDur.toFixed(2)}s`;
      useGenerateParamsStore.getState().patch({
        initAudioFile: file,
        initAudioEnabled: true,
        initAudioSourceLabel: summary,
        initAudioSourceClipLabels: clipLabels,
      });
      logInfo('editor', `Selection mashup sent to Init (${selection.length} clip${selection.length === 1 ? '' : 's'}, ${mixDur.toFixed(2)}s).`);
      onSwitchTab?.('create');
    } catch (e) {
      logError('editor', `Send to Init failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsRendering(false);
    }
  }, [getSelectionForInit, onSwitchTab, trackById]);

  const handleTrackHeaderPointerDown = useCallback((e: React.PointerEvent, trackId: string) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, button, select, textarea')) return;
    selectTrackWithModifiers(trackId, e);
  }, [selectTrackWithModifiers]);

  // Decode + cache peaks for any clip that doesn't have them yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const c of clips) {
        if (c.peaks || cancelled) continue;
        try {
          const { peaks } = await computePeaks(c.audioBlob, 240);
          if (!cancelled) cachePeaks(c.id, peaks);
        } catch (e) {
          if (!cancelled) {
            logError('editor', `Peak decode failed for ${c.label}: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [clips, cachePeaks]);


  const stopPreview = useCallback(() => {
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop(); } catch { /* ignore */ }
      previewSourceRef.current = null;
    }
  }, []);

  // --- Multi-track timeline playback (routes through the footer's playerStore) ---

  const stopEditorPlayback = useCallback(() => {
    liveMixer.stop();
    stopPreview();
  }, [stopPreview]);

  const playEditorTimeline = useCallback(async () => {
    if (clips.length === 0) return;
    stopPreview();
    setIsRendering(true);
    try {
      // Live multi-track playback — per-track volume / pan / mute / solo are
      // audible MID-playback (see state/liveMixer). The offline bounce is kept
      // for export (commitEdit / sendSelectionToInit), not for preview.
      await liveMixer.playAsync();
    } catch (e) {
      logError('editor', `Live playback failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsRendering(false);
    }
  }, [clips.length, stopPreview]);

  // Register with bridge so PlayerFooter can trigger a fresh render+play, AND
  // register liveMixer as the footer's transport so its normal play/pause/seek
  // buttons drive the live multi-track engine. liveMixer.attach() returns a
  // disposer that stops playback + detaches on unmount.
  useEffect(() => {
    registerEditorPlayback(
      () => void playEditorTimeline(),
      stopEditorPlayback,
    );
    const detach = liveMixer.attach();
    return () => {
      unregisterEditorPlayback();
      detach();
    };
  }, [playEditorTimeline, stopEditorPlayback]);

  // liveMixer already mirrors its playhead into editorStore.playheadSec, so no
  // footer→playhead bridging is needed for the live engine. (The offline path
  // for export doesn't drive the playhead.)

  // Preview playback of the selected clip.
  const playSelectedPreview = useCallback(async () => {
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) {
      logError('editor', 'Nothing selected to preview');
      return;
    }
    stopPreview();
    try {
      const ctx = getEngineCtx();
      if (ctx.state === 'suspended') void ctx.resume();
      const buf = await clip.audioBlob.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(buf.slice(0));
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      const gain = ctx.createGain();
      gain.gain.value = masterGain;
      // Route through the shared master → analyser → destination chain.
      src.connect(gain).connect(getMasterGain());
      src.onended = () => {
        if (previewSourceRef.current === src) previewSourceRef.current = null;
      };
      previewSourceRef.current = src;
      src.start(0, clip.offsetIntoSource, clip.durationSec);
      logInfo('editor', `Previewing: ${clip.label} (${clip.durationSec.toFixed(2)}s)`);
    } catch (e) {
      logError('editor', `Preview failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [clips, selectedClipId, masterGain, stopPreview]);

  // --- Keyboard hotkeys ---
  // v        = move tool
  // c        = cut tool
  // Space    = play preview / stop preview
  // Delete   = remove selected clip
  // Ctrl/Cmd+D = duplicate selected clip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // No modifier hotkeys.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'v' || e.key === 'V') {
          e.preventDefault();
          setTool('move');
          return;
        }
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          setTool('cut');
          return;
        }
        if (e.key === ' ') {
          e.preventDefault();
          if (isEditorTimelinePlaying()) stopEditorPlayback();
          else void playEditorTimeline();
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectedClipCount > 0) {
            e.preventDefault();
            deleteSelectedClips();
          }
          return;
        }
        if (e.key === 'Escape') {
          clearInpaintSelection();
          return;
        }
      }
      // Ctrl/Cmd + D = duplicate selected clip.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        duplicateSelectedClips();
      }
      // Ctrl/Cmd + P = inpaint selected region.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        openInpaintPanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipCount, setTool, stopEditorPlayback, playEditorTimeline, deleteSelectedClips, duplicateSelectedClips, openInpaintPanel, clearInpaintSelection]);

  // --- Wheel: Ctrl/Cmd + wheel = zoom; plain wheel = horizontal pan ---
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Zoom centered on cursor X.
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left + el.scrollLeft;
        const oldZoom = useEditorStore.getState().zoom;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const newZoom = Math.max(5, Math.min(400, oldZoom * factor));
        useEditorStore.getState().setZoom(newZoom);
        // Keep the cursor on the same time after zoom.
        const ratio = newZoom / oldZoom;
        el.scrollLeft = cursorX * ratio - (e.clientX - rect.left);
        return;
      }
      // Shift + wheel — convert vertical delta to horizontal scroll. Plain wheel remains vertical.
      if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- Right-click context menu (uses shared ContextMenu primitive) ---
  const clipMenu = useContextMenu<{ clipId: string; atSec: number }>();
  const trackMenu = useContextMenu<{ trackId: string }>();

  const openContextMenu = (e: React.MouseEvent, clipId: string) => {
    e.stopPropagation();
    if (!selectedClipIds.includes(clipId)) {
      selectClipSingle(clipId);
    }
    const atSec = timelineClientXToSec(e.clientX);
    clipMenu.open(e, { clipId, atSec });
  };

  // OfflineAudioContext mixdown. With { silent: true } it renders and RETURNS the
  // master WAV without saving to the library or downloading — the VST freeze path
  // reuses this so the frozen master matches the export exactly.
  const commitEdit = useCallback(async (opts?: { silent?: boolean }): Promise<Blob | null> => {
    if (clips.length === 0) {
      logError('editor', 'No clips to commit');
      return null;
    }
    setIsCommitting(true);
    const start = performance.now();
    logInfo('editor', `Mixing ${clips.length} clips on ${tracks.length} tracks…`);
    try {
      const dur = getTotalDurationSec();
      const sr = 44100;
      const offline = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
      const anySolo = tracks.some((t) => t.solo);
      // Decode with a regular AudioContext — more reliable than OfflineAudioContext.decodeAudioData.
      const blobCache = new Map<Blob, AudioBuffer>();
      const decodeCtx = new AudioContext({ sampleRate: 44100 });
      try {
        for (const c of clips) {
          if (!blobCache.has(c.audioBlob)) {
            const ab = await c.audioBlob.arrayBuffer();
            const decoded = await Promise.race([
              decodeCtx.decodeAudioData(ab.slice(0)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS),
              ),
            ]);
            blobCache.set(c.audioBlob, decoded);
          }
        }
      } finally {
        decodeCtx.close().catch(() => {});
      }
      // If any enabled insert chain uses the chop worklet, register it on the
      // offline context first so the bounce builds the real node (the factory
      // would otherwise fall back to passthrough and the chop would not bake in).
      const usesChop = [masterFxChain, ...tracks.map((t) => t.fxChain ?? [])]
        .some((ch) => ch.some((e) => e.effect === 'chop' && e.enabled));
      if (usesChop) {
        try { await ensureChopModule(offline); } catch { /* falls back to passthrough */ }
      }

      // Master bus + insert rack -> destination, mirroring liveMixer's routing so
      // the bounce carries the SAME psychoacoustic FX the user hears in preview.
      const masterBus = offline.createGain();
      const masterFx = buildEffectChain(offline, masterBus, offline.destination, masterFxChain);

      // Automation (Phase E5): bake the recorded lanes into the offline render. The
      // offline context renders from t=0, so a breakpoint's timeline time IS its
      // offline time. Native vol/pan ride an AudioParam timeline; FX params step at
      // each breakpoint via suspend/resume (no real-time loop runs offline).
      const lanes = useEditorStore.getState().automationLanes.filter((l) => l.enabled && l.points.length > 0);
      const scheduleParamLane = (param: AudioParam, lane: AutomationLaneT, clampFn: (v: number) => number) => {
        const pts = lane.points;
        param.setValueAtTime(clampFn(pts[0].v), 0);
        if (pts[0].t > 0) param.setValueAtTime(clampFn(pts[0].v), pts[0].t); // hold first value, then ramp
        for (let i = 1; i < pts.length; i += 1) {
          param.linearRampToValueAtTime(clampFn(pts[i].v), Math.max(pts[i].t, pts[i - 1].t + 1e-4));
        }
      };

      // One gain + insert chain + panner per audible track; panners feed the bus.
      const trackNodeById = new Map<string, { gain: GainNode; panner: StereoPannerNode; fx: ChainHandle }>();
      for (const track of tracks) {
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        const tgain = offline.createGain();
        const volLane = lanes.find((l) => l.target.kind === 'trackVolume' && l.target.trackId === track.id);
        if (volLane) scheduleParamLane(tgain.gain, volLane, (v) => Math.max(0, v));
        else tgain.gain.value = track.volume;
        const panner = offline.createStereoPanner();
        const panLane = lanes.find((l) => l.target.kind === 'trackPan' && l.target.trackId === track.id);
        if (panLane) scheduleParamLane(panner.pan, panLane, (v) => Math.max(-1, Math.min(1, v)));
        else panner.pan.value = Math.max(-1, Math.min(1, track.pan));
        const fx = buildEffectChain(offline, tgain, panner, track.fxChain ?? []); // tgain -> [fx] -> panner
        panner.connect(masterBus);
        trackNodeById.set(track.id, { gain: tgain, panner, fx });
      }

      for (const c of clips) {
        const tn = trackNodeById.get(c.trackId);
        if (!tn) continue; // track muted or hidden by an active solo
        const buf = blobCache.get(c.audioBlob);
        if (!buf) continue;
        const safeOffset = Math.min(c.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const safeDur = Math.min(c.durationSec, buf.duration - safeOffset);
        if (safeDur <= 0) continue;

        // Per-clip gain carries ONLY the fade envelope (peak 1). Track volume lives
        // on the track gain so per-track FX process the post-fade signal exactly as
        // they do live.
        const src = offline.createBufferSource();
        src.buffer = buf;
        const clipGain = offline.createGain();
        const fadeIn = c.fadeInSec ?? 0;
        const fadeOut = c.fadeOutSec ?? 0;
        clipGain.gain.setValueAtTime(fadeIn > 0 ? 0 : 1, c.startSec);
        if (fadeIn > 0) {
          clipGain.gain.linearRampToValueAtTime(1, c.startSec + Math.min(fadeIn, safeDur));
        }
        if (fadeOut > 0) {
          const foStart = c.startSec + safeDur - Math.min(fadeOut, safeDur);
          clipGain.gain.setValueAtTime(1, foStart);
          clipGain.gain.linearRampToValueAtTime(0, c.startSec + safeDur);
        }
        src.connect(clipGain).connect(tn.gain);
        src.start(c.startSec, safeOffset, safeDur);
      }

      // Spatializer Teleport: schedule the same onset-driven panner jumps the live
      // preview makes, so the bounce matches. The offline ctx renders from t=0, so
      // each event's `when` is simply its timeline time.
      const chunkCache = new Map<Blob, ReturnType<typeof sliceChunks>>();
      for (const track of tracks) {
        const tn = trackNodeById.get(track.id);
        if (!tn) continue;
        const teleEntries = (track.fxChain ?? []).filter(
          (e) => e.enabled && e.effect === 'spatializer' && Math.round(e.params?.motion ?? 0) === SPATIAL_TELEPORT,
        );
        if (teleEntries.length === 0) continue;
        const insts = tn.fx.instances();
        const trackClips = clips.filter((c) => c.trackId === track.id);
        for (const entry of teleEntries) {
          const li = insts.find((x) => x.id === entry.id);
          if (!li?.inst.scheduleTeleport) continue;
          const spread = entry.params?.motionDepth ?? 5;
          const events: { when: number; x: number; y: number; z: number }[] = [];
          let idx = 0;
          for (const c of trackClips) {
            const buf = blobCache.get(c.audioBlob);
            if (!buf) continue;
            const offset = Math.min(c.offsetIntoSource, Math.max(0, buf.duration - 0.01));
            const cdur = Math.min(c.durationSec, buf.duration - offset);
            if (cdur <= 0) continue;
            let chunks = chunkCache.get(c.audioBlob);
            if (!chunks) { chunks = sliceChunks(buf); chunkCache.set(c.audioBlob, chunks); }
            for (const chunk of chunks) {
              if (chunk.tSec < offset || chunk.tSec >= offset + cdur) continue;
              const pos = teleportXYZ(idx, chunk.loudness, chunk.brightness, spread);
              events.push({ when: c.startSec + (chunk.tSec - offset), x: pos.x, y: pos.y, z: pos.z });
              idx += 1;
            }
          }
          if (events.length > 0) {
            events.sort((a, b) => a.when - b.when);
            li.inst.scheduleTeleport(events);
          }
        }
      }

      // FX-param automation bake: group the FX lanes by their effect entry, then
      // step the params at each breakpoint via suspend/resume (the live lookahead
      // writer does not run offline). Native vol/pan were already scheduled above.
      const fxTargets: { handle: ChainHandle; entryId: string; baseParams: Record<string, number>; lanes: AutomationLaneT[] }[] = [];
      const groupFx = (
        kind: 'trackFx' | 'masterFx',
        handle: ChainHandle,
        chain: { id: string; enabled: boolean; params: Record<string, number> }[],
        trackId?: string,
      ) => {
        for (const entry of chain) {
          if (!entry.enabled) continue;
          const entryLanes = lanes.filter(
            (l) => l.target.kind === kind && l.target.entryId === entry.id && (kind === 'masterFx' || l.target.trackId === trackId),
          );
          if (entryLanes.length > 0) fxTargets.push({ handle, entryId: entry.id, baseParams: entry.params, lanes: entryLanes });
        }
      };
      groupFx('masterFx', masterFx, masterFxChain);
      for (const track of tracks) {
        const tn = trackNodeById.get(track.id);
        if (!tn) continue;
        groupFx('trackFx', tn.fx, track.fxChain ?? [], track.id);
      }

      if (fxTargets.length > 0) {
        const applyFxAt = (t: number) => {
          for (const tgt of fxTargets) {
            const merged: Record<string, number> = { ...tgt.baseParams };
            for (const lane of tgt.lanes) {
              const v = sampleLane(lane, t);
              if (v != null && lane.target.paramKey) merged[lane.target.paramKey] = v;
            }
            tgt.handle.updateParams(tgt.entryId, merged);
          }
        };
        applyFxAt(0); // initial state at the top of the render
        // Union of breakpoint times, quantized to the render quantum, in (0, dur).
        const q = 128 / sr;
        const times = new Set<number>();
        for (const tgt of fxTargets) {
          for (const lane of tgt.lanes) {
            for (const p of lane.points) {
              if (p.t <= 0 || p.t >= dur) continue;
              times.add(Math.min(dur - q, Math.ceil(p.t / q) * q));
            }
          }
        }
        for (const tq of [...times].sort((a, b) => a - b)) {
          if (tq <= 0 || tq >= dur) continue;
          offline.suspend(tq).then(() => { applyFxAt(tq); offline.resume(); }).catch(() => {});
        }
      }

      const rendered = await offline.startRendering();
      const wavBlob = encodeWav(rendered);
      // Freeze path: hand the rendered master back to the caller (it post-processes
      // through the VST chain and caches it) without saving/downloading.
      if (opts?.silent) {
        return wavBlob;
      }
      const id = `mix-${Date.now()}`;
      const trimmedName = mixdownName.trim();
      const title = trimmedName
        ? (trimmedName.endsWith('.wav') ? trimmedName : `${trimmedName}.wav`)
        : `mixdown_${id.slice(-6)}.wav`;
      await useLibraryStore.getState().importEntry({
        blob: wavBlob,
        filename: title,
        mimeType: 'audio/wav',
        metadata: {
          title,
          prompt: `Editor mixdown of ${clips.length} clips`,
          model: 'editor-mixdown',
          duration: rendered.duration,
          source: 'studio',
          tags: ['mixdown'],
        },
      });
      // Also trigger an immediate browser download so the file lands on disk.
      const dlUrl = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = title;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(dlUrl), 10000);

      const ms = (performance.now() - start).toFixed(0);
      logInfo('editor', `Mixdown complete: ${rendered.duration.toFixed(2)}s rendered in ${ms}ms → library + download`);
      return wavBlob;
    } catch (e) {
      logError('editor', `Mixdown failed: ${e instanceof Error ? e.message : e}`);
      return null;
    } finally {
      setIsCommitting(false);
    }
  }, [clips, tracks, getTotalDurationSec, mixdownName, masterFxChain]);

  // --- Master VST freeze (render-on-change) ----------------------------------
  const editorBpm = useEditorStore((s) => s.bpm);
  // Populate the VST3 browser on first mount (cached scan — cheap).
  useEffect(() => { void scanVst(false); }, [scanVst]);

  // Signature of everything that affects the rendered master, so a frozen render
  // can be flagged stale after edits (and re-renders are skipped when unchanged).
  const freezeSig = useMemo(() => {
    const clipPart = clips
      .map((c) => `${c.id}:${c.trackId}:${c.startSec}:${c.durationSec}:${c.offsetIntoSource}:${c.fadeInSec ?? 0}:${c.fadeOutSec ?? 0}:${c.audioBlob.size}`)
      .join('|');
    const trackPart = tracks
      .map((t) => `${t.id}:${t.volume}:${t.pan}:${t.mute}:${t.solo}:${JSON.stringify(t.fxChain ?? [])}`)
      .join('|');
    return [clipPart, trackPart, JSON.stringify(masterFxChain), JSON.stringify(masterVstChain), editorBpm].join('::');
  }, [clips, tracks, masterFxChain, masterVstChain, editorBpm]);

  const frozenStale = !frozenMaster || frozenMaster.sig !== freezeSig;

  // Render the master mix (silent commit), then post-process it through each
  // enabled master VST on the backend (one /process-file call per node, in series).
  const renderFrozenMaster = useCallback(async (): Promise<Blob | null> => {
    const vsts = useEditorStore.getState().masterVstChain.filter((e) => e.enabled && e.vst);
    if (vsts.length === 0) {
      logError('editor', 'Add a master VST before rendering.');
      return null;
    }
    if (clips.length === 0) {
      logError('editor', 'No clips to render.');
      return null;
    }
    setIsFreezing(true);
    try {
      const base = await commitEdit({ silent: true });
      if (!base) return null;
      let current = new File([base], 'edit-master.wav', { type: 'audio/wav' });
      for (const node of vsts) {
        const form = new FormData();
        form.append('audio', current);
        form.append('plugin_path', node.vst!.plugin_path);
        form.append('params', '{}');
        const res = await fetch('/api/vst/process-file', { method: 'POST', body: form });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const j = (await res.json()) as { detail?: string };
            if (j.detail) detail = j.detail;
          } catch { /* non-JSON */ }
          throw new Error(detail);
        }
        const blob = await res.blob();
        current = new File([blob], 'edit-master.wav', { type: 'audio/wav' });
      }
      setFrozenMaster({ blob: current, sig: freezeSig });
      logInfo('editor', `VST freeze rendered through ${vsts.length} plugin(s).`);
      return current;
    } catch (e) {
      logError('editor', `VST freeze failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      setIsFreezing(false);
    }
  }, [clips.length, commitEdit, setFrozenMaster, freezeSig]);

  // Play the live multitrack mix again (re-arm liveMixer as the transport).
  const enterLiveMode = useCallback(() => {
    usePlayerStore.getState().stop();
    liveMixer.reactivate();
    setPreviewMode('live');
  }, [setPreviewMode]);

  // Switch to the frozen VST master; render first when stale/absent.
  const enterFrozenMode = useCallback(async () => {
    usePlayerStore.getState().stop();
    let fm = useEditorStore.getState().frozenMaster;
    if (!fm || fm.sig !== freezeSig) {
      const blob = await renderFrozenMaster();
      if (!blob) return; // failed — stay in the current mode
      fm = useEditorStore.getState().frozenMaster;
    }
    if (!fm) return;
    await usePlayerStore.getState().load(fm.blob, { label: 'EDIT · frozen VST master' });
    setPreviewMode('frozen');
  }, [freezeSig, renderFrozenMaster, setPreviewMode]);

  // Re-render the frozen master in place (used by the "stale" button).
  const reRenderFrozen = useCallback(async () => {
    const blob = await renderFrozenMaster();
    if (blob && useEditorStore.getState().previewMode === 'frozen') {
      await usePlayerStore.getState().load(blob, { label: 'EDIT · frozen VST master' });
    }
  }, [renderFrozenMaster]);

  // --- Pointer math helpers. ---
  const pxToSec = useCallback((px: number) => px / zoom, [zoom]);
  const timelineClientXToSec = useCallback((clientX: number): number => {
    const scroller = timelineScrollRef.current;
    const timeline = timelineRef.current;
    const rect = (scroller ?? timeline)?.getBoundingClientRect();
    if (!rect) return 0;
    return pxToSec(clientX - rect.left + (scroller?.scrollLeft ?? 0));
  }, [pxToSec]);

  // --- Inpaint drag handlers ---
  const handleInpaintDragStart = (e: React.PointerEvent, clip: AudioClip) => {
    if (tool === 'cut') return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const anchorSec = timelineClientXToSec(e.clientX);
    inpaintDragRef.current = { clipId: clip.id, anchorSec };
  };

  const handleInpaintDragMove = (e: React.PointerEvent) => {
    if (!inpaintDragRef.current) return;
    const { clipId, anchorSec } = inpaintDragRef.current;
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    const curSec = timelineClientXToSec(e.clientX);
    const clampedStart = Math.max(clip.startSec, Math.min(anchorSec, curSec));
    const clampedEnd   = Math.min(clip.startSec + clip.durationSec, Math.max(anchorSec, curSec));
    if (clampedEnd - clampedStart >= 0.1) {
      setInpaintSelection({ clipId, startSec: clampedStart, endSec: clampedEnd });
    }
  };

  const handleInpaintDragEnd = () => {
    const sel = useEditorStore.getState().inpaintSelection;
    if (sel && sel.endSec - sel.startSec < 0.1) {
      clearInpaintSelection();
    }
    inpaintDragRef.current = null;
  };

  const onClipPointerDown = (e: React.PointerEvent, clipId: string, edge: 'move' | 'left' | 'right') => {
    e.stopPropagation();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    if (edge === 'move' && (e.ctrlKey || e.metaKey)) {
      const ids = selectedClipIds.includes(clipId) ? selectedClipIds : [clipId];
      const dragItems: AudioDragItem[] = ids
        .map((id) => clips.find((c) => c.id === id))
        .filter((c): c is AudioClip => !!c)
        .map((c) => ({
          blob: c.audioBlob,
          mimeType: c.mimeType,
          label: c.label,
        }));
      opRef.current = {
        kind: 'ctrl-drag-pending',
        clipId,
        startPxX: e.clientX,
        startPxY: e.clientY,
        initialStartSec: clip.startSec,
        initialDurationSec: clip.durationSec,
        initialOffsetIntoSource: clip.offsetIntoSource,
        initialTrackIndex: Math.max(0, tracks.findIndex((t) => t.id === clip.trackId)),
        dragItems,
      };
      return;
    }

    if (edge === 'move') {
      selectClipWithModifiers(clipId, e);
    } else if (!selectedClipIds.includes(clipId)) {
      selectClipSingle(clipId);
    }
    const trackIndex = tracks.findIndex((t) => t.id === clip.trackId);
    const moveIds = edge === 'move' && selectedClipIds.includes(clipId) && !(e.ctrlKey || e.metaKey || e.shiftKey)
      ? selectedClipIds
      : [clipId];
    const initialClips = moveIds
      .map((id) => {
        const c = clips.find((item) => item.id === id);
        if (!c) return null;
        return {
          id,
          startSec: c.startSec,
          trackIndex: Math.max(0, tracks.findIndex((t) => t.id === c.trackId)),
        };
      })
      .filter((item): item is { id: string; startSec: number; trackIndex: number } => item !== null);
    opRef.current = {
      kind: edge === 'move' ? 'move' : edge === 'left' ? 'resize-left' : 'resize-right',
      clipId,
      startPxX: e.clientX,
      startPxY: e.clientY,
      initialStartSec: clip.startSec,
      initialDurationSec: clip.durationSec,
      initialOffsetIntoSource: clip.offsetIntoSource,
      initialTrackIndex: trackIndex,
      initialClips,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const op = opRef.current;
    if (!op) return;
    const dxPx = e.clientX - op.startPxX;
    const dySec = e.clientY - op.startPxY;

    if (op.kind === 'ctrl-drag-pending') {
      const dist = Math.hypot(dxPx, dySec);
      if (dist >= CTRL_DRAG_MOVE_THRESHOLD_PX && op.dragItems && op.dragItems.length > 0) {
        useExternalDragStore.getState().begin(op.dragItems);
        opRef.current = null;
      }
      return;
    }

    const dxSec = pxToSec(dxPx);
    const clip = clips.find((c) => c.id === op.clipId);
    if (!clip) return;
    if (op.kind === 'move') {
      // Vertical track shift.
      const trackDelta = Math.round(dySec / TRACK_HEIGHT);
      const moveTargets = op.initialClips?.length ? op.initialClips : [{ id: op.clipId, startSec: op.initialStartSec, trackIndex: op.initialTrackIndex }];
      moveTargets.forEach((target) => {
        const newStart = Math.max(0, snapSec(target.startSec + dxSec));
        const targetIdx = Math.max(0, Math.min(tracks.length - 1, target.trackIndex + trackDelta));
        const newTrackId = tracks[targetIdx].id;
        updateClip(target.id, { startSec: newStart, trackId: newTrackId });
      });
    } else if (op.kind === 'resize-right') {
      const newDur = Math.max(0.05, op.initialDurationSec + dxSec);
      // Don't exceed source.
      const maxDur = Math.max(0.05, clip.sourceDuration - clip.offsetIntoSource);
      updateClip(op.clipId, { durationSec: Math.min(newDur, maxDur) });
    } else if (op.kind === 'resize-left') {
      const delta = dxSec;
      const newStart = op.initialStartSec + delta;
      const newOffset = op.initialOffsetIntoSource + delta;
      const newDur = op.initialDurationSec - delta;
      if (newDur <= 0.05 || newOffset < 0) return;
      updateClip(op.clipId, {
        startSec: Math.max(0, newStart),
        offsetIntoSource: newOffset,
        durationSec: newDur,
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const op = opRef.current;
    if (op?.kind === 'ctrl-drag-pending') {
      selectClipWithModifiers(op.clipId, { ctrlKey: true });
      opRef.current = null;
      return;
    }
    if (opRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      opRef.current = null;
    }
  };

  // --- Drag-and-drop from Library ---
  const onTimelineDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-thedaw-library-id')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onTimelineDrop = async (e: React.DragEvent) => {
    const entryId = e.dataTransfer.getData('application/x-thedaw-library-id');
    if (!entryId) return;
    e.preventDefault();
    if (!timelineRef.current) return;
    const entry = useLibraryStore.getState().entries.find((x) => x.id === entryId);
    if (!entry) {
      logError('editor', `Drop: library entry ${entryId.slice(0, 8)} not found`);
      return;
    }
    const rect = timelineRef.current.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const droppedBelowAllTracks = yPx >= tracks.length * TRACK_HEIGHT;
    let targetTrack: typeof tracks[number] | undefined;
    if (droppedBelowAllTracks) {
      const newTrackId = addTrack({ name: entry.title });
      // Re-read tracks from the store after the mutation.
      targetTrack = useEditorStore.getState().tracks.find((t) => t.id === newTrackId);
    } else {
      const targetTrackIdx = Math.max(0, Math.min(tracks.length - 1, Math.floor(yPx / TRACK_HEIGHT)));
      targetTrack = tracks[targetTrackIdx];
    }
    if (!targetTrack) return;
    const startSec = droppedBelowAllTracks ? 0 : snapSec(pxToSec(xPx));
    try {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      const { peaks, duration } = await computePeaks(blob, 240);
      const clipId = addClipToTrack({
        trackId: targetTrack.id,
        label: entry.title ?? `clip_${entryId.slice(0, 6)}`,
        audioBlob: blob,
        mimeType: entry.mimeType,
        sourceDuration: duration || entry.duration,
        offsetIntoSource: 0,
        durationSec: duration || entry.duration,
        startSec,
        color: targetTrack.color,
        libraryEntryId: entry.id,
      });
      cachePeaks(clipId, peaks);
      logInfo('editor', `Dropped ${entry.title} on ${targetTrack.name} at ${startSec.toFixed(2)}s`);
    } catch (err) {
      logError('editor', `Drop decode failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  // --- Fade handle drag ---
  const onFadePointerDown = (e: React.PointerEvent, clipId: string, edge: 'in' | 'out') => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    fadeDragRef.current = {
      clipId,
      edge,
      startX: e.clientX,
      initialFade: edge === 'in' ? (clip.fadeInSec ?? 0) : (clip.fadeOutSec ?? 0),
    };
  };

  const onFadePointerMove = (e: React.PointerEvent) => {
    const fd = fadeDragRef.current;
    if (!fd) return;
    const clip = clips.find((c) => c.id === fd.clipId);
    if (!clip) return;
    const dxPx = e.clientX - fd.startX;
    const dxSec = fd.edge === 'in' ? pxToSec(dxPx) : pxToSec(-dxPx);
    const maxFade = clip.durationSec / 2;
    const newFade = Math.max(0, Math.min(maxFade, fd.initialFade + dxSec));
    updateClip(fd.clipId, fd.edge === 'in' ? { fadeInSec: newFade } : { fadeOutSec: newFade });
  };

  const onFadePointerUp = (e: React.PointerEvent) => {
    if (!fadeDragRef.current) return;
    fadeDragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  // --- Playhead drag (initiated from the ruler OR the drag handle on the line) ---
  const secFromClientX = useCallback((clientX: number): number => {
    return Math.max(0, timelineClientXToSec(clientX));
  }, [timelineClientXToSec]);

  const onPlayheadPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const wasPlaying = isEditorTimelinePlaying();
    if (wasPlaying) stopEditorPlayback();
    const sec = secFromClientX(e.clientX);
    setPlayhead(sec);
    playheadDragRef.current = { startX: e.clientX, startSec: sec, wasPlaying };
  };

  const seekEditorTo = useCallback((sec: number) => {
    setPlayhead(sec);
    if (usePlayerStore.getState().currentEntryId === 'editor-timeline') {
      usePlayerStore.getState().seek(sec);
    }
  }, [setPlayhead]);

  const onPlayheadPointerMove = (e: React.PointerEvent) => {
    if (!playheadDragRef.current) return;
    seekEditorTo(secFromClientX(e.clientX));
  };

  const onPlayheadPointerUp = (e: React.PointerEvent) => {
    if (!playheadDragRef.current) return;
    const { wasPlaying } = playheadDragRef.current;
    playheadDragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    // Resume footer player if it was playing; it already has the audio loaded.
    if (wasPlaying && usePlayerStore.getState().currentEntryId === 'editor-timeline') {
      usePlayerStore.getState().play();
    }
  };

  // Ruler click sets playhead immediately (same coord math as track lanes).
  const onRulerMouseDown = (e: React.MouseEvent) => {
    // Shift-drag on the ruler draws the loop region; a plain click sets the playhead.
    if (e.shiftKey) {
      const anchor = Math.max(0, secFromClientX(e.clientX));
      setLoopRegion(anchor, anchor);
      const move = (ev: MouseEvent) => {
        const cur = Math.max(0, secFromClientX(ev.clientX));
        setLoopRegion(Math.min(anchor, cur), Math.max(anchor, cur));
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
      return;
    }
    seekEditorTo(secFromClientX(e.clientX));
  };

  const onTimelineClick = (e: React.MouseEvent) => {
    if (automationEdit) return; // automation edit mode owns the lanes; ruler still moves the playhead
    if (e.button === 2) return; // right-click is the add-MIDI menu, not a playhead move
    if (!timelineRef.current) return;
    if (opRef.current) return;
    // Only react to direct clicks on the timeline gutter (not on a clip).
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip="1"]')) return;
    if (target.closest('[data-playhead-handle="1"]')) return;
    clearInpaintSelection();
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const sec = pxToSec(x);
    setPlayhead(Math.max(0, sec));
    setSelected(null);
  };

  const onClipClick = (e: React.MouseEvent, clipId: string) => {
    if (tool !== 'cut') return;
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const sec = pxToSec(x);
    splitClipAt(clipId, sec);
  };

  /** Bind a MIDI clip to the Piano Roll and reveal it (FL: double-click a clip). */
  const editClipInPianoRoll = useCallback((clip: AudioClip) => {
    if (!clip.sourcePianoRoll) return;
    usePianoRollStore.getState().loadFromClip(
      clip.id,
      clip.sourcePianoRoll,
      clip.sourceBpm ?? 120,
      clip.sourceTotalSteps ?? 32,
    );
    useBottomPanelStore.getState().showTab('midi');
    logInfo('editor', `Editing clip ${clip.id.slice(0, 8)} in MIDI (${clip.sourcePianoRoll.length} notes)`);
  }, []);

  const onClipDoubleClick = (clip: AudioClip) => {
    if (clip.sourcePianoRoll) editClipInPianoRoll(clip);
  };

  /** Right-click an empty part of the timeline → open the MIDI picker there. */
  const onLanesContextMenu = (e: React.MouseEvent) => {
    if (automationEdit) return; // right-click deletes automation points in edit mode
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip="1"]')) return; // a clip's own menu handles it
    e.preventDefault();
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    setMidiDrop({ sec: Math.max(0, snapSec(pxToSec(e.clientX - rect.left))), x: e.clientX, y: e.clientY });
  };

  /** Turn picked MIDI bytes into a piano-roll clip on a new track at `startSec`,
   *  using the currently selected instrument (live-playable + editable). */
  const addMidiClipFromBytes = useCallback(async (bytes: ArrayBuffer, label: string, startSec: number) => {
    try {
      const data = parseMidi(new Uint8Array(bytes));
      const stepTicks = (data.ppq || 480) / 4;
      const notes: PianoNote[] = [];
      for (const tr of data.tracks) {
        for (const n of tr.notes) {
          notes.push({
            id: `imp-${Math.random().toString(36).slice(2)}-${notes.length}`,
            note: n.note,
            step: Math.round(n.tick / stepTicks),
            length: Math.max(1, Math.round(n.durationTicks / stepTicks)),
            velocity: n.velocity,
          });
        }
      }
      if (notes.length === 0) {
        logError('editor', `No notes in "${label}"`);
        return;
      }
      const bpm = Math.round(data.bpm) || 120;
      const lastStep = notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
      const totalSteps = Math.max(16, Math.ceil(lastStep / 16) * 16);
      const program = isSoundfontActive() ? getActiveProgram() : undefined;
      const nominalDuration = totalSteps * (60 / Math.max(40, bpm) / 4);
      const blob = silentWavBlob();
      const trackId = addTrack({ name: label, instrumentProgram: program });
      const color = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const clipId = addClipToTrack({
        trackId,
        label,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: nominalDuration,
        offsetIntoSource: 0,
        durationSec: nominalDuration,
        startSec: Math.max(0, startSec),
        color,
        sourceKind: 'piano-roll',
        sourcePianoRoll: notes,
        sourceBpm: bpm,
        sourceTotalSteps: totalSteps,
        instrumentProgram: program,
      });
      logInfo('editor', `Added MIDI "${label}" (${notes.length} notes) at ${startSec.toFixed(2)}s; rendering audio in background…`);
      void (async () => {
        const started = performance.now();
        try {
          const rendered = await renderStepNotesToBlob(notes, bpm, totalSteps);
          const { peaks } = await computePeaks(rendered.blob, 240);
          updateClip(clipId, {
            audioBlob: rendered.blob,
            mimeType: 'audio/wav',
            sourceDuration: rendered.duration,
            durationSec: rendered.duration,
          });
          cachePeaks(clipId, peaks);
          logInfo('editor', `MIDI audio ready for "${label}" in ${(performance.now() - started).toFixed(0)}ms`);
        } catch (renderErr) {
          logError('editor', `MIDI audio render failed for "${label}": ${renderErr instanceof Error ? renderErr.message : String(renderErr)}`);
        }
      })();
    } catch (err) {
      logError('editor', `Add MIDI failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [addTrack, addClipToTrack, cachePeaks, updateClip]);

  // --- Renderers ---
  const renderRuler = useMemo(() => {
    const ticks: { sec: number; major: boolean }[] = [];
    const stepSec = zoom >= 60 ? 1 : zoom >= 25 ? 2 : zoom >= 12 ? 5 : 10;
    for (let s = 0; s <= totalDuration + stepSec; s += stepSec) {
      ticks.push({ sec: s, major: s % (stepSec * 5) === 0 });
    }
    return ticks;
  }, [zoom, totalDuration]);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

  const handleTimelineScroll = useCallback(() => {
    if (trackHeaderScrollRef.current && timelineScrollRef.current) {
      trackHeaderScrollRef.current.scrollTop = timelineScrollRef.current.scrollTop;
    }
  }, []);

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40 overflow-hidden" ref={containerRef}>
      {/* Editor Toolbar */}
      <div className="flex items-center justify-between p-2 border-b border-white/5 bg-black/20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex bg-black/40 p-0.5 rounded border border-white/5 gap-0.5">
            <button
              onClick={() => setTool('move')}
              className={`p-1 px-2 rounded transition-colors ${tool === 'move' ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
              title="Move tool: drag clips"
            >
              <Move className="w-3 h-3" />
            </button>
            <button
              onClick={() => setTool('cut')}
              className={`p-1 px-2 rounded transition-colors ${tool === 'cut' ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
              title="Cut tool: click a clip to split it at that point"
            >
              <Scissors className="w-3 h-3" />
            </button>
          </div>

          <div className="flex bg-black/40 p-0.5 rounded border border-white/5 gap-0.5">
            <button
              onClick={() => undo()}
              disabled={!canUndo}
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              className="p-1 px-2 rounded transition-colors text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
            >
              <Undo2 className="w-3 h-3" />
            </button>
            <button
              onClick={() => redo()}
              disabled={!canRedo}
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              className="p-1 px-2 rounded transition-colors text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
            >
              <Redo2 className="w-3 h-3" />
            </button>
          </div>

          <button
            onClick={openInpaintPanel}
            disabled={!inpaintSelection}
            className={`p-1 px-2 rounded border transition-colors disabled:opacity-30 disabled:pointer-events-none
              ${inpaintSelection ? 'bg-purple-600/20 border-purple-500/40 text-purple-300 hover:bg-purple-600/30' : 'border-white/5 text-zinc-500'}`}
            title="Inpaint selected region (Ctrl+P)"
          >
            <Paintbrush className="w-3 h-3" />
          </button>

          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-black/40 border border-white/5 rounded">
            <Magnet className={`w-3 h-3 ${snap === 'off' ? 'text-zinc-700' : 'text-purple-300'}`} />
            <select
              id="editor-snap-division"
              name="editor-snap-division"
              value={snap}
              onChange={(e) => setSnap(e.target.value as SnapDivision)}
              className="bg-transparent border-none outline-none text-[9px] font-mono uppercase text-zinc-100 cursor-pointer"
              style={{ colorScheme: 'dark' }}
              title="Snap divisions are relative to the editor BPM"
            >
              <option value="off">Snap off</option>
              <option value="1/4">1/4</option>
              <option value="1/8">1/8</option>
              <option value="1/16">1/16</option>
            </select>
          </div>

          <div className="flex items-center gap-1">
            <button onClick={() => setZoom(zoom - 5)} className="p-1 hover:bg-white/5 rounded text-zinc-500" title="Zoom out">
              <ZoomOut className="w-3 h-3" />
            </button>
            <span className="text-[9px] font-mono text-zinc-400 w-12 text-center">{zoom}px/s</span>
            <button onClick={() => setZoom(zoom + 5)} className="p-1 hover:bg-white/5 rounded text-zinc-500" title="Zoom in">
              <ZoomIn className="w-3 h-3" />
            </button>
          </div>

          <div className="h-4 w-px bg-white/10" />

          <button
            disabled={selectedClipCount === 0}
            onClick={deleteSelectedClips}
            className="p-1.5 hover:bg-red-500/20 rounded text-zinc-400 hover:text-red-400 disabled:opacity-30 disabled:pointer-events-none"
            title="Delete selected clip(s) (Del)"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <div className="h-4 w-px bg-white/10" />

          <button
            onClick={() => setShowMasterFx((v) => !v)}
            aria-pressed={showMasterFx}
            aria-label="Master FX rack"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${showMasterFx || masterFxChain.length > 0 ? 'bg-purple-600/20 border-purple-500/40 text-purple-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
            title="Master psychoacoustic insert rack (applies to the whole editor mix)"
          >
            <SlidersHorizontal className="w-3 h-3" /> MASTER FX
          </button>

          <button
            onClick={() => setShowMasterVst((v) => !v)}
            aria-pressed={showMasterVst}
            aria-label="Master VST3 chain"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${showMasterVst || masterVstChain.length > 0 ? 'bg-teal-600/20 border-teal-500/40 text-teal-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
            title="Master VST3 chain — render the mix through VST plugins (freeze)"
          >
            <Plug className="w-3 h-3" /> VST
            {previewMode === 'frozen' && <Snowflake className="w-2.5 h-2.5 text-cyan-300" />}
          </button>

          <button
            onClick={() => setMagentaToolId((cur) => (cur ? null : MAGENTA_TOOLS[0].id))}
            aria-pressed={!!magentaTool}
            aria-label="Magenta RT2 generative tools"
            title="Magenta RealTime 2 — generate audio (Collider · Jam · MRT2) via the Windows sidecar"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${magentaTool ? 'bg-cyan-600/20 border-cyan-500/40 text-cyan-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
          >
            <Music className="w-3 h-3" /> MAGENTA
          </button>

          <button
            onClick={() => setAutomationWrite(!automationWrite)}
            aria-pressed={automationWrite}
            aria-label="Automation write"
            title="Automation write: while playing, ride a track's volume or pan fader to record it; turn off to play it back"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${automationWrite ? 'bg-red-600/20 border-red-500/50 text-red-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
          >
            <span className={`w-2 h-2 rounded-full ${automationWrite ? 'bg-red-500 animate-pulse' : 'bg-zinc-600'}`} /> WRITE
          </button>

          <button
            onClick={() => setAutomationEdit((v) => {
              const next = !v;
              if (next && !activeLaneId && automationLanes.length > 0) setActiveLaneId(automationLanes[0].id);
              return next;
            })}
            aria-pressed={automationEdit}
            aria-label="Edit automation lanes"
            title="Edit automation: draw, drag, and delete breakpoints on the selected lane"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${automationEdit ? 'bg-amber-600/20 border-amber-500/50 text-amber-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
          >
            <span className={`w-2 h-2 rounded-full ${automationEdit ? 'bg-amber-400' : 'bg-zinc-600'}`} /> AUTO
          </button>

          <button
            onClick={() => setLoopEnabled(!loopEnabled)}
            onContextMenu={(e) => { e.preventDefault(); clearLoop(); }}
            aria-pressed={loopEnabled}
            aria-label="Loop region"
            title="Loop: shift-drag the ruler to set the region, click to toggle, right-click to clear"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${loopEnabled ? 'bg-amber-600/20 border-amber-500/50 text-amber-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
          >
            <Repeat className="w-3 h-3" /> LOOP
          </button>

          <button
            onClick={() => addMarker(playheadSec)}
            aria-label="Add marker at playhead"
            title="Add a marker at the playhead (double-click a flag to rename, Alt-click to delete)"
            className="flex items-center gap-1.5 p-1 px-2 rounded border border-white/5 text-zinc-500 hover:text-white hover:bg-white/5 transition-colors text-[9px] font-mono uppercase tracking-wider"
          >
            <Flag className="w-3 h-3" /> MARK
          </button>

          <button
            onClick={() => setShowMetamorph((v) => !v)}
            aria-pressed={showMetamorph}
            aria-label="Metamorph granular identity-bleed panel"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${showMetamorph ? 'bg-purple-600/20 border-purple-500/40 text-purple-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
            title="Granular identity bleed: rebuild one sound out of another's grains, live"
          >
            <Wand2 className="w-3 h-3" /> METAMORPH
          </button>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[9px] font-mono text-zinc-500 tabular-nums">
            {formatTimecode(playheadSec)} / {formatTimecode(totalDuration)}
          </span>
          <button
            onClick={() => isEditorPlaying ? stopEditorPlayback() : void playEditorTimeline()}
            disabled={clips.length === 0 || isRendering}
            className={`p-1.5 rounded transition-colors disabled:opacity-30 ${isEditorPlaying ? 'bg-purple-500/30 text-purple-200 hover:bg-purple-500/20' : 'hover:bg-purple-500/20 text-purple-300'}`}
            title={isRendering ? 'Rendering…' : isEditorPlaying ? 'Stop (Space)' : 'Play from playhead (Space)'}
          >
            {isRendering
              ? <div className="w-3.5 h-3.5 border-2 border-purple-400/40 border-t-purple-300 rounded-full animate-spin" />
              : isEditorPlaying
                ? <Pause className="w-3.5 h-3.5 fill-current" />
                : <Play className="w-3.5 h-3.5 fill-current" />}
          </button>
          <button
            onClick={stopEditorPlayback}
            disabled={!isEditorPlaying}
            className="p-1.5 hover:bg-white/10 rounded text-zinc-400 disabled:opacity-30"
            title="Stop and return to start"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
          <label htmlFor="editor-mixdown-name" className="sr-only">Mixdown filename</label>
          <input
            id="editor-mixdown-name"
            name="editor-mixdown-name"
            type="text"
            value={mixdownName}
            onChange={(e) => setMixdownName(e.target.value)}
            placeholder="mixdown name…"
            className="bg-black/40 border border-white/10 rounded px-2 py-0.5 text-[9px] font-mono text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-purple-500/50 transition-colors w-28"
            title="Optional filename for the committed mixdown"
          />
          <button
            onClick={() => void commitEdit()}
            disabled={isCommitting || clips.length === 0}
            className="btn-primary py-1! px-2! text-[9px] flex items-center gap-1.5 disabled:opacity-40"
            title="Render all clips to a single audio file and save it to the library"
          >
            {isCommitting ? <Upload className="w-3 h-3 animate-pulse" /> : <Save className="w-3 h-3" />}
            {isCommitting ? 'COMMITTING…' : 'COMMIT EDIT'}
          </button>
        </div>
      </div>

      {/* MASTER FX + METAMORPH float as popups (like the per-track FX rack) so they
          never shove the timeline down; close with the X. */}
      {(showMasterFx || showMetamorph || showMasterVst) && (
        <div className="fixed top-28 left-4 z-50 flex items-start gap-3 max-w-[calc(100%-2rem)]">
          {showMasterVst && (
            <section aria-label="Master VST chain" className="w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-teal-500/30 rounded-lg shadow-2xl shadow-teal-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-teal-300">Master VST</span>
                <button onClick={() => setShowMasterVst(false)} aria-label="Close master VST panel" className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"><X className="w-3.5 h-3.5" /></button>
              </div>

              {/* Live / Frozen toggle */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={enterLiveMode}
                  className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest transition-colors ${previewMode === 'live' ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-100' : 'border-white/10 text-zinc-400 hover:bg-white/5'}`}
                >
                  <Play className="w-3 h-3" /> Live
                </button>
                <button
                  onClick={() => void enterFrozenMode()}
                  disabled={masterVstChain.length === 0 || clips.length === 0 || isFreezing}
                  className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest transition-colors disabled:opacity-40 ${previewMode === 'frozen' ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-100' : 'border-white/10 text-zinc-400 hover:bg-white/5'}`}
                >
                  {isFreezing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Snowflake className="w-3 h-3" />} Frozen
                </button>
              </div>

              {previewMode === 'frozen' && (
                <button
                  onClick={() => void reRenderFrozen()}
                  disabled={isFreezing || !frozenStale}
                  className="btn-ghost inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
                  title={frozenStale ? 'Re-render the master through the VST chain' : 'Frozen render is up to date'}
                >
                  {isFreezing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  {frozenStale ? 'Re-render (stale)' : 'Up to date'}
                </button>
              )}
              <p className="text-[8px] text-zinc-600 leading-relaxed">
                VSTs apply to the rendered master. Live plays the realtime mix (built-in rack only); Frozen plays the VST-processed render and re-renders after edits.
              </p>

              {/* Master VST chain */}
              <div className="flex items-center justify-between">
                <span className="mono-label">Chain ({masterVstChain.length})</span>
                {masterVstChain.length > 0 && (
                  <button onClick={() => { clearMasterVst(); enterLiveMode(); }} className="text-zinc-600 hover:text-red-400" title="Clear VST chain"><Trash2 className="w-3 h-3" /></button>
                )}
              </div>
              {masterVstChain.length === 0 ? (
                <p className="text-[9px] text-zinc-600 italic">No VSTs. Add one below.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {masterVstChain.map((node, i) => (
                    <div key={node.id} className="flex items-center gap-1.5 bg-black/40 border border-white/5 rounded px-1.5 py-1">
                      <span className="text-[8px] font-mono text-teal-300/70 shrink-0">{i + 1}</span>
                      <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-300 truncate">{node.vst?.plugin_name ?? 'VST'}</span>
                      <button onClick={() => reorderMasterVst(i, i - 1)} disabled={i === 0} aria-label="Move up" className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-30"><ChevronUp className="w-3 h-3" /></button>
                      <button onClick={() => reorderMasterVst(i, i + 1)} disabled={i === masterVstChain.length - 1} aria-label="Move down" className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-30"><ChevronDown className="w-3 h-3" /></button>
                      <button onClick={() => removeMasterVst(node.id)} aria-label="Remove VST" className="p-0.5 text-zinc-500 hover:text-red-300"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}

              {/* Available plugins */}
              <div className="flex items-center justify-between border-t border-white/10 pt-2">
                <span className="mono-label">Available ({vstPlugins.length})</span>
                <button onClick={() => void scanVst(true)} disabled={vstScanning} className="btn-ghost inline-flex items-center gap-1 disabled:opacity-40" title="Rescan VST3 folders">
                  {vstScanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Rescan
                </button>
              </div>
              {vstPlugins.length === 0 ? (
                <p className="text-[9px] text-zinc-600 italic">{vstScanning ? 'Scanning…' : 'No VST3 plugins found.'}</p>
              ) : (
                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {vstPlugins.map((pl) => (
                    <button key={pl.path} onClick={() => addMasterVst({ plugin_path: pl.path, plugin_name: pl.name })} title={pl.path}
                      className="flex items-center gap-1.5 bg-black/30 border border-white/5 rounded px-1.5 py-1 text-left hover:bg-white/5">
                      <Plug className="w-3 h-3 text-teal-300 shrink-0" />
                      <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-300 truncate">{pl.name}</span>
                      <Plus className="w-3 h-3 text-zinc-500 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          {showMasterFx && (
            <section aria-label="Master FX rack" className="w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-purple-300">Master FX</span>
                <button
                  onClick={() => setShowMasterFx(false)}
                  aria-label="Close master FX rack"
                  className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <FxRack
                chain={masterFxChain}
                idPrefix="master-fx"
                onAdd={addMasterEffect}
                onRemove={removeMasterEffect}
                onReorder={reorderMasterEffect}
                onToggle={toggleMasterEffect}
                onUpdateParams={(id, p) => writeFxParams({ kind: 'master' }, id, p)}
                projectBpm={projectBpm}
                displayParams={(id) => fxDisplayParams({ kind: 'master' }, id)}
              />
            </section>
          )}
          {showMetamorph && (
            <section aria-label="Metamorph" className="w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-purple-300">
                  Metamorph <span className="text-zinc-600 normal-case tracking-normal">granular identity bleed</span>
                </span>
                <button
                  onClick={() => setShowMetamorph(false)}
                  aria-label="Close Metamorph panel"
                  className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <MetamorphPanel />
            </section>
          )}
        </div>
      )}

      {/* Magenta RT2 generative tools (floating; large enough for the 780×504
          instrument). The picked tool's EXACT Google UI is embedded via
          MagentaToolStage and driven by the bridge shim → /api/magenta. */}
      {magentaTool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" role="dialog" aria-label="Magenta RT2 tools" onMouseDown={() => setMagentaToolId(null)}>
          <section
            className="hardware-card bg-black/95 border border-cyan-500/30 rounded-lg shadow-2xl shadow-cyan-900/40 flex flex-col overflow-hidden"
            style={{ width: 'min(900px, 92vw)', height: 'min(620px, 88vh)' }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 shrink-0">
              <Music className="w-3.5 h-3.5 text-cyan-300" />
              <span className="text-[10px] font-mono uppercase tracking-wider text-cyan-300">Magenta RT2</span>
              <div className="flex items-center gap-1 ml-2">
                {MAGENTA_TOOLS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setMagentaToolId(t.id)}
                    title={t.desc}
                    className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border transition-colors ${magentaTool.id === t.id ? 'bg-cyan-600/20 border-cyan-500/40 text-cyan-200' : 'border-white/8 text-zinc-500 hover:text-zinc-200 hover:bg-white/5'}`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setMagentaToolId(null)}
                aria-label="Close Magenta tools"
                className="ml-auto p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <MagentaToolStage tool={magentaTool} />
            </div>
          </section>
        </div>
      )}

      {/* Per-track FX rack (floating; fixed so it escapes the card's overflow clip) */}
      {fxPanelTrackId && (() => {
        const t = tracks.find((tr) => tr.id === fxPanelTrackId);
        if (!t) return null;
        return (
          <div className="fixed right-4 top-28 z-50 w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 truncate">
                Track FX — <span style={{ color: t.color }}>{t.name}</span>
              </span>
              <button
                onClick={() => setFxPanelTrackId(null)}
                aria-label="Close track FX rack"
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <FxRack
              chain={t.fxChain ?? []}
              idPrefix={`track-fx-${t.id}`}
              onAdd={(eid) => addTrackEffect(t.id, eid)}
              onRemove={(id) => removeTrackEffect(t.id, id)}
              onReorder={(from, to) => reorderTrackEffect(t.id, from, to)}
              onToggle={(id) => toggleTrackEffect(t.id, id)}
              onUpdateParams={(id, p) => writeFxParams({ kind: 'track', trackId: t.id }, id, p)}
              projectBpm={projectBpm}
              displayParams={(id) => fxDisplayParams({ kind: 'track', trackId: t.id }, id)}
            />
          </div>
        );
      })()}

      {/* Automation lane panel (floating; while automation edit mode is on) */}
      {automationEdit && (
        <div className="fixed left-4 top-28 z-50 w-72 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-amber-500/30 rounded-lg shadow-2xl shadow-amber-900/30 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-amber-300">Automation Lanes</span>
            <button
              onClick={() => setAutomationEdit(false)}
              aria-label="Close automation editor"
              className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {automationLanes.length === 0 ? (
            <span className="text-[9px] font-mono text-zinc-600 leading-relaxed">
              No lanes yet. Turn on WRITE and ride a fader or FX control while playing to record one.
            </span>
          ) : (
            <div className="flex flex-col gap-1">
              {automationLanes.map((lane) => {
                const vis = laneVisual(lane);
                const active = lane.id === activeLaneId;
                return (
                  <div
                    key={lane.id}
                    className={`flex items-center gap-1.5 rounded px-1.5 py-1 border ${active ? 'border-amber-500/50 bg-amber-500/10' : 'border-white/5 bg-black/30'}`}
                  >
                    <button
                      onClick={() => toggleAutomationLane(lane.id)}
                      aria-pressed={lane.enabled}
                      aria-label={`${laneLabel(lane)} ${lane.enabled ? 'enabled' : 'disabled'}`}
                      title={lane.enabled ? 'Lane on (records + plays back)' : 'Lane off (ignored)'}
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${lane.enabled ? '' : 'opacity-40'}`}
                      style={{ backgroundColor: vis?.color ?? '#a1a1aa' }}
                    />
                    <button
                      onClick={() => setActiveLaneId(lane.id)}
                      className={`flex-1 text-left text-[9px] font-mono truncate ${active ? 'text-amber-100' : 'text-zinc-300 hover:text-white'}`}
                      title="Select this lane to edit its breakpoints"
                    >
                      {laneLabel(lane)} <span className="text-zinc-600">({lane.points.length})</span>
                    </button>
                    <button
                      onClick={() => clearAutomationLane(lane.id)}
                      aria-label={`Clear ${laneLabel(lane)}`}
                      title="Clear all breakpoints in this lane"
                      className="px-1 py-0.5 rounded text-[8px] font-mono text-zinc-500 hover:text-amber-300 hover:bg-white/5 shrink-0"
                    >
                      CLR
                    </button>
                    <button
                      onClick={() => { if (activeLaneId === lane.id) setActiveLaneId(null); removeAutomationLane(lane.id); }}
                      aria-label={`Delete ${laneLabel(lane)}`}
                      title="Delete this lane"
                      className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {activeLaneId && (
            <p className="text-[8px] font-mono text-zinc-500 leading-relaxed border-t border-white/5 pt-2">
              Editing the highlighted lane: click the curve to add a point, drag a point to move it, Alt-click or right-click a point to delete it.
            </p>
          )}
        </div>
      )}

      {/* Per-clip instrument override (floating; MIDI clips only) */}
      {instrPanel && (() => {
        const clip = clips.find((c) => c.id === instrPanel.clipId);
        if (!clip) return null;
        const left = Math.max(8, Math.min(instrPanel.x, window.innerWidth - 280));
        const top = Math.max(8, Math.min(instrPanel.y, window.innerHeight - 96));
        return (
          <div
            ref={instrPanelRef}
            className="fixed z-50 w-66 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
            style={{ left, top }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 truncate">
                Clip instrument — <span style={{ color: clip.color }}>{clip.label}</span>
              </span>
              <button
                onClick={() => setInstrPanel(null)}
                aria-label="Close clip instrument picker"
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <ClipInstrumentSelect clip={clip} />
          </div>
        );
      })()}

      {/* Per-clip Time / Pitch popover (audio clips) */}
      {timePitchPanel && (() => {
        const clip = clips.find((c) => c.id === timePitchPanel.clipId);
        if (!clip) return null;
        const left = Math.max(8, Math.min(timePitchPanel.x, window.innerWidth - 300));
        const top = Math.max(8, Math.min(timePitchPanel.y, window.innerHeight - 170));
        return (
          <div
            ref={timePitchRef}
            className="fixed z-50 w-72 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
            style={{ left, top }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 truncate">
                Time / Pitch — <span style={{ color: clip.color }}>{clip.label}</span>
              </span>
              <button
                onClick={() => setTimePitchPanel(null)}
                aria-label="Close time and pitch panel"
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <TimePitchControls
              busy={timePitchBusy}
              onApply={(tempo, semitones) => { void applyTimePitch(timePitchPanel.clipId, tempo, semitones).then(() => setTimePitchPanel(null)); }}
            />
          </div>
        );
      })()}

      {/* Body: track headers + scrollable timeline */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Track headers (sticky, not scrolled) */}
        <div className="shrink-0 bg-[#0c0a12] border-r border-[#1a1528] overflow-hidden flex flex-col" style={{ width: TRACK_HEADER_PX }}>
          {/* Ruler row spacer */}
          <div className="h-6 border-b border-white/5 bg-black/30 flex items-center justify-center text-[8px] font-mono text-zinc-700 uppercase">tracks</div>
          <div ref={trackHeaderScrollRef} className="flex-1 overflow-hidden">
            {tracks.map((t) => (
              <div
                key={t.id}
                onPointerDown={(e) => handleTrackHeaderPointerDown(e, t.id)}
                onContextMenu={(e) => { selectTrackSingle(t.id); trackMenu.open(e, { trackId: t.id }); }}
                className={`border-b border-[#1a1528] p-2 flex flex-col gap-1.5 transition-colors ${selectedTrackIds.includes(t.id) ? 'bg-purple-500/10 ring-1 ring-inset ring-purple-500/35' : ''}`}
                style={{ height: TRACK_HEIGHT }}
                title="Click to select track. Ctrl/Cmd-click to multi-select tracks. Right-click for track FX."
              >
                <div className="flex justify-between items-center gap-1">
                  <input
                    id={`editor-track-name-${t.id}`}
                    name={`editor-track-name-${t.id}`}
                    aria-label={`Track ${t.name} name`}
                    type="text"
                    value={t.name}
                    onChange={(e) => updateTrack(t.id, { name: e.target.value, nameAutoGenerated: false })}
                    className="bg-transparent border-none outline-none text-[10px] font-bold w-full hover:bg-white/5 px-1 -mx-1 rounded transition-colors min-w-0"
                    style={{ color: t.color }}
                  />
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => updateTrack(t.id, { armed: !t.armed })}
                      aria-label={`Arm track ${t.name} for recording`}
                      aria-pressed={!!t.armed}
                      title="Arm for recording"
                      className={`w-4 h-4 rounded-full flex items-center justify-center border ${t.armed ? 'bg-red-500/30 text-red-400 border-red-500/60' : 'bg-black/40 text-zinc-500 border-white/10 hover:text-white'}`}
                    >
                      <Circle className={`w-2 h-2 ${t.armed ? 'fill-red-500' : ''}`} />
                    </button>
                    <button
                      onClick={() => updateTrack(t.id, { mute: !t.mute })}
                      className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center ${t.mute ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                    >M</button>
                    <button
                      onClick={() => toggleSolo(t.id)}
                      className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center ${t.solo ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                    >S</button>
                    <button
                      onClick={() => setFxPanelTrackId((cur) => (cur === t.id ? null : t.id))}
                      aria-label={`Track ${t.name} insert FX`}
                      aria-pressed={fxPanelTrackId === t.id}
                      title="Track insert FX rack"
                      className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center ${(t.fxChain?.length ?? 0) > 0 || fxPanelTrackId === t.id ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                    >F</button>
                    <button
                      onClick={() => removeTrack(t.id)}
                      className="w-4 h-4 rounded text-[8px] flex items-center justify-center bg-black/40 text-zinc-600 border border-white/5 hover:text-red-400"
                      title="Remove track"
                    >×</button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Volume2 className="w-2.5 h-2.5 text-zinc-600 shrink-0" />
                  <SlideTrack min={0} max={1} step={0.01} value={faderDisplay('trackVolume', t.id, t.volume)}
                    onChange={(v) => writeFader('trackVolume', t.id, v)} className="flex-1" ariaLabel="Track volume" />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase w-3">P</span>
                  <SlideTrack min={-1} max={1} step={0.01} value={faderDisplay('trackPan', t.id, t.pan)}
                    onChange={(v) => writeFader('trackPan', t.id, v)} className="flex-1" ariaLabel="Track pan" />
                  <span className="text-[7px] font-mono text-zinc-600 text-right w-5">
                    {t.pan > 0 ? `R${Math.round(t.pan * 100)}` : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : 'C'}
                  </span>
                </div>
                {clips.some((c) => c.trackId === t.id && c.sourceKind === 'piano-roll' && !!c.sourcePianoRoll && c.sourcePianoRoll.length > 0) && (
                  <TrackInstrumentSelect track={t} />
                )}
              </div>
            ))}
            {/* Add-track affordance sits directly below the lowest (newest) track. */}
            <button
              onClick={() => addTrack()}
              aria-label="Add track"
              title="Add a new empty track"
              className="w-full h-7 flex items-center justify-center text-zinc-500 hover:text-purple-300 hover:bg-purple-500/10 border-b border-[#1a1528] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Scrollable timeline area */}
        <div
          ref={timelineScrollRef}
          className="flex-1 min-w-0 overflow-x-auto overflow-y-auto bg-[#07050a]"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onScroll={handleTimelineScroll}
        >
          {/* Ruler — click or drag to set playhead. Sticky so vertical scroll keeps it pinned. */}
          <div
            className="h-6 border-b border-white/5 bg-black/80 backdrop-blur-sm sticky top-0 z-40 select-none cursor-col-resize"
            style={{ width: timelineWidthPx }}
            onMouseDown={onRulerMouseDown}
          >
            {renderRuler.map((tick) => (
              <div
                key={tick.sec}
                className="absolute top-0 bottom-0 flex items-center px-1 border-l border-white/5 pointer-events-none"
                style={{ left: tick.sec * zoom }}
              >
                <span className={`text-[8px] font-mono ${tick.major ? 'text-zinc-500' : 'text-zinc-700'}`}>
                  {formatTimecode(tick.sec).replace(/\.00$/, '')}
                </span>
              </div>
            ))}
            {/* Loop region (shift-drag the ruler to set; LOOP toggles it) */}
            {loopEnd > loopStart && (
              <div
                className={`absolute top-0 bottom-0 z-10 pointer-events-none ${loopEnabled ? 'bg-amber-400/25 border-x border-amber-400/70' : 'bg-white/5 border-x border-white/25'}`}
                style={{ left: loopStart * zoom, width: (loopEnd - loopStart) * zoom }}
              />
            )}
            {/* Marker flags */}
            {markers.map((m) => (
              <MarkerFlag
                key={m.id}
                marker={m}
                zoom={zoom}
                onSeek={() => seekEditorTo(m.t)}
                onRename={(label) => renameMarker(m.id, label)}
                onDelete={() => removeMarker(m.id)}
              />
            ))}
            {/* Playhead in ruler: line + draggable triangle handle */}
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500/60 pointer-events-none z-20"
              style={{ left: playheadSec * zoom }}
            />
            <div
              data-playhead-handle="1"
              className="absolute bottom-0 z-30 cursor-ew-resize"
              style={{ left: playheadSec * zoom - 6, width: 13 }}
              onPointerDown={onPlayheadPointerDown}
              onPointerMove={onPlayheadPointerMove}
              onPointerUp={onPlayheadPointerUp}
            >
              {/* Downward-pointing triangle */}
              <div
                className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0"
                style={{
                  borderLeft: '5px solid transparent',
                  borderRight: '5px solid transparent',
                  borderTop: '7px solid #ef4444',
                }}
              />
            </div>
          </div>

          {/* Track lanes + 'drop here for new track' slot at the bottom */}
          <div
            ref={timelineRef}
            className={`relative ${tool === 'cut' ? 'cursor-crosshair' : 'cursor-default'}`}
            style={{ width: timelineWidthPx, height: tracks.length * TRACK_HEIGHT + 34 + (automationEdit ? MASTER_STRIP_H : 0) }}
            onMouseDown={onTimelineClick}
            onContextMenu={onLanesContextMenu}
            onDragOver={onTimelineDragOver}
            onDrop={onTimelineDrop}
          >
            {tracks.map((track, ti) => (
              <div
                key={track.id}
                className="absolute left-0 right-0 border-b border-white/5"
                style={{ top: ti * TRACK_HEIGHT, height: TRACK_HEIGHT, backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.02) 1px, transparent 1px)', backgroundSize: `${zoom * 5}px 100%` }}
              />
            ))}

            {/* Clips */}
            {clips.map((clip) => {
              const trackIdx = tracks.findIndex((t) => t.id === clip.trackId);
              if (trackIdx < 0) return null;
              const left = clip.startSec * zoom;
              const width = clip.durationSec * zoom;
              const top = trackIdx * TRACK_HEIGHT + 6;
              const height = TRACK_HEIGHT - 12;
              const selected = selectedClipIdSet.has(clip.id) || clip.id === selectedClipId;
              const peaks = clip.peaks;
              const isMidi = clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll && clip.sourcePianoRoll.length > 0;
              return (
                <div
                  key={clip.id}
                  data-clip="1"
                  onPointerDown={(e) => onClipPointerDown(e, clip.id, 'move')}
                  onClick={(e) => onClipClick(e, clip.id)}
                  onDoubleClick={() => onClipDoubleClick(clip)}
                  onContextMenu={(e) => openContextMenu(e, clip.id)}
                  className={`absolute rounded border overflow-hidden transition-shadow ${selected ? 'border-white shadow-[0_0_18px_rgba(255,255,255,0.18)] z-10' : 'border-white/15 hover:border-white/40'}`}
                  style={{
                    left, width, top, height,
                    backgroundColor: `${clip.color}22`,
                    cursor: tool === 'cut' ? 'crosshair' : 'grab',
                  }}
                >
                  {/* Header bar */}
                  <div className="absolute top-0 left-0 right-0 px-1 h-3.5 bg-black/50 backdrop-blur-sm border-b border-white/10 flex justify-between items-center text-[8px] font-mono uppercase tracking-tighter">
                    <span className="flex items-center gap-1 min-w-0 max-w-3/5">
                      {clip.sourceKind === 'piano-roll' && (
                        <Piano className="w-2.5 h-2.5 text-emerald-300 shrink-0" />
                      )}
                      <span className="text-white truncate">{clip.label}</span>
                    </span>
                    <span className="text-zinc-300">{clip.durationSec.toFixed(2)}s</span>
                  </div>
                  {/* Body: MIDI clips show their notes (FL-style); audio clips show peaks */}
                  {isMidi ? (
                    <MidiClipNotes clip={clip} zoom={zoom} selected={selected} />
                  ) : (
                    <div className="absolute inset-x-0 bottom-0 top-3.5 flex items-center gap-[0.5px] px-1">
                      {peaks ? (
                        Array.from(peaks).map((v, i) => (
                          <div
                            key={i}
                            className="flex-1 rounded-sm"
                            style={{ height: `${Math.max(2, v * 90)}%`, backgroundColor: clip.color, opacity: selected ? 0.95 : 0.7 }}
                          />
                        ))
                      ) : (
                        <span className="text-[8px] font-mono text-zinc-600 italic">decoding…</span>
                      )}
                    </div>
                  )}
                  {/* Inpaint drag target — covers waveform body below header.
                      MIDI clips skip it so double-click / right-click reach the
                      clip (inpaint generates audio into a region, meaningless for notes). */}
                  {!isMidi && (
                    <div
                      className="absolute inset-x-0 bottom-0 z-10 cursor-crosshair"
                      style={{ top: 14 }}
                      onPointerDown={(e) => handleInpaintDragStart(e, clip)}
                      onPointerMove={handleInpaintDragMove}
                      onPointerUp={handleInpaintDragEnd}
                    />
                  )}
                  {/* Inpaint selection overlay */}
                  {inpaintSelection?.clipId === clip.id && (
                    <div
                      className="absolute top-0 bottom-0 pointer-events-none z-20 border-x border-purple-400"
                      style={{
                        left:  (inpaintSelection.startSec - clip.startSec) * zoom,
                        width: (inpaintSelection.endSec - inpaintSelection.startSec) * zoom,
                        background: 'rgba(168, 85, 247, 0.18)',
                      }}
                    >
                      <span className="absolute top-0.5 left-1 text-[8px] font-mono text-purple-300 pointer-events-none leading-none">
                        {(inpaintSelection.endSec - inpaintSelection.startSec).toFixed(2)}s
                      </span>
                    </div>
                  )}
                  {/* Resize handles — z-20 to stay above inpaint drag target */}
                  <div
                    className="absolute inset-y-0 left-0 w-1.5 hover:bg-white/40 cursor-ew-resize z-20"
                    onPointerDown={(e) => onClipPointerDown(e, clip.id, 'left')}
                  />
                  <div
                    className="absolute inset-y-0 right-0 w-1.5 hover:bg-white/40 cursor-ew-resize z-20"
                    onPointerDown={(e) => onClipPointerDown(e, clip.id, 'right')}
                  />
                  {/* Fade-in overlay */}
                  {(clip.fadeInSec ?? 0) > 0 && (
                    <div
                      className="absolute top-3.5 bottom-0 left-0 pointer-events-none z-15"
                      style={{
                        width: (clip.fadeInSec ?? 0) * zoom,
                        background: `linear-gradient(to right, rgba(0,0,0,0.65) 0%, transparent 100%)`,
                      }}
                    />
                  )}
                  {/* Fade-out overlay */}
                  {(clip.fadeOutSec ?? 0) > 0 && (
                    <div
                      className="absolute top-3.5 bottom-0 right-0 pointer-events-none z-15"
                      style={{
                        width: (clip.fadeOutSec ?? 0) * zoom,
                        background: `linear-gradient(to left, rgba(0,0,0,0.65) 0%, transparent 100%)`,
                      }}
                    />
                  )}
                  {/* Fade-in handle — draggable fence post */}
                  <div
                    className="absolute bottom-0 top-3.5 w-2 cursor-ew-resize z-25 group/fh flex items-center justify-center"
                    style={{ left: Math.max(2, (clip.fadeInSec ?? 0) * zoom - 4) }}
                    title="Fade in — drag right"
                    onPointerDown={(e) => onFadePointerDown(e, clip.id, 'in')}
                    onPointerMove={onFadePointerMove}
                    onPointerUp={onFadePointerUp}
                  >
                    <div className="w-px h-full bg-white/20 group-hover/fh:bg-white/60 transition-colors" />
                    <div className="absolute bottom-2 w-2 h-2 rounded-full bg-white/30 group-hover/fh:bg-white/70 transition-colors border border-white/40" />
                  </div>
                  {/* Fade-out handle — draggable fence post */}
                  <div
                    className="absolute bottom-0 top-3.5 w-2 cursor-ew-resize z-25 group/fh flex items-center justify-center"
                    style={{ right: Math.max(4, (clip.fadeOutSec ?? 0) * zoom - 4) }}
                    title="Fade out — drag left"
                    onPointerDown={(e) => onFadePointerDown(e, clip.id, 'out')}
                    onPointerMove={onFadePointerMove}
                    onPointerUp={onFadePointerUp}
                  >
                    <div className="w-px h-full bg-white/20 group-hover/fh:bg-white/60 transition-colors" />
                    <div className="absolute bottom-2 w-2 h-2 rounded-full bg-white/30 group-hover/fh:bg-white/70 transition-colors border border-white/40" />
                  </div>
                </div>
              );
            })}

            {/* Automation lanes: read-only curve per track (volume green, pan blue, FX
                amber), or editable when automation edit mode targets that lane. */}
            {automationLanes.map((lane) => {
              const tk = lane.target.kind;
              if (tk !== 'trackVolume' && tk !== 'trackPan' && tk !== 'trackFx') return null;
              const editable = automationEdit && lane.id === activeLaneId;
              if (lane.points.length === 0 && !editable) return null;
              const trackIdx = tracks.findIndex((t) => t.id === lane.target.trackId);
              if (trackIdx < 0) return null;
              const vis = laneVisual(lane);
              if (!vis) return null;
              return (
                <AutomationLane
                  key={lane.id}
                  lane={lane}
                  zoom={zoom}
                  width={timelineWidthPx}
                  height={TRACK_HEIGHT}
                  top={trackIdx * TRACK_HEIGHT}
                  color={vis.color}
                  toNorm={vis.toNorm}
                  fromNorm={vis.fromNorm}
                  editable={editable}
                />
              );
            })}

            {/* Master-FX automation strip (only while editing automation; master
                lanes have no track row of their own). */}
            {automationEdit && (
              <div
                className="absolute left-0 border-t border-amber-500/30 bg-amber-500/4 pointer-events-none"
                style={{ top: tracks.length * TRACK_HEIGHT + 34, width: timelineWidthPx, height: MASTER_STRIP_H }}
              >
                <span className="absolute top-1 left-2 text-[8px] font-mono uppercase tracking-widest text-amber-400/70">Master FX</span>
              </div>
            )}
            {automationEdit && masterLanes.map((lane) => {
              const editable = lane.id === activeLaneId;
              if (lane.points.length === 0 && !editable) return null;
              const vis = laneVisual(lane);
              if (!vis) return null;
              return (
                <AutomationLane
                  key={lane.id}
                  lane={lane}
                  zoom={zoom}
                  width={timelineWidthPx}
                  height={MASTER_STRIP_H}
                  top={tracks.length * TRACK_HEIGHT + 34}
                  color={vis.color}
                  toNorm={vis.toNorm}
                  fromNorm={vis.fromNorm}
                  editable={editable}
                />
              );
            })}

            {/* Loop region band down the lanes (when set) */}
            {loopEnd > loopStart && (
              <div
                className={`absolute top-0 bottom-0 pointer-events-none ${loopEnabled ? 'bg-amber-400/8 border-x border-amber-400/30' : 'bg-white/2 border-x border-white/10'}`}
                style={{ left: loopStart * zoom, width: (loopEnd - loopStart) * zoom }}
              />
            )}

            {/* Playhead line in track lanes */}
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] z-30 pointer-events-none"
              style={{ left: playheadSec * zoom }}
            />

            {/* Drop-here-for-new-track strip — directly below the last lane */}
            <div
              className="absolute left-0 right-0 border-t border-dashed border-purple-500/30 bg-purple-500/4 flex items-center justify-center text-[9px] font-mono uppercase tracking-widest text-purple-400/60 pointer-events-none"
              style={{ top: tracks.length * TRACK_HEIGHT, height: 34 }}
            >
              Drop here to create a new track
            </div>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="h-6 border-t border-white/5 bg-black/60 flex items-center justify-between px-3 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-[9px] font-mono text-zinc-500 tabular-nums">
            {formatTimecode(playheadSec)} / {formatTimecode(totalDuration)}
          </span>
          <span className="text-[8px] font-mono text-zinc-600">
            {clips.length} clips · {tracks.length} tracks
          </span>
        </div>
        <div className="flex items-center gap-3">
          {selectedClip ? (
            <span className="text-[8px] font-mono text-purple-300 uppercase tracking-wider">
              SEL: {selectedClip.label} · {selectedClip.startSec.toFixed(2)}s → {(selectedClip.startSec + selectedClip.durationSec).toFixed(2)}s
            </span>
          ) : (
            <span className="text-[8px] font-mono text-zinc-700 uppercase tracking-wider">
              {clips.length === 0 ? 'No clips yet — send something from LIBRARY' : 'No selection'}
            </span>
          )}
        </div>
      </div>

      {/* Right-click context menu — shared ContextMenu primitive
          (plan step 3d). The conditional items (inpaint region / edit
          in piano roll) flow naturally through the items array since
          the menu is rebuilt each render from `clipMenu.payload`. */}
      {(() => {
        const payload = clipMenu.payload;
        if (!payload) return null;
        const clip = clips.find((c) => c.id === payload.clipId);
        const items: ContextMenuItem[] = [];
        if (inpaintSelection?.clipId === payload.clipId) {
          items.push({
            type: 'item',
            label: 'Inpaint Region',
            icon: <Paintbrush className="w-3 h-3" />,
            hint: 'Ctrl+P',
            onSelect: openInpaintPanel,
          });
          items.push({ type: 'separator' });
        }
        items.push({
          type: 'item',
          label: 'Preview',
          hint: 'Space',
          onSelect: () => { void playSelectedPreview(); },
        });
        items.push({
          type: 'item',
          label: 'Split here',
          hint: `${payload.atSec.toFixed(2)}s`,
          onSelect: () => splitClipAt(payload.clipId, payload.atSec),
        });
        items.push({
          type: 'item',
          label: 'Duplicate',
          hint: 'Ctrl+D',
          onSelect: duplicateSelectedClips,
        });
        items.push({
          type: 'item',
          label: 'Send Selection to Init',
          icon: <Wand2 className="w-3 h-3" />,
          hint: 'mix',
          disabled: isRendering,
          onSelect: () => { void sendSelectionToInit(); },
        });
        items.push({
          type: 'item',
          label: 'Send Selection to Init (stacked)',
          icon: <Layers className="w-3 h-3" />,
          hint: 'chimera',
          onSelect: () => {
            const selection = getSelectionForInit();
            if (selection.length === 0) return;
            addBlobsToChimera(
              selection.map((c) => ({
                blob: c.audioBlob,
                mimeType: c.mimeType,
                label: c.label,
              })),
            );
            onSwitchTab?.('create');
          },
        });
        if (clip && !clip.sourcePianoRoll) {
          items.push({
            type: 'item',
            label: 'Time / Pitch…',
            icon: <Gauge className="w-3 h-3" />,
            hint: 'stretch',
            onSelect: () => {
              const pos = clipMenu.position;
              setTimePitchPanel({ clipId: payload.clipId, x: pos?.x ?? 240, y: pos?.y ?? 200 });
            },
          });
        }
        if (clip?.sourcePianoRoll) {
          const noteCount = clip.sourcePianoRoll.length;
          items.push({
            type: 'item',
            label: 'Edit in Piano Roll',
            icon: <Piano className="w-3 h-3" />,
            hint: `${noteCount} notes`,
            onSelect: () => editClipInPianoRoll(clip),
          });
          items.push({
            type: 'item',
            label: 'Instrument',
            icon: <Piano className="w-3 h-3" />,
            hint: clip.instrumentProgram === undefined ? 'track default' : gmShortName(clip.instrumentProgram),
            onSelect: () => {
              const pos = clipMenu.position;
              setInstrPanel({ clipId: payload.clipId, x: pos?.x ?? 240, y: pos?.y ?? 200 });
            },
          });
        }
        items.push({ type: 'separator' });
        items.push({
          type: 'item',
          label: 'Delete',
          hint: 'Del',
          danger: true,
          onSelect: deleteSelectedClips,
        });
        return (
          <ContextMenu
            position={clipMenu.position}
            onClose={clipMenu.close}
            items={items}
            minWidth="10rem"
          />
        );
      })()}

      {/* Track context menu — insert FX, opened by right-clicking a track header. */}
      {trackMenu.position && (() => {
        const t = tracks.find((tr) => tr.id === trackMenu.payload?.trackId);
        if (!t) return null;
        const hasFx = (t.fxChain?.length ?? 0) > 0;
        // Style prompt + lyrics come from the originating library entry of any
        // clip on this track (Suno tracks carry them; derived best-effort).
        const clipWithEntry = clips.find((c) => c.trackId === t.id && c.libraryEntryId);
        const srcEntry = clipWithEntry?.libraryEntryId
          ? useLibraryStore.getState().entries.find((e) => e.id === clipWithEntry.libraryEntryId)
          : null;
        const styleText = srcEntry ? deriveStyle(srcEntry).trim() : '';
        const lyricsText = srcEntry ? deriveLyrics(srcEntry).trim() : '';
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            icon: <Copy className="w-3 h-3" />,
            label: 'Copy style prompt',
            disabled: !styleText,
            onSelect: () => { if (styleText) void navigator.clipboard.writeText(styleText); },
          },
          {
            type: 'item',
            icon: <Copy className="w-3 h-3" />,
            label: 'Copy lyrics',
            disabled: !lyricsText,
            onSelect: () => { if (lyricsText) void navigator.clipboard.writeText(lyricsText); },
          },
          { type: 'separator' },
          {
            type: 'item',
            icon: <SlidersHorizontal className="w-3 h-3" />,
            label: 'Open FX rack',
            onSelect: () => setFxPanelTrackId(t.id),
          },
          { type: 'separator' },
          { type: 'header', label: 'Add insert' },
          ...RACK_EFFECTS.map((def): ContextMenuItem => ({
            type: 'item',
            label: def.label,
            onSelect: () => addTrackEffect(t.id, def.id),
          })),
        ];
        if (hasFx) {
          items.push({ type: 'separator' });
          items.push({
            type: 'item',
            label: 'Clear track FX',
            danger: true,
            onSelect: () => updateTrack(t.id, { fxChain: [] }),
          });
        }
        return (
          <ContextMenu
            position={trackMenu.position}
            onClose={trackMenu.close}
            items={items}
            title={`Track · ${t.name}`}
            minWidth="11rem"
          />
        );
      })()}

      {/* MIDI picker — opened by right-clicking an empty part of the timeline. */}
      <LibraryMidiPicker
        open={midiDrop !== null}
        anchor={midiDrop ? { x: midiDrop.x, y: midiDrop.y } : null}
        title="Add MIDI to timeline"
        onClose={() => setMidiDrop(null)}
        onPick={(bytes, label) => {
          const at = midiDrop?.sec ?? 0;
          setMidiDrop(null);
          void addMidiClipFromBytes(bytes, label, at);
        }}
      />

      {/* Floating inpaint panel */}
      {inpaintPanel && (
        <div
          className="fixed right-4 z-150 w-72 bg-[#0a080f] border border-purple-500/40 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.75)] p-3 flex flex-col gap-2.5"
          style={{ top: (containerRef.current?.getBoundingClientRect().top ?? 140) + 52 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 flex items-center gap-1.5">
              <Paintbrush className="w-3 h-3" /> Inpaint Region
            </span>
            <button onClick={rejectInpaint} className="p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-white transition-colors">
              <X className="w-3 h-3" />
            </button>
          </div>

          {/* Phase: params */}
          {inpaintPanel.kind === 'params' && (
            <>
              <textarea
                name="inpaint-prompt"
                placeholder="Describe what to generate in this region…"
                value={inpaintPrompt}
                onChange={(e) => setInpaintPrompt(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 placeholder:text-zinc-600 resize-none outline-none focus:border-purple-500/50 transition-colors"
                rows={3}
                autoFocus
              />
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-mono text-zinc-500">Steps</span>
                  <span className="text-[9px] font-mono text-zinc-400">{inpaintSteps}</span>
                </div>
                <SlideTrack min={4} max={20} step={1} value={inpaintSteps}
                  onChange={(v) => setInpaintSteps(v)} className="w-full" ariaLabel="Inpaint steps" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-zinc-500 shrink-0">Seed</span>
                <input
                  type="number" name="inpaint-seed" value={inpaintSeed}
                  onChange={(e) => setInpaintSeed(parseInt(e.target.value) || -1)}
                  className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-purple-500/50 transition-colors"
                  placeholder="-1 (random)"
                />
              </div>
              <button
                onClick={() => void submitInpaint()}
                disabled={!inpaintPrompt.trim()}
                className="w-full py-1.5 rounded bg-purple-600/30 border border-purple-500/40 text-purple-200 text-[9px] font-black uppercase tracking-widest hover:bg-purple-600/50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                Generate
              </button>
            </>
          )}

          {/* Phase: generating */}
          {inpaintPanel.kind === 'generating' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="w-5 h-5 border-2 border-purple-500/40 border-t-purple-400 rounded-full animate-spin" />
              <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">Generating…</span>
              <button onClick={rejectInpaint} className="text-[9px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors">
                cancel
              </button>
            </div>
          )}

          {/* Phase: review */}
          {inpaintPanel.kind === 'review' && (
            <>
              <audio controls src={inpaintPanel.blobUrl} className="w-full h-8 mt-1" />
              <div className="flex gap-2">
                <button
                  onClick={() => acceptInpaint(inpaintPanel.blob)}
                  className="flex-1 py-1.5 rounded bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 text-[9px] font-black uppercase tracking-widest hover:bg-emerald-600/50 transition-colors"
                >
                  Accept
                </button>
                <button
                  onClick={rejectInpaint}
                  className="flex-1 py-1.5 rounded bg-red-600/20 border border-red-500/30 text-red-300 text-[9px] font-black uppercase tracking-widest hover:bg-red-600/40 transition-colors"
                >
                  Reject
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

