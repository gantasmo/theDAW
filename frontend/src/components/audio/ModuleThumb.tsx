import React, { useEffect, useRef } from 'react';

/* ── ModuleThumb ─────────────────────────────────────────────────────────────
   The "badass thumbnail" for a Studio Module tile. Ports the per-module canvas
   preview renderers verbatim from the Edit Tool Stack's static/modules/index.html
   so each tile previews its instrument's character (EQ bars, transfer curve,
   goniometer rings, grain cloud, RVQ segments, …). Pure Canvas2D, framework-free. */

type Draw = (ctx: CanvasRenderingContext2D, W: number, H: number) => void;

const DRAWERS: Record<string, Draw> = {
  'eq-bars': (ctx, W, H) => {
    const bars = [0.5, 0.7, 0.4, 0.8, 0.6];
    const bw = W / bars.length - 4;
    bars.forEach((v, i) => {
      ctx.fillStyle = `rgba(77,208,225,${0.3 + v * 0.4})`;
      const bh = v * H * 0.8;
      ctx.fillRect(i * (bw + 4) + 2, H - bh, bw, bh);
    });
  },
  dynamics: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(102,187,106,.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(4, H - 4); ctx.lineTo(W * 0.4, H * 0.5); ctx.lineTo(W - 4, H * 0.35); ctx.stroke();
    ctx.setLineDash([2, 2]); ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.beginPath(); ctx.moveTo(4, H - 4); ctx.lineTo(W - 4, 4); ctx.stroke(); ctx.setLineDash([]);
  },
  transient: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(129,199,132,.5)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) { const t = x / W; const spike = t > 0.15 && t < 0.25 ? Math.exp(-(t - 0.2) * 80) * 20 : 0; const body = Math.sin(t * 40) * 4 * Math.exp(-t * 3); ctx.lineTo(x, H / 2 - spike - body); }
    ctx.stroke();
  },
  maximizer: (ctx, W, H) => {
    ctx.fillStyle = 'rgba(255,171,64,.15)'; ctx.fillRect(0, 4, W, H - 8);
    ctx.strokeStyle = 'rgba(255,171,64,.5)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) { const v = (Math.sin(x * 0.15) + Math.sin(x * 0.23) * 0.5) * 0.35; ctx.lineTo(x, H / 2 - v * H); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(239,83,80,.4)'; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(W, 6); ctx.stroke(); ctx.setLineDash([]);
  },
  imager: (ctx, W, H) => {
    const cx = W / 2, cy = H / 2;
    for (let i = 3; i > 0; i--) { ctx.beginPath(); ctx.ellipse(cx, cy, i * W * 0.12, i * H * 0.3, 0, 0, Math.PI * 2); ctx.strokeStyle = `rgba(171,71,188,${0.15 + i * 0.1})`; ctx.lineWidth = 1; ctx.stroke(); }
  },
  exciter: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(239,83,80,.4)'; ctx.lineWidth = 1;
    for (let h = 1; h <= 5; h++) { ctx.beginPath(); for (let x = 0; x < W; x++) { const v = Math.sin(x * 0.1 * h) * 3 / h; ctx.lineTo(x, H / 2 + v); } ctx.stroke(); }
  },
  character: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(255,112,67,.4)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) { const v = Math.tanh(Math.sin(x * 0.12) * 2) * H * 0.3; ctx.lineTo(x, H / 2 - v); }
    ctx.stroke();
  },
  cleanup: (ctx, W, H) => {
    ctx.fillStyle = 'rgba(38,198,218,.06)';
    for (let i = 0; i < 30; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    ctx.strokeStyle = 'rgba(38,198,218,.4)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) ctx.lineTo(x, H / 2 + Math.sin(x * 0.2) * 5);
    ctx.stroke();
  },
  repair: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(77,208,225,.3)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) { const glitch = (x > W * 0.3 && x < W * 0.5) ? (Math.random() - 0.5) * 10 : 0; ctx.lineTo(x, H / 2 + Math.sin(x * 0.15) * 6 + glitch); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(77,208,225,.12)'; ctx.fillRect(W * 0.3, 2, W * 0.2, H - 4);
  },
  enhance: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(66,165,245,.3)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) ctx.lineTo(x, H / 2 + Math.sin(x * 0.18) * 4);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(66,165,245,.6)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) ctx.lineTo(x, H / 2 + Math.sin(x * 0.18) * 7);
    ctx.stroke();
  },
  vocoder: (ctx, W, H) => {
    for (let x = 0; x < W; x += 2) {
      for (let y = 0; y < H / 2 - 2; y += 3) { const v = Math.random() * 0.5; if (v > 0.3) { ctx.fillStyle = `rgba(232,121,249,${v * 0.5})`; ctx.fillRect(x, y, 2, 2); } }
      for (let y = H / 2 + 2; y < H; y += 3) { const v = Math.random() * 0.5; if (v > 0.3) { ctx.fillStyle = `rgba(0,229,255,${v * 0.5})`; ctx.fillRect(x, y, 2, 2); } }
    }
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(0, H / 2 - 1, W, 2);
  },
  granular: (ctx, W, H) => {
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      const c = Math.random();
      const r = Math.floor(255 * (1 - c) * 0.9 + 40 * c);
      const g = Math.floor(160 * (1 - c) + 200 * c);
      const b = Math.floor(60 * (1 - c) + 220 * c);
      ctx.beginPath(); ctx.arc(x, y, 1 + Math.random() * 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.3 + Math.random() * 0.5})`;
      ctx.fill();
    }
  },
  promptfx: (ctx, W, H) => {
    const colors = ['#26c6da', '#8b5cf6', '#ef5350', '#ffab40'];
    const labels = ['LP', 'RV', 'OD', 'DL'];
    for (let i = 0; i < 4; i++) {
      const bw = W * 0.25 + Math.random() * W * 0.45;
      const by = 4 + i * 11;
      ctx.fillStyle = colors[i] + '25';
      ctx.beginPath(); ctx.roundRect(4, by, bw, 9, 3); ctx.fill();
      ctx.fillStyle = colors[i] + '70';
      ctx.beginPath(); ctx.roundRect(4, by, 3, 9, [3, 0, 0, 3]); ctx.fill();
      ctx.fillStyle = colors[i] + '90';
      ctx.font = '700 6px "IBM Plex Mono"';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(labels[i], 11, by + 5);
    }
  },
  // Psychoacoustic effect thumbnails, one per group, in the Studio canvas style.
  'psy-spatial': (ctx, W, H) => {
    const cx = W / 2, cy = H / 2;
    for (let i = 3; i > 0; i--) {
      ctx.beginPath(); ctx.arc(cx, cy, i * Math.min(W, H) * 0.13, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(171,71,188,${0.15 + i * 0.12})`; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.fillStyle = 'rgba(232,121,249,.9)';
    ctx.beginPath(); ctx.arc(cx + W * 0.18, cy - H * 0.12, 2.5, 0, Math.PI * 2); ctx.fill();
  },
  'psy-lowend': (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(245,158,11,.55)'; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = 0; x < W; x++) { const v = Math.sin(x * 0.06) * H * 0.3; ctx.lineTo(x, H / 2 - v); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(245,158,11,.2)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) { const v = Math.sin(x * 0.18) * H * 0.12; ctx.lineTo(x, H / 2 - v); }
    ctx.stroke();
  },
  'psy-tone': (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(239,83,80,.4)'; ctx.lineWidth = 1;
    for (let h = 1; h <= 6; h++) { ctx.beginPath(); for (let x = 0; x < W; x++) { const v = Math.sin(x * 0.08 * h) * 3 / h; ctx.lineTo(x, H / 2 + v); } ctx.stroke(); }
    ctx.strokeStyle = 'rgba(239,83,80,.5)'; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(0, H * 0.72); ctx.lineTo(W, H * 0.25); ctx.stroke(); ctx.setLineDash([]);
  },
  'psy-performance': (ctx, W, H) => {
    const n = 8, bw = W / n;
    for (let i = 0; i < n; i++) {
      const on = i % 2 === 0;
      ctx.fillStyle = on ? 'rgba(139,92,246,.55)' : 'rgba(139,92,246,.12)';
      const bh = on ? H * 0.7 : H * 0.25;
      ctx.fillRect(i * bw + 1, H - bh, bw - 2, bh);
    }
  },
  codec: (ctx, W, H) => {
    const segW = W / 16;
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const r = Math.floor(239 * (1 - t));
      const g = Math.floor(83 * (1 - t) + 229 * t);
      const b = Math.floor(80 * (1 - t) + 255 * t);
      ctx.fillStyle = `rgba(${r},${g},${b},${i < 12 ? 0.7 : 0.08})`;
      ctx.beginPath(); ctx.roundRect(i * segW + 1, 6, segW - 2, H - 12, 2); ctx.fill();
    }
    const cutX = 12 * segW;
    ctx.strokeStyle = 'rgba(239,68,68,.35)'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(cutX, 4); ctx.lineTo(cutX, H - 4); ctx.stroke(); ctx.setLineDash([]);
  },
};

export const ModuleThumb: React.FC<{ preview: string; className?: string }> = ({ preview, className }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const draw = DRAWERS[preview];

    const render = () => {
      const W = parent.clientWidth;
      const H = parent.clientHeight;
      if (W === 0 || H === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      draw?.(ctx, W, H);
    };

    render();
    const ro = new ResizeObserver(render);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [preview]);

  return <canvas ref={ref} className={className} />;
};
