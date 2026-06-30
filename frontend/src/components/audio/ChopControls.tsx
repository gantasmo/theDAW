/**
 * ChopControls — custom UI for the MPC-style Chop rack effect, rendered by FxRack
 * in place of the generic sliders. Gives the program a real dropdown, a LATCH
 * toggle for continuous chopping, and a momentary HOLD-TO-CHOP trigger that gates
 * the effect only while pressed. Rate / Slice / Mix stay as SLIDE sliders.
 *
 * All values round-trip through the same ChainEntry.params the audio factory reads,
 * so the controls drive both the live preview and the offline bounce.
 */

import { SlideTrack } from './SlideTrack';

const PROGRAMS = ['Stutter', 'Beat-Repeat', 'Shuffle'] as const;

interface ChopControlsProps {
  params: Record<string, number>;
  onChange: (params: Record<string, number>) => void;
  idPrefix: string;
}

export function ChopControls({ params, onChange, idPrefix }: ChopControlsProps) {
  const program = Math.round(params.program ?? 0);
  const rate = params.rate ?? 8;
  const slice = params.slice ?? 0.5;
  const mix = params.mix ?? 1;
  const latched = (params.latch ?? 1) >= 0.5;
  const gating = (params.gate ?? 0) >= 0.5;

  const set = (key: string, value: number) => onChange({ ...params, [key]: value });
  const programId = `${idPrefix}-chop-program`;
  const rateId = `${idPrefix}-chop-rate`;
  const sliceId = `${idPrefix}-chop-slice`;
  const mixId = `${idPrefix}-chop-mix`;

  const hold = (on: boolean) => onChange({ ...params, gate: on ? 1 : 0 });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={programId} className="text-[9px] font-mono text-zinc-500 w-16 shrink-0">Program</label>
        <select
          id={programId}
          name={programId}
          value={program}
          onChange={(e) => set('program', Number(e.target.value))}
          className="flex-1 form-select px-2 py-1 text-[11px] font-mono"
          style={{ colorScheme: 'dark' }}
        >
          {PROGRAMS.map((label, i) => (
            <option key={label} value={i}>{label}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono text-zinc-500 w-16 shrink-0">Engage</span>
        <button
          onClick={() => set('latch', latched ? 0 : 1)}
          aria-pressed={latched}
          title={latched ? 'Latched: chops continuously' : 'Off: dry until you hold to chop'}
          className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${latched ? 'border-purple-500/50 bg-purple-500/15 text-purple-100' : 'border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-100'}`}
        >
          LATCH
        </button>
        <button
          onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); hold(true); e.preventDefault(); }}
          onPointerUp={() => hold(false)}
          onPointerCancel={() => hold(false)}
          aria-pressed={gating}
          aria-label="Hold to chop"
          title="Hold to chop: engages the effect only while pressed"
          className={`flex-1 text-[10px] font-mono px-2 py-1 rounded border transition-colors select-none touch-none ${gating ? 'border-purple-400 bg-purple-500/30 text-white' : 'border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-100'}`}
        >
          HOLD TO CHOP
        </button>
      </div>

      <SliderRow labelId={rateId} label="Rate" value={rate} min={0.5} max={32} step={0.5} dflt={8} unit="Hz"
        onChange={(v) => set('rate', v)} />
      <SliderRow labelId={sliceId} label="Slice" value={slice} min={0.05} max={1} step={0.01} dflt={0.5}
        onChange={(v) => set('slice', v)} />
      <SliderRow labelId={mixId} label="Mix" value={mix} min={0} max={1} step={0.01} dflt={1}
        onChange={(v) => set('mix', v)} />
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
