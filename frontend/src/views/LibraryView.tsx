import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Database, Clock, Play, Pause, Download, Trash2,
  Music, Star, Tag, Filter, ArrowUpDown, Sparkles,
  LayoutGrid, List as ListIcon, Activity, Scissors, Layers, Wand2, PenLine,
  Package, Network, FileMusic, Loader2, Mic, Piano, ListOrdered,
  CheckSquare, Square, MoreHorizontal, Combine, Paintbrush, FileText, ChevronDown, Maximize2,
  Film, Image as ImageIcon, Upload, RefreshCw, Tv2, Repeat,
} from 'lucide-react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu';
import { useConvertMenu } from '../convert/ConvertMenu';
import { LineageModal } from '../components/library/LineageModal';
import { SuggestPlaylistModal } from '../components/library/SuggestPlaylistModal';
import { StemsRunModal, type StemsRunOptions } from '../components/library/StemsRunModal';
import { MicRecorder } from '../components/audio/MicRecorder';
import { Section } from '../components/ui/Section';
import { useLibraryStore, type LibraryEntry } from '../state/libraryStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useEditorStore, computePeaks } from '../state/editorStore';
import { usePlayerStore } from '../state/playerStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { useStatusBarStore } from '../state/statusBarStore';
import { useFeatureToggleStore } from '../state/featureToggleStore';
import { logError, logInfo } from '../state/logStore';
import { addBlobsToChimera } from '../lib/chimeraClient';
import { listMedia, importMedia, deleteMedia, MEDIA_ACCEPT } from '../lib/mediaLibrary';
import { setAudioDragData } from '../lib/audioDnD';
import { renderMidiBufferToBlob } from '../lib/midiSynth';
import { fetchMidiBytesWithRetry, fetchBlobWithRetry } from '../lib/fetchRetry';
import { notationArtifactUrl, notationPackUrl } from '../lib/notationClient';
import { sendTrackToVj } from '../state/vjSetBus';
import {
  loadMidiIntoPianoRoll,
  midiIdToSendable,
  sendAudioToChimera,
  sendAudioToEditor,
  sendAudioToInit,
  sendAudioToInpaint,
  sendMidiIdToTarget,
  stemRowToSendable,
} from '../lib/sendToTargets';


const formatDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const formatDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

const downloadEntry = (entry: LibraryEntry, url: string) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = entry.title;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

export const LibraryView: React.FC<{ onSwitchTab?: (tab: string) => void; onExpand?: () => void }> = ({ onSwitchTab, onExpand }) => {
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [subTab, setSubTab] = useState<'tracks' | 'stems' | 'midi' | 'video' | 'score'>('tracks');
  const [lineageOpen, setLineageOpen] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  // Per-entry right-click menu now uses the shared ContextMenu
  // primitive (zoom-compensated, closes on outside-click / Esc / wheel
  // automatically). Payload carries the entryId of the right-clicked
  // row so the menu's items can read it without re-finding the row.
  const entryMenu = useContextMenu<{ entryId: string }>();
  // Second-stage "Convert to..." format picker (FFmpeg). Shared by the audio
  // context menu below; opened at the same spot the parent menu was.
  const convertMenu = useConvertMenu({
    onStart: (m) => logInfo('library', m),
    onError: (m) => logError('library', m),
  });
  const [allStems, setAllStems] = useState<Array<Record<string, unknown>> | null>(null);
  const [allMidis, setAllMidis] = useState<Array<Record<string, unknown>> | null>(null);
  // SCORE library tab: every notation/sheet artifact across all entries,
  // joined to its parent track's title. Fetched lazily when the SCORE tab
  // opens (notation is per-entry server-side, so this uses the aggregate
  // /_all/scores route, mirroring stems/midi).
  const [allScores, setAllScores] = useState<Array<Record<string, unknown>> | null>(null);
  // VJ video library: video + image entries live outside the audio store
  // (the default /entries list is audio-only). Fetched lazily when the
  // VIDEO tab opens and re-fetched after an import / delete.
  const [mediaEntries, setMediaEntries] = useState<LibraryEntry[] | null>(null);
  const [runningKind, setRunningKind] = useState<{ id: string; kind: 'analysis' | 'stems' | 'midi' } | null>(null);
  const [stemsBanner, setStemsBanner] = useState<{ phase: string; progress: number; message: string } | null>(null);
  const stemsAbortControllerRef = useRef<AbortController | null>(null);
  // Pre-run modal state for stem separation. The modal opens whenever
  // the user picks "Separate stems" from a context menu so they can pick
  // count / device / quality before kicking the heavy demucs run.
  const [stemsModal, setStemsModal] = useState<{ entryId: string; entryTitle: string } | null>(null);
  // Mic-in panel — toggled by a button at the top of the LIBRARY section.
  const [micOpen, setMicOpen] = useState(false);
  const midiFileInputRef = useRef<HTMLInputElement | null>(null);
  const patchFeatures = useFeatureToggleStore((s) => s.patch);


  const abortStems = async () => {
    if (!runningKind || runningKind.kind !== 'stems') return;
    logInfo('library', `Aborting stems for ${runningKind.id.slice(0, 8)}…`);
    try {
      await fetch(`/api/stems/${runningKind.id}/abort`, { method: 'POST' });
    } catch (e) {
      logError('library', `Abort request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Also tear down the client-side fetch so the UI returns quickly.
    if (stemsAbortControllerRef.current) {
      stemsAbortControllerRef.current.abort();
      stemsAbortControllerRef.current = null;
    }
  };

  const runJobForEntry = async (
    entryId: string,
    kind: 'analysis' | 'stems' | 'midi',
  ) => {
    setRunningKind({ id: entryId, kind });
    const labels: Record<typeof kind, string> = {
      analysis: 'analysis',
      stems: 'stem separation',
      midi: 'MIDI conversion',
    };
    logInfo('library', `Running ${labels[kind]} on ${entryId.slice(0, 8)}…`);

    // For stems, poll /progress every ~1.5s while the /run request is
    // in-flight so the user sees install/download/separate phases in
    // the ProcessingLog instead of an opaque 5-minute "running…".
    // Includes a 30-second heartbeat that logs elapsed time even when
    // the sidecar phase / message hasn't changed (demucs can sit at a
    // single percentage point for minutes while it processes shifts).
    let stemsPoller: ReturnType<typeof setInterval> | null = null;
    if (kind === 'stems') {
      let lastPhase = '';
      let lastMessage = '';
      let lastProgress = -1;
      let lastChangeAt = Date.now();
      let lastHeartbeatAt = Date.now();
      const runStartedAt = Date.now();
      stemsPoller = setInterval(() => {
        void fetch(`/api/stems/${entryId}/progress`)
          .then((r) => r.json())
          .then((p: { phase?: string; message?: string; progress?: number }) => {
            const phase = p.phase || 'idle';
            const message = p.message || '';
            const progress = typeof p.progress === 'number' ? p.progress : -1;
            // Banner state so the user can see + abort from anywhere
            // in the right panel.
            setStemsBanner({ phase, progress: progress >= 0 ? progress : 0, message });
            if (phase === 'idle') return;
            const now = Date.now();
            const elapsedTotal = Math.round((now - runStartedAt) / 1000);
            const fmtElapsed = (s: number) =>
              s >= 60 ? `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s` : `${s}s`;
            const pctText = progress >= 0 ? ` ${Math.round(progress)}%` : '';

            const changed =
              phase !== lastPhase || message !== lastMessage || progress !== lastProgress;
            if (changed) {
              lastPhase = phase;
              lastMessage = message;
              lastProgress = progress;
              lastChangeAt = now;
              lastHeartbeatAt = now;
              logInfo(
                'library',
                `stems[${entryId.slice(0, 8)}] ${phase}${pctText} @ ${fmtElapsed(elapsedTotal)}: ${message}`,
              );
              return;
            }

            // No change since last poll. Emit a heartbeat every 30s so
            // the user knows the run is still alive (demucs commonly
            // pauses ~minutes at a single percent during shifts).
            if (now - lastHeartbeatAt >= 30_000) {
              lastHeartbeatAt = now;
              const stuckFor = Math.round((now - lastChangeAt) / 1000);
              logInfo(
                'library',
                `stems[${entryId.slice(0, 8)}] still ${phase}${pctText} — no update for ${fmtElapsed(stuckFor)} (total ${fmtElapsed(elapsedTotal)})`,
              );
            }
          })
          .catch(() => {
            /* swallow — poll loop continues */
          });
      }, 1500);
    }

    // Build the run URL — stems honours the user's device + count
    // preferences from Settings → Background features.
    let runUrl = `/api/${kind}/${entryId}/run`;
    if (kind === 'stems') {
      const stemsCfg = useFeatureToggleStore.getState().settings.stems;
      const params = new URLSearchParams({
        stems: String(stemsCfg.default_count || 4),
      });
      if (stemsCfg.device && stemsCfg.device !== 'auto') {
        params.set('device', stemsCfg.device);
      }
      if (stemsCfg.quality) {
        params.set('quality', stemsCfg.quality);
      }
      runUrl += `?${params.toString()}`;
    }

    // Wire an AbortController so the user-side Abort button can tear
    // the in-flight fetch down promptly (the backend abort endpoint
    // takes care of the actual demucs cancellation).
    const ctrl = new AbortController();
    if (kind === 'stems') stemsAbortControllerRef.current = ctrl;
    try {
      const res = await fetch(runUrl, { method: 'POST', signal: ctrl.signal });
      const payload = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const detail =
          (payload && (payload as Record<string, unknown>).detail) ??
          (payload as Record<string, unknown>).error ??
          `HTTP ${res.status}`;
        logError('library', `${labels[kind]} failed: ${detail}`);
        return;
      }

      // The MIDI runner returns a top-level status of failed | partial |
      // complete with per-target results. Stems / analysis use their own
      // shapes. Surface the real outcome rather than a flat "done".
      const status = String((payload as Record<string, unknown>).status ?? '');
      if (kind === 'midi') {
        const results = ((payload as { results?: Array<Record<string, unknown>> }).results) ?? [];
        const failed = results.filter((r) => !r.ok);
        if (status === 'failed') {
          const firstErr = failed[0]?.error ?? 'no engine installed (try: pip install basic-pitch)';
          logError('library', `MIDI conversion FAILED for ${entryId.slice(0, 8)}: ${firstErr}`);
        } else if (status === 'partial') {
          logError(
            'library',
            `MIDI conversion partial for ${entryId.slice(0, 8)}: ${failed.length}/${results.length} target(s) failed; first error: ${failed[0]?.error ?? '—'}`,
          );
        } else {
          logInfo('library', `MIDI conversion done for ${entryId.slice(0, 8)} (${results.length} targets)`);
        }
      } else if (kind === 'stems') {
        const written = (payload as Record<string, unknown>).written ?? 0;
        const stat = status || 'completed';
        logInfo('library', `stem separation ${stat} for ${entryId.slice(0, 8)}: ${written} stem(s) written`);
      } else {
        // analysis — surface bpm / key / pitch summary in the log so
        // the user can verify at a glance without opening Details.
        const a = payload as Record<string, unknown>;
        const bits: string[] = [];
        if (a.bpm != null) bits.push(`bpm=${Number(a.bpm).toFixed(1)}`);
        if (a.key) bits.push(`key=${a.key}${a.scale ? ' ' + a.scale : ''}`);
        if (a.pitch_mean_hz != null) bits.push(`pitch=${Number(a.pitch_mean_hz).toFixed(0)}Hz`);
        if (a.bars_estimated != null) bits.push(`bars=${Number(a.bars_estimated).toFixed(1)}`);
        if (a.rms_db != null) bits.push(`rms=${Number(a.rms_db).toFixed(1)}dB`);
        logInfo('library', `analysis done for ${entryId.slice(0, 8)}: ${bits.join(', ') || 'no useful data'}`);
      }
      // Invalidate sub-tab caches so the new stems/midi show up.
      if (kind === 'stems') setAllStems(null);
      if (kind === 'midi') setAllMidis(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (kind === 'stems' && /aborted|AbortError/i.test(msg)) {
        logInfo('library', `stem separation cancelled for ${entryId.slice(0, 8)}`);
      } else {
        logError('library', `${labels[kind]} request failed: ${msg}`);
      }
    } finally {
      if (stemsPoller) clearInterval(stemsPoller);
      if (kind === 'stems') {
        stemsAbortControllerRef.current = null;
        setStemsBanner(null);
      }
      setRunningKind(null);
    }
  };

  // Fetch stems / midi indexes lazily when their sub-tab opens.
  useEffect(() => {
    if (subTab === 'stems' && allStems === null) {
      void fetch('/api/library/_all/stems')
        .then((r) => r.json())
        .then((j) => setAllStems(j.stems || []))
        .catch(() => setAllStems([]));
    }
    if (subTab === 'midi' && allMidis === null) {
      void fetch('/api/library/_all/midi')
        .then((r) => r.json())
        .then((j) => setAllMidis(j.midis || []))
        .catch(() => setAllMidis([]));
    }
    if (subTab === 'video' && mediaEntries === null) {
      void listMedia()
        .then((rows) => setMediaEntries(rows))
        .catch((e) => {
          logError('library', `Failed to load media library: ${e instanceof Error ? e.message : String(e)}`);
          setMediaEntries([]);
        });
    }
    if (subTab === 'score' && allScores === null) {
      void fetch('/api/library/_all/scores')
        .then((r) => r.json())
        .then((j) => setAllScores(j.scores || []))
        .catch(() => setAllScores([]));
    }
  }, [subTab, allStems, allMidis, mediaEntries, allScores]);

  const refreshMedia = React.useCallback(async () => {
    try {
      setMediaEntries(await listMedia());
    } catch (e) {
      logError('library', `Failed to refresh media library: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // In-place refresh of the stems / midi indexes (no null-flicker, unlike the
  // lazy first-load). Passed to SubTabList so favorite / delete update the list
  // without resetting the sub-tab to its "Loading…" placeholder.
  const refreshStems = React.useCallback(async () => {
    try {
      const j = await fetch('/api/library/_all/stems').then((r) => r.json());
      setAllStems(j.stems || []);
    } catch (e) {
      logError('library', `Failed to refresh stems: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const refreshMidi = React.useCallback(async () => {
    try {
      const j = await fetch('/api/library/_all/midi').then((r) => r.json());
      setAllMidis(j.midis || []);
    } catch (e) {
      logError('library', `Failed to refresh MIDI: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const refreshScores = React.useCallback(async () => {
    try {
      const j = await fetch('/api/library/_all/scores').then((r) => r.json());
      setAllScores(j.scores || []);
    } catch (e) {
      logError('library', `Failed to refresh scores: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const stemsByParent = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    (allStems || []).forEach((s) => {
      const pid = String(s.parent_id ?? '');
      if (!map[pid]) map[pid] = [];
      map[pid].push(s);
    });
    return map;
  }, [allStems]);

  const midisByParent = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    (allMidis || []).forEach((m) => {
      const pid = String(m.parent_id ?? '');
      if (!map[pid]) map[pid] = [];
      map[pid].push(m);
    });
    return map;
  }, [allMidis]);

  const scoresByParent = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    (allScores || []).forEach((s) => {
      const pid = String(s.parent_id ?? '');
      if (!map[pid]) map[pid] = [];
      map[pid].push(s);
    });
    return map;
  }, [allScores]);

  const entries = useLibraryStore((s) => s.entries);
  const loaded = useLibraryStore((s) => s.loaded);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const onlyFavorites = useLibraryStore((s) => s.onlyFavorites);
  const sortBy = useLibraryStore((s) => s.sortBy);
  const playingId = useLibraryStore((s) => s.playingId);
  const load = useLibraryStore((s) => s.load);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const setOnlyFavorites = useLibraryStore((s) => s.setOnlyFavorites);
  const setSortBy = useLibraryStore((s) => s.setSortBy);
  const setPlayingId = useLibraryStore((s) => s.setPlayingId);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const removeEntry = useLibraryStore((s) => s.removeEntry);
  const getAudioUrl = useLibraryStore((s) => s.getAudioUrl);
  const getFiltered = useLibraryStore((s) => s.getFiltered);

  // Gate the library fetch on backend readiness. The Shell mounts
  // immediately (so state stores initialize), but a /api/library/entries
  // call before uvicorn binds returns ECONNREFUSED and leaves the panel
  // stuck empty until the user hard-refreshes. We watch isBackendReady
  // and auto-fetch as soon as it flips true.
  //
  // The actual load() is wrapped in requestIdleCallback (with a
  // setTimeout fallback) so it doesn't pile on top of the vite HMR
  // commit / first paint — that's what produces the "message handler
  // took Xms" perf violations during initial connect.
  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  useEffect(() => {
    if (!isBackendReady || loaded) return;
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => void load(), { timeout: 1500 });
    } else {
      setTimeout(() => void load(), 0);
    }
  }, [isBackendReady, loaded, load]);

  const filteredEntries = getFiltered();
  const selectedEntries = filteredEntries.filter((entry) => selectedEntryIds.includes(entry.id));
  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const engineIsPlaying = usePlayerStore((s) => s.isPlaying);
  const engineLoad = usePlayerStore((s) => s.load);
  const enginePlay = usePlayerStore((s) => s.play);
  const enginePause = usePlayerStore((s) => s.pause);

  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const showBottomTab = useBottomPanelStore((s) => s.showTab);

  const openScoreForEntry = (entryId: string) => {
    setSelectedEntry(entryId);
    showBottomTab('score');
  };

  useEffect(() => {
    setSelectedEntryIds((prev) => prev.filter((id) => entries.some((entry) => entry.id === id)));
  }, [entries]);

  // Shared ContextMenu handles outside-click / Esc / wheel close, so
  // the old per-mount global listener block is gone.

  // Listen for the graph-node right-click actions that fire window
  // events the rest of the app picks up (see LineageModal.tsx graph
  // node ContextMenu). Open-lineage opens our embedded LineageModal
  // at the requested entry; reveal-library-entry selects + scrolls.
  useEffect(() => {
    const onOpenLineage = (e: Event) => {
      const id = (e as CustomEvent).detail?.entryId;
      if (typeof id === 'string') setLineageOpen(id);
    };
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent).detail?.entryId;
      if (typeof id !== 'string') return;
      setSelectedEntryIds([id]);
      setSelectionAnchorId(id);
      setSelectedEntry(id);
      showBottomTab('details');
      // Schedule a scrollIntoView after the next paint so the entry
      // row exists in the DOM by the time we look for it.
      window.requestAnimationFrame(() => {
        const el = document.querySelector(`[data-library-entry-id="${id}"]`);
        if (el && 'scrollIntoView' in el) {
          (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    };
    window.addEventListener('thedaw:open-lineage', onOpenLineage);
    window.addEventListener('thedaw:reveal-library-entry', onReveal);
    return () => {
      window.removeEventListener('thedaw:open-lineage', onOpenLineage);
      window.removeEventListener('thedaw:reveal-library-entry', onReveal);
    };
  }, [setSelectedEntry, showBottomTab]);

  const handleSelectEntry = (entry: LibraryEntry, event?: React.MouseEvent) => {
    const additive = !!(event?.ctrlKey || event?.metaKey);
    const range = !!event?.shiftKey;

    if (range && selectionAnchorId) {
      const orderedIds = filteredEntries.map((item) => item.id);
      const anchorIndex = orderedIds.indexOf(selectionAnchorId);
      const targetIndex = orderedIds.indexOf(entry.id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const rangeIds = orderedIds.slice(start, end + 1);
        setSelectedEntryIds((prev) => (additive ? Array.from(new Set([...prev, ...rangeIds])) : rangeIds));
      } else {
        setSelectedEntryIds([entry.id]);
      }
    } else if (additive) {
      setSelectedEntryIds((prev) => (
        prev.includes(entry.id) ? prev.filter((id) => id !== entry.id) : [...prev, entry.id]
      ));
      setSelectionAnchorId(entry.id);
    } else {
      setSelectedEntryIds([entry.id]);
      setSelectionAnchorId(entry.id);
    }

    setSelectedEntry(entry.id);
    // Selecting a track no longer auto-opens the Details tab (per user).
    // Details is still reachable via the bottom-panel tab + open-lineage events.
  };

  const handleEntryContextMenu = (event: React.MouseEvent, entry: LibraryEntry) => {
    event.stopPropagation();
    if (!selectedEntryIds.includes(entry.id)) {
      setSelectedEntryIds([entry.id]);
      setSelectionAnchorId(entry.id);
      setSelectedEntry(entry.id);
    }
    entryMenu.open(event, { entryId: entry.id });
  };

  const sendEntryToTrack = async (
    entry: LibraryEntry,
    target: 'first-track-tail' | 'new-track',
  ) => {
    const editor = useEditorStore.getState();
    let trackId: string;
    if (target === 'new-track' || editor.tracks.length === 0) {
      trackId = editor.addTrack({ name: entry.title });
    } else {
      trackId = editor.tracks[0].id;
    }
    const tail =
      target === 'new-track'
        ? 0
        : Math.max(
            0,
            ...editor.clips
              .filter((c) => c.trackId === trackId)
              .map((c) => c.startSec + c.durationSec),
          );
    try {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      const { peaks, duration } = await computePeaks(blob, 240);
      // Re-read tracks after potential addTrack so we pick up the right color.
      const trackColor =
        useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#8b5cf6';
      const clipId = editor.addClipToTrack({
        trackId,
        label: entry.title,
        audioBlob: blob,
        mimeType: entry.mimeType,
        sourceDuration: duration || entry.duration,
        offsetIntoSource: 0,
        durationSec: duration || entry.duration,
        startSec: tail,
        color: trackColor,
        libraryEntryId: entry.id,
      });
      editor.cachePeaks(clipId, peaks);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('library', `Could not send to editor: ${msg}`);
    }
  };

  // One "send to editor" action — always appends as a new track at the
  // end of the timeline (the user collapsed the old append-to-track-1 +
  // new-track pair into a single button).
  const handleSendToNewTrack = (entry: LibraryEntry) => void sendEntryToTrack(entry, 'new-track');

  const patchGenParams = useGenerateParamsStore((s) => s.patch);

  const handleSendToInit = async (entry: LibraryEntry) => {
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    const file = new File([blob], entry.title, { type: entry.mimeType });
    patchGenParams({
      initAudioFile: file,
      initAudioEnabled: true,
      initAudioSourceLabel: null,
      initAudioSourceClipLabels: [],
    });
  };

  const handleSendSelectedToInit = () => {
    const targets = selectedEntries.length > 0
      ? selectedEntries
      : (() => {
          const ctxId = entryMenu.payload?.entryId;
          const ctxEntry = entries.find((entry) => entry.id === ctxId);
          return ctxEntry ? [ctxEntry] : [];
        })();
    if (targets.length === 0) return;

    void (async () => {
      const fetchBlob = useLibraryStore.getState().fetchAudioBlob;
      if (targets.length === 1) {
        await handleSendToInit(targets[0]);
      } else {
        const items = await Promise.all(
          targets.map(async (entry) => ({
            blob: await fetchBlob(entry),
            mimeType: entry.mimeType,
            label: entry.title,
          })),
        );
        addBlobsToChimera(items);
      }
      onSwitchTab?.('create');
      entryMenu.close();
    })();
  };

  const handleSendToInpaint = async (entry: LibraryEntry) => {
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    const file = new File([blob], entry.title, { type: entry.mimeType });
    patchGenParams({ inpaintAudioFile: file, inpaintEnabled: true, maskStart: 0, maskEnd: 0 });
  };

  // Handler invoked from StemsRunModal — applies the user's per-run
  // choices (writing them back as defaults if they ticked the checkbox)
  // and kicks the actual /api/stems/<id>/run with those query params.
  const onConfirmStemsModal = async (opts: StemsRunOptions) => {
    const modal = stemsModal;
    if (!modal) return;
    setStemsModal(null);
    if (opts.persistAsDefault) {
      // Fire-and-forget — backend persists to data/settings.json and the
      // feature store reconciles on next refresh. Don't block the run.
      void patchFeatures({
        stems: {
          default_count: opts.stems,
          device: opts.device,
          quality: opts.quality,
        },
      });
    } else {
      // Even when not persisting, set the in-memory store so the
      // existing runJobForEntry() (which reads from the store) picks up
      // the user's per-run choice without a backend round-trip.
      useFeatureToggleStore.setState((s) => ({
        settings: {
          ...s.settings,
          stems: {
            ...s.settings.stems,
            default_count: opts.stems,
            device: opts.device,
            quality: opts.quality,
          },
        },
      }));
    }
    await runJobForEntry(modal.entryId, 'stems');
  };

  // Picks a .mid file off disk and loads it straight into the piano roll
  // — gives the user a "MIDI IN" path that doesn't require running the
  // basic-pitch engine first. Reusable for any /mid file on disk.
  const onLoadMidiFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      loadMidiIntoPianoRoll(buf, 'piano-roll', file.name);
    } catch (e) {
      logError('library', `MIDI import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handlePlay = async (entry: LibraryEntry) => {
    // If this entry is already loaded in the global engine, just toggle play/pause.
    if (engineEntryId === entry.id) {
      if (engineIsPlaying) {
        enginePause();
        setPlayingId(null);
      } else {
        enginePlay();
        setPlayingId(entry.id);
      }
      return;
    }
    // Otherwise load and play through the global engine — visualizer + footer follow.
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    await engineLoad(blob, { label: entry.title, entryId: entry.id });
    enginePlay();
    setPlayingId(entry.id);
  };

  // Compact analytics strip at the very top of the panel — the user
  // wanted the prior "LIBRARY ANALYSIS" section's stats hoisted up
  // here as small chip-style features instead of taking up real
  // estate at the bottom of the panel.
  const totalSize = entries.reduce((s, e) => s + e.fileSizeBytes, 0);
  const totalDur = entries.reduce((s, e) => s + e.duration, 0);
  const favCount = entries.filter((e) => e.favorite).length;

  return (
    // The panel itself does NOT scroll (overflow-hidden); the upper region
    // (stats + LIBRARY header + search + filters + sub-tabs) stays pinned and
    // ONLY the per-tab list region scrolls (see the scroll wrapper below).
    // h-full + min-h-0 let the flex parent collapse so the fill chain works
    // inside the right rail without clipping the always-on Log section.
    <div className="flex flex-col gap-2 h-full min-h-0 overflow-hidden text-[11px] pb-2 px-2 pt-2">

      {/* Top stats strip — compact "features" version of the old
          LIBRARY ANALYSIS section. */}
      <div className="shrink-0 flex items-center gap-1 flex-wrap text-[8px] font-mono uppercase tracking-widest text-zinc-500 pb-1 border-b border-white/5">
        <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">
          <span className="text-zinc-300">{entries.length}</span> entries
        </span>
        <span className="px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/20">
          <Star className="w-2 h-2 fill-current inline-block text-yellow-400 -mt-0.5" />{' '}
          <span className="text-yellow-200">{favCount}</span>
        </span>
        <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">
          <span className="text-zinc-300">{formatSize(totalSize)}</span>
        </span>
        <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">
          <span className="text-zinc-300">{formatDuration(totalDur)}</span>
        </span>
      </div>

      {/* Stems running banner. Shows live phase + progress + an Abort
          button so the user can bail without right-click-finding the
          original entry. */}
      {runningKind?.kind === 'stems' && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-purple-500/40 bg-purple-500/15 text-[10px] font-mono">
          <Loader2 className="w-3 h-3 text-purple-300 animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-purple-200 truncate">
              Stems · {runningKind.id.slice(0, 8)} · {stemsBanner?.phase ?? '…'}
              {typeof stemsBanner?.progress === 'number' && stemsBanner.progress > 0
                ? ` · ${Math.round(stemsBanner.progress)}%`
                : ''}
            </div>
            {stemsBanner?.message && (
              <div className="text-[8px] text-zinc-400 truncate">{stemsBanner.message}</div>
            )}
          </div>
          <button
            onClick={() => void abortStems()}
            className="shrink-0 text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15"
            title="Abort the running stem separation"
          >
            Abort
          </button>
        </div>
      )}

      {/* Stems pre-run modal — picks count / device / quality, optionally
          saves them as the new defaults, then kicks runJobForEntry. */}
      <StemsRunModal
        open={stemsModal !== null}
        entryLabel={stemsModal?.entryTitle}
        onCancel={() => setStemsModal(null)}
        onConfirm={(opts) => void onConfirmStemsModal(opts)}
      />

      {/* Hidden file picker — used by the "Import MIDI" toolbar button.
          Drives loadMidiIntoPianoRoll() so users can pull a .mid off
          disk straight into the piano roll without running basic-pitch.
          `multiple` lets the user batch-import several .mid files in
          one go; each is loaded sequentially. */}
      <input
        ref={midiFileInputRef}
        type="file"
        name="library-import-midi"
        accept=".mid,.midi,audio/midi"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          for (const file of files) void onLoadMidiFile(file);
          // Reset so picking the same file(s) twice re-fires onChange.
          e.target.value = '';
        }}
      />

      <Section title="LIBRARY" icon={Database} defaultOpen={true} resizable={false} collapsible={false} fill maxContentHeight={null} rightNode={
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <span className="text-[8px] font-mono text-zinc-600">{entries.length} TRACKS</span>
          {/* Mic-in toggle removed per spec — the MicRecorder lives
              on EDIT + VJ now, not Library. */}
          <button
            onClick={() => midiFileInputRef.current?.click()}
            className="p-1 rounded text-zinc-500 hover:text-purple-300"
            title="Import a .mid file → piano roll"
          >
            <FileMusic className="w-3 h-3" />
          </button>
          <button onClick={() => setViewMode('list')} className={`p-1 rounded ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-zinc-600'}`} title="List view">
            <ListIcon className="w-3 h-3" />
          </button>
          <button onClick={() => setViewMode('grid')} className={`p-1 rounded ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-600'}`} title="Grid view">
            <LayoutGrid className="w-3 h-3" />
          </button>
          {onExpand && (
            <button onClick={onExpand} className="p-1 rounded text-zinc-500 hover:text-teal-300" title="Expand to full library">
              <Maximize2 className="w-3 h-3" />
            </button>
          )}
        </div>
      }>
        {/* Mic-in recorder. Hidden by default; toggled from the LIBRARY
            header. Saving to library triggers a refresh so the recording
            shows up immediately as a fresh import entry. */}
        {micOpen && (
          <div className="mb-2">
            <MicRecorder
              embedded
              onClose={() => setMicOpen(false)}
            />
          </div>
        )}

        <div className="shrink-0 flex flex-col gap-2 mb-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
            <input
              id="library-search"
              name="library-search"
              type="search"
              className="compact-input w-full pl-7"
              placeholder="SEARCH titles / prompts / tags / model / bpm / key / genre…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search the library"
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
            <button
              className={`mono-tag flex items-center gap-1 whitespace-nowrap ${onlyFavorites ? 'bg-purple-600/20! text-purple-300! border-purple-500/40!' : 'bg-white/5! text-zinc-400!'}`}
              onClick={() => setOnlyFavorites(!onlyFavorites)}
            >
              <Star className="w-2 h-2 fill-current" /> FAVS
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'newest' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('newest')}>
              <Clock className="w-2 h-2" /> NEWEST
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'duration' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('duration')}>
              <Tag className="w-2 h-2" /> LENGTH
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'title' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('title')}>
              <Filter className="w-2 h-2" /> TITLE
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'plays' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('plays')}>
              <Play className="w-2 h-2" /> PLAYS
            </button>
            <button className="mono-tag flex items-center gap-1 whitespace-nowrap bg-purple-600/30! text-purple-200! border border-purple-500/40" onClick={() => setSuggestOpen(true)} title="Suggest a playlist from your library">
              <Sparkles className="w-2 h-2" /> SUGGEST
            </button>
          </div>
        </div>

        {/* Sub-tabs: Tracks / Stems / MIDI / Video / Score — text-only per
            spec, no icons; GRAPH button removed (use the LEARN tab for the
            lineage graph instead). overflow-x-auto so the row never wraps and
            stays a single sticky strip above the scrolling lists. */}
        <div className="shrink-0 flex items-center gap-1 mb-2 border-b border-white/5 pb-1 overflow-x-auto no-scrollbar">
          <SubTabButton active={subTab === 'tracks'} onClick={() => setSubTab('tracks')}>
            Tracks ({entries.length})
          </SubTabButton>
          <SubTabButton active={subTab === 'stems'} onClick={() => setSubTab('stems')}>
            Stems ({allStems?.length ?? '…'})
          </SubTabButton>
          <SubTabButton active={subTab === 'midi'} onClick={() => setSubTab('midi')}>
            MIDI ({allMidis?.length ?? '…'})
          </SubTabButton>
          <SubTabButton active={subTab === 'video'} onClick={() => setSubTab('video')}>
            Video ({mediaEntries?.length ?? '…'})
          </SubTabButton>
          <SubTabButton active={subTab === 'score'} onClick={() => setSubTab('score')}>
            Score ({allScores?.length ?? '…'})
          </SubTabButton>
        </div>

        {/* THE scroll region: only the per-tab lists scroll; everything
            above (stats / search / filters / sub-tab strip) stays pinned. */}
        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col">

        {subTab === 'tracks' && (<>
        {/* Icon-only top-level actions toolbar (user request 2026-05-28).
            All actions operate on selectedEntries; SELECT toggles
            select-all-visible. Tooltips on hover (title attr) — names
            are not visible inline. */}
        <LibraryActionsToolbar
          selectedEntries={selectedEntries}
          visibleEntries={filteredEntries}
          allEntries={entries}
          onToggleSelectAll={() => {
            const visIds = filteredEntries.map((e) => e.id);
            const allVisSelected = visIds.length > 0 && visIds.every((id) => selectedEntryIds.includes(id));
            setSelectedEntryIds(allVisSelected ? [] : visIds);
            setSelectionAnchorId(allVisSelected ? null : visIds[0] ?? null);
          }}
          onDeleteSelected={async () => {
            const targets = selectedEntries.length > 0 ? selectedEntries : [];
            if (targets.length === 0) return;
            const ok = window.confirm(
              `Delete ${targets.length} entr${targets.length === 1 ? 'y' : 'ies'} from disk? This cannot be undone.`,
            );
            if (!ok) return;
            const { deleted, failed } = await useLibraryStore.getState().removeMany(targets.map((t) => t.id));
            window.alert(`Removed ${deleted} entr${deleted === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} failed` : ''}.`);
            setSelectedEntryIds([]);
          }}
          onFuseSelected={handleSendSelectedToInit}
          onInpaintSelected={() => {
            const target = selectedEntries[0];
            if (!target) return;
            void handleSendToInpaint(target);
            onSwitchTab?.('create');
          }}
          onClearNonFavorites={async () => {
            const targets = entries.filter((e) => !e.favorite);
            if (targets.length === 0) return;
            const ok = window.confirm(
              `Delete ${targets.length} non-favorite entr${targets.length === 1 ? 'y' : 'ies'} from disk? Favorites and their audio files are kept.`,
            );
            if (!ok) return;
            const { deleted, failed } = await useLibraryStore.getState().removeMany(targets.map((t) => t.id));
            window.alert(`Removed ${deleted} entr${deleted === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} failed` : ''}.`);
          }}
          onClearAll={async () => {
            const ok = window.confirm(
              `Delete ALL ${entries.length} library entr${entries.length === 1 ? 'y' : 'ies'} including favorites from disk?\n\nThis cannot be undone.`,
            );
            if (!ok) return;
            const { deleted, failed } = await useLibraryStore.getState().clearAll();
            window.alert(`Removed ${deleted} entr${deleted === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} failed` : ''}.`);
          }}
        />
        <div className="flex items-center justify-between px-1 mb-1 text-[8px] font-mono text-zinc-600 uppercase border-b border-white/5 pb-1">
          <button className="flex items-center gap-1 hover:text-zinc-300" onClick={() => setSortBy('title')}>
            <ArrowUpDown className="w-2 h-2" /> NAME
          </button>
          <div className="flex gap-4">
            <span>MODEL</span>
            <span>LEN</span>
            <span>DATE</span>
          </div>
        </div>

        <div className={viewMode === 'list' ? 'flex flex-col gap-1' : 'grid grid-cols-2 gap-2'}>
          {filteredEntries.map((entry) => (
            <div
              key={entry.id}
              data-library-entry-id={entry.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-thedaw-library-id', entry.id);
                e.dataTransfer.setData('text/plain', entry.title);
                e.dataTransfer.effectAllowed = 'copyMove';
                const dragItems = selectedEntryIds.includes(entry.id) && selectedEntries.length > 1
                  ? selectedEntries
                  : [entry];
                const fetchBlob = useLibraryStore.getState().fetchAudioBlob;
                setAudioDragData(e, dragItems.map((en) => ({
                  fetcher: () => fetchBlob(en),
                  mimeType: en.mimeType,
                  label: en.title,
                  entryId: en.id,
                })));
              }}
              onClick={(e) => handleSelectEntry(entry, e)}
              onContextMenu={(e) => handleEntryContextMenu(e, entry)}
              className={`hardware-card p-0! group cursor-grab active:cursor-grabbing transition-all hover:bg-white/4
                ${selectedEntryIds.includes(entry.id) || selectedEntryId === entry.id ? 'ring-1 ring-purple-500/60 bg-purple-500/6' : ''}
                ${viewMode === 'list' ? 'flex-row items-center p-1' : 'aspect-square flex-col'}`}
              title="Click to inspect metadata. Drag onto a Waveform Editor track."
            >
              {viewMode === 'grid' && (
                <div className="flex-1 bg-black/40 flex items-center justify-center relative">
                  <Music className="w-6 h-6 text-zinc-800" />
                  <button
                    className="absolute top-1 right-1 p-1 bg-black/80 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handlePlay(entry)}
                  >
                    {engineEntryId === entry.id && engineIsPlaying ? <Pause className="w-3 h-3 text-purple-300" /> : <Play className="w-3 h-3 text-zinc-300" />}
                  </button>
                </div>
              )}

              <div className={`p-1.5 flex flex-col gap-0.5 ${viewMode === 'list' ? 'flex-1 min-w-0' : ''}`}>
                <div className="flex items-center justify-between overflow-hidden gap-2">
                  <span className="font-bold text-[10px] truncate pr-2 text-zinc-200" title={entry.title}>
                    {entry.title}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); void toggleFavorite(entry.id); }}
                    className="shrink-0"
                    title={entry.favorite ? 'Unfavorite' : 'Favorite'}
                  >
                    <Star className={`w-2.5 h-2.5 ${entry.favorite ? 'text-yellow-500 fill-current' : 'text-zinc-700'}`} />
                  </button>
                </div>
                {entry.prompt && (
                  <span className="mono-label text-[8px]! text-zinc-500! truncate" title={entry.prompt}>
                    {entry.prompt}
                  </span>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[8px] font-mono text-purple-400/80 uppercase tracking-wider">{entry.model}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    {(entry.playCount ?? 0) > 0 && (
                      <span className="text-[8px] font-mono text-purple-300/70 flex items-center gap-0.5" title={`Played ${entry.playCount}x`}>
                        <Play className="w-2 h-2 fill-current" />{entry.playCount}
                      </span>
                    )}
                    <span className="text-[8px] font-mono text-zinc-600">{formatDuration(entry.duration)}</span>
                    <span className="text-[8px] font-mono text-zinc-700">{formatDate(entry.timestamp)}</span>
                    <span className="text-[8px] font-mono text-zinc-700">{formatSize(entry.fileSizeBytes)}</span>
                    {viewMode === 'list' && (
                      <div className="flex gap-1">
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); handlePlay(entry); }}
                          title={engineEntryId === entry.id && engineIsPlaying ? 'Pause' : 'Play'}
                        >
                          {engineEntryId === entry.id && engineIsPlaying ? <Pause className="w-2.5 h-2.5 text-purple-400" /> : <Play className="w-2.5 h-2.5 text-zinc-400 group-hover:text-purple-400" />}
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); handleSendToNewTrack(entry); }}
                          title="Send to editor as a new track"
                        >
                          <Layers className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); handleSendToInit(entry); }}
                          title="Send to Init audio"
                        >
                          <Wand2 className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); handleSendToInpaint(entry); }}
                          title="Send to Inpaint"
                        >
                          <PenLine className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); downloadEntry(entry, getAudioUrl(entry)); }}
                          title="Download"
                        >
                          <Download className="w-2.5 h-2.5 text-zinc-600 hover:text-white" />
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete "${entry.title}"?`)) void removeEntry(entry.id);
                          }}
                          title="Delete"
                        >
                          <Trash2 className="w-2.5 h-2.5 text-zinc-600 hover:text-red-400" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {filteredEntries.length === 0 && (
          <div className="py-8 flex flex-col items-center justify-center opacity-30 italic gap-2">
            <Database className="w-8 h-8" />
            {entries.length === 0 ? (
              <>
                <p>Library is empty.</p>
                <button
                  className="mono-tag bg-purple-600/20! text-purple-300! border-purple-500/40! cursor-pointer"
                  onClick={() => onSwitchTab?.('create')}
                >
                  Go generate something
                </button>
              </>
            ) : (
              <p>No entries match your filter.</p>
            )}
          </div>
        )}
        </>)}

        {subTab === 'stems' && (
          <SubTabList
            byParent={stemsByParent}
            parentTitles={Object.fromEntries(entries.map((e) => [e.id, e.title]))}
            kind="stem"
            placeholder={allStems === null ? 'Loading stems…' : 'No stems yet. Enable auto-stems in Settings or right-click a track → Separate stems.'}
            onMutated={refreshStems}
          />
        )}
        {subTab === 'midi' && (
          <SubTabList
            byParent={midisByParent}
            parentTitles={Object.fromEntries(entries.map((e) => [e.id, e.title]))}
            kind="midi"
            placeholder={allMidis === null ? 'Loading MIDI…' : 'No MIDI yet. Enable auto-MIDI in Settings or right-click a track → Convert to MIDI.'}
            onMutated={refreshMidi}
          />
        )}
        {subTab === 'video' && (
          <MediaGrid
            entries={mediaEntries}
            onChanged={refreshMedia}
          />
        )}
        {subTab === 'score' && (
          <ScoreList
            byParent={scoresByParent}
            parentTitles={Object.fromEntries(entries.map((e) => [e.id, e.title]))}
            placeholder={allScores === null
              ? 'Loading scores…'
              : 'No scores yet. Open a track → Score and use MAKE SHEET / MAKE TABS / ARRANGE.'}
            onOpen={openScoreForEntry}
            onRefresh={refreshScores}
          />
        )}
        </div>
      </Section>

      {(() => {
        const ctxEntryId = entryMenu.payload?.entryId;
        if (!ctxEntryId) return null;
        // Captured while the parent menu is open; the convert picker reopens here
        // (onSelect runs after the parent menu has already closed itself).
        const ctxPos = entryMenu.position;
        const isRunning = (k: 'analysis' | 'stems' | 'midi') =>
          runningKind?.id === ctxEntryId && runningKind?.kind === k;
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: 'Send selected to Init',
            icon: <Wand2 className="w-3 h-3" />,
            hint: selectedEntries.length > 1 ? `${selectedEntries.length} → Chimera` : 'single',
            disabled: selectedEntries.length === 0,
            onSelect: handleSendSelectedToInit,
          },
          { type: 'separator' },
          {
            type: 'item',
            label: isRunning('analysis') ? 'Running analysis…' : 'Run analysis',
            icon: isRunning('analysis')
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Activity className="w-3 h-3" />,
            hint: 'bpm/key/pitch',
            disabled: isRunning('analysis'),
            onSelect: () => { void runJobForEntry(ctxEntryId, 'analysis'); },
          },
          {
            type: 'item',
            label: isRunning('stems') ? 'Running stems…' : 'Separate stems…',
            icon: isRunning('stems')
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Scissors className="w-3 h-3" />,
            hint: 'demucs',
            disabled: isRunning('stems'),
            onSelect: () => {
              const title = entries.find((e) => e.id === ctxEntryId)?.title ?? ctxEntryId;
              setStemsModal({ entryId: ctxEntryId, entryTitle: title });
            },
          },
          {
            type: 'item',
            label: isRunning('midi') ? 'Running MIDI…' : 'Convert to MIDI',
            icon: isRunning('midi')
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <FileMusic className="w-3 h-3" />,
            hint: 'basic-pitch',
            disabled: isRunning('midi'),
            onSelect: () => { void runJobForEntry(ctxEntryId, 'midi'); },
          },
          {
            type: 'item',
            label: 'Open Score / Notation',
            icon: <FileMusic className="w-3 h-3" />,
            hint: 'MusicXML',
            onSelect: () => openScoreForEntry(ctxEntryId),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Download audio',
            icon: <Download className="w-3 h-3" />,
            hint: 'file',
            onSelect: () => {
              const title = entries.find((e) => e.id === ctxEntryId)?.title ?? ctxEntryId;
              const a = document.createElement('a');
              a.href = `/api/library/${ctxEntryId}/audio`;
              a.download = title;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            },
          },
          {
            type: 'item',
            label: 'Convert to…',
            icon: <Repeat className="w-3 h-3" />,
            hint: 'ffmpeg',
            onSelect: () => {
              const title = entries.find((e) => e.id === ctxEntryId)?.title ?? ctxEntryId;
              if (ctxPos) convertMenu.openAt(ctxPos, { entryId: ctxEntryId, title, kind: 'audio' });
            },
          },
          {
            type: 'item',
            label: 'Download bundle',
            icon: <Package className="w-3 h-3" />,
            hint: '.zip+scores',
            onSelect: () => {
              const a = document.createElement('a');
              a.href = `/api/library/${ctxEntryId}/bundle`;
              a.download = '';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            },
          },
          {
            type: 'item',
            label: 'Show lineage',
            icon: <Network className="w-3 h-3" />,
            hint: 'graph',
            onSelect: () => setLineageOpen(ctxEntryId),
          },
        ];
        return (
          <ContextMenu
            position={entryMenu.position}
            onClose={entryMenu.close}
            items={items}
            title={selectedEntries.length > 1 ? `${selectedEntries.length} selected` : '1 selected'}
            minWidth="13rem"
          />
        );
      })()}

      {convertMenu.element}

      <LineageModal
        open={lineageOpen !== null}
        rootEntryId={lineageOpen === '__library__' ? null : lineageOpen}
        onClose={() => setLineageOpen(null)}
      />

      <SuggestPlaylistModal open={suggestOpen} onClose={() => setSuggestOpen(false)} />

      {/* Maintenance actions (Clear Non-Favorites / Clear All) moved
          into the icon toolbar's OPTIONS submenu per user request
          2026-05-28. Section removed entirely. */}

    </div>
  );
};


interface LibraryActionsToolbarProps {
  selectedEntries: LibraryEntry[];
  visibleEntries: LibraryEntry[];
  allEntries: LibraryEntry[];
  onToggleSelectAll: () => void;
  onDeleteSelected: () => void | Promise<void>;
  onFuseSelected: () => void;
  onInpaintSelected: () => void;
  onClearNonFavorites: () => void | Promise<void>;
  onClearAll: () => void | Promise<void>;
}

/** Icon-only top-level library actions bar. Names render as tooltips
 *  only (mouseover). DOWNLOAD + OPTIONS open ContextMenu submenus
 *  anchored to the click. Empty selection disables destructive actions
 *  (delete / fuse / inpaint) but leaves SELECT / DOWNLOAD / OPTIONS
 *  usable so the user can act on the visible set without selecting
 *  first. */
const LibraryActionsToolbar: React.FC<LibraryActionsToolbarProps> = ({
  selectedEntries,
  visibleEntries,
  allEntries,
  onToggleSelectAll,
  onDeleteSelected,
  onFuseSelected,
  onInpaintSelected,
  onClearNonFavorites,
  onClearAll,
}) => {
  const downloadMenu = useContextMenu<'download'>();
  const optionsMenu = useContextMenu<'options'>();
  const selCount = selectedEntries.length;
  const hasSelection = selCount > 0;
  const visIds = visibleEntries.map((e) => e.id);
  const selectedIds = new Set(selectedEntries.map((e) => e.id));
  const allVisibleSelected = visIds.length > 0 && visIds.every((id) => selectedIds.has(id));

  // For DOWNLOAD: the target set is selectedEntries when populated,
  // otherwise the full visible set (so the user gets a "bulk download
  // everything on screen" affordance without having to click SELECT
  // first). DELETE always requires explicit selection — too destructive
  // to default-target the visible set.
  const downloadTargets = hasSelection ? selectedEntries : visibleEntries;

  const downloadAll = (kind: 'song' | 'midi' | 'json' | 'bundle' | 'lineage') => {
    for (const entry of downloadTargets) {
      const a = document.createElement('a');
      if (kind === 'song') {
        // The entry's audio blob lives at this server-relative URL.
        a.href = `/api/library/${entry.id}/audio`;
        a.download = entry.title;
      } else if (kind === 'midi') {
        a.href = `/api/midi/file/${entry.id}`;
        a.download = `${entry.title}.mid`;
      } else if (kind === 'bundle') {
        a.href = `/api/library/${entry.id}/bundle`;
        a.download = `${entry.title}.zip`;
      } else if (kind === 'lineage') {
        a.href = `/api/library/${entry.id}/lineage?depth=8`;
        a.download = `${entry.title}-lineage.json`;
      } else if (kind === 'json') {
        // Build a metadata JSON client-side from what the store already
        // has cached — no backend round-trip. If the user needs the
        // server's canonical view they can use Bundle.
        const blob = new Blob([JSON.stringify(entry, null, 2)], {
          type: 'application/json',
        });
        a.href = URL.createObjectURL(blob);
        a.download = `${entry.title}.json`;
      }
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (kind === 'json') {
        // Revoke after a beat so the browser actually triggers the save.
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
    }
  };

  const downloadItems: ContextMenuItem[] = [
    { type: 'header', label: `${downloadTargets.length} ${hasSelection ? 'selected' : 'visible'}` },
    {
      type: 'item',
      label: 'Songs (audio file)',
      icon: <Music className="w-3 h-3" />,
      hint: downloadTargets.length > 0 ? `${downloadTargets.length} files` : undefined,
      disabled: downloadTargets.length === 0,
      onSelect: () => downloadAll('song'),
    },
    {
      type: 'item',
      label: 'MIDI (.mid)',
      icon: <FileMusic className="w-3 h-3" />,
      disabled: downloadTargets.length === 0,
      onSelect: () => downloadAll('midi'),
    },
    {
      type: 'item',
      label: 'Metadata JSON',
      icon: <FileText className="w-3 h-3" />,
      disabled: downloadTargets.length === 0,
      onSelect: () => downloadAll('json'),
    },
    {
      type: 'item',
      label: 'Bundle (.zip)',
      icon: <Package className="w-3 h-3" />,
      hint: 'audio+meta+midi',
      disabled: downloadTargets.length === 0,
      onSelect: () => downloadAll('bundle'),
    },
    {
      type: 'item',
      label: 'Lineage report',
      icon: <Network className="w-3 h-3" />,
      hint: 'JSON graph',
      disabled: downloadTargets.length === 0,
      onSelect: () => downloadAll('lineage'),
    },
  ];

  const optionsItems: ContextMenuItem[] = [
    { type: 'header', label: 'Library maintenance' },
    {
      type: 'item',
      label: `Clear non-favorites (${allEntries.filter((e) => !e.favorite).length})`,
      icon: <Trash2 className="w-3 h-3" />,
      disabled: allEntries.filter((e) => !e.favorite).length === 0,
      onSelect: () => void onClearNonFavorites(),
    },
    {
      type: 'item',
      label: `Clear ALL (${allEntries.length})`,
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      disabled: allEntries.length === 0,
      onSelect: () => void onClearAll(),
    },
  ];

  const baseBtn =
    'p-1.5 rounded border transition-colors flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none';
  const idleBtn = `${baseBtn} border-white/5 text-zinc-400 hover:text-zinc-100 hover:bg-white/5`;
  const activeBtn = `${baseBtn} border-purple-500/40 text-purple-200 bg-purple-500/10 hover:bg-purple-500/20`;
  const dangerBtn = `${baseBtn} border-red-500/30 text-red-300 hover:bg-red-500/15`;

  return (
    <div className="flex items-center justify-between gap-1 px-1 mb-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleSelectAll}
          className={allVisibleSelected ? activeBtn : idleBtn}
          title={
            allVisibleSelected
              ? 'Clear selection'
              : `Select all visible (${visIds.length})`
          }
          aria-label="Select all visible"
        >
          {allVisibleSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={(e) => downloadMenu.open(e, 'download')}
          className={idleBtn}
          title={`Download${hasSelection ? ` (${selCount} selected)` : ' (visible)'}…`}
          aria-label="Download menu"
        >
          <Download className="w-3.5 h-3.5" />
          <ChevronDown className="w-2.5 h-2.5 opacity-60" />
        </button>
        <button
          type="button"
          onClick={() => void onDeleteSelected()}
          disabled={!hasSelection}
          className={hasSelection ? dangerBtn : idleBtn}
          title={hasSelection ? `Delete ${selCount} selected` : 'Delete (select tracks first)'}
          aria-label="Delete selected"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onFuseSelected}
          disabled={!hasSelection}
          className={idleBtn}
          title={
            hasSelection
              ? selCount === 1
                ? 'FUSE: Send to Init'
                : `FUSE: Chimera-stack ${selCount} selected`
              : 'FUSE (select tracks first)'
          }
          aria-label="Fuse selected"
        >
          <Combine className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onInpaintSelected}
          disabled={!hasSelection}
          className={idleBtn}
          title={
            hasSelection
              ? selCount > 1
                ? 'INPAINT (first selected only)'
                : 'INPAINT this track'
              : 'INPAINT (select a track first)'
          }
          aria-label="Inpaint selected"
        >
          <Paintbrush className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => optionsMenu.open(e, 'options')}
          className={idleBtn}
          title="More options…"
          aria-label="More options"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>
      <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600 pr-1">
        {hasSelection ? `${selCount}/${visIds.length} sel` : `${visIds.length} shown`}
      </span>

      <ContextMenu
        position={downloadMenu.position}
        onClose={downloadMenu.close}
        items={downloadItems}
        title="Download"
        minWidth="14rem"
      />
      <ContextMenu
        position={optionsMenu.position}
        onClose={optionsMenu.close}
        items={optionsItems}
        title="Options"
        minWidth="14rem"
      />
    </div>
  );
};


interface SubTabButtonProps {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

const SubTabButton: React.FC<SubTabButtonProps> = ({ active, onClick, icon, children }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
      active
        ? 'bg-purple-500/15 border-purple-500/40 text-purple-200'
        : 'border-white/5 text-zinc-500 hover:text-zinc-300'
    }`}
  >
    {icon}
    {children}
  </button>
);


/* ═══════════════════════════════ MediaGrid ════════════════════════════════ */

/** VJ video library: a thumbnail grid of imported video/image entries with
 *  an import button. Videos and alpha-capable media (transparent PNG/WebP,
 *  alpha WebM) are badged so overlay-capable clips are identifiable. Entries
 *  persist server-side, so the VJ cue survives reloads once routed here. */
const MediaGrid: React.FC<{
  entries: LibraryEntry[] | null;
  onChanged: () => Promise<void>;
}> = ({ entries, onChanged }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const mediaMenu = useContextMenu<LibraryEntry>();
  const convertMenu = useConvertMenu({
    onStart: (m) => logInfo('library', m),
    onError: (m) => logError('library', m),
  });

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    let ok = 0;
    let failed = 0;
    for (const file of Array.from(files)) {
      try {
        await importMedia(file);
        ok += 1;
      } catch (e) {
        failed += 1;
        logError('library', `Media import failed for ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setUploading(false);
    if (ok) logInfo('library', `Imported ${ok} media file${ok === 1 ? '' : 's'} into the library.`);
    await onChanged();
  };

  const onRemove = async (entry: LibraryEntry) => {
    try {
      await deleteMedia(entry.id);
      await onChanged();
    } catch (e) {
      logError('library', `Media delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const sendToVj = (entry: LibraryEntry) => {
    sendTrackToVj({
      entryId: entry.id,
      label: entry.title,
      url: entry.mediaUrl ?? entry.audioUrl,
      kind: entry.kind === 'image' ? 'image' : 'video',
    });
    logInfo('library', `Sent "${entry.title}" to the VJ.`);
  };

  const ctxEntry = mediaMenu.payload;
  const ctxPos = mediaMenu.position;
  const menuItems: ContextMenuItem[] = ctxEntry
    ? [
        {
          type: 'item',
          label: 'Send to VJ',
          icon: <Film className="w-3 h-3" />,
          hint: 'live visuals',
          onSelect: () => sendToVj(ctxEntry),
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Download',
          icon: <Download className="w-3 h-3" />,
          onSelect: () => {
            const a = document.createElement('a');
            a.href = ctxEntry.mediaUrl ?? ctxEntry.audioUrl;
            a.download = ctxEntry.title;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          },
        },
        {
          type: 'item',
          label: 'Convert to…',
          icon: <Repeat className="w-3 h-3" />,
          hint: 'ffmpeg',
          onSelect: () => {
            if (ctxPos) {
              convertMenu.openAt(ctxPos, {
                entryId: ctxEntry.id,
                title: ctxEntry.title,
                kind: ctxEntry.kind ?? 'video',
              });
            }
          },
        },
        {
          type: 'item',
          label: 'Copy media link',
          icon: <FileText className="w-3 h-3" />,
          onSelect: () => {
            void navigator.clipboard?.writeText(
              new URL(ctxEntry.mediaUrl ?? ctxEntry.audioUrl, window.location.origin).toString(),
            );
          },
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Delete',
          icon: <Trash2 className="w-3 h-3" />,
          danger: true,
          onSelect: () => { void onRemove(ctxEntry); },
        },
      ]
    : [];

  return (
    <div className="px-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[9px] font-mono text-zinc-600">
          Videos and images for the VJ tab. Transparent media can act as overlays.
        </span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[9px] font-black uppercase tracking-widest border border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25 disabled:opacity-50 transition-colors"
        >
          {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          {uploading ? 'Importing…' : 'Import media'}
        </button>
        <label htmlFor="media-import-input" className="sr-only">Import video or image files</label>
        <input
          ref={fileInputRef}
          id="media-import-input"
          name="media-import-input"
          type="file"
          accept={MEDIA_ACCEPT}
          multiple
          hidden
          onChange={(e) => { void onPick(e.target.files); e.target.value = ''; }}
        />
      </div>

      {entries === null ? (
        <div className="flex items-center gap-2 text-[10px] text-zinc-500 py-8 justify-center">
          <Loader2 size={12} className="animate-spin" /> Loading media…
        </div>
      ) : entries.length === 0 ? (
        <div className="text-[10px] text-zinc-600 py-8 text-center">
          No media yet. Import videos or images, or load clips in the VJ tab — they are saved here.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {entries.map((entry) => (
            <MediaCard
              key={entry.id}
              entry={entry}
              onRemove={() => onRemove(entry)}
              onSendToVj={() => sendToVj(entry)}
              onContextMenu={(e) => mediaMenu.open(e, entry)}
            />
          ))}
        </div>
      )}

      <ContextMenu
        position={mediaMenu.position}
        onClose={mediaMenu.close}
        items={menuItems}
        title={ctxEntry ? ctxEntry.title : ''}
      />
      {convertMenu.element}
    </div>
  );
};

const MediaCard: React.FC<{
  entry: LibraryEntry;
  onRemove: () => void;
  onSendToVj: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}> = ({ entry, onRemove, onSendToVj, onContextMenu }) => {
  const isVideo = entry.kind === 'video';
  const mediaUrl = entry.mediaUrl ?? entry.audioUrl;
  return (
    <div
      className="group relative rounded-lg overflow-hidden border border-white/8 bg-black/40"
      draggable
      onContextMenu={onContextMenu}
      title="Drag onto the VJ tab to add it · right-click for actions"
      onDragStart={(e) => {
        // Stable URL so a drop target (the VJ tab's drop zone, or any
        // consumer) can reference the persisted file rather than a session blob.
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/uri-list', mediaUrl);
        e.dataTransfer.setData(
          'application/x-thedaw-media',
          JSON.stringify({
            id: entry.id,
            url: mediaUrl,
            kind: entry.kind ?? 'video',
            name: entry.title,
            hasAlpha: !!entry.hasAlpha,
          }),
        );
      }}
    >
      <div className="aspect-video bg-black/60 flex items-center justify-center overflow-hidden">
        {entry.thumbUrl ? (
          <img
            src={entry.thumbUrl}
            alt={`Thumbnail for ${entry.title}`}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="text-zinc-700">
            {isVideo ? <Film size={28} /> : <ImageIcon size={28} />}
          </div>
        )}
      </div>

      {/* Badges */}
      <div className="absolute top-1 left-1 flex items-center gap-1">
        <span className="flex items-center gap-1 px-1 py-0.5 rounded bg-black/70 text-[8px] font-black uppercase tracking-wider text-zinc-300">
          {isVideo ? <Film size={9} /> : <ImageIcon size={9} />}
          {isVideo ? 'Video' : 'Image'}
        </span>
        {entry.hasAlpha && (
          <span
            className="px-1 py-0.5 rounded bg-fuchsia-500/30 text-[8px] font-black uppercase tracking-wider text-fuchsia-200"
            title="Transparent — usable as an overlay"
          >
            Alpha
          </span>
        )}
      </div>

      {/* Action buttons — top-right corner so they never sit under the
          duration badge (bottom-right). Hover-revealed; dark pill so the
          icons read over any thumbnail. */}
      <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-black/70 px-0.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSendToVj(); }}
          aria-label={`Send ${entry.title} to the VJ`}
          title="Send to VJ"
          className="p-0.5 rounded text-fuchsia-300 hover:text-fuchsia-100 hover:bg-white/10"
        >
          <Tv2 size={12} />
        </button>
        <a
          href={mediaUrl}
          download={entry.title}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Download ${entry.title}`}
          title="Download"
          className="p-0.5 rounded text-zinc-300 hover:text-white hover:bg-white/10"
        >
          <Download size={12} />
        </a>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label={`Remove ${entry.title} from the media library`}
          className="p-0.5 rounded text-zinc-300 hover:text-red-400 hover:bg-white/10"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {isVideo && entry.duration > 0 && (
        <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/70 text-[8px] font-mono text-zinc-300">
          {formatDuration(entry.duration)}
        </span>
      )}

      {/* Footer: title */}
      <div className="px-1.5 py-1">
        <span className="text-[9px] text-zinc-300 truncate block" title={entry.title}>{entry.title}</span>
      </div>
    </div>
  );
};


interface SubTabListProps {
  byParent: Record<string, Array<Record<string, unknown>>>;
  parentTitles: Record<string, string>;
  kind: 'stem' | 'midi';
  placeholder: string;
  /** Re-fetch the index in place after a favorite toggle or delete. */
  onMutated: () => void | Promise<void>;
}

type SubTabRowPayload =
  | { kind: 'midi'; midiId: string; label: string }
  | { kind: 'stem'; row: Record<string, unknown> };

/**
 * One stem/MIDI row, memoized so opening the right-click menu (or any other
 * parent state change) doesn't re-render the whole hundreds-of-rows list — that
 * full re-render was the 600ms+ contextmenu/mousedown jank. Props are stable
 * (the row object, plus stable callbacks), so React.memo skips untouched rows.
 */
const SubTabRow = React.memo<{
  row: Record<string, unknown>;
  isMidi: boolean;
  parentTitle: string;
  isPlaying: boolean;
  isBusy: boolean;
  onPlay: (rowId: string, label: string, isMidi: boolean) => void;
  onFavorite: (isMidi: boolean, rowId: string, current: boolean) => void;
  onDelete: (isMidi: boolean, rowId: string, name: string) => void;
  onContext: (e: React.MouseEvent, payload: SubTabRowPayload) => void;
}>(({ row, isMidi, parentTitle, isPlaying, isBusy, onPlay, onFavorite, onDelete, onContext }) => {
  const rowId = String(row.id ?? '');
  const name = isMidi ? String(row.source ?? 'midi') : String(row.stem_name ?? 'stem');
  const label = parentTitle ? `${parentTitle} · ${name}` : name;
  const favorite = !!row.favorite;
  const meta = isMidi ? `${row.engine ?? ''}` : `${row.model ?? ''} ${row.model_variant ?? ''}`.trim();
  return (
    <div
      className="group flex items-center gap-1 text-[10px] font-mono text-zinc-300 px-1 py-0.5 hover:bg-white/5 rounded"
      onContextMenu={(e) => onContext(e, isMidi ? { kind: 'midi', midiId: rowId, label } : { kind: 'stem', row })}
      title="Right-click for more — send to editor / init / inpaint / chimera"
    >
      <button
        type="button"
        className="shrink-0 p-0.5 rounded hover:bg-white/10"
        onClick={() => onFavorite(isMidi, rowId, favorite)}
        title={favorite ? 'Unfavorite' : 'Favorite'}
        aria-label={favorite ? `Unfavorite ${name}` : `Favorite ${name}`}
      >
        <Star className={`w-2.5 h-2.5 ${favorite ? 'text-yellow-500 fill-current' : 'text-zinc-700'}`} />
      </button>
      <button
        type="button"
        className="shrink-0 p-0.5 rounded hover:bg-white/10"
        disabled={isBusy}
        onClick={() => onPlay(rowId, label, isMidi)}
        title={isPlaying ? 'Pause' : isMidi ? 'Play (synth)' : 'Play'}
        aria-label={isPlaying ? `Pause ${name}` : `Play ${name}`}
      >
        {isBusy ? (
          <Loader2 className="w-2.5 h-2.5 animate-spin text-purple-400" />
        ) : isPlaying ? (
          <Pause className="w-2.5 h-2.5 text-purple-400" />
        ) : (
          <Play className="w-2.5 h-2.5 text-zinc-400 group-hover:text-purple-400" />
        )}
      </button>
      <span className="truncate flex-1 min-w-0">{name}</span>
      <span className="text-[8px] text-zinc-600 ml-1 shrink-0">{meta}</span>
      <button
        type="button"
        className="shrink-0 p-0.5 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => onDelete(isMidi, rowId, name)}
        title="Delete"
        aria-label={`Delete ${name}`}
      >
        <Trash2 className="w-2.5 h-2.5 text-zinc-600 hover:text-red-400" />
      </button>
    </div>
  );
});
SubTabRow.displayName = 'SubTabRow';


const SubTabList: React.FC<SubTabListProps> = ({ byParent, parentTitles, kind, placeholder, onMutated }) => {
  const parentIds = Object.keys(byParent);
  // Shared ContextMenu primitive — fixes drift under .dense-layout
  // zoom and gives consistent close-on-outside behavior across the
  // app (plan step 3d migration).
  const rowMenu = useContextMenu<SubTabRowPayload>();

  // Stems and MIDI are first-class library items: they play through the
  // global engine, can be favorited, and can be deleted independently of
  // their parent track. MIDI playback synthesizes via the shared sawtooth
  // engine in lib/midiSynth (no soundfont needed).
  const engineIsPlaying = usePlayerStore((s) => s.isPlaying);
  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const [playingRowKey, setPlayingRowKey] = useState<string | null>(null);
  const [busyRowKey, setBusyRowKey] = useState<string | null>(null);
  // Ref mirror so the stable playRow callback can read the current playing row
  // without being recreated each render (which would defeat row memoization).
  const playingRowKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => { playingRowKeyRef.current = playingRowKey; }, [playingRowKey]);

  // Stems / MIDI load with no entryId, so currentEntryId is null while one is
  // playing. If a real track takes over the engine, currentEntryId goes
  // non-null and our rows stop showing the pause state.
  const rowIsPlaying = (rowKey: string) =>
    playingRowKey === rowKey && engineIsPlaying && engineEntryId === null;

  // Stable handlers (read live engine state via getState) so SubTabRow's memo
  // holds across parent re-renders (e.g. opening the context menu).
  const playRow = React.useCallback(async (rowKey: string, label: string, fetchBlob: () => Promise<Blob>) => {
    const ps = usePlayerStore.getState();
    if (playingRowKeyRef.current === rowKey && ps.isPlaying && ps.currentEntryId === null) {
      ps.pause();
      return;
    }
    setBusyRowKey(rowKey);
    try {
      const blob = await fetchBlob();
      await ps.load(blob, { label });
      ps.play();
      setPlayingRowKey(rowKey);
    } catch (e) {
      logError('library', `Could not play ${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyRowKey(null);
    }
  }, []);

  const handlePlay = React.useCallback((rowId: string, label: string, isMidi: boolean) => {
    const rowKey = `${isMidi ? 'midi' : 'stem'}:${rowId}`;
    void playRow(
      rowKey,
      label,
      isMidi
        ? async () => {
            const buf = await fetchMidiBytesWithRetry(`/api/midi/file/${rowId}`, { label });
            return (await renderMidiBufferToBlob(buf)).blob;
          }
        : async () => fetchBlobWithRetry(`/api/library/stems/${rowId}/audio`, { label }),
    );
  }, [playRow]);

  const toggleFavorite = React.useCallback(async (isMidi: boolean, rowId: string, current: boolean) => {
    const url = isMidi ? `/api/midi/file/${rowId}` : `/api/library/stems/${rowId}`;
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: !current }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await onMutated();
    } catch (e) {
      logError('library', `Could not update favorite: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onMutated]);

  const deleteRow = React.useCallback(async (isMidi: boolean, rowId: string, label: string) => {
    if (!window.confirm(`Delete "${label}"? This removes the file from disk and cannot be undone.`)) return;
    const url = isMidi ? `/api/midi/file/${rowId}` : `/api/library/stems/${rowId}`;
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logInfo('library', `Deleted ${isMidi ? 'MIDI' : 'stem'} "${label}".`);
      await onMutated();
    } catch (e) {
      logError('library', `Could not delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onMutated]);

  if (parentIds.length === 0) {
    return <p className="text-[10px] text-zinc-500 italic py-4 text-center">{placeholder}</p>;
  }

  const payload = rowMenu.payload;
  let menuItems: ContextMenuItem[] = [];
  let menuTitle = '';

  if (payload?.kind === 'midi') {
    const sendable = midiIdToSendable(payload.midiId, payload.label);
    menuTitle = `MIDI · ${payload.label}`;
    menuItems = [
      {
        type: 'item',
        label: 'Send to piano roll',
        icon: <Piano className="w-3 h-3" />,
        onSelect: () => { void sendMidiIdToTarget(payload.midiId, 'piano-roll'); },
      },
      {
        type: 'item',
        label: 'Send to step sequencer',
        icon: <ListOrdered className="w-3 h-3" />,
        onSelect: () => { void sendMidiIdToTarget(payload.midiId, 'step-seq'); },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Send to editor (synth)',
        icon: <Layers className="w-3 h-3" />,
        hint: 'new track',
        onSelect: () => { void sendAudioToEditor(sendable, 'editor-new-track'); },
      },
      {
        type: 'item',
        label: 'Send to Init audio (synth)',
        icon: <Wand2 className="w-3 h-3" />,
        onSelect: () => { void sendAudioToInit(sendable); },
      },
      {
        type: 'item',
        label: 'Send to Inpaint (synth)',
        icon: <PenLine className="w-3 h-3" />,
        onSelect: () => { void sendAudioToInpaint(sendable); },
      },
      {
        type: 'item',
        label: 'Add to Chimera (synth)',
        icon: <Music className="w-3 h-3" />,
        onSelect: () => { void sendAudioToChimera([sendable]); },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Download .mid',
        icon: <Download className="w-3 h-3" />,
        onSelect: () => {
          const a = document.createElement('a');
          a.href = `/api/midi/file/${payload.midiId}`;
          a.download = '';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        },
      },
      {
        type: 'item',
        label: 'Delete MIDI',
        icon: <Trash2 className="w-3 h-3" />,
        danger: true,
        onSelect: () => { void deleteRow(true, payload.midiId, payload.label); },
      },
    ];
  } else if (payload?.kind === 'stem') {
    const stemId = String(payload.row.id ?? '');
    const stemName = String(payload.row.stem_name ?? 'stem');
    const sendable = stemRowToSendable(payload.row);
    const audioUrl = `/api/library/stems/${stemId}/audio`;
    menuTitle = `Stem · ${stemName}`;
    menuItems = [
      {
        type: 'item',
        label: 'Send to editor (new track)',
        icon: <Layers className="w-3 h-3" />,
        onSelect: () => { void sendAudioToEditor(sendable, 'editor-new-track'); },
      },
      {
        type: 'item',
        label: 'Send to Init audio',
        icon: <Wand2 className="w-3 h-3" />,
        onSelect: () => { void sendAudioToInit(sendable); },
      },
      {
        type: 'item',
        label: 'Send to Inpaint',
        icon: <PenLine className="w-3 h-3" />,
        onSelect: () => { void sendAudioToInpaint(sendable); },
      },
      {
        type: 'item',
        label: 'Add to Chimera',
        icon: <Music className="w-3 h-3" />,
        onSelect: () => { void sendAudioToChimera([sendable]); },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Download .wav',
        icon: <Download className="w-3 h-3" />,
        onSelect: () => {
          const a = document.createElement('a');
          a.href = audioUrl;
          a.download = `${stemName}.wav`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        },
      },
      {
        type: 'item',
        label: 'Delete stem',
        icon: <Trash2 className="w-3 h-3" />,
        danger: true,
        onSelect: () => { void deleteRow(false, stemId, stemName); },
      },
    ];
  }

  return (
    <div className="flex flex-col gap-2 relative">
      {parentIds.map((pid) => (
        <div key={pid} className="border border-white/5 rounded p-2 bg-white/3">
          <div className="text-[9px] font-black uppercase tracking-widest text-purple-300 mb-1 truncate">
            {parentTitles[pid] ?? pid}
          </div>
          <div className="flex flex-col gap-0.5">
            {byParent[pid].map((row, idx) => {
              const rowId = String(row.id ?? '');
              const rowKey = `${kind}:${rowId}`;
              return (
                <SubTabRow
                  key={rowId || idx}
                  row={row}
                  isMidi={kind === 'midi'}
                  parentTitle={parentTitles[pid] ?? ''}
                  isPlaying={rowIsPlaying(rowKey)}
                  isBusy={busyRowKey === rowKey}
                  onPlay={handlePlay}
                  onFavorite={toggleFavorite}
                  onDelete={deleteRow}
                  onContext={rowMenu.open}
                />
              );
            })}
          </div>
        </div>
      ))}

      <ContextMenu
        position={rowMenu.position}
        onClose={rowMenu.close}
        items={menuItems}
        title={menuTitle}
      />
    </div>
  );
};


/* ═══════════════════════════════ ScoreList ═══════════════════════════════ */

const SCORE_KIND_LABEL: Record<string, string> = {
  musicxml: 'Sheet',
  alphatex: 'Tab',
  abc: 'ABC',
  pdf: 'PDF',
  svg: 'SVG',
  guitarpro: 'GP',
};

/** SCORE library tab: every sheet / tab / arrangement across the library,
 *  grouped by parent track. A row opens the Score viewer for that track and
 *  downloads the artifact (the backend names the file after the originating
 *  song). Scores are created elsewhere (the bottom Score panel), so a manual
 *  refresh is offered since this list is cached on first open. */
const ScoreList: React.FC<{
  byParent: Record<string, Array<Record<string, unknown>>>;
  parentTitles: Record<string, string>;
  placeholder: string;
  onOpen: (entryId: string) => void;
  onRefresh: () => void | Promise<void>;
}> = ({ byParent, parentTitles, placeholder, onOpen, onRefresh }) => {
  const parentIds = Object.keys(byParent);

  const downloadScore = (id: string, kind: string) => {
    const a = document.createElement('a');
    // Sheets come down as a MusicXML + PDF zip; tabs/others as the raw file.
    a.href = kind === 'musicxml' ? notationPackUrl(id) : notationArtifactUrl(id);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const refreshBtn = (
    <div className="flex justify-end">
      <button
        onClick={() => void onRefresh()}
        className="p-1 rounded text-zinc-500 hover:text-purple-300"
        title="Refresh scores"
        aria-label="Refresh scores"
      >
        <RefreshCw className="w-3 h-3" />
      </button>
    </div>
  );

  if (parentIds.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {refreshBtn}
        <p className="text-[10px] text-zinc-500 italic py-4 text-center">{placeholder}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {refreshBtn}
      {parentIds.map((pid) => (
        <div key={pid} className="border border-white/5 rounded p-2 bg-white/3">
          <div className="text-[9px] font-black uppercase tracking-widest text-emerald-300 mb-1 truncate">
            {parentTitles[pid] ?? pid}
          </div>
          <div className="flex flex-col gap-0.5">
            {byParent[pid].map((row, idx) => {
              const id = String(row.id ?? '');
              const kind = String(row.kind ?? '');
              const label = SCORE_KIND_LABEL[kind] ?? kind.toUpperCase();
              const engine = String(row.engine ?? '');
              return (
                <div
                  key={id || idx}
                  className="group flex items-center gap-1 text-[10px] font-mono text-zinc-300 px-1 py-0.5 hover:bg-white/5 rounded cursor-pointer"
                  onClick={() => onOpen(pid)}
                  title="Open in the Score viewer"
                >
                  <span className="shrink-0 px-1 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[8px] font-black uppercase tracking-widest">
                    {label}
                  </span>
                  <span className="truncate flex-1 min-w-0">{engine || kind}</span>
                  <button
                    type="button"
                    className="shrink-0 p-0.5 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); downloadScore(id, kind); }}
                    title={kind === 'musicxml' ? 'Download MusicXML + PDF' : 'Download score'}
                    aria-label={`Download ${label} score`}
                  >
                    <Download className="w-2.5 h-2.5 text-zinc-500 hover:text-white" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};


