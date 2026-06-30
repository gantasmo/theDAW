import React, { useEffect, useRef, useState } from 'react';
import { Zap, Target, Settings2, Maximize2 } from 'lucide-react';
import { getAnalyser, getEngineCtx, samplePeakAndRMS } from '../../state/playerStore';
import { QuantumLatticeView } from './QuantumLatticeView';

type Mode = 'oscilloscope' | 'spectrum' | 'radial' | 'quantum';

const OVERLAY_RESERVE_HEIGHT = 18;

const formatDb = (db: number): string => {
  if (!Number.isFinite(db)) return '−∞';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
};

export const AdvancedVisualizer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const [mode, setMode] = useState<Mode>('spectrum');
  const [peakDb, setPeakDb] = useState(-Infinity);
  const [rmsDb, setRmsDb] = useState(-Infinity);
  const [ctxInfo, setCtxInfo] = useState<{ sr: number; fft: number }>({ sr: 44100, fft: 2048 });

  // Resize the canvas to its container, accounting for device pixel ratio.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapperRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Render loop — reads from the shared engine analyser.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const analyser = getAnalyser();
    const engineCtx = getEngineCtx();
    setCtxInfo({ sr: engineCtx.sampleRate, fft: analyser.fftSize });

    const timeBuf = new Uint8Array(analyser.fftSize);
    const freqBuf = new Uint8Array(analyser.frequencyBinCount);
    let hudCounter = 0;

    const render = () => {
      rafRef.current = requestAnimationFrame(render);
      const w = canvas.width;
      const h = canvas.height;

      ctx2d.clearRect(0, 0, w, h);

      if (mode === 'oscilloscope') {
        analyser.getByteTimeDomainData(timeBuf);
        ctx2d.lineWidth = 1.5;
        ctx2d.strokeStyle = '#8b5cf6';
        ctx2d.shadowBlur = 8;
        ctx2d.shadowColor = '#8b5cf6';
        ctx2d.beginPath();
        const step = w / timeBuf.length;
        for (let i = 0; i < timeBuf.length; i += 1) {
          const v = (timeBuf[i] - 128) / 128;
          const x = i * step;
          const y = h / 2 + v * (h / 2 - 4);
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
      } else if (mode === 'spectrum') {
        analyser.getByteFrequencyData(freqBuf);
        const usableBins = Math.min(freqBuf.length, Math.floor(freqBuf.length * 0.6));
        const barCount = Math.min(96, usableBins);
        const barWidth = w / barCount;
        const floor = h - OVERLAY_RESERVE_HEIGHT;
        for (let i = 0; i < barCount; i += 1) {
          const t = i / barCount;
          const binIdx = Math.floor(Math.pow(t, 1.6) * (usableBins - 1));
          const mag = freqBuf[binIdx] / 255;
          const barH = Math.max(1, mag * (floor - 4));
          const x = i * barWidth;
          const grad = ctx2d.createLinearGradient(0, floor, 0, floor - barH);
          grad.addColorStop(0, '#7c3aed');
          grad.addColorStop(1, '#c4b5fd');
          ctx2d.fillStyle = grad;
          ctx2d.fillRect(x + 0.5, floor - barH, Math.max(1, barWidth - 1), barH);
        }
      } else if (mode === 'radial') {
        analyser.getByteFrequencyData(freqBuf);
        const cx = w / 2;
        const cy = h / 2;
        const baseR = Math.min(w, h) * 0.18;
        const segs = Math.min(180, freqBuf.length);
        ctx2d.strokeStyle = '#a78bfa';
        ctx2d.lineWidth = 1;
        ctx2d.shadowBlur = 6;
        ctx2d.shadowColor = '#8b5cf6';
        ctx2d.beginPath();
        for (let i = 0; i <= segs; i += 1) {
          const t = i / segs;
          const binIdx = Math.floor(Math.pow(t, 1.4) * (freqBuf.length - 1));
          const mag = freqBuf[binIdx] / 255;
          const r = baseR + mag * (Math.min(w, h) * 0.32);
          const ang = (i / segs) * Math.PI * 2;
          const x = cx + Math.cos(ang) * r;
          const y = cy + Math.sin(ang) * r;
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.closePath();
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
      }

      hudCounter += 1;
      if (hudCounter % 5 === 0) {
        const { peakDb: pd, rmsDb: rd } = samplePeakAndRMS();
        setPeakDb(pd);
        setRmsDb(rd);
      }
    };

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mode]);

  const modeLabels: Record<Mode, string> = { oscilloscope: 'O', spectrum: 'S', radial: 'R', quantum: 'Q' };
  const modeTitles: Record<Mode, string> = { oscilloscope: 'Oscilloscope', spectrum: 'Spectrum', radial: 'Radial', quantum: 'Quantum Lattice' };

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40 relative overflow-hidden group">
      {/* Background Grid */}
      <div
        className="absolute inset-0 opacity-7 pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)`,
          backgroundSize: '20px 20px',
        }}
      />

      {/* Canvas area — fills all space above status bar */}
      <div ref={wrapperRef} className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

        {/* Quantum Lattice WebGL mode overlays the 2D canvas when selected */}
        {mode === 'quantum' && <QuantumLatticeView />}

        {/* O / S / R / Q mode buttons — vertical column, top-left */}
        <div className="absolute top-2 left-2 flex flex-col gap-1 z-10">
          {(['oscilloscope', 'spectrum', 'radial', 'quantum'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              title={modeTitles[m]}
              className={`w-5 h-5 rounded text-[8px] font-black flex items-center justify-center transition-colors
                ${mode === m
                  ? 'bg-purple-600 text-white shadow-[0_0_6px_rgba(139,92,246,0.6)]'
                  : 'bg-black/50 text-zinc-600 border border-white/10 hover:text-zinc-300 hover:border-white/20'
                }`}
            >
              {modeLabels[m]}
            </button>
          ))}
        </div>

        {/* Bottom overlay — gradient backdrop with kHz / RMS / PEAK / LIVE + controls */}
        <div className="absolute bottom-0 left-0 right-0 h-7 flex items-center gap-2.5 px-2.5"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, transparent 100%)', filter: 'drop-shadow(0 -1px 4px rgba(0,0,0,0.6))' }}>
          <span className="text-[9px] font-mono text-zinc-400 uppercase tabular-nums"
            style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}>
            {(ctxInfo.sr / 1000).toFixed(1)} kHz · {ctxInfo.fft}
          </span>

          <div className="w-px h-3 bg-white/15" />

          <div className="flex items-center gap-1">
            <Zap className="w-3 h-3 text-yellow-400 shrink-0" style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.9))' }} />
            <span className="text-[9px] font-mono text-zinc-300 tabular-nums"
              style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}>
              RMS {formatDb(rmsDb)} dB
            </span>
          </div>

          <div className="w-px h-3 bg-white/15" />

          <div className="flex items-center gap-1">
            <Target className="w-3 h-3 text-emerald-400 shrink-0" style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.9))' }} />
            <span className="text-[9px] font-mono text-zinc-300 tabular-nums"
              style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}>
              PEAK {formatDb(peakDb)} dB
            </span>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${peakDb > -60 ? 'bg-purple-400 animate-pulse' : 'bg-zinc-700'}`} />
            <span className={`text-[9px] font-mono font-black uppercase ${peakDb > -60 ? 'text-purple-300' : 'text-zinc-600'}`}
              style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}>
              {peakDb > -60 ? 'LIVE' : 'SILENT'}
            </span>
          </div>

          <div className="w-px h-3 bg-white/15" />

          <div className="flex gap-0.5">
            <button className="p-0.5 hover:bg-white/15 rounded text-zinc-500 hover:text-zinc-200 transition-colors">
              <Settings2 className="w-3 h-3" />
            </button>
            <button
              className="p-0.5 hover:bg-white/15 rounded text-zinc-500 hover:text-zinc-200 transition-colors"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void wrapperRef.current?.requestFullscreen();
              }}
            >
              <Maximize2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

