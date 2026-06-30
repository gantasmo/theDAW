/**
 * GaterControls — custom UI for the Gater rack effect, rendered by FxRack in place
 * of the generic sliders. Adds a tempo-sync toggle: free-run uses the Rate (Hz)
 * knob, while sync derives the rate from a musical division plus BPM. Shape is a
 * proper dropdown (sine / square / saw).
 *
 * Values round-trip through the same ChainEntry.params the audio factory reads, so
 * the controls drive both the live preview and the offline bounce.
 */

import { SlideTrack } from './SlideTrack';
import { GATER_DIVISIONS } from '../../lib/rackEffects';

const SHAPES = ['Sine', 'Square', 'Saw'] as const;

interface GaterControlsProps {
  params: Record<string, number>;
  onChange: (params: Record<string, number>) => void;
  idPrefix: string;
  /** Current project tempo, offered for the "match project" button when synced. */
  projectBpm?: number;
}

export function GaterControls({ params, onChange, idPrefix, projectBpm }: GaterControlsProps) {
  const synced = (params.sync ?? 0) >= 0.5;
  const shape = Math.round(params.shape ?? 1);
  const depth = params.depth ?? 0.8;
  const rate = params.rate ?? 6;
  const div = Math.round(params.div ?? 3);
  const bpm = Math.round(params.bpm ?? 120);

  const set = (key: string, value: number) => onChange({ ...params, [key]: value });
  const shapeId = `${idPrefix}-gater-shape`;
  const divId = `${idPrefix}-gater-div`;
  const depthId = `${idPrefix}-gater-depth`;
  const rateId = `${idPrefix}-gater-rate`;
  const bpmId = `${idPrefix}-gater-bpm`;

  // Enabling sync seeds the BPM from the project tempo so it lines up immediately.
  const toggleSync = () => {
    if (synced) set('sync', 0);
    else onChange({ ...params, sync: 1, bpm: projectBpm ?? bpm });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono text-zinc-500 w-16 shrink-0">Clock</span>
        <button
          onClick={toggleSync}
          aria-pressed={synced}
          title={synced ? 'Tempo-synced: rate follows the division and BPM' : 'Free-run: rate set in Hz'}
          className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${synced ? 'border-purple-500/50 bg-purple-500/15 text-purple-100' : 'border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-100'}`}
        >
          {synced ? 'SYNC' : 'FREE'}
        </button>
      </div>

      {synced ? (
        <>
          <div className="flex items-center gap-2">
            <label htmlFor={divId} className="text-[9px] font-mono text-zinc-500 w-16 shrink-0">Division</label>
            <select
              id={divId}
              name={divId}
              value={div}
              onChange={(e) => set('div', Number(e.target.value))}
              className="flex-1 form-select px-2 py-1 text-[11px] font-mono"
              style={{ colorScheme: 'dark' }}
            >
              {GATER_DIVISIONS.map((label, i) => (
                <option key={label} value={i}>{label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={bpmId} className="text-[9px] font-mono text-zinc-500 w-16 shrink-0">BPM</label>
            <SlideTrack value={bpm} min={40} max={240} step={1} defaultValue={projectBpm ?? 120}
              ariaLabelledBy={bpmId} className="flex-1" onChange={(v) => set('bpm', v)} />
            {projectBpm != null && projectBpm !== bpm && (
              <button
                onClick={() => set('bpm', projectBpm)}
                title={`Match the project tempo (${projectBpm})`}
                className="text-[9px] font-mono px-1.5 py-1 rounded border border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-100 shrink-0"
              >
                ={projectBpm}
              </button>
            )}
            {(projectBpm == null || projectBpm === bpm) && (
              <span className="text-[9px] font-mono text-zinc-400 w-10 shrink-0 text-right tabular-nums">{bpm}</span>
            )}
          </div>
        </>
      ) : (
        <SliderRow labelId={rateId} label="Rate" value={rate} min={0.1} max={30} step={0.1} dflt={6} unit="Hz"
          onChange={(v) => set('rate', v)} />
      )}

      <SliderRow labelId={depthId} label="Depth" value={depth} min={0} max={1} step={0.01} dflt={0.8}
        onChange={(v) => set('depth', v)} />

      <div className="flex items-center gap-2">
        <label htmlFor={shapeId} className="text-[9px] font-mono text-zinc-500 w-16 shrink-0">Shape</label>
        <select
          id={shapeId}
          name={shapeId}
          value={shape}
          onChange={(e) => set('shape', Number(e.target.value))}
          className="flex-1 bg-zinc-900 border border-white/20 rounded px-2 py-1 text-[11px] font-mono text-zinc-100 outline-none focus:border-purple-500/60 cursor-pointer"
          style={{ colorScheme: 'dark' }}
        >
          {SHAPES.map((label, i) => (
            <option key={label} value={i}>{label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function SliderRow({
  labelId, label, value, min, max, step, dflt, unit, onChange,
}: {
  labelId: string; label: string; value: number; min: number; max: number;
  step: number; dflt: number; unit?: string; onChange: (v: number) => void;
}) {
  const decimals = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
  return (
    <div className="flex items-center gap-2">
      <span id={labelId} className="text-[9px] font-mono text-zinc-500 w-16 shrink-0">{label}</span>
      <SlideTrack value={value} min={min} max={max} step={step} defaultValue={dflt}
        ariaLabelledBy={labelId} className="flex-1" onChange={onChange} />
      <span className="text-[9px] font-mono text-zinc-400 w-16 shrink-0 text-right tabular-nums">
        {value.toFixed(decimals)}{unit ? ` ${unit}` : ''}
      </span>
    </div>
  );
}
