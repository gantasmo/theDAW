/**
 * SlideKnob — a compact, lag-free SLIDE-style rotary knob for the MAKE
 * "temperature" controls. Reuses the SLIDE control-surface look (the
 * `.tk-*` glass dial + 270° conic arc + glowing pointer from
 * track-controls.css), but is fully props-driven (value / onChange /
 * min / max) instead of being bound to slideStore.
 *
 * Lag-free: the arc background + pointer rotation are set inline from the
 * live value every render with NO CSS transition, so the dial tracks the
 * pointer 1:1 (none of the .ts-fill/.ts-mark easing that made the SLIDE
 * faders feel draggy). Vertical drag changes the value; Shift = fine.
 *
 * Bulging number: the value readout scales up + glows while the knob is
 * hovered or dragged — the MAKE analogue of the SLIDE fader's magnified
 * ruler digit.
 */
import React, { memo, useRef, useState } from 'react';
import { accentVars, colorAt, rgb, rgba } from '../../lib/trackColor';
import { HoverTip } from '../ui/Tooltip';
import { HOVER_TOOLTIPS } from '../ui/tooltips';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const PX_FULL = 170; // px of vertical drag to sweep the whole range

interface SlideKnobProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  tipKey?: string;
  size?: number;
  /** Render the value in the CENTER of the dial, colored by the dial value. */
  centerReadout?: boolean;
  /** Bipolar: fill the arc OUTWARD from the 12-o'clock midpoint (neutral at
   *  center), for ±params like EQ / filter / pitch. */
  center?: boolean;
  /** Fixed accent colour position 0..1 (a style/skin override). When set, the
   *  dial colour no longer tracks the value — used by custom controls. */
  tint?: number;
  /** Value a double-click resets to. Defaults to the bipolar midpoint for
   *  `center` dials, else 0 (clamped into range). */
  defaultValue?: number;
  onLabelClick?: () => void;
  onLabelDoubleClick?: () => void;
  labelTitle?: string;
}

const SlideKnobImpl: React.FC<SlideKnobProps> = ({
  label, value, onChange, min, max, step = 0.01, tipKey, size = 42, centerReadout = false, center = false, tint,
  defaultValue, onLabelClick, onLabelDoubleClick, labelTitle,
}) => {
  const dragging = useRef(false);
  const lastY = useRef(0);
  const [active, setActive] = useState(false);

  const span = max - min || 1;
  const t = clamp((value - min) / span, 0, 1);
  // Geometry follows the value (`t`); colour follows `tint` when given.
  const colorT = tint ?? t;
  const base = colorAt(colorT);
  const sweep = t * 270;
  // gap centered at the BOTTOM: sweep clockwise from 7:30 (225°). In `center`
  // (bipolar) mode the fill grows out from the 12-o'clock midpoint (135° into
  // the sweep) so the dial reads neutral at the center value.
  const MIDPOINT = 135;
  const fStart = Math.min(sweep, MIDPOINT);
  const fEnd = Math.max(sweep, MIDPOINT);
  const arcBg = center
    ? `conic-gradient(from 225deg, rgba(255,255,255,0.09) 0deg ${fStart}deg, ${rgb(base)} ${fStart}deg ${fEnd}deg, ` +
      `rgba(255,255,255,0.09) ${fEnd}deg 270deg, rgba(255,255,255,0) 270deg 360deg)`
    : `conic-gradient(from 225deg, ${rgb(base)} 0deg ${sweep}deg, ` +
      `rgba(255,255,255,0.09) ${sweep}deg 270deg, rgba(255,255,255,0) 270deg 360deg)`;

  const snap = (v: number) => clamp(+(Math.round(v / step) * step).toFixed(6), min, max);
  // Decimals follow the step: integer steps → 0, 0.1 → 1 dp, finer → 2 dp.
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const fmt = (v: number) =>
    !Number.isFinite(v) ? '0'
      : Number.isInteger(v) ? String(v)
        : v.toFixed(decimals);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true; setActive(true); lastY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dy = lastY.current - e.clientY;
    lastY.current = e.clientY;
    onChange(snap(value + (dy / PX_FULL) * span * (e.shiftKey ? 0.25 : 1)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false; setActive(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    onChange(snap(value + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
  };
  // Double-click resets to the control's default (bipolar dials → center).
  const resetValue = defaultValue ?? (center ? (min + max) / 2 : clamp(0, min, max));
  const onDoubleClick = () => onChange(snap(resetValue));
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = step * (e.shiftKey ? 10 : 1);
    let h = true;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': onChange(snap(value + s)); break;
      case 'ArrowDown': case 'ArrowLeft': onChange(snap(value - s)); break;
      case 'Home': onChange(max); break;
      case 'End': onChange(min); break;
      default: h = false;
    }
    if (h) e.preventDefault();
  };

  const labelEl = (
    <span
      className={`text-[8px] font-bold uppercase tracking-wider text-zinc-400 truncate max-w-full text-center leading-none ${onLabelClick || onLabelDoubleClick ? 'cursor-pointer hover:text-zinc-200' : ''}`}
      title={labelTitle}
      onClick={(e) => {
        if (!onLabelClick) return;
        e.preventDefault();
        e.stopPropagation();
        onLabelClick();
      }}
      onDoubleClick={(e) => {
        if (!onLabelDoubleClick) return;
        e.preventDefault();
        e.stopPropagation();
        onLabelDoubleClick();
      }}
    >
      {label}
    </span>
  );
  const tip = tipKey ? HOVER_TOOLTIPS[tipKey] : undefined;

  return (
    <div className="flex flex-col items-center gap-1 select-none min-w-0" style={accentVars(colorT)}>
      {tip ? <HoverTip text={tip}>{labelEl}</HoverTip> : labelEl}
      <div
        className={`tk-dial${active ? ' is-active' : ''}`}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        style={{ width: size, height: size, touchAction: 'none', cursor: 'ns-resize' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onMouseEnter={() => setActive(true)}
        onMouseLeave={() => { if (!dragging.current) setActive(false); }}
      >
        <div className="tk-arc" style={{ background: arcBg }} />
        <div className="tk-face" />
        <div className="tk-point" style={{ transform: `rotate(${225 + sweep}deg)` }}><span /></div>
        {centerReadout && (
          <span
            className="absolute inset-0 grid place-items-center font-mono tabular-nums pointer-events-none leading-none"
            style={{
              color: rgb(base),
              fontSize: active ? '13px' : '11px',
              fontWeight: 800,
              textShadow: `0 0 8px ${rgba(base, 0.85)}`,
              zIndex: 8, // above the rotating pointer (.tk-point z-5) so the readout is never occluded
              transition: 'font-size 0.1s ease',
            }}
          >
            {fmt(value)}
          </span>
        )}
      </div>
      {!centerReadout && (
        <span
          className="font-mono tabular-nums leading-none"
          style={{
            fontSize: active ? '12px' : '9px',
            fontWeight: active ? 800 : 700,
            color: 'var(--accent)',
            textShadow: active ? '0 0 10px var(--accent-glow)' : 'none',
            transition: 'font-size 0.1s ease, text-shadow 0.1s ease',
          }}
        >
          {fmt(value)}
        </span>
      )}
    </div>
  );
};

export const SlideKnob = memo(SlideKnobImpl);
