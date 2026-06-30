/**
 * DrawPanel - the DRAW bottom tab. A generative draw-to-music instrument ported
 * from art2music onto the shared Web Audio graph (see lib/drawEngine). Draw on
 * the canvas to play live; record the session and either save it to the library
 * or drop it onto a new EDIT track. Switch between the faithful noise DRONE and a
 * SOUNDFONT voice, pick a mode/instrument, and set the master level.
 */

import { ArrowLeft, Disc, Eraser, Save, Send, Sparkles, SlidersHorizontal, Square, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BRUSHES, DrawEngine, DRAW_EFFECT_OPTIONS, drawEffectMeta, type BrushId, type SoundMode } from '../../lib/drawEngine';
import { GM_NAMES } from '../../lib/gmInstruments';
import { RACK_EFFECTS } from '../../lib/rackEffects';
import { STUDIO_MODULES, type StudioModule } from '../../lib/moduleCatalog';
import { sendAudioToEditor, type SendableAudio } from '../../lib/sendToTargets';
import { useDrawFxStore } from '../../state/drawEffectChainStore';
import { useDrawModeStore } from '../../state/drawModeStore';
import { useLibraryStore } from '../../state/libraryStore';
import { logError, logInfo } from '../../state/logStore';
import { pollMagentaJob } from '../../state/instrumentStore';
import { FxRack } from '../audio/FxRack';
import { EffectGuiStage } from '../audio/EffectGuiStage';

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** A distinct hue per live effect so each label in the palette reads its own color. */
const EFFECT_HUE: Record<string, number> = Object.fromEntries(
  RACK_EFFECTS.map((d, i) => [d.id, Math.round((i * 360) / RACK_EFFECTS.length)]),
);

/** Mode-effect dropdown groups (built-in draw effects, then live psychoacoustics). */
const MODE_GROUPS = ['Draw', 'Psychoacoustic'];

export const DrawPanel: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<DrawEngine | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recStartRef = useRef(0);

  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const entries = useLibraryStore((s) => s.entries);
  const [brush, setBrush] = useState<BrushId>('organic');
  const [mode, setMode] = useState(0);
  const [soundMode, setSoundMode] = useState<SoundMode>('drone');
  const [program, setProgram] = useState(89);
  const [volume, setVolume] = useState(0.8);
  const [recording, setRecording] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [grainName, setGrainName] = useState('');
  const [magLive, setMagLive] = useState(false);
  const [status, setStatus] = useState('');
  const [fxOpen, setFxOpen] = useState(false);
  const [studioModule, setStudioModule] = useState<StudioModule | null>(null);

  const slots = useDrawModeStore((s) => s.slots);
  const setSlot = useDrawModeStore((s) => s.setSlot);

  const chain = useDrawFxStore((s) => s.chain);
  const addEffect = useDrawFxStore((s) => s.addEffect);
  const removeEffect = useDrawFxStore((s) => s.removeEffect);
  const updateParams = useDrawFxStore((s) => s.updateParams);
  const toggleEnabled = useDrawFxStore((s) => s.toggleEnabled);
  const reorder = useDrawFxStore((s) => s.reorder);
  const clearChain = useDrawFxStore((s) => s.clearChain);

  // Create the engine once the canvas exists; keep the drawing buffer matched to
  // the element size so strokes land where the cursor is.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const size = () => {
      canvas.width = Math.max(1, container.clientWidth);
      canvas.height = Math.max(1, container.clientHeight);
    };
    size();
    const engine = new DrawEngine(canvas);
    engineRef.current = engine;
    engine.setMasterVolume(volume);
    engine.onMagentaStatus = (s) => setStatus(s);
    const ro = new ResizeObserver(size);
    ro.observe(container);
    return () => {
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
      try {
        recorderRef.current?.stop();
      } catch {
        /* not recording */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the live FX chain on the engine when its STRUCTURE changes
  // (add/remove/reorder/toggle). Pure param tweaks go straight to the running
  // nodes via onChainParams, so a slider drag never re-wires the graph.
  const chainSig = chain.map((e) => `${e.id}:${e.effect}:${e.enabled ? 1 : 0}`).join('|');
  useEffect(() => {
    engineRef.current?.setChain(useDrawFxStore.getState().chain);
  }, [chainSig]);

  // Push reassigned per-stroke mode slots to the engine.
  useEffect(() => {
    engineRef.current?.setModeSlots(slots);
  }, [slots]);

  // The latest recording, as a File the Studio module iframes can ingest.
  const recordingFile = useMemo(
    () => (blob ? new File([blob], `draw-${stamp()}.webm`, { type: blob.type || 'audio/webm' }) : null),
    [blob],
  );

  const addAllEffects = useCallback(() => {
    for (const d of RACK_EFFECTS) addEffect(d.id);
  }, [addEffect]);

  const onChainParams = useCallback(
    (id: string, p: Record<string, number>) => {
      updateParams(id, p);
      engineRef.current?.updateChainParam(id, p);
    },
    [updateParams],
  );

  const pickBrush = useCallback((id: BrushId) => {
    setBrush(id);
    engineRef.current?.setBrush(id);
  }, []);
  const pickMode = useCallback((i: number) => {
    setMode(i);
    engineRef.current?.setMode(i);
  }, []);
  const loadGrain = useCallback(async () => {
    const entry = entries.find((e) => e.id === selectedEntryId);
    if (!entry) {
      setGrainName('');
      setStatus('select a library song to granulate');
      return;
    }
    const url = useLibraryStore.getState().getAudioUrl(entry);
    setStatus(`loading grains from "${entry.title}"...`);
    const ok = await engineRef.current?.loadGrainSource(url);
    setGrainName(ok ? entry.title : '');
    setStatus(ok ? `grains: "${entry.title}"` : 'grain source failed to load');
  }, [entries, selectedEntryId]);

  const pickSoundMode = useCallback((m: SoundMode) => {
    setSoundMode(m);
    engineRef.current?.setSoundMode(m);
  }, []);

  // Load / reload the grain source when granular is active or the selection moves.
  // Skip while the live Magenta loop owns the grain buffer.
  useEffect(() => {
    if (soundMode === 'granular' && !magLive) void loadGrain();
  }, [soundMode, selectedEntryId, loadGrain, magLive]);

  const toggleMagentaLive = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.magentaLive) {
      engine.stopMagentaGrain();
      setMagLive(false);
      if (soundMode === 'granular') void loadGrain();
    } else {
      if (soundMode !== 'granular') pickSoundMode('granular');
      setMagLive(true);
      void engine.startMagentaGrain('evolving instrumental texture');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundMode, loadGrain]);
  const pickInstrument = useCallback((p: number) => {
    setProgram(p);
    engineRef.current?.setInstrument(p);
  }, []);
  const changeVolume = useCallback((v: number) => {
    setVolume(v);
    engineRef.current?.setMasterVolume(v);
  }, []);
  const clear = useCallback(() => {
    engineRef.current?.clear();
    setStatus('cleared');
  }, []);

  const toggleRecord = useCallback(() => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const stream = engineRef.current?.recordDest.stream;
    if (!stream) return;
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      setRecording(false);
      const b = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      setBlob(b);
      setStatus(`recorded ${(b.size / 1024).toFixed(0)}KB - save or send`);
      logInfo('draw', `recording stopped (${(b.size / 1024).toFixed(0)}KB)`);
    };
    recorderRef.current = rec;
    recStartRef.current = performance.now();
    rec.start();
    setRecording(true);
    setStatus('recording - draw away, then stop');
    logInfo('draw', 'recording started');
  }, [recording]);

  const saveToLibrary = useCallback(async () => {
    if (!blob) return;
    setBusy(true);
    try {
      const name = `draw-${stamp()}`;
      const entry = await useLibraryStore.getState().importEntry({
        blob,
        filename: `${name}.webm`,
        mimeType: blob.type || 'audio/webm',
        metadata: {
          title: name,
          model: 'draw',
          duration: (performance.now() - recStartRef.current) / 1000,
          source: 'import',
          tags: ['draw'],
        },
      });
      setStatus(`saved "${entry.title}" to library`);
      logInfo('draw', `saved ${entry.title} to library`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`save failed: ${msg}`);
      logError('draw', `library save failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [blob]);

  const sendToEdit = useCallback(async () => {
    if (!blob) return;
    setBusy(true);
    try {
      const item: SendableAudio = {
        label: `draw-${stamp()}.webm`,
        mimeType: blob.type || 'audio/webm',
        fetcher: async () => blob,
      };
      const clipId = await sendAudioToEditor(item, 'editor-new-track');
      setStatus(clipId ? 'sent to EDIT (new track)' : 'send to EDIT failed');
      if (clipId) logInfo('draw', 'sent recording to EDIT');
    } finally {
      setBusy(false);
    }
  }, [blob]);

  // Hand the drawn melody to the Magenta RT2 sidecar for a full arrangement; the
  // result lands in the library. Needs Magenta installed (412 -> setup prompt).
  const jamMagenta = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const melody = engine.getMelody();
    if (!melody.length) {
      setStatus('draw a melody first, then jam with Magenta');
      return;
    }
    const span = Math.max(...melody.map((n) => n.end));
    const duration = Math.min(20, Math.max(4, Math.round(span)));
    setBusy(true);
    setStatus('Magenta is jamming over your melody...');
    try {
      const form = new FormData();
      form.append('prompt', 'instrumental jam, full arrangement');
      form.append('duration', String(duration));
      form.append('model_size', 'small');
      form.append('notes', JSON.stringify(melody));
      const res = await fetch('/api/magenta/generate', { method: 'POST', body: form });
      if (res.status === 412) {
        setStatus('Magenta is not installed - run Setup-MRT2 once (see Settings)');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { job } = await res.json();
      const arr = await pollMagentaJob(job.id);
      const b = new Blob([arr], { type: 'audio/wav' });
      setBlob(b);
      const name = `draw-jam-${stamp()}`;
      const entry = await useLibraryStore.getState().importEntry({
        blob: b,
        filename: `${name}.wav`,
        mimeType: 'audio/wav',
        metadata: { title: name, model: 'magenta', duration, source: 'import', tags: ['draw', 'magenta'] },
      });
      setStatus(`Magenta jam saved: "${entry.title}"`);
      logInfo('draw', `magenta jam saved ${entry.title}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Magenta jam failed: ${msg}`);
      logError('draw', `magenta jam failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const iconBtn =
    'grid place-items-center w-7 h-7 rounded border transition-colors disabled:opacity-40';

  return (
    <div className="h-full w-full flex flex-col bg-zinc-950 text-zinc-200">
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-white/8">
        {/* brush — the visual + sonic character of a stroke */}
        <div className="flex items-center gap-1" role="group" aria-label="Brush">
          {BRUSHES.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => pickBrush(b.id)}
              title={b.desc}
              className="px-1.5 h-6 grid place-items-center text-[9px] font-black uppercase tracking-wide rounded border transition-colors"
              style={
                brush === b.id
                  ? { borderColor: `hsl(${b.hue} 80% 60%)`, color: `hsl(${b.hue} 85% 78%)`, background: `hsl(${b.hue} 80% 50% / 0.2)` }
                  : { borderColor: 'rgb(63 63 70)', color: 'rgb(161 161 170)' }
              }
            >
              {b.label}
            </button>
          ))}
        </div>

        <span className="w-px h-4 bg-white/10" aria-hidden="true" />

        {/* mode — per-stroke effect slots, each reassignable to any effect */}
        <div className="flex items-center gap-1" role="group" aria-label="Effect mode">
          {slots.map((eff, i) => {
            const info = drawEffectMeta(eff);
            const hue = info?.hue ?? 0;
            return (
              <button
                key={i}
                type="button"
                onClick={() => pickMode(i)}
                title={info ? `${info.label}: ${info.desc}` : eff}
                className="w-6 h-6 grid place-items-center text-[10px] font-mono rounded border transition-colors"
                style={
                  mode === i
                    ? { borderColor: `hsl(${hue} 80% 60%)`, color: `hsl(${hue} 85% 75%)`, background: `hsl(${hue} 80% 50% / 0.2)` }
                    : { borderColor: 'rgb(82 82 91)', color: 'rgb(161 161 170)' }
                }
              >
                {i + 1}
              </button>
            );
          })}
        </div>
        {/* reassign the selected mode slot to any live effect */}
        <label htmlFor="draw-mode-effect" className="sr-only">
          Effect for the selected mode
        </label>
        <select
          id="draw-mode-effect"
          name="draw-mode-effect"
          value={slots[mode] ?? 'clean'}
          onChange={(e) => setSlot(mode, e.target.value)}
          title="Change the selected mode to any effect"
          className="bg-zinc-800 border border-zinc-500 text-zinc-100 text-[10px] font-mono px-1 py-1 rounded"
        >
          {MODE_GROUPS.map((grp) => (
            <optgroup key={grp} label={grp}>
              {DRAW_EFFECT_OPTIONS.filter((o) => o.group === grp).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </optgroup>
          ))}
        </select>

        <span className="w-px h-4 bg-white/10" aria-hidden="true" />

        {/* sound source */}
        <label htmlFor="draw-sound-mode" className="sr-only">
          Sound source
        </label>
        <select
          id="draw-sound-mode"
          name="draw-sound-mode"
          value={soundMode}
          onChange={(e) => pickSoundMode(e.target.value as SoundMode)}
          title="How strokes make sound: a filtered-noise drone, played notes on a soundfont instrument, or grains sampled from a library song"
          className="bg-zinc-800 border border-zinc-500 text-zinc-100 text-[10px] font-mono px-1 py-1 rounded"
        >
          <option value="drone">Drone</option>
          <option value="soundfont">Soundfont</option>
          <option value="granular">Granular</option>
        </select>
        {soundMode === 'soundfont' && (
          <>
            <label htmlFor="draw-instrument" className="sr-only">
              Instrument
            </label>
            <select
              id="draw-instrument"
              name="draw-instrument"
              value={program}
              onChange={(e) => pickInstrument(Number(e.target.value))}
              title="Instrument the drawn notes play through"
              className="max-w-40 bg-zinc-800 border border-zinc-500 text-zinc-100 text-[10px] font-mono px-1 py-1 rounded"
            >
              {GM_NAMES.map((n, i) => (
                <option key={n} value={i}>{`${i + 1}. ${n}`}</option>
              ))}
            </select>
          </>
        )}
        {soundMode === 'granular' && (
          <>
            <span className="text-[9px] font-mono text-zinc-400 max-w-40 truncate" title="Source the grains are sampled from: a library song, or live Magenta when enabled">
              {magLive ? 'Magenta live' : grainName ? grainName : 'select a library song'}
            </span>
            <button
              type="button"
              onClick={toggleMagentaLive}
              title="Stream live Magenta audio as the grain source (continuous generation, Collider-style). Needs Magenta installed; cannot run at the same time as the Jam tools."
              aria-label={magLive ? 'Stop live Magenta grain source' : 'Start live Magenta grain source'}
              className={`px-1.5 h-6 grid place-items-center text-[9px] font-black uppercase tracking-wide rounded border transition-colors ${
                magLive
                  ? 'border-fuchsia-500 text-fuchsia-200 bg-fuchsia-600/25'
                  : 'border-fuchsia-700 text-fuchsia-300 hover:bg-fuchsia-600/15'
              }`}
            >
              {magLive ? 'Live on' : 'Live'}
            </button>
          </>
        )}

        <span className="w-px h-4 bg-white/10" aria-hidden="true" />

        {/* master volume */}
        <label htmlFor="draw-volume" className="text-[9px] font-mono text-zinc-500">
          VOL
        </label>
        <input
          id="draw-volume"
          name="draw-volume"
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={volume}
          onChange={(e) => changeVolume(Number(e.target.value))}
          title="Master output level for the draw instrument"
          className="w-20 accent-purple-400"
        />

        <button
          type="button"
          onClick={clear}
          title="Clear the canvas and silence all voices"
          aria-label="Clear"
          className={`${iconBtn} border-zinc-600 text-zinc-300 hover:bg-white/10`}
        >
          <Eraser className="w-3.5 h-3.5" />
        </button>

        <span className="w-px h-4 bg-white/10" aria-hidden="true" />

        {/* record + outputs */}
        <button
          type="button"
          onClick={toggleRecord}
          title={recording ? 'Stop recording' : 'Record the draw session to audio'}
          aria-label={recording ? 'Stop recording' : 'Record'}
          className={`${iconBtn} ${
            recording
              ? 'border-rose-500 text-rose-300 bg-rose-600/25'
              : 'border-rose-600 text-rose-300 hover:bg-rose-600/15'
          }`}
        >
          {recording ? <Square className="w-3.5 h-3.5" /> : <Disc className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={saveToLibrary}
          disabled={!blob || busy}
          title="Save the recording into the library"
          aria-label="Save to library"
          className={`${iconBtn} border-emerald-600 text-emerald-300 hover:bg-emerald-600/15`}
        >
          <Save className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={sendToEdit}
          disabled={!blob || busy}
          title="Add the recording to a new track in EDIT"
          aria-label="Send to EDIT"
          className={`${iconBtn} border-cyan-600 text-cyan-300 hover:bg-cyan-600/15`}
        >
          <Send className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={jamMagenta}
          disabled={busy}
          title="Send your drawn melody to Magenta to jam a full arrangement into the library (needs Magenta installed)"
          aria-label="Jam with Magenta"
          className={`${iconBtn} border-fuchsia-600 text-fuchsia-300 hover:bg-fuchsia-600/15`}
        >
          <Sparkles className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setFxOpen((v) => !v)}
          title="FX chain: add any MIX effect to process all drawn audio, or open a Studio module"
          aria-label="FX chain"
          aria-expanded={fxOpen}
          className={`${iconBtn} ${
            fxOpen
              ? 'border-purple-500 text-purple-200 bg-purple-600/25'
              : 'border-purple-700 text-purple-300 hover:bg-purple-600/15'
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </button>
        <span className="text-[10px] font-mono text-zinc-500 truncate min-w-0 flex-1 text-right">
          {status}
        </span>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 relative bg-black">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full touch-none"
          style={{ cursor: 'crosshair' }}
          aria-label="Drawing canvas - draw to make music"
        />

        {fxOpen && (
          <div className="absolute top-0 right-0 h-full w-90 max-w-[60%] bg-zinc-950/95 border-l border-white/10 flex flex-col z-10">
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-white/10 shrink-0">
              <span className="text-[10px] font-black uppercase tracking-widest text-purple-200">
                {studioModule ? studioModule.name : 'FX Chain'}
              </span>
              <div className="flex items-center gap-1">
                {studioModule && (
                  <button
                    type="button"
                    onClick={() => setStudioModule(null)}
                    title="Back to the FX chain"
                    aria-label="Back to FX chain"
                    className="px-1.5 h-6 grid place-items-center rounded border border-white/10 text-zinc-300 hover:bg-white/10"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFxOpen(false)}
                  title="Close the FX panel"
                  aria-label="Close FX panel"
                  className="px-1.5 h-6 grid place-items-center rounded border border-white/10 text-zinc-300 hover:bg-white/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {studioModule ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <span className="px-2 py-1 text-[9px] font-mono text-zinc-500 shrink-0">
                  {recordingFile
                    ? 'Processing your latest DRAW recording. Render inside the module, then save from there.'
                    : 'No DRAW recording yet — record first, or use the module’s own Load Audio.'}
                </span>
                <div className="flex-1 min-h-0">
                  <EffectGuiStage module={studioModule} sourceFile={recordingFile} />
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-3">
                {/* live palette: ALL + every MIX insert, each its own color */}
                <div>
                  <div className="text-[9px] font-black uppercase tracking-widest text-zinc-500 mb-1">
                    Add live effect
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={addAllEffects}
                      title="Add every live effect to the chain"
                      className="px-2 h-6 grid place-items-center text-[9px] font-black uppercase tracking-wide rounded border border-white/30 text-white hover:bg-white/10"
                    >
                      All
                    </button>
                    {RACK_EFFECTS.map((d) => {
                      const hue = EFFECT_HUE[d.id];
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => addEffect(d.id)}
                          title={d.description}
                          className="px-2 h-6 grid place-items-center text-[9px] font-bold rounded border transition-colors hover:bg-white/5"
                          style={{ borderColor: `hsl(${hue} 70% 45%)`, color: `hsl(${hue} 85% 70%)` }}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* the chain itself */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">
                      Chain ({chain.length})
                    </span>
                    {chain.length > 0 && (
                      <button
                        type="button"
                        onClick={clearChain}
                        className="text-[9px] font-mono text-zinc-500 hover:text-red-400"
                        title="Remove all effects from the chain"
                      >
                        clear
                      </button>
                    )}
                  </div>
                  {chain.length === 0 ? (
                    <span className="text-[9px] font-mono text-zinc-600">
                      No effects yet. Click one above to add it; all drawn audio runs through the chain in order.
                    </span>
                  ) : (
                    <FxRack
                      chain={chain}
                      idPrefix="draw-fx"
                      hideAdd
                      onAdd={addEffect}
                      onRemove={removeEffect}
                      onReorder={reorder}
                      onToggle={toggleEnabled}
                      onUpdateParams={onChainParams}
                    />
                  )}
                </div>

                {/* studio modules (offline, open their GUI on a recording) */}
                <div>
                  <div className="text-[9px] font-black uppercase tracking-widest text-zinc-500 mb-1">
                    Studio module (offline)
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {STUDIO_MODULES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setStudioModule(m)}
                        title={`${m.desc} - opens the module GUI to process your DRAW recording`}
                        className="px-2 h-6 grid place-items-center text-[9px] font-bold rounded border transition-colors hover:bg-white/5"
                        style={{ borderColor: m.color, color: m.color }}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                  <span className="block mt-1 text-[8px] font-mono text-zinc-600">
                    Studio modules process a recording offline; they are not part of the live realtime chain.
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
