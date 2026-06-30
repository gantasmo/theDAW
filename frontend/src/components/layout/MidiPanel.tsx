/**
 * MidiPanel - the unified MIDI tab (merged Piano + Vocal).
 *
 * The shared Piano Roll is the surface; everything else feeds or operates on it.
 * Vocal is one INPUT option: a live mic recording is converted to notes through
 * the SAME backend basic-pitch path as "Analyze" (far better than the live YIN),
 * and dropped into the roll without shrinking the grid (the take is highlighted).
 * A mic monitor runs while the tab is open so the input level is always visible.
 * When a vocal artifact is loaded, a right rail shows lyrics + segments (each arms
 * an inpaint guide). Notes export to .mid, drive a drum Beat, or round-trip
 * validate. No synthesis here.
 */

import { Activity, Download, Drum, FileCheck2, Loader2, Mic, Music4, Square } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { RenderNote } from '../../lib/midiSynth';
import { colorAt, rgb, rgba } from '../../lib/trackColor';
import { renderDrumBeatBlob, vocalizeEffect } from '../../lib/vocalBeat';
import {
  armInpaintGuide,
  downloadVocalMidi,
  fetchVocalArtifact,
  type ArtifactNote,
  type VocalArtifactDoc,
} from '../../lib/vocalExport';
import {
  listAudioInputs,
  queryMicPermission,
  startInputMonitor,
  type InputMonitor,
} from '../../lib/vocalToMidi';
import { useLibraryStore } from '../../state/libraryStore';
import { logInfo, logWarn } from '../../state/logStore';
import { usePianoRollStore, type PianoNote } from '../../state/pianoRollStore';
import { PianoRoll } from '../audio/PianoRoll';
import { ArpeggiatorPanel } from '../audio/ArpeggiatorPanel';
import { Vocal2MidiPanel } from '../audio/vocal2midi/Vocal2MidiPanel';

const stepSec = (bpm: number): number => 60 / bpm / 4;

const artifactToPiano = (notes: ArtifactNote[], bpm: number): PianoNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n, i) => ({
    id: `art-${i}-${n.start_ms}`,
    note: n.pitch,
    step: Math.max(0, Math.round(n.start_ms / 1000 / ss)),
    length: Math.max(1, Math.round((n.end_ms - n.start_ms) / 1000 / ss)),
    velocity: n.velocity,
  }));
};

const pianoToArtifact = (notes: PianoNote[], bpm: number): ArtifactNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n) => ({
    start_ms: Math.round(n.step * ss * 1000),
    end_ms: Math.round((n.step + n.length) * ss * 1000),
    pitch: n.note,
    velocity: n.velocity,
  }));
};

const pianoToRender = (notes: PianoNote[], bpm: number): RenderNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n) => ({
    midi: n.note,
    startSec: n.step * ss,
    durationSec: Math.max(0.05, n.length * ss),
    velocity: n.velocity,
  }));
};

/**
 * Self-contained input-level meter using the SLIDE temperature scale (colorAt).
 * Runs its own rAF so the 60fps level updates never re-render the parent panel
 * (which embeds the Piano Roll).
 */
const MicMeter: React.FC<{ monitorRef: React.MutableRefObject<InputMonitor | null> }> = ({
  monitorRef,
}) => {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setLevel(monitorRef.current?.getLevel() ?? 0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [monitorRef]);
  const col = colorAt(level);
  return (
    <div
      role="meter"
      aria-label="Microphone input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      title={`mic level ${Math.round(level * 100)}%`}
      className="w-24 h-2.5 shrink-0 rounded-full overflow-hidden border border-white/10 bg-black/50"
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.max(level * 100, 2)}%`,
          background: rgb(col),
          boxShadow: `0 0 8px ${rgba(col, 0.7)}`,
        }}
      />
    </div>
  );
};

export const MidiPanel: React.FC = () => {
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const entries = useLibraryStore((s) => s.entries);
  const [assetId, setAssetId] = useState('');
  // What the search box shows (a friendly title); the actual API uses assetId.
  const [assetQuery, setAssetQuery] = useState('');
  const [assetOpen, setAssetOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('idle');
  const [artifact, setArtifact] = useState<VocalArtifactDoc | null>(null);
  const [validateMsg, setValidateMsg] = useState('');
  const [arpOn, setArpOn] = useState(false);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(
    () => localStorage.getItem('vocal.inputDeviceId') ?? '',
  );
  const [micPerm, setMicPerm] = useState<string>('unknown');
  const monitorRef = useRef<InputMonitor | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStartRef = useRef(0);

  // Default the asset field to the selected library item (override freely). Show
  // the friendly title in the box while keeping the real id for the API.
  useEffect(() => {
    if (selectedEntryId && !assetId) {
      setAssetId(selectedEntryId);
      const sel = useLibraryStore.getState().entries.find((e) => e.id === selectedEntryId);
      if (sel) setAssetQuery(sel.title);
    }
  }, [selectedEntryId, assetId]);

  // Pick a library entry into the asset field: store the real id, show the title.
  const pickAsset = useCallback((id: string, title: string) => {
    setAssetId(id);
    setAssetQuery(title);
    setAssetOpen(false);
  }, []);

  // Library entries whose title matches the current search text (cap the list).
  const assetMatches = (() => {
    const q = assetQuery.trim().toLowerCase();
    const audio = entries.filter((e) => e.kind === 'audio');
    const list = q ? audio.filter((e) => e.title.toLowerCase().includes(q)) : audio;
    return list.slice(0, 12);
  })();

  const refreshInputs = useCallback(async () => {
    setMicPerm(await queryMicPermission());
    setInputs(await listAudioInputs());
  }, []);

  const pickDevice = useCallback((id: string) => {
    setDeviceId(id);
    if (id) localStorage.setItem('vocal.inputDeviceId', id);
    else localStorage.removeItem('vocal.inputDeviceId');
  }, []);

  // Always-on input monitor while the tab is open: opens the mic + an analyser so
  // the level is visible even when not recording. Re-opens when the device
  // changes; releases the mic when the tab unmounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const monitor = await startInputMonitor(deviceId || undefined);
        if (cancelled) {
          monitor.stop();
          return;
        }
        monitorRef.current = monitor;
        void refreshInputs();
      } catch (e) {
        if (!cancelled) {
          setMicPerm(await queryMicPermission());
          logWarn('vocal', `mic monitor unavailable: ${String(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        recorderRef.current?.stop();
      } catch {
        /* not recording */
      }
      recorderRef.current = null;
      monitorRef.current?.stop();
      monitorRef.current = null;
    };
  }, [deviceId, refreshInputs]);

  const loadArtifact = useCallback(async (id: string) => {
    const doc = await fetchVocalArtifact(id);
    if (!doc) {
      setStatus('no artifact for asset (analyze it first)');
      return;
    }
    setArtifact(doc);
    const bpm = doc.timing?.tempo_bpm || usePianoRollStore.getState().bpm;
    usePianoRollStore.getState().importNotes(artifactToPiano(doc.notes, bpm), bpm);
    setStatus(`loaded ${doc.notes.length} notes`);
  }, []);

  // Record the mic, then convert through the backend basic-pitch path and place
  // the take in the roll WITHOUT shrinking the grid (it stays >= 256 steps).
  const toggleRecord = useCallback(() => {
    if (recording) {
      recorderRef.current?.stop(); // onstop does the conversion
      return;
    }
    const monitor = monitorRef.current;
    if (!monitor) {
      setStatus('no mic - check permission / input device');
      return;
    }
    try {
      const rec = new MediaRecorder(monitor.stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        setRecording(false);
        const elapsedSec = (performance.now() - recordStartRef.current) / 1000;
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        logInfo(
          'vocal',
          `recording stopped - ${(blob.size / 1024).toFixed(0)}KB, converting via basic-pitch`,
        );
        setBusy(true);
        setStatus('converting recording to notes...');
        try {
          const fd = new FormData();
          fd.append('file', blob, 'recording.webm');
          const res = await fetch('/api/vocal/audio-to-notes', { method: 'POST', body: fd });
          const data = await res.json();
          const notes: ArtifactNote[] = data.notes ?? [];
          const bpm = usePianoRollStore.getState().bpm;
          const piano = artifactToPiano(notes, bpm);
          const endStep = Math.max(1, Math.ceil(elapsedSec / stepSec(bpm)));
          usePianoRollStore.getState().placeRecording(piano, { startStep: 0, endStep });
          setStatus(`recorded ${piano.length} notes (${elapsedSec.toFixed(1)}s)`);
          logInfo('vocal', `recording -> ${piano.length} notes via basic-pitch`);
        } catch (e) {
          setStatus(`convert error: ${String(e)}`);
          logWarn('vocal', `audio-to-notes failed: ${String(e)}`);
        } finally {
          setBusy(false);
          recorderRef.current = null;
        }
      };
      recorderRef.current = rec;
      recordStartRef.current = performance.now();
      rec.start();
      setRecording(true);
      setStatus('recording - sing, then stop');
      const track = monitor.stream.getAudioTracks()[0];
      const st = track?.getSettings?.() ?? {};
      logInfo(
        'vocal',
        `recording from "${track?.label || 'default'}" ${st.sampleRate ?? '?'}Hz muted=${track?.muted}`,
      );
      window.setTimeout(() => {
        if (recorderRef.current && (monitorRef.current?.getLevel() ?? 0) < 0.02) {
          logWarn('vocal', 'no mic signal during recording (level ~0%) - wrong input or muted');
        }
      }, 1500);
    } catch (e) {
      setStatus(`record error: ${String(e)}`);
      logWarn('vocal', `record error: ${String(e)}`);
    }
  }, [recording]);

  const analyze = useCallback(async () => {
    if (!assetId) {
      setStatus('enter or select an asset id');
      return;
    }
    setBusy(true);
    setStatus('analyzing vocal...');
    try {
      const res = await fetch('/api/vocal/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: assetId, transcribe: true }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`prepare ${res.status}: ${detail.slice(0, 200)}`);
      }
      const { job } = await res.json();
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const jr = await fetch(`/api/vocal/jobs/${job.id}`);
        const jd = await jr.json();
        setStatus(jd.message || jd.status);
        if (jd.status === 'done') {
          await loadArtifact(assetId);
          break;
        }
        if (jd.status === 'failed' || jd.status === 'cancelled') {
          setStatus(`analyze ${jd.status}: ${jd.error ?? ''}`);
          break;
        }
      }
    } catch (e) {
      setStatus(`analyze error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [assetId, loadArtifact]);

  const exportMidi = useCallback(() => {
    const { notes, bpm } = usePianoRollStore.getState();
    if (!notes.length) {
      setStatus('no notes to export');
      return;
    }
    // downloadVocalMidi wraps the canonical RenderNote->SMF writer. Export exactly
    // what is in the roll (post-edit), not the stale artifact.
    downloadVocalMidi(pianoToArtifact(notes, bpm), 'midi');
    setStatus(`exported ${notes.length} notes to .mid`);
  }, []);

  const validate = useCallback(async () => {
    if (!assetId) return;
    const r = await fetch(`/api/vocal/validate/${assetId}`);
    const d = await r.json();
    setValidateMsg(
      d.ok
        ? `round-trip ${d.count_in} to ${d.count_out}, drift ${d.max_drift_ms}ms`
        : `validate: ${d.error}`,
    );
  }, [assetId]);

  const makeBeat = useCallback(async () => {
    const { notes, bpm } = usePianoRollStore.getState();
    if (!notes.length) {
      setStatus('no notes for a beat');
      return;
    }
    const render = pianoToRender(notes, bpm);
    setStatus('rendering beat...');
    try {
      const { blob } = await renderDrumBeatBlob(render);
      const span = Math.max(...render.map((r) => r.startSec)) + 0.5;
      const fx = vocalizeEffect(render, span);
      const url = URL.createObjectURL(blob);
      void new Audio(url).play().catch(() => {});
      setTimeout(() => URL.revokeObjectURL(url), 20000);
      setStatus(`beat playing - fx idea: ${fx.effectId} (${fx.reason})`);
    } catch (e) {
      setStatus(`beat error: ${String(e)}`);
    }
  }, []);

  const inpaintSegment = useCallback(
    async (i: number) => {
      if (!artifact) return;
      const ok = await armInpaintGuide(artifact, i);
      setStatus(
        ok
          ? 'inpaint guide armed - open MAKE and Generate to re-sing the segment'
          : 'segment has no mask window (starts at 0)',
      );
    },
    [artifact],
  );

  const btn =
    'flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wide rounded border transition-colors disabled:opacity-40';

  return (
    <div className="h-full w-full flex flex-col bg-zinc-950 text-zinc-200">
      {/* tools toolbar — vocal recording is the input; the rest operate on the roll */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-white/8">
        {/* Vocal input */}
        <label htmlFor="midi-input-device" className="sr-only">
          Microphone input
        </label>
        <select
          id="midi-input-device"
          name="midi-input-device"
          value={deviceId}
          onChange={(e) => pickDevice(e.target.value)}
          aria-label="Microphone input"
          title="Microphone input device used for recording and the level meter"
          className="max-w-40 bg-zinc-800 border border-zinc-500 text-zinc-100 text-[10px] font-mono px-1 py-1 rounded"
        >
          <option value="">System default input</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
        {micPerm === 'denied' && (
          <span className="text-[9px] font-mono text-rose-400">mic blocked</span>
        )}
        <button
          type="button"
          onClick={toggleRecord}
          disabled={busy || micPerm === 'denied'}
          aria-label={recording ? 'Stop recording' : 'Record vocal to notes'}
          title={recording ? 'Stop recording' : 'Record (mic -> notes via basic-pitch)'}
          className={`grid place-items-center w-7 h-7 rounded border transition-colors disabled:opacity-40 ${
            recording
              ? 'border-rose-500 text-rose-300 bg-rose-600/25'
              : 'border-rose-600 text-rose-300 hover:bg-rose-600/15'
          }`}
        >
          {recording ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        </button>
        <MicMeter monitorRef={monitorRef} />

        <span className="w-px h-4 bg-white/10" aria-hidden="true" />

        {/* Analyze a library vocal into the roll — search by name or drop a
            library item here instead of pasting a raw id. */}
        <div
          className="relative"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-thedaw-library-id')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            const id = e.dataTransfer.getData('application/x-thedaw-library-id');
            if (!id) return;
            e.preventDefault();
            const dropped = entries.find((en) => en.id === id);
            pickAsset(id, dropped?.title ?? id);
          }}
        >
          <label htmlFor="midi-asset-id" className="sr-only">
            Search library song
          </label>
          <input
            id="midi-asset-id"
            name="midi-asset-id"
            type="text"
            value={assetQuery}
            onChange={(e) => {
              setAssetQuery(e.target.value);
              setAssetId(e.target.value.trim());
              setAssetOpen(true);
            }}
            onFocus={() => setAssetOpen(true)}
            onBlur={() => window.setTimeout(() => setAssetOpen(false), 150)}
            placeholder="search song / drop here"
            aria-label="Search library song"
            aria-expanded={assetOpen}
            title="Type a song name (or drop a library item here). Pick a result to use it — no need to paste a raw id."
            className="w-44 bg-zinc-800 border border-zinc-500 text-zinc-100 text-[10px] font-mono px-1.5 py-1 rounded"
          />
          {assetOpen && assetMatches.length > 0 && (
            <div
              role="listbox"
              className="absolute left-0 top-full mt-1 z-50 w-64 max-h-56 overflow-y-auto rounded border border-zinc-600 bg-zinc-900 shadow-2xl"
            >
              {assetMatches.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={e.id === assetId}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => pickAsset(e.id, e.title)}
                  className={`w-full text-left px-2 py-1.5 text-[10px] border-b border-white/5 last:border-0 hover:bg-purple-500/15 ${
                    e.id === assetId ? 'bg-purple-500/10 text-purple-200' : 'text-zinc-200'
                  }`}
                >
                  <span className="block truncate">{e.title}</span>
                  <span className="block truncate text-[8px] font-mono text-zinc-500">{e.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={analyze}
          disabled={busy}
          title="Detect notes, pitch and lyrics from the library vocal (basic-pitch) and load them into the roll"
          className={`${btn} border-emerald-600 text-emerald-300 hover:bg-emerald-600/15`}
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
          Analyze
        </button>
        <button
          type="button"
          onClick={() => assetId && loadArtifact(assetId)}
          disabled={busy || !assetId}
          title="Load an already-analyzed artifact's notes + lyrics into the roll without re-detecting"
          className={`${btn} border-zinc-500 text-zinc-200 hover:bg-white/10`}
        >
          Load
        </button>

        <span className="w-px h-4 bg-white/10" aria-hidden="true" />

        {/* Roll tools */}
        <button
          type="button"
          onClick={exportMidi}
          title="Download the current roll as a Standard MIDI (.mid) file"
          className={`${btn} border-zinc-500 text-zinc-200 hover:bg-white/10`}
        >
          <Download className="w-3 h-3" />
          .mid
        </button>
        <button
          type="button"
          onClick={makeBeat}
          title="Render a General MIDI drum beat from the notes (low/mid/high -> kick/snare/hat) and play it"
          className={`${btn} border-amber-600 text-amber-300 hover:bg-amber-600/15`}
        >
          <Drum className="w-3 h-3" />
          Beat
        </button>
        <button
          type="button"
          onClick={validate}
          disabled={!assetId}
          title="Check the notes survive a notes -> MIDI -> notes round-trip and report any timing drift"
          className={`${btn} border-zinc-500 text-zinc-200 hover:bg-white/10`}
        >
          <FileCheck2 className="w-3 h-3" />
          Validate
        </button>

        <span className="w-px h-4 bg-white/10" aria-hidden="true" />

        <button
          type="button"
          onClick={() => setArpOn((v) => !v)}
          aria-pressed={arpOn}
          title={arpOn ? 'Back to the piano roll' : 'Chord-progression arpeggiator'}
          className={`${btn} ${
            arpOn
              ? 'border-amber-400 text-amber-200 bg-amber-400/20'
              : 'border-amber-600 text-amber-300 hover:bg-amber-600/15'
          }`}
        >
          <Music4 className="w-3 h-3" />
          Arp
        </button>
        <span className="text-[10px] font-mono text-zinc-500 truncate min-w-0 flex-1 text-right">
          {status}
        </span>
      </div>

      {/* body: piano roll (or the arpeggiator face), plus a vocal rail only when
          an artifact is loaded. The arpeggiator stays mounted but hidden so its
          transport keeps running when toggling back to the roll. */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 relative">
          <div className={arpOn ? 'hidden' : 'absolute inset-0'}>
            <PianoRoll />
          </div>
          <div className={arpOn ? 'absolute inset-0' : 'hidden'}>
            <ArpeggiatorPanel />
          </div>
        </div>

        {!arpOn && artifact && (
          <div className="w-64 shrink-0 border-l border-white/8 overflow-y-auto p-2 space-y-3">
            <section>
              <h3 className="text-[8px] font-mono uppercase tracking-widest text-zinc-500 mb-1">
                Lyrics
              </h3>
              <p className="text-[10px] text-zinc-300 whitespace-pre-wrap wrap-break-word">
                {artifact.lyrics?.text || (
                  <span className="text-zinc-600">none (analyze with transcription)</span>
                )}
              </p>
            </section>

            <section>
              <h3 className="text-[8px] font-mono uppercase tracking-widest text-zinc-500 mb-1">
                Segments
              </h3>
              {artifact.segments?.length ? (
                <ul className="space-y-1">
                  {artifact.segments.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-1.5">
                      <span className="flex-1 min-w-0 truncate text-[10px] font-mono text-zinc-400">
                        {(s.start_ms / 1000).toFixed(2)}-{(s.end_ms / 1000).toFixed(2)}s {s.kind}
                      </span>
                      <button
                        type="button"
                        onClick={() => inpaintSegment(i)}
                        className="text-[8px] font-mono uppercase px-1 py-0.5 rounded border border-fuchsia-600 text-fuchsia-300 hover:bg-fuchsia-600/15"
                      >
                        Inpaint
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[10px] text-zinc-600">none</p>
              )}
            </section>

            {validateMsg && (
              <p className="text-[9px] font-mono text-zinc-400 wrap-break-word">{validateMsg}</p>
            )}
          </div>
        )}

        {/* Vocal2MIDI suite — the full vocal-to-MIDI tool as a collapsible right
            column. Its recorder/AI/editor write notes into the piano roll above. */}
        {!arpOn && <Vocal2MidiPanel />}
      </div>
    </div>
  );
};
