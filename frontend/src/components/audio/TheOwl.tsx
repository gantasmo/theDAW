/**
 * TheOwl — the front-end for the spatializer effect (renamed "The Owl"). A
 * drop-in for SpatializerPad (same { params, onChange, idPrefix }, the same
 * ChainEntry.params the audio factory reads), rendered to fit the MIX Effect
 * Stage footprint over the "the OWL" artwork.
 *
 * The two panels mount the ORIGINAL owl canvas surfaces (served from
 * /owl/kaoss.html + /owl/room.html) so the real particle trails, glowing
 * indicator, crosshairs and source rings come straight from the source art.
 * They postMessage their values up; this bridges them onto the spatializer:
 *   - left (Kaoss): valueX/valueY -> azimuth / elevation (springs to front-centre)
 *   - right (spatial room): SRC-01 radius -> distance, z -> depth
 * Plus the native controls:
 *   - 4 SLIDE sliders (bottom): azimuth, elevation, distance, depth
 *   - centre knob: rate (motionRate)
 *   - 12 ring buttons (6 L + 6 R): the 12 motion modes (motion 0..11)
 *
 * Positions are percentages of the 1672x941 art; tweak the constants to nudge a
 * control onto its frame. The art is fit (not stretched) inside the stage.
 */

import { useEffect, useRef } from 'react';
import { SlideTrack } from './SlideTrack';
import { SPATIAL_MOTIONS } from '../../lib/rackEffects';
import { ContextMenu, useContextMenu } from '../ui/ContextMenu';
import { ganApi } from '../../lib/ganClient';
import { logInfo, logError } from '../../state/logStore';

interface TheOwlProps {
  params: Record<string, number>;
  onChange: (params: Record<string, number>) => void;
  idPrefix: string;
}

const BG = '/owl/the-owl.png';
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/* positions as % of the 1672x941 art */
const PAD = {
  left: { left: 24.23, top: 21.62, w: 26.55, h: 46.0 }, // Kaoss -> azimuth / elevation
  right: { left: 52.24, top: 21.31, w: 26.64, h: 46.29 }, // spatial room -> distance / depth
};
const KNOB = { cx: 51.35, cy: 79.85, size: 6.3 }; // rate
const SLIDERS = [
  { key: 'azimuth', label: 'Azimuth', min: -180, max: 180, step: 1, def: 0, unit: 'deg', left: 19.4, top: 73.4, w: 19 },
  { key: 'elevation', label: 'Elevation', min: -90, max: 90, step: 1, def: 0, unit: 'deg', left: 19.4, top: 79.6, w: 19 },
  { key: 'distance', label: 'Distance', min: 0.5, max: 10, step: 0.1, def: 1.5, unit: '', left: 61.0, top: 73.4, w: 19 },
  { key: 'motionDepth', label: 'Depth', min: 0, max: 8, step: 0.1, def: 1.5, unit: '', left: 61.0, top: 79.6, w: 19 },
] as const;
/* 12 ring buttons -> motion modes 0..11 (left column top->bottom 0..5, right 6..11) */
const BTN_W = 2.84;
const BTN_H = 5.17;
const BUTTONS: { left: number; top: number }[] = [
  { left: 18.04, top: 23.35 }, { left: 18.06, top: 30.71 }, { left: 18.06, top: 38.15 },
  { left: 18.06, top: 45.59 }, { left: 18.06, top: 52.82 }, { left: 18.24, top: 59.83 },
  { left: 82.6, top: 24.12 }, { left: 82.6, top: 31.14 }, { left: 82.6, top: 38.04 },
  { left: 82.6, top: 44.74 }, { left: 82.6, top: 51.22 }, { left: 82.66, top: 58.13 },
];

export function TheOwl({ params, onChange, idPrefix }: TheOwlProps) {
  const motion = Math.round(params.motion ?? 0);
  const motionRate = params.motionRate ?? 0.3;

  const set = (key: string, value: number) => onChange({ ...params, [key]: value });

  // Right-click the interface -> package + reveal the sidecar .gan (VST-style).
  const menu = useContextMenu<true>();
  const revealGan = async () => {
    try {
      const r = await ganApi.packageOwl();
      await ganApi.reveal(r.gan_path);
      logInfo('plugin', `The Owl packaged + revealed: ${r.gan_path}`);
    } catch (e) {
      logError('plugin', `Reveal .gan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // The canvas panels postMessage their values; bridge them onto the params.
  // Use refs so the listener always reads the latest params/onChange.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== 'updateValue') return;
      const p = paramsRef.current;
      if (d.id === 'oivsvlg' && typeof d.valueX === 'number') {
        onChangeRef.current({
          ...p,
          azimuth: Math.round((d.valueX - 0.5) * 360),
          elevation: Math.round((0.5 - d.valueY) * 180),
        });
      } else if (d.id === 'owl-room' && typeof d.rad === 'number') {
        onChangeRef.current({
          ...p,
          distance: +clamp(0.5 + d.rad * 9.5, 0.5, 10).toFixed(2),
          motionDepth: +clamp(d.z * 8, 0, 8).toFixed(2),
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div
      className="relative h-full w-full bg-[#07080c] overflow-hidden flex items-center justify-center select-none"
      onContextMenu={(e) => menu.open(e, true)}
    >
      <div
        className="relative aspect-1672/941 w-full h-full max-w-full max-h-full"
        style={{ backgroundImage: `url(${BG})`, backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' }}
      >
        {/* ── left panel: the real Kaoss surface (trails + glowing indicator) ── */}
        <iframe
          src="/owl/kaoss.html"
          title="Azimuth / elevation pad"
          className="absolute border-0 bg-transparent"
          style={{ left: `${PAD.left.left}%`, top: `${PAD.left.top}%`, width: `${PAD.left.w}%`, height: `${PAD.left.h}%` }}
        />
        {/* ── right panel: the real spatial-room surface (crosshairs + rings) ── */}
        <iframe
          src="/owl/room.html"
          title="Distance / depth pad"
          className="absolute border-0 bg-transparent"
          style={{ left: `${PAD.right.left}%`, top: `${PAD.right.top}%`, width: `${PAD.right.w}%`, height: `${PAD.right.h}%` }}
        />

        {/* ── 12 ring buttons -> motion modes ── */}
        {BUTTONS.map((b, i) => {
          const active = motion === i;
          return (
            <button
              key={i}
              type="button"
              onClick={() => set('motion', i)}
              title={SPATIAL_MOTIONS[i] ?? `Mode ${i}`}
              aria-label={`Motion mode: ${SPATIAL_MOTIONS[i] ?? i}`}
              aria-pressed={active}
              className="absolute rounded-full transition-shadow"
              style={{
                left: `${b.left}%`, top: `${b.top}%`, width: `${BTN_W}%`, height: `${BTN_H}%`,
                border: active ? '2px solid rgba(255,255,255,0.7)' : '2px solid transparent',
                boxShadow: active ? '0 0 12px rgba(255,255,255,0.45)' : 'none',
              }}
            />
          );
        })}

        {/* ── centre knob -> rate ── */}
        <Knob
          cx={KNOB.cx} cy={KNOB.cy} size={KNOB.size}
          value={motionRate} min={0} max={4} step={0.01}
          ariaLabel="Rate"
          onChange={(v) => set('motionRate', +v.toFixed(2))}
        />

        {/* ── 4 SLIDE sliders ── */}
        {SLIDERS.map((s) => {
          const value = params[s.key] ?? s.def;
          const labelId = `${idPrefix}-owl-${s.key}`;
          return (
            <div key={s.key} className="absolute flex flex-col gap-0.5"
              style={{ left: `${s.left}%`, top: `${s.top}%`, width: `${s.w}%` }}>
              <div className="flex items-center justify-between">
                <span id={labelId} className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">{s.label}</span>
                <span className="text-[8px] font-mono text-zinc-400 tabular-nums">
                  {value.toFixed(s.step < 1 ? 1 : 0)}{s.unit ? ` ${s.unit}` : ''}
                </span>
              </div>
              <SlideTrack
                value={value} min={s.min} max={s.max} step={s.step}
                defaultValue={s.def} ariaLabelledBy={labelId}
                onChange={(v) => set(s.key, v)}
              />
            </div>
          );
        })}
      </div>
      <ContextMenu
        position={menu.position}
        onClose={menu.close}
        title="The Owl · .gan"
        items={[{ type: 'item', label: 'Reveal .gan in folder', onSelect: () => void revealGan() }]}
      />
    </div>
  );
}

/* ── A minimal rotary that overlays the artwork's knob. ── */
function Knob({
  cx, cy, size, value, min, max, step, ariaLabel, onChange,
}: {
  cx: number; cy: number; size: number;
  value: number; min: number; max: number; step: number;
  ariaLabel: string; onChange: (v: number) => void;
}) {
  const dragging = useRef(false);
  const start = useRef({ y: 0, v: 0 });
  const t = clamp((value - min) / (max - min || 1), 0, 1);
  const angle = -135 + t * 270;

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true; start.current = { y: e.clientY, v: value };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId); e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dv = ((start.current.y - e.clientY) / 150) * (max - min);
    onChange(clamp(+(start.current.v + dv).toFixed(6), min, max));
  };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const s = step * (e.shiftKey ? 10 : 1);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { onChange(clamp(value + s, min, max)); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { onChange(clamp(value - s, min, max)); e.preventDefault(); }
  };

  return (
    <div
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      className="absolute rounded-full cursor-ns-resize touch-none"
      style={{ left: `${cx}%`, top: `${cy}%`, width: `${size}%`, aspectRatio: '1 / 1', transform: 'translate(-50%,-50%)' }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onKeyDown={onKey}
    >
      {/* indicator only — the artwork draws the knob body */}
      <span
        className="absolute left-1/2 top-1/2"
        style={{
          width: 2, height: '38%', background: '#fff', borderRadius: 2,
          boxShadow: '0 0 6px rgba(255,255,255,0.9)',
          transform: `translate(-50%,-100%) rotate(${angle}deg)`, transformOrigin: 'bottom center',
        }}
      />
    </div>
  );
}
