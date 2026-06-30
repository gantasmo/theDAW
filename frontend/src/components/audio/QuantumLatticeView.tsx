/**
 * QuantumLatticeView — in-app host for the Quantum Lattice shader engine, used
 * as the "Q" mode of the Visualize tab. Owns a canvas, drives the engine from
 * the shared playback analyser (so the lattice reacts to whatever is playing),
 * and exposes the full parameter surface through a collapsible controls drawer
 * (QuantumControls): shape, palette, master audio drive, and every param with a
 * per-param audio band. Sizing goes through getBoundingClientRect so it stays
 * correct under the app's CSS-zoom scaling.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Donut, Box, Star, Grid3x3, SlidersHorizontal, Activity } from 'lucide-react';
import {
  QuantumLatticeEngine,
  QUANTUM_GEOMETRY_NAMES,
  resolveQuantumParams,
  type QuantumLevels,
  type QuantumAudioBand,
} from '../../lib/quantumLattice';
import { getAnalyser } from '../../state/playerStore';
import { QuantumControls } from './QuantumControls';

const SHAPES: { idx: number; label: string; Icon: typeof Box }[] = [
  { idx: 0, label: 'Torus', Icon: Donut },
  { idx: 1, label: 'Cube', Icon: Box },
  { idx: 2, label: 'Star', Icon: Star },
  { idx: 3, label: 'Cage', Icon: Grid3x3 },
];

/** Read the shared analyser into 4 bands the engine consumes. */
const makeGetLevels = (): (() => QuantumLevels) => {
  const analyser = getAnalyser();
  const buf = new Uint8Array(analyser.frequencyBinCount);
  return () => {
    analyser.getByteFrequencyData(buf);
    let bass = 0, mid = 0, high = 0;
    const bassEnd = Math.min(6, buf.length);
    const midEnd = Math.min(40, buf.length);
    for (let i = 0; i < bassEnd; i++) bass += buf[i];
    for (let i = bassEnd; i < midEnd; i++) mid += buf[i];
    for (let i = midEnd; i < buf.length; i++) high += buf[i];
    const bassN = bass / Math.max(1, bassEnd) / 255;
    const midN = mid / Math.max(1, midEnd - bassEnd) / 255;
    const highN = high / Math.max(1, buf.length - midEnd) / 255;
    return { bass: bassN, mid: midN, high: highN, volume: (bassN + midN + highN) / 3 };
  };
};

export const QuantumLatticeView: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<QuantumLatticeEngine | null>(null);

  const [shape, setShape] = useState(0);
  const [geomName, setGeomName] = useState(QUANTUM_GEOMETRY_NAMES[0]);
  const [beatCycle, setBeatCycle] = useState(true); // hard hits cycle the geometry
  const [panelOpen, setPanelOpen] = useState(false);
  const [paletteIdx, setPaletteIdx] = useState(-1); // -1 = auto
  const [audioDrive, setAudioDrive] = useState(1);
  const [values, setValues] = useState<Record<string, number>>({});
  const [audioBands, setAudioBands] = useState<Record<string, QuantumAudioBand>>({});

  const resolved = useMemo(() => resolveQuantumParams(values, audioBands), [values, audioBands]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const rect = container.getBoundingClientRect();
    const engine = new QuantumLatticeEngine({
      canvas,
      width: rect.width || 320,
      height: rect.height || 240,
      interactive: true,
      getLevels: makeGetLevels(),
      onStats: (s) => setGeomName(s.geomName),
      // beat-cycle advances the geometry internally; mirror it so the shape
      // buttons highlight the live shape.
      onShape: (idx) => setShape(idx),
    });
    engineRef.current = engine;

    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      engine.resize(r.width, r.height);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Push live state into the engine.
  useEffect(() => { engineRef.current?.setParams(resolved); }, [resolved]);
  useEffect(() => { engineRef.current?.setAudioDrive(audioDrive); }, [audioDrive]);
  useEffect(() => { engineRef.current?.setPaletteIndex(paletteIdx < 0 ? null : paletteIdx); }, [paletteIdx]);
  useEffect(() => { engineRef.current?.setShape(shape); }, [shape]);
  useEffect(() => { engineRef.current?.setBeatCycle(beatCycle); }, [beatCycle]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden bg-[#020005]">
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* shape selector — top-right column */}
      <div className="absolute top-2 right-2 flex flex-col gap-1 z-10">
        {SHAPES.map(({ idx, label, Icon }) => (
          <button
            key={idx}
            type="button"
            onClick={() => setShape(idx)}
            title={label}
            aria-label={`Morph to ${label}`}
            aria-pressed={shape === idx}
            className={`w-5 h-5 rounded grid place-items-center transition-colors ${
              shape === idx
                ? 'bg-cyan-500 text-black shadow-[0_0_6px_rgba(0,255,255,0.6)]'
                : 'bg-black/50 text-zinc-500 border border-white/10 hover:text-zinc-200 hover:border-white/25'
            }`}
          >
            <Icon className="w-3 h-3" />
          </button>
        ))}
        <button
          type="button"
          onClick={() => setBeatCycle((v) => !v)}
          title={beatCycle ? 'Hard hits cycle shapes (on)' : 'Hard hits cycle shapes (off)'}
          aria-label="Toggle hard-hit shape cycling"
          aria-pressed={beatCycle}
          className={`w-5 h-5 rounded grid place-items-center transition-colors ${
            beatCycle
              ? 'bg-cyan-500 text-black shadow-[0_0_6px_rgba(0,255,255,0.6)]'
              : 'bg-black/50 text-zinc-500 border border-white/10 hover:text-zinc-200 hover:border-white/25'
          }`}
        >
          <Activity className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          title="Quantum controls"
          aria-label="Toggle Quantum controls"
          aria-pressed={panelOpen}
          className={`w-5 h-5 rounded grid place-items-center transition-colors ${
            panelOpen
              ? 'bg-cyan-500 text-black shadow-[0_0_6px_rgba(0,255,255,0.6)]'
              : 'bg-black/50 text-zinc-500 border border-white/10 hover:text-zinc-200 hover:border-white/25'
          }`}
        >
          <SlidersHorizontal className="w-3 h-3" />
        </button>
      </div>

      {panelOpen && (
        <QuantumControls
          shape={shape}
          onShape={setShape}
          paletteIdx={paletteIdx}
          onPalette={setPaletteIdx}
          audioDrive={audioDrive}
          onDrive={setAudioDrive}
          values={values}
          onValue={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
          audio={audioBands}
          onAudio={(id, b) => setAudioBands((p) => ({ ...p, [id]: b }))}
          onReset={() => { setValues({}); setAudioBands({}); setPaletteIdx(-1); setAudioDrive(1); }}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {/* geometry name lamp, bottom-left */}
      <div className="absolute bottom-1.5 left-2 z-10 text-[8px] font-mono uppercase tracking-[0.25em] text-cyan-300/70 pointer-events-none">
        {geomName}
      </div>
    </div>
  );
};
