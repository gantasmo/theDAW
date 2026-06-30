/**
 * MetamorphPanel — the UI for the live granular identity-bleed morph (Phase M).
 *
 * Pick a DONOR (A, the "identity") and a HOST (B, the structure). Sources are the
 * clips already on the timeline first (stems, layers, anything you dropped in),
 * with the wider library underneath. Press play to hear B rebuilt out of A's grains
 * in real time; `Bleed` crossfades dry-B into the mosaic, `Match` sets how strictly
 * grains are chosen. "Send to editor" renders one pass and drops it on a new track,
 * where it is an ordinary clip you can trim, FX, and export.
 */

import { useEffect, useState } from 'react';
import { Play, Square, Download } from 'lucide-react';
import { SlideTrack } from './SlideTrack';
import { useLibraryStore } from '../../state/libraryStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { useMorphStore, type MorphParams, type MorphSource } from '../../state/morphEngine';

const SLIDERS: { key: keyof MorphParams; label: string; min: number; max: number; step: number; unit?: string }[] = [
  { key: 'bleed', label: 'Bleed', min: 0, max: 1, step: 0.01 },
  { key: 'grainSize', label: 'Grain', min: 0.02, max: 0.4, step: 0.005, unit: 's' },
  { key: 'grainRate', label: 'Rate', min: 2, max: 80, step: 1, unit: '/s' },
  { key: 'spray', label: 'Spray', min: 0, max: 1, step: 0.01 },
  { key: 'match', label: 'Match', min: 0, max: 1, step: 0.01 },
  { key: 'sync', label: 'Sync', min: 0, max: 1, step: 0.01 },
  { key: 'favor', label: 'Favor', min: 0, max: 1, step: 0.01 },
  { key: 'gain', label: 'Gain', min: 0, max: 1.5, step: 0.01 },
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function MetamorphPanel() {
  const entries = useLibraryStore((s) => s.entries);
  const loaded = useLibraryStore((s) => s.loaded);
  const load = useLibraryStore((s) => s.load);
  const audio = entries.filter((e) => (e.kind ?? 'audio') === 'audio');

  const clips = useEditorStore((s) => s.clips);
  const tracks = useEditorStore((s) => s.tracks);
  const trackName = (id: string) => tracks.find((t) => t.id === id)?.name ?? 'Track';

  const aId = useMorphStore((s) => s.aId);
  const bId = useMorphStore((s) => s.bId);
  const aTitle = useMorphStore((s) => s.aTitle);
  const bTitle = useMorphStore((s) => s.bTitle);
  const status = useMorphStore((s) => s.status);
  const playing = useMorphStore((s) => s.playing);
  const posSec = useMorphStore((s) => s.posSec);
  const durSec = useMorphStore((s) => s.durSec);
  const params = useMorphStore((s) => s.params);
  const loadA = useMorphStore((s) => s.loadA);
  const loadB = useMorphStore((s) => s.loadB);
  const play = useMorphStore((s) => s.play);
  const stop = useMorphStore((s) => s.stop);
  const setParam = useMorphStore((s) => s.setParam);

  const [sending, setSending] = useState(false);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  // Silence the morph when the panel unmounts (closed, or leaving the editor).
  useEffect(() => () => useMorphStore.getState().stop(), []);

  // Resolve a select value ("clip:<id>" | "lib:<id>") to a loadable source.
  const resolve = async (val: string): Promise<MorphSource | null> => {
    if (val.startsWith('clip:')) {
      const c = clips.find((x) => `clip:${x.id}` === val);
      return c ? { id: val, title: c.label || trackName(c.trackId), blob: c.audioBlob } : null;
    }
    if (val.startsWith('lib:')) {
      const e = audio.find((x) => `lib:${x.id}` === val);
      if (!e) return null;
      const blob = await useLibraryStore.getState().fetchAudioBlob(e);
      return { id: val, title: e.title, blob };
    }
    return null;
  };

  const pick = (which: 'a' | 'b') => async (ev: React.ChangeEvent<HTMLSelectElement>) => {
    const src = await resolve(ev.target.value);
    if (!src) return;
    if (which === 'a') void loadA(src); else void loadB(src);
  };

  const sendToEditor = async () => {
    setSending(true);
    try {
      const blob = await useMorphStore.getState().renderToBlob();
      if (!blob) return;
      const ed = useEditorStore.getState();
      const name = (`${aTitle || 'A'}→${bTitle || 'B'}`).slice(0, 24);
      const trackId = ed.addTrack({ name });
      const color = ed.tracks.find((t) => t.id === trackId)?.color;
      const { peaks, duration } = await computePeaks(blob, 240);
      const clipId = ed.addClipToTrack({
        trackId,
        label: name,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        offsetIntoSource: 0,
        durationSec: duration,
        startSec: 0,
        color,
      });
      ed.cachePeaks(clipId, peaks);
    } finally {
      setSending(false);
    }
  };

  const ready = status === 'ready' || (!!aId && !!bId);

  const SourceOptions = () => (
    <>
      <option value="">— choose —</option>
      {clips.length > 0 && (
        <optgroup label="On the timeline">
          {clips.map((c) => (
            <option key={`clip:${c.id}`} value={`clip:${c.id}`}>{trackName(c.trackId)} · {c.label}</option>
          ))}
        </optgroup>
      )}
      {audio.length > 0 && (
        <optgroup label="Library">
          {audio.map((e) => (<option key={`lib:${e.id}`} value={`lib:${e.id}`}>{e.title}</option>))}
        </optgroup>
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="morph-donor" className="text-[9px] font-mono text-zinc-500">Donor A (identity)</label>
          <select
            id="morph-donor"
            name="morph-donor"
            value={aId ?? ''}
            onChange={pick('a')}
            className="form-select px-2 py-1 text-[11px] font-mono"
            style={{ colorScheme: 'dark' }}
          >
            <SourceOptions />
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="morph-host" className="text-[9px] font-mono text-zinc-500">Host B (structure)</label>
          <select
            id="morph-host"
            name="morph-host"
            value={bId ?? ''}
            onChange={pick('b')}
            className="form-select px-2 py-1 text-[11px] font-mono"
            style={{ colorScheme: 'dark' }}
          >
            <SourceOptions />
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => (playing ? stop() : void play())}
          disabled={!ready}
          aria-label={playing ? 'Stop the morph' : 'Play the morph'}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-mono uppercase tracking-wider transition-colors disabled:opacity-30 disabled:pointer-events-none
            ${playing ? 'bg-purple-500/30 border-purple-500/50 text-purple-200' : 'border-purple-500/30 text-purple-300 hover:bg-purple-500/10'}`}
        >
          {playing ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
          {playing ? 'Stop' : 'Play'}
        </button>
        <button
          onClick={() => void sendToEditor()}
          disabled={!ready || sending}
          aria-label="Render the morph and add it to the timeline"
          title="Render one pass and drop it on a new track as an ordinary clip"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-white/10 text-[10px] font-mono uppercase tracking-wider text-zinc-300 hover:bg-white/5 transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <Download className={`w-3 h-3 ${sending ? 'animate-pulse' : ''}`} />
          {sending ? 'Rendering…' : 'Send to editor'}
        </button>
        <span className="text-[9px] font-mono text-zinc-500 tabular-nums">{fmt(posSec)} / {fmt(durSec)}</span>
        <span className="text-[9px] font-mono text-zinc-600">
          {status === 'loading' ? 'loading…' : status === 'error' ? 'load failed' : ready ? '' : 'pick A + B'}
        </span>
      </div>

      <div className="grid gap-x-4 gap-y-1 grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
        {SLIDERS.map((p) => {
          const labelId = `morph-${p.key}-label`;
          const v = params[p.key];
          const decimals = p.step < 0.1 ? (p.step < 0.01 ? 3 : 2) : 0;
          return (
            <div key={p.key} className="flex items-center gap-2">
              <span id={labelId} className="text-[9px] font-mono text-zinc-500 w-12 shrink-0">{p.label}</span>
              <SlideTrack
                value={v}
                min={p.min}
                max={p.max}
                step={p.step}
                ariaLabelledBy={labelId}
                className="flex-1"
                onChange={(nv) => setParam(p.key, nv)}
              />
              <span className="text-[9px] font-mono text-zinc-400 w-14 shrink-0 text-right tabular-nums">
                {v.toFixed(decimals)}{p.unit ? ` ${p.unit}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
