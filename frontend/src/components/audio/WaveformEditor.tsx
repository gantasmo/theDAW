import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import {
  Scissors, Play, Square, ZoomIn, ZoomOut,
  Trash2, Move, Plus, Volume2, Upload, Save, Piano, Paintbrush, X, Wand2, Layers,
  SlidersHorizontal, Undo2, Redo2, Gauge, Repeat, Flag, Circle, Copy, Music,
  Plug, Snowflake, Loader2, ChevronUp, ChevronDown, RefreshCw, Blocks,
  Maximize2, Rows3, Keyboard, Eye, AudioLines, Spline, FolderOpen, Check,
  Settings2, ScanSearch, BoxSelect, Ellipsis, AudioWaveform, Bot, Drum, ListTree,
} from 'lucide-react';
import { addSectionMarkersToClip } from '../../lib/songSectionActions';
import { deriveStyle, deriveLyrics } from '../../catalog/catalogSearch';
import { addBlobsToChimera } from '../../lib/chimeraClient';
import { stripSourceId } from '../../lib/displayName';
import { SlideTrack } from './SlideTrack';
import { SemanticWave } from './SemanticWave';
import { WaveformModeToggle } from './WaveformModeControl';
import { MetamorphPanel } from './MetamorphPanel';
import { useMorphStore } from '../../state/morphEngine';
import { useMetamorphPanelRequest } from '../../state/metamorphPanelRequestStore';
import { MagentaToolStage } from './MagentaToolStage';
import { TrackVstInstrument } from './TrackVstInstrument';
import { MAGENTA_TOOLS, magentaToolById, type MagentaTool } from '../../lib/magentaToolCatalog';
import { AutomationLane } from './AutomationLane';
import { TrackVolumeLines } from './TrackVolumeLine';
import { volumeBand } from '../../lib/volumeLine';
import { addVolumeKeyframe } from '../../state/volumeKeyframes';
import { buildAddAutomationLaneOptions } from './automationLaneOptions';
import { RACK_EFFECTS, getRackEffect, buildEffectChain, ensureChopModule } from '../../lib/rackEffects';
import { decodeClipBlob, releaseDecoded } from '../../lib/decodeCache';
import { type FadeCurve } from '../../lib/clipFade';
import {
  BOUNCE_SAMPLE_RATE, clipsInScope, encodeBounce, instrumentTracksInScope, isExternalMidiClip, printInstrumentTracks, renderExtentSec,
  type BounceRequest, type BounceScope, type InstrumentPrint, type RenderDeps,
} from '../../lib/renderCore';
import { isInstrumentClip } from '../../lib/vstInstrumentMidi';
import { clipWithAudio, clipsWithMidiAudio, dropAutoRender, midiRenderStatusText, requestMidiRender, useMidiRenderQueue, type MidiRenderMode } from '../../state/midiRenderQueue';
import { configureAppMidiRenderQueue } from '../../state/appMidiRenderer';
import { crossfadeRegions } from '../../lib/crossfade';
import {
  MIN_CLIP_SEC,
  resizeLeft as resizeClipLeft,
  resizeRight as resizeClipRight,
  slip as slipClipAudio,
  toTimelineView,
  fromTimelineOffset,
} from '../../lib/clipDragMath';
import { effectiveZoom } from '../../lib/canvasScale';
import { ownsKey } from '../../lib/keyScope';
import { encodeWav } from '../../lib/wavEncode';
import type { AudioDragItem } from '../../lib/audioDnD';
import { beginClipDragOut, dragOutHasContent, planClipDragOut } from '../../state/clipDragOut';
import { TrackTemplatePicker } from './TrackTemplatePicker';
import { useEditorStore, activeTrackInstrument, automationEntryFor, automationLaneFeed, beginUndoStep, computePeaks, documentFreezeSignature, isFxAutomationKind, sampleLane, automationTargetKey, midiCcOfTarget, vstParamIndexOfKey, clipPeakGain, clipSourceSpanSec, clipStretchRate, snapStepSecAt, snapDivisionLabel, SNAP_DIVISIONS, TRACK_HEIGHT_MIN, TRACK_HEIGHT_MAX, ZOOM_MIN, ZOOM_MAX, type AudioClip, type EditorTrack, type SnapDivision, type AutomationTarget, type AutomationLane as AutomationLaneT, type TimelineMarker } from '../../state/editorStore';
import { partController } from '../../lib/rollTracks';
import { AUTOMATION_MODES, holdsAfterRelease, type AutomationMode } from '../../lib/automationModes';
import { createAutomationGesture, type AutomationGesture } from '../../lib/automationGesture';
import { useLibraryStore, type LibraryEntry } from '../../state/libraryStore';
import { LIBRARY_ID_MIME, MIDI_ID_MIME, STEM_ID_MIME, STEM_SONG_MIME, dropHasLibraryOrFiles, entriesFromDrop } from '../../lib/libraryDrop';
import { magnetStart, magnetTargetsFor } from '../../lib/timelineMagnet';
import { useVstStore } from '../../state/vstStore';
import { useVstParamStore } from '../../state/vstParamStore';
import {
  bounceIsChunkSafe, useRenderJobs,
  type RenderJob, type RenderJobKind, type RenderJobResult, type RenderJobSeed,
} from '../../state/renderJobs';
import { useAppUiStore } from '../../state/appUiStore';
import { captureLiveVstStates, useVstEditorStore } from '../../state/vstEditorStore';
import type { ChainEntry, VstNode } from '../../state/effectChainStore';
import { processFileThroughVst, renderInstrumentTrack, type Vst3PluginInfo } from '../../lib/vstClient';
import { printedStemSec, printsThroughHost, renderWithInserts, type InsertPrintResult, type VstHop } from '../../lib/render/insertPrint';
import { getEngineCtx, getMasterGain, usePlayerStore } from '../../state/playerStore';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { clipPartsLoad } from '../../lib/rollClip';
import { midiClipPlacedReport, placeMidiFileClip } from '../../lib/midiClipPlace';
import { MidiClipNotes } from './MidiClipNotes';
import { tempoSpan } from '../../lib/rollTempo';
import { GM_NAMES, gmShortName } from '../../lib/gmInstruments';
import { useSoundfontStore, ensureSoundfontReady, getGlobalVoice } from '../../lib/soundfontEngine';
import {
  GM_DRUM_KITS,
  clipBank,
  clipVoice,
  drumKitName,
  isPercussionTrack,
} from '../../lib/clipProgram';
import { anyLiftedVoice } from '../../lib/soundbankGain';
import { safetyLimiterFor } from '../../lib/synthOutputStage';
import { DEFAULT_VOICE_VALUE, parseVoiceValue, voiceValue } from '../../lib/voiceOptions';
import { BUNDLED_BANK_ID, instrumentRefValue, parseInstrumentRefValue, presetName, type InstrumentRef } from '../../lib/bankRegistry';
import { BankPresetOptions, isBankPreset, useSoundBanks } from './bankPresetOptions';
import { TuningControl } from './TuningControl';
import { TrackMidiOut } from './TrackMidiOut';
import { DROP_RENDER_FIELDS, hasMidiNotes, midiRenderSig, midiRenderState, midiRenderStateText, type MidiRenderState } from '../../lib/midiRender';
import { importMidiBytesAsTracks } from '../../lib/midiImportTracksApp';
import { parseMidi } from '../../utils/midi';
import { EditorBpmField } from './EditorBpmField';
import { EditTimeMapPanel, type TimeMapFocus } from './EditTimeMapPanel';
import { NewMidiPartDialog } from './NewMidiPartDialog';
import { editMeterFlags, editRulerBars, editTempoAtSec, editTempoFlags } from '../../lib/editTimeMap';
import { hasTempoChanges } from '../../lib/rollTempo';
import { LibraryPicker, type LibraryPick, type LibraryPickerTab } from './LibraryPicker';
import {
  addToTrackGroupLabel,
  buildAddToTrackMenu,
  isAddSourceEntry,
  type AddToTrackEntry,
  type AddToTrackTarget,
} from './addToTrackMenu';
import { cachedLibraryMidiCount, loadLibraryMidi, stemAudioUrl } from '../../lib/libraryIndex';
import { AUDIO_ACCEPT, MIDI_ACCEPT, midiFileLabel } from '../../lib/fileFilters';
import { importAudioFiles, type AudioImportOrigin } from '../../lib/importAudioFiles';
import { fetchBlobWithRetry, fetchMidiBytesWithRetry } from '../../lib/fetchRetry';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { classifyModelGate } from '../../lib/modelDownloadClient';
import { setLocalOnly } from '../../lib/storageClient';
import { requireFeature } from '../../notices/featureGateStore';
import { logError, logInfo, logWarn } from '../../state/logStore';
import { humanizeTracks, type SectionHumanizeStrength } from '../../state/editorTools';
import { saveFile } from '../../lib/saveFile';
import { dirnameOf, basenameOf } from '../../lib/placesClient';
import {
  mixdownSaveOptions, mixdownSaveTargetFromPath, shouldApplyMixdownSave, type MixdownSaveTarget,
} from './mixdownSaveTarget';
import { clipsNeedingPeaksDecode, pruneFailedBlobs } from './peaksDecodeScheduler';
import { usePeaksDecodeQueue } from './usePeaksDecodeQueue';
import { allStemsMenuInfo, stemsFolderName, stemTrackSpecs } from './insertAllStems';
import { pruneMixdownJobExplicitNames } from './mixdownJobExplicitName';
import { KnownFilesMenu } from '../ui/KnownFilesMenu';
import { registerEditorPlayback, unregisterEditorPlayback } from '../../state/editorPlaybackBridge';
import { publishSelectedClips, publishSelectedTracks } from '../../state/editorSelectionBridge';
import { ctrlDragClickModifiers, mergeSelection, pruneSelection, rangeSelection, toggleSelection } from './waveformSelection';
import * as liveMixer from '../../state/liveMixer';
import { keyBelongsToFocusedControl } from '../../lib/keyTargets';
import { useDjAnalysisStore } from '../../state/djAnalysisStore';
import { laneTargetAtY } from './laneTarget';
import {
  cancelReorder, finishReorder, moveReorder, movingIdsFor, reorderRows, startReorder,
  type ReorderSession,
} from './trackReorderDrag';
import {
  autoscrollVelocity, cancelGesture, finishGesture, isPrimaryGestureButton, moveGesture, placementIntent,
  refreshMarquee, startGesture, type ClickSurface, type GestureState,
} from '../../lib/timeline/pointerGesture';
import { combineMarquee, contextAt, marqueeModeFor, reduceSelection, type TimeRange } from '../../lib/timeline/timeSelection';
import { layoutRows } from '../../lib/timeline/trackOrder';
import { useTimelinePrefs } from '../../state/timelinePrefsStore';
import { WHEEL_PROFILES, isWheelExcludedTarget } from '../../lib/timeline/viewport';
import { useEditThemeStore } from '../../state/editThemeStore';
import { TimelineGridLayer } from './TimelineGridLayer';
import { TimelinePrefsPanel } from './TimelinePrefsPanel';
import {
  ZOOM_FOLLOW_HOLD_MS, ZOOM_STEP_FACTOR, RULER_BAR_LABEL_MIN_PX, clipChromeLayout, createZoomCoalescer, fitProjectZoom, fitRangeZoom,
  followHoldActive, localViewportWidth, planZoom, resolveAnchorSec, rulerReadoutSpanPx, rulerTimeTicks, shouldRescrollAfterZoom, timeLabelUnderReadout,
  spanOfClips, viewportWindowSec, wheelDispatch, type ZoomAnchor, type ZoomCoalescer,
} from './timelineZoom';
import {
  buildClipHitRects, buildRangeMenu, classifyRulerPress, formatCursorTime, formatRangeReadout,
  highlightClearDecision, hitTestClipRects,
  inpaintFromRange, rangeSplitPlan, rulerDragRange, type RangeMenuAction,
} from './timelineInteraction';
import { clipKnownBpm, runBeatMatch, runTimePitch, type TimePitchRenderer } from '../../lib/beatMatchRun';
import { linkSongTime, stemsSongTime } from '../../lib/songTimeLink';
import { SongTempoDialog } from './SongTempoDialog';
import { ContextMenu, useContextMenu, type ContextMenuItem, type ContextMenuPosition } from '../ui/ContextMenu';
import { RenderRangeDialog } from '../render/RenderRangeDialog';
import { SurfacePlayKey } from '../ui/SurfacePlayKey';
import { StemsRunModal, type StemsRunOptions } from '../library/StemsRunModal';
import { ExportDialog } from './ExportDialog';
import type { ExportRenderItem, ExportRenderPlan, MidiExportItem } from '../../lib/render/exportDialogModel';
import { exportArrangementMidi } from '../../lib/arrangementMidiApp';
import { EffectWindowsHost, FxChainList, chainInState, effectEntryLabel, openEffectWindow, openVstEditorForScope, type EffectWindowOrigin, type FxScope } from './EffectWindows';
import { VstAutomationPicker } from './VstAutomationPicker';
import { PopoverPortal } from './PopoverPortal';
import { useTrackFxRackStore, type TrackFxRackAnchor } from '../../state/trackFxRackStore';
import { ensureStems, listStems, type StemRef } from '../../lib/djStems';
import { clipEditKind, isMidiClip } from '../../lib/clipEditTarget';
import {
  REVEAL_CLIP_EVENT, clipGesturePhase, planStemInsert, skippedAggregatesNote, stemClipPlacement,
  type RevealClipDetail,
} from './clipDoubleClick';
import { useAudioEditorStore } from '../../state/audioEditorStore';
import {
  referenceForClip, referenceForTimeSelection, referenceForTrack, requestAssistantFocus,
  useAssistantReferenceStore, type AssistantReference,
} from '../../state/assistantReferenceStore';
import { useFeatureToggleStore } from '../../state/featureToggleStore';
import { punchWindowFrom, useRecordingPrefs, useRecordingStore, type RecordingStatus } from '../../state/recordingStore';
import type { LevelFrame } from '../../lib/recordingEngine';
import { SurfaceAudio } from './IoDeviceSelect';
import { acquireObjectUrl } from '../../lib/sharedObjectUrl';
import { handleEngineElsewhere } from '../../lib/magentaElsewhere';

const TRACK_HEADER_PX = 180;

/** Provenance recorded on a file the user adds straight to a track from the
 *  timeline's right-click menu. The file still goes through the library first,
 *  exactly like a desktop drop, so the clip is indistinguishable from a dropped
 *  one and the take is findable in LIBRARY afterwards. */
const ADD_TO_TRACK_ORIGIN: AudioImportOrigin = {
  prompt: 'Added to a track from the timeline menu',
  tags: ['imported'],
};

/** Icon per add-to-track entry. Library and System share a kind, so the icon
 *  says WHERE it comes from and the label says WHAT it is. */
const ADD_ENTRY_ICON: Record<AddToTrackEntry['id'], React.ReactNode> = {
  'audio-library': <AudioLines className="w-3 h-3" />,
  'audio-system': <FolderOpen className="w-3 h-3" />,
  'midi-library': <Music className="w-3 h-3" />,
  'midi-system': <FolderOpen className="w-3 h-3" />,
  'midi-tracks': <Rows3 className="w-3 h-3" />,
  'midi-empty': <Piano className="w-3 h-3" />,
  paste: <Copy className="w-3 h-3" />,
  'new-track': <Plus className="w-3 h-3" />,
};

// How many peaks decodes (FE-007) run at once. Each holds a full decoded PCM
// buffer plus its own AudioContext, so a project with many undecoded clips at
// once (a fresh import, a big paste) does not decode all of them in parallel.
const PEAKS_DECODE_CONCURRENCY = 2;

// Track/clip colors for exploded stems, keyed by Demucs/LARSNET stem name.
const STEM_TRACK_COLORS: Record<string, string> = {
  vocals: '#f472b6',
  drums: '#f59e0b',
  bass: '#34d399',
  other: '#a78bfa',
  accompaniment: '#a78bfa',
  guitar: '#fb923c',
  piano: '#22d3ee',
  kick: '#f59e0b',
  snare: '#fbbf24',
  hihat: '#fde047',
  cymbals: '#fef08a',
  toms: '#fdba74',
};

export interface AllStemsInsertResult {
  /** The parent clip's label at the moment of the write — for the caller's log line. */
  readonly parentLabel: string;
  readonly insertedTrackCount: number;
  /** Aggregate names left out, unchanged from `planStemInsert`. */
  readonly skippedAggregates: readonly string[];
}

/**
 * F14's store writes: one folder track, one track+clip per already-decoded
 * stem, all in ONE undo step, then the parent clip muted. Module-level (not
 * a `useCallback`) and exported so this — the part an audit specifically
 * asked to be proven against the REAL store (one undo step, one `undo()`
 * restores everything) — is directly testable without mounting the editor or
 * faking a fetch/AudioContext; see `insertAllStemsStore.test.ts`.
 *
 * `insertAllStemsBesideClip` (the component callback) does the fetch +
 * `computePeaks` I/O and calls this once decoding is done. `decoded` is
 * stems already fetched and peak-decoded, in insertion order; `skipped` is
 * the aggregate names `planStemInsert` left out, carried through only for
 * the log line. Returns `null` when the clip is gone by the time this runs
 * (the caller logs) — nothing is written in that case.
 *
 * The folder is built with `addTrack({ isFolder: true, ... })` + each stem
 * track's `parentTrackId` set at creation, NOT the `addFolderFromSelectedTracks`
 * store action: that action opens its OWN undo step (it calls
 * `beginUndoStep()` before its write), which would split "add the stem
 * tracks" and "wrap them in a folder" into two steps — one Ctrl-Z would
 * un-fold the folder but leave the stems and the muted parent behind.
 * `addTrack` / `addClipToTrack` are anonymous writes (no `beginUndoStep()`
 * of their own), so every write here folds into the ONE burst the explicit
 * `beginUndoStep()` below opens — same pattern `explodeClipToStems` uses.
 */
export function applyAllStemsInsert(
  clipId: string,
  decoded: readonly { ref: StemRef; blob: Blob; peaks: Float32Array; duration: number }[],
  skipped: readonly string[],
): AllStemsInsertResult | null {
  const live = useEditorStore.getState().clips.find((c) => c.id === clipId);
  if (!live) return null;
  const specs = stemTrackSpecs(live.label, live.color, STEM_TRACK_COLORS, decoded.map((d) => d.ref));
  // The stems are the time of the entry they were separated from (the parent's
  // library entry), so each is tied to that song's analysis.
  const songTime = stemsSongTime(live, live.libraryEntryId);
  beginUndoStep();
  const store = useEditorStore.getState();
  const folderId = store.addTrack({ name: stemsFolderName(live.label), isFolder: true, collapsed: false });
  for (let i = 0; i < decoded.length; i++) {
    const { blob, peaks, duration } = decoded[i];
    const { label, color } = specs[i];
    const trackId = store.addTrack({ name: label, color, parentTrackId: folderId });
    const newClipId = store.addClipToTrack({
      trackId,
      label,
      audioBlob: blob,
      mimeType: 'audio/wav',
      sourceDuration: duration,
      ...stemClipPlacement(live, duration),
      color,
      gain: live.gain,
      fadeInSec: live.fadeInSec,
      fadeOutSec: live.fadeOutSec,
      ...(songTime ? { songTime: { ...songTime } } : {}),
    });
    store.cachePeaks(newClipId, peaks);
  }
  // Mute the source clip — kept, so this is undoable/reversible, same as
  // `explodeClipToStems`. `{ coalesce: true }` for the same reason that
  // needs it there: `updateClip` keys its coalescing on the clip while
  // `addTrack` / `addClipToTrack` are anonymous, so without the opt-in this
  // write opens a SECOND undo step.
  useEditorStore.getState().updateClip(clipId, { muted: true }, { coalesce: true });
  return { parentLabel: live.label, insertedTrackCount: decoded.length, skippedAggregates: skipped };
}

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

/** macOS: a ctrl+click with a mouse is a context-menu click, never a timeline gesture. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Installed on window while a ruler or lane press is in flight, so dragging
 *  across clip labels and readouts never starts a text selection. */
const preventSelectStart = (e: Event): void => e.preventDefault();


// Preview routes through the shared engine context so the visualizer sees it too.

// --- WAV encoder for the offline mixdown output. ---

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

/* ────────────────────────────────────────────────────────────────────────────
   THE RENDER QUEUE BRIDGE (T11c-b)

   Every offline render the timeline starts is a JOB on `state/renderJobs` now,
   not an inline `await` behind a local boolean. What lives here is the half of
   that the queue cannot own:

     - the three REQUEST BUILDERS, one per renderer, each still carrying exactly
       the fidelity flags `lib/renderCore`'s header assigns it. They are exported
       so `state/renderJobs.test.ts` can pin them: moving a render behind a queue
       must not move a single flag;
     - `runRenderJob`, the switch the app's one runner is started with. It
       performs the render AND the consumer work that used to sit after the
       `await` in each callback — the library import, the Save As, the Init
       hand-off, `freezeTrack`, `setFrozenMaster`.

   ONE PATTERN, ALL THREE: the consumer work lives in `run`, never in the caller.
   The callbacks in the component build a request, enqueue, and return, so a
   render survives EDIT unmounting and a second press queues instead of racing.
   The two places that must hold the rendered audio to carry on — the master VST
   freeze, and `enterFrozenMode` behind it — `enqueueAndWait` and read the
   settled job. The alternative the plan offered, an `onDone` closure carried on
   the job, was not taken: a job holding a callback cannot be inspected, logged
   or replayed, and the store would then own a field it can neither type nor
   bound.

   WHY THIS IS MODULE-LEVEL. The runner is started once for the app's life (see
   `App.tsx`) and EDIT unmounts on every tab switch, so anything `run` reaches
   for has to be reachable with this component unmounted: the stores through
   `getState()`, and nothing at all through props or hooks.

   WHAT IS NOT ON THE QUEUE, and why:
     - the step sequencer's pattern print — it keeps its own `isBouncing`; the
       `pattern` kind exists in the store but nothing enqueues one yet;
     - the Metamorph granular bleed (`isBleeding`) — it is a `morphEngine`
       render, not a `renderCore` bounce, so it has no `BounceRequest` to put on
       a job and no kind to put it under;
     - `cropAudioBlob` above — a one-clip crop for an inpaint upload, not a
       timeline bounce: no scope, no fidelity flags, nothing to report progress
       against.
──────────────────────────────────────────────────────────────────────────── */

// The MIDI render queue's real renderer, peak scan, picker, warm-up and live
// plan (state/appMidiRenderer). App.tsx sets them when the app loads; this
// module sets them again when it loads, which is before any bounce job can run
// (the render runner reaches its job functions through this module), so a
// surface that mounts EDIT without App has them too.
configureAppMidiRenderQueue();

/**
 * The nine fields `lib/renderCore` reads for a bounce: the document — clips,
 * tracks, the master rack, the automation lanes, and (since T14) the routing
 * graph with its buses, so the bounce sums through the same buses the live
 * mixer does — and the three real implementations it will not reach for itself
 * (the shared decode cache, the rack builder, the live mixer's per-clip
 * scheduler — the same one playback uses, which is what keeps a bounce and a
 * preview the same audio).
 *
 * Read from the store when the JOB RUNS, not when it was enqueued: a job that
 * waited behind another renders the document it actually starts against.
 *
 * A piano-roll clip may hold no render (lib/midiRender): it plays live and is
 * rendered here, before the graph is built. Every MIDI clip in `scope` without
 * a current render goes through the MIDI render queue one clip at a time
 * (state/midiRenderQueue clipsWithMidiAudio); a stale cache is re-rendered and
 * kept, and a clip with none is rendered for this bounce only. A job called off
 * while those renders run stops before the next one (`isCancelled`), and the
 * job drops its result as it always has. `release` frees the decoded audio of
 * the renders made for this bounce only; every job calls it once its bounce is
 * done, since the decode cache holds a buffer until someone says it is gone.
 */
interface BounceDeps extends RenderDeps {
  /** The master VST chain, read with the rest of the document: it prints
   *  after the master rack (lib/render/insertPrint). */
  masterVstChain: ChainEntry[];
  release: () => void;
}

/** True when a MIDI clip the bounce of `scope` plays sounds a sound bank preset its playback gain lifts above unity. */
const liftedVoiceIn = (clips: readonly AudioClip[], tracks: readonly EditorTrack[], scope: BounceScope): boolean => {
  const global = getGlobalVoice();
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return anyLiftedVoice(
    clipsInScope([...clips], scope)
      .filter((c) => !c.muted && isMidiClip(c))
      .map((c) => clipVoice(c, byId.get(c.trackId), global)),
  );
};

const currentRenderDeps = async (scope: BounceScope, isCancelled: () => boolean = () => false): Promise<BounceDeps> => {
  // A track whose instrument slot holds a VST3 prints its MIDI through that
  // plugin (lib/renderCore printInstrumentTracks), so its clips skip the
  // soundfont render. An external-only track's MIDI clips play on its MIDI out
  // device and are left out of the bounce (lib/renderCore isExternalMidiClip),
  // so they skip it too.
  const before = useEditorStore.getState();
  const instrumentTracks = new Set(instrumentTracksInScope(before.clips, before.tracks, scope).map((t) => t.id));
  const midi = await clipsWithMidiAudio(
    (c) =>
      clipsInScope([c], scope).length > 0 &&
      !(instrumentTracks.has(c.trackId) && isInstrumentClip(c)) &&
      !isExternalMidiClip(c, useEditorStore.getState().tracks),
    (n, total, label) => logInfo('editor', `Rendering MIDI for the bounce: ${n} of ${total} (${label})`),
    isCancelled,
  );
  const st = useEditorStore.getState();
  let print: InstrumentPrint;
  try {
    print = await printInstrumentTracks({ ...st, clips: midi.clips }, scope, renderInstrumentTrack, {
      global: getGlobalVoice(),
      sampleRate: BOUNCE_SAMPLE_RATE,
      isCancelled,
      onProgress: (n, total, name) => logInfo('editor', `Printing VST instruments for the bounce: ${n} of ${total} (${name})`),
      onWarning: (name, w) => logWarn('editor', `VST instrument on ${name}: ${w}`),
    });
  } catch (e) {
    midi.release();
    throw e;
  }
  return {
    clips: print.clips,
    tracks: st.tracks,
    masterFxChain: st.masterFxChain,
    masterVstChain: st.masterVstChain,
    automationLanes: st.automationLanes,
    routing: st.routing,
    buses: st.buses,
    decode: decodeClipBlob,
    buildChain: buildEffectChain,
    scheduleSources: liveMixer.scheduleClipSources,
    // A MIDI clip on a lifted sound bank preset: the bounce's master goes out through the safety limiter.
    ...(liftedVoiceIn(print.clips, st.tracks, scope) ? { safetyLimiter: safetyLimiterFor } : {}),
    release: () => {
      midi.release();
      for (const blob of print.printed) releaseDecoded(blob);
    },
  };
};

/** One plugin hop of an insert print: `/api/vst/process-file` with the
 *  entry's captured state, the host that captured it and the automation on its
 *  parameters. What the plugin did not take goes to the LOG, and a failure
 *  names the plugin and where it sits. */
const printHop: VstHop = async (wav, entry, where, automation) => {
  const vst = entry.vst as VstNode;
  const plugin = vst.plugin_name || entry.label || 'VST3';
  logInfo(
    'editor',
    automation.length > 0
      ? `Printing ${plugin} on ${where} with ${automation.length} automated parameter${automation.length === 1 ? '' : 's'}…`
      : `Printing ${plugin} on ${where}…`,
  );
  try {
    return await processFileThroughVst(wav, vst, 'insert-print.wav', {
      onWarning: (w) => logWarn('editor', `${plugin} on ${where}: ${w}`),
      automation,
    });
  } catch (e) {
    throw new Error(`${plugin} on ${where} could not be printed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * Bounce `request` over `deps` with every VST3 insert on every track, every
 * bus and the master VST chain printed in its place (lib/render/insertPrint),
 * then free the renders and prints made for it alone. Null when it was called
 * off part way.
 */
const bounceWithInserts = async (
  request: BounceRequest,
  deps: BounceDeps,
  isCancelled: () => boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<InsertPrintResult | null> => {
  const prints: Blob[] = [];
  try {
    return await renderWithInserts(request, deps, {
      hop: printHop,
      masterVstChain: deps.masterVstChain,
      isCancelled,
      onProgress,
      onPrinted: (wav) => prints.push(wav),
      // The plugin's own name for an automated parameter, as its live host listed it.
      paramName: (entryId, index) => useVstParamStore.getState().lists[entryId]?.find((p) => p.index === index)?.name,
    });
  } finally {
    deps.release();
    for (const wav of prints) releaseDecoded(wav);
  }
};

/** COMMIT EDIT's bounce, and the master half of a VST freeze. Everything: the
 *  master rack and every track's rack, the automation lanes, mute AND solo. */
export const mixdownRequest = (): BounceRequest => ({
  scope: { kind: 'master' },
  sampleRate: BOUNCE_SAMPLE_RATE,
  includeFx: true,
  includeAutomation: true,
  includeTrackMix: true,
  float32: false,
});

/** Send Selection to Init: the picked clips as they play. Each track's rack
 *  and VST3 inserts, the buses the graph routes them through, the master rack
 *  and the master VST chain, the automation and the track mix
 *  (lib/render/bounceWalksMix). Solo is ignored: this bounces exactly what was
 *  selected. The export dialog's clip selection asks for the same
 *  (exportDialogModel). */
export const selectionRequest = (clipIds: string[]): BounceRequest => ({
  scope: { kind: 'selection', clipIds },
  sampleRate: BOUNCE_SAMPLE_RATE,
  includeFx: true,
  includeAutomation: true,
  includeTrackMix: true,
  float32: false,
});

/**
 * A track stem: the track's RAW audio through its own rack, with the automation
 * of that rack's parameters baked in, and no track volume / pan / mute / solo,
 * because the timeline plays the printed stem back through the fader it was
 * already going through (a volume or pan lane is a lane on that fader, and the
 * render applies those only with the track mix). The rack's lanes have to be
 * in the stem: a freeze empties the live rack, so nothing else plays them.
 * Hosted VST3 entries print on the backend at their place in the chain, their
 * parameters moving as their lanes say (lib/render/insertPrint).
 *
 * `/api/vst/process-file` answers in float, and every hop is sent in float, so
 * a chain does not requantize between stages. `float32` is how the finished
 * stem is encoded: float when a plugin printed into it, since 16 bits would put
 * the loss back once at the end. With no plugins the stem goes straight to the
 * timeline, where 16-bit at half the size is the right answer.
 */
export const stemRequest = (trackId: string, hasHostedVsts: boolean): BounceRequest => ({
  scope: { kind: 'track', trackId },
  sampleRate: BOUNCE_SAMPLE_RATE,
  includeFx: true,
  includeAutomation: true,
  includeTrackMix: false,
  float32: hasHostedVsts,
});

/** The filename a mixdown lands under. A `mixdown` job's `label` IS this name —
 *  the runner reads it back to import and save — so the jobs pill says exactly
 *  what is being written. */
const mixdownTitle = (typed: string): string => {
  const trimmed = typed.trim();
  if (trimmed) return trimmed.endsWith('.wav') ? trimmed : `${trimmed}.wav`;
  return `mixdown_${String(Date.now()).slice(-6)}.wav`;
};

/** Attach the chunk-safety verdict for THIS request against the document it will
 *  render. The runner does not chunk (that is T11d, gated on this), but the jobs
 *  pill has to know whether a progress number is even possible before it shows
 *  an empty bar and calls it "0%".
 *
 *  `st.buses` rides the 5th argument because a master bounce now builds the BUS
 *  racks too (T14): the predicate has to judge every chain the render will
 *  actually put in the path, and a `chunkUnsafe` effect on a bus is exactly as
 *  unsafe as one on a track. `undefined` in the 4th slot keeps the default rack
 *  registry — the seam is there for tests, not for this call site. */
const bounceSeed = (
  seed: Omit<RenderJobSeed, 'chunkable' | 'chunkReasons'>,
): RenderJobSeed => {
  const st = useEditorStore.getState();
  const { safe, reasons } = bounceIsChunkSafe(
    seed.request, st.tracks, st.masterFxChain, undefined, st.buses,
  );
  return { ...seed, chunkable: safe, chunkReasons: reasons };
};

const enqueueBounce = (seed: Omit<RenderJobSeed, 'chunkable' | 'chunkReasons'>): string =>
  useRenderJobs.getState().enqueue(bounceSeed(seed));

const enqueueBounceAndWait = (
  seed: Omit<RenderJobSeed, 'chunkable' | 'chunkReasons'>,
): Promise<RenderJob> => useRenderJobs.getState().enqueueAndWait(bounceSeed(seed));

/** What each kind is called, for the pill and for a failure notice. */
const JOB_NOUN: Record<RenderJobKind, string> = {
  mixdown: 'Mixdown',
  selection: 'Selection bounce',
  stem: 'Track stem',
  freeze: 'Freeze',
  pattern: 'Pattern print',
  export: 'Export',
};

/**
 * Which kinds have stages a cancel can be noticed BETWEEN. A single
 * `OfflineAudioContext.startRendering()` exposes no checkpoint and no abort, so
 * a running mixdown or selection bounce cannot be stopped — only a queued one.
 * The freeze/stem flows hop through the backend one plugin at a time and check
 * between hops, so cancelling one of those really does stop it. A mixdown, an
 * export or a selection bounce that prints a VST3 insert has the same stages,
 * and says so by reporting progress (`RenderJobsPill` reads that as
 * cancellable too).
 */
const STAGED_KINDS: readonly RenderJobKind[] = ['stem', 'freeze'];

/** The disk destination the last SAVED mixdown landed on (D18), or `null`
 *  before the first one this session, or after one that was cancelled or
 *  fell back to a browser download. `runMixdownJob` reads it to default the
 *  next mixdown's Save As dialog onto the same file, and writes it back once
 *  a save actually lands on a real path — see `mixdownSaveTarget.ts`. */
let lastMixdownSaveTarget: MixdownSaveTarget | null = null;
/** The `seq` of whichever mixdown save last won the race to update
 *  `lastMixdownSaveTarget` (`shouldApplyMixdownSave`'s `lastAppliedSeq`),
 *  `-1` before any has. */
let lastAppliedMixdownSaveSeq = -1;
/** Assigns each mixdown job a distinct, increasing `seq`, captured once at
 *  the top of `runMixdownJob` — never assigned inside the `.then()` below,
 *  since two mixdowns queued back to back render independently and their
 *  never-awaited Save As dialogs can complete in EITHER order; `seq` records
 *  the order the jobs actually started running in, so `shouldApplyMixdownSave`
 *  can tell an older job's late-arriving save from a newer job's. */
let nextMixdownSaveSeq = 0;
/**
 * Whether the label a mixdown job runs under is TEXT THE USER TYPED into the
 * mixdown-name field ("explicit"), keyed by the job's own id — set by
 * `setMixdownJobExplicitName` right after `enqueueBounce` hands back the id,
 * read (and cleared) once by `runMixdownJob`. A caller-supplied FACT, not
 * something guessed from the label's text later: a user who happens to type
 * exactly the auto-generated `mixdown_<n>.wav` shape must still be treated
 * as explicit, which sniffing the text at save time cannot tell apart from
 * the real auto-generated fallback (`mixdownSaveOptions`'s whole point).
 *
 * `let`, not `const`: `setMixdownJobExplicitName` reassigns it to a PRUNED
 * map before every write (see there) — a job cancelled while still queued,
 * or dropped by the runner before `runMixdownJob` ever reads its entry,
 * would otherwise leak one entry into this map for the life of the tab.
 */
let mixdownJobExplicitName = new Map<string, boolean>();

/** Record whether `jobId`'s label is user-typed, pruning stale entries
 *  first: any id whose job is no longer queued/running in `useRenderJobs`
 *  (done, failed, cancelled, or aged out of the jobs list entirely) is
 *  dropped, so a job that never reaches `runMixdownJob`'s own read-and-
 *  delete does not leak its entry forever. */
const setMixdownJobExplicitName = (jobId: string, explicitName: boolean): void => {
  mixdownJobExplicitName = pruneMixdownJobExplicitNames(mixdownJobExplicitName, useRenderJobs.getState().jobs);
  mixdownJobExplicitName.set(jobId, explicitName);
};

/** COMMIT EDIT, end to end: the full-fidelity master bounce, then the library
 *  entry and the Save As that used to follow the `await` in `commitEdit`. */
const runMixdownJob = async (
  job: RenderJob,
  onProgress: (stage: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<RenderJobResult> => {
  // Captured at the top, before the (possibly long) render/save below, so it
  // reflects the order jobs actually started running in — see
  // `nextMixdownSaveSeq` and `shouldApplyMixdownSave`.
  const saveSeq = nextMixdownSaveSeq++;
  const explicitName = mixdownJobExplicitName.get(job.id) ?? false;
  mixdownJobExplicitName.delete(job.id);
  const st = useEditorStore.getState();
  const start = performance.now();
  logInfo('editor', `Mixing ${st.clips.length} clips on ${st.tracks.length} tracks…`);
  // A plugin dialled in live prints at the state it is at now.
  await captureLiveVstStates();
  const mixDeps = await currentRenderDeps(job.request.scope, isCancelled);
  // Called off while its MIDI clips rendered: nothing is bounced.
  if (isCancelled()) { mixDeps.release(); return {}; }
  const printed = await bounceWithInserts(job.request, mixDeps, isCancelled, onProgress);
  // Called off while the context was rendering or between plugin hops. Nothing
  // has been written yet, so stopping here really does stop it.
  if (!printed || isCancelled()) return {};
  const rendered = printed.buffer;
  const blob = encodeBounce(rendered, job.request);
  const title = job.label;
  await useLibraryStore.getState().importEntry({
    blob,
    filename: title,
    mimeType: 'audio/wav',
    metadata: {
      title,
      prompt: `Editor mixdown of ${st.clips.length} clips`,
      model: 'editor-mixdown',
      duration: rendered.duration,
      source: 'studio',
      tags: ['mixdown'],
    },
  });
  // Also put the file on disk. Save As opens in the folder last used for audio,
  // and — when a mixdown was already saved to a real path this session (D18) —
  // defaulted onto that SAME file, so confirming the dialog (its own overwrite
  // prompt included) re-writes it instead of navigating to a folder and typing
  // a fresh name from scratch. Not awaited, so the queue moves on to the next
  // job while the dialog is up: two mixdowns queued back to back can have
  // their saves land in EITHER order, so the remembered target is only
  // updated when this save's `saveSeq` is not older than whichever save last
  // won (`shouldApplyMixdownSave`) — an older job's save finishing late must
  // not clobber a newer job's fresher target. A cancel or a browser download
  // (`target === null`) always leaves the remembered target as it was.
  const { suggestedName, initialDir } = mixdownSaveOptions(title, explicitName, lastMixdownSaveTarget);
  void saveFile({
    blob,
    suggestedName: suggestedName.replace(/[<>:"/\\|?*]/g, '_'),
    initialDir,
    kind: 'audio',
  }).then((result) => {
    const target = mixdownSaveTargetFromPath(result.path, dirnameOf, basenameOf);
    if (target && shouldApplyMixdownSave(saveSeq, lastAppliedMixdownSaveSeq)) {
      lastMixdownSaveTarget = target;
      lastAppliedMixdownSaveSeq = saveSeq;
    }
  });
  const ms = (performance.now() - start).toFixed(0);
  logInfo('editor', `Mixdown complete: ${rendered.duration.toFixed(2)}s rendered in ${ms}ms → library + save`);
  return { blob, durationSec: rendered.duration };
};

/** Send Selection to Init: bounce the picked clips with every VST3 insert in
 *  their path printed (`bounceWithInserts`), hand the file to MAKE's params
 *  store, and show MAKE. */
const runSelectionJob = async (
  job: RenderJob,
  onProgress: (stage: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<RenderJobResult> => {
  const { scope } = job.request;
  const ids = scope.kind === 'selection' ? scope.clipIds : [];
  // A plugin dialled in live prints at the state it is at now.
  await captureLiveVstStates();
  const selectionDeps = await currentRenderDeps(scope, isCancelled);
  if (isCancelled()) { selectionDeps.release(); return {}; }
  const printed = await bounceWithInserts(job.request, selectionDeps, isCancelled, onProgress);
  if (!printed || isCancelled()) return {};
  const rendered = printed.buffer;
  const blob = encodeBounce(rendered, job.request);
  // Resolved AFTER the render, from the same document `renderBounce` just read,
  // so the labels describe what was actually bounced rather than what was
  // selected when the button was pressed.
  const clips = useEditorStore.getState().clips;
  const selected = ids
    .map((id) => clips.find((c) => c.id === id))
    .filter((c): c is AudioClip => !!c);
  const count = selected.length;
  const mixDur = rendered.duration;
  const fileName = count === 1
    ? `editor-clip-${Date.now()}.wav`
    : `editor-mashup-${count}clips-${Date.now()}.wav`;
  const summary = count === 1
    ? `Editor clip · ${mixDur.toFixed(2)}s`
    : `Editor mashup · ${count} clips · ${mixDur.toFixed(2)}s`;
  useGenerateParamsStore.getState().patch({
    initAudioFile: new File([blob], fileName, { type: 'audio/wav' }),
    initAudioEnabled: true,
    initAudioSourceLabel: summary,
    initAudioSourceClipLabels: selected.map((c) => c.label),
  });
  logInfo('editor', `Selection mashup sent to Init (${count} clip${count === 1 ? '' : 's'}, ${mixDur.toFixed(2)}s).`);
  // The same store action the `onSwitchTab` prop resolves to (Shell hands
  // DAWCenterPanel `navigateTo`); reached directly because a module-level run
  // function has no props.
  useAppUiStore.getState().navigateTo('create');
  return { blob, durationSec: mixDur };
};

/**
 * Delivers one export-dialog item's rendered blob per its chosen destination
 * (T25c) — the SAME two steps `runMixdownJob` above always performs
 * (`importEntry`, `saveFile`), just gated on the choice instead of hardcoded
 * to both. No new encoder or upload path: both calls are the app's existing
 * library-import and Save-As primitives.
 */
export const deliverExport = async (
  blob: Blob,
  durationSec: number,
  item: Pick<ExportRenderItem, 'label' | 'kind' | 'destination'>,
): Promise<void> => {
  const filename = item.label;
  let libraryFailed: string | undefined;
  if (item.destination === 'library' || item.destination === 'both') {
    // Its own try/catch (T25c finding 6): a library-import failure (provider
    // down, disk full) must not cancel the download half below — the user
    // asked for both, and a failed library write should still leave them the
    // file they could still have.
    try {
      await useLibraryStore.getState().importEntry({
        blob,
        filename,
        mimeType: 'audio/wav',
        metadata: {
          title: filename,
          prompt: `Editor export (${item.kind})`,
          model: 'editor-export',
          duration: durationSec,
          source: 'studio',
          tags: ['export'],
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      libraryFailed = message;
      logError('editor', `${filename}: library import failed — ${message}`);
    }
  }
  if (item.destination === 'download' || item.destination === 'both') {
    void saveFile({ blob, suggestedName: filename.replace(/[<>:"/\\|?*]/g, '_'), kind: 'audio' });
  }
  if (libraryFailed && item.destination === 'library') {
    throw new Error(`${filename}: library import failed — ${libraryFailed}`);
  }
};

/**
 * The export dialog's own render (T25c finding 5): bounce, encode, deliver —
 * the same `bounceWithInserts` + `encodeBounce` every job kind uses, run under the
 * QUEUE rather than called directly, so an export gets the FIFO serialisation
 * every other render gets (two `OfflineAudioContext`s never compete), a job
 * pill, a real cancel, and `runRenderJob`'s shared catch (toast + `logError`)
 * on failure — none of which a direct call bypassing the queue could offer.
 *
 * Not `mixdown` or `selection`: `mixdown` jobs (`runMixdownJob`) always write
 * to both the library and a Save As, ignoring the dialog's destination choice
 * (finding 3), and `selection` jobs (`runSelectionJob`) hand the blob to MAKE
 * and switch tabs — reusing either kind here would silently misroute or
 * ignore what the dialog actually asked for. `export` runs the bounce and
 * nothing else, then delivers exactly where `item.destination` says.
 *
 * The bounce prints every VST3 insert the request's fidelity puts in the path
 * (`bounceWithInserts`): each track's and each bus's, in chain order, and the
 * master VST chain after the master rack. The buffer stays float through every
 * plugin hop and is encoded once, in the format the dialog chose.
 */
const runExportJob = async (
  job: RenderJob,
  onProgress: (stage: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<RenderJobResult> => {
  if (job.destination === undefined) {
    throw new Error(`${job.label}: export job carries no destination`);
  }
  // A plugin dialled in live prints at the state it is at now.
  await captureLiveVstStates();
  const exportDeps = await currentRenderDeps(job.request.scope, isCancelled);
  if (isCancelled()) { exportDeps.release(); return {}; }
  const printed = await bounceWithInserts(job.request, exportDeps, isCancelled, onProgress);
  if (!printed || isCancelled()) return {};
  const rendered = printed.buffer;
  const blob = encodeBounce(rendered, job.request);
  await deliverExport(blob, rendered.duration, {
    label: job.label,
    kind: job.exportItemKind ?? 'mixdown',
    destination: job.destination,
  });
  return { blob, durationSec: rendered.duration };
};

/**
 * Runs one plan item from the export dialog (`exportDialogModel.buildRenderRequest`).
 * `item.range` sits beside `item.request` in the model rather than on it
 * (its header explains why) — merged onto the request here, the one place
 * that actually renders it.
 *
 * `stem` items reuse the EXISTING `stem` job kind (`runStemJob`, apply=false:
 * render + hosted-VST print, no timeline write) via `enqueueBounceAndWait`,
 * then deliver through `deliverExport` — a stem never had a delivery step of
 * its own before this dialog.
 *
 * `mixdown` and `selection` items BOTH go through the new `export` job kind
 * above (T25c finding 3 + finding 5) rather than the existing `mixdown` /
 * `selection` `RenderJobKind`s: those two are each hardcoded to a DIFFERENT
 * fixed behaviour (always-both-destinations; hand-off to MAKE) that has
 * nothing to do with what this dialog asks for, and reusing them would
 * misroute or ignore the user's choice. `export` also sidesteps
 * `runMixdownJob`'s remembered-Save-As-target tracking entirely (finding 4):
 * a dialog export never touches `mixdownJobExplicitName` or
 * `lastMixdownSaveTarget`, so there is no stale remembered filename for it to
 * collide with — `deliverExport`'s Save As always uses `item.label` as typed.
 */
export const runExportPlanItem = async (item: ExportRenderItem): Promise<void> => {
  const request: BounceRequest = item.range ? { ...item.request, range: item.range } : item.request;
  if (item.kind === 'stem') {
    const job = await enqueueBounceAndWait({
      kind: 'stem', label: item.label, trackId: item.trackId, request, range: item.range ?? undefined,
    });
    if (job.status === 'done' && job.result?.blob) {
      try {
        await deliverExport(job.result.blob, job.result.durationSec ?? 0, item);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        requireFeature({
          id: `render:failed:${item.kind}`,
          kind: 'error',
          title: `${JOB_NOUN.export} failed`,
          message,
          autoDismissMs: 10000,
        });
      }
    }
    return;
  }
  await enqueueBounceAndWait({
    kind: 'export',
    label: item.label,
    request,
    range: item.range ?? undefined,
    destination: item.destination,
    exportItemKind: item.kind,
  });
};

/** A MIDI-format export (lib/arrangementMidi): the arrangement's notes written
 *  and saved, no render; a refusal (no notes, a cancelled Save As) is shown as
 *  the render failures are. */
export const runMidiExportItem = async (item: MidiExportItem): Promise<void> => {
  const outcome = await exportArrangementMidi({ scope: item.scope, range: item.rangeSec, name: item.label });
  if (!outcome.ok) {
    logWarn('editor', outcome.error);
    requireFeature({ id: 'render:failed:midi', kind: 'error', title: 'MIDI export', message: outcome.error, autoDismissMs: 10000 });
  }
};

/** Fires every item in an export-dialog plan. Each item runs independently —
 *  one stem failing (logged by `runRenderJob`'s own catch, for the two kinds
 *  that go through the queue) does not stop the others. */
export const runExportPlan = (plan: ExportRenderPlan): void => {
  for (const item of plan.items) void runExportPlanItem(item);
  for (const item of plan.midiItems) void runMidiExportItem(item);
};

/**
 * A freeze, master or per-track — structurally one thing: bounce offline with
 * every hosted VST3 insert printed in its place (`bounceWithInserts`), then
 * apply.
 *
 * `job.trackId` is what tells them apart. With one, this is a track freeze: the
 * stem's own rack, its plugins among its rack effects in the order the chain
 * has them, a peaks pass, and `freezeTrack`. Without one, it is the master VST
 * freeze: the full-fidelity master bounce, every track's and bus's plugins
 * printed, then the master VST chain, into `frozenMaster`.
 *
 * `apply` is false for a bare `stem` job — the render and the print happen, the
 * timeline is not touched — which is the only difference between the two kinds.
 *
 * STAGES: every render and every plugin hop of the print, + 1 for the peaks
 * pass a printed stem needs. Those are the checkpoints a cancel is noticed at,
 * and the only real progress any render in this app can report (see
 * `renderJobs`).
 */
const runStemJob = async (
  job: RenderJob,
  onProgress: (stage: number, total: number) => void,
  isCancelled: () => boolean,
  apply: boolean,
): Promise<RenderJobResult> => {
  const { trackId } = job;
  const isTrack = trackId !== undefined;

  // A track freeze replaces what the transport is playing, so it stops first.
  // The master freeze does not: re-rendering a stale frozen master while the
  // live mix plays is a normal thing to do, and it never did stop it.
  if (isTrack && apply) usePlayerStore.getState().stop();

  // A plugin dialled in live prints at the state it is at now.
  await captureLiveVstStates();
  const deps = await currentRenderDeps(job.request.scope, isCancelled);
  if (isCancelled()) { deps.release(); return {}; }
  // The request is REBUILT from the chain resolved just now, not taken as it
  // was enqueued. `float32` is the one field that depends on the plugin chain,
  // and a queued job can sit through the user adding a VST3 to the track —
  // encoding that stem at 16 bits after a backend hop would quantize it once
  // for nothing. Rebuilt through the same tested builder the caller used, so
  // the rule lives in exactly one place.
  const hosted = isTrack && (deps.tracks.find((t) => t.id === trackId)?.fxChain ?? []).some(printsThroughHost);
  const request = isTrack ? { ...job.request, float32: job.request.float32 || hosted } : job.request;
  // The freeze signature is taken HERE rather than at enqueue: the queue may
  // have held this job, and what the frozen master is a render OF is the
  // document the bounce below is about to read. That is the document as it
  // stands after its MIDI clips rendered: a stale cached render the renders
  // just replaced is not an edit, and a signature taken before them would call
  // the new frozen master stale the moment it landed.
  const now = useEditorStore.getState();
  const sig = isTrack ? '' : documentFreezeSignature(now, getGlobalVoice());
  // Measured from the SAME clips the bounce below reads (its MIDI clips with
  // their renders, ring-out included), as the stem renderer always did. The
  // master branch reports the rendered buffer's own duration instead and never
  // looks at this.
  const durationSec = isTrack ? renderExtentSec(deps.clips, request.scope) : 0;
  // The peaks pass is one stage more than the print reports.
  const extra = isTrack ? 1 : 0;
  let total = 1 + extra;
  const printed = await bounceWithInserts(request, deps, isCancelled, (done, of) => {
    total = of + extra;
    onProgress(done, total);
  });
  if (!printed || isCancelled()) return {};
  const rendered = printed.buffer;
  const fileName = isTrack ? 'track-stem.wav' : 'edit-master.wav';
  // How the finished file is encoded, once. A freeze lands on the timeline and
  // keeps float wherever a plugin printed into it. A stem the export dialog
  // asked for (`apply` false) is written in the format the dialog chose.
  const float32 = apply ? request.float32 || printed.hops > 0 : job.request.float32;
  const file = new File([encodeBounce(rendered, { float32 })], fileName, { type: 'audio/wav' });

  if (!isTrack) {
    if (apply) {
      useEditorStore.getState().setFrozenMaster({ blob: file, sig });
      logInfo('editor', `VST freeze rendered through ${printed.hops} plugin hop(s).`);
    }
    return { blob: file, durationSec: rendered.duration };
  }

  // The clips' extent, or the whole print when a plugin rang out past them.
  const heldSec = printedStemSec(durationSec, rendered);
  let peaks: Float32Array | undefined;
  if (apply) {
    ({ peaks } = await computePeaks(file, 240));
  }
  onProgress(total, total);
  if (isCancelled()) return {};
  if (apply) {
    useEditorStore.getState().freezeTrack(trackId, { audioBlob: file, durationSec: heldSec, peaks });
    liveMixer.reactivate();
    logInfo('editor', 'Track frozen — VST FX printed into the stem.');
  }
  return { blob: file, durationSec: apply ? heldSec : rendered.duration, peaks };
};

/**
 * The app's one render runner runs THIS. Started in `App.tsx`, which reaches it
 * through a dynamic import so mounting the runner does not drag the whole EDIT
 * chunk into the first-paint bundle.
 *
 * A failure is toasted from here rather than from a subscription in the
 * component, because EDIT unmounts on every tab switch and a render started
 * from EDIT outlives it. The throw is re-raised either way, so the store still
 * records the message on the job.
 */
export async function runRenderJob(
  job: RenderJob,
  onProgress: (stage: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<RenderJobResult> {
  try {
    if (job.kind === 'mixdown') return await runMixdownJob(job, onProgress, isCancelled);
    if (job.kind === 'selection') return await runSelectionJob(job, onProgress, isCancelled);
    if (job.kind === 'export') return await runExportJob(job, onProgress, isCancelled);
    if (job.kind === 'stem' || job.kind === 'freeze') {
      return await runStemJob(job, onProgress, isCancelled, job.kind === 'freeze');
    }
    throw new Error('the step sequencer prints its own patterns; they are not on the render queue');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!isCancelled()) {
      logError('editor', `${job.label} failed: ${message}`);
      requireFeature({
        id: `render:failed:${job.kind}`,
        kind: 'error',
        title: `${JOB_NOUN[job.kind]} failed`,
        message,
        autoDismissMs: 10000,
      });
    }
    throw e;
  }
}

/**
 * The jobs pill: what is rendering, how far in, how many are waiting, and the
 * one honest cancel. Its own component so a progress tick re-renders 40px of
 * toolbar rather than the whole timeline.
 *
 * The bar is INDETERMINATE unless a stage has actually reported — a single
 * offline context has no progress to read, and drawing an empty bar labelled 0%
 * would be an invention. When the store also knows the render could not have
 * been chunked (`chunkable === false`), the bar says so on hover instead of
 * leaving the user to wonder why it never moves.
 */
const RenderJobsPill: React.FC = () => {
  const jobs = useRenderJobs((s) => s.jobs);
  const cancel = useRenderJobs((s) => s.cancel);
  const clearFinished = useRenderJobs((s) => s.clearFinished);

  const active = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued');
  const live = active ?? queued[0];
  const finishedCount = jobs.length - queued.length - (active ? 1 : 0);
  if (!live && finishedCount === 0) return null;

  if (!live) {
    return (
      <div className="flex items-center gap-1.5 rounded border border-white/10 bg-black/40 px-2 py-0.5">
        <span className="text-xs font-bold text-zinc-500 tabular-nums">
          {finishedCount} render{finishedCount === 1 ? '' : 's'} finished
        </span>
        <button
          type="button"
          onClick={clearFinished}
          aria-label="Clear finished renders"
          title="Clear finished renders"
          className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  const determinate = live.progress > 0;
  const unknowable = !determinate && live.chunkable === false;
  const pending = active ? queued.length : queued.length - 1;
  // A job that has reported a stage has checkpoints between its stages.
  const cancellable = live.status === 'queued' || STAGED_KINDS.includes(live.kind) || determinate;

  return (
    <div
      aria-busy
      className="flex items-center gap-1.5 rounded border border-purple-500/30 bg-purple-500/10 px-2 py-0.5"
    >
      <Loader2 className={`w-3 h-3 text-purple-300 ${active ? 'animate-spin' : 'opacity-50'}`} />
      <span className="text-xs font-bold tabular-nums text-purple-100 max-w-32 truncate" title={live.label}>
        {live.label}
      </span>
      <progress
        id="render-progress"
        aria-label={`${JOB_NOUN[live.kind]} progress`}
        max={1}
        {...(determinate ? { value: live.progress } : {})}
        title={unknowable ? 'no progress available for this render' : undefined}
        className="w-16 h-1 align-middle accent-purple-400"
      />
      {pending > 0 && (
        // The active job is usually a single offline context and cannot be
        // interrupted, so the queue needs its own way out: this takes the job
        // off the BACK, which is what a double-pressed COMMIT EDIT put there.
        <button
          type="button"
          onClick={() => cancel(queued[queued.length - 1].id)}
          aria-label="Cancel the last queued render"
          title="Cancel the render at the back of the queue"
          className="text-xs font-bold text-purple-300/70 tabular-nums rounded px-1 hover:text-white hover:bg-white/10"
        >
          +{pending} queued
        </button>
      )}
      <button
        type="button"
        onClick={() => cancel(live.id)}
        disabled={!cancellable}
        aria-label="Cancel render"
        title={cancellable
          ? 'Cancel this render'
          : 'This render is one offline context — it cannot be interrupted once it has started'}
        className="p-0.5 rounded text-purple-200 hover:text-white hover:bg-white/10 disabled:opacity-30"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
};

/**
 * A track's freeze button. Its own component because it reads only THIS track's
 * job: a freeze on another track queues behind this one rather than blocking it,
 * so the button has to stay live while an unrelated freeze runs — which the one
 * shared `isFreezing` boolean could not express.
 */
const TrackFreezeButton: React.FC<{
  trackId: string;
  trackName: string;
  frozen: boolean;
  onFreeze: (trackId: string) => void;
  onUnfreeze: (trackId: string) => void;
}> = ({ trackId, trackName, frozen, onFreeze, onUnfreeze }) => {
  const job = useRenderJobs((s) => s.jobs.find(
    (j) => j.kind === 'freeze'
      && j.trackId === trackId
      && (j.status === 'queued' || j.status === 'running'),
  ));
  const running = job?.status === 'running';
  const queued = job?.status === 'queued';
  const label = frozen
    ? `Unfreeze track ${trackName}`
    : queued
      ? `Freeze track ${trackName} — queued`
      : `Freeze track ${trackName} to print VST FX`;
  return (
    <button
      type="button"
      onClick={() => (frozen ? onUnfreeze(trackId) : onFreeze(trackId))}
      // One freeze per track at a time: a second would print the same stem.
      disabled={!!job}
      aria-label={label}
      aria-pressed={frozen}
      aria-busy={running || queued}
      title={running
        ? 'Freezing — printing the plugin chain'
        : queued
          ? 'Queued — waiting for the render ahead of it'
          : frozen
            ? 'Unfreeze (restore live clips + FX)'
            : 'Freeze: print VST3/effects into audio so the plugin is audible'}
      className={`w-4 h-4 rounded flex items-center justify-center border disabled:opacity-40 ${frozen ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50' : 'bg-black/40 text-zinc-500 border-white/5 hover:text-white'}`}
    >
      {running ? (
        <Loader2 className="w-2 h-2 animate-spin" />
      ) : queued ? (
        <Snowflake className="w-2 h-2 animate-pulse" />
      ) : (
        <Snowflake className="w-2 h-2" />
      )}
    </button>
  );
};

/* -------------------------------------------------------------------------- */
/*                      the track header's record controls                    */
/* -------------------------------------------------------------------------- */

/**
 * The two narrow reads the record controls make of `recordingStore`, exported
 * so `WaveformEditorRecordArm.test.ts` can pin their equality (the whole reason
 * the meter is its own component — see there).
 */
export const selectRecordingStatus = (s: { status: RecordingStatus }): RecordingStatus => s.status;
export const selectTrackLevel =
  (trackId: string) =>
  (s: { levels: Record<string, LevelFrame> }): LevelFrame | undefined =>
    s.levels[trackId];

/** Arming is the engine's between-passes business; locked for every live state. */
export const armingLocked = (status: RecordingStatus): boolean => status !== 'idle';

/** Why the arm dot is dead mid-pass. One string, so the title and the reason agree. */
const ARMING_LOCKED_TITLE = 'Stop recording to change arming';

/**
 * The count-in announcement for the PASS. One region for the whole header
 * column, mounted next to the track list rather than inside it.
 *
 * Per-track would mean N regions announcing N times for one count, none of them
 * saying which track — and a count-in counts the pass in, not a track. The node
 * is always in the accessibility tree and only its TEXT changes: a live region
 * has to exist before the change for the change to be announced, and `sr-only`
 * (clipped, not `display:none`) is what keeps it there while it is empty. The
 * status moves to `counting` once per press, so that is one announcement per
 * pass.
 */
const CountInAnnouncement: React.FC = () => {
  const status = useRecordingStore(selectRecordingStatus);
  return (
    <span aria-live="polite" className="sr-only">
      {status === 'counting' ? 'Count-in' : ''}
    </span>
  );
};

/**
 * A track's record-arm dot, and the count-in chip beside it.
 *
 * Its own component for the same reason `TrackFreezeButton` is: it reads the
 * recording status, and the editor must not. Arming is disabled while a pass is
 * live because `recordingStore` mirrors the `armed` flags onto the engine as
 * they flip, and the engine only opens and closes inputs BETWEEN passes — a
 * track armed mid-take would have no recorder and would silently record
 * nothing. The dot pulses while the take rolls, which is the one place in the
 * header that says "this track is being recorded right now".
 *
 * The chip is `aria-hidden`: it is the eyes' copy of what
 * `CountInAnnouncement` already said once for the pass. The locked reason is
 * folded into the button's NAME as well as its `title`, the way the footer's
 * RECORD key carries `RECORD_NEEDS_ARM` — a disabled control's tooltip never
 * reaches a screen reader.
 */
const TrackArmButton: React.FC<{
  trackName: string;
  armed: boolean;
  onToggle: () => void;
}> = ({ trackName, armed, onToggle }) => {
  const status = useRecordingStore(selectRecordingStatus);
  const locked = armingLocked(status);
  const counting = armed && status === 'counting';
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        disabled={locked}
        aria-label={locked ? `${trackName} record arm — ${ARMING_LOCKED_TITLE}` : `${trackName} record arm`}
        aria-pressed={armed}
        title={locked ? ARMING_LOCKED_TITLE : 'Arm for recording'}
        className={`w-4 h-4 rounded-full flex items-center justify-center border disabled:opacity-40 ${armed ? 'bg-red-500/30 text-red-400 border-red-500/60' : 'bg-black/40 text-zinc-500 border-white/10 hover:text-white'}`}
      >
        <Circle
          className={`w-2 h-2 ${armed ? 'fill-red-500' : ''} ${armed && status === 'recording' ? 'animate-pulse' : ''}`}
        />
      </button>
      {counting && (
        <span
          aria-hidden="true"
          className="text-xs font-bold uppercase tracking-wider text-red-400 shrink-0"
        >
          count-in
        </span>
      )}
    </>
  );
};

/**
 * The take meter for ONE armed track, live for the length of a pass.
 *
 * Shape borrowed from the confidence meter in `sing/LyricAnalysisPane.tsx` (a
 * `role="meter"` strip over a `bg-white/10` groove) and the colours from the arm
 * dot right above it: an RMS fill for the body of the signal and a thin peak
 * tick, so a take that is clipping reads before the fill catches up.
 *
 * `levels[trackId]` is the only thing it subscribes to, so the twenty writes a
 * second `recordingStore` makes during a pass re-render this strip and nothing
 * else — not the other tracks' strips, not the header, not the timeline.
 */
const TrackInputMeter: React.FC<{ trackId: string; trackName: string }> = ({ trackId, trackName }) => {
  const status = useRecordingStore(selectRecordingStatus);
  const frame = useRecordingStore(selectTrackLevel(trackId));
  if (status === 'idle') return null;
  const peak = clampFrac(frame?.peak ?? 0);
  const rms = clampFrac(frame?.rms ?? 0);
  return (
    <div
      role="meter"
      aria-label={`${trackName} input level`}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={peak}
      aria-valuetext={`${Math.round(peak * 100)} percent`}
      className="relative h-1 w-full overflow-hidden rounded-xs bg-white/10"
    >
      <i className="absolute inset-y-0 left-0 block bg-red-500/60" style={{ width: `${rms * 100}%` }} />
      <i className="absolute inset-y-0 w-0.5 bg-red-400" style={{ left: `calc(${peak * 100}% - 1px)` }} />
    </div>
  );
};

/**
 * Draw a MIDI clip's notes inside the clip body (FL-style playlist preview).
 * X maps note time (relative to the clip's source offset) to pixels via `zoom`;
 * Y stacks pitches lowest-to-highest across the body. Velocity sets brightness.
 * Read-only — editing happens in the Piano Roll (double-click / context menu).
 */
/**
 * ClipWave — the DJ-style semantic waveform for a timeline audio clip. Renders
 * only the clip's trim window of its source audio (viewport mapped from
 * offsetIntoSource/sourceDuration). Shares one object URL per source Blob
 * (`lib/sharedObjectUrl`), revoked a few seconds after the last clip using it
 * unmounts. No per-clip playhead — the timeline draws a global one over clips.
 *
 * `normalize={false}` (D16): the EDIT timeline draws every clip at its
 * ABSOLUTE amplitude, not scaled up to fill the lane by each clip's own
 * peak — REAPER's intent, and the one this app matches, so a quiet clip
 * draws SMALLER than a loud one, both readable against each other at a
 * glance. This is not a promise of linear pixels: `drawWaveform`'s own
 * gamma curve (`pow(peak, 0.58)`, floored at 0.72) still applies on top, so
 * a -20 dBFS clip draws roughly twice as tall as a linear mapping would give
 * it — only the ORDERING (quiet < loud) is what `normalize` controls here.
 * The DJ decks (a different surface, a different job: cueing one track at a
 * time, not comparing levels across an arrangement) keep `SemanticWave`'s
 * own default of `true`.
 *
 * `showModeToggle={false}`: the clip body carries the trim handles, the fade
 * grips and the inpaint drag target, and a narrow clip is all body. The
 * colour mode toggle lives in the EDIT toolbar instead.
 */
const ClipWave: React.FC<{ clip: AudioClip; height: number; selected: boolean }> = ({ clip, height, selected }) => {
  // One object URL per source Blob, acquired inside the effect that releases
  // it. The URL is the waveform decode cache's key, so a fresh URL per mount
  // made every remount a second fetch and decode and filled the cache with
  // keys nobody read again. Releasing only schedules the revoke: StrictMode's
  // mount -> cleanup -> remount gets the same, still-live URL back (revoking
  // on cleanup is what once left every clip blank with "Failed to fetch").
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // A MIDI clip with no render has no waveform; its notes are drawn instead.
    if (!clip.audioBlob) { setUrl(null); return undefined; }
    const shared = acquireObjectUrl(clip.audioBlob);
    setUrl(shared.url);
    return () => {
      setUrl((current) => (current === shared.url ? null : current));
      shared.release();
    };
  }, [clip.audioBlob]);
  const dur = clip.sourceDuration > 0 ? clip.sourceDuration : clip.durationSec || 1;
  const viewportStart = clampFrac((clip.offsetIntoSource ?? 0) / dur);
  // The slice the clip plays is measured in SOURCE seconds, and a stretched
  // clip covers `rate` of them per second of timeline — `durationSec` alone
  // would draw the wrong span of the file under a stretched clip.
  const viewportEnd = clampFrac(((clip.offsetIntoSource ?? 0) + clipSourceSpanSec(clip)) / dur);
  return (
    <div className="h-full w-full" style={{ opacity: selected ? 1 : 0.85 }}>
      {url && (
        <SemanticWave audioUrl={url} height={height} viewportStart={viewportStart} viewportEnd={Math.max(viewportStart + 1e-4, viewportEnd)} transparentBg normalize={false} showModeToggle={false} />
      )}
    </div>
  );
};

const clampFrac = (n: number) => (Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0);

/** Push a context-menu separator only where one is worth drawing: not as the
 *  first row, and never straight after another separator. Whole groups in the
 *  clip menu are conditional (no clip under the pointer, no crossfade pair, no
 *  fade to shape, no stretch to reset), so the separators around them can
 *  otherwise end up stacked with nothing between them. */
const pushSeparator = (items: ContextMenuItem[]): void => {
  const last = items[items.length - 1];
  if (!last || last.type === 'separator') return;
  items.push({ type: 'separator' });
};

/** The track instrument select's value for an external-only track (EditorTrack externalOnly). */
const EXTERNAL_ONLY_VALUE = 'external';

/**
 * Compact per-track instrument selector (channel-rack style). "Default" leaves
 * the track on the global Piano Roll instrument; picking a GM program assigns it
 * to the track, which makes its MIDI clips play that voice live on the timeline.
 *
 * The drum key beside it makes the track a percussion track: its MIDI clips
 * play and render on the General MIDI drum channel, where a note is a drum and
 * the program picks the kit. The list holds the instruments and the kits, the
 * track's own kind first: choosing a kit on a melodic track turns the drum flag
 * on, and choosing an instrument on a drum track turns it off, one undo step
 * with a LOG line (editorStore setTrackVoice).
 *
 * The status after it (a dot and one word) says how the track's MIDI sounds on
 * the next play: Live, on EDIT's synths on the audio clock
 * (lib/editMidiScheduler), or Bounce, its rendered audio; its title says why
 * and how many channels a live track holds.
 *
 * The sound banks' presets follow, by bank (bankPresetOptions): a bank
 * preset sets the track's program with the bank it is picked from, and a
 * user bank's kit is a kit of the track's kind (its value starts `kit|`).
 * The cable key beside the drum key opens the track's MIDI output (a port,
 * its channel, clock) and its per-note expression channels (TrackMidiOut).
 * "External only" plays the track through that port alone: EDIT schedules
 * its notes to the port and no synth of theDAW's sounds them; its status
 * reads Port.
 */
export const TrackInstrumentSelect: React.FC<{ track: EditorTrack; status?: liveMixer.LiveMidiTrackStatus }> = ({ track, status }) => {
  const setTrackVoice = useEditorStore((s) => s.setTrackVoice);
  const globalProgram = useSoundfontStore((s) => s.activeProgram);
  const globalSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const drums = isPercussionTrack(track);
  const { banks, warm } = useSoundBanks();
  const trackRef: InstrumentRef | null = track.instrumentProgram === undefined
    ? null
    : { bankId: track.instrumentBankId ?? BUNDLED_BANK_ID, bank: track.instrumentBank ?? 0, program: track.instrumentProgram };
  const refValue = trackRef && isBankPreset(trackRef) ? `${drums ? 'kit|' : ''}${instrumentRefValue(trackRef)}` : null;
  const value = track.externalOnly ? EXTERNAL_ONLY_VALUE : refValue ?? voiceValue(track.instrumentProgram, drums);
  const defaultLabel = drums
    ? `Default (${drumKitName(0)} kit)`
    : globalSoundfont ? `Default (${gmShortName(globalProgram)})` : 'Default (Basic)';

  const updateTrack = useEditorStore((s) => s.updateTrack);
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === EXTERNAL_ONLY_VALUE) {
      // Its MIDI out port alone plays it: no program of theDAW's (TrackMidiOut picks the port).
      updateTrack(track.id, { externalOnly: true, instrumentProgram: undefined, instrumentBank: undefined, instrumentBankId: undefined });
      return;
    }
    const kit = v.startsWith('kit|');
    const ref = parseInstrumentRefValue(kit ? v.slice(4) : v);
    if (ref) {
      setTrackVoice(track.id, ref.program, kit, { bankId: ref.bankId, bank: ref.bank });
      void ensureSoundfontReady();
      return;
    }
    const pick = parseVoiceValue(v, drums);
    setTrackVoice(track.id, pick.program, pick.drums);
    if (pick.program !== undefined) void ensureSoundfontReady(); // warm worklet + soundfont while the user looks
  };
  const kits = (
    <optgroup key="kits" label="Drum kits">
      {GM_DRUM_KITS.map((k) => <option key={k.program} value={voiceValue(k.program, true)}>{`${k.name} kit`}</option>)}
      {/* A program the kit list lacks (set by the assistant) stays listed, so the select shows what the track holds. */}
      {drums && track.instrumentProgram !== undefined && !GM_DRUM_KITS.some((k) => k.program === track.instrumentProgram) && (
        <option value={voiceValue(track.instrumentProgram, true)}>{`${drumKitName(track.instrumentProgram)} kit`}</option>
      )}
    </optgroup>
  );
  const instruments = (
    <optgroup key="instruments" label="Instruments">
      {GM_NAMES.map((nm, i) => <option key={nm} value={voiceValue(i, false)}>{`${i + 1}. ${nm}`}</option>)}
    </optgroup>
  );
  const bankPresets = [
    <BankPresetOptions key="bank-instruments" drums={false} />,
    <BankPresetOptions key="bank-kits" drums valuePrefix="kit|" skipBundledKits={GM_DRUM_KITS.map((k) => k.program)} />,
  ];
  // A bank preset whose bank is not listed (yet, or any more) stays listed, so the select shows what the track holds.
  const unlisted = refValue && trackRef && !presetName(banks, trackRef, drums)
    ? <option key="unlisted" value={refValue}>{`Bank ${trackRef.bank} · ${trackRef.program + 1}`}</option>
    : null;

  // A program means an instrument on a melodic track and a kit on a drum
  // track, so switching clears the track's and its clips' programs and they
  // start on their defaults (editorStore setTrackPercussion).
  const setTrackPercussion = useEditorStore((s) => s.setTrackPercussion);
  const toggleDrums = () => {
    setTrackPercussion(track.id, !drums);
    void ensureSoundfontReady();
  };

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={toggleDrums}
        aria-pressed={drums}
        aria-label={`Track ${track.name} is a drum track`}
        title={drums ? 'Drum track: notes play drums on the drum channel' : 'Make this a drum track'}
        className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${drums ? 'bg-amber-500/30 text-amber-300 border-amber-500/60' : 'bg-black/40 text-zinc-500 border-white/10 hover:text-white'}`}
      >
        {drums ? <Drum aria-hidden="true" className="w-3 h-3" /> : <Piano aria-hidden="true" className="w-3 h-3" />}
      </button>
      {/* The track's MIDI output port, clock and per-note expression channels. */}
      <TrackMidiOut track={track} />
      <label htmlFor={`editor-track-instrument-${track.id}`} className="sr-only">{`Track ${track.name} ${drums ? 'drum kit' : 'instrument'}`}</label>
      <select
        id={`editor-track-instrument-${track.id}`}
        name={`editor-track-instrument-${track.id}`}
        value={value}
        onChange={onChange}
        onFocus={warm}
        className="flex-1 min-w-0 form-select px-1 py-0.5 text-xs font-bold"
        style={{ colorScheme: 'dark' }}
      >
        <option value={DEFAULT_VOICE_VALUE}>{defaultLabel}</option>
        <option value={EXTERNAL_ONLY_VALUE}>{track.midiOut ? `External only (${track.midiOut.label})` : 'External only (MIDI out port)'}</option>
        {drums ? [kits, instruments] : [instruments, kits]}
        {bankPresets}
        {unlisted}
      </select>
      {status && (
        <span
          className={`flex items-center gap-1 shrink-0 font-sans text-xs font-bold ${status.external ? 'text-sky-300' : status.mode === 'live' ? 'text-emerald-300' : 'text-zinc-400'}`}
          title={status.reason}
        >
          <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${status.external ? 'bg-sky-400' : status.mode === 'live' ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
          {status.external ? 'Port' : status.mode === 'live' ? 'Live' : 'Bounce'}
          <span className="sr-only">{`: ${status.reason}`}</span>
        </span>
      )}
      <TrackReverbSendInput track={track} />
    </div>
  );
};

/**
 * The track's synth reverb send (CC 91, EditorTrack synthReverbSend): what
 * every MIDI channel of the track opens with live and in the MIDI export.
 * Blank leaves the synth its own; the symphony template sets 0 so the hall
 * send is the only reverb. Each change is an undo step of its own.
 */
export const TrackReverbSendInput: React.FC<{ track: EditorTrack }> = ({ track }) => {
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const id = `editor-track-reverb-send-${track.id}`;
  const value = track.synthReverbSend;
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim();
    const n = Number(raw);
    const next = raw === '' || !Number.isFinite(n) ? undefined : Math.max(0, Math.min(127, Math.round(n)));
    if (next === value) return;
    beginUndoStep();
    updateTrack(track.id, { synthReverbSend: next });
  };
  return (
    <>
      <label htmlFor={id} className="font-sans text-xs font-bold text-zinc-400 shrink-0" title="Synth reverb send (CC 91). Blank: the synth's own. 0: off, for a hall send.">
        Rev
        <span className="sr-only">{` — track ${track.name} synth reverb send, CC 91, 0 to 127, blank for the synth's own`}</span>
      </label>
      <input
        id={id}
        name={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={127}
        step={1}
        value={value ?? ''}
        placeholder="—"
        onChange={onChange}
        className="w-11 shrink-0 bg-black/40 border border-(--panel-border) rounded px-1 py-0.5 font-sans text-xs font-bold text-white tabular-nums outline-none focus:border-purple-500"
        style={{ colorScheme: 'dark' }}
      />
    </>
  );
};

/**
 * Per-clip instrument override. "Track default" leaves the clip on its track's
 * instrument (or the global one); picking a GM program assigns it to this clip
 * only, so its MIDI notes play that voice live regardless of the track default.
 * On a drum track the list is the drum kits. The sound banks' presets follow,
 * by bank: a bank preset sets the clip's program with its bank and bank
 * select (AudioClip instrumentBankId, instrumentBank).
 */
export const ClipInstrumentSelect: React.FC<{ clip: AudioClip }> = ({ clip }) => {
  const updateClip = useEditorStore((s) => s.updateClip);
  const track = useEditorStore((s) => s.tracks.find((t) => t.id === clip.trackId));
  const globalProgram = useSoundfontStore((s) => s.activeProgram);
  const globalSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const drums = isPercussionTrack(track);
  const { banks, warm } = useSoundBanks();
  const clipRef: InstrumentRef | null = clip.instrumentProgram === undefined
    ? null
    : { bankId: clip.instrumentBankId ?? BUNDLED_BANK_ID, bank: clip.instrumentBank ?? 0, program: clip.instrumentProgram };
  // A bank preset shows by its bank value; a bundled program in a Bank the bundled bank does not list shows as the program, its Bank beside it.
  const refValue = clipRef && (clipRef.bankId !== BUNDLED_BANK_ID || (clipRef.bank > 0 && presetName(banks, clipRef, drums)))
    ? instrumentRefValue(clipRef)
    : null;
  const value = refValue ?? (clip.instrumentProgram === undefined ? 'default' : String(clip.instrumentProgram));
  const effective = clipVoice({}, track, { useSoundfont: globalSoundfont, activeProgram: globalProgram }).program;
  const defaultLabel = effective === undefined
    ? 'Track default (Basic)'
    : `Track default (${drums ? `${drumKitName(effective)} kit` : gmShortName(effective)})`;

  // A bank belongs to the program it was chosen with (a roll part's Bank, lib/clipProgram clipBank), so a new pick drops it.
  // The badge is the clip's own program's bank select; a clip on its track's program shows none.
  const bank = clip.instrumentProgram !== undefined ? clipBank(clip, track) : 0;
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'default') {
      updateClip(clip.id, { instrumentProgram: undefined, instrumentBank: undefined, instrumentBankId: undefined });
      return;
    }
    const ref = parseInstrumentRefValue(v);
    if (ref) {
      updateClip(clip.id, {
        instrumentProgram: ref.program,
        instrumentBank: ref.bank > 0 ? ref.bank : undefined,
        instrumentBankId: ref.bankId === BUNDLED_BANK_ID ? undefined : ref.bankId,
      });
      void ensureSoundfontReady();
      return;
    }
    updateClip(clip.id, { instrumentProgram: Number(v), instrumentBank: undefined, instrumentBankId: undefined });
    void ensureSoundfontReady(); // warm worklet + soundfont while the user looks
  };

  return (
    <div className="flex items-center gap-1.5">
      {drums ? <Drum aria-hidden="true" className="w-3 h-3 text-amber-300/80 shrink-0" /> : <Piano aria-hidden="true" className="w-3 h-3 text-emerald-400/70 shrink-0" />}
      <label htmlFor={`editor-clip-instrument-${clip.id}`} className="sr-only">{`Clip ${clip.label} ${drums ? 'drum kit' : 'instrument'}`}</label>
      <select
        id={`editor-clip-instrument-${clip.id}`}
        name={`editor-clip-instrument-${clip.id}`}
        value={value}
        onChange={onChange}
        onFocus={warm}
        className="flex-1 min-w-0 form-select px-1.5 py-1 text-xs font-bold"
        style={{ colorScheme: 'dark' }}
      >
        <option value="default">{defaultLabel}</option>
        {drums
          ? GM_DRUM_KITS.map((k) => <option key={k.program} value={k.program}>{`${k.name} kit`}</option>)
          : GM_NAMES.map((nm, i) => <option key={nm} value={i}>{`${i + 1}. ${nm}`}</option>)}
        {/* A program set before the track became a drum track stays listed, so the select shows what the clip holds. */}
        {drums && clip.instrumentProgram !== undefined && !GM_DRUM_KITS.some((k) => k.program === clip.instrumentProgram) && (
          <option value={clip.instrumentProgram}>{`${drumKitName(clip.instrumentProgram)} kit`}</option>
        )}
        <BankPresetOptions drums={drums} skipBundledKits={GM_DRUM_KITS.map((k) => k.program)} />
        {/* A bank preset whose bank is not listed (yet, or any more) stays listed, so the select shows what the clip holds. */}
        {refValue && clipRef && !presetName(banks, clipRef, drums) && (
          <option value={refValue}>{`Bank ${clipRef.bank} · ${clipRef.program + 1}`}</option>
        )}
      </select>
      {bank > 0 && (
        <span
          data-clip-bank={bank}
          title="Bank select sent before the program: the bank the piano roll part chose. Picking another sound here drops it."
          className="shrink-0 text-xs font-bold text-zinc-300 tabular-nums"
        >
          {`Bank ${bank}`}
        </span>
      )}
    </div>
  );
};

interface PointerOp {
  /** `slip` moves the audio inside a clip that stays put; `stretch-*` drags an
   *  edge without trimming, re-fitting the same audio into the new length. */
  kind: 'move' | 'resize-left' | 'resize-right' | 'slip' | 'stretch-left' | 'stretch-right' | 'ctrl-drag-pending';
  clipId: string;
  startPxX: number;
  startPxY: number;
  initialStartSec: number;
  initialDurationSec: number;
  initialOffsetIntoSource: number;
  initialTrackIndex: number;
  initialClips?: Array<{ id: string; startSec: number; trackIndex: number }>;
  dragItems?: AudioDragItem[];
  /** `ctrl-drag-pending` / its copy-move: MIDI parts in the drag with no current
   *  render. Nothing renders at the press; a drag that leaves the timeline
   *  renders them (state/clipDragOut) and hands them over when they land. */
  dragRenderIds?: string[];
  /** Undo depth when the press went down. The whole drag is ONE undo step, so a deeper stack
   *  means the drag has written something — which is exactly what Escape has to take back. */
  undoDepthAtStart?: number;
  /** `ctrl-drag-pending` only: Shift was held at pointer-down, so a click that
   *  never became a drag replays as Shift+Ctrl (additive range). */
  shiftKey?: boolean;
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
        <span className="text-xs font-bold tabular-nums text-zinc-500 w-14 shrink-0">Tempo</span>
        <SlideTrack value={tempo} min={0.25} max={4} step={0.01} defaultValue={1} ariaLabel="Tempo (time-stretch)" className="flex-1" onChange={setTempo} />
        <span className="text-xs font-bold text-zinc-400 w-12 shrink-0 text-right tabular-nums">{tempo.toFixed(2)}x</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold tabular-nums text-zinc-500 w-14 shrink-0">Pitch</span>
        <SlideTrack value={semitones} min={-12} max={12} step={1} defaultValue={0} ariaLabel="Pitch (semitones)" className="flex-1" onChange={(v) => setSemitones(Math.round(v))} />
        <span className="text-xs font-bold text-zinc-400 w-12 shrink-0 text-right tabular-nums">{semitones >= 0 ? '+' : ''}{semitones} st</span>
      </div>
      <p className="text-xs font-bold tabular-nums text-zinc-600 leading-relaxed">
        Tempo keeps pitch; pitch keeps length. Rendered on the backend and baked into the clip.
      </p>
      <button
        onClick={() => onApply(tempo, Math.round(semitones))}
        disabled={busy || (tempo === 1 && semitones === 0)}
        className="w-full py-1.5 rounded bg-purple-600/30 border border-purple-500/40 text-purple-200 text-xs font-black uppercase tracking-widest hover:bg-purple-600/50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
      >
        {busy ? 'Rendering…' : 'Apply'}
      </button>
    </div>
  );
};

/** The three fade shapes, in the order the clip menu offers them: the app's
 *  historical default first, then the two that need a reason. The hint says
 *  what each one is FOR, because "exponential" alone does not tell a user which
 *  of their two fades wants it. Evaluated by lib/clipFade. */
const FADE_CURVE_CHOICES: Array<{ id: FadeCurve; label: string; hint: string }> = [
  { id: 'linear', label: 'Linear', hint: 'straight' },
  { id: 'exponential', label: 'Exponential', hint: 'even in dB' },
  { id: 'equal-power', label: 'Equal power', hint: 'steady loudness' },
];

/** The EDIT tab's keyboard map, rendered by the "?" overlay. Kept next to the
 *  hotkey handler's own comment block so the two stay in step — if you add a
 *  binding there, add its row here. */
const EDIT_SHORTCUTS: Array<{ group: string; keys: Array<[string, string]> }> = [
  {
    group: 'Transport',
    keys: [
      ['Space', 'Play / pause'],
      // Bound in PlayerFooter (the app-wide transport), not in this file;
      // the sheet documents the key, the footer owns the handler.
      ['R', 'Record / stop'],
      ['Home', 'Playhead and edit cursor to start'],
      ['End', 'Playhead and edit cursor to end'],
      ['L', 'Toggle loop'],
      ['M', 'Marker at playhead'],
    ],
  },
  {
    group: 'Editing',
    keys: [
      ['V', 'Move tool'],
      ['C', 'Cut tool'],
      ['S', 'Split selection at playhead'],
      ['Del', 'Delete selected clips'],
      ['Ctrl+D', 'Duplicate'],
      ['F2', 'Name and colour of the selected clip'],
      ['Esc (while dragging)', 'Cancel the clip move / trim and put it back'],
      ['Ctrl+C / X / V', 'Copy / cut / paste at the edit cursor'],
      ['Ctrl+A', 'Select all clips'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ],
  },
  {
    group: 'Clip gestures',
    keys: [
      ['Drag a clip edge', 'Trim'],
      ['Alt + drag a clip', 'Slip the audio inside it'],
      ['Shift + drag a clip edge', 'Stretch to fit — no re-render'],
      ['Ctrl + drag a clip', 'Copy it (drag it out of the timeline to take it to another surface)'],
    ],
  },
  {
    group: 'Move',
    keys: [
      ['← / →', 'Nudge by one grid step'],
      ['Shift + ← / →', 'Nudge by four steps'],
      ['↑ / ↓', 'Move a track up / down'],
    ],
  },
  {
    group: 'Volume line',
    keys: [
      ['Drag the line', 'Track volume, or the stretch between two keyframes'],
      ['Right-click the line', 'Add a keyframe'],
      ['Drag a keyframe', 'Move it (Shift: fine, Alt: off the grid)'],
      ['↑ / ↓', 'Selected keyframe 0.1 dB (Shift: 1 dB)'],
      ['← / →', 'Selected keyframe one grid step in time'],
      ['Enter', 'Type the selected keyframe volume'],
      ['Del', 'Delete the selected keyframe'],
    ],
  },
  {
    group: 'View',
    keys: [
      ['+ / -', 'Zoom in / out'],
      ['Shift+F', 'Zoom to fit'],
      ['Ctrl + wheel', 'Zoom at cursor'],
      ['Shift + wheel', 'Scroll horizontally'],
      ['?', 'This list'],
    ],
  },
  {
    group: 'AI',
    keys: [['Ctrl+P', 'Inpaint the selected region']],
  },
];

/** Per-clip gain, edited in dB and stored as a linear multiplier. Applies live —
 *  there is no Apply button because nothing is rendered: clip gain is read by the
 *  scheduler on the next play and by every offline bounce. */
const ClipGainControls: React.FC<{ gain: number; onChange: (gain: number) => void }> = ({ gain, onChange }) => {
  const db = gain > 0 ? 20 * Math.log10(gain) : -60;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold tabular-nums text-zinc-500 w-14 shrink-0">Gain</span>
        <SlideTrack
          value={Math.max(-24, Math.min(12, db))}
          min={-24}
          max={12}
          step={0.5}
          defaultValue={0}
          ariaLabel="Clip gain in decibels"
          className="flex-1"
          onChange={(v) => onChange(10 ** (v / 20))}
        />
        <span className="text-xs font-bold text-zinc-400 w-12 shrink-0 text-right tabular-nums">
          {db > -0.05 && db < 0.05 ? '0.0' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`} dB
        </span>
      </div>
      <p className="text-xs font-bold tabular-nums text-zinc-600 leading-relaxed">
        Sits before the track fader and its insert FX, so gain-staging changes what the
        track&apos;s compressor hears. Non-destructive — the clip&apos;s audio is untouched.
      </p>
      <button
        onClick={() => onChange(1)}
        disabled={db > -0.05 && db < 0.05}
        className="w-full py-1.5 rounded bg-white/5 border border-white/10 text-zinc-300 text-xs font-black uppercase tracking-widest hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none transition-colors"
      >
        Reset to unity
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
    <div data-ruler-control="1" className="absolute top-0 bottom-0 z-30" style={{ left: marker.t * zoom }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="absolute top-4 bottom-0 w-px bg-cyan-400/50 pointer-events-none" />
      {editing ? (
        <>
          <label htmlFor={`marker-rename-${marker.id}`} className="sr-only">Marker name</label>
          <input
            autoFocus
            id={`marker-rename-${marker.id}`}
            name="marker-rename"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            className="absolute top-0 left-0 w-28 h-4 bg-zinc-900 border border-cyan-500/50 rounded px-1 text-xs font-bold leading-none text-cyan-100 outline-none"
          />
        </>
      ) : (
        <button
          onClick={(e) => { if (e.altKey) onDelete(); else onSeek(); }}
          onDoubleClick={() => { setDraft(marker.label); setEditing(true); }}
          onContextMenu={(e) => { e.preventDefault(); onDelete(); }}
          title={`${marker.label} — click to seek, double-click to rename, Alt or right-click to delete`}
          className="absolute top-0 left-0 flex items-center gap-0.5 px-1 h-4 bg-cyan-500/20 border border-cyan-400/40 rounded-br text-xs font-bold leading-none text-cyan-200 hover:bg-cyan-500/35 whitespace-nowrap max-w-32"
        >
          <Flag className="w-3 h-3 shrink-0" /> <span className="truncate">{marker.label}</span>
        </button>
      )}
    </div>
  );
};

/** Where a rack or plugin param lives: every scope `EffectWindowsHost` and
 *  `FxRack` hand back, the master VST chain and the bus racks included. */
type FxParamScope = FxScope;

/* Which SURFACE a lane's gesture boundary comes from.
 *
 * A track fader is one SlideTrack writing one lane, so it is its own surface. A
 * rack panel is one surface writing SEVERAL lanes — an OWL-Pad drag moves x and
 * y, a preset writes the lot — and it reports one boundary for all of them, so
 * every param of an entry shares the entry's group. */
const gestureGroup = (t: AutomationTarget): string =>
  isFxAutomationKind(t.kind)
    ? `${t.kind}|${t.trackId ?? ''}|${t.entryId ?? ''}`
    : automationTargetKey(t);

/* A native (volume / pan) track fader, plus the badge that admits when the
   fader is NOT what drives the sound. An enabled automation lane owns its
   AudioParam: liveMixer schedules the envelope onto the param and applyMixLive
   deliberately leaves the manual fader out of the reconcile, so a fader sitting
   at 0.8 over a lane whose first breakpoint is 0.05 is simply lying about the
   track. `automated` makes the control say who holds it, and `value` is then the
   lane's value at the playhead rather than the stored one. */
const NativeFader: React.FC<{
  label: string;
  min: number; max: number; step: number; defaultValue: number;
  value: number;
  automated: boolean;
  onChange: (v: number) => void;
  /** The widget's gesture boundary, straight through to SlideTrack: one start
   *  before the first `onChange` of a drag / key press / wheel burst, one end
   *  after its last (including a gesture that changed nothing, and an unmount
   *  mid-drag). See lib/gestureTracker.ts. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}> = ({ label, min, max, step, defaultValue, value, automated, onChange, onGestureStart, onGestureEnd }) => (
  <>
    <SlideTrack
      min={min} max={max} step={step} defaultValue={defaultValue}
      value={value}
      onChange={onChange}
      onGestureStart={onGestureStart}
      onGestureEnd={onGestureEnd}
      className="flex-1"
      ariaLabel={automated ? `${label} (an automation lane drives this)` : label}
    />
    {automated && (
      <span
        className="text-xs tabular-nums font-black text-emerald-400 shrink-0"
        title="An automation lane drives this parameter — the fader shows the lane's value at the playhead. Disable the lane to take the control back."
      >A</span>
    )}
  </>
);

export const WaveformEditor: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const tool = useEditorStore((s) => s.tool);
  const zoom = useEditorStore((s) => s.zoom);
  // Playhead: the live engine calls setPlayhead ~60x/sec during playback.
  // SUBSCRIBING to playheadSec here would re-render the entire timeline (every
  // clip + its per-sample waveform bars — thousands of nodes) each frame. Read it
  // non-reactively for initial/re-render positioning, and drive the moving
  // playhead line + timecode readouts imperatively via refs + a store
  // subscription (see the effect just below). This is the dominant editor
  // frame-time win for playback on any non-trivial project.
  const playheadSec = useEditorStore.getState().playheadSec;
  const rulerLineRef = useRef<HTMLDivElement>(null);
  const rulerHandleRef = useRef<HTMLDivElement>(null);
  const laneLineRef = useRef<HTMLDivElement>(null);
  const headerTcRef = useRef<HTMLSpanElement>(null);
  const footerTcRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Follow-playhead: keep the moving playhead in view during playback. Extends
  // this same imperative subscription rather than adding a playheadSec selector,
  // for exactly the reason documented above. Suspended while the user is
  // scrolling by hand (any wheel/pointer scroll that isn't ours) and resumed on
  // the next transport start, so it never fights the user for the scrollbar.
  const followPlayheadRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  /** performance.now() until which follow paging holds off: a zoom keeps the
   *  edit cursor centred, and paging to the playhead on the next frame would
   *  undo it. Follow stays armed and resumes once the hold lapses. */
  const zoomFollowHoldUntilRef = useRef(0);
  useEffect(() => {
    const scrollIntoView = (sec: number) => {
      const el = timelineScrollRef.current;
      if (!el || !followPlayheadRef.current) return;
      if (!liveMixer.isPlaying()) return;
      if (followHoldActive(performance.now(), zoomFollowHoldUntilRef.current)) return;
      const x = sec * zoomRef.current;
      const view = el.clientWidth;
      if (view <= 0) return;
      const left = el.scrollLeft;
      // Page when the playhead leaves a comfortable band, rather than centring
      // every frame — continuous re-centring makes the waveform crawl sideways
      // and is far more distracting than a page turn.
      const lead = view * 0.15;
      if (x < left + lead || x > left + view - lead) {
        programmaticScrollRef.current = true;
        el.scrollLeft = Math.max(0, x - lead);
        // Cleared on the next frame: the scroll event this triggers must not be
        // mistaken for the user grabbing the scrollbar.
        requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      }
    };
    const apply = (sec: number) => {
      const z = zoomRef.current;
      const x = `${sec * z}px`;
      if (rulerLineRef.current) rulerLineRef.current.style.left = x;
      if (rulerHandleRef.current) rulerHandleRef.current.style.left = `${sec * z - 6}px`;
      if (laneLineRef.current) laneLineRef.current.style.left = x;
      const tc = formatTimecode(sec);
      if (headerTcRef.current) headerTcRef.current.textContent = tc;
      if (footerTcRef.current) footerTcRef.current.textContent = tc;
      scrollIntoView(sec);
    };
    apply(useEditorStore.getState().playheadSec);
    return useEditorStore.subscribe((s, prev) => {
      if (s.playheadSec !== prev.playheadSec) apply(s.playheadSec);
    });
  }, []);

  // Any scroll the follow logic did not initiate is the user taking over.
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      followPlayheadRef.current = false;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  const snap = useEditorStore((s) => s.snap);
  /** Vertical zoom. Every `index * trackH` in the timeline layout (and the
   *  drag/drop track-targeting maths) reads this, so lanes stay aligned at any
   *  height. Uniform across tracks by design — see editorStore.trackHeight. */
  const trackH = useEditorStore((s) => s.trackHeight);
  const setTrackHeight = useEditorStore((s) => s.setTrackHeight);
  /** The clip-selection writer for every whole-selection change: `setSelectedClips`
   *  keeps `selectedClipId` pinned to the first entry, so those call sites never
   *  write the two fields separately (which is how the canvas and the assistant's
   *  `editor_select_clips` used to drift apart). */
  const setSelectedClips = useEditorStore((s) => s.setSelectedClips);
  /** Moves the FOCUSED clip only, leaving the multi-selection alone — the marquee,
   *  the ctrl-drag copy and the range split all need a new anchor over a selection
   *  they have already written (or are deliberately keeping). */
  const setSelected = useEditorStore((s) => s.setSelected);
  const setTool = useEditorStore((s) => s.setTool);
  const setSnap = useEditorStore((s) => s.setSnap);
  const setBpm = useEditorStore((s) => s.setBpm);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const addTrack = useEditorStore((s) => s.addTrack);
  const insertTrack = useEditorStore((s) => s.insertTrack);
  const removeTrack = useEditorStore((s) => s.removeTrack);
  const updateTrack = useEditorStore((s) => s.updateTrack);
  /* Reorder (F01). Both record ONE undo step and no-op on an unchanged order;
     routing and clip trackIds are keyed by id, so neither is touched. */
  const moveTracks = useEditorStore((s) => s.moveTracks);
  const moveTracksByOffset = useEditorStore((s) => s.moveTracksByOffset);
  const toggleSolo = useEditorStore((s) => s.toggleSolo);
  const updateClip = useEditorStore((s) => s.updateClip);
  const removeClip = useEditorStore((s) => s.removeClip);
  const splitClipAt = useEditorStore((s) => s.splitClipAt);
  const setClipFadeCurve = useEditorStore((s) => s.setClipFadeCurve);
  const createCrossfade = useEditorStore((s) => s.createCrossfade);
  const stretchClipToFit = useEditorStore((s) => s.stretchClipToFit);
  const resetClipStretch = useEditorStore((s) => s.resetClipStretch);
  const cachePeaks = useEditorStore((s) => s.cachePeaks);

  const addClipToTrack = useEditorStore((s) => s.addClipToTrack);
  const snapSec = useEditorStore((s) => s.snapSec);
  const getTotalDurationSec = useEditorStore((s) => s.getTotalDurationSec);
  const inpaintSelection = useEditorStore((s) => s.inpaintSelection);
  // BPM/key per clip: audio clips resolve through the DJ analysis cache via
  // their originating library entry (same source the DJ decks read); MIDI
  // clips report their own render BPM. Nothing is queued or run here: an entry
  // a clip names and the cache has never heard of (a reopened project, a stem's
  // song) is read once with a GET, so its tempo and beats are there for SYNC.
  const djAnalysisById = useDjAnalysisStore((s) => s.byId);
  const clipSongEntries = useEditorStore(useShallow((s) => {
    const ids = new Set<string>();
    for (const c of s.clips) {
      if (c.songTime?.entryId) ids.add(c.songTime.entryId);
      else if (c.libraryEntryId) ids.add(c.libraryEntryId);
    }
    return [...ids].sort();
  }));
  useEffect(() => {
    const dj = useDjAnalysisStore.getState();
    for (const id of clipSongEntries) if (!dj.byId[id]) void dj.fetch(id);
  }, [clipSongEntries]);
  const setInpaintSelection = useEditorStore((s) => s.setInpaintSelection);
  const clearInpaintSelection = useEditorStore((s) => s.clearInpaintSelection);
  const masterFxChain = useEditorStore((s) => s.masterFxChain);
  // Master VST3 chain (rendered/frozen, hosted via pedalboard) + scan list.
  const masterVstChain = useEditorStore((s) => s.masterVstChain);
  const addMasterVst = useEditorStore((s) => s.addMasterVst);
  const setTrackInstrumentRawState = useEditorStore((s) => s.setTrackInstrumentRawState);
  const addTrackVst = useEditorStore((s) => s.addTrackVst);
  const removeMasterVst = useEditorStore((s) => s.removeMasterVst);
  const reorderMasterVst = useEditorStore((s) => s.reorderMasterVst);
  const clearMasterVst = useEditorStore((s) => s.clearMasterVst);
  const previewMode = useEditorStore((s) => s.previewMode);
  const setPreviewMode = useEditorStore((s) => s.setPreviewMode);
  const frozenMaster = useEditorStore((s) => s.frozenMaster);
  // The buses and the routing reach the rendered master too, so they sign it.
  const buses = useEditorStore((s) => s.buses);
  const routing = useEditorStore((s) => s.routing);
  const vstPlugins = useVstStore((s) => s.plugins);
  const vstScanning = useVstStore((s) => s.scanning);
  const scanVst = useVstStore((s) => s.scan);
  const automationMode = useEditorStore((s) => s.automationMode);
  const setAutomationMode = useEditorStore((s) => s.setAutomationMode);
  // The one derived read the rest of this component uses: "is anything armed to
  // record?". This is all the store keeps now — the `automationWrite` boolean that
  // used to shadow the mode is gone, because it could not tell touch from latch
  // from write and three of the four modes are not "write".
  const automationArmed = automationMode !== 'read';
  // Lanes come through the store's repaint feed, not a raw selector. A latch or
  // write pass rewrites `automationLanes` on EVERY transport frame (the document
  // needs that — undo and autosave read the slice), and this component renders the
  // whole timeline: subscribing directly meant ~40 full re-renders a second for a
  // curve a few pixels wide. The feed republishes at most every
  // AUTOMATION_LANE_REPAINT_MS while holds exist and immediately otherwise, so an
  // ordinary edit still lands on the very next paint. See editorStore.ts.
  const automationLanes = useSyncExternalStore(automationLaneFeed.subscribe, automationLaneFeed.getSnapshot);
  // Every hosted plugin's own parameter list, as its live host sent it: a lane on
  // a plugin parameter is named from it.
  const vstParamLists = useVstParamStore((s) => s.lists);
  const addAutomationPoint = useEditorStore((s) => s.addAutomationPoint);
  const updateAutomationPoint = useEditorStore((s) => s.updateAutomationPoint);
  const removeAutomationPoint = useEditorStore((s) => s.removeAutomationPoint);
  const toggleAutomationLane = useEditorStore((s) => s.toggleAutomationLane);
  const clearAutomationLane = useEditorStore((s) => s.clearAutomationLane);
  const removeAutomationLane = useEditorStore((s) => s.removeAutomationLane);
  const addAutomationLane = useEditorStore((s) => s.addAutomationLane);
  const projectBpm = useEditorStore((s) => s.bpm);
  // The arrangement's tempo and meter maps: the grid, the ruler's bar numbers
  // and its meter and tempo flags draw from them, and snap reads them too.
  const arrangementTempoMap = useEditorStore((s) => s.tempoMap);
  const arrangementMeterMap = useEditorStore((s) => s.meterMap);
  const timeMapOffer = useEditorStore((s) => s.timeMapOffer);
  // "Use song tempo" asked from a clip's menu or a library entry's (SongTempoDialog).
  const songTempoRequest = useEditorStore((s) => s.songTempoRequest);
  /** The Meter and tempo panel: where it opens and the row a ruler flag asked for. */
  const [timeMapPanel, setTimeMapPanel] = useState<{ x: number; y: number; focus: TimeMapFocus } | null>(null);
  const timeMapOpenerRef = useRef<HTMLElement | null>(null);
  const timeMapPanelId = `edit-time-map-${useId().replace(/:/g, '')}`;
  const openTimeMapPanel = useCallback((el: HTMLElement, focus: TimeMapFocus) => {
    timeMapOpenerRef.current = el;
    const r = el.getBoundingClientRect();
    setTimeMapPanel({ x: r.left, y: r.bottom + 4, focus });
  }, []);
  const closeTimeMapPanel = useCallback(() => {
    setTimeMapPanel(null);
    timeMapOpenerRef.current?.focus({ preventScroll: true });
  }, []);
  // A press outside the panel closes it, as the gain and name panels do; a
  // press on the button or flag that opened it is theirs to toggle.
  const timeMapPanelRef = useRef<HTMLDivElement>(null);
  const timeMapOpen = timeMapPanel !== null;
  useEffect(() => {
    if (!timeMapOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (timeMapPanelRef.current?.contains(t) || timeMapOpenerRef.current?.contains(t)) return;
      setTimeMapPanel(null);
    };
    let attached = false;
    const timer = window.setTimeout(() => { attached = true; window.addEventListener('mousedown', onDown); }, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) window.removeEventListener('mousedown', onDown);
    };
  }, [timeMapOpen]);
  const loopEnabled = useEditorStore((s) => s.loopEnabled);
  const loopStart = useEditorStore((s) => s.loopStart);
  const loopEnd = useEditorStore((s) => s.loopEnd);
  // The punch mode, for the band down the lanes that shows which edges of the
  // loop region the next record pass may write across. Persisted, so it is set
  // long before any track is armed — which is why the band is always on rather
  // than only while recording: a window nothing draws is one the user finds out
  // about by losing a take to it.
  const recPunch = useRecordingPrefs((s) => s.punch);
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

  // ── Automation gestures ───────────────────────────────────────────────────
  //
  // A record mode is a statement about a GESTURE — touch punches out when you let
  // go, latch holds what you let go of — so the store needs begin / move / end,
  // not a stream of anonymous values.
  //
  // The track faders are SlideTrack, and SlideTrack REPORTS that boundary
  // (`onGestureStart` / `onGestureEnd`, rules in lib/gestureTracker.ts): one start
  // before the first `onChange` of a drag / key press / wheel burst and one end
  // after its last, with the pointer dominant so a Shift let go mid-ride or a
  // paused drag cannot split a gesture, and an unmount closing whatever is open.
  // The editor no longer guesses any of that from window listeners: there is no
  // pointer watch, no keyup listener and no pointerup listener in this path.
  //
  // Per the widget's own scope note, `onGestureStart` carries no value and does
  // not promise a change — so a start only ARMS the target, the first `onChange`
  // is the real begin, and an end for a target that never began just disarms.
  //
  // The rack's BESPOKE panels are SlideTrack too, so they report it as well:
  // spatializer / owlpad / chop / gater thread the same two props out through
  // FxRack (`onParamsGestureStart` / `onParamsGestureEnd`) and EffectWindowsHost.
  // Their boundary is per ENTRY rather than per param key, because one surface
  // writes several keys — so the arm is on the entry and each key begins on its
  // own first change; the one end closes every key of that entry.
  //
  // Since batch 9 (T27) the schema-driven panel reports its boundary too:
  // EffectControls threads gestureStart/gestureEnd to EffectKnob (the default
  // for every rack param, including each effect's wet/dry MIX) and EffectXYPad,
  // which own a gesture tracker each, and wraps the SlidePad toggle, the enum
  // <select>, the preset select and the reset button as one-change pairs; the
  // two bespoke XY SURFACES (the OWL-Pad pad and the Spatializer pad) call the
  // pair around their drag. The RACK_GESTURE_IDLE_MS deadline is reached only
  // by a host that passes no gesture props (MixView, outside this consumer)
  // and by the two pads' own program/motion selects and preset buttons, which
  // still write without a boundary.
  //
  // The bookkeeping itself is lib/automationGesture.ts, tested there.
  const gestureRef = useRef<AutomationGesture<AutomationTarget> | null>(null);
  const automationGesture = () => (gestureRef.current ??= createAutomationGesture<AutomationTarget>({
    keyOf: automationTargetKey,
    groupOf: gestureGroup,
    // Read through getState() rather than a captured selector: the machine is
    // built once, on demand, and outlives the render that happened to build it.
    onBegin: (target, v) => useEditorStore.getState().beginAutomationTouch(target, liveMixer.currentTransportSec(), v),
    onMove: (target, v) => useEditorStore.getState().moveAutomationTouch(target, liveMixer.currentTransportSec(), v),
    onEnd: (target) => {
      // Balanced even if the transport stopped mid-gesture: the store drops an
      // end for a target it is not holding, and the release below is a no-op when
      // nothing is playing.
      useEditorStore.getState().endAutomationTouch(target, liveMixer.currentTransportSec());
      // Touch punches out here — the lane takes its AudioParam back from the
      // hand. Latch and write keep the released value; not re-arming IS the hold.
      if (!holdsAfterRelease(useEditorStore.getState().automationMode)) {
        liveMixer.automationReleaseNative(target);
      }
    },
  }));

  /** A widget opened a gesture. Nothing is recorded yet, and it is armed whatever
   *  the transport is doing, so the pairs stay balanced when stopped and a gesture
   *  that outlives a play/stop still uses the right mechanism. */
  const armAutomation = (target: AutomationTarget) => automationGesture().arm(gestureGroup(target));
  /** The widget let go. Ends every lane of the surface that began; one that never
   *  did just disarms. */
  const endAutomation = (target: AutomationTarget) => automationGesture().end(gestureGroup(target));
  /** First value on a lane begins it; every later value moves it. */
  const touchAutomation = (target: AutomationTarget, v: number) => automationGesture().change(target, v);

  // Unmounting mid-gesture must not leave a target held in the store: end each
  // open lane properly rather than just dropping the map. `dispose` is not
  // terminal, so StrictMode's mount → cleanup → mount on the same instance leaves
  // a working machine behind.
  useEffect(() => () => gestureRef.current?.dispose(), []);

  /** The lane a native fader records onto. */
  const faderTarget = (kind: 'trackVolume' | 'trackPan', trackId: string): AutomationTarget => ({ kind, trackId });
  /** The lane one rack or plugin param records onto. A bus insert's lane names
   *  the bus in `trackId` (the routing node id); both master chains are masterFx. */
  const fxTarget = (scope: FxParamScope, entryId: string, paramKey: string): AutomationTarget => {
    if (scope.kind === 'track') return { kind: 'trackFx', trackId: scope.trackId, entryId, paramKey };
    if (scope.kind === 'bus') return { kind: 'busFx', trackId: scope.busId, entryId, paramKey };
    return { kind: 'masterFx', entryId, paramKey };
  };
  /** The surface a rack panel's gesture belongs to — built from a target so it
   *  cannot drift from `gestureGroup`. */
  const fxGroup = (scope: FxParamScope, entryId: string): string => gestureGroup(fxTarget(scope, entryId, ''));

  // Move a track fader. While a record mode is armed and the transport is rolling,
  // the move is a gesture on the lane (timestamped off the audio clock) and is
  // driven onto the live param so it is heard as it is recorded.
  const writeFader = (kind: 'trackVolume' | 'trackPan', trackId: string, v: number) => {
    updateTrack(trackId, kind === 'trackVolume' ? { volume: v } : { pan: v });
    if (!automationArmed || !liveMixer.isPlaying()) return;
    const target = faderTarget(kind, trackId);
    touchAutomation(target, v);
    liveMixer.automationTouchNative(target, v);
  };

  // Apply an FX param change, and while armed + playing, record each param key
  // that actually changed onto its own lane (an OWL-Pad drag moves x and y at
  // once, so both are captured). Every key of an entry shares that entry's gesture
  // group, so a panel that reports a boundary opens and closes all of them
  // together and one that does not shares one deadline. Playback is driven by the
  // FX lookahead writer, which is also what advances a held key between frames.
  const writeFxParams = (
    scope: FxParamScope,
    entryId: string,
    p: Record<string, number>,
  ) => {
    const st = useEditorStore.getState();
    const prev = chainInState(st, scope).find((e) => e.id === entryId)?.params;
    if (scope.kind === 'master') updateMasterEffectParams(entryId, p);
    else if (scope.kind === 'masterVst') st.setMasterVstParams(entryId, p);
    else if (scope.kind === 'bus') st.updateBusEffectParams(scope.busId, entryId, p);
    else updateTrackEffectParams(scope.trackId, entryId, p);
    if (!automationArmed || !liveMixer.isPlaying() || !prev) return;
    for (const key of Object.keys(p)) {
      if (prev[key] === p[key]) continue;
      touchAutomation(fxTarget(scope, entryId, key), p[key]);
    }
  };

  /** A rack panel that reports its boundary opened / closed a gesture on one
   *  entry. Armed on the ENTRY: the panel writes several param keys and each
   *  begins on its own first change. */
  const armFxPanel = (scope: FxParamScope, entryId: string) => automationGesture().arm(fxGroup(scope, entryId));
  const endFxPanel = (scope: FxParamScope, entryId: string) => automationGesture().end(fxGroup(scope, entryId));
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

  // The FX/fader overlay should visually follow the playhead ONLY when a lane is
  // actually in charge — automation-READ with at least one enabled, non-empty
  // lane. Subscribe to playheadSec just for that narrow case, so ordinary
  // playback (no lanes / an armed mode — the common case) never pays the
  // per-frame re-render the playhead note above avoids. Stopped counts too: a
  // lane still owns the param when the transport is parked, and playheadSec then
  // only moves on a seek, so following it costs nothing.
  const automationFollowActive =
    !automationArmed &&
    automationLanes.some((l) => l.enabled && l.points.length > 0);
  const followPlayhead = useEditorStore((s) => (automationFollowActive ? s.playheadSec : 0));

  // Sampled FX-param overrides for a rack entry at the current playhead, so its
  // controls visually follow automation during playback (display only; edits still
  // write the stored params).
  const fxDisplayParams = useCallback(
    (scope: FxParamScope, entryId: string): Record<string, number> | undefined => {
      if (!isEditorPlaying || automationArmed) return undefined; // read follows the lane; an armed mode shows your hands
      const out: Record<string, number> = {};
      // The lanes of THIS entry at THIS place: the kind and owner its scope records onto.
      const want = fxTarget(scope, entryId, '');
      for (const lane of automationLanes) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const tgt = lane.target;
        if (!tgt.paramKey || tgt.entryId !== entryId || tgt.kind !== want.kind) continue;
        if (want.kind !== 'masterFx' && tgt.trackId !== want.trackId) continue;
        const v = sampleLane(lane, followPlayhead);
        if (v != null) out[tgt.paramKey] = v;
      }
      return Object.keys(out).length ? out : undefined;
    },
    [isEditorPlaying, automationArmed, automationLanes, followPlayhead],
  );

  // What a native (volume/pan) track fader should SHOW, and whether the fader is
  // still the thing that decides. An enabled lane owns the AudioParam whether or
  // not the transport is rolling, so "stopped" is no reason to fall back to the
  // stored value — that is how a fader ends up reading 0.8 over a track the lane
  // has pinned near silence. An ARMED record mode is the one exception: there the
  // fader IS your hands and the lane is recording them.
  const faderDisplay = (
    kind: 'trackVolume' | 'trackPan',
    trackId: string,
    stored: number,
  ): { value: number; automated: boolean } => {
    if (automationArmed) return { value: stored, automated: false };
    const lane = automationLanes.find(
      (l) => l.enabled && l.points.length > 0 && l.target.kind === kind && l.target.trackId === trackId,
    );
    if (!lane) return { value: stored, automated: false };
    const v = sampleLane(lane, followPlayhead);
    return { value: v == null ? stored : v, automated: true };
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
    // A MIDI controller: 0-127, a whole value, as the synth takes it.
    if (k === 'trackMidiCc') return { color: '#e879f9', toNorm: (v) => c01(v / 127), fromNorm: (n) => Math.round(c01(n) * 127) };
    const entry = automationEntryFor({ tracks, buses, masterFxChain, masterVstChain }, lane.target);
    if (!entry) return null;
    // A hosted plugin's parameter: the plugin's own normalized 0..1, drawn in the
    // teal every VST row wears.
    if (entry.vst && vstParamIndexOfKey(lane.target.paramKey) !== null) {
      return { color: '#2dd4bf', toNorm: (v) => c01(v), fromNorm: (n) => c01(n) };
    }
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
    if (k === 'trackMidiCc') {
      const cc = midiCcOfTarget(lane.target);
      return `${trackName} · MIDI CC ${lane.target.paramKey ?? ''}${cc !== null ? ` ${partController(cc)?.name ?? ''}` : ''}`.trim();
    }
    const entry = automationEntryFor({ tracks, buses, masterFxChain, masterVstChain }, lane.target);
    const owner = k === 'masterFx' ? 'Master' : k === 'busFx' ? buses.find((b) => b.id === lane.target.trackId)?.name ?? 'Bus' : trackName;
    const effLabel = entry ? effectEntryLabel(entry) : '?';
    const vstIndex = vstParamIndexOfKey(lane.target.paramKey);
    const paramLabel = entry?.vst && vstIndex !== null
      // The plugin's own name for it once its host has listed it; its place in the list until then.
      ? vstParamLists[entry.id]?.find((p) => p.index === vstIndex)?.name ?? `Parameter ${vstIndex + 1}`
      : entry ? getRackEffect(entry.effect)?.params.find((p) => p.key === lane.target.paramKey)?.label ?? lane.target.paramKey : lane.target.paramKey;
    return `${owner} · ${effLabel} ${paramLabel ?? ''}`.trim();
  };

  // The "Add lane" picker's options — see automationLaneOptions.ts for why this
  // is a pure module rather than inline: the picker's coverage of every
  // AUTOMATION_KINDS shape is unit-tested there, DOM-free.
  // The tracks that play MIDI, which offer a lane per controller (trackMidiCc).
  const midiTrackIds = useMemo(
    () => new Set(clips.filter((c) => c.sourceKind === 'piano-roll').map((c) => c.trackId)),
    [clips],
  );
  const addLaneOptions = useMemo(
    () => buildAddAutomationLaneOptions(tracks, masterFxChain, automationLanes, midiTrackIds, buses),
    [tracks, masterFxChain, automationLanes, midiTrackIds, buses],
  );

  // The picker's own selection — reset whenever the option it names disappears
  // (added, or the track/entry it pointed at was removed) so a stale key never
  // silently resolves to nothing.
  const [addLaneKey, setAddLaneKey] = useState('');
  useEffect(() => {
    if (addLaneKey && !addLaneOptions.some((o) => o.key === addLaneKey)) setAddLaneKey('');
  }, [addLaneKey, addLaneOptions]);

  const MASTER_STRIP_H = 80;
  const masterLanes = automationLanes.filter((l) => l.target.kind === 'masterFx');
  /** The buses with a lane, in the mixer's order: each gets a strip of its own
   *  under the master's while automation is being edited (a bus has no lane row). */
  const busLaneStrips = buses.filter((b) => automationLanes.some((l) => l.target.kind === 'busFx' && l.target.trackId === b.id));

  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const trackHeaderScrollRef = useRef<HTMLDivElement>(null);
  /** The track header column; the FX rack opens clear of it. */
  const trackHeaderColRef = useRef<HTMLDivElement>(null);
  const opRef = useRef<PointerOp | null>(null);
  /** The gap a dragged clip or a drop is hovering, as the index the new lane
   *  takes; null while over a lane. Drawn as a line between the lanes. */
  const [laneInsert, setLaneInsert] = useState<number | null>(null);
  const laneInsertRef = useRef<number | null>(null);
  const showLaneInsert = (idx: number | null) => {
    if (laneInsertRef.current === idx) return;
    laneInsertRef.current = idx;
    setLaneInsert(idx);
  };
  // originX/Y: the press in client px, so a release without travel reads as a
  // clip-body click (edit cursor placement, F06) rather than a mask drag.
  const inpaintDragRef = useRef<{ clipId: string; anchorSec: number; originX: number; originY: number } | null>(null);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Playhead drag
  const playheadDragRef = useRef<{ startX: number; startSec: number; wasPlaying: boolean } | null>(null);
  // Fade handle drag
  const fadeDragRef = useRef<{ clipId: string; edge: 'in' | 'out'; startX: number; initialFade: number } | null>(null);
  // The three render flags are the queue's to answer now (T11c-b): "busy" is
  // one job of that kind unfinished, and a second press queues rather than
  // racing. `isBusy` reads the live store, so these flip on the same commit the
  // job's status does.
  const isCommitting = useRenderJobs((s) => s.isBusy('mixdown'));
  const isSelectionRendering = useRenderJobs((s) => s.isBusy('selection'));
  // Arming the live transport: liveMixer decodes + schedules every clip before
  // `playAsync` resolves. This was called `isRendering` and shared that name
  // with the selection bounce, so a bounce greyed out PLAY and arming the
  // transport greyed out the bounce. Two different things; two names.
  const [isArmingPlayback, setIsArmingPlayback] = useState(false);
  // Granular bleed rendering from the clip menu (Metamorph offline pass). NOT a
  // render job: it is a `morphEngine` render with no `BounceRequest`, so it has
  // nothing to put on the queue and keeps its own flag.
  const [isBleeding, setIsBleeding] = useState(false);
  const [mixdownName, setMixdownName] = useState('');
  // T25c: the export dialog opens beside MIXDOWN rather than replacing it —
  // MIXDOWN stays the one-click "everything, as WAV" path, this is where
  // format/bit-depth/range/destination/stems/selection live.
  // Open on the mix from the toolbar, or on the selected clips from a clip's
  // menu; null while closed.
  const [exportDialogOpen, setExportDialogOpen] = useState<'mix' | 'clips' | null>(null);
  // ONE master FX panel — built-in rack effects, VST3s and .gan surfaces are
  // the same concept (chain entries) and share a single list + add menu.
  const [showMasterFx, setShowMasterFx] = useState(false);
  // Any freeze, master or per-track — the one flag both shared before.
  const isFreezing = useRenderJobs((s) => s.isBusy('freeze'));
  // Magenta RT2 generative tool open in the floating panel (Collider/Jam/MRT2), or null.
  const [magentaToolId, setMagentaToolId] = useState<string | null>(null);
  const magentaTool: MagentaTool | null = magentaToolId ? magentaToolById[magentaToolId] ?? null : null;
  const [showMetamorph, setShowMetamorph] = useState(false);
  /**
   * Where the toolbar's floating panels (MASTER FX, METAMORPH) open: under the
   * key that asked for them, the way TOOLS opens its menu. They used to be
   * pinned to `top-28 left-4`, which put MASTER FX in the far corner of the
   * timeline with no relation to the FX key on the toolbar. null falls back to
   * that corner, for the code paths that open METAMORPH with no key to hang
   * under (a clip action, the assistant).
   */
  const [toolbarPanelAt, setToolbarPanelAt] = useState<{ x: number; y: number } | null>(null);
  /** The same, for the automation lanes panel behind the AUTO key. */
  const [automationAt, setAutomationAt] = useState<{ x: number; y: number } | null>(null);
  /** The anchor under `el`: its left edge, 4px below it. */
  const underKey = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.bottom) + 4 };
  };
  /** Timeline preferences popover, anchored under its toolbar key. */
  const [prefsAnchor, setPrefsAnchor] = useState<{ x: number; y: number } | null>(null);
  const closePrefs = useCallback(() => setPrefsAnchor(null), []);
  // The TOOLS dropdown (Magenta / Metamorph) — anchored under its button.
  const [toolsMenu, setToolsMenu] = useState<{ x: number; y: number } | null>(null);
  // The VIEW dropdown (zoom-to-selection/clips, lane height, keyboard
  // shortcuts, timeline preferences) — anchored under its button, so the
  // toolbar stays a single row of icons from play to MIXDOWN.
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null);
  // Per-track FX rack popover. x/y anchor it at the opening click (clip FX
  // button, track-header F, context menu); both undefined falls back to the
  // legacy right-4 top-28 position.
  // The rack lives in its own store, which closes it when its lane leaves the
  // arrangement, so undoing a lane's removal never reopens the lane's rack.
  const fxPanel = useTrackFxRackStore((s) => s.rack);
  const openFxRack = useTrackFxRackStore((s) => s.open);
  const toggleFxRack = useTrackFxRackStore((s) => s.toggle);
  const closeFxRack = useTrackFxRackStore((s) => s.close);
  // Leaving EDIT closes the rack.
  useEffect(() => () => useTrackFxRackStore.getState().close(), []);
  /** The rack's anchor for a click at (x, y), for a caller with no element of
   *  its own to hang under (the lane's context menu). */
  const fxRackAnchor = (trackId: string, x?: number, y?: number): TrackFxRackAnchor => {
    if (x == null || y == null) return { trackId };
    return { trackId, x, y };
  };
  /**
   * The rack's anchor under the key that opened it: its left edge, 4px below
   * it — the placement TOOLS uses for its menu, so the two open the same way.
   * The rack used to open at the pointer, pushed out past the track header
   * column, which put it nowhere near the key that asked for it.
   * popoverPlacement keeps it on screen and above the transport from there.
   */
  const fxRackUnder = (trackId: string, el: HTMLElement): TrackFxRackAnchor => {
    const r = el.getBoundingClientRect();
    return { trackId, x: Math.round(r.left), y: Math.round(r.bottom) + 4 };
  };
  // Open a VST entry's REAL native GUI; the sink stores the captured raw_state
  // on the right chain (a track's fxChain or the master VST chain).
  const openVstEditor = (entry: ChainEntry, sink: (entryId: string, rawState: string) => void) =>
    useVstEditorStore.getState().open(entry, sink);
  // Scope-aware VST GUI opener for the unified effect windows: the raw_state
  // sink follows where the entry lives (a track, a bus or the master).
  const openVstFor = useCallback((scope: FxScope, entry: ChainEntry) => openVstEditorForScope(scope, entry), []);
  // The single row-click entry point: open (or focus) the entry's control
  // window; VST entries also (re)open their native GUI, 'ares' takes the
  // one app-wide surface. One window per effect — reopening focuses.
  const openEntryWindow = useCallback(
    (scope: FxScope, entry: ChainEntry, origin?: EffectWindowOrigin) => openEffectWindow(scope, entry, openVstFor, origin),
    [openVstFor],
  );
  // Clicking an available plugin adds it to the right chain (once) AND opens
  // its window + GUI immediately. Re-clicking one already in the chain just
  // focuses its window instead of adding a duplicate.
  const addAndEditMasterVst = (pl: Vst3PluginInfo) => {
    let entry = useEditorStore.getState().masterVstChain.find((e) => e.vst?.plugin_path === pl.path);
    if (!entry) {
      addMasterVst({ plugin_path: pl.path, plugin_name: pl.name });
      entry = [...useEditorStore.getState().masterVstChain].reverse().find((e) => e.vst?.plugin_path === pl.path);
    }
    if (entry) openEntryWindow({ kind: 'masterVst' }, entry);
  };
  const addAndEditTrackVst = (trackId: string, pl: Vst3PluginInfo) => {
    const chainOf = (): ChainEntry[] =>
      useEditorStore.getState().tracks.find((t) => t.id === trackId)?.fxChain ?? [];
    let entry = chainOf().find((e) => e.vst?.plugin_path === pl.path);
    if (!entry) {
      addTrackVst(trackId, { plugin_path: pl.path, plugin_name: pl.name });
      entry = [...chainOf()].reverse().find((e) => e.vst?.plugin_path === pl.path);
    }
    if (entry) openEntryWindow({ kind: 'track', trackId }, entry);
  };
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

  // ── Stem separation on a timeline clip → explode to tracks. The Demucs
  // sidecar is keyed on library entries, so a clip without a libraryEntryId is
  // first imported as one (the id is written back onto the clip so a re-run
  // hits the cache). ensureStems() returns cached stems or runs separation
  // with progress; each stem becomes its own track whose clip keeps the source
  // clip's timeline placement + trim, and the source clip is muted (not
  // deleted) so the explosion is reversible.
  const [stemsModal, setStemsModal] = useState<{ clipId: string } | null>(null);
  const [stemsJob, setStemsJob] = useState<{ clipId: string; entryId: string | null; phase: string; pct: number } | null>(null);
  const stemsJobRef = useRef(stemsJob);
  stemsJobRef.current = stemsJob;

  const abortStemsJob = useCallback(() => {
    const job = stemsJobRef.current;
    if (job?.entryId) {
      void fetch(`/api/stems/${encodeURIComponent(job.entryId)}/abort`, { method: 'POST' });
    }
  }, []);

  const explodeClipToStems = useCallback(async (clipId: string, opts: StemsRunOptions) => {
    const st = useEditorStore.getState();
    if (!st.clips.some((c) => c.id === clipId)) return;
    setStemsJob({ clipId, entryId: null, phase: 'preparing', pct: 0 });
    try {
      // A MIDI clip with no render is rendered first (state/midiRenderQueue).
      const src = await clipWithAudio(clipId);
      // 1. A library entry to key the stems backend on.
      let entryId = src.libraryEntryId ?? null;
      // Stems of an entry imported from the clip's own audio are that audio's
      // time, so they keep the clip's song tie; stems of a library entry are
      // tied to that entry (lib/songTimeLink stemsSongTime).
      const importedFromClipAudio = !entryId;
      if (!entryId) {
        const entry = await useLibraryStore.getState().importEntry({
          blob: src.audioBlob,
          filename: `${(src.label || 'edit-clip').replace(/[^\w \-.]+/g, '')}.wav`,
          mimeType: src.mimeType || 'audio/wav',
          metadata: { title: `${src.label || 'EDIT clip'} (EDIT)`, source: 'import' },
        });
        entryId = entry.id;
        useEditorStore.getState().updateClip(clipId, { libraryEntryId: entryId });
      }
      setStemsJob({ clipId, entryId, phase: 'separating', pct: 0 });
      // 2. Cached stems, or a fresh separation run with live progress.
      const refs = await ensureStems(
        entryId,
        { stems: opts.stems, device: opts.device, quality: opts.quality },
        (pct, phase) => setStemsJob({ clipId, entryId, phase, pct }),
      );
      if (!refs.length) throw new Error('separation produced no stems');
      // 3. Which stems go on the timeline. An `aggregate` row is a SUM of other
      //    rows in the same run (`drums` over the LARSNET kit parts,
      //    `no_vocals` over everything but the vocal), so placing it beside its
      //    members would put that audio on the arrangement twice at double
      //    level. A run that reports no roles at all is placed whole, as before.
      const plan = planStemInsert(refs);
      setStemsJob({ clipId, entryId, phase: 'placing clips', pct: 100 });
      // 4. Fetch and decode EVERY stem before touching the document. The store
      //    writes then run back to back with nothing awaited between them, so
      //    they land inside one coalescing burst (300 ms) and the explosion is
      //    a single undo step instead of one per stem.
      const decoded: Array<{ ref: StemRef; blob: Blob; peaks: Float32Array; duration: number }> = [];
      for (const ref of plan.insert) {
        const res = await fetch(ref.url);
        if (!res.ok) {
          logError('editor', `stem ${ref.name}: fetch failed (${res.status})`);
          continue;
        }
        const blob = await res.blob();
        const { peaks, duration } = await computePeaks(blob, 240);
        decoded.push({ ref, blob, peaks, duration });
      }
      if (!decoded.length) throw new Error('no stem audio could be fetched');
      // 5. One new track per stem; each clip lands exactly where the source is.
      //    Read the source AFTER the downloads — it may have been moved or
      //    trimmed while they ran, and the stems line up with where it is now.
      const srcNow = useEditorStore.getState().clips.find((c) => c.id === clipId) ?? src;
      const songTime = stemsSongTime(srcNow, entryId, importedFromClipAudio);
      beginUndoStep();
      const store = useEditorStore.getState();
      for (const { ref, blob, peaks, duration } of decoded) {
        const label = `${srcNow.label} · ${ref.name}`;
        const color = STEM_TRACK_COLORS[ref.name] ?? srcNow.color;
        const trackId = store.addTrack({ name: label, color });
        const newClipId = store.addClipToTrack({
          trackId,
          label,
          audioBlob: blob,
          mimeType: 'audio/wav',
          sourceDuration: duration,
          ...stemClipPlacement(srcNow, duration),
          color,
          gain: srcNow.gain,
          fadeInSec: srcNow.fadeInSec,
          fadeOutSec: srcNow.fadeOutSec,
          ...(songTime ? { songTime: { ...songTime } } : {}),
        });
        store.cachePeaks(newClipId, peaks);
      }
      // 6. Mute the source clip — kept, so the explosion is undoable/reversible.
      //    `{ coalesce: true }` is what makes the whole explode ONE undo step:
      //    `updateClip` keys its coalescing on the clip while `addTrack` /
      //    `addClipToTrack` are anonymous, so without the opt-in this write
      //    opened a SECOND step and one Ctrl-Z left the stems on the timeline
      //    with the parent unmuted — every part of the audio playing twice.
      //    The `beginUndoStep()` above already cut the burst for the whole
      //    operation, which is exactly the case the opt-in exists for (same
      //    rule as a `stretchClipToFit` drag).
      useEditorStore.getState().updateClip(clipId, { muted: true }, { coalesce: true });
      const note = skippedAggregatesNote(plan.skipped);
      logInfo(
        'editor',
        `Exploded "${srcNow.label}" into ${decoded.length} stem track(s)${note ? ` — ${note}` : ''}`,
      );
      setStemsJob(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('editor', `Stem explode failed: ${msg}`);
      setStemsJob((j) => (j && j.clipId === clipId ? { ...j, phase: `failed — ${msg}`, pct: 0 } : j));
      window.setTimeout(() => {
        setStemsJob((j) => (j && j.clipId === clipId && j.phase.startsWith('failed') ? null : j));
      }, 6000);
    }
  }, []);

  const onConfirmStemsModal = useCallback((opts: StemsRunOptions) => {
    const modal = stemsModal;
    if (!modal) return;
    setStemsModal(null);
    if (opts.persistAsDefault) {
      // Fire-and-forget — backend persists to data/settings.json.
      void useFeatureToggleStore.getState().patch({
        stems: { default_count: opts.stems, device: opts.device, quality: opts.quality },
      });
    } else {
      // In-memory only, so the next open of the modal remembers this run.
      useFeatureToggleStore.setState((s) => ({
        settings: {
          ...s.settings,
          stems: { ...s.settings.stems, default_count: opts.stems, device: opts.device, quality: opts.quality },
        },
      }));
    }
    void explodeClipToStems(modal.clipId, opts);
  }, [stemsModal, explodeClipToStems]);

  /** Queue a MIDI clip's render (state/midiRenderQueue: one clip at a time),
   *  writing it as the clip's cached audio: 'cache' for EDIT's own upkeep,
   *  'keep' when the user asks to keep the audio with the clip. */
  const rerenderMidiClipAudio = useCallback(async (clipId: string, mode: MidiRenderMode = 'cache') => {
    try {
      await requestMidiRender(clipId, mode);
    } catch (e) {
      const label = useEditorStore.getState().clips.find((c) => c.id === clipId)?.label ?? clipId;
      logError('editor', `MIDI render failed for "${label}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Keep every MIDI clip's cached render in step with its notes and instrument
  // (lib/midiRender). Covers clip overrides, track defaults and the global picker
  // in one place, so no individual instrument control has to remember to ask for
  // a render. `tracks` and the soundfont store are in the dep list because a
  // clip's effective program can change without `clips` changing at all — via a
  // track default or the global instrument picker. Without them, reassigning the
  // instrument at either of those levels would leave a cached render stale.
  const sfActiveProgram = useSoundfontStore((s) => s.activeProgram);
  const sfEnabled = useSoundfontStore((s) => s.useSoundfont);
  // Which MIDI tracks the next pass plays live on EDIT's synths and which play
  // their bounce, for the status beside each track's instrument (the same plan
  // play() makes, liveMixer planLiveMidi).
  const liveMidiStatus = useMemo(
    () => liveMixer.liveMidiTrackStatus(clips, tracks, { useSoundfont: sfEnabled, activeProgram: sfActiveProgram }),
    [clips, tracks, sfActiveProgram, sfEnabled],
  );
  // Each MIDI clip's render state (lib/midiRender): no render, a current one or
  // a stale one, whether it plays live when heard (liveMixer liveMidiIfHeard:
  // the plan play() makes, a muted clip read as if unmuted), and whether EDIT
  // made its render only so it could be heard (renderAuto). A clip whose kept
  // render went stale (a note edit, an instrument change) is re-rendered, and so
  // is an automatic render of a clip that still cannot play live; a clip with no
  // render that cannot play live (no program, or past the last live channel) is
  // rendered so it can be heard; a clip that plays live with no render stays
  // without one until an export needs it, and an automatic render it holds is
  // dropped, so a part given an instrument stops re-rendering after every edit.
  // Every render goes through the queue one clip at a time.
  const midiRenderInfo = useMemo(() => {
    const global = { useSoundfont: sfEnabled, activeProgram: sfActiveProgram };
    const live = liveMixer.liveMidiIfHeard(clips, tracks, global);
    const byId = new Map<string, { state: MidiRenderState; live: boolean; auto: boolean }>();
    const wanted: string[] = [];
    const drop: string[] = [];
    for (const c of clips) {
      if (!hasMidiNotes(c)) continue;
      const track = tracks.find((t) => t.id === c.trackId);
      const state = midiRenderState(c, track, global);
      const isLive = live.has(c.id);
      const auto = c.renderAuto === true && !!c.audioBlob;
      byId.set(c.id, { state, live: isLive, auto });
      if (auto && isLive) drop.push(c.id);
      // The signature rides along, so an edit to a clip already waiting asks again (the queue shares the job).
      else if (state === 'stale' || (state === 'none' && !isLive && !c.muted)) wanted.push(`${c.id}:${midiRenderSig(c)}`);
    }
    return { byId, wantedSig: wanted.join('|'), dropIds: drop.join('|') };
  }, [clips, tracks, sfActiveProgram, sfEnabled]);
  useEffect(() => {
    if (!midiRenderInfo.wantedSig) return;
    for (const key of midiRenderInfo.wantedSig.split('|')) void rerenderMidiClipAudio(key.slice(0, key.lastIndexOf(':')));
    // wantedSig collapses the clip list to the clips that need a render, so this
    // runs when one starts or stops needing one, not on every clip drag.
  }, [midiRenderInfo.wantedSig, rerenderMidiClipAudio]);
  useEffect(() => {
    if (!midiRenderInfo.dropIds) return;
    const dropped = midiRenderInfo.dropIds.split('|').filter((id) => dropAutoRender(id));
    if (dropped.length) logInfo('editor', `${dropped.length} MIDI part(s) now play live, so the audio rendered for them to be heard was dropped`);
  }, [midiRenderInfo.dropIds]);
  const midiQueue = useMidiRenderQueue();

  // Tap tempo. Averages the intervals between recent taps and writes the result to
  // the project BPM. Taps more than 2s apart start a fresh measurement, so an idle
  // return to the button doesn't average against a stale gap.
  const tapTimesRef = useRef<number[]>([]);
  const tapTempo = useCallback(() => {
    const now = performance.now();
    const taps = tapTimesRef.current;
    if (taps.length > 0 && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length < 2) return;
    const spans: number[] = [];
    for (let i = 1; i < taps.length; i += 1) spans.push(taps[i] - taps[i - 1]);
    const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
    if (mean <= 0) return;
    setBpm(Math.round(60000 / mean));
  }, [setBpm]);

  // Keyboard-map overlay ("?"). The ref mirrors the flag so the hotkey effect can
  // read it without listing it as a dependency — otherwise every open/close would
  // tear down and re-register the window listener.
  const [showShortcuts, setShowShortcuts] = useState(false);
  const showShortcutsRef = useRef(false);
  useEffect(() => { showShortcutsRef.current = showShortcuts; }, [showShortcuts]);

  // Clip-gain popover. Unlike Time/Pitch this needs no render pass — clip gain is
  // a scheduling parameter, so it applies on the next play (and to every bounce)
  // with no destructive edit to the clip's audio.
  const [gainPanel, setGainPanel] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const gainPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!gainPanel) return;
    const onDown = (e: MouseEvent) => {
      if (gainPanelRef.current?.contains(e.target as Node)) return;
      setGainPanel(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setGainPanel(null); };
    let attached = false;
    const attach = () => { attached = true; window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey); };
    const timer = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); }
    };
  }, [gainPanel]);

  // Clip name + colour popover (clip menu -> "Name and colour…"). A commit is one undo step.
  const [clipNamePanel, setClipNamePanel] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const clipNamePanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!clipNamePanel) return;
    const onDown = (e: MouseEvent) => {
      if (clipNamePanelRef.current?.contains(e.target as Node)) return;
      setClipNamePanel(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setClipNamePanel(null); };
    let attached = false;
    const attach = () => { attached = true; window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey); };
    const timer = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); }
    };
  }, [clipNamePanel]);

  // Render the clip's current region (offset..offset+duration) to a WAV File so the
  // backend stretches only what the clip actually plays, not the whole source.
  const extractRegionWav = useCallback(async (asked: AudioClip): Promise<File> => {
    // A MIDI clip with no render is rendered first (state/midiRenderQueue).
    const clip = await clipWithAudio(asked.id);
    // 44100 puts this in the same shared-cache lane as the offline renderers, so
    // a stretch after a bounce (or a bounce after a stretch) reuses the buffer.
    // `ac` stays open past the decode — createBuffer below still needs it.
    const ac = new AudioContext({ sampleRate: 44100 });
    try {
      const buf = await decodeClipBlob(ac, clip.audioBlob as Blob);
      const sr = buf.sampleRate;
      const start = Math.max(0, Math.floor((clip.offsetIntoSource ?? 0) * sr));
      const len = Math.max(1, Math.min(buf.length - start, Math.ceil(clip.durationSec * sr)));
      const seg = ac.createBuffer(buf.numberOfChannels, len, sr);
      for (let ch = 0; ch < buf.numberOfChannels; ch += 1) {
        seg.copyToChannel(buf.getChannelData(ch).subarray(start, start + len), ch);
      }
      // Float: this is going to the stretch backend to be resampled, not to
      // the timeline, so a 16-bit round trip here would only cost resolution
      // on the way in.
      return new File([encodeWav(seg, { float32: true })], 'clip.wav', { type: 'audio/wav' });
    } finally {
      ac.close().catch(() => {});
    }
  }, []);

  // Time-stretch (tempo, pitch preserved) + transpose (semitones, tempo preserved)
  // through the FFmpeg backend (rubberband when available), then replace the clip's
  // audio with the result. tempo > 1 shortens the clip; pitch leaves length alone.
  // What the result writes onto the clip (its tempo, its song tie) and the beat
  // match built on it live in lib/beatMatchRun, which a node test replays.
  const renderTimePitch = useCallback<TimePitchRenderer>(async (clip, tempo, semitones) => {
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
    return { blob, duration, peaks };
  }, [extractRegionWav]);

  const applyTimePitch = useCallback(async (clipId: string, tempo: number, semitones: number) => {
    setTimePitchBusy(true);
    try {
      await runTimePitch(clipId, tempo, semitones, renderTimePitch);
    } finally {
      setTimePitchBusy(false);
    }
  }, [renderTimePitch]);

  /** Beat match, the way a deck's SYNC works (lib/beatMatchRun runBeatMatch):
   *  `toProject` targets the arrangement's own tempo. */
  const beatMatchClips = useCallback(async (ids: string[], targetBpm: number, toProject = false) => {
    setTimePitchBusy(true);
    try {
      await runBeatMatch(ids, targetBpm, toProject, renderTimePitch);
    } finally {
      setTimePitchBusy(false);
    }
  }, [renderTimePitch]);

  // The clip / track multi-selection lives in editorStore (batch 11), not local
  // state: EDIT unmounts on a tab switch and a local selection died with it.
  // It is also the ONE copy the assistant's `editor_select_clips` /
  // `editor_select_range` tools read and write, so a tool-driven selection shows
  // up on the canvas and a canvas multi-select is readable by those tools.
  // These two wrappers keep the useState setter shape every call site below
  // already uses (value or updater), and skip the store write when nothing
  // changed so the prune effect cannot ping-pong renders.
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const selectedTrackIds = useEditorStore((s) => s.selectedTrackIds);
  const setSelectedClipIds = useCallback((next: string[] | ((prev: string[]) => string[])) => {
    const st = useEditorStore.getState();
    const ids = typeof next === 'function' ? next(st.selectedClipIds) : next;
    if (ids.length === st.selectedClipIds.length && ids.every((id, i) => id === st.selectedClipIds[i])) return;
    st.setSelectedClipIds(ids);
  }, []);
  const setSelectedTrackIds = useCallback((next: string[] | ((prev: string[]) => string[])) => {
    const st = useEditorStore.getState();
    const ids = typeof next === 'function' ? next(st.selectedTrackIds) : next;
    if (ids.length === st.selectedTrackIds.length && ids.every((id, i) => id === st.selectedTrackIds[i])) return;
    st.setSelectedTrackIds(ids);
  }, []);
  // The time range (F03) and the edit cursor (F06), also workspace state in the store.
  const timeSelection = useEditorStore((s) => s.timeSelection);
  const editCursorSec = useEditorStore((s) => s.editCursorSec);
  const setTimeSelection = useEditorStore((s) => s.setTimeSelection);
  const setEditCursor = useEditorStore((s) => s.setEditCursor);
  const clickProfile = useTimelinePrefs((s) => s.clickProfile);
  /** Grid style (F05): tier opacities, bar width, lane-divider alpha. */
  const gridStyle = useTimelinePrefs((s) => s.grid);
  /** Each track's volume drawn over its lane, with its keyframes (TrackVolumeLine). */
  const showVolumeLine = useTimelinePrefs((s) => s.showVolumeLine);
  /** Redraw key for the canvas grid: its line colour comes from the theme. */
  const editThemeId = useEditThemeStore((s) => s.themeId);

  /** A real transport seek: moves the playhead and, when the footer player is
   *  driving the editor timeline, the audio itself. Never starts or stops play.
   *  While stopped the playhead and the edit cursor are one point, so a seek
   *  then moves the edit cursor too (F06). */
  const seekEditorTo = useCallback((sec: number) => {
    setPlayhead(sec);
    if (usePlayerStore.getState().currentEntryId === 'editor-timeline') {
      usePlayerStore.getState().seek(sec);
    }
    if (!isEditorTimelinePlaying()) setEditCursor(sec);
  }, [setPlayhead, setEditCursor]);

  /* Timeline gesture state shared by the Escape key (window listener, declared
     further up than the handlers) and the pointer handlers further down. */
  /** The empty-lane press in flight: a click until it travels 4 px, then a marquee. */
  const marqueeRef = useRef<GestureState | null>(null);
  /** The live rubber band in lanes-content local px, for drawing; null when none. */
  const [marqueeRect, setMarqueeRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  /** Last pointer position (client px) of the marquee, re-read after an autoscroll step. */
  const marqueeClientRef = useRef<{ x: number; y: number } | null>(null);
  const marqueeRafRef = useRef<number | null>(null);
  /** A plain ruler press: seek on a click, time range on a drag. `before` is the
   *  range at press time, restored if Escape cancels the drag. */
  const rulerPressRef = useRef<
    { pointerId: number; originX: number; originY: number; anchorSec: number; dragging: boolean; before: TimeRange | null } | null
  >(null);
  /** Set by the render below: what Escape does on the timeline (menu → gesture → clips → range → inpaint mask). */
  const timelineEscapeRef = useRef<() => void>(() => {});

  // Publish the track selection for non-React consumers (the Sway control
  // surface's selection-following fader bank reads this).
  useEffect(() => {
    publishSelectedTracks(selectedTrackIds);
  }, [selectedTrackIds]);

  // Same for the clip selection. editorTools publishes after its own writes;
  // this covers the canvas's (and undo/redo's, and loadProject's) writes, so the
  // bridge is current no matter which side moved the selection.
  useEffect(() => {
    publishSelectedClips(selectedClipIds);
  }, [selectedClipIds]);

  // --- Inpaint panel state ---
  type InpaintPhase =
    // `error` carries the reason a previous attempt failed back into the params
    // panel. Without it every failure path just snapped the panel back with no
    // visible message, which is what made GH-132 undiagnosable.
    | { kind: 'params'; error?: string }
    | { kind: 'generating'; jobId: string }
    | { kind: 'review'; blob: Blob; blobUrl: string };
  const [inpaintPanel, setInpaintPanel] = useState<InpaintPhase | null>(null);
  // When set, the LibraryPicker is open: which tab it opens on, where the pick
  // lands (`trackId` null = make a new track, matching a drop below all lanes),
  // and the viewport point to anchor the popover at.
  const [addPicker, setAddPicker] = useState<
    { tab: LibraryPickerTab; trackId: string | null; atSec: number; x: number; y: number } | null
  >(null);
  // Library MIDI rows, or null until the index has been read once. Feeds the
  // add-to-track menu so "MIDI from Library" can say WHY it is greyed out
  // instead of opening an empty picker.
  const [libraryMidiCount, setLibraryMidiCount] = useState<number | null>(cachedLibraryMidiCount);
  // Only `loaded` is subscribed — the entry count itself is read when a menu
  // opens. This flag is what makes the menu re-render once the startup load
  // finishes, so "Audio from Library" stops reading as an empty library.
  const libraryLoaded = useLibraryStore((s) => s.loaded);
  /** The "Empty MIDI part…" dialog: which track (null = a new one), the second
   *  the menu opened at, and where the dialog opens. */
  const [newPart, setNewPart] = useState<{ trackId: string | null; atSec: number; x: number; y: number } | null>(null);
  const newPartId = `edit-new-part-${useId().replace(/:/g, '')}`;
  const newPartRef = useRef<HTMLDivElement>(null);
  const newPartOpen = newPart !== null;
  // A press outside the dialog closes it, as the meter panel does.
  useEffect(() => {
    if (!newPartOpen) return;
    const onDown = (e: MouseEvent) => {
      if (newPartRef.current?.contains(e.target as Node)) return;
      setNewPart(null);
    };
    let attached = false;
    const timer = window.setTimeout(() => { attached = true; window.addEventListener('mousedown', onDown); }, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) window.removeEventListener('mousedown', onDown);
    };
  }, [newPartOpen]);
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
      // A text field keeps its own undo; a fader (which holds focus after a ride) has none,
      // so Ctrl+Z right after moving one is the app's undo (lib/keyTargets.ts).
      if (keyBelongsToFocusedControl(e)) return;
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

  // The inpaint retry the gate cards call back into. A ref because the cards
  // are raised from the poll effect above submitInpaint's definition.
  const retryInpaintRef = useRef<(() => void) | null>(null);

  // Route an inpaint failure through the same model-gate cards MAKE raises
  // (generateStore.submitGeneration). A fresh Pinokio install defaults to
  // local-only, so the first INPAINT REGION fails on the model load; the 502
  // detail already says so, but as raw text in the panel there was nothing
  // to click (GH-132). Returns true when a card carried the fix.
  const surfaceInpaintGate = (msg: string): boolean => {
    const gate = classifyModelGate(msg);
    if (!gate) return false;
    const retry = () => retryInpaintRef.current?.();
    if (gate.kind === 'local-only') {
      requireFeature({
        id: 'model:local-only',
        kind: 'model',
        title: 'Downloads are turned off',
        message:
          'This model is not on the machine, and local-only mode blocks fetching it. Allowing downloads gets it now.',
        action: {
          label: 'Allow downloads & retry',
          run: async () => {
            await setLocalOnly(false);
            retry();
          },
        },
      });
    } else if (gate.kind === 'sign-in') {
      requireFeature({
        id: 'hf:generate',
        kind: 'hf',
        title: 'Hugging Face sign-in needed',
        message: 'This model is gated — paste a token and inpainting runs again.',
        action: { label: 'Retry inpaint', run: retry },
      });
    } else {
      const repoUrl = gate.repoUrl;
      requireFeature({
        id: 'hf:no-access',
        kind: 'model',
        title: 'Access not granted',
        message:
          "Your token works — this Hugging Face account is not on the model's allow list. Open the model page, click 'Agree and access', then inpaint again.",
        action: repoUrl
          ? { label: 'Open model page', run: () => { window.open(repoUrl, '_blank', 'noopener'); } }
          : undefined,
      });
    }
    return true;
  };

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
            const msg = job.error ?? 'unknown';
            logError('editor', `Inpaint job failed: ${msg}`);
            surfaceInpaintGate(msg);
            setInpaintPanel({ kind: 'params', error: msg });
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
    if (!useEditorStore.getState().clips.some((c) => c.id === sel.clipId)) return;

    // Always crop the audio to exactly the visible clip region before sending.
    // This guarantees mask coordinates are relative to the start of the audio
    // the model receives, regardless of offsetIntoSource (split/trim clips).
    let croppedAudio: Blob;
    let clip: AudioClip;
    try {
      // A MIDI clip with no render is rendered first (state/midiRenderQueue).
      clip = await clipWithAudio(sel.clipId);
      croppedAudio = await cropAudioBlob(clip.audioBlob as Blob, clip.offsetIntoSource, clip.durationSec);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('editor', `Inpaint: failed to crop audio: ${msg}`);
      setInpaintPanel({ kind: 'params', error: `Could not read the clip's audio: ${msg}` });
      return;
    }

    // Mask coords are now relative to the start of the cropped (visible) audio.
    const maskStart = sel.startSec - clip.startSec;
    const maskEnd   = sel.endSec   - clip.startSec;

    const fd = new FormData();
    // Send the model the user actually selected. Without this the endpoint's
    // own default won, which meant INPAINT REGION always asked for the gated
    // 'medium' checkpoint no matter what MAKE was set to (GH-132).
    fd.append('model_name', useGenerateParamsStore.getState().model);
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
        // The backend's `detail` is the actionable part (a gated-model fetch, a
        // missing checkpoint, CUDA OOM). Throwing it away is what left GH-132
        // with nothing but a panel that snapped back.
        let detail = '';
        try {
          const body = await res.json() as { detail?: unknown };
          const message = (body.detail as { message?: unknown } | null)?.message;
          detail = typeof body.detail === 'string'
            ? body.detail
            : typeof message === 'string'
              ? message
              : JSON.stringify(body.detail ?? '');
          // Another copy's Magenta engine holds the GPU: its card names the
          // engine and offers to stop it.
          handleEngineElsewhere(body, 'Stable Audio cannot load beside it.');
        } catch {
          try { detail = await res.text(); } catch { /* body already consumed */ }
        }
        const msg = `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
        logError('editor', `Inpaint submit ${msg}`);
        surfaceInpaintGate(detail || msg);
        setInpaintPanel({ kind: 'params', error: msg });
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

  retryInpaintRef.current = () => { void submitInpaint(); };

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

  const selectedClipIdSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);

  const selectedClipCount = selectedClipIds.length || (selectedClipId ? 1 : 0);

  useEffect(() => {
    // pruneSelection hands back the SAME array when nothing died, so this effect
    // does not write the store on every clips/tracks change (which, now that it
    // also depends on the selection it prunes, would never settle).
    const pruned = pruneSelection(selectedClipIds, clips.map((clip) => clip.id));
    if (pruned !== selectedClipIds) setSelectedClips(pruned);
    setSelectedTrackIds((prev) => prev.filter((id) => tracks.some((track) => track.id === id)));
  }, [clips, tracks, selectedClipIds, setSelectedClips]);

  const deleteSelectedClips = useCallback(() => {
    const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    if (ids.length === 0) return;
    ids.forEach((id) => removeClip(id));
    setSelectedClips([]);
    setSelectedTrackIds([]);
  }, [removeClip, selectedClipId, selectedClipIds, setSelectedClips]);

  const duplicateSelectedClips = useCallback(() => {
    const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    if (ids.length === 0) return;
    const selected = clips.filter((c) => ids.includes(c.id));
    // Drop `id` before handing the clip back: addClipToTrack honours an incoming
    // id (`clip.id ?? uid()`), so spreading the source clip whole made the copy
    // reuse the ORIGINAL's id — two clips, one id, and every later updateClip /
    // removeClip on that id silently hit both.
    const newIds = selected.map(({ id: _sourceId, ...clip }) => addClipToTrack({
      ...clip,
      startSec: clip.startSec + clip.durationSec,
    }));
    setSelectedClips(newIds);
    setSelectedTrackIds([]);
    logInfo('editor', `Duplicated ${newIds.length} clip${newIds.length === 1 ? '' : 's'}`);
  }, [addClipToTrack, clips, selectedClipId, selectedClipIds, setSelectedClips]);

  const selectClipSingle = useCallback((clipId: string | null) => {
    setSelectedClips(clipId ? [clipId] : []);
    setSelectedTrackIds([]);
  }, [setSelectedClips]);

  const selectTrackSingle = useCallback((trackId: string | null) => {
    setSelectedTrackIds(trackId ? [trackId] : []);
    setSelectedClips([]);
  }, [setSelectedClips]);

  const toggleTrackSelection = useCallback((trackId: string) => {
    setSelectedTrackIds((prev) => (
      prev.includes(trackId) ? prev.filter((id) => id !== trackId) : [...prev, trackId]
    ));
    setSelectedClips([]);
  }, [setSelectedClips]);

  const selectTrackWithModifiers = useCallback((trackId: string, e?: { metaKey?: boolean; ctrlKey?: boolean }) => {
    if (e?.metaKey || e?.ctrlKey) toggleTrackSelection(trackId);
    else selectTrackSingle(trackId);
  }, [selectTrackSingle, toggleTrackSelection]);

  const selectClipWithModifiers = useCallback((clipId: string, e?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
    const additive = !!(e?.metaKey || e?.ctrlKey);
    const range = !!e?.shiftKey;

    if (range && selectedClipId) {
      const orderedIds = [...clips].sort((a, b) => a.startSec - b.startSec).map((c) => c.id);
      // The clicked clip leads whatever comes back, so the store's
      // `selectedClipId` stays on it and the NEXT shift-click ranges from there —
      // the anchor behaviour the old setSelected(clipId) gave us.
      const rangeIds = rangeSelection(orderedIds, selectedClipId, clipId);
      if (rangeIds) {
        setSelectedClips(additive ? mergeSelection(selectedClipIds, rangeIds) : rangeIds);
        setSelectedTrackIds([]);
        return;
      }
    }

    if (additive) {
      setSelectedClips(toggleSelection(selectedClipIds, clipId));
      setSelectedTrackIds([]);
      return;
    }

    selectClipSingle(clipId);
  }, [clips, selectedClipId, selectedClipIds, selectClipSingle, setSelectedClips]);

  const getSelectionForInit = useCallback((): AudioClip[] => {
    if (selectedClipIds.length > 0) return clips.filter((c) => selectedClipIds.includes(c.id));
    if (selectedTrackIds.length > 0) return clips.filter((c) => selectedTrackIds.includes(c.trackId));
    if (selectedClipId) {
      const clip = clips.find((c) => c.id === selectedClipId);
      return clip ? [clip] : [];
    }
    return [];
  }, [clips, selectedClipIds, selectedTrackIds, selectedClipId]);

  // The footer track menu loads Metamorph A or B from outside EDIT and asks for
  // the panel; a request made before EDIT mounted is taken on mount.
  const metamorphRequested = useMetamorphPanelRequest((s) => s.pending);
  useEffect(() => {
    if (!metamorphRequested) return;
    useMetamorphPanelRequest.getState().consume();
    setShowMetamorph(true);
  }, [metamorphRequested]);

  // ── Granular bleed straight from the clip menu ─────────────────────────
  // Metamorph (granular identity bleed) used to live only in the TOOLS
  // dropdown with two pickers. Here the selection IS the pickers: the
  // right-clicked clip is the HOST (structure) and the other selected clip
  // is the DONOR (identity). When the two overlap in time, only the overlap
  // is bled — a granular seam where a crossfade would normally go. The
  // render lands on a new track at the host's position as an ordinary
  // clip; nothing is modified in place. "Live" arms the same pair in the
  // real-time engine and opens the panel so the dials can be ridden.
  const bleedPartnerFor = useCallback((hostId: string): AudioClip | null => {
    const host = clips.find((c) => c.id === hostId);
    if (!host) return null;
    const others = clips.filter((c) => c.id !== hostId && selectedClipIds.includes(c.id));
    if (others.length === 0) return null;
    const hostEnd = host.startSec + host.durationSec;
    const overlapping = others.filter((c) => c.startSec < hostEnd && c.startSec + c.durationSec > host.startSec);
    const pool = overlapping.length > 0 ? overlapping : others;
    return [...pool].sort((a, b) => Math.abs(a.startSec - host.startSec) - Math.abs(b.startSec - host.startSec))[0] ?? null;
  }, [clips, selectedClipIds]);

  const clipOverlap = (a: AudioClip, b: AudioClip): { startSec: number; endSec: number } | null => {
    const s = Math.max(a.startSec, b.startSec);
    const e = Math.min(a.startSec + a.durationSec, b.startSec + b.durationSec);
    return e - s > 0.05 ? { startSec: s, endSec: e } : null;
  };

  /** The selection as a crossfade, or null. A crossfade needs exactly two
   *  clips, on ONE track, that actually overlap — anything else is two clips
   *  that happen to be selected together. */
  const crossfadePair = useMemo(() => {
    if (selectedClipIds.length !== 2) return null;
    const a = clips.find((c) => c.id === selectedClipIds[0]);
    const b = clips.find((c) => c.id === selectedClipIds[1]);
    if (!a || !b || a.trackId !== b.trackId) return null;
    const [region] = crossfadeRegions([a, b]);
    return region ? { a, b, region } : null;
  }, [clips, selectedClipIds]);

  /** Every overlap on every track, in lane coordinates, for the X drawn over
   *  it. A crossfade is not stored anywhere — it IS the overlap — so this is
   *  derived on each render from where the clips currently sit. */
  const crossfadeOverlaps = useMemo(() => (
    tracks.flatMap((track, trackIdx) => (
      crossfadeRegions(clips.filter((c) => c.trackId === track.id))
        .map((region) => ({ key: `${region.outId}:${region.inId}`, trackIdx, region }))
    ))
  ), [clips, tracks]);

  const bleedClips = useCallback(async (hostId: string, mode: 'render' | 'live') => {
    const host = clips.find((c) => c.id === hostId);
    const donor = bleedPartnerFor(hostId);
    if (!host || !donor) return;
    const title = (c: AudioClip) => c.label || tracks.find((t) => t.id === c.trackId)?.name || 'clip';
    const morph = useMorphStore.getState();
    try {
      // A MIDI clip with no render is rendered first (state/midiRenderQueue).
      const donorAudio = await clipWithAudio(donor.id);
      const hostAudio = await clipWithAudio(host.id);
      await morph.loadA({ id: `clip:${donor.id}`, title: title(donor), blob: donorAudio.audioBlob as Blob });
      await morph.loadB({ id: `clip:${host.id}`, title: title(host), blob: hostAudio.audioBlob as Blob });
    } catch (e) {
      logError('edit', `Bleed: could not load the pair — ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (mode === 'live') {
      setShowMetamorph(true);
      await useMorphStore.getState().play();
      return;
    }
    setIsBleeding(true);
    try {
      const blob = await useMorphStore.getState().renderToBlob();
      if (!blob) return;
      const ed = useEditorStore.getState();
      const seam = clipOverlap(host, donor);
      const name = `${title(donor)}→${title(host)}`.slice(0, 24);
      const trackId = ed.addTrack({ name });
      const color = ed.tracks.find((t) => t.id === trackId)?.color;
      const { peaks, duration } = await computePeaks(blob, 240);
      // The render spans the host's whole SOURCE; place it under the host's
      // window (or only the seam) so it lines up sample-for-sample.
      const startSec = seam ? seam.startSec : host.startSec;
      const durationSec = Math.min(
        seam ? seam.endSec - seam.startSec : host.durationSec,
        Math.max(0.05, duration - (host.offsetIntoSource + (startSec - host.startSec))),
      );
      const clipId = ed.addClipToTrack({
        trackId,
        label: seam ? `${name} · seam` : name,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        offsetIntoSource: host.offsetIntoSource + (startSec - host.startSec),
        durationSec,
        startSec,
        color,
      });
      ed.cachePeaks(clipId, peaks);
      logInfo('edit', seam
        ? `Bled the ${(seam.endSec - seam.startSec).toFixed(2)}s seam of "${title(donor)}" into "${title(host)}"`
        : `Bled "${title(donor)}" into "${title(host)}" on a new track`);
    } catch (e) {
      logError('edit', `Bleed render failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsBleeding(false);
    }
  }, [bleedPartnerFor, clips, tracks]);

  /** Queue the selection bounce. The render, the hand-off to MAKE's params
   *  store and the tab switch all happen in `runSelectionJob`. */
  const sendSelectionToInit = useCallback(() => {
    const selection = getSelectionForInit();
    if (selection.length === 0) {
      logError('editor', 'Select at least one clip or track first.');
      return;
    }
    enqueueBounce({
      kind: 'selection',
      label: selection.length === 1
        ? 'Selection → Init'
        : `Selection → Init · ${selection.length} clips`,
      request: selectionRequest(selection.map((c) => c.id)),
    });
  }, [getSelectionForInit]);

  const handleTrackHeaderPointerDown = useCallback((e: React.PointerEvent, trackId: string) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, button, select, textarea')) return;
    selectTrackWithModifiers(trackId, e);
  }, [selectTrackWithModifiers]);

  // Decode + cache peaks for any clip that doesn't have them yet, keyed PER
  // CLIP+BLOB (FE-007) with at most PEAKS_DECODE_CONCURRENCY running at once
  // AND NEVER MORE THAN ONE decode per clip id at a time (see
  // peaksDecodeScheduler.ts for the full history: a shared `cancelled` flag
  // used to abort every in-flight decode and restart the scan from the top on
  // ANY clips change; keying on id alone fixed that but then a decode for a
  // clip's OLD blob could settle after `acceptInpaint` / a take switch
  // replaced that clip's audio, writing the old audio's peaks onto the new
  // one; keying on id+blob fixed THAT but let a stale decode's slot get
  // silently overwritten instead of counted, so the concurrency cap could be
  // exceeded). `getPeaksQueue` owns the ONE queue instance for this
  // component's whole life — see `usePeaksDecodeQueue.ts` for why it has to
  // be built on demand and disposed+NULLED (not just disposed) on unmount:
  // StrictMode's dev-only mount→cleanup→remount dance killed the queue
  // forever otherwise, with no waveform for anything imported/recorded/
  // pasted/inpainted/take-switched after the remount.
  const getPeaksQueue = usePeaksDecodeQueue(PEAKS_DECODE_CONCURRENCY);
  // The blob that most recently FAILED to decode, per clip id: a clip whose
  // audio truly cannot be decoded must not be retried (and re-logged) on
  // every unrelated `clips` change (a drag, a rename elsewhere) — only once
  // its blob actually changes to something new. Pruned to the clips that
  // still exist before every sync (below): a deleted clip's entry would
  // otherwise pin its Blob in memory forever, never dropped by anything.
  const peaksFailedBlob = useRef<Map<string, Blob>>(new Map());
  useEffect(() => {
    const queue = getPeaksQueue();
    peaksFailedBlob.current = pruneFailedBlobs(peaksFailedBlob.current, new Set(clips.map((c) => c.id)));
    const startDecode = (item: { id: string; blob: Blob }): void => {
      void (async () => {
        try {
          const { peaks } = await computePeaks(item.blob, 240);
          peaksFailedBlob.current.delete(item.id);
          // Apply the result ONLY if the live clip still holds this EXACT
          // blob and still has no peaks: a clip that moved on to a newer
          // blob while this decode ran (or that already got peaks another
          // way) must not have a stale decode's result written onto it.
          const live = useEditorStore.getState().clips.find((c) => c.id === item.id);
          if (live && live.audioBlob === item.blob && !live.peaks) cachePeaks(item.id, peaks);
        } catch (e) {
          peaksFailedBlob.current.set(item.id, item.blob);
          // Read live, not the `clips` this effect closed over: this decode
          // can still be running long after a later render replaced that
          // closure, and the label should name the clip as it is now.
          const label = useEditorStore.getState().clips.find((c) => c.id === item.id)?.label ?? item.id;
          logError('editor', `Peak decode failed for ${label}: ${e instanceof Error ? e.message : e}`);
        } finally {
          queue.settle(item.id, item.blob, startDecode);
        }
      })();
    };
    queue.sync(clipsNeedingPeaksDecode(clips, peaksFailedBlob.current), startDecode);
  }, [clips, cachePeaks, getPeaksQueue]);


  const stopPreview = useCallback(() => {
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop(); } catch { /* ignore */ }
      previewSourceRef.current = null;
    }
  }, []);

  // --- Multi-track timeline playback (routes through the footer's playerStore) ---

  /** Full stop: halts playback AND rewinds to zero. Wired to the Stop button only. */
  const stopEditorPlayback = useCallback(() => {
    liveMixer.stop();
    stopPreview();
  }, [stopPreview]);

  /** Pause in place. liveMixer.pause() leaves the playhead where it stopped and
   *  play() resumes from it, so Space toggles play/pause the way every DAW does
   *  instead of rewinding the arrangement to the top on every tap. */
  const pauseEditorPlayback = useCallback(() => {
    liveMixer.pause();
    stopPreview();
  }, [stopPreview]);

  const playEditorTimeline = useCallback(async () => {
    // Read the clip count at call time instead of closing over it. `clips.length`
    // in this dep array changed the callback's identity on every clip add/delete,
    // which re-ran the attach effect below — cleanup → detach() → dispose() — and
    // tore the whole mixer graph down mid-playback. Dropping a clip onto a rolling
    // timeline, or pressing Delete, stopped the transport outright.
    if (useEditorStore.getState().clips.length === 0) return;
    // Re-arm follow-playhead: a manual scroll suspends following only for the
    // pass it happened in. (editorStore.isPlaying can't be used as the signal —
    // it has no writer anywhere; see swaySurface.)
    followPlayheadRef.current = true;
    stopPreview();
    setIsArmingPlayback(true);
    try {
      // Live multi-track playback — per-track volume / pan / mute / solo are
      // audible MID-playback (see state/liveMixer). The offline bounce is kept
      // for export (commitEdit / sendSelectionToInit), not for preview.
      await liveMixer.playAsync();
    } catch (e) {
      logError('editor', `Live playback failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsArmingPlayback(false);
    }
  }, [stopPreview]);

  // Register with bridge so PlayerFooter can trigger a fresh render+play, AND
  // register liveMixer as the footer's transport so its normal play/pause/seek
  // buttons drive the live multi-track engine. liveMixer.attach() returns a
  // disposer that stops playback + detaches on unmount.
  //
  // The transport callbacks are held in refs so this effect can be MOUNT-ONLY.
  // It previously depended on [playEditorTimeline, stopEditorPlayback], so any
  // change to either identity disposed and rebuilt the mixer. Fixing
  // playEditorTimeline's deps alone would work today but leaves the trap armed:
  // the next dep added to either callback would silently start killing playback
  // again. Refs make the teardown structurally impossible to trigger by re-render.
  const playEditorTimelineRef = useRef(playEditorTimeline);
  const stopEditorPlaybackRef = useRef(stopEditorPlayback);
  useEffect(() => { playEditorTimelineRef.current = playEditorTimeline; }, [playEditorTimeline]);
  useEffect(() => { stopEditorPlaybackRef.current = stopEditorPlayback; }, [stopEditorPlayback]);

  useEffect(() => {
    registerEditorPlayback(
      () => void playEditorTimelineRef.current(),
      () => stopEditorPlaybackRef.current(),
    );
    const detach = liveMixer.attach();
    return () => {
      unregisterEditorPlayback();
      detach();
    };
  }, []);

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
      // A MIDI clip with no render is rendered first (state/midiRenderQueue).
      const withAudio = await clipWithAudio(clip.id);
      const audioBuf = await decodeClipBlob(ctx, withAudio.audioBlob as Blob);
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      // Route through the shared master → analyser → destination chain. No gain
      // stage of our own: getMasterGain() is a unity summing bus and the
      // listening fader lives on the monitor node at the END of that chain
      // (playerStore), so scaling by playbackStore.volume here applied it twice
      // and auditioned a clip 20*log10(volume/100) below the same clip on the
      // timeline — 2.5 dB at the default 75, 10.5 dB at 30.
      src.connect(getMasterGain());
      src.onended = () => {
        if (previewSourceRef.current === src) previewSourceRef.current = null;
      };
      previewSourceRef.current = src;
      src.start(0, clip.offsetIntoSource, clip.durationSec);
      logInfo('editor', `Previewing: ${clip.label} (${clip.durationSec.toFixed(2)}s)`);
    } catch (e) {
      logError('editor', `Preview failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [clips, selectedClipId, stopPreview]);

  /* ── Clip clipboard + grid-aware edit actions ────────────────────────────────
     The clipboard holds the clip records themselves. Blobs (and cached peak
     arrays) are shared by reference with the source clips, not copied: they are
     only ever read, and the shared decode cache is keyed by Blob identity (and
     sample rate), so a pasted clip costs no extra decode and no extra memory. */
  const clipboardRef = useRef<AudioClip[]>([]);

  /** The clips a keyboard action applies to: the multi-selection if there is one,
   *  otherwise the single selected clip. Mirrors delete/duplicate's rule. */
  const getActionClips = useCallback((): AudioClip[] => {
    const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    if (ids.length === 0) return [];
    return clips.filter((c) => ids.includes(c.id));
  }, [clips, selectedClipId, selectedClipIds]);

  const copySelectedClips = useCallback((): number => {
    const sel = getActionClips();
    if (sel.length === 0) return 0;
    clipboardRef.current = sel.map((c) => ({ ...c }));
    logInfo('editor', `Copied ${sel.length} clip${sel.length === 1 ? '' : 's'}`);
    return sel.length;
  }, [getActionClips]);

  const cutSelectedClips = useCallback(() => {
    if (copySelectedClips() === 0) return;
    deleteSelectedClips();
  }, [copySelectedClips, deleteSelectedClips]);

  /** Paste at the edit cursor, preserving the clips' relative timing and their
   *  track layout. A clip whose original track is gone lands on the first track.
   *  The edit cursor, not the playhead: a click while playing places the cursor
   *  without moving the transport (F06), and the paste goes where the user put it.
   *
   *  `opts` is what the timeline's right-click "Paste clip here" passes: the
   *  clicked time instead of the edit cursor, and the clicked lane instead of each
   *  clip's original track (so a paste lands where the user pointed). */
  const pasteClips = useCallback((opts?: { atSec?: number; trackId?: string }) => {
    const buf = clipboardRef.current;
    if (buf.length === 0) return;
    const anchor = snapSec(opts?.atSec ?? useEditorStore.getState().editCursorSec);
    const earliest = Math.min(...buf.map((c) => c.startSec));
    const liveTracks = useEditorStore.getState().tracks;
    const fallbackTrackId = opts?.trackId ?? liveTracks[0]?.id;
    if (!fallbackTrackId) return;
    // Pasting AT a lane re-homes the earliest clip onto it and keeps the rest
    // in their own lanes only when those still exist.
    const anchorTrackId = buf.reduce((a, c) => (c.startSec < a.startSec ? c : a), buf[0]).trackId;
    const newIds = buf.map((c) => {
      const trackId =
        opts?.trackId && c.trackId === anchorTrackId
          ? opts.trackId
          : liveTracks.some((t) => t.id === c.trackId)
            ? c.trackId
            : fallbackTrackId;
      const { id: _omit, ...rest } = c;
      return addClipToTrack({ ...rest, trackId, startSec: Math.max(0, anchor + (c.startSec - earliest)) });
    });
    setSelectedClips(newIds);
    setSelectedTrackIds([]);
    logInfo('editor', `Pasted ${newIds.length} clip${newIds.length === 1 ? '' : 's'} at ${anchor.toFixed(2)}s`);
  }, [addClipToTrack, setSelectedClips, snapSec]);

  /** Split every selected clip that straddles the playhead. splitClipAt already
   *  refuses cuts within 50ms of an edge, so a clip barely overlapping is skipped. */
  const splitSelectedAtPlayhead = useCallback(() => {
    const at = useEditorStore.getState().playheadSec;
    const targets = getActionClips().filter((c) => at > c.startSec && at < c.startSec + c.durationSec);
    if (targets.length === 0) {
      logError('editor', 'Move the playhead over a selected clip to split it.');
      return;
    }
    const newIds = targets.map((c) => splitClipAt(c.id, at)).filter((id): id is string => !!id);
    if (newIds.length > 0) {
      setSelectedClips(newIds);
      setSelectedTrackIds([]);
    }
  }, [getActionClips, setSelectedClips, splitClipAt]);

  /** One nudge step: one division of the snap grid where `atSec` sits (a bar
   *  of the meter there for 'Bar', at the tempo there), else a flat 50ms.
   *  Shift multiplies by 4 for coarse moves. */
  const nudgeStepSec = useCallback((coarse: boolean, atSec: number): number => {
    const step = snapStepSecAt(useEditorStore.getState(), atSec) ?? 0.05;
    return coarse ? step * 4 : step;
  }, []);

  const nudgeSelectedClips = useCallback((dir: -1 | 1, coarse: boolean) => {
    const sel = getActionClips();
    if (sel.length === 0) return;
    // Clamp as a group so a nudge left never collapses the selection's internal
    // spacing against t=0 — the whole block stops when its earliest clip hits 0.
    const earliest = Math.min(...sel.map((c) => c.startSec));
    const delta = nudgeStepSec(coarse, earliest) * dir;
    const applied = Math.max(delta, -earliest);
    if (applied === 0) return;
    sel.forEach((c) => updateClip(c.id, { startSec: Math.max(0, c.startSec + applied) }));
  }, [getActionClips, nudgeStepSec, updateClip]);

  /** Move the selection up/down one track, the way arrow-key track moves work in
   *  Reaper and Logic. Clamped so the selection keeps its relative track spread. */
  const moveSelectedClipsByTrack = useCallback((dir: -1 | 1) => {
    const sel = getActionClips();
    if (sel.length === 0 || tracks.length === 0) return;
    const idxOf = new Map(tracks.map((t, i) => [t.id, i]));
    const indices = sel.map((c) => idxOf.get(c.trackId) ?? 0);
    const room = dir < 0 ? -Math.min(...indices) : tracks.length - 1 - Math.max(...indices);
    const shift = dir < 0 ? Math.max(dir, room) : Math.min(dir, room);
    if (shift === 0) return;
    sel.forEach((c) => {
      const target = tracks[(idxOf.get(c.trackId) ?? 0) + shift];
      if (target) updateClip(c.id, { trackId: target.id });
    });
  }, [getActionClips, tracks, updateClip]);

  const selectAllClips = useCallback(() => {
    if (clips.length === 0) return;
    const ids = clips.map((c) => c.id);
    setSelectedClips(ids);
    setSelectedTrackIds([]);
  }, [clips, setSelectedClips]);

  /* --- Zoom (F07). Every zoom entry point — wheel, toolbar +/-, +/- keys, fit,
     zoom to selection / selected clips — goes through requestZoom, which keeps
     the EDIT CURSOR centred (not the pointer, not time 0, not the left edge).
     The new scrollLeft cannot be written in the same tick as setZoom: the lanes
     are still the old width, so the browser would clamp the write and the
     anchor would drift. It is parked in pendingZoomScrollRef and applied by the
     layout effect below once the wider content is committed. */
  const pendingZoomScrollRef = useRef<number | null>(null);

  /** The scroller's visible width in LOCAL px. Its on-screen rect is viewport
   *  px (divide by the cumulative CSS zoom) and includes the vertical
   *  scrollbar (local px, subtracted after). The track-header column is a
   *  sibling outside the scroller, so there is no header width to exclude. */
  const measureViewportWidth = useCallback((el: HTMLElement): number => {
    const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth);
    return Math.max(0, localViewportWidth({
      rectWidthPx: el.getBoundingClientRect().width,
      layoutZoom: effectiveZoom(el),
      headerColumnPx: 0,
    }) - scrollbar);
  }, []);

  /** Claim the scroll events of this frame as ours, so the follow-playhead
   *  listener does not read them as the user taking the scrollbar. Cleared on
   *  the next frame, after the scroll events it covers have been dispatched. */
  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = true;
    requestAnimationFrame(() => { programmaticScrollRef.current = false; });
  }, []);

  /** A scroll write that is ours. */
  const writeProgrammaticScrollLeft = useCallback((el: HTMLElement, left: number) => {
    markProgrammaticScroll();
    el.scrollLeft = left;
  }, [markProgrammaticScroll]);

  /** Zoom to `nextZoom` px/s (clamped to ZOOM_MIN..ZOOM_MAX) keeping `anchor`
   *  — the edit cursor unless told otherwise, clamped into the project — at
   *  the centre of the viewport where the content allows it. */
  const requestZoom = useCallback((nextZoom: number, anchor: ZoomAnchor = 'edit-cursor', isExplicitCommand = false) => {
    if (!Number.isFinite(nextZoom) || nextZoom <= 0) return;
    const st = useEditorStore.getState();
    const el = timelineScrollRef.current;
    const viewportWidth = el ? measureViewportWidth(el) : 0;
    if (!el || viewportWidth <= 0) {
      st.setZoom(nextZoom);
      return;
    }
    const totalDurationSec = st.getTotalDurationSec();
    const plan = planZoom({
      requestedZoom: nextZoom,
      anchorSec: resolveAnchorSec(anchor, st.editCursorSec, totalDurationSec),
      totalDurationSec,
      viewportWidth,
      bounds: { min: ZOOM_MIN, max: ZOOM_MAX },
    });
    // While the transport rolls, follow-playhead would page away from the
    // anchor on the very next frame; hold it off briefly (it stays armed).
    zoomFollowHoldUntilRef.current = performance.now() + ZOOM_FOLLOW_HOLD_MS;
    if (plan.zoom === st.zoom) {
      // Same width: nothing to wait for. A no-op or bound-clamped request —
      // every wheel tick past ZOOM_MIN/ZOOM_MAX lands here — must not yank the
      // view back to the anchor; only an explicit command still moves it.
      pendingZoomScrollRef.current = null;
      if (shouldRescrollAfterZoom(st.zoom, plan.zoom, isExplicitCommand)) {
        writeProgrammaticScrollLeft(el, plan.scrollLeft);
      }
      return;
    }
    pendingZoomScrollRef.current = plan.scrollLeft;
    // Zooming out shrinks the lanes, and the browser clamps scrollLeft as they
    // shrink — that scroll event is a consequence of this zoom, not the user
    // grabbing the scrollbar, so claim it before the width changes.
    markProgrammaticScroll();
    st.setZoom(plan.zoom);
  }, [markProgrammaticScroll, measureViewportWidth, writeProgrammaticScrollLeft]);

  useLayoutEffect(() => {
    const left = pendingZoomScrollRef.current;
    if (left === null) return;
    pendingZoomScrollRef.current = null;
    const el = timelineScrollRef.current;
    if (el) writeProgrammaticScrollLeft(el, left);
  }, [zoom, writeProgrammaticScrollLeft]);

  /** One discrete zoom step (toolbar buttons, +/- keys). */
  const zoomStepBy = useCallback((direction: 'in' | 'out') => {
    const z = useEditorStore.getState().zoom;
    requestZoom(direction === 'in' ? z * ZOOM_STEP_FACTOR : z / ZOOM_STEP_FACTOR);
  }, [requestZoom]);

  /** Wheel bursts: one zoom request per animation frame. */
  const zoomCoalescerRef = useRef<ZoomCoalescer | null>(null);
  const requestZoomRef = useRef(requestZoom);
  if (zoomCoalescerRef.current === null) {
    zoomCoalescerRef.current = createZoomCoalescer({
      schedule: (cb) => requestAnimationFrame(cb),
      cancel: (id) => cancelAnimationFrame(id),
      readZoom: () => useEditorStore.getState().zoom,
      apply: (z) => requestZoomRef.current(z),
      bounds: { min: ZOOM_MIN, max: ZOOM_MAX },
    });
  }
  useEffect(() => () => zoomCoalescerRef.current?.cancel(), []);

  /** Fit [startSec, endSec] with a 5 % margin on each side, centred on it. */
  const zoomToRange = useCallback((startSec: number, endSec: number) => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const fit = fitRangeZoom(startSec, endSec, measureViewportWidth(el));
    if (fit) requestZoom(fit.zoom, { sec: fit.centerSec }, true);
  }, [measureViewportWidth, requestZoom]);

  /* ── Reveal a clip (F19) ──────────────────────────────────────────────────
     The AUDIO EDIT drawer's "Reveal in timeline" key dispatches
     `thedaw:reveal-clip`; this brings the clip into view here. Three things,
     in the order a user reads them: the clip becomes the selection, the lanes
     scroll to it, and the edit cursor parks on its start (so the next Space,
     split or paste acts there).

     BOTH scroll writes are claimed as ours FIRST. The follow-playhead listener
     treats any unclaimed scroll as the user grabbing the scrollbar and disarms
     itself, and revealing a clip must not cost the user follow-playhead on the
     next transport start. Neither axis is touched when the clip is already in
     view — scrolling to something you can see is just a jump. */
  useEffect(() => {
    const onReveal = (e: Event) => {
      const clipId = (e as CustomEvent<RevealClipDetail>).detail?.clipId;
      if (typeof clipId !== 'string' || clipId.length === 0) return;
      const st = useEditorStore.getState();
      const clip = st.clips.find((c) => c.id === clipId);
      if (!clip) {
        logError('editor', `Cannot reveal clip ${clipId.slice(0, 8)}: it is no longer in the project`);
        return;
      }
      selectClipSingle(clipId);
      setEditCursor(Math.max(0, clip.startSec));

      const el = timelineScrollRef.current;
      if (!el) return;
      const laneH = st.trackHeight;
      const leftPx = clip.startSec * st.zoom;
      const rightPx = (clip.startSec + clip.durationSec) * st.zoom;
      const viewW = measureViewportWidth(el);
      const trackIdx = st.tracks.findIndex((t) => t.id === clip.trackId);
      const topPx = trackIdx * laneH;
      const viewH = el.clientHeight;
      const needsX = viewW > 0 && (leftPx < el.scrollLeft || rightPx > el.scrollLeft + viewW);
      const needsY = trackIdx >= 0 && viewH > 0 && (topPx < el.scrollTop || topPx + laneH > el.scrollTop + viewH);
      if (!needsX && !needsY) return;
      markProgrammaticScroll();
      // A margin ahead of the clip rather than hard against the left edge, so
      // what comes before it stays readable — the same lead follow-playhead uses.
      if (needsX) el.scrollLeft = Math.max(0, leftPx - viewW * 0.15);
      if (needsY) el.scrollTop = Math.max(0, topPx - Math.max(0, (viewH - laneH) / 2));
    };
    window.addEventListener(REVEAL_CLIP_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_CLIP_EVENT, onReveal);
  }, [selectClipSingle, setEditCursor, measureViewportWidth, markProgrammaticScroll]);

  /** Fit the whole arrangement in the viewport ("whole project": anchored on
   *  the project centre, so the clamp lands at the start). */
  const zoomToFit = useCallback(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const fit = fitProjectZoom(getTotalDurationSec(), measureViewportWidth(el));
    if (fit) requestZoom(fit.zoom, { sec: fit.centerSec }, true);
  }, [getTotalDurationSec, measureViewportWidth, requestZoom]);

  // --- Keyboard hotkeys ---
  // v          = move tool                 c            = cut tool
  // s          = split selection at playhead
  // Space      = play / pause              Delete       = remove selected clip(s)
  // ←/→        = nudge by grid (Shift ×4)  ↑/↓          = move a track up / down
  // Home/End   = playhead to start / end   m            = marker at playhead
  // l          = toggle loop               +/-          = zoom in / out
  // Shift+F    = zoom to fit               Escape       = clear clips, then range, then inpaint mask
  // Ctrl/Cmd + C/X/V = copy / cut / paste at the edit cursor
  // Ctrl/Cmd + D = duplicate               Ctrl/Cmd + A = select all clips
  // Ctrl/Cmd + P = inpaint selection       (Ctrl/Cmd + Z/Y = undo/redo, own effect)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Someone ahead of us already handled this key (an open ContextMenu takes
      // Escape, for one). Listener order between two window handlers depends on
      // which effect re-registered last, so the flag is what decides, not luck.
      if (e.defaultPrevented) return;
      // Keys the focused control uses itself stay with it: everything in a text field, and
      // type-to-jump in a dropdown such as the snap-division picker (the bare-letter hotkeys
      // below - s / m / l / f - would otherwise steal it). A fader only keeps the keys that
      // move it, so Space and the hotkeys still work right after a fader ride.
      if (keyBelongsToFocusedControl(e)) return;
      // Alt+Shift+Arrow moves the selected TRACKS one row (F01) — the same edit
      // the header grip's Alt+Arrow makes, reachable without focusing a grip.
      // Alt alone belongs to the lane keys, so the Shift is what distinguishes
      // "move the tracks" from them.
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const st = useEditorStore.getState();
        if (st.selectedTrackIds.length === 0) return;
        e.preventDefault();
        st.moveTracksByOffset(st.selectedTrackIds, e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
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
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          splitSelectedAtPlayhead();
          return;
        }
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          addMarker(useEditorStore.getState().playheadSec);
          return;
        }
        if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          setLoopEnabled(!useEditorStore.getState().loopEnabled);
          return;
        }
        // Shift+F fits the arrangement to the viewport; bare f is left free.
        if ((e.key === 'f' || e.key === 'F') && e.shiftKey) {
          e.preventDefault();
          zoomToFit();
          return;
        }
        if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          zoomStepBy('in');
          return;
        }
        if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          zoomStepBy('out');
          return;
        }
        // Home/End move the edit cursor AND the transport (a real seek, so a
        // rolling timeline keeps rolling from the new point).
        if (e.key === 'Home') {
          e.preventDefault();
          setEditCursor(0);
          seekEditorTo(0);
          return;
        }
        if (e.key === 'End') {
          e.preventDefault();
          const end = getTotalDurationSec();
          setEditCursor(end);
          seekEditorTo(end);
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          if (selectedClipCount === 0) return;
          e.preventDefault();
          nudgeSelectedClips(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey);
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          if (selectedClipCount === 0) return;
          e.preventDefault();
          moveSelectedClipsByTrack(e.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        if (e.key === ' ') {
          e.preventDefault();
          if (isEditorTimelinePlaying()) pauseEditorPlayback();
          else void playEditorTimeline();
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          // The bottom dock (piano roll / step sequencer) is global chrome and
          // binds Delete for its own selection. Yield when the pointer or focus
          // is over it; `fallback: true` keeps the timeline the default owner
          // when the user hasn't touched either surface. See lib/keyScope.
          if (!ownsKey('edit-timeline', { fallback: true })) return;
          if (selectedClipCount > 0) {
            e.preventDefault();
            deleteSelectedClips();
          }
          return;
        }
        if (e.key === '?') {
          e.preventDefault();
          setShowShortcuts((v) => !v);
          return;
        }
        // F2 = name and colour of the selected clip (REAPER's item-properties key).
        if (e.key === 'F2') {
          const st = useEditorStore.getState();
          const clipId = st.selectedClipId ?? st.selectedClipIds[0];
          if (!clipId || !containerRef.current?.offsetParent) return;
          e.preventDefault();
          const el = Array.from(document.querySelectorAll<HTMLElement>('[data-clip="1"][data-clip-id]')).find(
            (n) => n.dataset.clipId === clipId,
          );
          const r = el?.getBoundingClientRect();
          setClipNamePanel({
            clipId,
            x: Math.round(r ? Math.max(8, r.left) : window.innerWidth / 2 - 144),
            y: Math.round(r ? r.bottom + 4 : 160),
          });
          return;
        }
        if (e.key === 'Escape') {
          if (showShortcutsRef.current) {
            setShowShortcuts(false);
            return;
          }
          // Same hidden-tab guard as the undo handler: EDIT stays mounted
          // behind other tabs, and Escape there must not clear its selection.
          if (!containerRef.current?.offsetParent) return;
          timelineEscapeRef.current();
          return;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        // Ctrl/Cmd + C / X / V = copy / cut / paste-at-edit-cursor. If the user has
        // actually selected text somewhere on the page (a label, a log line), let
        // the browser's own copy win instead of hijacking it for clips.
        const hasTextSelection = !(window.getSelection()?.isCollapsed ?? true);
        if (k === 'c') {
          if (hasTextSelection) return;
          e.preventDefault();
          copySelectedClips();
          return;
        }
        if (k === 'x') {
          if (hasTextSelection) return;
          e.preventDefault();
          cutSelectedClips();
          return;
        }
        if (k === 'v') {
          e.preventDefault();
          pasteClips();
          return;
        }
        // Ctrl/Cmd + A = select every clip on the timeline.
        if (k === 'a') {
          e.preventDefault();
          selectAllClips();
          return;
        }
        // Ctrl/Cmd + D = duplicate selected clip.
        if (k === 'd') {
          e.preventDefault();
          duplicateSelectedClips();
          return;
        }
        // Ctrl/Cmd + P = inpaint selected region.
        if (k === 'p') {
          e.preventDefault();
          openInpaintPanel();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    selectedClipCount, setTool, pauseEditorPlayback, playEditorTimeline, deleteSelectedClips,
    duplicateSelectedClips, openInpaintPanel, splitSelectedAtPlayhead,
    addMarker, setLoopEnabled, zoomToFit, zoomStepBy, setEditCursor, seekEditorTo, getTotalDurationSec,
    nudgeSelectedClips, moveSelectedClipsByTrack, copySelectedClips, cutSelectedClips,
    pasteClips, selectAllClips,
  ]);

  // --- Wheel (F08): the selected profile in useTimelinePrefs decides what each
  // modifier does; the gesture itself is read by lib/editWheel. theDAW default
  // (EDIT_WHEEL_BINDINGS): wheel = vertical scroll, Shift = horizontal scroll,
  // Ctrl (Cmd on macOS) = time zoom, Alt = track height, Ctrl+Shift = fine
  // time zoom. The lane scroller and the track header column share one
  // handler. Zooms go through requestZoom (edit-cursor anchored), one per
  // frame. Form fields and anything under [data-wheel-passthrough] (editable
  // automation lanes, popovers) keep their own wheel, as does a child that
  // already consumed the event (a focused header knob); so does any gesture
  // the profile does not handle; preventDefault only when the editor acts.
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  /** The mounted scroller as state, so effects that attach listeners re-run
   *  when it (re)mounts instead of depending on mount order. */
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const setTimelineScroller = useCallback((el: HTMLDivElement | null) => {
    timelineScrollRef.current = el;
    setScrollerEl(el);
  }, []);
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  const wheelHandler = (e: WheelEvent) => {
    const el = timelineScrollRef.current;
    if (!el || e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;
    if (isWheelExcludedTarget(target)) return;
    const prefs = useTimelinePrefs.getState();
    const st = useEditorStore.getState();
    const d = wheelDispatch(
      e,
      WHEEL_PROFILES[prefs.wheelProfile],
      el.clientHeight,
      { coarseSpeed: prefs.coarseZoomSpeed, fineSpeed: prefs.fineZoomSpeed },
      { trackHeight: st.trackHeight, min: TRACK_HEIGHT_MIN, max: TRACK_HEIGHT_MAX },
    );
    switch (d.kind) {
      case 'none':
        return;
      case 'zoom':
        e.preventDefault();
        zoomCoalescerRef.current?.push(d.factor);
        return;
      case 'scroll-x':
        e.preventDefault();
        el.scrollLeft += d.px;
        return;
      case 'scroll-y':
        e.preventDefault();
        el.scrollTop += d.px;
        return;
      case 'lane-height':
        e.preventDefault();
        st.setTrackHeight(d.height);
        return;
    }
  };
  useEffect(() => {
    if (!scrollerEl) return;
    const onWheel = (e: WheelEvent) => wheelHandlerRef.current(e);
    scrollerEl.addEventListener('wheel', onWheel, { passive: false });
    // The track header column mounts in the same body as the scroller and
    // mirrors its scrollTop, so a wheel over the headers moves the lanes too.
    const headerEl = trackHeaderScrollRef.current;
    headerEl?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      scrollerEl.removeEventListener('wheel', onWheel);
      headerEl?.removeEventListener('wheel', onWheel);
    };
  }, [scrollerEl]);

  /* Visible window of the scroller (local px), for the grid window, the ruler's
     bar numbers and the clip chrome. Updated at most once per frame on scroll
     and on resize — never from playback frames (follow-playhead only moves it
     when it pages). */
  const [viewport, setViewport] = useState<{ scrollLeft: number; width: number }>({ scrollLeft: 0, width: 0 });
  const viewportRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!scrollerEl) return;
    const sync = () => {
      viewportRafRef.current = null;
      const next = { scrollLeft: scrollerEl.scrollLeft, width: measureViewportWidth(scrollerEl) };
      setViewport((prev) => (prev.scrollLeft === next.scrollLeft && prev.width === next.width ? prev : next));
    };
    const schedule = () => {
      if (viewportRafRef.current === null) viewportRafRef.current = requestAnimationFrame(sync);
    };
    scrollerEl.addEventListener('scroll', schedule, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(scrollerEl);
    sync();
    return () => {
      scrollerEl.removeEventListener('scroll', schedule);
      ro?.disconnect();
      if (viewportRafRef.current !== null) cancelAnimationFrame(viewportRafRef.current);
      viewportRafRef.current = null;
    };
  }, [scrollerEl, measureViewportWidth]);

  // --- Right-click context menu (uses shared ContextMenu primitive) ---
  const clipMenu = useContextMenu<{ clipId: string; atSec: number }>();
  const trackMenu = useContextMenu<{ trackId: string }>();
  /** The timeline's "Add to track" menu. Its payload is the lane + time the
   *  right-click resolved to; a null trackId means "below every lane", which
   *  adds to a new track exactly as dropping there does. */
  const addMenu = useContextMenu<AddToTrackTarget>();
  /** The time-range menu (F04): a right-click INSIDE the range. A right-click
   *  never clears a highlight (T44 rule 5) — "Clear range" in this menu is the
   *  only way one of them removes a range.
   *  `trackId` / `clipId` are what was under the pointer, for the rows that
   *  need a lane or a clip. */
  const rangeMenu = useContextMenu<{ range: TimeRange; trackId: string | null; clipId?: string; sec: number }>();
  // The range the 'Render range…' row was chosen for, captured at menu time, plus where the
  // menu stood so the popover opens beside it. Opening it never touches the time selection,
  // the edit cursor or the playhead.
  const [rangeRender, setRangeRender] = useState<{ startSec: number; endSec: number; x: number; y: number } | null>(null);
  const addInputUid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const addAudioInputId = `editor-add-audio-${addInputUid}`;
  const addMidiInputId = `editor-add-midi-${addInputUid}`;
  const addMidiTracksInputId = `editor-add-midi-tracks-${addInputUid}`;

  /** The range menu when a right-click at (`sec`, `trackId`) lands inside the
   *  time range; true when it opened. Opening it changes no selection. */
  const openRangeMenuIfInside = (e: React.MouseEvent, sec: number, trackId: string | null, clipId?: string): boolean => {
    const st = useEditorStore.getState();
    const ctx = contextAt(
      { clipIds: st.selectedClipIds, range: st.timeSelection },
      clipId !== undefined ? { trackId, sec, clipId } : { trackId, sec },
    );
    if (ctx.kind !== 'time-range') return false;
    rangeMenu.open(e, { range: ctx.range, trackId, clipId: ctx.clipId, sec });
    return true;
  };

  const openContextMenu = (e: React.MouseEvent, clipId: string) => {
    e.stopPropagation();
    const atSec = timelineClientXToSec(e.clientX);
    const hitClip = clips.find((c) => c.id === clipId);
    // Inside the time range the range menu wins (F04); "Clip actions…" in it
    // reaches this clip's own menu.
    if (openRangeMenuIfInside(e, Math.max(0, atSec), hitClip?.trackId ?? null, clipId)) return;
    if (!selectedClipIds.includes(clipId)) {
      selectClipSingle(clipId);
    }
    // The "Insert stem…" group needs the entry's separated stems; a right-click
    // is the only moment it matters, so the read starts here rather than on mount.
    warmClipStems(hitClip?.libraryEntryId);
    clipMenu.open(e, { clipId, atSec });
  };

  // Queue the master mixdown. The render, the library entry and the Save As all
  // happen in `runMixdownJob`; pressing COMMIT EDIT twice queues two mixdowns
  // instead of running two OfflineAudioContexts against each other.
  const commitEdit = useCallback(() => {
    if (useEditorStore.getState().clips.length === 0) {
      logError('editor', 'No clips to commit');
      return;
    }
    // The label IS the filename the runner writes under, so the jobs pill names
    // the file rather than the verb.
    const jobId = enqueueBounce({
      kind: 'mixdown',
      label: mixdownTitle(mixdownName),
      request: mixdownRequest(),
    });
    // D18: whether this job's label is text the user typed, decided HERE
    // (the one place that actually knows), not re-derived from the label's
    // text later.
    setMixdownJobExplicitName(jobId, mixdownName.trim().length > 0);
  }, [mixdownName]);

  // --- Master VST freeze (render-on-change) ----------------------------------
  const editorBpm = useEditorStore((s) => s.bpm);
  // Populate the VST3 browser on first mount (cached scan — cheap).
  useEffect(() => { void scanVst(false); }, [scanVst]);

  // Signature of everything that affects the rendered master, so a frozen render
  // can be flagged stale after edits (and re-renders are skipped when unchanged).
  // The rule lives in editorStore.freezeSignature, with the test that holds it
  // to every field a renderer reads; `documentFreezeSignature` is the same call
  // the freeze stamps its render with.
  const freezeSig = useMemo(
    () => documentFreezeSignature(
      { clips, tracks, masterFxChain, masterVstChain, bpm: editorBpm, buses, routing, automationLanes },
      // A MIDI clip with no program of its own or on its track renders through the picker.
      { useSoundfont: sfEnabled, activeProgram: sfActiveProgram },
    ),
    [clips, tracks, masterFxChain, masterVstChain, editorBpm, buses, routing, automationLanes, sfEnabled, sfActiveProgram],
  );

  const frozenStale = !frozenMaster || frozenMaster.sig !== freezeSig;

  // Queue the master VST freeze — the full-fidelity master bounce with every
  // track's and bus's VST3 inserts printed in place, then one
  // /api/vst/process-file hop per enabled master VST, in chain order — and wait
  // for the printed blob. All of it runs in `runStemJob`.
  const renderFrozenMaster = useCallback(async (): Promise<Blob | null> => {
    const st = useEditorStore.getState();
    // The entries the print runs through a host, by the rule the print itself uses.
    const vsts = st.masterVstChain.filter((e) => e.enabled && !!e.vst?.plugin_path);
    if (vsts.length === 0) {
      logError('editor', 'Add a master VST before rendering.');
      return null;
    }
    if (st.clips.length === 0) {
      logError('editor', 'No clips to render.');
      return null;
    }
    // The one render the caller cannot walk away from: `enterFrozenMode` has to
    // load the returned blob into the player, so this awaits the settled job
    // rather than firing and forgetting. A failure or a cancel both come back
    // as a job that is not `done` — null, and the caller stays where it is.
    const job = await enqueueBounceAndWait({
      kind: 'freeze',
      label: `Master VST freeze · ${vsts.length} plugin${vsts.length === 1 ? '' : 's'}`,
      request: mixdownRequest(),
    });
    return job.status === 'done' ? job.result?.blob ?? null : null;
  }, []);

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

  // --- Per-track VST freeze ---------------------------------------------------
  // An offline render cannot host a VST3, so "freezing" a track renders it
  // offline — its clips and rack FX baked locally, each VST3 printed on the
  // backend at its place in the chain — into one printed stem the normal clip
  // path plays back. Mirrors the master freeze,
  // and shares its runner: both are `freeze` jobs, told apart by `job.trackId`
  // (see `runStemJob` at the top of this file).

  /** Queue a track freeze. The stem render, the backend plugin hops and
   *  `freezeTrack` itself all happen in `runStemJob`; a freeze on another track
   *  queues behind this one instead of being refused. */
  const freezeTrackAction = useCallback((trackId: string) => {
    const st = useEditorStore.getState();
    const track = st.tracks.find((t) => t.id === trackId);
    if (!track) return;
    if (!st.clips.some((c) => c.trackId === trackId)) {
      logError('editor', 'Track has no clips to freeze.');
      return;
    }
    const hasVsts = activeTrackInstrument(track) !== null || (track.fxChain ?? []).some((e) => e.enabled && e.effect === 'vst3' && e.vst);
    enqueueBounce({
      kind: 'freeze',
      trackId,
      label: `Freeze ${track.name}`,
      request: stemRequest(trackId, hasVsts),
    });
  }, []);

  const unfreezeTrackAction = useCallback((trackId: string) => {
    usePlayerStore.getState().stop();
    useEditorStore.getState().unfreezeTrack(trackId);
    liveMixer.reactivate();
  }, []);

  /* --- Pointer math helpers. ------------------------------------------------
     TWO COORDINATE SPACES. The shell scales the whole DAW with CSS `zoom` on
     .dense-layout (0.85 / 0.95 / 1.1 by breakpoint — index.css). So:
        event.clientX / getBoundingClientRect()  ->  VIEWPORT px  (local * zoom)
        scrollLeft / clientWidth / style widths  ->  LOCAL px
     `zoom` here is px-per-second in LOCAL px, so every measurement taken from a
     pointer event must be divided by the cumulative CSS zoom before it is mixed
     with a local-space value or handed to pxToSec. Skipping that made every
     seek, split point, loop edge, marker drop and drag-delta read ~15% short at
     the default tier. canvasScale.effectiveZoom walks computed `zoom` up the
     ancestor chain, which also stays correct inside counter-zoomed panels. */
  const pxToSec = useCallback((px: number) => px / zoom, [zoom]);

  /** Cumulative CSS zoom on the timeline subtree (1 when unscaled). */
  const layoutZoom = useCallback(
    (): number => effectiveZoom(timelineScrollRef.current ?? timelineRef.current),
    [],
  );
  /** Viewport-px delta (from clientX/clientY arithmetic) -> local px. */
  const viewportPxToLocal = useCallback((px: number): number => px / layoutZoom(), [layoutZoom]);

  const timelineClientXToSec = useCallback((clientX: number): number => {
    const scroller = timelineScrollRef.current;
    const timeline = timelineRef.current;
    const rect = (scroller ?? timeline)?.getBoundingClientRect();
    if (!rect) return 0;
    // (clientX - rect.left) is viewport px; scrollLeft is already local px.
    return pxToSec((clientX - rect.left) / layoutZoom() + (scroller?.scrollLeft ?? 0));
  }, [pxToSec, layoutZoom]);

  /** For handlers measuring against the scrolling CONTENT rect (timelineRef),
   *  whose rect.left already accounts for scroll — scale only, no scrollLeft. */
  const contentClientXToSec = useCallback((clientX: number): number => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return pxToSec((clientX - rect.left) / layoutZoom());
  }, [pxToSec, layoutZoom]);

  // --- Inpaint drag handlers ---
  const handleInpaintDragStart = (e: React.PointerEvent, clip: AudioClip) => {
    if (tool === 'cut') return;
    // Alt belongs to the slip gesture. This overlay covers the whole waveform
    // body, so without this the clip's own pointerdown never sees the drag.
    if (e.altKey) return;
    e.stopPropagation();
    // Primary button only. A right-click (or a mac ctrl-click) is on its way to
    // a context menu: it must not capture the pointer, mask anything, or later
    // read as a clip-body click.
    if (!isPrimaryGestureButton(e, IS_MAC)) return;
    // A press on the waveform selects the clip, exactly as a press on its title bar does (and as
    // REAPER does for a media item: click = select item + move edit cursor, Ctrl toggles, Shift
    // takes the range). Before this only the title bar selected, so clicking clip B's waveform and
    // pressing Delete removed whatever had been selected before.
    selectClipWithModifiers(clip.id, e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const anchorSec = timelineClientXToSec(e.clientX);
    inpaintDragRef.current = { clipId: clip.id, anchorSec, originX: e.clientX, originY: e.clientY };
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
      // The other half of T44 rule 3: only one highlight at a time, so drawing a
      // mask puts away the time range. Guarded against a per-pointermove write.
      if (useEditorStore.getState().timeSelection) setTimeSelection(null);
    }
  };

  const handleInpaintDragEnd = (e: React.PointerEvent) => {
    const drag = inpaintDragRef.current;
    const sel = useEditorStore.getState().inpaintSelection;
    if (sel && sel.endSec - sel.startSec < 0.1) {
      clearInpaintSelection();
    }
    inpaintDragRef.current = null;
    // A PRIMARY press released where it began is a clip-body click, which places
    // the edit cursor (and seeks only when the click profile says so).
    if (
      drag && isPrimaryGestureButton(e, IS_MAC) &&
      clipGesturePhase(e.clientX - drag.originX, e.clientY - drag.originY) === 'click'
    ) {
      const hitClip = clips.find((c) => c.id === drag.clipId);
      placeClickAt(timelineClientXToSec(e.clientX), 'clip-body', {
        trackId: hitClip?.trackId ?? null,
        clipId: drag.clipId,
      });
    }
  };

  const onClipPointerDown = (e: React.PointerEvent, clipId: string, edge: 'move' | 'left' | 'right') => {
    // stopPropagation first, so a press on a clip never reaches the lanes'
    // marquee — then bail on anything that is not a primary press. A right-click
    // must leave the selection (and the time range) exactly as it found them;
    // the menu it opens is the contextmenu event, not this one.
    e.stopPropagation();
    if (!isPrimaryGestureButton(e, IS_MAC)) return;
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    if (edge === 'move' && (e.ctrlKey || e.metaKey)) {
      const ids = selectedClipIds.includes(clipId) ? selectedClipIds : [clipId];
      const picked = ids
        .map((id) => clips.find((c) => c.id === id))
        .filter((c): c is AudioClip => !!c);
      // A press renders nothing: a Ctrl+click selects and a Ctrl+drag inside
      // the timeline copies, and neither needs audio. A drag that leaves the
      // timeline hands over the audio the clips have now, and renders the MIDI
      // parts with no current render for that drag only (state/clipDragOut).
      const plan = planClipDragOut(picked, tracks, getGlobalVoice());
      opRef.current = {
        kind: 'ctrl-drag-pending',
        clipId,
        startPxX: e.clientX,
        startPxY: e.clientY,
        initialStartSec: clip.startSec,
        initialDurationSec: clip.durationSec,
        initialOffsetIntoSource: clip.offsetIntoSource,
        initialTrackIndex: Math.max(0, tracks.findIndex((t) => t.id === clip.trackId)),
        dragItems: plan.items,
        dragRenderIds: plan.renderIds,
        shiftKey: e.shiftKey,
      };
      return;
    }

    // Which gesture the drag is. Alt on the BODY slips the audio under a clip
    // that stays where it is; Shift on an EDGE stretches instead of trimming.
    // Neither modifier had a meaning on a clip before: Ctrl/Cmd drags a clip
    // out to another surface (above), Shift on the body extends the selection,
    // and the edges took no modifier at all.
    const kind: PointerOp['kind'] = edge === 'move'
      ? (e.altKey ? 'slip' : 'move')
      : e.shiftKey
        ? (edge === 'left' ? 'stretch-left' : 'stretch-right')
        : (edge === 'left' ? 'resize-left' : 'resize-right');

    if (edge === 'move') {
      // A slip is a single-clip gesture, so Alt must not also extend or toggle
      // the selection on its way in.
      if (kind === 'slip') selectClipSingle(clipId);
      else selectClipWithModifiers(clipId, e);
    } else if (!selectedClipIds.includes(clipId)) {
      selectClipSingle(clipId);
    }
    // The recorder folds a whole drag into one undo step; this keeps it from
    // folding the drag into whatever edit happened in the 300 ms before it.
    beginUndoStep();
    const trackIndex = tracks.findIndex((t) => t.id === clip.trackId);
    const moveIds = kind === 'move' && selectedClipIds.includes(clipId) && !(e.ctrlKey || e.metaKey || e.shiftKey)
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
      kind,
      clipId,
      startPxX: e.clientX,
      startPxY: e.clientY,
      initialStartSec: clip.startSec,
      initialDurationSec: clip.durationSec,
      initialOffsetIntoSource: clip.offsetIntoSource,
      initialTrackIndex: trackIndex,
      initialClips,
      undoDepthAtStart: useEditorStore.getState()._undo.length,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const op = opRef.current;
    if (!op) return;
    // Both are viewport-px deltas; normalise to local px before they meet
    // pxToSec (local px/sec) and trackH (local px).
    const dxPx = viewportPxToLocal(e.clientX - op.startPxX);
    const dySec = viewportPxToLocal(e.clientY - op.startPxY);

    if (op.kind === 'ctrl-drag-pending') {
      const dist = Math.hypot(dxPx, dySec);
      if (dist < CTRL_DRAG_MOVE_THRESHOLD_PX) return;
      // Ctrl+drag COPIES (REAPER: media item, Ctrl + left drag = copy item). The copies are made
      // where the originals are and the drag carries on as a plain move of the COPIES, so snapping,
      // lane changes and the new-lane gap all work as they do for a move. The whole thing is one
      // undo step: the copies are added inside the step the first move frame then joins.
      const st = useEditorStore.getState();
      const ids = st.selectedClipIds.includes(op.clipId) ? st.selectedClipIds : [op.clipId];
      const sources = st.clips.filter((c) => ids.includes(c.id));
      if (sources.length === 0) {
        opRef.current = null;
        return;
      }
      const undoDepthAtStart = st._undo.length;
      beginUndoStep();
      // `id` is dropped: addClipToTrack honours an incoming id, and a copy that kept its source's
      // id would be the same clip twice.
      const copies = sources.map(({ id: sourceId, ...clip }) => ({ sourceId, clip, id: addClipToTrack({ ...clip }) }));
      const anchor = copies.find((c) => c.sourceId === op.clipId) ?? copies[0];
      const liveTracks = useEditorStore.getState().tracks;
      setSelectedClipIds(copies.map((c) => c.id));
      setSelectedTrackIds([]);
      setSelected(anchor.id);
      opRef.current = {
        ...op,
        kind: 'move',
        clipId: anchor.id,
        initialClips: copies.map((c) => ({
          id: c.id,
          startSec: c.clip.startSec,
          trackIndex: Math.max(0, liveTracks.findIndex((t) => t.id === c.clip.trackId)),
        })),
        undoDepthAtStart,
      };
      return;
    }

    // A copy-drag that LEAVES the timeline becomes the drag to another surface it has always been
    // (the library, another tab's drop zone): the copies are taken back and the app-level drag
    // starts with the ORIGINAL clips' audio. MIDI parts with no current render are rendered for
    // this drag (state/clipDragOut: the MIDI render queue, one at a time, muted ones too): the
    // drop takes them as they land, and once the drag is over the decoded audio of the renders
    // made for it alone is freed. A part that plays live keeps no render from the drag.
    const dragPlan = { items: op.dragItems ?? [], renderIds: op.dragRenderIds ?? [] };
    if (op.kind === 'move' && dragOutHasContent(dragPlan)) {
      const box = timelineScrollRef.current?.getBoundingClientRect();
      const margin = 24;
      if (
        box &&
        (e.clientX < box.left - margin || e.clientX > box.right + margin ||
          e.clientY < box.top - margin || e.clientY > box.bottom + margin)
      ) {
        const depth = op.undoDepthAtStart;
        if (depth !== undefined) {
          for (let guard = 0; guard < 64 && useEditorStore.getState()._undo.length > depth; guard += 1) undo();
        }
        opRef.current = null;
        showLaneInsert(null);
        beginClipDragOut(dragPlan);
        return;
      }
    }

    /* F18 — the click band. Below CLIP_CLICK_SLOP_PX of pointer travel this
       press is still a CLICK, so the op applies nothing: no move, no trim, no
       slip, no stretch, no lane-insert marker, and so no store write and no
       undo step. Above it the gesture is a drag and everything below runs
       exactly as it always has, measured from where the press went down (an
       absolute drag, so the suppressed frames cost no accuracy).

       This is what makes double-click reliable. Applying from the FIRST
       pointermove meant one wobbled pixel re-snapped the clip to the grid,
       and — since laneTargetAtY's 10 px insert band covers a clip's top and
       bottom few pixels — the release could also insert a track and move the
       clip onto it. Either way the clip left the pointer, the second press
       landed on the lanes, and the browser dispatched `dblclick` there instead
       of on the clip. The SAME threshold decides the release in onPointerUp
       below, so there is no travel at which the op applied yet the release
       still counted as a click. */
    if (clipGesturePhase(e.clientX - op.startPxX, e.clientY - op.startPxY) === 'click') return;

    const dxSec = pxToSec(dxPx);
    const clip = clips.find((c) => c.id === op.clipId);
    if (!clip) return;
    if (op.kind === 'move') {
      // The lane under the pointer decides the vertical move, so a clip goes to
      // any lane in one drag. A gap between two lanes, above the first or
      // below the last is a new lane, made when the pointer lets go.
      const rect = timelineRef.current?.getBoundingClientRect();
      const yPx = rect ? viewportPxToLocal(e.clientY - rect.top) : op.initialTrackIndex * trackH + trackH / 2;
      const lane = laneTargetAtY(yPx, tracks.length, trackH);
      showLaneInsert(lane.kind === 'insert' ? lane.index : null);
      const trackDelta = lane.kind === 'lane' ? lane.index - op.initialTrackIndex : 0;
      const moveTargets = op.initialClips?.length ? op.initialClips : [{ id: op.clipId, startSec: op.initialStartSec, trackIndex: op.initialTrackIndex }];
      // Magnetism is resolved ONCE, on the clip under the pointer, and the
      // resulting shift is applied to the whole selection. Magnetising each
      // clip on its own would pull a multi-clip drag apart, destroying exactly
      // the spacing the user is dragging.
      const movingIds = moveTargets.map((t) => t.id);
      const magnets = magnetTargetsFor(clips, movingIds, [
        useEditorStore.getState().playheadSec,
        ...markers.map((m) => m.t),
        loopEnabled ? loopStart : null,
        loopEnabled ? loopEnd : null,
      ]);
      const lead = moveTargets.find((t) => t.id === op.clipId) ?? moveTargets[0];
      const leadDur = clips.find((c) => c.id === lead.id)?.durationSec ?? 0;
      const desiredLead = lead.startSec + dxSec;
      // Snap off means off — a free drag, no grid and no magnet. Otherwise the
      // pull is 8 px wide, converted through the current zoom so it feels the
      // same at 5 px/s as at 400. `snapSec` rides along as the grid candidate,
      // so the old grid snap is still one of the things the drag can land on.
      const snappedLead =
        snap === 'off'
          ? desiredLead
          : magnetStart(desiredLead, leadDur, magnets, pxToSec(8), snapSec(desiredLead));
      const appliedDx = snappedLead - lead.startSec;
      // `coalesce`: the pointer-down cut ONE undo step for the whole drag, and a drag of several
      // selected clips writes each of them on every frame. Keyed per clip, those writes never
      // folded together — two clips dragged for 60 frames left 120 undo steps, each taking one
      // clip back by one frame.
      moveTargets.forEach((target) => {
        const newStart = Math.max(0, target.startSec + appliedDx);
        if (lane.kind === 'insert') {
          updateClip(target.id, { startSec: newStart }, { coalesce: true });
          return;
        }
        const targetIdx = Math.max(0, Math.min(tracks.length - 1, target.trackIndex + trackDelta));
        updateClip(target.id, { startSec: newStart, trackId: tracks[targetIdx].id }, { coalesce: true });
      });
      return;
    }

    // Every gesture below measures from where the clip was when the drag began,
    // so a drag is absolute rather than a sum of frames. lib/clipDragMath owns
    // the arithmetic (and the minimum-length and end-of-source rules); the grid
    // is ours, so `snapSec` goes in as the quantiser.
    //
    // A stretched clip covers `rate` seconds of source per second of timeline,
    // so whatever is measured against the source converts through it. Rather
    // than let each gesture convert for itself — which is how a left-trim came
    // to add a timeline delta onto a source offset — the drag is handed ONE
    // view in which every length is timeline seconds, and the single offset
    // that comes back out converts once, through `fromTimelineOffset`. An
    // unstretched clip is at rate 1, where both are the identity and the
    // arithmetic is exactly what the trims did inline.
    const rate = clipStretchRate(clip);
    const atDragStart = toTimelineView({
      startSec: op.initialStartSec,
      durationSec: op.initialDurationSec,
      offsetIntoSource: op.initialOffsetIntoSource,
      sourceDuration: clip.sourceDuration,
    }, rate);

    if (op.kind === 'resize-right') {
      const next = resizeClipRight(atDragStart, dxSec, snapSec);
      updateClip(op.clipId, { durationSec: next.durationSec });
    } else if (op.kind === 'resize-left') {
      // null = the drag would leave nothing of the clip, or read from before
      // the head of the source: refused, and the clip is left exactly as it was.
      const next = resizeClipLeft(atDragStart, dxSec, snapSec);
      if (!next) return;
      updateClip(op.clipId, {
        startSec: next.startSec,
        offsetIntoSource: fromTimelineOffset(next.offsetIntoSource, rate),
        durationSec: next.durationSec,
      });
    } else if (op.kind === 'slip') {
      // The clip window does not move and does not change length, only which
      // part of the audio sits under it. Dragging right pushes the audio right,
      // so the clip reads from EARLIER.
      const next = slipClipAudio(atDragStart, -dxSec);
      updateClip(op.clipId, { offsetIntoSource: fromTimelineOffset(next.offsetIntoSource, rate) });
    } else if (op.kind === 'stretch-right') {
      // Same snapped edge as a trim, but no clamp to what is left of the source
      // — reaching past the end of the audio is the point of stretching.
      const wanted = snapSec(op.initialStartSec + op.initialDurationSec + dxSec) - op.initialStartSec;
      if (wanted < MIN_CLIP_SEC) return;
      stretchClipToFit(op.clipId, wanted, undefined, { coalesce: true });
    } else if (op.kind === 'stretch-left') {
      // The clip's END stays put and its head moves, so the same audio lands in
      // whatever length is left between them.
      const endSec = op.initialStartSec + op.initialDurationSec;
      // Held at or after zero BEFORE the length is taken from it: the clip's
      // end is what this gesture keeps fixed, and a negative start that the
      // store later clamped to 0 would have grown the clip past that end.
      const newStart = Math.max(0, snapSec(op.initialStartSec + dxSec));
      if (endSec - newStart < MIN_CLIP_SEC) return;
      stretchClipToFit(op.clipId, endSec - newStart, newStart, { coalesce: true });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const op = opRef.current;
    // A plain PRIMARY clip press released without travel is a clip-body click
    // (F06): it places the edit cursor. The move op already selected the clip on
    // pointer-down; nothing about that gesture changes. The cut tool's click is
    // its split, so it places nothing.
    if (
      op?.kind === 'move' && tool !== 'cut' && isPrimaryGestureButton(e, IS_MAC) &&
      clipGesturePhase(e.clientX - op.startPxX, e.clientY - op.startPxY) === 'click'
    ) {
      const hitClip = clips.find((c) => c.id === op.clipId);
      placeClickAt(timelineClientXToSec(e.clientX), 'clip-body', {
        trackId: hitClip?.trackId ?? null,
        clipId: op.clipId,
      });
    }
    if (op?.kind === 'ctrl-drag-pending') {
      selectClipWithModifiers(op.clipId, ctrlDragClickModifiers(op));
      opRef.current = null;
      return;
    }
    if (opRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      const insertAt = laneInsertRef.current;
      if (op?.kind === 'move' && insertAt !== null) {
        // Let go in a gap: the lane is made there and the dragged clips move
        // onto it, keeping their spread over the lanes that follow it.
        const newId = insertTrack(insertAt);
        const live = useEditorStore.getState().tracks;
        const newIdx = live.findIndex((t) => t.id === newId);
        const moveTargets = op.initialClips?.length ? op.initialClips : [{ id: op.clipId, startSec: op.initialStartSec, trackIndex: op.initialTrackIndex }];
        moveTargets.forEach((target) => {
          const idx = Math.max(0, Math.min(live.length - 1, newIdx + (target.trackIndex - op.initialTrackIndex)));
          updateClip(target.id, { trackId: live[idx].id });
        });
      }
      showLaneInsert(null);
      opRef.current = null;
    }
  };

  // --- Drag-and-drop from the Library, or audio files from the desktop ---
  const onTimelineDragOver = (e: React.DragEvent) => {
    // Every in-app mime the drop understands, or the gate refuses the drag and
    // no drop ever fires.
    if (dropHasLibraryOrFiles(e.dataTransfer, [LIBRARY_ID_MIME, MIDI_ID_MIME, STEM_ID_MIME])) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const rect = timelineRef.current?.getBoundingClientRect();
      if (rect) {
        const lane = laneTargetAtY(viewportPxToLocal(e.clientY - rect.top), tracks.length, trackH);
        showLaneInsert(lane.kind === 'insert' ? lane.index : null);
      }
    }
  };
  const onTimelineDragLeave = (e: React.DragEvent) => {
    // Moving over a child fires this too; only leaving the timeline counts.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    showLaneInsert(null);
  };

  /** Fetch, decode and place ANY audio source as a clip on `targetTrack` — the
   *  shared tail of a library drop, a desktop drop, and every "Add to track"
   *  menu entry that produces audio (a library take, a separated stem, a file
   *  the user just picked). One implementation: the only thing that differs
   *  between the sources is where the Blob comes from.
   *
   *  `libraryEntryId` is passed through because it is what later unlocks the
   *  clip's bpm/key readout and the stems explode path — a library-sourced clip
   *  that loses it looks like a bare recording. `songEntryId` names the song a
   *  stem was separated from; the clip is tied to that song's analysis (or to
   *  its own entry's, for library audio) so SYNC and "Use song tempo" read its
   *  tempo, beats and downbeats (lib/songTimeLink). */
  const placeAudioOnTrack = async (
    audio: { label: string; mimeType?: string; entryId?: string; songEntryId?: string; fallbackDuration?: number; fetch: () => Promise<Blob> },
    targetTrack: EditorTrack,
    startSec: number,
    verb = 'Dropped',
  ) => {
    const blob = await audio.fetch();
    const { peaks, duration } = await computePeaks(blob, 240);
    const length = duration || audio.fallbackDuration || 0;
    const clipId = addClipToTrack({
      trackId: targetTrack.id,
      label: audio.label,
      audioBlob: blob,
      mimeType: audio.mimeType ?? blob.type ?? 'audio/wav',
      sourceDuration: length,
      offsetIntoSource: 0,
      durationSec: length,
      startSec,
      color: targetTrack.color,
      libraryEntryId: audio.entryId,
      songTime: linkSongTime(audio.songEntryId ?? audio.entryId),
    });
    cachePeaks(clipId, peaks);
    logInfo('editor', `${verb} ${audio.label} on ${targetTrack.name} at ${startSec.toFixed(2)}s`);
  };

  /** A library entry as a clip on `targetTrack`. */
  const placeEntryOnTrack = async (
    entry: LibraryEntry,
    targetTrack: EditorTrack,
    startSec: number,
    verb = 'Dropped',
  ) =>
    placeAudioOnTrack(
      {
        label: stripSourceId(entry.title) || `clip_${entry.id.slice(0, 6)}`,
        mimeType: entry.mimeType,
        entryId: entry.id,
        fallbackDuration: entry.duration,
        fetch: () => useLibraryStore.getState().fetchAudioBlob(entry),
      },
      targetTrack,
      startSec,
      verb,
    );

  /** The track an add lands on: the one the user clicked, or a fresh track when
   *  they clicked below every lane (the same rule a drop there follows). Reads
   *  the track back out of the store because `addTrack` returns only an id. */
  const resolveAddTarget = (trackId: string | null, newTrackName?: string): EditorTrack | undefined => {
    const live = useEditorStore.getState().tracks;
    const existing = trackId ? live.find((t) => t.id === trackId) : undefined;
    if (existing) return existing;
    const newId = addTrack(newTrackName ? { name: newTrackName } : undefined);
    return useEditorStore.getState().tracks.find((t) => t.id === newId);
  };

  const onTimelineDrop = async (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    if (!dropHasLibraryOrFiles(dt, [LIBRARY_ID_MIME, MIDI_ID_MIME, STEM_ID_MIME])) return;
    e.preventDefault();
    if (!timelineRef.current) return;
    // Everything the DataTransfer and the pointer give is read before the
    // import awaits: the browser locks the DataTransfer once the handler yields.
    const entryId = dt.getData(LIBRARY_ID_MIME);
    const midiId = dt.getData(MIDI_ID_MIME);
    const stemId = dt.getData(STEM_ID_MIME);
    const stemSongId = dt.getData(STEM_SONG_MIME);
    const midiLabel = dt.getData('text/plain') || 'midi';
    const stemLabel = dt.getData('text/plain') || 'stem';
    const fromDesktop = !entryId && !midiId && !stemId;
    const rect = timelineRef.current.getBoundingClientRect();
    // Viewport px -> local px: yPx is compared against trackH (local) to pick the
    // target lane, so an unscaled value dropped clips onto the wrong track.
    const xPx = viewportPxToLocal(e.clientX - rect.left);
    const yPx = viewportPxToLocal(e.clientY - rect.top);
    const lane = laneTargetAtY(yPx, tracks.length, trackH);
    // The MIDI and stem drops below make their own track when the drop lands under every lane.
    const droppedBelowAllTracks = yPx >= tracks.length * trackH;
    showLaneInsert(null);
    const startSec = snapSec(pxToSec(xPx));

    // A MIDI row carries a `midis` id, which entriesFromDrop can never resolve
    // against the library. Fetch the bytes and place a piano-roll clip instead
    // — the same destination the right-click "send to piano roll" path uses.
    if (midiId) {
      const laneIdx = Math.max(0, Math.min(tracks.length - 1, Math.floor(yPx / trackH)));
      try {
        const bytes = await fetchMidiBytesWithRetry(`/api/midi/file/${midiId}`, { label: midiLabel });
        // A null track id means "make one" — what a drop below every lane means.
        await addMidiClipFromBytes(
          bytes,
          midiLabel,
          startSec,
          droppedBelowAllTracks ? null : (tracks[laneIdx]?.id ?? null),
          // A library MIDI row transcribes a song (or one of its stems): its id names the stem.
          { stem: midiId, fromAudio: true },
        );
      } catch (err) {
        logError('editor', `MIDI drop failed for ${midiLabel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // A stem row carries a `stems` id, not a library entry id, so — like MIDI —
    // it cannot resolve through entriesFromDrop. Fetch the stem's audio and
    // place it as a clip, with the same lane/time math as a library drop: the
    // pointer's track, or a fresh track when dropped below every lane.
    if (stemId) {
      const stemTarget = droppedBelowAllTracks
        ? resolveAddTarget(null, stemLabel)
        : tracks[Math.max(0, Math.min(tracks.length - 1, Math.floor(yPx / trackH)))];
      if (!stemTarget) return;
      try {
        await placeAudioOnTrack(
          {
            label: stemLabel,
            mimeType: 'audio/wav',
            // The song the stem was separated from: the clip reads its analysis.
            songEntryId: stemSongId || undefined,
            // The shared retrying fetcher, like every other stem-audio read:
            // it status-checks (a 404/500 body would otherwise become a Blob
            // that only fails later in computePeaks) and rides out the
            // single-worker backend's model-load stalls.
            fetch: () => fetchBlobWithRetry(stemAudioUrl({ id: stemId }), { label: stemLabel }),
          },
          stemTarget,
          startSec,
        );
      } catch (err) {
        logError('editor', `Stem drop failed for ${stemLabel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // A desktop drop imports its audio files to the library first, so both
    // paths continue from library entries.
    const dropped = await entriesFromDrop(dt, { entries: useLibraryStore.getState().entries });
    if (dropped.length === 0) {
      if (entryId) logError('editor', `Drop: library entry ${entryId.slice(0, 8)} not found`);
      return;
    }
    const newTrackFor = (entry: LibraryEntry): EditorTrack | undefined => {
      const newTrackId = addTrack({ name: entry.title });
      // Re-read tracks from the store after the mutation.
      return useEditorStore.getState().tracks.find((t) => t.id === newTrackId);
    };
    let targetTrack: EditorTrack | undefined;
    if (lane.kind === 'insert') {
      // A gap between lanes, above the first or below the last: a lane of its own there.
      const newTrackId = insertTrack(lane.index, { name: dropped[0].title });
      targetTrack = useEditorStore.getState().tracks.find((t) => t.id === newTrackId);
    } else {
      targetTrack = tracks[lane.index];
    }
    if (!targetTrack) return;
    try {
      // The first entry lands where the pointer let go; every further file of
      // a multi-file desktop drop gets a new track of its own at the same time.
      await placeEntryOnTrack(dropped[0], targetTrack, startSec);
      for (const entry of dropped.slice(1)) {
        const track = newTrackFor(entry);
        if (track) await placeEntryOnTrack(entry, track, startSec);
      }
      if (fromDesktop) logInfo('editor', `Imported ${dropped.length} file(s) from the desktop onto the timeline at ${startSec.toFixed(2)}s`);
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
    beginUndoStep(); // the whole drag is one undo step, and only this drag
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
    const dxPx = viewportPxToLocal(e.clientX - fd.startX);
    const dxSec = fd.edge === 'in' ? pxToSec(dxPx) : pxToSec(-dxPx);
    // Each fade may run the WHOLE clip — the old durationSec / 2 cap made a
    // 90 % in / 10 % out pair impossible to draw — and the only limit is the
    // room the OTHER fade leaves. That other end is read, never written: a
    // drag the user did not make on it must not shorten it, which is what
    // writing back both ends of `clampClipFades` did. (The clamp stays the rule
    // where both ends really are being set: the split and the crossfade.)
    const otherFade = Math.max(0, (fd.edge === 'in' ? clip.fadeOutSec : clip.fadeInSec) ?? 0);
    const room = Math.max(0, clip.durationSec - otherFade);
    const wanted = Math.min(Math.max(0, fd.initialFade + dxSec), room);
    updateClip(fd.clipId, fd.edge === 'in' ? { fadeInSec: wanted } : { fadeOutSec: wanted });
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

  /** Where a click resolves (F06), on pointer-up: the edit cursor and/or a real
   *  seek, per the placement policy and the user's click profile. A seek never
   *  starts or stops playback, so clicking while playing keeps it playing.
   *
   *  T44 — the same click also puts away a highlight it lands AWAY from: the
   *  time range and the clip inpaint mask are the user's current focus, not
   *  pinned annotations, so a click outside one clears it (a click inside keeps
   *  it, so the edit cursor can be parked in a range). `hit` names the lane and
   *  clip under the pointer; `highlightClearDecision` owns the rule. Only
   *  primary-button clicks reach here — right-clicks go to the menus and never
   *  clear anything, and controls never call this at all. */
  const placeClickAt = useCallback((
    sec: number,
    surface: ClickSurface,
    hit?: { trackId: string | null; clipId?: string },
  ) => {
    const at = Math.max(0, sec);
    const intent = placementIntent({
      surface,
      playing: isEditorTimelinePlaying() || liveMixer.isPlaying(),
      explicitSeek: false,
      profile: clickProfile,
    });
    if (intent.moveEditCursor) setEditCursor(at);
    if (intent.seek) seekEditorTo(at);
    if (!hit) return;
    const st = useEditorStore.getState();
    const decision = highlightClearDecision({
      surface,
      clickSec: at,
      clickTrackId: hit.trackId,
      clickClipId: hit.clipId,
      range: st.timeSelection,
      mask: st.inpaintSelection,
    });
    if (decision.clearRange) setTimeSelection(null);
    if (decision.clearMask) clearInpaintSelection();
  }, [clearInpaintSelection, clickProfile, seekEditorTo, setEditCursor, setTimeSelection]);

  // Shift-drag on the ruler draws the loop region (unchanged). A plain press is
  // the pointer handlers below: a click seeks, a drag draws the time range.
  const onRulerMouseDown = (e: React.MouseEvent) => {
    if (!e.shiftKey) return;
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
  };

  /** A plain primary press on the ruler. Resolved on pointer-up: under 4 px of
   *  travel it is a click (placement, which on the ruler always seeks); past it,
   *  a drag that sets the time range live and never seeks (F03). */
  const onRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.shiftKey) return; // the loop gesture (onRulerMouseDown)
    if (!isPrimaryGestureButton(e, IS_MAC)) return;
    // Marker flags own their own click (seek / rename / delete).
    if ((e.target as HTMLElement).closest('[data-ruler-control="1"]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    window.addEventListener('selectstart', preventSelectStart);
    rulerPressRef.current = {
      pointerId: e.pointerId,
      originX: e.clientX,
      originY: e.clientY,
      anchorSec: secFromClientX(e.clientX),
      dragging: false,
      before: useEditorStore.getState().timeSelection,
    };
  };

  const onRulerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = rulerPressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    if (!press.dragging) {
      if (classifyRulerPress({ x: press.originX, y: press.originY }, { x: e.clientX, y: e.clientY }) === 'click') return;
      press.dragging = true;
    }
    // snapSec is the identity when snapping is off. A new drag replaces the range.
    const drawn = rulerDragRange(press.anchorSec, secFromClientX(e.clientX), snapSec);
    setTimeSelection(drawn);
    // Only ONE highlight is ever on screen: drawing a time range puts away the
    // clip inpaint mask (T44 rule 3). Guarded so a drag does not write the store
    // once per pointermove.
    if (drawn && useEditorStore.getState().inpaintSelection) clearInpaintSelection();
  };

  const endRulerPress = (el: Element, pointerId: number) => {
    rulerPressRef.current = null;
    window.removeEventListener('selectstart', preventSelectStart);
    if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
  };

  const onRulerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = rulerPressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    endRulerPress(e.currentTarget, e.pointerId);
    // No lane under a ruler click: a track-scoped range ignores the scope there
    // (rangeContains), so only the time decides whether the click is outside it.
    if (!press.dragging) placeClickAt(secFromClientX(e.clientX), 'ruler', { trackId: null });
  };

  const onRulerPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = rulerPressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    endRulerPress(e.currentTarget, e.pointerId);
    if (press.dragging) setTimeSelection(press.before);
  };

  /* --- Empty-lane press: click (placement) or marquee (F15) ----------------
     Model space is lanes-content local px: the content rect already carries the
     scroll offset, so only the CSS layout zoom is divided out. Hit rects come
     from store data (buildClipHitRects), never from DOM queries, so clips
     scrolled offscreen are selectable once the band reaches them. */
  const lanesModelPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const z = layoutZoom();
    return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z };
  }, [layoutZoom]);

  /** Clip rects captured at press time; clips do not move during a marquee. */
  const marqueeHitRectsRef = useRef<ReturnType<typeof buildClipHitRects>>([]);
  /** What a cancelled marquee restores besides the clip ids. */
  const marqueeBaselineRef = useRef<{ anchor: string | null; trackIds: string[] }>({ anchor: null, trackIds: [] });
  const marqueeHitTest = useCallback(
    (r: { x1: number; y1: number; x2: number; y2: number }) => hitTestClipRects(marqueeHitRectsRef.current, r),
    [],
  );

  const applyMarqueeSelection = useCallback((ids: string[]) => {
    setSelectedClipIds(ids);
    const anchor = useEditorStore.getState().selectedClipId;
    setSelected(anchor !== null && ids.includes(anchor) ? anchor : ids[0] ?? null);
    setSelectedTrackIds([]);
  }, [setSelected, setSelectedClipIds, setSelectedTrackIds]);

  /** Tear down a marquee press: no gesture, no band, no autoscroll, no capture. */
  const endMarquee = useCallback((el?: Element | null, pointerId?: number) => {
    marqueeRef.current = null;
    marqueeClientRef.current = null;
    if (marqueeRafRef.current !== null) {
      cancelAnimationFrame(marqueeRafRef.current);
      marqueeRafRef.current = null;
    }
    window.removeEventListener('selectstart', preventSelectStart);
    setMarqueeRect(null);
    if (el && pointerId !== undefined && el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
  }, []);

  /** Escape / pointercancel: the gesture ends and the selection captured at
   *  pointer-down comes back. */
  const cancelMarquee = useCallback(() => {
    const g = marqueeRef.current;
    if (!g) return;
    const { restoreIds } = cancelGesture(g);
    endMarquee(timelineRef.current, g.pointerId);
    if (g.phase === 'marquee') {
      setSelectedClipIds(restoreIds);
      setSelected(marqueeBaselineRef.current.anchor);
      setSelectedTrackIds(marqueeBaselineRef.current.trackIds);
    }
  }, [endMarquee, setSelected, setSelectedClipIds, setSelectedTrackIds]);

  /** One autoscroll frame while the band is near a viewport edge. After each
   *  scroll step the pointer sits over different content, so the model point is
   *  re-read and the marquee re-evaluated (refreshMarquee). Held in a ref so the
   *  rAF chain always runs the current render's closure. */
  const marqueeAutoscrollRef = useRef<() => void>(() => {});
  const marqueeAutoscroll = () => {
    marqueeRafRef.current = null;
    const g = marqueeRef.current;
    const el = timelineScrollRef.current;
    const p = marqueeClientRef.current;
    if (!g || g.phase !== 'marquee' || !el || !p) return;
    const vp = el.getBoundingClientRect();
    const { vx, vy } = autoscrollVelocity(p, vp);
    if (vx !== 0 || vy !== 0) {
      // The velocity is screen px per frame; scrollLeft/Top are local px.
      const z = layoutZoom();
      const beforeLeft = el.scrollLeft;
      const beforeTop = el.scrollTop;
      el.scrollLeft += vx / z;
      el.scrollTop += vy / z;
      const moved = el.scrollLeft !== beforeLeft || el.scrollTop !== beforeTop;
      const model = moved ? lanesModelPoint(p.x, p.y) : null;
      if (model) {
        const next: GestureState = { ...g, currentModel: model };
        marqueeRef.current = next;
        const res = refreshMarquee(next, marqueeHitTest, combineMarquee);
        if (res.selectedIds) applyMarqueeSelection(res.selectedIds);
        if (res.rect) setMarqueeRect(res.rect);
      }
    }
    marqueeRafRef.current = requestAnimationFrame(() => marqueeAutoscrollRef.current());
  };

  // A marquee never outlives EDIT: unmounting stops its frame loop and listener.
  useEffect(() => () => {
    if (marqueeRafRef.current !== null) cancelAnimationFrame(marqueeRafRef.current);
    marqueeRafRef.current = null;
    marqueeRef.current = null;
    window.removeEventListener('selectstart', preventSelectStart);
  }, []);

  const onLanesPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (automationEdit) return; // automation edit mode owns the lanes; ruler still moves the playhead
    // Primary button only: a right-click opens a menu and never starts a marquee.
    if (!isPrimaryGestureButton(e, IS_MAC)) return;
    if (opRef.current) return;
    // Only presses on empty lane space (lane background, gaps, below the last
    // lane). Clips and the playhead handle own their presses.
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip="1"]')) return;
    if (target.closest('[data-playhead-handle="1"]')) return;
    const model = lanesModelPoint(e.clientX, e.clientY);
    if (!model) return;
    const st = useEditorStore.getState();
    // The baseline is what the user sees selected: the multi-selection, or the
    // single focused clip when there is no multi-selection.
    const baseline = st.selectedClipIds.length > 0 ? st.selectedClipIds : st.selectedClipId ? [st.selectedClipId] : [];
    marqueeBaselineRef.current = { anchor: st.selectedClipId, trackIds: st.selectedTrackIds };
    marqueeHitRectsRef.current = buildClipHitRects(
      st.clips,
      layoutRows(st.tracks.map((t) => ({ id: t.id, height: st.trackHeight }))),
      st.zoom,
    );
    marqueeRef.current = startGesture(e.pointerId, { x: e.clientX, y: e.clientY }, model, baseline, marqueeModeFor(e));
    marqueeClientRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    window.addEventListener('selectstart', preventSelectStart);
  };

  const onLanesPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = marqueeRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const model = lanesModelPoint(e.clientX, e.clientY);
    if (!model) return;
    marqueeClientRef.current = { x: e.clientX, y: e.clientY };
    const res = moveGesture(g, e.pointerId, { x: e.clientX, y: e.clientY }, model, marqueeHitTest, combineMarquee);
    marqueeRef.current = res.state;
    if (res.selectedIds) applyMarqueeSelection(res.selectedIds);
    if (res.rect) setMarqueeRect(res.rect);
    if (res.state.phase === 'marquee' && marqueeRafRef.current === null) {
      marqueeRafRef.current = requestAnimationFrame(() => marqueeAutoscrollRef.current());
    }
  };

  const onLanesPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = marqueeRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const outcome = finishGesture(g, e.pointerId);
    endMarquee(e.currentTarget, e.pointerId);
    if (outcome !== 'click') return; // a marquee keeps the selection it drew; no click follows
    // Which lane the click landed on, for a track-scoped range: plain lane index,
    // not laneTargetAtY — its 10 px insert band is about where a DRAGGED clip
    // lands, and a click in it is still visibly on that lane. Below the last lane
    // there is no track, and the scope is then ignored (rangeContains).
    const model = lanesModelPoint(e.clientX, e.clientY);
    const laneIdx = model ? Math.floor(model.y / trackH) : -1;
    placeClickAt(contentClientXToSec(e.clientX), 'empty-lane', {
      trackId: laneIdx >= 0 ? tracks[laneIdx]?.id ?? null : null,
    });
    // An empty click releases what was selected — clips (reduceSelection
    // 'empty-click'), the focused clip and the track selection, exactly as the
    // click did before the time range existed. The highlights it lands away from
    // go too, but that is placeClickAt's call (highlightClearDecision), not this
    // reducer's: a click INSIDE the range keeps it. Clearing only `selectedClipId`
    // once left clips visibly ringed and Delete still armed, so the
    // multi-selection goes too.
    const st = useEditorStore.getState();
    const next = reduceSelection({ clipIds: st.selectedClipIds, range: st.timeSelection }, { type: 'empty-click' });
    setSelectedClipIds([...next.clipIds]);
    setSelectedTrackIds([]);
    setSelected(null);
  };

  /** pointercancel AND lostpointercapture: either way the gesture is over and
   *  its teardown must run (rAF stopped, selectstart blocker removed, baseline
   *  selection restored). Whichever fires second finds no gesture and no-ops. */
  const onLanesPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (marqueeRef.current?.pointerId !== e.pointerId) return;
    cancelMarquee();
  };

  /* Escape on the timeline, in order: an open menu or popover owns the key;
     then an active gesture is cancelled (its baseline restored); then the clip
     selection clears; then, on a later press, the time range; and only when
     nothing else is selected, the inpaint mask. */
  const timelineEscape = () => {
    // Any menu, picker or panel that is open owns Escape — it is the thing the
    // user means to dismiss, and several of them close on Escape themselves.
    const menuOpen =
      !!(
        clipMenu.position || trackMenu.position || addMenu.position || rangeMenu.position || addPicker ||
        gainPanel || clipNamePanel || timePitchPanel || instrPanel || stemsModal || inpaintPanel || prefsAnchor
      ) ||
      document.querySelector('[role="menu"], [role="dialog"][aria-modal="true"]') !== null;
    // Every timeline gesture, not just the two this ticket added: a clip drag,
    // trim, slip, stretch, fade drag, inpaint mask drag or playhead drag is just
    // as much "a gesture in flight", and Escape must not clear a selection out
    // from under one.
    const gestureActive =
      marqueeRef.current !== null || rulerPressRef.current !== null || opRef.current !== null ||
      fadeDragRef.current !== null || inpaintDragRef.current !== null || playheadDragRef.current !== null;
    if (menuOpen) return;
    if (gestureActive) {
      cancelMarquee();
      // Escape during a clip move / trim / slip / stretch puts the clip back (REAPER cancels a
      // drag the same way). The drag is one undo step, opened at pointer-down, so taking it back
      // is one undo — and only when the drag actually wrote something: a press still inside the
      // click band has no step of its own, and undoing there would take back an earlier edit.
      const clipOp = opRef.current;
      if (clipOp) {
        opRef.current = null;
        showLaneInsert(null);
        // Usually one step; a drag the user paused in for longer than the coalescing window has
        // left more than one, and all of them are this drag.
        const depth = clipOp.undoDepthAtStart;
        if (depth !== undefined) {
          for (let guard = 0; guard < 64 && useEditorStore.getState()._undo.length > depth; guard += 1) undo();
        }
      }
      const press = rulerPressRef.current;
      if (press) {
        rulerPressRef.current = null;
        window.removeEventListener('selectstart', preventSelectStart);
        if (press.dragging) setTimeSelection(press.before);
      }
      return;
    }
    const st = useEditorStore.getState();
    const clipIds = st.selectedClipIds.length > 0 ? st.selectedClipIds : st.selectedClipId ? [st.selectedClipId] : [];
    const cur = { clipIds, range: st.timeSelection };
    const next = reduceSelection(cur, { type: 'escape', gestureActive, menuOpen });
    if (next === cur) {
      clearInpaintSelection();
      return;
    }
    if (next.clipIds !== cur.clipIds) {
      setSelectedClipIds([...next.clipIds]);
      setSelected(null);
    }
    if (next.range !== cur.range) setTimeSelection(next.range);
  };

  const onClipClick = (e: React.MouseEvent, clipId: string) => {
    if (tool !== 'cut') return;
    if (!timelineRef.current) return;
    const sec = contentClientXToSec(e.clientX);
    splitClipAt(clipId, sec);
  };

  /** Bind a MIDI clip to the Piano Roll and reveal it (FL: double-click a clip). */
  const editClipInPianoRoll = useCallback((clip: AudioClip) => {
    // The classifier, not `sourcePianoRoll` truthiness: a roll clip whose notes
    // were all deleted is still a roll, and opening it is how you put notes back.
    if (!isMidiClip(clip)) return;
    // The roll's own notes with their lanes, meter map and pickup; a clip bounced
    // before the roll had a meter opens as 4/4 on a whole number of bars. The
    // clips of its other roll parts open with it, one part each (lib/rollClip
    // clipPartsLoad); a clip bounced before parts opens as one part.
    const { clips, tracks } = useEditorStore.getState();
    const args = clipPartsLoad(clip, clips, tracks);
    usePianoRollStore.getState().loadFromClip(...args);
    useBottomPanelStore.getState().showTab('midi');
    const partCount = args[8]?.tracks.length ?? 1;
    logInfo('editor', `Editing clip ${clip.id.slice(0, 8)} in MIDI (${args[1].length} notes${partCount > 1 ? `, ${partCount} parts` : ''})`);
  }, []);

  /** Open the AUDIO EDIT drawer on a clip and bring its tab up (F19). */
  const editClipInAudioEditor = useCallback((clip: AudioClip) => {
    useAudioEditorStore.getState().openForClip(clip.id);
    useBottomPanelStore.getState().showTab('audio-edit');
    logInfo('editor', `Editing clip ${clip.id.slice(0, 8)} in the audio editor`);
  }, []);

  /**
   * F18/F19 — double-clicking a clip opens the editor that OWNS it, and every
   * clip has one: a roll clip opens the piano roll, everything else opens the
   * audio drawer. `clipEditKind` is the single answer to that question, shared
   * with the clip menu below so the two can never disagree.
   */
  const onClipDoubleClick = (clip: AudioClip) => {
    if (clipEditKind(clip) === 'midi') editClipInPianoRoll(clip);
    else editClipInAudioEditor(clip);
  };

  /**
   * F17 — hand gantasmob0t an explicit "act on THIS" list, then bring the
   * composer up. Adding a reference is NOT a request, so nothing is ever sent:
   * the chips sit beside the composer until the user types.
   *
   * A builder returns null when its subject is gone (deleted between the menu
   * opening and the row being chosen); those are dropped and the rest still
   * land, because losing one clip should not cost the user the other four.
   */
  const addAssistantReferences = useCallback((refs: readonly (AssistantReference | null)[], what: string) => {
    const add = useAssistantReferenceStore.getState().add;
    const usable = refs.filter((r): r is AssistantReference => r !== null);
    if (usable.length === 0) {
      logError('editor', `Nothing left to reference in gantasmob0t: ${what} is no longer in the project`);
      return;
    }
    for (const ref of usable) add(ref);
    requestAssistantFocus();
    logInfo('editor', `Referenced ${usable.length === 1 ? what : `${usable.length} clips`} in gantasmob0t`);
  }, []);

  /* ── Stems already separated for the clip-menu clip's library entry ────────
     Read when the menu opens (a right-click is the only moment the list
     matters), so the rows are there by the time the user looks. `rows: null`
     is "still reading"; an entry id that no longer matches the open menu is
     ignored, so a slow answer for a previous clip cannot land in this one. */
  const [clipStems, setClipStems] = useState<{ entryId: string; rows: StemRef[] | null }>({ entryId: '', rows: [] });
  const warmClipStems = useCallback((entryId: string | undefined) => {
    if (!entryId) {
      setClipStems({ entryId: '', rows: [] });
      return;
    }
    setClipStems({ entryId, rows: null });
    void listStems(entryId)
      .then((rows) => setClipStems((prev) => (prev.entryId === entryId ? { entryId, rows } : prev)))
      .catch(() => setClipStems((prev) => (prev.entryId === entryId ? { entryId, rows: [] } : prev)));
  }, []);

  /**
   * Put ONE already-separated stem on a new track, framed exactly like the clip
   * it came from (`stemClipPlacement` — the same arithmetic the explode-to-
   * tracks path uses). The parent is left UNMUTED: adding one stem beside a mix
   * is a layering gesture, not an explosion of it.
   */
  const insertStemBesideClip = useCallback(async (clipId: string, ref: StemRef) => {
    const src = useEditorStore.getState().clips.find((c) => c.id === clipId);
    if (!src) return;
    try {
      const res = await fetch(ref.url);
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      const blob = await res.blob();
      const { peaks, duration } = await computePeaks(blob, 240);
      // Re-read: the clip may have been moved, trimmed or deleted while the
      // stem downloaded, and the new clip has to line up with where it is NOW.
      const live = useEditorStore.getState().clips.find((c) => c.id === clipId);
      if (!live) {
        logError('editor', `Stem "${ref.name}" not inserted: the clip it was aimed at is gone`);
        return;
      }
      const store = useEditorStore.getState();
      const label = `${live.label} · ${ref.name}`;
      const color = STEM_TRACK_COLORS[ref.name] ?? live.color;
      // The stem is the time of the clip's library entry it was separated from.
      const songTime = stemsSongTime(live, live.libraryEntryId);
      // The track and its clip are ONE undo step.
      beginUndoStep();
      const trackId = store.addTrack({ name: label, color });
      const newClipId = store.addClipToTrack({
        trackId,
        label,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        ...stemClipPlacement(live, duration),
        color,
        gain: live.gain,
        fadeInSec: live.fadeInSec,
        fadeOutSec: live.fadeOutSec,
        ...(songTime ? { songTime } : {}),
      });
      store.cachePeaks(newClipId, peaks);
      logInfo('editor', `Inserted stem "${ref.name}" beside "${live.label}"`);
    } catch (e) {
      logError('editor', `Stem "${ref.name}" could not be inserted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /**
   * F14 — put EVERY already-separated stem of a clip's library entry on its
   * own track, all in one folder, in ONE undo step, with the parent clip
   * muted. Unlike `explodeClipToStems` this never runs separation: `refs` are
   * stems `warmClipStems` already found, and — like every other BULK stem
   * path — an aggregate sum is left off (`planStemInsert`; naming a stem is
   * the only place a sum is deliberately offered, see the "Insert stem…"
   * menu build).
   *
   * This is the fetch + `computePeaks` I/O only; the store writes (folder,
   * per-stem track+clip, mute) are `applyAllStemsInsert`, split out above so
   * that part is testable against the real store with no fetch/AudioContext.
   */
  const insertAllStemsBesideClip = useCallback(async (clipId: string, refs: readonly StemRef[]) => {
    const src = useEditorStore.getState().clips.find((c) => c.id === clipId);
    if (!src) return;
    const plan = planStemInsert(refs);
    if (!plan.insert.length) return;
    try {
      const decoded: Array<{ ref: StemRef; blob: Blob; peaks: Float32Array; duration: number }> = [];
      for (const ref of plan.insert) {
        const res = await fetch(ref.url);
        if (!res.ok) {
          logError('editor', `stem ${ref.name}: fetch failed (${res.status})`);
          continue;
        }
        const blob = await res.blob();
        const { peaks, duration } = await computePeaks(blob, 240);
        decoded.push({ ref, blob, peaks, duration });
      }
      if (!decoded.length) throw new Error('no stem audio could be fetched');
      const result = applyAllStemsInsert(clipId, decoded, plan.skipped);
      if (!result) {
        logError('editor', 'Stems not inserted: the clip they were aimed at is gone');
        return;
      }
      const note = skippedAggregatesNote(result.skippedAggregates);
      logInfo(
        'editor',
        `Inserted ${result.insertedTrackCount} stem track(s) beside "${result.parentLabel}" in a folder${note ? ` — ${note}` : ''}`,
      );
    } catch (e) {
      logError('editor', `Stems could not be inserted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /** Read the two indexes the add menu counts, so it can tell "there is none of
   *  this in the library" (disable the row, say why) from "not fetched yet"
   *  (offer it). Both are cheap and cached, both are no-ops once warm, and the
   *  menu re-renders when either lands — opening a menu is the only moment the
   *  counts matter, so this runs on the right-click rather than on mount. */
  const warmAddMenuCounts = () => {
    const library = useLibraryStore.getState();
    if (!library.loaded) void library.load();
    void loadLibraryMidi()
      .then((rows) => setLibraryMidiCount(rows.length))
      .catch(() => undefined);
  };

  /** Right-click an empty part of the timeline → the "Add to track" menu,
   *  aimed at the lane under the pointer.
   *
   *  The lane comes from clientY the same way `onTimelineDrop` resolves it
   *  (viewport px -> local px, compared against trackH), and a click in the
   *  34px band below the last lane means "a new track" — so right-clicking
   *  somewhere adds exactly what dropping there would. */
  const onLanesContextMenu = (e: React.MouseEvent) => {
    if (automationEdit) return; // right-click deletes automation points in edit mode
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip="1"]')) return; // a clip's own menu handles it
    e.preventDefault(); // suppress the OS menu even if the lane rect is missing
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return;
    const yPx = viewportPxToLocal(e.clientY - rect.top);
    const belowAllTracks = yPx >= tracks.length * trackH;
    const trackIdx = Math.max(0, Math.min(tracks.length - 1, Math.floor(yPx / trackH)));
    const track = belowAllTracks ? undefined : tracks[trackIdx];
    // Inside the time range the range menu wins over the add menu (F04). Below
    // every lane there is no track; a null track ignores the range's scope.
    if (openRangeMenuIfInside(e, Math.max(0, contentClientXToSec(e.clientX)), track?.id ?? null)) return;
    warmAddMenuCounts();
    addMenu.open(e, {
      trackId: track?.id ?? null,
      trackName: track?.name ?? null,
      // Where the pointer is, which is where a drop there lands too.
      atSec: Math.max(0, snapSec(contentClientXToSec(e.clientX))),
    });
  };

  /** Turn picked MIDI bytes into a piano-roll clip at `startSec` — on
   *  `targetTrackId` when one is given, otherwise on a new track. Live-playable
   *  and editable in the Piano Roll either way. The clip plays the file's own
   *  program, a drum file on a drum track (lib/midiClipPlace); `source` names a
   *  LIBRARY row's stem and marks its notes as timed against the song's audio. */
  const addMidiClipFromBytes = useCallback(async (
    bytes: ArrayBuffer,
    label: string,
    startSec: number,
    targetTrackId?: string | null,
    source?: { stem?: string; fromAudio?: boolean },
  ) => {
    try {
      // The file as the roll reads it: each note at its own ticks, each bending
      // channel in its own lane with its curve, the file's time signatures and
      // pickup (4/4 when it has none) and its tempo; the clip ends on the bar
      // line after its last note. The track, the clip and the file's markers
      // on the timeline are one undo step.
      const done = placeMidiFileClip(
        parseMidi(new Uint8Array(bytes)),
        { label, startSec, targetTrackId, ...(source?.stem ? { stem: source.stem } : {}), ...(source?.fromAudio ? { fromAudio: true } : {}) },
        { global: getGlobalVoice },
      );
      if (!done) {
        logError('editor', `No notes in "${label}"`);
        return;
      }
      const report = midiClipPlacedReport(done, label, startSec);
      for (const line of report.info) logInfo('editor', line);
      for (const line of report.warn) logWarn('editor', line);
    } catch (err) {
      logError('editor', `Add MIDI failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /* -- "Add to track" ------------------------------------------------------
     One dispatcher behind the timeline menu, the track-header menu and the two
     file inputs, so anything added from a menu is built by the same code that
     builds a dropped clip. Nothing here duplicates an insert path: audio goes
     through placeAudioOnTrack, MIDI through addMidiClipFromBytes, a picked file
     through importAudioFiles first (like a desktop drop). */

  /** Hand focus back to the timeline. The menu item that triggered an action is
   *  unmounting with its menu, so without this a cancelled OS file dialog
   *  strands focus on <body> -- the bug commit 5af1090 fixed for IMPORT. */
  const returnFocusToTimeline = () => timelineRef.current?.focus({ preventScroll: true });

  /** The target a pending OS file dialog will place into. A ref, not state: it
   *  is written synchronously next to `input.click()` and read back in the
   *  change handler, with no render in between. */
  const pendingSystemAdd = useRef<AddToTrackTarget | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const midiFileInputRef = useRef<HTMLInputElement | null>(null);
  const midiTracksInputRef = useRef<HTMLInputElement | null>(null);

  /** Library entries -> clips. The first lands where the user pointed; further
   *  files of a multi-file pick get a track each, the rule onTimelineDrop uses. */
  const placeEntriesOnTarget = async (entries: LibraryEntry[], target: AddToTrackTarget) => {
    if (entries.length === 0) return;
    const first = resolveAddTarget(target.trackId, entries[0].title);
    if (!first) return;
    try {
      await placeEntryOnTrack(entries[0], first, target.atSec, 'Added');
      for (const entry of entries.slice(1)) {
        const track = resolveAddTarget(null, entry.title);
        if (track) await placeEntryOnTrack(entry, track, target.atSec, 'Added');
      }
    } catch (err) {
      logError('editor', `Add to track failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Whatever the picker handed back, on the target track. */
  const placePick = async (pick: LibraryPick, target: AddToTrackTarget) => {
    if (pick.kind === 'midi') {
      // A library row is a song's transcription; a file from disk is whatever it is.
      await addMidiClipFromBytes(pick.bytes, pick.label, target.atSec, target.trackId, pick.row ? { stem: pick.row.midi_path ?? pick.row.id, fromAudio: true } : undefined);
      return;
    }
    const track = resolveAddTarget(target.trackId, pick.label);
    if (!track) return;
    try {
      if (pick.kind === 'audio') {
        await placeEntryOnTrack(pick.entry, track, target.atSec, 'Added');
      } else {
        // A stem is an ordinary audio clip: there is no stem clip kind, only a
        // different place the Blob comes from.
        await placeAudioOnTrack(
          {
            label: pick.label,
            mimeType: 'audio/wav',
            // The song the stem was separated from: the clip reads its analysis.
            songEntryId: pick.row.parent_id || undefined,
            fetch: () => fetchBlobWithRetry(pick.url, { label: pick.label }),
          },
          track,
          target.atSec,
          'Added',
        );
      }
    } catch (err) {
      logError('editor', `Add to track failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Audio chosen from the OS dialog or a Recent list: imported to the library
   *  first (what a desktop drop does), then placed. */
  const onAddAudioFiles = async (files: File[], target: AddToTrackTarget | null) => {
    if (!target || files.length === 0) return;
    // importAudioFiles logs its own failures and its own multi-file summary.
    const { imported } = await importAudioFiles(files, ADD_TO_TRACK_ORIGIN);
    await placeEntriesOnTarget(imported, target);
  };

  const onAddMidiFiles = async (files: File[], target: AddToTrackTarget | null) => {
    const file = files[0];
    if (!target || !file) return;
    try {
      const bytes = await file.arrayBuffer();
      await addMidiClipFromBytes(bytes, midiFileLabel(file.name), target.atSec, target.trackId);
    } catch (err) {
      logError('editor', `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** "MIDI file as tracks": every part of the file on a new track of its own at the clicked time (lib/midiImportTracks). */
  const onAddMidiTracksFiles = async (files: File[], target: AddToTrackTarget | null) => {
    const file = files[0];
    if (!target || !file) return;
    try {
      await importMidiBytesAsTracks(await file.arrayBuffer(), midiFileLabel(file.name), target.atSec);
    } catch (err) {
      logError('editor', `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** The target the open OS dialog was opened for, handed over once. */
  const takePendingAdd = (): AddToTrackTarget | null => {
    const target = pendingSystemAdd.current;
    pendingSystemAdd.current = null;
    return target;
  };

  /** Where a file chosen from a Recent list lands: the one selected track, or
   *  a new track when none or several are selected, at the edit cursor. */
  const recentAddTarget = (): AddToTrackTarget => {
    const st = useEditorStore.getState();
    const track = selectedTrackIds.length === 1 ? st.tracks.find((t) => t.id === selectedTrackIds[0]) : undefined;
    return { trackId: track?.id ?? null, trackName: track?.name ?? null, atSec: st.editCursorSec };
  };

  /** Run one entry of the add-to-track menu.
   *
   *  Anything that opens an OS file dialog calls `input.click()` synchronously
   *  from here. ContextMenu runs `onSelect` in the same tick as the click, so
   *  the user activation is still live -- one `await` before the `.click()` and
   *  Chrome refuses to open the dialog, silently. */
  const runAddEntry = (
    entry: AddToTrackEntry,
    target: AddToTrackTarget,
    at: ContextMenuPosition | null,
  ) => {
    returnFocusToTimeline();
    switch (entry.id) {
      case 'audio-library':
      case 'midi-library':
        setAddPicker({
          tab: entry.id === 'midi-library' ? 'midi' : 'audio',
          trackId: target.trackId,
          atSec: target.atSec,
          // The menu's own anchor, captured at render: the menu has already
          // closed by the time this runs, so its state is gone.
          x: at?.x ?? 240,
          y: at?.y ?? 160,
        });
        return;
      case 'audio-system':
        pendingSystemAdd.current = target;
        audioFileInputRef.current?.click();
        return;
      case 'midi-system':
        pendingSystemAdd.current = target;
        midiFileInputRef.current?.click();
        return;
      case 'midi-tracks':
        pendingSystemAdd.current = target;
        midiTracksInputRef.current?.click();
        return;
      case 'midi-empty':
        // The menu's own anchor, as the library picker takes it.
        setNewPart({ trackId: target.trackId, atSec: target.atSec, x: at?.x ?? 240, y: at?.y ?? 160 });
        return;
      case 'paste':
        pasteClips({ atSec: target.atSec, trackId: target.trackId ?? undefined });
        return;
      case 'new-track':
        selectTrackSingle(addTrack());
        return;
    }
  };

  /** The add-to-track entries as ContextMenu items. Shared by the timeline menu
   *  and the track-header menu so the two can never drift. */
  const addToTrackItems = (
    target: AddToTrackTarget,
    at: ContextMenuPosition | null,
    only?: (entry: AddToTrackEntry) => boolean,
  ): ContextMenuItem[] =>
    buildAddToTrackMenu(target, {
      // Null until the library store has loaded, so a right-click during boot
      // offers the row instead of greying it out with "no audio in the library".
      libraryAudioCount: libraryLoaded
        ? useLibraryStore.getState().entries.filter((e) => (e.kind ?? 'audio') === 'audio').length
        : null,
      libraryMidiCount,
      clipboardClipCount: clipboardRef.current.length,
      trackCount: tracks.length,
    })
      .filter((entry) => (only ? only(entry) : true))
      .map((entry): ContextMenuItem => ({
        type: 'item',
        icon: ADD_ENTRY_ICON[entry.id],
        label: entry.label,
        // A disabled row explains itself in the badge: a disabled menu item is
        // pointer-events:none, so the `title` tooltip below never fires on the
        // one row whose reason the user actually needs.
        hint: entry.shortReason
          ? entry.shortReason
          : entry.createsTrack && isAddSourceEntry(entry)
            ? 'new track'
            : undefined,
        title: entry.title,
        disabled: !entry.enabled,
        onSelect: () => runAddEntry(entry, target, at),
      }));

  // --- Renderers ---
  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

  /** Lanes content height (local px): every lane, the drop slot, the master strip. */
  const lanesHeightPx = tracks.length * trackH + 34 + (automationEdit ? MASTER_STRIP_H * (1 + busLaneStrips.length) : 0);
  /** Seconds the grid, the ruler's time ticks and its bar numbers cover
   *  (null until measured). Windowed to the viewport (+ padding), never the
   *  whole session — see rulerTimeTicks' own note on why that matters. */
  const gridWindow = viewport.width > 0 ? viewportWindowSec(viewport.scrollLeft, viewport.width, zoom, totalDuration) : null;
  const renderRuler = useMemo(
    () => (gridWindow ? rulerTimeTicks({ startSec: gridWindow.startSec, endSec: gridWindow.endSec, zoom }) : []),
    [gridWindow, zoom],
  );
  // Bar numbers under the arrangement's meter and tempo maps: bar 17 after
  // eight bars of 7/8 sits where those bars end, not where 4/4 would put it.
  const barLabels = gridWindow
    ? editRulerBars({ startSec: gridWindow.startSec, endSec: gridWindow.endSec, zoom, tempoMap: arrangementTempoMap, meterMap: arrangementMeterMap, minPx: RULER_BAR_LABEL_MIN_PX })
    : [];
  /** The time range's readout, and the ruler px its pill can cover. It sits in
   *  the ruler's time row, so the timecodes under it hide. */
  const rangeReadout = timeSelection ? formatRangeReadout(timeSelection) : null;
  const rangeReadoutSpan = timeSelection && rangeReadout ? rulerReadoutSpanPx(timeSelection.startSec, zoom, rangeReadout) : null;
  const meterFlags = gridWindow
    ? editMeterFlags({ tempoMap: arrangementTempoMap, meterMap: arrangementMeterMap }, gridWindow.startSec, gridWindow.endSec)
    : [];
  const tempoFlags = gridWindow
    ? editTempoFlags({ tempoMap: arrangementTempoMap, meterMap: arrangementMeterMap }, gridWindow.startSec, gridWindow.endSec)
    : [];
  const meterFlagBars = new Set(meterFlags.map((f) => f.bar + 1));
  /** Is this clip's action menu the one on screen? (`aria-expanded` for its trigger buttons.) */
  const clipMenuOpenFor = (clipId: string): boolean => clipMenu.position !== null && clipMenu.payload?.clipId === clipId;
  /** Open a clip's menu under one of its header buttons (compact / handle chrome). */
  const openClipMenuFrom = (el: HTMLElement, clipId: string) => {
    if (!selectedClipIds.includes(clipId)) selectClipSingle(clipId);
    const r = el.getBoundingClientRect();
    clipMenu.open(
      new MouseEvent('contextmenu', { clientX: r.left, clientY: r.bottom }),
      { clipId, atSec: Math.max(0, timelineClientXToSec(r.left + r.width / 2)) },
    );
  };

  const zoomToSelection = () => {
    if (timeSelection) zoomToRange(timeSelection.startSec, timeSelection.endSec);
  };
  const selectedClipsSpan = spanOfClips(clips.filter((c) => selectedClipIdSet.has(c.id) || c.id === selectedClipId));
  const zoomToSelectedClips = () => {
    if (selectedClipsSpan) zoomToRange(selectedClipsSpan.startSec, selectedClipsSpan.endSec);
  };

  const handleTimelineScroll = useCallback(() => {
    if (trackHeaderScrollRef.current && timelineScrollRef.current) {
      trackHeaderScrollRef.current.scrollTop = timelineScrollRef.current.scrollTop;
    }
  }, []);

  /* ── Track reorder (F01) ───────────────────────────────────────────────────
     Dragging a header's grip reorders the arrangement. The session model,
     threshold and drop target are pure (trackReorderDrag.ts); this owns pointer
     capture, the insertion line, autoscroll and the single store write. The
     dragged track's clips, routing and sound are untouched — a reorder is a
     permutation of the track array, nothing else. */

  /** The live session. A ref, because pointer handlers must see the latest one
   *  without waiting for a render. */
  const reorderRef = useRef<ReorderSession | null>(null);
  /** What the drag DRAWS: the rows to dim and the gap to draw the line in.
   *  Null whenever no drag is active, which is also the effects' on/off switch. */
  const [reorderDraw, setReorderDraw] = useState<{ movingIds: readonly string[]; insertIndex: number } | null>(null);
  /** Last pointer position (client px), re-read by each autoscroll frame. */
  const reorderClientRef = useRef<{ x: number; y: number } | null>(null);
  const reorderRafRef = useRef<number | null>(null);

  /** Client y -> px from the top of the track-list CONTENT (scroll applied).
   *  The rect is viewport px, so it is divided by the cumulative CSS zoom
   *  before it meets scrollTop, which is already local px. */
  const headerLocalY = useCallback((clientY: number): number | null => {
    const el = trackHeaderScrollRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return (clientY - rect.top) / effectiveZoom(el) + el.scrollTop;
  }, []);

  /** Move focus to a track's grip after a keyboard move, so a run of Alt+Arrow
   *  presses keeps moving the same track. Attribute lookup rather than a
   *  selector string: a track id never has to be CSS-escaped this way. */
  const focusTrackGrip = useCallback((trackId: string) => {
    const root = trackHeaderScrollRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-track-grip]')) {
      if (el.dataset.trackGrip === trackId) {
        el.focus();
        return;
      }
    }
  }, []);

  /** Tear down a session: no drag, no line, no autoscroll frame, no capture. */
  const endReorder = useCallback((el?: Element | null, pointerId?: number) => {
    reorderRef.current = null;
    reorderClientRef.current = null;
    if (reorderRafRef.current !== null) {
      cancelAnimationFrame(reorderRafRef.current);
      reorderRafRef.current = null;
    }
    setReorderDraw(null);
    if (el && pointerId !== undefined && el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
  }, []);

  /** Escape / pointercancel / lost capture: the drag ends and the order is left
   *  exactly as it was. */
  const cancelReorderDrag = useCallback((el?: Element | null) => {
    const s = reorderRef.current;
    if (!s) return;
    reorderRef.current = cancelReorder(s);
    endReorder(el, s.pointerId);
  }, [endReorder]);

  /** One autoscroll frame while the pointer sits near the header column's top
   *  or bottom edge. The real scroller is the timeline; the header column
   *  mirrors its scrollTop (handleTimelineScroll), so both are written here and
   *  the drop target is re-read from the new scroll offset. Held in a ref so
   *  the rAF chain always runs the current render's closure. */
  const reorderAutoscrollRef = useRef<() => void>(() => {});
  const reorderAutoscroll = () => {
    reorderRafRef.current = null;
    const s = reorderRef.current;
    const header = trackHeaderScrollRef.current;
    const scroller = timelineScrollRef.current;
    const p = reorderClientRef.current;
    if (!s || s.phase !== 'active' || !header || !scroller || !p) return;
    const vp = header.getBoundingClientRect();
    // A reorder only ever moves rows up and down, so the horizontal velocity is
    // read and dropped. (DOMRect's edges live on its prototype — spreading one
    // yields an empty object — so they are named out explicitly.)
    const { vy } = autoscrollVelocity(
      { x: p.x, y: p.y },
      { left: vp.left, top: vp.top, right: vp.right, bottom: vp.bottom },
    );
    if (vy !== 0) {
      const z = effectiveZoom(header);
      const before = scroller.scrollTop;
      markProgrammaticScroll();
      scroller.scrollTop += vy / z; // velocity is screen px per frame, scrollTop is local px
      header.scrollTop = scroller.scrollTop;
      if (scroller.scrollTop !== before) {
        const localY = headerLocalY(p.y);
        if (localY !== null) {
          const rows = reorderRows(useEditorStore.getState().tracks.map((t) => t.id), trackH);
          const next = moveReorder(s, s.pointerId, p.y, localY, rows);
          if (next !== s) {
            reorderRef.current = next;
            if (next.insertIndex !== null) setReorderDraw({ movingIds: next.movingIds, insertIndex: next.insertIndex });
          }
        }
      }
    }
    reorderRafRef.current = requestAnimationFrame(() => reorderAutoscrollRef.current());
  };

  /** Five refs whose `.current` must always be this render's closure — an rAF
   *  loop, a native listener or a keydown handler holds a stable ref but still
   *  needs to see the current render's props and store reads. One effect, no
   *  dependency array, so it runs after every render exactly like the
   *  render-phase writes it replaces. */
  useLayoutEffect(() => {
    requestZoomRef.current = requestZoom;
    wheelHandlerRef.current = wheelHandler;
    marqueeAutoscrollRef.current = marqueeAutoscroll;
    timelineEscapeRef.current = timelineEscape;
    reorderAutoscrollRef.current = reorderAutoscroll;
  });

  const onGripPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>, trackId: string) => {
    if (!isPrimaryGestureButton(e, IS_MAC)) return;
    // The header row's own pointerdown selects the track; the grip is a drag
    // handle, not a selector, so the press stops here.
    e.stopPropagation();
    // preventDefault keeps the press from selecting the header's text or
    // starting a native drag — and, with it, from focusing the button, so the
    // focus the keyboard path needs is taken explicitly.
    e.preventDefault();
    e.currentTarget.focus();
    const st = useEditorStore.getState();
    reorderRef.current = startReorder(e.pointerId, trackId, e.clientY, st.selectedTrackIds);
    reorderClientRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onGripPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const s = reorderRef.current;
    if (!s || s.pointerId !== e.pointerId || s.phase === 'cancelled') return;
    const localY = headerLocalY(e.clientY);
    if (localY === null) return;
    reorderClientRef.current = { x: e.clientX, y: e.clientY };
    const rows = reorderRows(useEditorStore.getState().tracks.map((t) => t.id), trackH);
    const next = moveReorder(s, e.pointerId, e.clientY, localY, rows);
    if (next !== s) {
      reorderRef.current = next;
      if (next.insertIndex !== null) setReorderDraw({ movingIds: next.movingIds, insertIndex: next.insertIndex });
    }
    if (reorderRef.current?.phase === 'active' && reorderRafRef.current === null) {
      reorderRafRef.current = requestAnimationFrame(() => reorderAutoscrollRef.current());
    }
  }, [headerLocalY, trackH]);

  const onGripPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const s = reorderRef.current;
    if (!s) return;
    // The order at RELEASE time decides, not the one the drag started with.
    const drop = finishReorder(s, e.pointerId, useEditorStore.getState().tracks.map((t) => t.id));
    endReorder(e.currentTarget, e.pointerId);
    // 'click' (under the threshold), 'none' (order unchanged) and 'ignore' all
    // write nothing: no undo step for a press that moved nothing.
    if (drop.kind === 'move') moveTracks(drop.ids, drop.beforeId);
  }, [endReorder, moveTracks]);

  const onGripPointerCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    cancelReorderDrag(e.currentTarget);
  }, [cancelReorderDrag]);

  /** Alt+Arrow on a focused grip moves the track (or the whole selection it
   *  belongs to) one row, and keeps the focus on it. */
  const onGripKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, trackId: string) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    moveTracksByOffset(movingIdsFor(trackId, useEditorStore.getState().selectedTrackIds), e.key === 'ArrowUp' ? -1 : 1);
    // React moves the same DOM node when the keyed rows reorder, so focus
    // normally survives on its own; this makes that a guarantee.
    requestAnimationFrame(() => focusTrackGrip(trackId));
  }, [focusTrackGrip, moveTracksByOffset]);

  /** Escape abandons a drag in flight. Registered only while one is active, so
   *  it never shadows the editor's own Escape at any other moment — and in the
   *  CAPTURE phase, because while a drag IS live Escape means "cancel it" and
   *  nothing else: the editor's Escape listener was registered first, so a
   *  bubble-phase listener here would clear the selection before this one ever
   *  ran (it bails on `defaultPrevented`, which capture sets in time). */
  useEffect(() => {
    if (!reorderDraw) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      cancelReorderDrag(document.activeElement);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [reorderDraw, cancelReorderDrag]);

  // A reorder never outlives EDIT: unmounting stops its frame loop.
  useEffect(() => () => {
    if (reorderRafRef.current !== null) cancelAnimationFrame(reorderRafRef.current);
    reorderRafRef.current = null;
    reorderRef.current = null;
  }, []);

  /** Ids being dragged right now, for dimming their rows. */
  const reorderMovingSet = useMemo(
    () => new Set(reorderDraw?.movingIds ?? []),
    [reorderDraw],
  );

  return (
    <div data-keyscope="edit-timeline" className="hardware-card h-full flex flex-col bg-black/40 overflow-hidden" ref={containerRef}>
      {/* Editor Toolbar */}
      <div data-tour="edit-toolbar" className="flex flex-wrap items-center gap-y-2 p-2 border-b border-white/5 bg-black/20 shrink-0">
        <div className="flex flex-wrap items-center gap-2 gap-y-2">
          {/* The surface play key leads the toolbar with stop right after it,
              the spot every surface that plays keeps its play in. */}
          <div className="flex items-center gap-1">
            <SurfacePlayKey
              size="bar"
              pauses
              busy={isArmingPlayback || isSelectionRendering}
              playing={isEditorPlaying}
              onToggle={() => isEditorPlaying ? pauseEditorPlayback() : void playEditorTimeline()}
              what="the arrangement"
              disabled={clips.length === 0 || isArmingPlayback || isSelectionRendering}
              title={isArmingPlayback || isSelectionRendering ? 'Rendering…' : isEditorPlaying ? 'Pause (Space)' : 'Play from playhead (Space)'}
            />
            <button
              onClick={stopEditorPlayback}
              disabled={!isEditorPlaying}
              aria-label="Stop and return to start"
              className="h-7 w-8 grid place-items-center hover:bg-white/10 rounded text-zinc-400 disabled:opacity-30"
              title="Stop and return to start"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
          </div>

          <div className="flex bg-black/40 p-0.5 rounded border border-white/5 gap-0.5">
            <button
              onClick={() => setTool('move')}
              className={`p-1 px-1.5 rounded transition-colors ${tool === 'move' ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
              title="Move tool: drag clips"
            >
              <Move className="w-3 h-3" />
            </button>
            <button
              onClick={() => setTool('cut')}
              className={`p-1 px-1.5 rounded transition-colors ${tool === 'cut' ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
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
              className="p-1 px-1.5 rounded transition-colors text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
            >
              <Undo2 className="w-3 h-3" />
            </button>
            <button
              onClick={() => redo()}
              disabled={!canRedo}
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              className="p-1 px-1.5 rounded transition-colors text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
            >
              <Redo2 className="w-3 h-3" />
            </button>
          </div>

          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded">
            {/* BPM lives next to the snap picker because the grid divisions are
                defined in terms of it — a bar/triplet grid is meaningless without
                a tempo the user can actually set. */}
            <EditorBpmField bpm={projectBpm} onChange={setBpm} />
            {/* The project tuning sits with the tempo: both are what every part is played against. */}
            <TuningControl />
            <button
              type="button"
              onClick={() => {
                const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
                if (ids.length === 0) return;
                if (ids.length === 1) {
                  void beatMatchClips(ids, projectBpm, true);
                  return;
                }
                // The first selected clip is the master, the way a deck's SYNC follows the other deck.
                const anchor = clips.find((c) => c.id === ids[0]);
                const anchorBpm = anchor ? clipKnownBpm(anchor) : null;
                void beatMatchClips(anchorBpm !== null ? ids.slice(1) : ids, anchorBpm ?? projectBpm, anchorBpm === null);
              }}
              disabled={timePitchBusy || (selectedClipIds.length === 0 && !selectedClipId)}
              aria-label="Beat match the selected clips"
              title="Beat match (DJ sync): one selected clip stretches to the project tempo; with several selected, the rest stretch to the first one and the project tempo follows"
              className="px-1.5 py-0.5 rounded text-xs font-bold uppercase tracking-wider text-purple-300 hover:text-purple-100 hover:bg-purple-500/10 disabled:opacity-40 disabled:pointer-events-none"
            >
              {timePitchBusy ? 'Syncing…' : 'Sync'}
            </button>
            <button
              onClick={tapTempo}
              aria-label="Tap tempo"
              className="px-1 py-0.5 rounded text-xs font-bold uppercase tracking-wider text-zinc-400 hover:text-purple-300 hover:bg-white/5"
              title="Tap tempo — tap in time to set the BPM"
            >
              tap
            </button>
            <div className="h-4 w-px bg-white/10" />
            <label htmlFor="editor-snap-division" className="sr-only">Snap division</label>
            <select
              id="editor-snap-division"
              name="editor-snap-division"
              value={snap}
              onChange={(e) => setSnap(e.target.value as SnapDivision)}
              className="bg-transparent border-none outline-none text-xs font-bold text-zinc-100 cursor-pointer"
              style={{ colorScheme: 'dark' }}
              title="Snap divisions are relative to the editor BPM"
            >
              {SNAP_DIVISIONS.map((d) => (
                <option key={d} value={d}>
                  {snapDivisionLabel(d)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-0.5 bg-black/40 p-0.5 rounded border border-white/5">
            <button
              type="button"
              onClick={() => zoomStepBy('out')}
              aria-label="Zoom out around the edit cursor"
              className="p-1 hover:bg-white/5 rounded text-zinc-500"
              title="Zoom out around the edit cursor (-)"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <span className="text-xs font-bold tabular-nums text-zinc-400 min-w-20 text-center">{zoom.toFixed(2)}px/s</span>
            <button
              type="button"
              onClick={() => zoomStepBy('in')}
              aria-label="Zoom in around the edit cursor"
              className="p-1 hover:bg-white/5 rounded text-zinc-500"
              title="Zoom in around the edit cursor (+)"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={zoomToFit}
              aria-label="Zoom to fit the whole arrangement"
              className="p-1 hover:bg-white/5 rounded text-zinc-500"
              title="Zoom to fit the whole arrangement (Shift+F)"
            >
              <Maximize2 className="w-3 h-3" />
            </button>
            {/* The waveform colour mode for every clip (and every waveform in
                the app); a button inside each clip covered its trim handle
                and fade grip. */}
            <WaveformModeToggle variant="toolbar" />
            {/* Zoom-to-selection, zoom-to-clips, keyboard shortcuts, lane
                height and timeline preferences moved into the VIEW menu so the
                toolbar is one row; the prefs panel it opens stays mounted here. */}
            <TimelinePrefsPanel anchor={prefsAnchor} onClose={closePrefs} />
          </div>

          <div className="h-4 w-px bg-white/10" />

          <button
            disabled={selectedClipCount === 0}
            onClick={deleteSelectedClips}
            className="p-1 px-1.5 hover:bg-red-500/20 rounded text-zinc-400 hover:text-red-400 disabled:opacity-30 disabled:pointer-events-none"
            title="Delete selected clip(s) (Del)"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <div className="h-4 w-px bg-white/10" />

          <button
            onClick={(e) => {
              setToolbarPanelAt(underKey(e.currentTarget));
              setShowMasterFx((v) => !v);
            }}
            aria-pressed={showMasterFx}
            aria-label="Master FX"
            className={`flex items-center gap-1.5 p-1 px-1.5 rounded border transition-colors font-display text-xs font-bold uppercase tracking-wider
              ${showMasterFx || masterFxChain.length + masterVstChain.length > 0 ? 'bg-purple-600/20 border-purple-500/40 text-purple-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
            title="Master FX — built-in effects, VST3s and control surfaces in one chain; click an entry to open its control window"
          >
            <SlidersHorizontal className="w-3 h-3" /> FX
            {previewMode === 'frozen' && <Snowflake className="w-2.5 h-2.5 text-cyan-300" />}
          </button>

          {/* Generative tools live behind ONE dropdown — Magenta and Metamorph
              are occasional tools, not top-level modes, and each labeled
              button was toolbar clutter. */}
          <button
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setToolsMenu((cur) => (cur ? null : { x: rect.left, y: rect.bottom + 4 }));
            }}
            aria-haspopup="menu"
            aria-expanded={!!toolsMenu}
            aria-label="Generative tools"
            title="Generative tools — Magenta RT2, Metamorph"
            className={`flex items-center gap-1.5 p-1 px-1.5 rounded border transition-colors font-display text-xs font-bold uppercase tracking-wider
              ${magentaTool || showMetamorph ? 'bg-cyan-600/20 border-cyan-500/40 text-cyan-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
          >
            <Wand2 className="w-3 h-3" /> TOOLS <ChevronDown className="w-2.5 h-2.5" />
          </button>

          {/* View options — zoom to selection or clips, lane height, keyboard
              shortcuts and timeline preferences, nested so the bar stays one
              row from play to MIXDOWN. */}
          <button
            type="button"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setViewMenu((cur) => (cur ? null : { x: rect.left, y: rect.bottom + 4 }));
            }}
            aria-haspopup="menu"
            aria-expanded={!!viewMenu}
            aria-label="View options"
            title="View — zoom to selection or clips, lane height, keyboard shortcuts, timeline preferences"
            className={`flex items-center gap-1.5 p-1 px-1.5 rounded border transition-colors font-display text-xs font-bold uppercase tracking-wider
              ${viewMenu ? 'bg-purple-600/20 border-purple-500/40 text-purple-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
          >
            <Eye className="w-3 h-3" /> VIEW <ChevronDown className="w-2.5 h-2.5" />
          </button>

          {/* Mode cluster, grouped like the tool/undo clusters: the record-mode
              select (four states, so it names itself), then the icon-only toggles
              whose words live in the tooltips and whose states live in the colors. */}
          <div className="flex bg-black/40 p-0.5 rounded border border-white/5 gap-0.5">
            {/* Record mode. A two-state button could only ever say on/off, and
                there are FOUR modes whose whole point is how they differ, so this
                is a native <select> — which needs a real id/name and a <label
                htmlFor>, sr-only because the chosen mode is the visible text
                (same pattern as the footer's count-in select). */}
            <label htmlFor="automation-mode" className="sr-only">Automation record mode</label>
            <select
              id="automation-mode"
              name="automationMode"
              value={automationMode}
              onChange={(e) => setAutomationMode(e.target.value as AutomationMode)}
              title="Automation record mode — READ plays the lanes back; TOUCH records while you hold a control and hands it back when you let go; LATCH keeps writing the released value until you stop; WRITE arms every lane from the moment you press play"
              className="bg-transparent text-zinc-400 font-display text-xs font-bold uppercase tracking-wider px-1 py-0.5 rounded focus:outline-hidden focus:ring-1 focus:ring-red-500/60 hover:text-white"
            >
              {AUTOMATION_MODES.map((m) => (
                // Capitalised rather than shouted, so the accessible name a screen
                // reader announces is "Touch", not "TOUCH" — the uppercase is the
                // toolbar's typography, not part of the word.
                <option key={m} value={m} className="bg-[#0d0a14] text-zinc-200">
                  {m[0].toUpperCase() + m.slice(1)}
                </option>
              ))}
            </select>
            {/* Not a control any more — just the armed light beside the select. */}
            {automationArmed && (
              <span aria-hidden className="flex items-center px-0.5 text-red-400">
                <Circle className="w-3 h-3 fill-current animate-pulse" />
              </span>
            )}
            <button
              onClick={(e) => {
                setAutomationAt(underKey(e.currentTarget));
                setAutomationEdit((v) => {
                  const next = !v;
                  if (next && !activeLaneId && automationLanes.length > 0) setActiveLaneId(automationLanes[0].id);
                  return next;
                });
              }}
              aria-pressed={automationEdit}
              aria-label="Edit automation lanes"
              title="AUTO — edit automation: draw, drag, and delete breakpoints on the selected lane"
              className={`p-1 px-1.5 rounded transition-colors ${automationEdit ? 'bg-amber-600/30 text-amber-300' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
            >
              <Spline className="w-3 h-3" />
            </button>
            <button
              onClick={() => setLoopEnabled(!loopEnabled)}
              onContextMenu={(e) => { e.preventDefault(); clearLoop(); }}
              aria-pressed={loopEnabled}
              aria-label="Loop region"
              title="LOOP — shift-drag the ruler to set the region, click to toggle, right-click to clear"
              className={`p-1 px-1.5 rounded transition-colors ${loopEnabled ? 'bg-amber-600/30 text-amber-300' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
            >
              <Repeat className="w-3 h-3" />
            </button>
            <button
              onClick={() => addMarker(useEditorStore.getState().playheadSec)}
              aria-label="Add marker at playhead"
              title="MARK — add a marker at the playhead (double-click a flag to rename, Alt-click to delete)"
              className="p-1 px-1.5 rounded transition-colors text-zinc-500 hover:text-white hover:bg-white/5"
            >
              <Flag className="w-3 h-3" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 ml-auto shrink-0">
          <span className="text-xs font-bold text-zinc-500 tabular-nums">
            <span ref={headerTcRef}>{formatTimecode(playheadSec)}</span> / {formatTimecode(totalDuration)}
          </span>
          {/* What the render queue is doing right now: the active job, its
              progress, how many wait behind it, and the one cancel that can
              honestly be offered. */}
          <RenderJobsPill />
          {/* Name, options and render in one chip: the field names the file,
              the ⋯ opens the export options, the button renders it. "Mixdown"
              is said once, on the button, and the button is a neutral chip like
              the rest of the bar rather than the primary purple. */}
          <div className="flex items-center rounded border border-white/10 bg-black/40 overflow-hidden">
            <label htmlFor="editor-mixdown-name" className="sr-only">Mixdown filename</label>
            <input
              id="editor-mixdown-name"
              name="editor-mixdown-name"
              type="text"
              value={mixdownName}
              onChange={(e) => setMixdownName(e.target.value)}
              placeholder="name…"
              className="w-24 bg-transparent px-2 py-1 text-xs font-bold text-zinc-300 placeholder:text-zinc-600 outline-none focus:bg-white/5 transition-colors"
              title="Optional filename for the mixdown"
            />
            <button
              type="button"
              onClick={() => setExportDialogOpen('mix')}
              aria-haspopup="dialog"
              aria-expanded={exportDialogOpen !== null}
              className="self-stretch border-l border-white/10 px-1.5 text-zinc-400 hover:text-white hover:bg-white/5"
              aria-label="Export options"
              title="Export options — format, bit depth, range, stems or a clip selection"
            >
              <Ellipsis className="w-3 h-3" />
            </button>
            <button
              onClick={commitEdit}
              // A MASTER VST FREEZE does not light this: it is its own `freeze` job.
              // NOT disabled while one is committing: a second press queues a
              // second mixdown behind the first (the pill offers to cancel it)
              // instead of being swallowed. Only an empty timeline has nothing
              // to render.
              disabled={clips.length === 0}
              className="flex items-center gap-1.5 self-stretch border-l border-white/10 bg-white/10 px-3 py-1 text-xs font-bold text-zinc-100 hover:bg-white/20 disabled:opacity-40 disabled:pointer-events-none"
              title={isCommitting
                ? 'A mixdown is already rendering — pressing this queues another behind it'
                : 'Render all clips to a single audio file and save it to the library'}
            >
              {isCommitting ? <Upload className="w-3 h-3 animate-pulse" /> : <Save className="w-3 h-3" />}
              {isCommitting ? 'Mixing…' : 'Mixdown'}
            </button>
          </div>
        </div>
      </div>

      {exportDialogOpen !== null && (
        <ExportDialog
          onClose={() => setExportDialogOpen(null)}
          onExport={runExportPlan}
          openOn={exportDialogOpen}
          projectEndSec={totalDuration}
          selectionSec={timeSelection}
          tracks={tracks.map((t) => ({ id: t.id, name: t.name }))}
          selectedClipIds={selectedClipIds}
          defaultName={mixdownName.trim() || undefined}
        />
      )}

      {/* MASTER FX + METAMORPH float as popups (like the per-track FX rack) so
          they never shove the timeline down; close with the X. They open under
          the toolbar key that asked for them (toolbarPanelAt), which is where
          TOOLS opens its menu, and PopoverPortal keeps them inside the window
          and above the transport from there. A path that opens METAMORPH with
          no key to hang under falls back to the timeline's top-left corner,
          where both panels used to be pinned. */}
      {(showMasterFx || showMetamorph) && (
        <PopoverPortal
          x={toolbarPanelAt?.x}
          y={toolbarPanelAt?.y}
          anchorClassName="top-28 left-4"
          maxHeight="70vh"
          className="fixed z-50 flex items-start gap-3 max-w-[calc(100%-2rem)]"
        >
          {showMasterFx && (
            <section aria-label="Master FX" className="w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                <span className="font-display text-xs font-bold uppercase tracking-wider text-purple-300">Master FX</span>
                <button
                  onClick={() => setShowMasterFx(false)}
                  aria-label="Close master FX"
                  className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {/* ONE list for every effect kind — click a row to open its
                  control window. Rack effects + the Ares surface live in the
                  realtime chain; VST3s live in the frozen-render chain and
                  appear as rows in the same list right below. */}
              <FxChainList
                scope={{ kind: 'master' }}
                onOpenEntry={openEntryWindow}
                onAddEffect={addMasterEffect}
                onAddVst={addAndEditMasterVst}
                vstPlugins={vstPlugins}
                vstScanning={vstScanning}
                onRescanVst={() => void scanVst(true)}
                emptyHint="No master effects yet — add one below."
              />
              {masterVstChain.length > 0 && (
                <FxChainList
                  scope={{ kind: 'masterVst' }}
                  onOpenEntry={openEntryWindow}
                />
              )}

              {/* Live / Frozen — VSTs apply to the rendered master. */}
              <div className="flex items-center gap-1.5 border-t border-white/10 pt-2">
                <button
                  onClick={enterLiveMode}
                  className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded border font-display text-xs font-bold uppercase tracking-wider transition-colors ${previewMode === 'live' ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-100' : 'border-white/10 text-zinc-400 hover:bg-white/5'}`}
                >
                  <Play className="w-3 h-3" /> Live
                </button>
                <button
                  onClick={() => void enterFrozenMode()}
                  disabled={masterVstChain.length === 0 || clips.length === 0 || isFreezing}
                  className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded border font-display text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40 ${previewMode === 'frozen' ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-100' : 'border-white/10 text-zinc-400 hover:bg-white/5'}`}
                >
                  {isFreezing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Snowflake className="w-3 h-3" />} Frozen
                </button>
              </div>
              {previewMode === 'frozen' && (
                <button
                  onClick={() => void reRenderFrozen()}
                  disabled={isFreezing || !frozenStale}
                  className="btn-ghost inline-flex items-center justify-center gap-1.5 font-sans text-xs font-bold disabled:opacity-40"
                  title={frozenStale ? 'Re-render the master through the VST chain' : 'Frozen render is up to date'}
                >
                  {isFreezing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  {frozenStale ? 'Re-render (stale)' : 'Up to date'}
                </button>
              )}
              <p className="font-sans text-xs font-bold text-zinc-500 leading-relaxed">
                VST3 entries apply to the rendered master: Live plays the realtime mix (built-in rack only); Frozen plays the VST-processed render and re-renders after edits.
              </p>
            </section>
          )}
          {showMetamorph && (
            <section aria-label="Metamorph" className="w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                <span className="font-display text-xs font-bold uppercase tracking-wider text-purple-300">
                  Metamorph <span className="font-sans text-zinc-500 normal-case tracking-normal">granular identity bleed</span>
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
        </PopoverPortal>
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
              <span className="font-display text-xs font-bold uppercase tracking-wider text-cyan-300">Magenta RT2</span>
              <div className="flex items-center gap-1 ml-2">
                {MAGENTA_TOOLS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setMagentaToolId(t.id)}
                    title={t.desc}
                    className={`px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider border transition-colors ${magentaTool.id === t.id ? 'bg-cyan-600/20 border-cyan-500/40 text-cyan-200' : 'border-white/8 text-zinc-500 hover:text-zinc-200 hover:bg-white/5'}`}
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

      {/* The arrangement's meter map and tempo map (the ruler's flags and the
          Meter · Tempo button open it). Portaled like the FX rack. */}
      {timeMapPanel && (
        <PopoverPortal
          x={timeMapPanel.x}
          y={timeMapPanel.y}
          anchorClassName="left-4 top-28"
          maxHeight="80vh"
          innerRef={timeMapPanelRef}
          className="fixed z-50 w-160 max-w-[95vw] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3"
        >
          <div id={timeMapPanelId} role="dialog" aria-labelledby={`${timeMapPanelId}-h`}>
            <EditTimeMapPanel headingId={`${timeMapPanelId}-h`} focus={timeMapPanel.focus} onClose={closeTimeMapPanel} onSeek={seekEditorTo} />
          </div>
        </PopoverPortal>
      )}

      {/* "Empty MIDI part…" from the Add-to-track menus: an empty part with an
          instrument, in the arrangement's meter and tempo from its bar. */}
      {newPart && (
        <PopoverPortal
          x={newPart.x}
          y={newPart.y}
          anchorClassName="left-4 top-28"
          maxHeight="80vh"
          innerRef={newPartRef}
          className="fixed z-50 w-104 max-w-[95vw] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3"
        >
          <div id={newPartId} role="dialog" aria-labelledby={`${newPartId}-h`}>
            <NewMidiPartDialog
              headingId={`${newPartId}-h`}
              trackId={newPart.trackId}
              atSec={newPart.atSec}
              onClose={() => { setNewPart(null); returnFocusToTimeline(); }}
              onCreated={(clipId) => selectClipSingle(clipId)}
            />
          </div>
        </PopoverPortal>
      )}

      {/* Per-track FX rack (floating popover, portaled to body so it opens AT
          the click even under the .dense-layout CSS zoom) */}
      {fxPanel && (() => {
        const t = tracks.find((tr) => tr.id === fxPanel.trackId);
        if (!t) return null;
        return (
          <PopoverPortal
            x={fxPanel.x}
            y={fxPanel.y}
            anchorClassName="right-4 top-28"
            maxHeight="70vh"
            className="fixed z-50 w-90 overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
          >
            {/* Title and add controls stay put; the rows between them scroll. */}
            <div className="shrink-0 flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400 truncate">
                Track FX — <span style={{ color: t.color }}>{t.name}</span>
              </span>
              <button
                onClick={closeFxRack}
                aria-label="Close track FX rack"
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {/* ONE list: built-in effects, VST3s and the Ares surface are the
                same thing here — click a row to open its control window. */}
            <FxChainList
              scope={{ kind: 'track', trackId: t.id }}
              onOpenEntry={openEntryWindow}
              onAddEffect={(eid) => addTrackEffect(t.id, eid)}
              onAddVst={(pl) => addAndEditTrackVst(t.id, pl)}
              vstPlugins={vstPlugins}
              vstScanning={vstScanning}
              onRescanVst={() => void scanVst(true)}
              emptyHint="No inserts on this track yet — add one below."
              scrollRows
            />
          </PopoverPortal>
        );
      })()}

      {/* TOOLS dropdown — the generative tools menu (shared ContextMenu
          primitive, anchored under the toolbar button). */}
      <ContextMenu
        position={toolsMenu}
        onClose={() => setToolsMenu(null)}
        title="Generative tools"
        items={[
          {
            type: 'item',
            label: 'Inpaint region',
            icon: <Paintbrush className="w-3 h-3" />,
            hint: inpaintSelection ? 'Ctrl+P' : 'select a region first',
            disabled: !inpaintSelection,
            onSelect: openInpaintPanel,
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Magenta RT2',
            icon: <Music className="w-3 h-3" />,
            hint: 'Collider · Jam · MRT2',
            onSelect: () => setMagentaToolId(MAGENTA_TOOLS[0].id),
          },
          {
            type: 'item',
            label: showMetamorph ? 'Close Metamorph' : 'Metamorph',
            icon: <Wand2 className="w-3 h-3" />,
            hint: 'identity bleed',
            onSelect: () => {
              // The menu's own position is already under the TOOLS key, so the
              // panel opens where the menu it was chosen from is.
              if (toolsMenu) setToolbarPanelAt(toolsMenu);
              setShowMetamorph((v) => !v);
            },
          },
        ]}
      />

      {/* VIEW dropdown — zoom, lane height, keyboard shortcuts and timeline
          preferences, nested off the toolbar (shared ContextMenu primitive). */}
      <ContextMenu
        position={viewMenu}
        onClose={() => setViewMenu(null)}
        title="View"
        items={[
          { type: 'header', label: 'Zoom' },
          {
            type: 'item',
            label: 'Zoom to selection',
            icon: <ScanSearch className="w-3 h-3" />,
            hint: timeSelection ? undefined : 'no range',
            disabled: !timeSelection,
            onSelect: zoomToSelection,
          },
          {
            type: 'item',
            label: 'Zoom to selected clips',
            icon: <BoxSelect className="w-3 h-3" />,
            hint: selectedClipsSpan ? undefined : 'no clips',
            disabled: !selectedClipsSpan,
            onSelect: zoomToSelectedClips,
          },
          { type: 'separator' },
          { type: 'header', label: 'Lane height' },
          {
            type: 'item',
            label: 'Taller lanes',
            icon: <Rows3 className="w-3 h-3" />,
            disabled: trackH >= TRACK_HEIGHT_MAX,
            onSelect: () => setTrackHeight(Math.min(TRACK_HEIGHT_MAX, trackH + 8)),
          },
          {
            type: 'item',
            label: 'Shorter lanes',
            icon: <Rows3 className="w-3 h-3" />,
            disabled: trackH <= TRACK_HEIGHT_MIN,
            onSelect: () => setTrackHeight(Math.max(TRACK_HEIGHT_MIN, trackH - 8)),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Keyboard shortcuts',
            icon: <Keyboard className="w-3 h-3" />,
            hint: '?',
            onSelect: () => setShowShortcuts(true),
          },
          {
            type: 'item',
            label: 'Timeline preferences…',
            icon: <Settings2 className="w-3 h-3" />,
            onSelect: () => { if (viewMenu) setPrefsAnchor(viewMenu); },
          },
        ]}
      />

      {/* Unified per-effect control windows: one draggable window per chain
          entry (VST native GUI / Ares surface / built-in params), opened from
          the FX lists. Owns the Ares bridge while an EDIT entry drives it. */}
      <EffectWindowsHost
        writeParams={writeFxParams}
        gestureStart={armFxPanel}
        gestureEnd={endFxPanel}
        displayParams={fxDisplayParams}
        openVst={openVstFor}
        projectBpm={projectBpm}
      />

      {/* Stems pre-run modal + progress banner for clip → stem-tracks explode. */}
      <StemsRunModal
        open={stemsModal !== null}
        entryLabel={stemsModal ? clips.find((c) => c.id === stemsModal.clipId)?.label : undefined}
        onCancel={() => setStemsModal(null)}
        onConfirm={onConfirmStemsModal}
      />
      {stemsJob && createPortal(
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-100 flex items-center gap-3 rounded-lg border border-purple-500/40 bg-black/90 px-4 py-2 shadow-2xl">
          {!stemsJob.phase.startsWith('failed') && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-300" />
          )}
          <span className="text-xs font-bold tabular-nums text-zinc-200">
            {stemsJob.phase.startsWith('failed')
              ? `Stem separation ${stemsJob.phase}`
              : `Separating stems — ${stemsJob.phase} ${stemsJob.pct}%`}
          </span>
          {stemsJob.entryId && !stemsJob.phase.startsWith('failed') && (
            <button
              onClick={abortStemsJob}
              className="px-2 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-200 text-xs font-black uppercase tracking-widest hover:bg-red-500/20"
            >
              Abort
            </button>
          )}
        </div>,
        document.body,
      )}

      {/* Automation lane panel (floating; while automation edit mode is on).
          Opens under the AUTO key, like every other toolbar panel. */}
      {automationEdit && (
        <PopoverPortal
          x={automationAt?.x}
          y={automationAt?.y}
          anchorClassName="left-4 top-28"
          maxHeight="70vh"
          className="fixed z-50 w-72 hardware-card bg-black/90 border border-amber-500/30 rounded-lg shadow-2xl shadow-amber-900/30 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
            <span className="font-display text-xs font-bold uppercase tracking-wider text-amber-300">Automation Lanes</span>
            <button
              onClick={() => setAutomationEdit(false)}
              aria-label="Close automation editor"
              className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {/* Add a lane for a parameter that has not been ridden yet. Before this,
              `addAutomationLane` (editorStore.ts) was reachable only from the
              assistant tool surface (`editor_add_automation_lane`) — a user who
              wanted a lane for a control they had not touched under WRITE had no
              way in. The picker offers the same target shapes that tool resolves:
              volume/pan per track, and one entry per numeric FX param, track racks
              and the master rack alike. A native select, so it needs a real
              id/name and an sr-only <label htmlFor> (CLAUDE.md rule 3) — the
              "Add lane" button beside it is the visible name for the pair. */}
          <div className="flex items-center gap-1 border-b border-white/5 pb-2">
            <label htmlFor="add-automation-lane" className="sr-only">Parameter to automate</label>
            <select
              id="add-automation-lane"
              name="addAutomationLane"
              value={addLaneKey}
              onChange={(e) => setAddLaneKey(e.target.value)}
              disabled={addLaneOptions.length === 0}
              title="Add an automation lane for a parameter you have not ridden yet"
              className="flex-1 min-w-0 bg-black/40 text-zinc-300 border border-white/10 rounded px-1.5 py-1 text-xs font-bold focus:outline-hidden focus:ring-1 focus:ring-amber-500/60 disabled:opacity-40"
            >
              <option value="">{addLaneOptions.length === 0 ? 'No parameters left to automate' : 'Choose a parameter…'}</option>
              {addLaneOptions.map((o) => (
                <option key={o.key} value={o.key} className="bg-[#0d0a14] text-zinc-200">{o.label}</option>
              ))}
            </select>
            <button
              onClick={() => {
                const opt = addLaneOptions.find((o) => o.key === addLaneKey);
                if (!opt) return;
                const laneId = addAutomationLane(opt.target);
                setActiveLaneId(laneId);
                setAddLaneKey('');
              }}
              disabled={!addLaneKey}
              aria-label="Add automation lane for the chosen parameter"
              title="Add lane"
              className="p-1 rounded text-amber-300 hover:text-white hover:bg-amber-600/30 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-amber-300 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          {/* A VST3 insert's own parameters, on a track, a bus or the master:
              the insert first, then one of the parameters its host lists. */}
          <VstAutomationPicker
            lanes={automationLanes}
            onAdd={(target) => setActiveLaneId(addAutomationLane(target))}
          />
          {automationLanes.length === 0 ? (
            <span className="text-xs font-bold tabular-nums text-zinc-600 leading-relaxed">
              No lanes yet. Pick a parameter above, or turn on WRITE and ride a fader or FX control while playing to record one.
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
                      className={`flex-1 text-left text-xs font-bold tabular-nums truncate ${active ? 'text-amber-100' : 'text-zinc-300 hover:text-white'}`}
                      title="Select this lane to edit its breakpoints"
                    >
                      {laneLabel(lane)} <span className="text-zinc-600">({lane.points.length})</span>
                    </button>
                    <button
                      onClick={() => clearAutomationLane(lane.id)}
                      aria-label={`Clear ${laneLabel(lane)}`}
                      title="Clear all breakpoints in this lane"
                      className="px-1 py-0.5 rounded text-xs font-bold tabular-nums text-zinc-500 hover:text-amber-300 hover:bg-white/5 shrink-0"
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
            <p className="text-xs font-bold tabular-nums text-zinc-500 leading-relaxed border-t border-white/5 pt-2">
              Editing the highlighted lane: click the curve to add a point, drag a point to move it, Alt-click or right-click a point to delete it.
            </p>
          )}
        </PopoverPortal>
      )}

      {/* Per-clip instrument override (floating; MIDI clips only). Portaled to
          body so the click-position anchor holds under the layout zoom. */}
      {instrPanel && (() => {
        const clip = clips.find((c) => c.id === instrPanel.clipId);
        if (!clip) return null;
        return (
          <PopoverPortal
            x={instrPanel.x}
            y={instrPanel.y}
            innerRef={instrPanelRef}
            className="fixed z-50 w-66 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400 truncate">
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
          </PopoverPortal>
        );
      })()}

      {/* Per-clip Time / Pitch popover (audio clips). Portaled to body so the
          click-position anchor holds under the layout zoom. */}
      {timePitchPanel && (() => {
        const clip = clips.find((c) => c.id === timePitchPanel.clipId);
        if (!clip) return null;
        return (
          <PopoverPortal
            x={timePitchPanel.x}
            y={timePitchPanel.y}
            innerRef={timePitchRef}
            className="fixed z-50 w-72 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400 truncate">
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
          </PopoverPortal>
        );
      })()}

      {/* Keyboard map. Dialog semantics so screen readers announce it as a modal
          and the close button is reachable; Escape and the backdrop both dismiss. */}
      {showShortcuts && (
        <div
          className="fixed inset-0 z-100 grid place-items-center bg-black/70 p-6"
          onClick={() => setShowShortcuts(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="editor-shortcuts-title"
            onClick={(e) => e.stopPropagation()}
            className="hardware-card bg-[#0c0a12] border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-4 max-w-2xl w-full max-h-full overflow-y-auto"
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2 mb-3">
              <h2 id="editor-shortcuts-title" className="font-display text-xs font-bold uppercase tracking-widest text-zinc-300">
                Edit — keyboard shortcuts
              </h2>
              <button
                onClick={() => setShowShortcuts(false)}
                aria-label="Close keyboard shortcuts"
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              {EDIT_SHORTCUTS.map((section) => (
                <div key={section.group} className="flex flex-col gap-1">
                  <span className="font-display text-xs font-bold uppercase tracking-widest text-purple-300/70">{section.group}</span>
                  {section.keys.map(([k, desc]) => (
                    <div key={k} className="flex items-baseline justify-between gap-3">
                      <kbd className="text-xs font-bold tabular-nums text-zinc-200 bg-white/5 border border-white/10 rounded px-1.5 py-0.5 shrink-0">{k}</kbd>
                      <span className="text-xs font-bold tabular-nums text-zinc-500 text-right">{desc}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Per-clip gain popover. Same portal/anchor pattern as Time / Pitch. */}
      {gainPanel && (() => {
        const clip = clips.find((c) => c.id === gainPanel.clipId);
        if (!clip) return null;
        return (
          <PopoverPortal
            x={gainPanel.x}
            y={gainPanel.y}
            innerRef={gainPanelRef}
            className="fixed z-50 w-72 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400 truncate">
                Clip gain — <span style={{ color: clip.color }}>{clip.label}</span>
              </span>
              <button
                onClick={() => setGainPanel(null)}
                aria-label="Close clip gain panel"
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <ClipGainControls
              gain={clipPeakGain(clip)}
              onChange={(g) => updateClip(clip.id, { gain: g })}
            />
          </PopoverPortal>
        );
      })()}

      {clipNamePanel && (() => {
        const clip = clips.find((c) => c.id === clipNamePanel.clipId);
        if (!clip) return null;
        // The whole selection takes the colour when the clip is part of it (the way a colour set
        // on one selected item applies to all of them in REAPER); the name is this clip's alone.
        const targets = selectedClipIds.includes(clip.id) && selectedClipIds.length > 1 ? selectedClipIds : [clip.id];
        const trackColor = tracks.find((t) => t.id === clip.trackId)?.color ?? clip.color;
        const paint = (color: string) => {
          beginUndoStep();
          targets.forEach((id) => updateClip(id, { color }, { coalesce: true }));
        };
        return (
          <PopoverPortal
            x={clipNamePanel.x}
            y={clipNamePanel.y}
            innerRef={clipNamePanelRef}
            className="fixed z-50 w-72 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
          >
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const next = String(new FormData(e.currentTarget).get('clip-name') ?? '').trim();
                if (next && next !== clip.label) {
                  beginUndoStep();
                  updateClip(clip.id, { label: next });
                }
                setClipNamePanel(null);
              }}
            >
              <label htmlFor="editor-clip-name" className="text-xs font-bold uppercase tracking-wider text-zinc-400">Clip name</label>
              <input
                id="editor-clip-name"
                name="clip-name"
                type="text"
                defaultValue={clip.label}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded border border-white/10 bg-black/40 px-2 py-1 font-sans text-xs text-zinc-100 focus:border-purple-400/60 focus:outline-hidden"
              />
              <div className="flex items-center gap-2">
                <label htmlFor="editor-clip-color" className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                  Colour{targets.length > 1 ? ` (${targets.length} clips)` : ''}
                </label>
                <input
                  id="editor-clip-color"
                  name="clip-color"
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(clip.color) ? clip.color : '#a855f7'}
                  onChange={(e) => paint(e.target.value)}
                  className="h-6 w-10 cursor-pointer rounded border border-white/10 bg-transparent p-0"
                />
                <button
                  type="button"
                  onClick={() => paint(trackColor)}
                  className="rounded border border-white/10 px-2 py-1 font-display text-xs font-bold uppercase tracking-wider text-zinc-400 hover:bg-white/5 hover:text-white"
                  title="Use the track's colour again"
                >
                  Track colour
                </button>
                <button
                  type="submit"
                  className="ml-auto rounded border border-purple-500/40 bg-purple-500/15 px-2 py-1 font-display text-xs font-bold uppercase tracking-wider text-purple-200 hover:bg-purple-500/25"
                >
                  Done
                </button>
              </div>
            </form>
          </PopoverPortal>
        );
      })()}

      {/* "Use song tempo": what a song's rhythm analysis would make the
          arrangement's tempo and meter, applied on a press as one undo step. */}
      {songTempoRequest && (
        <SongTempoDialog
          key={`${songTempoRequest.entryId}:${songTempoRequest.clipId ?? ''}`}
          request={songTempoRequest}
          onClose={() => useEditorStore.getState().dismissSongTempoRequest()}
        />
      )}

      {/* A clip from the roll or a MIDI file whose tempo or meter differs from
          the arrangement's: offered once, adopted or kept with one press. */}
      {timeMapOffer && (
        <div
          role="region"
          aria-label="Clip tempo and meter offer"
          className="shrink-0 flex flex-wrap items-center gap-2 border-b border-purple-500/30 bg-purple-500/10 px-3 py-1.5"
        >
          <span className="text-xs font-bold text-purple-100">
            {`"${timeMapOffer.label}" is in ${timeMapOffer.summary}. Use its tempo and meter for the arrangement from ${formatTimecode(timeMapOffer.anchorSec)}?`}
          </span>
          <button
            type="button"
            onClick={() => {
              const res = useEditorStore.getState().adoptClipTimeMaps(timeMapOffer.clipId);
              if (!res.ok) logError('editor', `Could not take the clip's tempo and meter: ${res.error}`);
            }}
            className="rounded border border-purple-400/50 bg-purple-500/25 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-purple-100 hover:bg-purple-500/40"
          >
            Use its tempo and meter
          </button>
          <button
            type="button"
            onClick={() => useEditorStore.getState().dismissTimeMapOffer()}
            className="rounded border border-white/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-zinc-300 hover:bg-white/10"
          >
            Keep the arrangement's
          </button>
        </div>
      )}

      {/* The MIDI render queue (state/midiRenderQueue): which clip is rendering
          and how many wait. Mounted always, so the status is announced. */}
      <div
        role="status"
        aria-live="polite"
        aria-label="MIDI render queue"
        className={midiQueue.running ? 'shrink-0 flex flex-wrap items-center gap-2 border-b border-sky-500/30 bg-sky-500/10 px-3 py-1' : 'sr-only'}
      >
        {midiQueue.running && (
          <>
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
            <span className="text-xs font-bold text-sky-100">
              {midiRenderStatusText(midiQueue.running, midiQueue.waiting.length)}
            </span>
          </>
        )}
      </div>
      {midiQueue.lastError && !midiQueue.running && (
        <div role="alert" className="shrink-0 flex flex-wrap items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1">
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-red-400" />
          <span className="text-xs font-bold text-red-100">{`MIDI render failed: ${midiQueue.lastError}`}</span>
          <button
            type="button"
            onClick={() => useMidiRenderQueue.setState({ lastError: null })}
            className="rounded border border-white/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-zinc-300 hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Body: track headers + scrollable timeline */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Track headers (sticky, not scrolled) */}
        <div ref={trackHeaderColRef} className="shrink-0 bg-[#0c0a12] border-r border-[#1a1528] overflow-hidden flex flex-col" style={{ width: TRACK_HEADER_PX }}>
          {/* Ruler row spacer, as tall as the ruler. It holds the Meter and
              tempo panel's button, level with the ruler's meter and tempo rows. */}
          <div className="h-17 border-b border-white/5 bg-black/30 flex flex-col items-stretch justify-center gap-1 px-2">
            <button
              type="button"
              onClick={(e) => (timeMapPanel ? closeTimeMapPanel() : openTimeMapPanel(e.currentTarget, null))}
              aria-haspopup="dialog"
              aria-expanded={timeMapPanel !== null}
              aria-controls={timeMapPanel ? timeMapPanelId : undefined}
              title="The arrangement's time signatures and tempo changes: add, edit and remove them, or take them from a MIDI clip"
              className="rounded border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-purple-200 hover:bg-purple-500/20"
            >
              Meter · Tempo
            </button>
            <span className="text-center text-xs font-bold text-zinc-500 tabular-nums" title="Bar 1's meter and the start tempo">
              {`${arrangementMeterMap[0] ? `${arrangementMeterMap[0].meter.num}/${arrangementMeterMap[0].meter.den}` : '4/4'} · ${Math.round(projectBpm * 100) / 100} BPM`}
            </span>
          </div>
          {/* One live region for the whole column — the count-in belongs to the
              pass, not to a track. See CountInAnnouncement. */}
          <CountInAnnouncement />
          <div ref={trackHeaderScrollRef} className="flex-1 overflow-hidden">
            {/* `relative` so the reorder insertion line can be placed in the
                gap it would drop into; the rows themselves stay in flow. */}
            <div className="relative">
            {tracks.map((t) => (
              <div
                key={t.id}
                onPointerDown={(e) => handleTrackHeaderPointerDown(e, t.id)}
                onContextMenu={(e) => { selectTrackSingle(t.id); warmAddMenuCounts(); trackMenu.open(e, { trackId: t.id }); }}
                /* overflow-hidden: shrinking the lane height (vertical zoom) clips the
                   header's controls rather than letting them spill into the next track. */
                className={`border-b border-[#1a1528] p-2 flex flex-col gap-1.5 overflow-hidden transition-colors ${selectedTrackIds.includes(t.id) ? 'bg-purple-500/10 ring-1 ring-inset ring-purple-500/35' : ''} ${reorderMovingSet.has(t.id) ? 'opacity-40' : ''}`}
                style={{ height: trackH }}
                title="Click to select track. Ctrl/Cmd-click to multi-select tracks. Right-click to add audio or MIDI to it, or for track FX."
              >
                <div className="flex justify-between items-center gap-1">
                  {/* Reorder grip (F01). A drag handle, not a selector: the press
                      stops here so the row's select handler never runs. Alt+Arrow
                      moves the track when it has focus, which is the whole
                      keyboard path — no pointer needed. */}
                  <button
                    type="button"
                    data-track-grip={t.id}
                    aria-label={`Reorder track ${t.name}`}
                    aria-roledescription="drag handle"
                    title="Drag to reorder · Alt+↑/↓ to move"
                    onPointerDown={(e) => onGripPointerDown(e, t.id)}
                    onPointerMove={onGripPointerMove}
                    onPointerUp={onGripPointerUp}
                    onPointerCancel={onGripPointerCancel}
                    onLostPointerCapture={onGripPointerCancel}
                    onKeyDown={(e) => onGripKeyDown(e, t.id)}
                    onClick={(e) => e.stopPropagation()}
                    className={`h-4 w-1.5 shrink-0 rounded-xs border border-white/5 transition-colors focus:outline-hidden focus-visible:ring-1 focus-visible:ring-purple-400 ${
                      reorderMovingSet.has(t.id)
                        ? 'bg-purple-400 cursor-grabbing'
                        : 'bg-white/15 hover:bg-purple-400/70 cursor-grab'
                    }`}
                  />
                  <label htmlFor={`editor-track-name-${t.id}`} className="sr-only">{`Track ${t.name} name`}</label>
                  <input
                    id={`editor-track-name-${t.id}`}
                    name={`editor-track-name-${t.id}`}
                    aria-label={`Track ${t.name} name`}
                    type="text"
                    value={t.name}
                    onChange={(e) => updateTrack(t.id, { name: e.target.value, nameAutoGenerated: false })}
                    className="bg-transparent border-none outline-none font-sans text-xs font-bold w-full hover:bg-white/5 px-1 -mx-1 rounded transition-colors min-w-0"
                    style={{ color: t.color }}
                  />
                  <div className="flex gap-1 shrink-0">
                    <TrackArmButton
                      trackName={t.name}
                      armed={!!t.armed}
                      onToggle={() => updateTrack(t.id, { armed: !t.armed })}
                    />
                    <button
                      onClick={() => updateTrack(t.id, { mute: !t.mute })}
                      aria-label={`Mute track ${t.name}`}
                      aria-pressed={t.mute}
                      className={`w-4 h-4 rounded font-display text-xs font-bold leading-none flex items-center justify-center ${t.mute ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                    >M</button>
                    <button
                      onClick={() => toggleSolo(t.id)}
                      aria-label={`Solo track ${t.name}`}
                      aria-pressed={t.solo}
                      className={`w-4 h-4 rounded font-display text-xs font-bold leading-none flex items-center justify-center ${t.solo ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                    >S</button>
                    <button
                      onClick={(e) => toggleFxRack(fxRackUnder(t.id, e.currentTarget))}
                      aria-label={`Track ${t.name} insert FX`}
                      aria-pressed={fxPanel?.trackId === t.id}
                      title="Track insert FX rack"
                      // Rack open: a solid fill. Inserts on the lane with the rack
                      // closed: a light tint, so a lane restored with its effects by
                      // undo never looks like its rack is open.
                      className={`w-4 h-4 rounded font-display text-xs font-bold leading-none flex items-center justify-center border ${
                        fxPanel?.trackId === t.id
                          ? 'bg-purple-500 text-white border-purple-200 shadow-[0_0_6px_rgba(168,85,247,0.7)]'
                          : (t.fxChain?.length ?? 0) > 0
                            ? 'bg-purple-500/15 text-purple-300 border-purple-500/40 hover:text-white'
                            : 'bg-black/40 text-zinc-500 border-white/5 hover:text-white'
                      }`}
                    >F</button>
                    {(t.frozenOriginal || t.instrument?.vst || (t.fxChain ?? []).some((e) => e.effect === 'vst3' && e.vst)) && (
                      <TrackFreezeButton
                        trackId={t.id}
                        trackName={t.name}
                        frozen={!!t.frozenOriginal}
                        onFreeze={freezeTrackAction}
                        onUnfreeze={unfreezeTrackAction}
                      />
                    )}
                    <button
                      onClick={() => removeTrack(t.id)}
                      aria-label={`Remove track ${t.name}`}
                      className="w-4 h-4 rounded font-sans text-xs font-bold leading-none flex items-center justify-center bg-black/40 text-zinc-500 border border-white/5 hover:text-red-400"
                      title="Remove track"
                    >×</button>
                  </div>
                </div>
                {/* The take meter, under the arm dot. Renders nothing unless a
                    pass is live, so an armed track costs an idle project one
                    mounted component and no DOM. */}
                {t.armed && <TrackInputMeter trackId={t.id} trackName={t.name} />}
                <div className="flex items-center gap-1.5">
                  <Volume2 className="w-2.5 h-2.5 text-zinc-600 shrink-0" />
                  {/* defaultValue is what double-click resets to; SlideTrack falls
                      back to `defaultValue ?? 0`, so omitting it made double-click
                      SILENCE the track instead of returning it to unity. 0.8 is the
                      track default in editorStore. ariaLabel carries the track name
                      so the faders are distinguishable to a screen reader. */}
                  <NativeFader label={`${t.name} volume`} min={0} max={1} step={0.01} defaultValue={0.8}
                    {...faderDisplay('trackVolume', t.id, t.volume)}
                    onChange={(v) => writeFader('trackVolume', t.id, v)}
                    onGestureStart={() => armAutomation(faderTarget('trackVolume', t.id))}
                    onGestureEnd={() => endAutomation(faderTarget('trackVolume', t.id))} />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="font-sans text-xs font-bold text-zinc-500 uppercase w-3">P</span>
                  <NativeFader label={`${t.name} pan`} min={-1} max={1} step={0.01} defaultValue={0}
                    {...faderDisplay('trackPan', t.id, t.pan)}
                    onChange={(v) => writeFader('trackPan', t.id, v)}
                    onGestureStart={() => armAutomation(faderTarget('trackPan', t.id))}
                    onGestureEnd={() => endAutomation(faderTarget('trackPan', t.id))} />
                  <span className="font-sans text-xs font-bold text-zinc-500 text-right w-8 shrink-0 tabular-nums">
                    {t.pan > 0 ? `R${Math.round(t.pan * 100)}` : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : 'C'}
                  </span>
                </div>
                {/* A MIDI track, or one a template gave an instrument before any clip is on it. */}
                {(clips.some((c) => c.trackId === t.id && isMidiClip(c)) || t.instrumentProgram !== undefined || t.synthReverbSend !== undefined) && (
                  <TrackInstrumentSelect track={t} status={liveMidiStatus.get(t.id)} />
                )}
                {!t.frozenOriginal && (clips.some((c) => c.trackId === t.id && isMidiClip(c)) || t.instrumentProgram !== undefined) && (
                  <TrackVstInstrument
                    track={t}
                    plugins={vstPlugins}
                    scanning={vstScanning}
                    onRescan={() => void scanVst(true)}
                    onOpenEditor={(entry) => openVstEditor(entry, (_entryId, raw) => setTrackInstrumentRawState(t.id, raw))}
                  />
                )}
              </div>
            ))}
            {/* Where the drop lands. Drawn in the gap between two header rows,
                and mirrored across the lanes by the twin below. */}
            {reorderDraw && (
              <div
                aria-hidden="true"
                className="absolute left-0 right-0 h-0.5 bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.9)] pointer-events-none z-30"
                style={{ top: reorderDraw.insertIndex * trackH - 1 }}
              />
            )}
            </div>
            {/* Add-track affordance sits directly below the lowest (newest) track. */}
            <button
              onClick={() => addTrack()}
              aria-label="Add track"
              title="Add a new empty track"
              className="w-full h-7 flex items-center justify-center text-zinc-500 hover:text-purple-300 hover:bg-purple-500/10 border-b border-[#1a1528] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            {/* The track templates (a template adds its tracks after the last
                one), then the files the app saved or downloaded: a chosen one
                lands at the playhead, on the selected track or a new one. Each
                file list renders nothing until it has a file. */}
            <div className="flex flex-col gap-1 p-1">
              <TrackTemplatePicker idBase={`editor-${addInputUid}`} />
              <KnownFilesMenu
                id={`editor-recent-audio-${addInputUid}`}
                exts={AUDIO_ACCEPT.split(',')}
                label="Recent audio"
                onFiles={(files) => void onAddAudioFiles(files, recentAddTarget())}
                className="w-full"
              />
              <KnownFilesMenu
                id={`editor-recent-midi-${addInputUid}`}
                exts={MIDI_ACCEPT.split(',')}
                label="Recent MIDI"
                onFiles={(files) => void onAddMidiFiles(files, recentAddTarget())}
                className="w-full"
              />
            </div>
          </div>
        </div>

        {/* Scrollable timeline area */}
        <div
          ref={setTimelineScroller}
          className="flex-1 min-w-0 overflow-x-auto overflow-y-auto bg-[#07050a]"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onScroll={handleTimelineScroll}
        >
          {/* Ruler — click to seek, drag to select a time range, shift-drag for
              the loop. Sticky so vertical scroll keeps it pinned. */}
          <div
            className="h-17 border-b border-white/5 bg-black/80 backdrop-blur-sm sticky top-0 z-40 select-none cursor-col-resize"
            style={{ width: timelineWidthPx }}
            onMouseDown={onRulerMouseDown}
            onPointerDown={onRulerPointerDown}
            onLostPointerCapture={onRulerPointerCancel}
            onPointerMove={onRulerPointerMove}
            onPointerUp={onRulerPointerUp}
            onPointerCancel={onRulerPointerCancel}
          >
            {/* Time row (bottom): timecodes in bold 12 px sans, once they are
                RULER_TIME_LABEL_MIN_PX apart. A timecode the range readout
                would cover keeps its tick line only. */}
            {renderRuler.map((tick) => {
              const text = formatTimecode(tick.sec).replace(/\.00$/, '');
              return (
                <div
                  key={tick.sec}
                  className="absolute top-12 bottom-0 px-1 border-l border-white/5 pointer-events-none"
                  style={{ left: tick.sec * zoom }}
                >
                  {!(rangeReadoutSpan && timeLabelUnderReadout(tick, text, zoom, rangeReadoutSpan)) && (
                    <span className={`block font-sans text-xs font-bold leading-none tabular-nums ${tick.major ? 'text-zinc-300' : 'text-zinc-500'}`}>
                      {text}
                    </span>
                  )}
                </div>
              );
            })}
            {/* Bar row: bar numbers (F05) at bar lines of the arrangement's meter
                map, once bars are RULER_BAR_LABEL_MIN_PX apart; a bar that starts
                a new meter shows it as a button that opens the Meter and tempo
                panel. */}
            {barLabels.map((b) => (meterFlagBars.has(b.bar) ? null : (
              <div
                key={`bar-${b.bar}`}
                aria-hidden="true"
                className="absolute top-4 h-4 border-l border-purple-300/40 pointer-events-none"
                style={{ left: b.sec * zoom }}
              >
                <span className="absolute top-0 left-0.5 font-sans text-xs font-bold leading-4 tabular-nums text-purple-300">{b.bar}</span>
              </div>
            )))}
            {meterFlags.map((f) => (
              <div
                key={`meter-${f.bar}`}
                data-ruler-control="1"
                className="absolute top-4 h-4 z-30 border-l border-purple-300/70"
                style={{ left: f.sec * zoom }}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={(e) => openTimeMapPanel(e.currentTarget, { kind: 'meter', bar: f.bar })}
                  aria-haspopup="dialog"
                  aria-label={`Bar ${f.bar + 1}: ${f.label}. Edit the meter`}
                  title={`Bar ${f.bar + 1} is in ${f.label}. Click to edit the meter map`}
                  className="absolute top-0 left-0 h-4 whitespace-nowrap rounded-br bg-purple-500/25 px-1 text-xs font-bold leading-4 text-purple-100 hover:bg-purple-500/40 tabular-nums"
                >
                  {`${f.bar + 1} · ${f.label}`}
                </button>
              </div>
            ))}
            {/* Tempo row: every tempo change, ramp and fermata, as buttons that
                open the Meter and tempo panel on their own row. */}
            {tempoFlags.map((f) => (
              <div
                key={`tempo-${f.kind}-${f.beat}`}
                data-ruler-control="1"
                className="absolute top-8 h-4 z-30 border-l border-amber-300/70"
                style={{ left: f.sec * zoom }}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={(e) => openTimeMapPanel(e.currentTarget, { kind: 'tempo', beat: f.beat, eventKind: f.kind })}
                  aria-haspopup="dialog"
                  aria-label={`${f.label} at ${formatTimecode(f.sec)}. Edit the tempo map`}
                  title={`${f.label} at ${formatTimecode(f.sec)}. Click to edit the tempo map`}
                  className={`absolute top-0 left-0 h-4 whitespace-nowrap rounded-br px-1 text-xs font-bold leading-4 tabular-nums ${f.kind === 'fermata' ? 'bg-sky-500/20 text-sky-100 hover:bg-sky-500/35' : 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/35'}`}
                >
                  {f.label}
                </button>
              </div>
            ))}
            {/* Loop region (shift-drag the ruler to set; LOOP toggles it) */}
            {loopEnd > loopStart && (
              <div
                className={`absolute top-0 bottom-0 z-10 pointer-events-none ${loopEnabled ? 'bg-amber-400/25 border-x border-amber-400/70' : 'bg-white/5 border-x border-white/25'}`}
                style={{ left: loopStart * zoom, width: (loopEnd - loopStart) * zoom }}
              />
            )}
            {/* Time range on the ruler (F03): the stronger band, with its
                start – end · duration readout on an opaque pill in the time row
                (the timecodes it would cover are hidden above). A picture of
                state: no pointer. */}
            {timeSelection && (
              <div
                aria-hidden="true"
                className="absolute top-0 bottom-0 z-10 pointer-events-none bg-sky-400/30 border-x border-sky-300"
                style={{ left: timeSelection.startSec * zoom, width: (timeSelection.endSec - timeSelection.startSec) * zoom }}
              >
                <span className="absolute top-12 left-1 px-1 rounded-sm bg-sky-900 font-sans text-xs font-bold text-sky-100 leading-none whitespace-nowrap tabular-nums">
                  {rangeReadout}
                </span>
              </div>
            )}
            {/* Edit cursor on the ruler (F06): an OUTLINED upward triangle,
                where the playhead is a filled downward one. */}
            <div
              role="img"
              aria-label={`Edit cursor at ${formatCursorTime(editCursorSec)}`}
              className="absolute bottom-0 z-20 w-3 h-2 -translate-x-1/2 pointer-events-none"
              style={{ left: editCursorSec * zoom }}
            >
              <svg viewBox="0 0 12 8" className="w-full h-full overflow-visible" aria-hidden="true">
                <polygon points="6,0.75 11.25,7.25 0.75,7.25" fill="none" stroke="#7dd3fc" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </div>
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
            {/* Playhead in ruler: line + draggable triangle handle (position is
                driven imperatively during playback — see the playhead effect) */}
            <div
              ref={rulerLineRef}
              className="absolute top-0 bottom-0 w-px bg-red-500/60 pointer-events-none z-20"
              style={{ left: playheadSec * zoom }}
            />
            <div
              ref={rulerHandleRef}
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
            /* tabIndex -1: never in the Tab order, but focusable from script so
               a menu item that opens an OS dialog can hand focus back here
               instead of stranding it on <body> when the dialog is cancelled. */
            tabIndex={-1}
            className={`relative outline-none ${tool === 'cut' ? 'cursor-crosshair' : 'cursor-default'}`}
            style={{ width: timelineWidthPx, height: lanesHeightPx }}
            onPointerDown={onLanesPointerDown}
            onLostPointerCapture={onLanesPointerCancel}
            onPointerMove={onLanesPointerMove}
            onPointerUp={onLanesPointerUp}
            onPointerCancel={onLanesPointerCancel}
            onContextMenu={onLanesContextMenu}
            onDragOver={onTimelineDragOver}
            onDragLeave={onTimelineDragLeave}
            onDrop={onTimelineDrop}
          >
            {/* Bar / beat / sub grid (F05), windowed to the visible range +-1
                viewport; behind everything, never takes the pointer. */}
            {gridWindow && (
              <TimelineGridLayer
                startSec={gridWindow.startSec}
                endSec={gridWindow.endSec}
                zoom={zoom}
                bpm={projectBpm}
                tempoMap={arrangementTempoMap}
                meterMap={arrangementMeterMap}
                heightPx={lanesHeightPx}
                style={gridStyle}
                themeKey={editThemeId}
              />
            )}
            {tracks.map((track, ti) => (
              <div
                key={track.id}
                className="absolute left-0 right-0 border-b"
                style={{ top: ti * trackH, height: trackH, borderBottomColor: `rgb(var(--et-line, 255 255 255) / ${gridStyle.laneDividerOpacity})` }}
              />
            ))}

            {/* Reorder drop target (F01), the same gap the header column draws,
                carried across the lanes so the eye does not have to travel back
                to the header column to see where the track will land. */}
            {reorderDraw && (
              <div
                aria-hidden="true"
                className="absolute left-0 right-0 h-0.5 bg-purple-400/80 pointer-events-none z-30"
                style={{ top: reorderDraw.insertIndex * trackH - 1 }}
              />
            )}

            {/* Time range down the lanes (F03): above the lane grid, under the
                clips' interactive layers, no pointer. All-tracks by default;
                a track-scoped range shades only its own lanes. */}
            {timeSelection && (timeSelection.scope.kind === 'all-tracks' ? (
              <div
                aria-hidden="true"
                className="absolute top-0 bottom-0 pointer-events-none bg-sky-400/10 border-x border-sky-300/50"
                style={{ left: timeSelection.startSec * zoom, width: (timeSelection.endSec - timeSelection.startSec) * zoom }}
              />
            ) : tracks.map((t, ti) => (timeSelection.scope.kind === 'tracks' && timeSelection.scope.ids.includes(t.id) ? (
              <div
                key={`range-${t.id}`}
                aria-hidden="true"
                className="absolute pointer-events-none bg-sky-400/10 border-x border-sky-300/50"
                style={{ left: timeSelection.startSec * zoom, width: (timeSelection.endSec - timeSelection.startSec) * zoom, top: ti * trackH, height: trackH }}
              />
            ) : null)))}

            {/* Clips */}
            {clips.map((clip) => {
              const trackIdx = tracks.findIndex((t) => t.id === clip.trackId);
              if (trackIdx < 0) return null;
              const left = clip.startSec * zoom;
              const width = clip.durationSec * zoom;
              const top = trackIdx * trackH + 6;
              const height = trackH - 12;
              const selected = selectedClipIdSet.has(clip.id) || clip.id === selectedClipId;
              const isMidi = isMidiClip(clip);
              // Compact BPM/key readout: MIDI clips carry their render BPM; audio
              // clips resolve through the DJ analysis cache. Hidden entirely on
              // narrow clips or when neither value is known.
              let bpmText: string | null = null;
              let keyText: string | null = null;
              if (clip.sourceKind === 'piano-roll') {
                // A clip whose tempo changes reads as its slowest to fastest tempo.
                const span = clip.sourceBpm ? tempoSpan(clip.sourceBpm, clip.sourceTempoMap) : null;
                if (span) bpmText = span[0] === span[1] ? String(span[0]) : `${span[0]}-${span[1]}`;
              } else {
                // What SYNC reads (lib/beatMatchRun clipKnownBpm): a beat match's
                // tempo, else the song's through the stretch its audio holds. The
                // key is the song's: a stem's is the song it was separated from.
                const known = clipKnownBpm(clip);
                if (known) bpmText = String(Math.round(known));
                const keyEntry = clip.songTime?.entryId ?? clip.libraryEntryId;
                const d = keyEntry ? djAnalysisById[keyEntry]?.data : undefined;
                if (d?.key) keyText = `${d.key}${(d.scale ?? '').toLowerCase().startsWith('min') ? 'm' : ''}`;
              }
              /* F09 — the header rides the VISIBLE part of the clip, so a long
                 clip scrolled past its own start still shows its title and
                 controls, and the 6-px resize zones stay clear. Before the
                 first viewport measurement the clip is treated as fully
                 visible, which is what it was on the previous render. */
              const chrome = viewport.width > 0
                ? clipChromeLayout(left, width, viewport.scrollLeft, viewport.width)
                : clipChromeLayout(left, width, left, Math.max(1, width));
              const bpmKeyReadout =
                chrome && chrome.width >= 120 && (bpmText || keyText) ? [bpmText, keyText].filter(Boolean).join(' . ') : null;
              return (
                <div
                  key={clip.id}
                  data-clip="1"
                  data-clip-id={clip.id}
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
                  {/* Header strip: the bar itself spans the clip (decoration),
                      its contents ride the visible part. */}
                  <div className="absolute top-0 left-0 right-0 h-3.5 bg-black/50 backdrop-blur-sm border-b border-white/10 pointer-events-none" />
                  {chrome && chrome.tier !== 'handle' && (
                    <div
                      className="absolute top-0 h-3.5 flex justify-between items-center gap-1 font-sans text-xs font-bold leading-none"
                      style={{ left: chrome.leftInClip, width: chrome.width }}
                    >
                      <span className={`flex items-center gap-1 min-w-0 ${chrome.tier === 'full' ? 'max-w-3/5' : 'flex-1'}`}>
                        {clip.sourceKind === 'piano-roll' && (
                          <Piano className="w-2.5 h-2.5 text-emerald-300 shrink-0" />
                        )}
                        <span className="text-white truncate" title={clip.label}>{clip.label}</span>
                      </span>
                      {chrome.tier === 'full' ? (
                        <span className="flex items-center gap-1 shrink-0">
                          {bpmKeyReadout && (
                            <span className="text-zinc-400 normal-case tabular-nums">{bpmKeyReadout}</span>
                          )}
                          {/* Header buttons stop pointerdown so they never start a
                              clip drag, and stop click so they never re-select. */}
                          <button
                            type="button"
                            onPointerDown={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              openFxRack(fxRackUnder(clip.trackId, e.currentTarget));
                            }}
                            aria-label={`Open track FX for clip ${clip.label}`}
                            className="px-1 h-3.5 rounded-sm font-display text-xs font-bold leading-none flex items-center bg-black/40 text-zinc-300 border border-white/10 hover:text-purple-300 hover:border-purple-500/50"
                          >FX</button>
                          <button
                            type="button"
                            onPointerDown={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              updateClip(clip.id, { muted: !clip.muted });
                            }}
                            aria-label={`Mute clip ${clip.label}`}
                            aria-pressed={!!clip.muted}
                            className={`px-1 h-3.5 rounded-sm font-display text-xs font-bold leading-none flex items-center ${clip.muted ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-black/40 text-zinc-300 border border-white/10 hover:text-white'}`}
                          >M</button>
                          {isMidi && (() => {
                            // The clip's audio as a cache (lib/midiRender): a dot and one word.
                            // `live` is how the clip plays when heard, so a muted
                            // part reads as it will sound unmuted; the M key beside
                            // it says it is muted, and the title does too.
                            const info = midiRenderInfo.byId.get(clip.id);
                            if (!info) return null;
                            const queued = midiQueue.running?.clipId === clip.id || midiQueue.waiting.some((w) => w.clipId === clip.id);
                            const word = queued ? 'Rendering' : info.state === 'none' ? (info.live ? 'Live' : 'Silent') : info.state === 'stale' ? 'Stale' : info.live ? 'Kept' : 'Audio';
                            const dot = queued ? 'bg-sky-400' : info.state === 'none' ? (info.live ? 'bg-emerald-400' : 'bg-red-400') : info.state === 'stale' ? 'bg-amber-400' : 'bg-zinc-300';
                            const said = queued ? 'Rendering its audio now' : midiRenderStateText(info.state, info.live, info.auto);
                            return (
                              <span
                                className="flex items-center gap-1 text-xs font-bold text-zinc-300"
                                title={clip.muted ? `Muted. When heard: ${said.charAt(0).toLowerCase()}${said.slice(1)}` : said}
                              >
                                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                                {word}
                              </span>
                            );
                          })()}
                          {clipStretchRate(clip) !== 1 && (
                            <span
                              className="text-amber-300 tabular-nums"
                              title={`Stretched to ${clipStretchRate(clip).toFixed(2)}x — the audio is untouched. Reset it from the clip menu.`}
                            >
                              {clipStretchRate(clip).toFixed(2)}x
                            </span>
                          )}
                          <span className="text-zinc-300 tabular-nums">{clip.durationSec.toFixed(2)}s</span>
                        </span>
                      ) : (
                        /* Compact: no room for the readouts — one key to the
                           clip's own menu, which holds all of them. */
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            openClipMenuFrom(e.currentTarget, clip.id);
                          }}
                          aria-label={`More actions for clip ${clip.label}`}
                          aria-haspopup="menu"
                          aria-expanded={clipMenuOpenFor(clip.id)}
                          title={`${clip.label} — clip actions`}
                          className="px-0.5 h-3.5 rounded-sm shrink-0 flex items-center bg-black/40 text-zinc-300 border border-white/10 hover:text-white"
                        ><Ellipsis className="w-2.5 h-2.5" /></button>
                      )}
                    </div>
                  )}
                  {/* Handle: too narrow for a title — a grip that carries the
                      name and opens the clip menu. */}
                  {chrome && chrome.tier === 'handle' && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        openClipMenuFrom(e.currentTarget, clip.id);
                      }}
                      aria-label={`${clip.label} — clip actions`}
                      aria-haspopup="menu"
                      aria-expanded={clipMenuOpenFor(clip.id)}
                      title={clip.label}
                      className="absolute top-0 h-3.5 w-1.5 rounded-sm bg-white/25 hover:bg-white/60"
                      style={{ left: chrome.leftInClip }}
                    />
                  )}
                  {/* Body: MIDI clips show their notes (FL-style); audio clips show
                      peaks. A muted clip's body is dimmed (the red M is the flag). */}
                  {isMidi ? (
                    <div className={clip.muted ? 'opacity-30' : ''}>
                      <MidiClipNotes
                        clip={clip}
                        zoom={zoom}
                        selected={selected}
                        height={Math.max(8, height - 14)}
                        // The part of the clip in the timeline's view (clip px); all of it before the first measurement.
                        visibleFromPx={viewport.width > 0 ? viewport.scrollLeft - left : 0}
                        visibleToPx={viewport.width > 0 ? viewport.scrollLeft + viewport.width - left : width}
                        // The scroller clips the bodies, so its view (and margin) decides which tracks draw their notes.
                        scrollRoot={scrollerEl}
                      />
                    </div>
                  ) : (
                    <div className={`absolute inset-x-0 bottom-0 top-3.5 ${clip.muted ? 'opacity-30' : ''}`}>
                      <ClipWave clip={clip} height={Math.max(8, height - 14)} selected={selected} />
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
                      onPointerCancel={handleInpaintDragEnd}
                      onLostPointerCapture={handleInpaintDragEnd}
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
                      <span className="absolute top-0.5 left-1 text-xs font-bold tabular-nums text-purple-300 pointer-events-none leading-none">
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

            {/* Crossfade X: where two clips on a track overlap, one is on its
                way out and the other on its way in. The two strokes are those
                two gains, so the crossing point is where they meet. Derived
                from the clip positions (lib/crossfade), never stored, so it
                follows a clip the moment it is dragged. Decoration over the
                clips, so it takes no pointer and no name. */}
            {crossfadeOverlaps.map(({ key, trackIdx, region }) => (
              <svg
                key={key}
                aria-hidden="true"
                className="absolute z-20 pointer-events-none"
                style={{
                  left: region.startSec * zoom,
                  width: Math.max(1, region.durationSec * zoom),
                  top: trackIdx * trackH + 6,
                  height: Math.max(1, trackH - 12),
                }}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <rect x="0" y="0" width="100" height="100" fill="rgba(255,255,255,0.07)" />
                <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(255,255,255,0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <line x1="0" y1="0" x2="100" y2="100" stroke="rgba(255,255,255,0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              </svg>
            ))}

            {/* Automation lanes: read-only curve per track (volume green, pan blue, FX
                amber), or editable when automation edit mode targets that lane. */}
            {automationLanes.map((lane) => {
              const tk = lane.target.kind;
              if (tk !== 'trackVolume' && tk !== 'trackPan' && tk !== 'trackFx' && tk !== 'trackMidiCc') return null;
              // Outside automation edit mode the volume line draws and edits a
              // track's volume lane (TrackVolumeLines, below).
              if (tk === 'trackVolume' && showVolumeLine && !automationEdit) return null;
              const editable = automationEdit && lane.id === activeLaneId;
              if (lane.points.length === 0 && !editable) return null;
              const trackIdx = tracks.findIndex((t) => t.id === lane.target.trackId);
              if (trackIdx < 0) return null;
              const vis = laneVisual(lane);
              if (!vis) return null;
              // A volume lane is drawn in the band the volume line uses, so its
              // curve sits at the same height in both modes.
              const band = tk === 'trackVolume' ? volumeBand(trackH) : { top: 0, height: trackH };
              return (
                /* An editable lane owns its own wheel (curve nudges); display
                   contents keeps the lane's own absolute layout. */
                <div key={lane.id} className="contents" data-wheel-passthrough={editable ? '' : undefined}>
                  <AutomationLane
                    lane={lane}
                    zoom={zoom}
                    width={timelineWidthPx}
                    height={band.height}
                    top={trackIdx * trackH + band.top}
                    color={vis.color}
                    toNorm={vis.toNorm}
                    fromNorm={vis.fromNorm}
                    editable={editable}
                  />
                </div>
              );
            })}

            {/* The volume line: each track's volume drawn over its lane. A bare
                line is the track fader, so its drag takes the header fader's own
                path; a keyframed one is the track's volume lane. Only the line
                and its keyframes take the pointer. Automation edit mode draws
                volume lanes with the lane editor above, and the cut tool leaves
                the lines inert so a cut never moves one. */}
            {showVolumeLine && !automationEdit && (
              <TrackVolumeLines
                tracks={tracks}
                lanes={automationLanes}
                zoom={zoom}
                trackHeight={trackH}
                width={timelineWidthPx}
                fromSec={viewport.width > 0 ? viewport.scrollLeft / zoom : 0}
                toSec={viewport.width > 0 ? (viewport.scrollLeft + viewport.width) / zoom : timelineWidthPx / zoom}
                interactive={tool !== 'cut'}
                snap={snapSec}
                timeStep={nudgeStepSec}
                onFaderChange={(trackId, v) => writeFader('trackVolume', trackId, v)}
                onFaderGestureStart={(trackId) => armAutomation(faderTarget('trackVolume', trackId))}
                onFaderGestureEnd={(trackId) => endAutomation(faderTarget('trackVolume', trackId))}
                onKeyframeSelected={() => { setSelectedClipIds([]); setSelected(null); }}
              />
            )}

            {/* Master-FX automation strip (only while editing automation; master
                lanes have no track row of their own). */}
            {automationEdit && (
              <div
                className="absolute left-0 border-t border-amber-500/30 bg-amber-500/4 pointer-events-none"
                style={{ top: tracks.length * trackH + 34, width: timelineWidthPx, height: MASTER_STRIP_H }}
              >
                <span className="absolute top-1 left-2 font-display text-xs font-bold uppercase tracking-widest text-amber-400/70">Master FX</span>
              </div>
            )}
            {automationEdit && masterLanes.map((lane) => {
              const editable = lane.id === activeLaneId;
              if (lane.points.length === 0 && !editable) return null;
              const vis = laneVisual(lane);
              if (!vis) return null;
              return (
                <div key={lane.id} className="contents" data-wheel-passthrough={editable ? '' : undefined}>
                  <AutomationLane
                    lane={lane}
                    zoom={zoom}
                    width={timelineWidthPx}
                    height={MASTER_STRIP_H}
                    top={tracks.length * trackH + 34}
                    color={vis.color}
                    toNorm={vis.toNorm}
                    fromNorm={vis.fromNorm}
                    editable={editable}
                  />
                </div>
              );
            })}

            {/* One strip per bus with a lane, under the master's: a bus has no
                row on the timeline, so its insert lanes are drawn here. */}
            {automationEdit && busLaneStrips.map((b, i) => {
              const top = tracks.length * trackH + 34 + MASTER_STRIP_H * (i + 1);
              return (
                <React.Fragment key={b.id}>
                  <div
                    className="absolute left-0 border-t border-purple-500/30 bg-purple-500/4 pointer-events-none"
                    style={{ top, width: timelineWidthPx, height: MASTER_STRIP_H }}
                  >
                    <span className="absolute top-1 left-2 font-display text-xs font-bold uppercase tracking-widest text-purple-300/80">{b.name} FX</span>
                  </div>
                  {automationLanes.map((lane) => {
                    if (lane.target.kind !== 'busFx' || lane.target.trackId !== b.id) return null;
                    const editable = lane.id === activeLaneId;
                    if (lane.points.length === 0 && !editable) return null;
                    const vis = laneVisual(lane);
                    if (!vis) return null;
                    return (
                      <div key={lane.id} className="contents" data-wheel-passthrough={editable ? '' : undefined}>
                        <AutomationLane
                          lane={lane}
                          zoom={zoom}
                          width={timelineWidthPx}
                          height={MASTER_STRIP_H}
                          top={top}
                          color={vis.color}
                          toNorm={vis.toNorm}
                          fromNorm={vis.fromNorm}
                          editable={editable}
                        />
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}

            {/* Loop region band down the lanes (when set) */}
            {loopEnd > loopStart && (
              <div
                className={`absolute top-0 bottom-0 pointer-events-none ${loopEnabled ? 'bg-amber-400/8 border-x border-amber-400/30' : 'bg-white/2 border-x border-white/10'}`}
                style={{ left: loopStart * zoom, width: (loopEnd - loopStart) * zoom }}
              />
            )}

            {/* The PUNCH window: which edges of that region the next record
                pass may write across, in the record light's red so it reads as
                a recording thing and not a second loop. Drawn from
                `punchWindowFrom` — the SAME gate `recordingStore` crops takes
                with — so it can only appear when a press would really punch: a
                loop that is set but switched off gets no band, because a band
                promising a crop the store will refuse is a lie. An open edge
                runs to the end of the timeline and carries no border, so which
                side is open is visible without reading anything. `aria-hidden`
                and `pointer-events-none`: it is a picture of state named on the
                RECORD key, and the loop band and ruler beneath it stay
                clickable. No z of its own, so it paints over the loop band it
                follows and under the z-30 playhead. */}
            {(() => {
              const win = punchWindowFrom(recPunch, { enabled: loopEnabled, start: loopStart, end: loopEnd });
              if (!win) return null;
              const openStart = !Number.isFinite(win.from); // `out`: no lower edge
              const openEnd = !Number.isFinite(win.to); // `in`: no upper edge
              return (
                <div
                  aria-hidden="true"
                  className={`absolute top-0 bottom-0 pointer-events-none bg-red-500/10 border-red-500/50 ${openStart ? 'border-r' : openEnd ? 'border-l' : 'border-x'}`}
                  style={
                    openStart
                      ? { left: 0, width: win.to * zoom }
                      : openEnd
                        ? { left: win.from * zoom, right: 0 }
                        : { left: win.from * zoom, width: (win.to - win.from) * zoom }
                  }
                />
              );
            })()}

            {/* Edit cursor line in the lanes (F06): thin and DASHED, where the
                playhead line is solid red, so the two never read as one. */}
            <div
              aria-hidden="true"
              className="absolute top-0 bottom-0 w-0 border-l border-dashed border-sky-300/70 z-30 pointer-events-none"
              style={{ left: editCursorSec * zoom }}
            />

            {/* The marquee's rubber band while a drag in empty space is live (F15). */}
            {marqueeRect && (
              <div
                aria-hidden="true"
                className="absolute z-40 pointer-events-none border border-sky-300/80 bg-sky-400/10"
                style={{
                  left: marqueeRect.x1,
                  top: marqueeRect.y1,
                  width: marqueeRect.x2 - marqueeRect.x1,
                  height: marqueeRect.y2 - marqueeRect.y1,
                }}
              />
            )}

            {/* Playhead line in track lanes (position driven imperatively) */}
            <div
              ref={laneLineRef}
              className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] z-30 pointer-events-none"
              style={{ left: playheadSec * zoom }}
            />

            {/* Drop-here-for-new-track strip — directly below the last lane */}
            <div
              className="absolute left-0 right-0 border-t border-dashed border-purple-500/30 bg-purple-500/4 flex items-center justify-center text-xs font-bold uppercase tracking-widest text-purple-400/60 pointer-events-none"
              style={{ top: tracks.length * trackH, height: 34 }}
            >
              Drop here to create a new track
            </div>

            {/* The gap a drag is aimed at: a line where the new lane will go. */}
            {laneInsert !== null && (
              <div
                className="absolute left-0 right-0 z-40 pointer-events-none"
                style={{ top: laneInsert * trackH - 1, height: 2 }}
              >
                <div className="w-full h-0.5 bg-purple-400 shadow-[0_0_8px_rgba(192,132,252,0.9)]" />
                <span className="absolute left-2 -top-5 text-xs font-bold uppercase tracking-wider text-purple-200 bg-black/80 px-1.5 py-0.5 rounded">
                  New lane here
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="h-6 border-t border-white/5 bg-black/60 flex items-center justify-between px-3 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-zinc-500 tabular-nums">
            <span ref={footerTcRef}>{formatTimecode(playheadSec)}</span> / {formatTimecode(totalDuration)}
          </span>
          <span className="text-xs font-bold tabular-nums text-zinc-600">
            {clips.length} clips · {tracks.length} tracks
          </span>
        </div>
        <div className="flex items-center gap-3">
          {selectedClip ? (
            <span className="text-xs font-bold text-purple-300 uppercase tracking-wider">
              SEL: {selectedClip.label} · {selectedClip.startSec.toFixed(2)}s → {(selectedClip.startSec + selectedClip.durationSec).toFixed(2)}s
            </span>
          ) : (
            <span className="text-xs font-bold text-zinc-700 uppercase tracking-wider">
              {clips.length === 0 ? 'No clips yet — right-click a lane to add, or drag from LIBRARY' : 'No selection'}
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
          label: 'Split at playhead',
          hint: 'S',
          onSelect: splitSelectedAtPlayhead,
        });
        items.push({
          type: 'item',
          label: 'Duplicate',
          hint: 'Ctrl+D',
          onSelect: duplicateSelectedClips,
        });
        items.push({ type: 'separator' });
        items.push({
          type: 'item',
          label: 'Copy',
          icon: <Copy className="w-3 h-3" />,
          hint: 'Ctrl+C',
          onSelect: () => { copySelectedClips(); },
        });
        items.push({
          type: 'item',
          label: 'Cut',
          icon: <Scissors className="w-3 h-3" />,
          hint: 'Ctrl+X',
          onSelect: cutSelectedClips,
        });
        items.push({
          type: 'item',
          label: 'Paste at edit cursor',
          hint: 'Ctrl+V',
          disabled: clipboardRef.current.length === 0,
          onSelect: () => pasteClips(),
        });
        items.push({ type: 'separator' });
        if (clip) {
          items.push({
            type: 'item',
            label: 'Name and colour…',
            hint: 'F2',
            onSelect: () => {
              const pos = clipMenu.position;
              setClipNamePanel({ clipId: payload.clipId, x: pos?.x ?? 240, y: pos?.y ?? 200 });
            },
          });
          const clipDb = 20 * Math.log10(clipPeakGain(clip));
          items.push({
            type: 'item',
            label: 'Clip Gain…',
            icon: <Volume2 className="w-3 h-3" />,
            hint: `${clipDb > -0.05 && clipDb < 0.05 ? '0.0' : `${clipDb > 0 ? '+' : ''}${clipDb.toFixed(1)}`} dB`,
            onSelect: () => {
              const pos = clipMenu.position;
              setGainPanel({ clipId: payload.clipId, x: pos?.x ?? 240, y: pos?.y ?? 200 });
            },
          });
          if (showVolumeLine) {
            items.push({
              type: 'item',
              label: 'Add volume keyframe',
              icon: <Volume2 className="w-3 h-3" />,
              hint: `${payload.atSec.toFixed(2)}s`,
              title: 'Add a keyframe to this track\'s volume line here.',
              onSelect: () => { addVolumeKeyframe(clip.trackId, payload.atSec); },
            });
          }
        }
        // A crossfade is offered only when the selection IS one: two clips on
        // one track with something to cross over. The hint is the length, so
        // the user can see what they are about to get before they take it.
        if (crossfadePair) {
          items.push({
            type: 'item',
            label: 'Crossfade',
            icon: <Spline className="w-3 h-3" />,
            hint: `${crossfadePair.region.durationSec.toFixed(2)}s`,
            title: 'Fade the earlier clip out and the later one in across their overlap, at equal power.',
            onSelect: () => { createCrossfade(crossfadePair.a.id, crossfadePair.b.id); },
          });
        }
        // Curve rows appear for a fade that exists, because a shape is only
        // audible once the fade has a length.
        if (clip) {
          for (const [edge, lengthSec, current] of [
            ['in', clip.fadeInSec ?? 0, clip.fadeInCurve ?? 'linear'],
            ['out', clip.fadeOutSec ?? 0, clip.fadeOutCurve ?? 'linear'],
          ] as Array<['in' | 'out', number, FadeCurve]>) {
            if (lengthSec <= 0) continue;
            pushSeparator(items);
            items.push({ type: 'header', label: `Fade ${edge} curve · ${lengthSec.toFixed(2)}s` });
            for (const choice of FADE_CURVE_CHOICES) {
              const active = current === choice.id;
              items.push({
                type: 'item',
                label: choice.label,
                // The check marks the shape in use; the inactive rows carry a
                // blank of the same size so the labels stay in one column.
                icon: active ? <Check className="w-3 h-3" /> : <span className="block w-3 h-3" />,
                hint: active ? 'in use' : choice.hint,
                onSelect: () => setClipFadeCurve(clip.id, edge, choice.id),
              });
            }
          }
        }
        if (clip && clipStretchRate(clip) !== 1) {
          pushSeparator(items);
          items.push({
            type: 'item',
            label: 'Reset stretch',
            icon: <Gauge className="w-3 h-3" />,
            hint: `${clipStretchRate(clip).toFixed(2)}x`,
            title: 'Play the clip at its original speed again, over the length that speed takes.',
            onSelect: () => resetClipStretch(clip.id),
          });
        }
        pushSeparator(items);
        items.push({
          type: 'item',
          label: 'Export Selection…',
          icon: <Save className="w-3 h-3" />,
          title: 'Render the selected clips as they play, with their tracks’ plugins, buses and master chain, to the library or a file',
          onSelect: () => setExportDialogOpen('clips'),
        });
        items.push({
          type: 'item',
          label: 'Send Selection to Init',
          icon: <Wand2 className="w-3 h-3" />,
          hint: 'mix',
          title: 'Render the selected clips as they play, with their tracks’ plugins, buses and master chain, and use the file as MAKE’s init audio',
          disabled: isSelectionRendering,
          onSelect: () => { sendSelectionToInit(); },
        });
        items.push({
          type: 'item',
          label: 'Send Selection to Init (stacked)',
          icon: <Layers className="w-3 h-3" />,
          hint: 'chimera',
          onSelect: () => {
            const selection = getSelectionForInit();
            if (selection.length === 0) return;
            // A MIDI clip with no render is rendered first (state/midiRenderQueue).
            void Promise.all(selection.map((c) => clipWithAudio(c.id)))
              .then((withAudio) => {
                addBlobsToChimera(
                  withAudio.map((c) => ({
                    blob: c.audioBlob as Blob,
                    mimeType: c.mimeType,
                    label: c.label,
                  })),
                );
                onSwitchTab?.('create');
              })
              .catch((err) => logError('editor', `Chimera: ${err instanceof Error ? err.message : String(err)}`));
          },
        });
        // Granular bleed: needs a second selected clip to act as the donor.
        // Overlapping pair → only the seam is bled; otherwise the whole host.
        if (clip && !isMidiClip(clip)) {
          const donor = bleedPartnerFor(clip.id);
          if (donor && !isMidiClip(donor)) {
            const seam = clipOverlap(clip, donor);
            const donorName = (donor.label || tracks.find((t) => t.id === donor.trackId)?.name || 'clip').slice(0, 18);
            items.push({ type: 'separator' });
            items.push({
              type: 'item',
              label: seam ? 'Bleed the seam' : 'Bleed into this clip',
              icon: <Wand2 className="w-3 h-3" />,
              hint: `${donorName} →`,
              disabled: isBleeding,
              onSelect: () => { void bleedClips(clip.id, 'render'); },
            });
            items.push({
              type: 'item',
              label: 'Bleed live…',
              hint: 'audition',
              onSelect: () => { void bleedClips(clip.id, 'live'); },
            });
          }
        }
        if (clip && !isMidiClip(clip)) {
          const subjectIds = selectedClipIdSet.has(payload.clipId) && selectedClipIds.length > 1 ? selectedClipIds : [payload.clipId];
          const others = subjectIds.filter((id) => id !== payload.clipId);
          const anchorBpm = clipKnownBpm(clip);
          const noTempo = 'No tempo is known for this clip. Analyse it in the library first.';
          items.push({
            type: 'item',
            label: hasTempoChanges(arrangementTempoMap)
              ? `Beat match to project (${Math.round(editTempoAtSec(arrangementTempoMap, clip.startSec))} bpm here)`
              : `Beat match to project (${Math.round(projectBpm)} bpm)`,
            icon: <Gauge className="w-3 h-3" />,
            hint: 'sync',
            disabled: timePitchBusy || anchorBpm === null,
            title: anchorBpm === null
              ? noTempo
              : hasTempoChanges(arrangementTempoMap)
                ? 'Stretch to the tempo the arrangement plays where the clip starts and put the first beat on its beat grid'
                : `Stretch to ${Math.round(projectBpm)} bpm and put the first beat on the grid`,
            onSelect: () => void beatMatchClips(subjectIds, projectBpm, true),
          });
          if (others.length > 0) {
            items.push({
              type: 'item',
              label: `Beat match ${others.length} selected to this clip${anchorBpm ? ` (${Math.round(anchorBpm)} bpm)` : ''}`,
              icon: <Gauge className="w-3 h-3" />,
              hint: 'sync',
              disabled: timePitchBusy || anchorBpm === null,
              title: anchorBpm === null ? noTempo : 'This clip is the master; the others stretch to its tempo and the project tempo follows',
              onSelect: () => {
                if (anchorBpm !== null) void beatMatchClips(others, anchorBpm);
              },
            });
          }
          // The song's rhythm analysis as the arrangement's tempo and meter,
          // bar 1 on this clip's first downbeat (SongTempoDialog previews it).
          const songEntry = clip.songTime?.entryId ?? clip.libraryEntryId;
          items.push({
            type: 'item',
            label: 'Use song tempo…',
            icon: <Gauge className="w-3 h-3" />,
            hint: 'bars',
            disabled: !songEntry,
            title: songEntry
              ? "Set the arrangement's tempo and meter from the song's rhythm analysis, with bar 1 on this clip's first downbeat. Shows what changes first"
              : 'This clip is not from a library song, so there is no rhythm analysis behind it',
            onSelect: () => {
              if (songEntry) useEditorStore.getState().requestSongTempo({ entryId: songEntry, clipId: payload.clipId });
            },
          });
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
          items.push({
            type: 'item',
            label: 'Separate Stems → Tracks…',
            icon: <AudioLines className="w-3 h-3" />,
            hint: 'demucs',
            disabled: !!stemsJob,
            onSelect: () => setStemsModal({ clipId: payload.clipId }),
          });
        }
        // The row that opens THIS clip's editor, chosen by the same classifier
        // the double-click uses, so the menu and the gesture always agree —
        // and every clip has one, which is why there is no `else` that leaves
        // a clip with no way in from the menu.
        if (clip) pushSeparator(items);
        if (clip && clipEditKind(clip) === 'audio') {
          items.push({
            type: 'item',
            label: 'Edit audio clip',
            icon: <AudioWaveform className="w-3 h-3" />,
            hint: 'double-click',
            title: 'Open this clip in the audio editor drawer (trim, gain, fades)',
            onSelect: () => editClipInAudioEditor(clip),
          });
        }
        if (clip && clipEditKind(clip) === 'midi') {
          // The count the roll will actually SHOW: its own notes when it has
          // them, else the notes the clip plays. An empty roll is a valid
          // document — the row stays, and says "0 notes" rather than vanishing.
          const noteCount = clip.sourceRollNotes?.length || clip.sourcePianoRoll?.length || 0;
          items.push({
            type: 'item',
            label: 'Edit in Piano Roll',
            icon: <Piano className="w-3 h-3" />,
            hint: `${noteCount} note${noteCount === 1 ? '' : 's'}`,
            onSelect: () => editClipInPianoRoll(clip),
          });
          items.push({
            type: 'item',
            label: 'Instrument',
            icon: <Piano className="w-3 h-3" />,
            hint: clip.instrumentProgram === undefined
              ? 'track default'
              : isPercussionTrack(tracks.find((t) => t.id === clip.trackId))
                ? `${drumKitName(clip.instrumentProgram)} kit`
                : gmShortName(clip.instrumentProgram),
            onSelect: () => {
              const pos = clipMenu.position;
              setInstrPanel({ clipId: payload.clipId, x: pos?.x ?? 240, y: pos?.y ?? 200 });
            },
          });
          // The clip's audio is a cache (lib/midiRender): keep a render with the
          // clip, or free it and let the clip play live and render on export. A
          // render EDIT made only so the clip could be heard offers both: keep it
          // for good, or (once the clip plays live, when EDIT drops it anyway)
          // free it. `info.live` reads a muted clip as if unmuted.
          const info = midiRenderInfo.byId.get(clip.id);
          if (info) {
            const queued = midiQueue.running?.clipId === clip.id || midiQueue.waiting.some((w) => w.clipId === clip.id);
            if (!clip.audioBlob || info.auto) {
              items.push({
                type: 'item',
                label: 'Keep rendered audio',
                icon: <AudioWaveform className="w-3 h-3" />,
                hint: queued ? 'rendering' : info.auto ? 'rendered to be heard' : info.live ? 'plays live now' : 'needs it to sound',
                title: 'Keep the audio with this clip, rendering it now when it has none. Exports and audio edits then use it, and it is re-rendered when the notes or instrument change.',
                disabled: queued,
                onSelect: () => { void rerenderMidiClipAudio(clip.id, 'keep'); },
              });
            }
            if (clip.audioBlob) {
              items.push({
                type: 'item',
                label: 'Drop rendered audio',
                icon: <AudioWaveform className="w-3 h-3" />,
                // A disabled row takes no pointer, so the reason is in the hint.
                hint: !info.live ? 'no live instrument' : info.state === 'stale' ? 'out of date' : 'kept',
                title: 'Free the cached render. The clip plays live on its instrument and renders when an export needs it. Undo brings the audio back.',
                disabled: !info.live,
                onSelect: () => {
                  useEditorStore.getState().updateClip(clip.id, { ...DROP_RENDER_FIELDS });
                  logInfo('editor', `"${clip.label}" plays live and renders when exported`);
                },
              });
            }
          }
        }
        // ── The song's form as timeline markers ─────────────────────────────
        // A clip of a library song gets a marker at each of the song's section
        // starts that it plays (lib/songSections), found first when the song
        // has none. The markers move and split with the clip; a second add
        // replaces them.
        if (clip?.libraryEntryId) {
          pushSeparator(items);
          items.push({
            type: 'item',
            label: 'Add section markers',
            icon: <ListTree className="w-3 h-3" />,
            hint: 'song form',
            title: 'A timeline marker at each section start of this song (intro, verse, chorus, ...) where this clip plays it. The sections are found first when the song has none; a second add replaces the markers.',
            onSelect: () => { void addSectionMarkersToClip(payload.clipId); },
          });
        }
        // ── Insert ONE stem beside this clip ────────────────────────────────
        // Every stem the entry already has is listed, aggregates included: the
        // user is naming one deliberately here, and hiding the drum sum from
        // someone who asked for it by name would be the wrong kind of help.
        // (The bulk paths are the ones that skip sums — see planStemInsert.)
        if (clip?.libraryEntryId && clipStems.entryId === clip.libraryEntryId) {
          const stemRows = clipStems.rows;
          if (stemRows === null) {
            pushSeparator(items);
            items.push({ type: 'header', label: 'Insert stem…' });
            items.push({ type: 'item', label: 'Reading stems…', disabled: true, onSelect: () => undefined });
          } else if (stemRows.length > 0) {
            pushSeparator(items);
            items.push({ type: 'header', label: 'Insert stem…' });
            // ── F14: every stem at once, grouped, one undo step ──────────────
            // Gated and counted by how many stems would actually be INSERTED
            // (aggregate sums excluded — same rule `planStemInsert` applies to
            // the bulk paths), not the raw row count: a clip with one real
            // stem plus its aggregate sum must not offer a 2-stem bulk action
            // that is really the same single insert as the row below it.
            const allStems = allStemsMenuInfo(stemRows);
            if (allStems.offer) {
              items.push({
                type: 'item',
                icon: <AudioLines className="w-3 h-3" />,
                label: `All ${allStems.insertCount} stems`,
                hint: 'new folder',
                title: 'Add every separated stem on its own track, grouped in a folder, lined up with this clip, with this clip muted',
                onSelect: () => { void insertAllStemsBesideClip(payload.clipId, stemRows); },
              });
            }
            for (const ref of stemRows) {
              items.push({
                type: 'item',
                icon: <AudioLines className="w-3 h-3" />,
                label: ref.name,
                hint: ref.role === 'aggregate' ? 'sum of parts' : 'new track',
                title: ref.role === 'aggregate'
                  ? `Add ${ref.name} — a SUM of the other stems — on its own track, lined up with this clip`
                  : `Add the ${ref.name} stem on its own track, lined up with this clip`,
                onSelect: () => { void insertStemBesideClip(payload.clipId, ref); },
              });
            }
          }
        }
        // ── Hand it to the assistant ────────────────────────────────────────
        if (clip) {
          // The clicked clip, or the whole selection when it contains it —
          // the same subject rule the beat-match rows use.
          const refIds = selectedClipIdSet.has(payload.clipId) && selectedClipIds.length > 1
            ? selectedClipIds
            : [payload.clipId];
          const present = refIds.filter((id) => clips.some((c) => c.id === id));
          pushSeparator(items);
          items.push({
            type: 'item',
            icon: <Bot className="w-3 h-3" />,
            label: refIds.length > 1 ? `Reference ${refIds.length} clips in gantasmob0t` : 'Reference in gantasmob0t',
            // A disabled row is pointer-events:none, so the reason rides in the
            // always-visible hint rather than the tooltip.
            hint: present.length === 0 ? 'No longer in the project' : 'assistant',
            disabled: present.length === 0,
            title: 'Add these clips to the assistant’s reference list and open its composer. Nothing is sent.',
            onSelect: () => addAssistantReferences(
              refIds.map((id) => referenceForClip(id)),
              refIds.length > 1 ? `${refIds.length} clips` : `"${clip.label}"`,
            ),
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
        // The header is where a user looks for "add something to THIS track",
        // so it offers the same sources as right-clicking the lane. A header
        // click has no x, so the insert point is the edit cursor.
        const headerTarget: AddToTrackTarget = {
          trackId: t.id,
          trackName: t.name,
          atSec: Math.max(0, snapSec(useEditorStore.getState().editCursorSec)),
        };
        const items: ContextMenuItem[] = [
          { type: 'header', label: 'Add to this track' },
          ...addToTrackItems(headerTarget, trackMenu.position, isAddSourceEntry),
          { type: 'separator' },
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
          // Reorder (F01). The menu moves THIS track, one row per invocation —
          // the same store action the grip's Alt+Arrow uses. A disabled row is
          // pointer-events:none, so the reason rides in the always-visible hint.
          ...(() => {
            const at = tracks.findIndex((tr) => tr.id === t.id);
            const atTop = at <= 0;
            const atBottom = at < 0 || at >= tracks.length - 1;
            return [
              {
                type: 'item',
                icon: <ChevronUp className="w-3 h-3" />,
                label: 'Move track up',
                hint: atTop ? 'Already first' : undefined,
                disabled: atTop,
                title: 'Move this track one row up (Alt+↑ on its grip)',
                onSelect: () => moveTracksByOffset([t.id], -1),
              },
              {
                type: 'item',
                icon: <ChevronDown className="w-3 h-3" />,
                label: 'Move track down',
                hint: atBottom ? 'Already last' : undefined,
                disabled: atBottom,
                title: 'Move this track one row down (Alt+↓ on its grip)',
                onSelect: () => moveTracksByOffset([t.id], 1),
              },
            ] satisfies ContextMenuItem[];
          })(),
          { type: 'separator' },
          // The drum key of the track header, here too, so an empty track can
          // become a drum track before a part is recorded onto it. A program
          // is an instrument on one and a kit on the other, so the track's and
          // its clips' programs are cleared (editorStore setTrackPercussion).
          {
            type: 'item',
            icon: isPercussionTrack(t) ? <Piano className="w-3 h-3" /> : <Drum className="w-3 h-3" />,
            label: isPercussionTrack(t) ? 'Make melodic track' : 'Make drum track',
            title: isPercussionTrack(t)
              ? 'MIDI on this track plays its notes as pitches again'
              : 'MIDI on this track plays drums on the General MIDI drum channel',
            onSelect: () => {
              useEditorStore.getState().setTrackPercussion(t.id, !isPercussionTrack(t));
              void ensureSoundfontReady();
            },
          },
          // Humanize by section: this track, or every selected track with it, moved together
          // (a section pushes or lays back as one, a phrase drifts as one, velocities lean to its peak).
          ...(() => {
            const sel = useEditorStore.getState().selectedTrackIds;
            const group = sel.includes(t.id) ? sel : [t.id];
            const hasMidi = clips.some((c) => group.includes(c.trackId) && c.sourceKind === 'piano-roll' && (c.sourcePianoRoll?.length ?? 0) > 0);
            const what = group.length > 1 ? `${group.length} selected tracks together` : 'this track';
            const run = (strength: SectionHumanizeStrength) => {
              void humanizeTracks({ track_ids: group, strength }).then((r) => {
                if (r.ok) logInfo('editor', r.message);
                else logWarn('editor', r.error);
              });
            };
            return [
              { type: 'header', label: 'Humanize by section' },
              ...(['light', 'medium', 'strong'] as const).map((strength): ContextMenuItem => ({
                type: 'item',
                icon: <Wand2 className="w-3 h-3" />,
                label: `${strength[0].toUpperCase()}${strength.slice(1)}`,
                hint: hasMidi ? (group.length > 1 ? `${group.length} tracks` : undefined) : 'No MIDI',
                disabled: !hasMidi,
                title: `Humanize the MIDI of ${what} by section, ${strength}: each section pushes or lays back, each phrase drifts, velocities lean toward each phrase's peak`,
                onSelect: () => run(strength),
              })),
            ] satisfies ContextMenuItem[];
          })(),
          { type: 'separator' },
          {
            type: 'item',
            icon: <Bot className="w-3 h-3" />,
            label: 'Reference track in gantasmob0t',
            hint: 'assistant',
            title: 'Add this track to the assistant’s reference list and open its composer. Nothing is sent.',
            onSelect: () => addAssistantReferences([referenceForTrack(t.id)], `"${t.name}"`),
          },
          { type: 'separator' },
          {
            type: 'item',
            icon: <SlidersHorizontal className="w-3 h-3" />,
            label: 'Open FX rack',
            // Anchor the rack at the right-click that opened this menu; the
            // legacy right-4 top-28 spot is the no-coords fallback.
            onSelect: () => openFxRack(fxRackAnchor(t.id, trackMenu.position?.x, trackMenu.position?.y)),
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

      {/* Add-to-track menu — right-click an empty part of the timeline. The
          group header names the lane the click resolved to, so it can never
          again claim to add to a track while quietly making a new one. */}
      {/* The time-range menu (F04). Rows come from timelineInteraction's model
          (tested there); this only binds each row to its action. Opening or
          closing it changes neither the range nor the clip selection. */}
      {rangeMenu.position && rangeMenu.payload && (() => {
        const { range, trackId, clipId, sec } = rangeMenu.payload;
        const menuPos = rangeMenu.position;
        const menuClips = clips.map((c) => ({
          id: c.id,
          trackId: c.trackId,
          startSec: c.startSec,
          durationSec: c.durationSec,
          midi: isMidiClip(c),
        }));
        const actions: Record<RangeMenuAction, { icon?: React.ReactNode; run: () => void }> = {
          play: {
            icon: <Play className="w-3 h-3" />,
            run: () => {
              setEditCursor(range.startSec);
              seekEditorTo(range.startSec);
              if (!isEditorTimelinePlaying() && !liveMixer.isPlaying()) void playEditorTimeline();
            },
          },
          loop: { icon: <Repeat className="w-3 h-3" />, run: () => setLoopRegion(range.startSec, range.endSec) },
          zoom: { icon: <ScanSearch className="w-3 h-3" />, run: () => zoomToRange(range.startSec, range.endSec) },
          split: {
            icon: <Scissors className="w-3 h-3" />,
            run: () => {
              const plan = rangeSplitPlan(menuClips, range);
              if (plan.length === 0) return;
              // One undo step for every cut: the recorder folds the synchronous
              // burst after this cut into a single step.
              beginUndoStep();
              const anchor = useEditorStore.getState().selectedClipId;
              for (const cut of plan) splitClipAt(cut.clipId, cut.atSec);
              // splitClipAt focuses each new right half; a range command should
              // leave the user's focused clip where it was.
              setSelected(anchor);
              logInfo('editor', `Split ${plan.length} cut${plan.length === 1 ? '' : 's'} at the range edges`);
            },
          },
          'copy-to-inpaint': {
            icon: <Paintbrush className="w-3 h-3" />,
            run: () => {
              const res = inpaintFromRange(menuClips, range, trackId);
              if (res.ok) setInpaintSelection(res.selection);
            },
          },
          'clip-actions': {
            icon: <Layers className="w-3 h-3" />,
            // The clip's own menu, at the same spot, exactly as a right-click
            // outside the range opens it — including the selection rule: a clip
            // that is not in the selection becomes the selection, so the rows
            // that act on "the selected clips" act on THIS one. Choosing this
            // row is a deliberate command, so changing the selection is allowed
            // (unlike merely opening or closing a menu).
            run: () => {
              if (clipId === undefined) return;
              if (!useEditorStore.getState().selectedClipIds.includes(clipId)) selectClipSingle(clipId);
              // Same read openContextMenu does on a direct right-click, so
              // "Insert stem…" is populated in the clip menu this opens too.
              warmClipStems(clips.find((c) => c.id === clipId)?.libraryEntryId);
              clipMenu.open(new MouseEvent('contextmenu', { clientX: menuPos.x, clientY: menuPos.y }), { clipId, atSec: sec });
            },
          },
          render: {
            run: () => setRangeRender({ startSec: range.startSec, endSec: range.endSec, x: menuPos.x, y: menuPos.y }),
          },
          'send-assistant': {
            icon: <Bot className="w-3 h-3" />,
            // The store's time selection, not this menu's copy of it: the
            // reference has to describe what the editor is selecting NOW.
            run: () => addAssistantReferences([referenceForTimeSelection()], 'this range'),
          },
          clear: { icon: <X className="w-3 h-3" />, run: () => setTimeSelection(null) },
        };
        const items: ContextMenuItem[] = [];
        for (const entry of buildRangeMenu({ range, clips: menuClips, trackId, clipId })) {
          if (entry.action === 'render' || entry.action === 'clear') items.push({ type: 'separator' });
          items.push({
            type: 'item',
            icon: actions[entry.action].icon,
            label: entry.label,
            disabled: !entry.enabled,
            // A disabled row is pointer-events-none, so its reason goes in the
            // always-visible hint rather than a tooltip.
            hint: entry.reason,
            onSelect: actions[entry.action].run,
          });
        }
        return (
          <ContextMenu
            position={menuPos}
            onClose={rangeMenu.close}
            items={items}
            title={`Range · ${formatRangeReadout(range)}`}
            minWidth="16rem"
          />
        );
      })()}

      {/* A bounded FULL-MIX render: the same request COMMIT EDIT queues (same scope, same
          fidelity), only with frame bounds, so the file lands exactly where a mixdown lands. */}
      <RenderRangeDialog
        open={rangeRender !== null}
        selection={rangeRender}
        anchor={rangeRender ?? undefined}
        onCancel={() => setRangeRender(null)}
        onConfirm={({ title, range }) => {
          const jobId = enqueueBounce({ kind: 'mixdown', label: title, request: { ...mixdownRequest(), range }, range });
          // This dialog's title is always text the user confirmed here, never
          // the `commitEdit` auto-generated fallback.
          setMixdownJobExplicitName(jobId, true);
          setRangeRender(null);
        }}
      />

      {addMenu.position && addMenu.payload && (() => {
        const target = addMenu.payload;
        const items: ContextMenuItem[] = [
          { type: 'header', label: addToTrackGroupLabel(target) },
          ...addToTrackItems(target, addMenu.position, isAddSourceEntry),
          { type: 'separator' },
          ...addToTrackItems(target, addMenu.position, (entry) => !isAddSourceEntry(entry)),
        ];
        // On a lane (not the slot below the last one): a keyframe on that
        // track's volume line, at the time the menu opened at.
        const volumeTrackId = target.trackId;
        if (showVolumeLine && volumeTrackId) {
          items.push(
            { type: 'separator' },
            {
              type: 'item',
              label: 'Add volume keyframe',
              icon: <Volume2 className="w-3 h-3" />,
              title: 'Add a keyframe to this track\'s volume line here.',
              onSelect: () => { addVolumeKeyframe(volumeTrackId, target.atSec); },
            },
          );
        }
        return (
          <ContextMenu
            position={addMenu.position}
            onClose={addMenu.close}
            items={items}
            title={`Timeline · ${formatTimecode(target.atSec)}`}
            minWidth="13rem"
          />
        );
      })()}

      {/* Library picker — opened by an "… from Library" entry of either menu.
          Portaled, anchored, no overlay: the app behind it stays usable. */}
      <LibraryPicker
        open={addPicker !== null}
        anchor={addPicker ? { x: addPicker.x, y: addPicker.y } : null}
        title={addPicker?.tab === 'midi' ? 'Add MIDI to a track' : 'Add audio to a track'}
        subtitle={
          addPicker
            ? `${tracks.find((t) => t.id === addPicker.trackId)?.name ?? 'New track'} · ${formatTimecode(addPicker.atSec)}`
            : undefined
        }
        initialTab={addPicker?.tab ?? 'audio'}
        onClose={() => {
          setAddPicker(null);
          returnFocusToTimeline();
        }}
        onPick={(pick) => {
          const target = addPicker;
          setAddPicker(null);
          returnFocusToTimeline();
          if (target) {
            void placePick(pick, { trackId: target.trackId, trackName: null, atSec: target.atSec });
          }
        }}
      />

      {/* The OS dialogs behind "… from System". A real <input type=file>, not
          electronAPI.selectFile / storageClient.pickFile: those return a
          filesystem PATH with no bytes, and nothing downstream can read a path.
          Inside Electron this input opens the same native dialog, so one route
          covers the desktop app and the browser at :5173 alike.
          Hidden with sr-only rather than display:none — `hidden` would drop the
          field out of the accessibility tree and leave its label naming
          nothing — and kept out of the Tab order because the menu is the route. */}
      <label htmlFor={addAudioInputId} className="sr-only">
        Audio files to add to a track
      </label>
      <input
        ref={audioFileInputRef}
        id={addAudioInputId}
        name={addAudioInputId}
        type="file"
        /* AUDIO_ACCEPT rather than the wildcard audio mime: Windows hands
           many audio files over with an EMPTY mime type, and the wildcard then
           greys out a 32-bit-float .wav the backend imports fine. */
        accept={AUDIO_ACCEPT}
        multiple
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // so picking the same file again still fires
          void onAddAudioFiles(files, takePendingAdd());
        }}
      />
      <label htmlFor={addMidiInputId} className="sr-only">
        MIDI file to add to a track
      </label>
      <input
        ref={midiFileInputRef}
        id={addMidiInputId}
        name={addMidiInputId}
        type="file"
        accept={MIDI_ACCEPT}
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void onAddMidiFiles(files, takePendingAdd());
        }}
      />
      <label htmlFor={addMidiTracksInputId} className="sr-only">
        MIDI file to add as tracks, one track per part
      </label>
      <input
        ref={midiTracksInputRef}
        id={addMidiTracksInputId}
        name={addMidiTracksInputId}
        type="file"
        accept={MIDI_ACCEPT}
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void onAddMidiTracksFiles(files, takePendingAdd());
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
            <span className="font-display text-xs font-black uppercase tracking-widest text-purple-300 flex items-center gap-1.5">
              <Paintbrush className="w-3 h-3" /> Inpaint Region
            </span>
            <button onClick={rejectInpaint} className="p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-white transition-colors">
              <X className="w-3 h-3" />
            </button>
          </div>

          {/* Phase: params */}
          {inpaintPanel.kind === 'params' && (
            <>
              {inpaintPanel.error && (
                <p
                  role="alert"
                  className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-xs font-bold tabular-nums leading-relaxed text-rose-200 wrap-break-word"
                >
                  {inpaintPanel.error}
                </p>
              )}
              <label htmlFor="inpaint-prompt" className="sr-only">Inpaint prompt</label>
              <textarea
                id="inpaint-prompt"
                name="inpaint-prompt"
                placeholder="Describe what to generate in this region…"
                value={inpaintPrompt}
                onChange={(e) => setInpaintPrompt(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs font-bold text-zinc-200 placeholder:text-zinc-600 resize-none outline-none focus:border-purple-500/50 transition-colors"
                rows={3}
                autoFocus
              />
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold tabular-nums text-zinc-500">Steps</span>
                  <span className="text-xs font-bold tabular-nums text-zinc-400">{inpaintSteps}</span>
                </div>
                <SlideTrack min={4} max={20} step={1} value={inpaintSteps}
                  onChange={(v) => setInpaintSteps(v)} className="w-full" ariaLabel="Inpaint steps" />
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="inpaint-seed" className="text-xs font-bold tabular-nums text-zinc-500 shrink-0">Seed</label>
                <input
                  id="inpaint-seed"
                  type="number" name="inpaint-seed" value={inpaintSeed}
                  onChange={(e) => setInpaintSeed(parseInt(e.target.value) || -1)}
                  className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-0.5 text-xs font-bold text-zinc-200 outline-none focus:border-purple-500/50 transition-colors"
                  placeholder="-1 (random)"
                />
              </div>
              <button
                onClick={() => void submitInpaint()}
                disabled={!inpaintPrompt.trim()}
                className="w-full py-1.5 rounded bg-purple-600/30 border border-purple-500/40 text-purple-200 text-xs font-black uppercase tracking-widest hover:bg-purple-600/50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                Generate
              </button>
            </>
          )}

          {/* Phase: generating */}
          {inpaintPanel.kind === 'generating' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="w-5 h-5 border-2 border-purple-500/40 border-t-purple-400 rounded-full animate-spin" />
              <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Generating…</span>
              <button onClick={rejectInpaint} className="text-xs font-bold tabular-nums text-zinc-600 hover:text-zinc-400 transition-colors">
                cancel
              </button>
            </div>
          )}

          {/* Phase: review */}
          {inpaintPanel.kind === 'review' && (
            <>
              {/* Outside the shared graph, so it follows the 'preview' surface
                  output rather than the main mix. */}
              <SurfaceAudio surface="preview" controls src={inpaintPanel.blobUrl} className="w-full h-8 mt-1" />
              <div className="flex gap-2">
                <button
                  onClick={() => acceptInpaint(inpaintPanel.blob)}
                  className="flex-1 py-1.5 rounded bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 text-xs font-black uppercase tracking-widest hover:bg-emerald-600/50 transition-colors"
                >
                  Accept
                </button>
                <button
                  onClick={rejectInpaint}
                  className="flex-1 py-1.5 rounded bg-red-600/20 border border-red-500/30 text-red-300 text-xs font-black uppercase tracking-widest hover:bg-red-600/40 transition-colors"
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

