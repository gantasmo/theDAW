/**
 * OwlPad — XY performance surface for the OWL-Pad rack effect. Dragging sets the
 * effect's x/y params live (and engages it); a program selector picks what the
 * two axes do, and HOLD latches the last position instead of gating back to dry
 * when the pointer is released.
 *
 * Rendered by FxRack in place of the generic sliders when the effect is 'owlpad'.
 * Values round-trip through the same ChainEntry.params the audio factory reads,
 * so the pad and the sound stay in sync (and the offline bounce uses them too).
 */

import { useRef } from 'react';
import { SlideTrack } from './SlideTrack';
import { OWLPAD_PROGRAMS } from '../../lib/rackEffects';

interface OwlPadProps {
  params: Record<string, number>;
  onChange: (params: Record<string, number>) => void;
  idPrefix: string;
}

const PAD = 150; // svg viewport (square)
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** What the X and Y axes sweep for each program (for the on-pad captions). */
const axisLabels = (program: number): { x: string; y: string } => {
  switch (Math.round(program)) {
    case 3: return { x: 'Time', y: 'Feedback' };
    case 4: return { x: 'Freq', y: 'Feedback' };
    default: return { x: 'Freq', y: 'Reso' };
  }
};

export function OwlPad({ params, onChange, idPrefix }: OwlPadProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);

  const x = clamp(params.x ?? 0.5, 0, 1);
  const y = clamp(params.y ?? 0.3, 0, 1);
  const program = Math.round(params.program ?? 0);
  const mix = params.mix ?? 1;
  const hold = (params.hold ?? 1) >= 0.5;
  const engaged = (params.active ?? 1) >= 0.5;

  const dotX = x * PAD;
  const dotY = (1 - y) * PAD; // y = 1 is the top of the pad
  const labels = axisLabels(program);

  const set = (key: string, value: number) => onChange({ ...params, [key]: value });

  const fromPointer = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = clamp((clientX - rect.left) / rect.width, 0, 1);
    const ny = clamp((clientY - rect.top) / rect.height, 0, 1);
    onChange({ ...params, x: +nx.toFixed(3), y: +(1 - ny).toFixed(3), active: 1 });
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    fromPointer(e.clientX, e.clientY);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) fromPointer(e.clientX, e.clientY); };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (!hold) onChange({ ...params, active: 0 }); // gate back to dry on release
  };

  const programId = `${idPrefix}-owlpad-program`;
  const mixId = `${idPrefix}-owlpad-mix-label`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        <svg
          ref={svgRef}
          width={PAD}
          height={PAD}
          viewBox={`0 0 ${PAD} ${PAD}`}
          role="application"
          aria-label={`OWL-Pad XY pad. Drag to sweep ${labels.x} on the X axis and ${labels.y} on the Y axis.`}
          className="shrink-0 rounded bg-black/50 border border-white/10 cursor-crosshair touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {/* grid */}
          {[0.25, 0.5, 0.75].map((f) => (
            <g key={f}>
              <line x1={f * PAD} y1={0} x2={f * PAD} y2={PAD} stroke="#ffffff" strokeOpacity={0.05} />
              <line x1={0} y1={f * PAD} x2={PAD} y2={f * PAD} stroke="#ffffff" strokeOpacity={0.05} />
            </g>
          ))}
          {/* crosshair + position dot (dimmed when gated to dry) */}
          <line x1={dotX} y1={0} x2={dotX} y2={PAD} stroke="#a855f7" strokeOpacity={engaged ? 0.4 : 0.12} strokeWidth={1} />
          <line x1={0} y1={dotY} x2={PAD} y2={dotY} stroke="#a855f7" strokeOpacity={engaged ? 0.4 : 0.12} strokeWidth={1} />
          <circle cx={dotX} cy={dotY} r={6} fill={engaged ? '#a855f7' : '#3f3f46'} stroke="#fff" strokeWidth={1} />
          {/* axis captions */}
          <text x={PAD / 2} y={PAD - 3} textAnchor="middle" fontSize={7} fill="#71717a" fontFamily="monospace">{labels.x}</text>
          <text x={3} y={10} fontSize={7} fill="#71717a" fontFamily="monospace">{labels.y}</text>
        </svg>

        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
          <label htmlFor={programId} className="sr-only">OWL-Pad program</label>
          <select
            id={programId}
            name={programId}
            value={program}
            onChange={(e) => set('program', Number(e.target.value))}
            className="form-select px-2 py-1 text-[11px] font-mono"
            style={{ colorScheme: 'dark' }}
          >
            {OWLPAD_PROGRAMS.map((label, i) => (
              <option key={label} value={i}>{label}</option>
            ))}
          </select>
          <button
            onClick={() => set('hold', hold ? 0 : 1)}
            aria-pressed={hold}
            title={hold ? 'Hold on: the pad latches its last position' : 'Hold off: releasing the pad gates back to dry'}
            className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${hold ? 'border-purple-500/50 bg-purple-500/15 text-purple-100' : 'border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-100'}`}
          >
            {hold ? 'HOLD' : 'GATE'}
          </button>
          <div className="flex items-center gap-2">
            <span id={mixId} className="text-[9px] font-mono text-zinc-500 w-8 shrink-0">Mix</span>
            <SlideTrack
              value={mix}
              min={0}
              max={1}
              step={0.01}
              ariaLabelledBy={mixId}
              className="flex-1"
              onChange={(v) => set('mix', v)}
            />
            <span className="text-[9px] font-mono text-zinc-400 w-8 shrink-0 text-right tabular-nums">{mix.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
