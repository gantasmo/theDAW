import React, { useEffect, useRef, useState } from 'react';
import { rgb, rgba, type RGB } from '../../lib/trackColor';
import * as djEngine from '../../state/djEngine';
import { useDjVinyl } from '../../state/djVinylStore';

/* ── JogWheel ──────────────────────────────────────────────────────────
   A DJ deck platter: a spinning disc with a position-progress ring and a
   center hub. Rotation + ring are driven IMPERATIVELY from the djEngine
   subscription (no per-frame React re-render). Vinyl-style drag scrubs the
   track (rotational delta → seek, rAF-throttled + pointer-captured).

   `fill` mode sizes the platter to fill its container (ResizeObserver →
   min(width,height)), so the deck can hand it a flex box and the circle
   grows to fill the space instead of sitting small in a sea of dead space. */

const SEC_PER_REV = 1.8;      // 33⅓-rpm feel
const SCRUB_TURNS = 4;        // seconds of travel per full drag-turn
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const fmtPct = (pct: number): string => `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
const fmtTime = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

export function JogWheel({ deckId, color, bpm = null, pitchPct = 0, size = 132, disabled, fill, fillScale = 1 }: {
  deckId: djEngine.DeckId;
  color: RGB;
  bpm?: number | null;
  pitchPct?: number;
  size?: number;
  disabled?: boolean;
  /** Auto-size the platter to fill its container (min of its width/height). */
  fill?: boolean;
  /** Multiplier for fill mode; use < 1 when neighboring controls need air. */
  fillScale?: number;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const platterRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const remainRef = useRef<HTMLSpanElement>(null);
  const [dim, setDim] = useState(size);

  // Scratch character (shared by both decks), pushed live to the engine.
  const scratchMode = useDjVinyl((s) => s.mode);
  const toggleScratch = useDjVinyl((s) => s.toggle);
  useEffect(() => { djEngine.setScratchMode(scratchMode); }, [scratchMode]);

  // In fill mode, track the container's smaller side as the platter diameter.
  useEffect(() => {
    if (!fill) { setDim(size); return; }
    const el = measureRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setDim(Math.max(44, Math.floor(Math.min(r.width, r.height) * fillScale)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill, fillScale, size]);

  const D = dim;
  const R = D / 2;
  const stroke = Math.max(3, Math.round(D * 0.025));
  const r = R - stroke / 2 - 1;
  const circ = 2 * Math.PI * r;

  useEffect(() => {
    const syncReadout = (st: djEngine.DeckStatus) => {
      const p = st.duration > 0 ? clamp01(st.currentTime / st.duration) : 0;
      if (platterRef.current) platterRef.current.style.transform = `rotate(${(st.currentTime / SEC_PER_REV) * 360}deg)`;
      if (ringRef.current) ringRef.current.style.strokeDashoffset = String(circ * (1 - p));
      if (progressRef.current) progressRef.current.textContent = `${Math.round(p * 100)}%`;
      if (elapsedRef.current) elapsedRef.current.textContent = fmtTime(st.currentTime);
      if (remainRef.current) remainRef.current.textContent = fmtTime(Math.max(0, st.duration - st.currentTime));
    };
    syncReadout(djEngine.getStatus(deckId));
    return djEngine.subscribe((sa, sb) => syncReadout(deckId === 'A' ? sa : sb));
  }, [deckId, circ]);

  const angleOf = (e: React.PointerEvent) => {
    const el = rootRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.atan2(e.clientY - (rect.top + rect.height / 2), e.clientX - (rect.left + rect.width / 2));
  };

  // ── Vinyl / scratch: grab hands playback to the scratch worklet; hand
  //    motion sets velocity (forward + reverse), a still hold winds down to a
  //    stop, release spins back up. Only when the deck can scratch (full-track
  //    buffer); stem mode / empty falls back to the silent seek-scrub below. ──
  const vinylOn = useRef(false);
  const lastA = useRef(0);
  const lastT = useRef(0);
  const stall = useRef(0);
  const VEL_K = SEC_PER_REV / (2 * Math.PI); // angular speed → playback velocity
  const clampV = (v: number) => Math.max(-16, Math.min(16, v));
  const armStall = () => {
    window.clearTimeout(stall.current);
    stall.current = window.setTimeout(() => djEngine.setVinylVelocity(deckId, 0, 0.06), 70);
  };

  // ── Fallback silent seek-scrub (stem mode / no decoded buffer) ──────────
  const scrubbing = useRef(false);
  const startAngle = useRef(0);
  const startTime = useRef(0);
  const pendingT = useRef<number | null>(null);
  const raf = useRef(0);
  const apply = () => { raf.current = 0; const t = pendingT.current; pendingT.current = null; if (t != null) djEngine.seekDeck(deckId, t); };

  const onDown = (e: React.PointerEvent) => {
    if (disabled || djEngine.getStatus(deckId).duration <= 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    lastA.current = angleOf(e); lastT.current = e.timeStamp;
    if (djEngine.canScratch(deckId)) {
      vinylOn.current = true;
      void djEngine.enterVinyl(deckId);
      armStall();
    } else {
      scrubbing.current = true;
      startAngle.current = angleOf(e);
      startTime.current = djEngine.getStatus(deckId).currentTime;
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (vinylOn.current) {
      const a = angleOf(e);
      let dA = a - lastA.current;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      while (dA < -Math.PI) dA += 2 * Math.PI;
      const dt = Math.max(4, e.timeStamp - lastT.current) / 1000; // seconds (min 4ms)
      lastA.current = a; lastT.current = e.timeStamp;
      djEngine.setVinylVelocity(deckId, clampV((dA / dt) * VEL_K), 0.5);
      armStall(); // keep resetting the wind-down timer while the hand moves
      return;
    }
    if (!scrubbing.current) return;
    let d = angleOf(e) - startAngle.current;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    pendingT.current = Math.max(0, startTime.current + (d / (2 * Math.PI)) * SEC_PER_REV * SCRUB_TURNS);
    if (!raf.current) raf.current = requestAnimationFrame(apply);
  };
  const onUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (vinylOn.current) {
      vinylOn.current = false;
      window.clearTimeout(stall.current);
      djEngine.exitVinyl(deckId, true);
      return;
    }
    scrubbing.current = false;
  };
  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    window.clearTimeout(stall.current);
  }, []);

  const effectiveBpm = bpm != null && bpm > 0 ? bpm * (1 + pitchPct / 100) : null;
  const accent = rgb(color);
  const dimmedAccent = rgba(color, 0.68);
  const muted = 'rgba(255,255,255,0.46)';
  const bpmSize = Math.max(18, D * 0.165);
  const metaSize = Math.max(8, D * 0.062);
  const timeSize = Math.max(10, D * 0.075);

  const wheel = (
    <div
      ref={rootRef}
      className={`relative select-none ${disabled ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
      style={{ width: D, height: D, touchAction: 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      title={disabled ? 'Load a track' : 'Drag to scrub'}
    >
      <svg className="absolute inset-0 -rotate-90" width={D} height={D}>
        <circle cx={R} cy={R} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <circle ref={ringRef} cx={R} cy={R} r={r} fill="none" stroke={rgb(color)} strokeWidth={stroke}
          strokeDasharray={circ} strokeDashoffset={circ} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${rgba(color, 0.7)})` }} />
      </svg>
      <div
        ref={platterRef}
        className="absolute rounded-full"
        style={{ inset: stroke + 3, background: 'radial-gradient(circle at 50% 38%, #1c1828, #0a080f 72%)', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full"
          style={{ width: Math.max(3, D * 0.03), height: '36%', background: rgb(color), boxShadow: `0 0 6px ${rgba(color, 0.85)}` }} />
      </div>
      <div className="absolute inset-0 grid place-items-center pointer-events-none">
        <div
          className="grid place-items-center text-center font-mono tabular-nums"
          style={{
            width: D * 0.7,
            minHeight: D * 0.47,
            paddingTop: D * 0.04,
            color: muted,
            textShadow: '0 1px 2px rgba(0,0,0,0.95)',
          }}
        >
          <div
            className="font-black leading-none"
            style={{ color: accent, fontSize: bpmSize, textShadow: `0 0 12px ${rgba(color, 0.35)}` }}
            title="Effective BPM"
          >
            {effectiveBpm != null ? effectiveBpm.toFixed(2) : '--.--'}
          </div>
          <div className="flex items-center justify-center gap-[0.45em] font-bold leading-none" style={{ fontSize: metaSize }}>
            <span title="Pitch adjustment">{fmtPct(pitchPct)}</span>
            <span className="rounded-full" style={{ width: D * 0.07, height: D * 0.07, background: accent, boxShadow: `0 0 8px ${dimmedAccent}` }} />
            <span ref={progressRef} title="Track progress">0%</span>
          </div>
          <div className="mt-[0.25em] grid gap-[0.08em] font-black leading-none" style={{ color: 'rgba(255,255,255,0.54)', fontSize: timeSize }}>
            <span ref={elapsedRef} title="Elapsed">0:00.0</span>
            <span ref={remainRef} title="Remaining">0:00.0</span>
          </div>
        </div>
      </div>
      {/* Scratch character toggle — classic vinyl vs cyber glitch (global). */}
      {!disabled && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); toggleScratch(); }}
          title={scratchMode === 'cyber'
            ? 'Scratch sound: CYBER glitch — click for classic vinyl'
            : 'Scratch sound: CLASSIC vinyl — click for cyber glitch'}
          className={`absolute left-1/2 -translate-x-1/2 rounded-full border px-1.5 py-0.5 text-[7px] font-black uppercase tracking-wider transition-colors ${
            scratchMode === 'cyber'
              ? 'border-fuchsia-400/60 bg-fuchsia-500/20 text-fuchsia-200'
              : 'border-white/15 bg-black/60 text-zinc-300 hover:border-white/30'
          }`}
          style={{ bottom: Math.round(D * 0.08) }}
        >
          {scratchMode === 'cyber' ? 'Cyber' : 'Vinyl'}
        </button>
      )}
    </div>
  );

  if (!fill) return wheel;
  return (
    <div ref={measureRef} className="relative w-full h-full grid place-items-center min-h-0">
      {wheel}
    </div>
  );
}
