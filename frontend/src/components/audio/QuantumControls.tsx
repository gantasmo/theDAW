/**
 * QuantumControls — the full parameter surface for the Quantum Lattice visual
 * (Visualize tab). A compact, grouped drawer: shape buttons, palette, master
 * audio drive, and every QUANTUM_PARAMS slider with a per-param audio-band
 * selector (none/bass/mid/high/volume), mirroring the VJ shader control deck.
 * Values + bands are lifted to QuantumLatticeView, which feeds them to the
 * engine via resolveQuantumParams.
 */
import React from 'react';
import { Donut, Box, Star, Grid3x3, X, RotateCcw } from 'lucide-react';
import {
  QUANTUM_PARAMS,
  QUANTUM_GROUPS,
  QUANTUM_GEOMETRY_NAMES,
  QUANTUM_PALETTES,
  type QuantumAudioBand,
} from '../../lib/quantumLattice';

const SHAPE_ICONS = [Donut, Box, Star, Grid3x3];

interface Props {
  shape: number;
  onShape: (n: number) => void;
  paletteIdx: number; // -1 = auto (follows shape)
  onPalette: (n: number) => void;
  audioDrive: number;
  onDrive: (n: number) => void;
  values: Record<string, number>;
  onValue: (id: string, v: number) => void;
  audio: Record<string, QuantumAudioBand>;
  onAudio: (id: string, b: QuantumAudioBand) => void;
  onReset: () => void;
  onClose: () => void;
}

const BANDS: { v: QuantumAudioBand; t: string }[] = [
  { v: 'none', t: '—' },
  { v: 'bass', t: 'BAS' },
  { v: 'mid', t: 'MID' },
  { v: 'high', t: 'HI' },
  { v: 'volume', t: 'VOL' },
];

export const QuantumControls: React.FC<Props> = ({
  shape, onShape, paletteIdx, onPalette, audioDrive, onDrive, values, onValue, audio, onAudio, onReset, onClose,
}) => {
  return (
    <div className="absolute top-7 right-1 bottom-8 w-48 z-20 flex flex-col rounded-md border border-cyan-500/25 bg-black/85 backdrop-blur-sm text-zinc-200 overflow-hidden">
      {/* header */}
      <div className="shrink-0 flex items-center justify-between px-2 py-1 border-b border-white/10">
        <span className="text-[8px] font-mono uppercase tracking-[0.25em] text-cyan-300/80">Quantum</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onReset} title="Reset all to defaults" aria-label="Reset Quantum parameters"
            className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/10">
            <RotateCcw className="w-3 h-3" />
          </button>
          <button type="button" onClick={onClose} title="Close controls" aria-label="Close Quantum controls"
            className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/10">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-2">
        {/* shape */}
        <div>
          <span className="block text-[7px] font-mono uppercase tracking-widest text-zinc-500 mb-1">Geometry</span>
          <div className="grid grid-cols-4 gap-1">
            {QUANTUM_GEOMETRY_NAMES.map((name, i) => {
              const Icon = SHAPE_ICONS[i];
              const on = shape === i;
              return (
                <button key={i} type="button" onClick={() => onShape(i)} title={name} aria-label={`Morph to ${name}`} aria-pressed={on}
                  className={`h-6 grid place-items-center rounded border transition-colors ${
                    on ? 'border-cyan-400 bg-cyan-500/25 text-cyan-200' : 'border-white/10 bg-white/5 text-zinc-500 hover:text-zinc-200 hover:border-white/25'
                  }`}>
                  <Icon className="w-3 h-3" />
                </button>
              );
            })}
          </div>
        </div>

        {/* palette + master drive */}
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <label htmlFor="q-palette" className="w-16 shrink-0 text-[8px] font-mono uppercase tracking-wide text-zinc-400">Palette</label>
            <select id="q-palette" name="q-palette" value={paletteIdx} onChange={(e) => onPalette(parseInt(e.target.value, 10))}
              className="flex-1 min-w-0 bg-zinc-800 border border-zinc-600 rounded text-[8px] font-mono text-zinc-100 px-1 py-0.5">
              <option value={-1}>Auto</option>
              {QUANTUM_PALETTES.map((p, i) => (
                <option key={p} value={i}>{p}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <label htmlFor="q-drive" className="w-16 shrink-0 text-[8px] font-mono uppercase tracking-wide text-zinc-400" title="Master audio reactivity">Audio Drive</label>
            <input id="q-drive" name="q-drive" type="range" min={0} max={2} step={0.05} value={audioDrive}
              onChange={(e) => onDrive(parseFloat(e.target.value))} className="flex-1 min-w-0 accent-cyan-500" />
            <span className="w-7 shrink-0 text-right text-[8px] font-mono text-zinc-500 tabular-nums">{audioDrive.toFixed(2)}</span>
          </div>
        </div>

        {/* param groups */}
        {QUANTUM_GROUPS.map((group, gi) => (
          <details key={group} open={gi < 2} className="rounded border border-white/8 bg-white/3">
            <summary className="cursor-pointer select-none px-1.5 py-1 text-[7px] font-mono uppercase tracking-widest text-zinc-400 hover:text-zinc-200">
              {group}
            </summary>
            <div className="px-1.5 pb-1.5 space-y-1">
              {QUANTUM_PARAMS.filter((p) => p.group === group).map((p) => {
                const val = values[p.id] ?? p.default;
                const band = audio[p.id] ?? p.audio ?? 'none';
                return (
                  <div key={p.id} className="flex items-center gap-1">
                    <label htmlFor={`q-${p.id}`} className="w-14 shrink-0 text-[8px] font-mono uppercase tracking-wide text-zinc-400 truncate" title={p.label}>
                      {p.label}
                    </label>
                    <input
                      id={`q-${p.id}`}
                      name={`q-${p.id}`}
                      type="range"
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      value={val}
                      onChange={(e) => onValue(p.id, parseFloat(e.target.value))}
                      className="flex-1 min-w-0 accent-cyan-500"
                    />
                    <label htmlFor={`q-${p.id}-aud`} className="sr-only">{p.label} audio band</label>
                    <select
                      id={`q-${p.id}-aud`}
                      name={`q-${p.id}-aud`}
                      value={band}
                      onChange={(e) => onAudio(p.id, e.target.value as QuantumAudioBand)}
                      title={`${p.label}: audio band that drives it`}
                      className="shrink-0 w-10 bg-zinc-800 border border-zinc-600 rounded text-[7px] font-mono text-zinc-100 px-0.5 py-0.5"
                    >
                      {BANDS.map((b) => (
                        <option key={b.v} value={b.v}>{b.t}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
};
