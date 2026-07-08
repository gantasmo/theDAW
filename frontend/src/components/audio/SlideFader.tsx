/**
 * SlideFader — a compact, lag-free vertical SLIDE-style fader for the MAKE
 * SAMPLER / SCHEDULE-SHIFT columns. Reuses the SLIDE glass-capsule look
 * (`.ts-*` from track-controls.css: capsule + colored fill + glowing knob +
 * magnifying number ruler) but is props-driven (value / onChange / min / max)
 * and sized compactly so several fit side-by-side in a MAKE column.
 *
 * Lag-free: while dragging, the fill's height transition is disabled so the
 * cap tracks the pointer 1:1 (none of the SLIDE fader's 0.12s easing).
 *
 * Bulging numbers: the ruler digits magnify + glow as the handle passes them,
 * exactly like the SLIDE tab — plus the value readout bulges while active.
 */
import React, { memo, useRef, useState } from 'react';
import { accentVars, colorAt, rgb, rgba, smoothstep, type RGB } from '../../lib/trackColor';
import { HoverTip } from '../ui/Tooltip';
import { HOVER_TOOLTIPS } from '../ui/tooltips';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const FOCUS = 0.26; // ruler magnifier reach, in normalized units

const fmtNum = (v: number): string => {
  if (!Number.isFinite(v)) return '0';
  const a = Math.abs(v);
  if (a >= 1000) return `${Math.round(v / 1000)}k`;
  if (Number.isInteger(v)) return String(v);
  if (a < 1) return v.toFixed(2).replace(/^(-?)0\./, '$1.');
  return v.toFixed(1);
};

interface SlideFaderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  tipKey?: string;
  /** Which side the number ruler sits on. Default 'left'; use 'right' for
   *  faders on the right of a layout so the ticks/numbers point outward. */
  rulerSide?: 'left' | 'right';
  /** Fixed accent colour position 0..1 (style/skin override); when set the
   *  colour no longer tracks the value. Used by custom controls. */
  tint?: number;
  /** Value a double-click resets to. Defaults to 0 (clamped into range). */
  defaultValue?: number;
  /** Slimmer presentation for dense mixer strips. */
  compact?: boolean;
}

const SlideFaderImpl: React.FC<SlideFaderProps> = ({ label, value, onChange, min, max, step = 0.01, tipKey, rulerSide = 'left', tint, defaultValue, compact = false }) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const [drag, setDrag] = useState(false);
  const [active, setActive] = useState(false);

  const span = max - min || 1;
  const t = clamp((value - min) / span, 0, 1);
  const colorT = tint ?? t;
  const base = colorAt(colorT);

  const fromClientY = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const yl = clamp(clientY - r.top, 0, r.height);
    const nt = clamp(1 - yl / r.height, 0, 1);
    return clamp(min + Math.round((nt * span) / step) * step, min, max);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true; setDrag(true); setActive(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onChange(fromClientY(e.clientY));
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) onChange(fromClientY(e.clientY));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false; setDrag(false); setActive(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    onChange(clamp(+(value + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 10 : 1)).toFixed(6), min, max));
  };
  // Double-click resets to the control's default (0 unless overridden).
  const onDoubleClick = () => onChange(clamp(defaultValue ?? 0, min, max));
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = step * (e.shiftKey ? 10 : 1);
    let h = true;
    switch (e.key) {
      case 'ArrowUp': onChange(clamp(+(value + s).toFixed(6), min, max)); break;
      case 'ArrowDown': onChange(clamp(+(value - s).toFixed(6), min, max)); break;
      case 'Home': onChange(max); break;
      case 'End': onChange(min); break;
      default: h = false;
    }
    if (h) e.preventDefault();
  };

  // ruler: 5 ticks across the range, numbers on the ends + middle, all
  // magnifying as the handle nears them (the SLIDE "bulge").
  const marks: React.ReactNode[] = [];
  const markDir = rulerSide === 'right' ? 1 : -1; // magnify outward (away from the track)
  const TICKS = compact ? 8 : 20;       // dense ruler; lighter in compact mixers
  for (let i = 0; i <= TICKS; i++) {
    const tt = i / TICKS;
    const p = smoothstep(1 - Math.abs(tt - t) / FOCUS);
    const isMajor = !compact && i % 4 === 0; // compact mixer strips use ticks only
    const txt: RGB = [lerp(150, 255, p), lerp(150, 255, p), lerp(155, 255, p)];
    const tickCol: RGB = [lerp(150, base[0], p), lerp(150, base[1], p), lerp(155, base[2], p)];
    marks.push(
      <div key={i} className="ts-mark" style={{
        top: `${(1 - tt) * 100}%`,
        transform: `translate(${markDir * p * 5}px, -50%) scale(${1 + p * 0.55})`,
        opacity: lerp(0.22, 1, p),
        color: rgb(txt),
        zIndex: 1 + Math.round(p * 10),
        ['--mark-glow' as string]: p > 0.02 ? `0 0 ${5 + p * 10}px ${rgba(base, 0.85 * p)}` : 'none',
      }}>
        {isMajor && <span className="ts-num">{fmtNum(min + tt * span)}</span>}
        <span className="ts-tick" style={{ width: isMajor ? 9 : 6, background: rgb(tickCol) }} />
      </div>,
    );
  }

  const labelEl = (
    <span className="text-[8px] font-bold uppercase tracking-wider text-zinc-400 truncate max-w-full text-center leading-none">{label}</span>
  );
  const tip = tipKey ? HOVER_TOOLTIPS[tipKey] : undefined;

  return (
    <div
      className={`flex flex-col items-center min-w-0 h-full select-none ${compact ? 'gap-0.5' : 'gap-1'}`}
      style={{
        ...accentVars(colorT),
        ['--body-w' as string]: compact ? '15px' : '26px',
        ['--track-w' as string]: compact ? '7px' : '14px',
        ['--track-inset' as string]: compact ? '4px' : '8px',
        ['--knob-cap' as string]: compact ? '10px' : '18px',
        ['--scale-w' as string]: compact ? '7px' : '16px',
        ['--scale-gap' as string]: compact ? '0px' : '2px',
      }}
    >
      {tip ? <HoverTip text={tip}>{labelEl}</HoverTip> : labelEl}
      <div className="ts-stage flex-1 min-h-0" style={{ width: 'var(--body-w)' }}>
        <div className={`ts-scale${rulerSide === 'right' ? ' ts-scale--right' : ''}`}>{marks}</div>
        <div
          className="ts-body"
          style={{ height: '100%' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          onWheel={onWheel}
          onMouseEnter={() => setActive(true)}
          onMouseLeave={() => { if (!dragging.current) setActive(false); }}
        >
          <div className="ts-track" ref={trackRef}>
            <div className="ts-fill" style={{ height: `${Math.max(t * 100, 3)}%`, transition: drag ? 'none' : undefined }} />
            <div
              className="ts-knob"
              role="slider"
              aria-label={label}
              aria-orientation="vertical"
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuenow={value}
              tabIndex={0}
              onKeyDown={onKeyDown}
              style={{ top: `${(1 - t) * 100}%` }}
            />
          </div>
        </div>
      </div>
      {!compact && (
        <span
          className="font-mono tabular-nums leading-none"
          style={{
            fontSize: active ? '11px' : '8.5px',
            fontWeight: active ? 800 : 700,
            color: 'var(--accent)',
            textShadow: active ? '0 0 10px var(--accent-glow)' : 'none',
            transition: 'font-size 0.1s ease, text-shadow 0.1s ease',
          }}
        >
          {fmtNum(value)}
        </span>
      )}
    </div>
  );
};

export const SlideFader = memo(SlideFaderImpl);
