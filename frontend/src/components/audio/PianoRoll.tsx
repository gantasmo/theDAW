import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Square, Download, Trash2, ZoomIn, ZoomOut, Send, Save } from 'lucide-react';
import { usePianoRollStore, pianoNotesToMidiNotes, type PianoNote } from '../../state/pianoRollStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx, getMasterGain } from '../../state/playerStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { downloadMidi, parseMidi } from '../../utils/midi';
import { logError, logInfo } from '../../state/logStore';
import { MidiMapper } from './MidiMapper';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { triggerActiveVoice, renderStepNotesToBlob } from '../../lib/midiSynth';
import { isSoundfontActive, previewNoteSF } from '../../lib/soundfontEngine';
import { InstrumentPicker } from './InstrumentPicker';
import { MidiImportPopover } from './MidiImportPopover';

const NOTE_HEIGHT = 12;
const HEADER_HEIGHT = 22;
const KEYBOARD_WIDTH = 64;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlackKey = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);
const noteLabel = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** Live preview convenience: route the shared synth voice through the engine
 *  master/analyser. The voice itself lives in `lib/midiSynth` so previews,
 *  bounces, and library MIDI renders all sound identical. */
const triggerPianoNote = (midi: number, velocity: number, when: number, duration: number, master: number) => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  if (isSoundfontActive()) {
    // The soundfont voice plays immediately, so approximate the scheduled
    // `when` with a timer relative to now (fine for preview + playback).
    const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
    window.setTimeout(() => void previewNoteSF(midi, velocity, duration), delayMs);
    return;
  }
  triggerActiveVoice(ctx, getMasterGain(), midi, velocity, when, duration, master);
};

/**
 * Public alias used by the global Web MIDI listener in App.tsx.
 * Defaults `when` to the engine's current time + a tiny lookahead,
 * `duration` to a comfortable 180ms decay, and `master` to 0.8 so
 * controller-driven notes feel uniform without callers having to
 * know the synth's internals. The PianoRoll component itself still
 * uses the bare `triggerPianoNote` for its own scheduling.
 */
const PIANO_MIDI_PARAMS = [
  { key: 'bpm' as const,        label: 'BPM',         min: 40,  max: 240, autoCc: 14, integer: true },
  { key: 'totalSteps' as const, label: 'Total Steps', min: 16,  max: 256, autoCc: 15, integer: true },
];

export const triggerPianoNoteFromMidi = (midi: number, velocity = 100, duration = 0.18) => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  triggerPianoNote(midi, velocity, ctx.currentTime + 0.02, duration, 0.8);
};

/** Render the current pattern offline to a WAV Blob. Used by SEND TO EDITOR.
 *  Delegates to the shared step renderer in `lib/midiSynth`. */
const renderPianoRollToBlob = (
  notes: PianoNote[],
  bpm: number,
  totalSteps: number,
): Promise<{ blob: Blob; duration: number }> =>
  renderStepNotesToBlob(notes, bpm, totalSteps);

// Re-declared after the imports section so it picks up the imported
// MidiMapper symbol without circular-import gymnastics.
export const PianoRoll: React.FC = () => {
  const notes = usePianoRollStore((s) => s.notes);
  const bpm = usePianoRollStore((s) => s.bpm);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const lowestNote = usePianoRollStore((s) => s.lowestNote);
  const highestNote = usePianoRollStore((s) => s.highestNote);
  const selectedNoteId = usePianoRollStore((s) => s.selectedNoteId);
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const currentStep = usePianoRollStore((s) => s.currentStep);
  const recordedRange = usePianoRollStore((s) => s.recordedRange);

  const setBpm = usePianoRollStore((s) => s.setBpm);
  const setTotalSteps = usePianoRollStore((s) => s.setTotalSteps);
  const addNote = usePianoRollStore((s) => s.addNote);
  const removeNote = usePianoRollStore((s) => s.removeNote);
  const updateNote = usePianoRollStore((s) => s.updateNote);
  const setSelectedNote = usePianoRollStore((s) => s.setSelectedNote);
  const setPlaying = usePianoRollStore((s) => s.setPlaying);
  const setCurrentStep = usePianoRollStore((s) => s.setCurrentStep);
  const importNotes = usePianoRollStore((s) => s.importNotes);
  const replaceAll = usePianoRollStore((s) => s.replaceAll);
  const clear = usePianoRollStore((s) => s.clear);
  const noteMenu = useContextMenu<PianoNote>();
  const editingClipId = usePianoRollStore((s) => s.editingClipId);
  const setEditingClip = usePianoRollStore((s) => s.setEditingClip);

  const [isBouncing, setIsBouncing] = useState(false);

  const masterGain = usePlaybackStore((s) => (s.muted ? 0 : s.volume / 100));
  const masterRef = useRef(masterGain);
  useEffect(() => { masterRef.current = masterGain; }, [masterGain]);

  const [stepPx, setStepPx] = useState(16);
  const [quantizePct, setQuantizePct] = useState(100);
  const [swingPct, setSwingPct] = useState(0);

  const noteCount = highestNote - lowestNote + 1;
  const gridHeight = noteCount * NOTE_HEIGHT;
  const gridWidth = totalSteps * stepPx;
  const gridRef = useRef<HTMLDivElement | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const keyboardRowsRef = useRef<HTMLDivElement | null>(null);

  // Map y-pixel inside the grid to a MIDI note. Top row = highestNote.
  const yToNote = useCallback(
    (y: number): number => highestNote - Math.floor(y / NOTE_HEIGHT),
    [highestNote],
  );
  const xToStep = useCallback((x: number): number => Math.floor(x / stepPx), [stepPx]);

  const handleGridClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0) return;
    const targetNote = yToNote(y);
    const targetStep = xToStep(x);
    if (targetStep < 0 || targetStep >= totalSteps) return;
    // If clicked on an existing note → remove or select.
    const hit = notes.find(
      (n) => n.note === targetNote && targetStep >= n.step && targetStep < n.step + n.length,
    );
    if (hit) {
      if (selectedNoteId === hit.id) {
        removeNote(hit.id);
      } else {
        setSelectedNote(hit.id);
      }
      return;
    }
    // Otherwise add a 1-step note.
    addNote({ note: targetNote, step: targetStep, length: 2, velocity: 96 });
    triggerPianoNote(targetNote, 96, getEngineCtx().currentTime + 0.02, 0.2, masterRef.current);
  };

  // Right-drag a note to extend its length.
  const resizeRef = useRef<{ id: string; startX: number; initialLength: number } | null>(null);
  const onNotePointerDown = (e: React.PointerEvent, note: PianoNote, edge: 'right' | 'body') => {
    e.stopPropagation();
    setSelectedNote(note.id);
    if (edge === 'right') {
      resizeRef.current = { id: note.id, startX: e.clientX, initialLength: note.length };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const op = resizeRef.current;
    if (!op) return;
    const dx = e.clientX - op.startX;
    const deltaSteps = Math.round(dx / stepPx);
    const newLen = Math.max(1, op.initialLength + deltaSteps);
    updateNote(op.id, { length: newLen });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (resizeRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      resizeRef.current = null;
    }
  };

  // Delete / Backspace removes selected note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (selectedNoteId) {
        e.preventDefault();
        removeNote(selectedNoteId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNoteId, removeNote]);

  // Playback loop.
  const playTimerRef = useRef<number | null>(null);
  const stepRef = useRef(currentStep);
  useEffect(() => { stepRef.current = currentStep; }, [currentStep]);
  const stopPlayback = useCallback(() => {
    if (playTimerRef.current != null) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    setPlaying(false);
  }, [setPlaying]);
  useEffect(() => {
    if (!isPlaying) return;
    const stepMs = (60_000 / Math.max(40, bpm)) / 4;
    const start = () => {
      const next = (stepRef.current + 1) % totalSteps;
      stepRef.current = next;
      setCurrentStep(next);
      const ctx = getEngineCtx();
      const when = ctx.currentTime + 0.02;
      for (const n of usePianoRollStore.getState().notes) {
        if (n.step === next) {
          const noteDur = (n.length * stepMs) / 1000;
          triggerPianoNote(n.note, n.velocity, when, noteDur, masterRef.current);
        }
      }
    };
    playTimerRef.current = window.setInterval(start, stepMs);
    return () => {
      if (playTimerRef.current != null) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, bpm, totalSteps, setCurrentStep]);

  const handlePlayToggle = () => {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    // Fire step 0 immediately.
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const when = ctx.currentTime + 0.02;
    const stepMs = (60_000 / Math.max(40, bpm)) / 4;
    for (const n of notes) {
      if (n.step === 0) {
        triggerPianoNote(n.note, n.velocity, when, (n.length * stepMs) / 1000, masterRef.current);
      }
    }
    setCurrentStep(0);
    stepRef.current = 0;
    setPlaying(true);
    logInfo('piano-roll', `Playing ${notes.length} notes at ${bpm} BPM`);
  };

  const handleSendToEditor = async () => {
    if (notes.length === 0) {
      logError('piano-roll', 'No notes to bounce');
      return;
    }
    setIsBouncing(true);
    const start = performance.now();
    try {
      const { blob, duration } = await renderPianoRollToBlob(notes, bpm, totalSteps);
      const { peaks } = await computePeaks(blob, 240);
      const editor = useEditorStore.getState();
      // Snapshot the notes so re-editing later sees the exact same state.
      const noteSnapshot: PianoNote[] = notes.map((n) => ({ ...n }));

      if (editingClipId) {
        const existing = editor.clips.find((c) => c.id === editingClipId);
        if (existing) {
          editor.updateClip(editingClipId, {
            audioBlob: blob,
            mimeType: 'audio/wav',
            sourceDuration: duration,
            durationSec: duration,
            offsetIntoSource: 0,
            peaks,
            sourcePianoRoll: noteSnapshot,
            sourceBpm: bpm,
            sourceTotalSteps: totalSteps,
            sourceKind: 'piano-roll',
            label: existing.label.startsWith('roll_')
              ? `roll_${bpm}bpm_${notes.length}n`
              : existing.label,
          });
          logInfo('piano-roll', `Updated editor clip ${editingClipId.slice(0, 8)} (${duration.toFixed(2)}s, ${notes.length} notes)`);
          const ms = (performance.now() - start).toFixed(0);
          logInfo('piano-roll', `Re-bounce took ${ms}ms`);
          return;
        }
        // The clip the roll was bound to is gone — fall through to create a new one.
        setEditingClip(null);
      }

      const trackId = editor.addTrack({ name: `Piano ${bpm} BPM` });
      const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const newClipId = editor.addClipToTrack({
        trackId,
        label: `roll_${bpm}bpm_${notes.length}n`,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        offsetIntoSource: 0,
        durationSec: duration,
        startSec: 0,
        color: trackColor,
        sourceKind: 'piano-roll',
        sourcePianoRoll: noteSnapshot,
        sourceBpm: bpm,
        sourceTotalSteps: totalSteps,
      });
      editor.cachePeaks(newClipId, peaks);
      // Bind the roll to the new clip so subsequent Send-to-Editor edits in place.
      setEditingClip(newClipId);
      const ms = (performance.now() - start).toFixed(0);
      logInfo('piano-roll', `Bounced ${notes.length} notes → editor (${duration.toFixed(2)}s in ${ms}ms)`);
    } catch (e) {
      logError('piano-roll', `Bounce failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsBouncing(false);
    }
  };

  const handleExportMidi = () => {
    if (notes.length === 0) {
      logError('piano-roll', 'No notes to export');
      return;
    }
    const ppq = 480;
    const midiNotes = pianoNotesToMidiNotes(notes, ppq);
    downloadMidi(
      {
        ppq,
        bpm,
        tracks: [
          { name: 'Piano Roll', notes: midiNotes },
        ],
      },
      'piano-roll',
    );
    logInfo('piano-roll', `Exported ${notes.length} notes as MIDI`);
  };

  const handleImportMidi = (file: File) => {
    file.arrayBuffer().then((buf) => {
      try {
        const data = parseMidi(new Uint8Array(buf));
        // Flatten all tracks' notes into a single piano-roll layer.
        const stepTicks = data.ppq / 4;
        const flat: PianoNote[] = [];
        for (const track of data.tracks) {
          for (const n of track.notes) {
            flat.push({
              id: `imp-${Math.random().toString(36).slice(2)}-${flat.length}`,
              note: n.note,
              step: Math.round(n.tick / stepTicks),
              length: Math.max(1, Math.round(n.durationTicks / stepTicks)),
              velocity: n.velocity,
            });
          }
        }
        if (flat.length === 0) {
          logError('piano-roll', `No notes found in "${file.name}"`);
          return;
        }
        flat.sort((a, b) => a.step - b.step);
        // importNotes auto-fits the grid length AND pitch range to the import.
        importNotes(flat, data.bpm);
        logInfo('piano-roll', `Imported ${flat.length} notes from "${file.name}" at ${Math.round(data.bpm)} BPM`);
      } catch (e) {
        logError('piano-roll', `MIDI import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }).catch((e) => logError('piano-roll', `Could not read file: ${e instanceof Error ? e.message : String(e)}`));
  };

  const handleGridScroll = () => {
    if (keyboardRowsRef.current && gridScrollRef.current) {
      keyboardRowsRef.current.scrollTop = gridScrollRef.current.scrollTop;
    }
  };

  const handleGridWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = gridScrollRef.current;
    if (!el) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el.scrollLeft;
      const oldStepPx = stepPx;
      const nextStepPx = Math.max(6, Math.min(64, oldStepPx * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      setStepPx(nextStepPx);
      requestAnimationFrame(() => {
        el.scrollLeft = cursorX * (nextStepPx / oldStepPx) - (e.clientX - rect.left);
      });
      return;
    }
    if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  };

  const applyTimingFeel = () => {
    if (notes.length === 0) return;
    const q = Math.max(0, Math.min(1, quantizePct / 100));
    const swing = Math.max(-0.49, Math.min(0.49, swingPct / 100));
    const adjusted = notes.map((note) => {
      const quantizedStep = Math.round(note.step);
      const quantizedLength = Math.max(1, Math.round(note.length));
      let step = note.step + (quantizedStep - note.step) * q;
      const length = Math.max(1, note.length + (quantizedLength - note.length) * q);
      const gridStep = Math.round(step);
      // Delay or pull back the off-16ths in each beat. Positive = swing/rag lag;
      // negative = push/syncopate ahead. Keep step >= 0 so the phrase stays valid.
      if (gridStep % 2 === 1) step = Math.max(0, step + swing);
      return { ...note, step, length };
    });
    replaceAll(adjusted);
    logInfo('piano-roll', `Applied timing feel: quantize ${quantizePct}% · swing/rag ${swingPct}%`);
  };

  // Center the vertical scroll on the note content so it's visible in the tall
  // full-piano grid (~88 rows). Re-centers when the content pitch range changes
  // (a capture / import / clip load), not on edits within the current range.
  const contentLo = notes.length ? notes.reduce((m, n) => Math.min(m, n.note), 127) : 60;
  const contentHi = notes.length ? notes.reduce((m, n) => Math.max(m, n.note), 0) : 72;
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const midNote = (contentLo + contentHi) / 2;
    const midY = (highestNote - midNote) * NOTE_HEIGHT;
    el.scrollTop = Math.max(0, midY - el.clientHeight / 2);
    if (keyboardRowsRef.current) keyboardRowsRef.current.scrollTop = el.scrollTop;
  }, [contentLo, contentHi, highestNote]);

  // Build keyboard rows + grid rows for rendering.
  const rows: number[] = [];
  for (let n = highestNote; n >= lowestNote; n -= 1) rows.push(n);

  return (
    <div className="h-full flex flex-col bg-[#07050a] overflow-hidden relative">
      {/* MIDI mapper popup — top-right pill that expands to LEARN UI.
          Mapped CC moves bpm / totalSteps from the user's controller
          without touching the rest of the toolbar. */}
      <MidiMapper
        title="PIANO"
        accent="cyan"
        storageKey="sa3-midi-map:piano-v1"
        params={PIANO_MIDI_PARAMS}
        onChange={(key, value) => {
          if (key === 'bpm') setBpm(Math.round(value));
          else if (key === 'totalSteps') {
            const stepped = Math.max(16, Math.round(value / 16) * 16);
            setTotalSteps(stepped);
          }
        }}
      />

      {/* Toolbar — extra right padding reserves space for the MIDI mapper pill
          (absolute top-right) so it never covers CLEAR / the right-side controls. */}
      <div className="flex items-center justify-between gap-2 pl-2 pr-20 py-1 border-b border-white/5 bg-black/40 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={handlePlayToggle}
            className={`p-1 rounded transition-colors ${isPlaying ? 'bg-red-500/20 text-red-300 border border-red-500/40' : 'bg-purple-500/20 text-purple-300 border border-purple-500/40 hover:bg-purple-500/30'}`}
            title={isPlaying ? 'Stop' : 'Play'}
          >
            {isPlaying ? <Square className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
          </button>
          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded">
            <span className="text-[7px] font-mono text-zinc-600 uppercase">BPM</span>
            <input
              type="number"
              name="piano-roll-bpm"
              min={40}
              max={240}
              value={bpm}
              onChange={(e) => setBpm(parseInt(e.target.value) || 120)}
              className="bg-transparent border-none outline-none text-[10px] font-mono text-cyan-400 w-10 font-black"
            />
          </div>
          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded">
            <span className="text-[7px] font-mono text-zinc-600 uppercase">Steps</span>
            <input
              type="number"
              name="piano-roll-total-steps"
              min={16}
              max={4096}
              step={16}
              value={totalSteps}
              onChange={(e) => setTotalSteps(parseInt(e.target.value) || 32)}
              className="bg-transparent border-none outline-none text-[10px] font-mono text-zinc-300 w-12"
            />
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setStepPx(Math.max(6, stepPx - 2))} className="p-1 hover:bg-white/5 rounded text-zinc-500" title="Zoom out">
              <ZoomOut className="w-3 h-3" />
            </button>
            <span className="text-[8px] font-mono text-zinc-400 w-8 text-center">{Math.round(stepPx)}px</span>
            <button onClick={() => setStepPx(Math.min(48, stepPx + 2))} className="p-1 hover:bg-white/5 rounded text-zinc-500" title="Zoom in">
              <ZoomIn className="w-3 h-3" />
            </button>
          </div>
          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded" title="Timing feel: quantize pulls notes to the grid; swing/rag delays or pushes off-16ths.">
            <span className="text-[7px] font-mono text-zinc-600 uppercase">Q</span>
            <input
              type="range"
              name="piano-roll-quantize"
              min={0}
              max={100}
              value={quantizePct}
              onChange={(e) => setQuantizePct(parseInt(e.target.value) || 0)}
              className="w-14 accent-cyan-400"
            />
            <span className="text-[8px] font-mono text-cyan-300 w-7 text-right">{quantizePct}%</span>
            <span className="text-[7px] font-mono text-zinc-600 uppercase ml-1">Rag</span>
            <input
              type="range"
              name="piano-roll-swing-rag"
              min={-50}
              max={50}
              value={swingPct}
              onChange={(e) => setSwingPct(parseInt(e.target.value) || 0)}
              className="w-14 accent-purple-400"
            />
            <span className="text-[8px] font-mono text-purple-300 w-8 text-right">{swingPct > 0 ? '+' : ''}{swingPct}%</span>
            <button
              type="button"
              onClick={applyTimingFeel}
              disabled={notes.length === 0}
              className="px-1.5 py-0.5 rounded bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/25 text-[7px] font-black uppercase tracking-widest text-cyan-200 disabled:opacity-40 disabled:pointer-events-none"
            >
              Apply
            </button>
          </div>
          <InstrumentPicker />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-zinc-500">{notes.length} note{notes.length === 1 ? '' : 's'}</span>
          <MidiImportPopover onImportFile={handleImportMidi} />
          <button
            onClick={handleExportMidi}
            className="btn-ghost text-[9px] py-1 flex items-center gap-1.5"
            title="Download as a Standard MIDI File"
          >
            <Download className="w-3 h-3 text-purple-300" /> EXPORT MIDI
          </button>
          <button
            onClick={() => void handleSendToEditor()}
            disabled={isBouncing || notes.length === 0}
            className={`btn-ghost text-[9px] py-1 flex items-center gap-1.5 disabled:opacity-40 ${editingClipId ? 'border-emerald-500/40! text-emerald-200!' : ''}`}
            title={editingClipId
              ? 'Re-render and update the linked editor clip in place'
              : 'Render these notes to audio and add to the waveform editor as a new track'}
          >
            {editingClipId ? <Save className={`w-3 h-3 ${isBouncing ? 'animate-pulse' : 'text-emerald-300'}`} /> : <Send className={`w-3 h-3 text-purple-300 ${isBouncing ? 'animate-pulse' : ''}`} />}
            {isBouncing ? 'BOUNCING…' : editingClipId ? 'SAVE TO CLIP' : 'SEND TO EDITOR'}
          </button>
          {editingClipId && (
            <button
              onClick={() => setEditingClip(null)}
              className="btn-ghost text-[9px] py-1 flex items-center gap-1.5"
              title="Detach: future renders will create a new editor clip instead of updating the linked one"
            >
              UNLINK
            </button>
          )}
          <button
            onClick={() => clear()}
            className="btn-ghost text-[9px] py-1 flex items-center gap-1.5"
            title="Remove every note"
          >
            <Trash2 className="w-3 h-3" /> CLEAR
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Keyboard column */}
        <div className="shrink-0 overflow-hidden bg-[#0c0a12] border-r border-white/5" style={{ width: KEYBOARD_WIDTH }}>
          <div className="bg-black/40" style={{ height: HEADER_HEIGHT }} />
          <div ref={keyboardRowsRef} className="overflow-hidden" style={{ height: `calc(100% - ${HEADER_HEIGHT}px)` }}>
            <div style={{ height: gridHeight }}>
              {rows.map((midi) => {
                const black = isBlackKey(midi);
                const isC = midi % 12 === 0;
                return (
                  <div
                    key={midi}
                    onClick={() => triggerPianoNote(midi, 100, getEngineCtx().currentTime + 0.02, 0.25, masterRef.current)}
                    className={`flex items-center justify-end pr-1 text-[8px] font-mono cursor-pointer transition-colors border-b border-black/40 ${black ? 'bg-zinc-900 text-zinc-600 hover:bg-purple-900/30' : isC ? 'bg-zinc-200 text-zinc-700 hover:bg-purple-300' : 'bg-zinc-300 text-zinc-700 hover:bg-purple-200'}`}
                    style={{ height: NOTE_HEIGHT }}
                    title={`Preview ${noteLabel(midi)}`}
                  >
                    {isC ? noteLabel(midi) : ''}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Grid column */}
        <div
          ref={gridScrollRef}
          className="flex-1 overflow-auto"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onScroll={handleGridScroll}
          onWheel={handleGridWheel}
        >
          {/* Ruler */}
          <div className="sticky top-0 z-20 bg-black/60 border-b border-white/5 flex" style={{ height: HEADER_HEIGHT, width: gridWidth, minWidth: '100%' }}>
            {Array.from({ length: Math.ceil(totalSteps / 4) }).map((_, beat) => (
              <div key={beat} className="border-r border-white/5 flex items-center px-1 text-[8px] font-mono text-zinc-500" style={{ width: stepPx * 4 }}>
                {beat + 1}
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            onClick={handleGridClick}
            className="relative cursor-crosshair"
            style={{ width: gridWidth, height: gridHeight }}
          >
            {/* Row backgrounds (alternating black/white key tint + 1-beat lines) */}
            {rows.map((midi, idx) => (
              <div
                key={midi}
                className={`absolute left-0 right-0 border-b border-black/30 ${isBlackKey(midi) ? 'bg-white/2' : 'bg-white/4'} ${midi % 12 === 0 ? 'border-purple-500/20!' : ''}`}
                style={{ top: idx * NOTE_HEIGHT, height: NOTE_HEIGHT }}
              />
            ))}
            {/* Vertical beat/step lines */}
            {Array.from({ length: totalSteps + 1 }).map((_, i) => (
              <div
                key={i}
                className={`absolute top-0 bottom-0 ${i % 4 === 0 ? 'border-l border-white/10' : 'border-l border-white/3'}`}
                style={{ left: i * stepPx }}
              />
            ))}
            {/* Recorded-region highlight: marks the last live take without
                shrinking the grid (the rest of the 256 stays empty). */}
            {recordedRange && recordedRange.endStep > recordedRange.startStep && (
              <div
                className="absolute top-0 bottom-0 bg-emerald-400/8 border-x border-emerald-400/40 pointer-events-none"
                style={{
                  left: recordedRange.startStep * stepPx,
                  width: (recordedRange.endStep - recordedRange.startStep) * stepPx,
                }}
              />
            )}
            {/* Playhead */}
            {isPlaying && (
              <div
                className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] z-30 pointer-events-none"
                style={{ left: currentStep * stepPx + stepPx / 2 }}
              />
            )}
            {/* Notes */}
            {notes.map((n) => {
              if (n.note < lowestNote || n.note > highestNote) return null;
              const row = highestNote - n.note;
              const left = n.step * stepPx;
              const width = Math.max(4, n.length * stepPx - 1);
              const top = row * NOTE_HEIGHT;
              const selected = n.id === selectedNoteId;
              return (
                <div
                  key={n.id}
                  data-piano-note="1"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (selectedNoteId === n.id) removeNote(n.id);
                    else setSelectedNote(n.id);
                  }}
                  onPointerDown={(e) => onNotePointerDown(e, n, 'body')}
                  onContextMenu={(e) => { e.stopPropagation(); setSelectedNote(n.id); noteMenu.open(e, n); }}
                  className={`absolute rounded-sm border z-10 transition-colors ${selected ? 'bg-purple-400 border-white' : 'bg-purple-500 border-purple-700 hover:bg-purple-400'}`}
                  style={{ left, width, top: top + 1, height: NOTE_HEIGHT - 2 }}
                  title={`${noteLabel(n.note)} · step ${n.step + 1} · ${n.length} step${n.length === 1 ? '' : 's'}`}
                >
                  <div
                    onPointerDown={(e) => onNotePointerDown(e, n, 'right')}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/50"
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="h-5 border-t border-white/5 bg-black/60 flex items-center justify-between px-3 shrink-0">
        <span className="text-[8px] font-mono text-zinc-500">
          {isPlaying ? `PLAYING · step ${currentStep + 1}/${totalSteps}` : 'STOPPED'} · {bpm} BPM
          {editingClipId && (
            <span className="ml-2 px-1 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[7px] uppercase tracking-widest">
              Linked to clip {editingClipId.slice(0, 8)}
            </span>
          )}
        </span>
        <span className="text-[8px] font-mono text-zinc-600">
          Click empty cell = add · Click note = select / second click = delete · Drag right edge = resize · Delete key removes selection · Right-click note for actions
        </span>
      </div>

      {/* Right-click menu for a single note. */}
      {(() => {
        const n = noteMenu.payload;
        if (!n) return null;
        const clampVel = (v: number) => Math.max(1, Math.min(127, v));
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: 'Duplicate (after)',
            hint: 'step+len',
            onSelect: () => {
              addNote({ note: n.note, step: n.step + n.length, length: n.length, velocity: n.velocity });
            },
          },
          {
            type: 'item',
            label: 'Velocity +10',
            hint: `${n.velocity}`,
            disabled: n.velocity >= 127,
            onSelect: () => updateNote(n.id, { velocity: clampVel(n.velocity + 10) }),
          },
          {
            type: 'item',
            label: 'Velocity −10',
            hint: `${n.velocity}`,
            disabled: n.velocity <= 1,
            onSelect: () => updateNote(n.id, { velocity: clampVel(n.velocity - 10) }),
          },
          {
            type: 'item',
            label: 'Lengthen (+1 step)',
            onSelect: () => updateNote(n.id, { length: n.length + 1 }),
          },
          {
            type: 'item',
            label: 'Shorten (−1 step)',
            disabled: n.length <= 1,
            onSelect: () => updateNote(n.id, { length: Math.max(1, n.length - 1) }),
          },
          {
            type: 'item',
            label: 'Nudge left',
            disabled: n.step <= 0,
            onSelect: () => updateNote(n.id, { step: Math.max(0, n.step - 1) }),
          },
          {
            type: 'item',
            label: 'Nudge right',
            onSelect: () => updateNote(n.id, { step: n.step + 1 }),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Clear all notes',
            icon: <Trash2 className="w-3 h-3" />,
            hint: `${notes.length}`,
            onSelect: clear,
          },
          {
            type: 'item',
            label: 'Delete note',
            hint: 'Del',
            danger: true,
            onSelect: () => removeNote(n.id),
          },
        ];
        return (
          <ContextMenu
            position={noteMenu.position}
            onClose={noteMenu.close}
            items={items}
            title={`${noteLabel(n.note)} · step ${n.step + 1}`}
            minWidth="12rem"
          />
        );
      })()}
    </div>
  );
};

