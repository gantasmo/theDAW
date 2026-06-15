import { useEffect, useRef, useState } from 'react';

type WaveBin = {
  peak: number;
  rms: number;
  color: string;
};

const EMPTY_BINS: WaveBin[] = [];
const SILENCE = 'rgba(72, 83, 100, 0.45)';
const BEAT = '#ff3f4f';
const VOCAL = '#72ee78';
const BASS = '#2ea9ff';
const BRIGHT = '#f5b84b';
const BODY = '#bca8ff';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getMonoSample(buffer: AudioBuffer, index: number): number {
  let total = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    total += buffer.getChannelData(ch)[index] ?? 0;
  }
  return total / Math.max(1, buffer.numberOfChannels);
}

function bandPower(samples: Float32Array, sampleRate: number, freqs: number[]): number {
  let power = 0;
  for (const freq of freqs) {
    if (freq >= sampleRate * 0.45) continue;
    const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
    let q1 = 0;
    let q2 = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const q0 = coeff * q1 - q2 + samples[i];
      q2 = q1;
      q1 = q0;
    }
    power += Math.max(0, q1 * q1 + q2 * q2 - coeff * q1 * q2);
  }
  return power / Math.max(1, samples.length * samples.length * freqs.length);
}

function pickColor(peak: number, rms: number, low: number, mid: number, bright: number, zcr: number, crest: number): string {
  if (peak < 0.012 || rms < 0.004) return SILENCE;

  const total = low + mid + bright + 1e-9;
  const lowShare = low / total;
  const midShare = mid / total;
  const brightShare = bright / total;
  const transient = clamp((crest - 1.65) / 2.7, 0, 1);
  const noisyTop = clamp(zcr / 0.28, 0, 1);

  if (transient > 0.48 && (lowShare > 0.22 || peak > 0.72)) return BEAT;
  if (midShare > lowShare * 1.08 && midShare > brightShare * 0.86) return VOCAL;
  if (lowShare > 0.46) return BASS;
  if (brightShare > 0.34 || noisyTop > 0.58) return BRIGHT;
  return BODY;
}

async function decodeAudio(audioUrl: string, signal: AbortSignal): Promise<AudioBuffer> {
  const res = await fetch(audioUrl, { signal });
  if (!res.ok) throw new Error(`Unable to load audio waveform: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}

function analyzeBuffer(buffer: AudioBuffer): WaveBin[] {
  const bins = clamp(Math.round(buffer.duration * 8), 360, 1200);
  const samplesPerBin = Math.max(1, Math.floor(buffer.length / bins));
  const maxAnalysisSamples = 1024;
  const out: WaveBin[] = [];
  let globalPeak = 0;

  for (let i = 0; i < bins; i += 1) {
    const start = i * samplesPerBin;
    const end = i === bins - 1 ? buffer.length : Math.min(buffer.length, start + samplesPerBin);
    const stride = Math.max(1, Math.floor((end - start) / maxAnalysisSamples));
    const analysisCount = Math.max(1, Math.floor((end - start) / stride));
    const samples = new Float32Array(analysisCount);

    let peak = 0;
    let sumSq = 0;
    let crossings = 0;
    let prev = 0;

    for (let n = 0; n < analysisCount; n += 1) {
      const sample = getMonoSample(buffer, Math.min(buffer.length - 1, start + n * stride));
      samples[n] = sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      sumSq += sample * sample;
      if (n > 0 && ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0))) crossings += 1;
      prev = sample;
    }

    const rms = Math.sqrt(sumSq / analysisCount);
    const zcr = crossings / Math.max(1, analysisCount - 1);
    const analysisRate = buffer.sampleRate / stride;
    const low = bandPower(samples, analysisRate, [58, 88, 128, 180]);
    const mid = bandPower(samples, analysisRate, [420, 760, 1180, 1700]);
    const bright = bandPower(samples, analysisRate, [2600, 3600, 5200]);
    const crest = peak / Math.max(0.0001, rms);

    out.push({ peak, rms, color: pickColor(peak, rms, low, mid, bright, zcr, crest) });
    if (peak > globalPeak) globalPeak = peak;
  }

  if (globalPeak > 0) {
    for (const bin of out) bin.peak = clamp(bin.peak / globalPeak, 0, 1);
  }

  return out;
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  const pixelHeight = Math.max(1, Math.floor(height));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(pixelHeight * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${pixelHeight}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, pixelHeight);

  const bg = ctx.createLinearGradient(0, 0, 0, pixelHeight);
  bg.addColorStop(0, '#06070d');
  bg.addColorStop(0.5, '#0e1018');
  bg.addColorStop(1, '#05060a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, pixelHeight);

  if (bins.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, pixelHeight / 2 - 1, width, 2);
    return;
  }

  const step = 3;
  const barWidth = 2;
  const visibleBars = Math.max(1, Math.floor(width / step));
  const center = pixelHeight / 2;
  const maxBar = Math.max(3, pixelHeight * 0.46);

  const startNorm = clamp(viewportStart, 0, 0.999);
  const endNorm = clamp(viewportEnd, startNorm + 0.001, 1);
  const viewSpan = endNorm - startNorm;

  for (let x = 0; x < visibleBars; x += 1) {
    const start = Math.floor((startNorm + (x / visibleBars) * viewSpan) * bins.length);
    const end = Math.max(start + 1, Math.floor((startNorm + ((x + 1) / visibleBars) * viewSpan) * bins.length));
    let bin = bins[start] ?? bins[0];
    for (let i = start + 1; i < end; i += 1) {
      if ((bins[i]?.peak ?? 0) > bin.peak) bin = bins[i];
    }

    const amp = Math.pow(clamp(bin.peak, 0, 1), 0.72);
    const halfHeight = Math.max(1.5, amp * maxBar);
    const alpha = clamp(0.48 + bin.rms * 3.2 + amp * 0.34, 0.5, 1);
    const left = x * step;
    const grad = ctx.createLinearGradient(0, center - halfHeight, 0, center + halfHeight);
    grad.addColorStop(0, 'rgba(255,255,255,0.8)');
    grad.addColorStop(0.18, bin.color);
    grad.addColorStop(0.5, bin.color);
    grad.addColorStop(0.82, bin.color);
    grad.addColorStop(1, 'rgba(255,255,255,0.34)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = grad;
    ctx.fillRect(left, center - halfHeight, barWidth, halfHeight * 2);
  }
  ctx.globalAlpha = 1;

  const mid = ctx.createLinearGradient(0, 0, width, 0);
  mid.addColorStop(0, 'rgba(255,255,255,0.04)');
  mid.addColorStop(0.5, 'rgba(255,255,255,0.22)');
  mid.addColorStop(1, 'rgba(255,255,255,0.04)');
  ctx.fillStyle = mid;
  ctx.fillRect(0, center - 0.5, width, 1);
}

export function DJSemanticWaveform({
  audioUrl,
  height = 64,
  viewportStart = 0,
  viewportEnd = 1,
}: {
  audioUrl: string;
  height?: number;
  viewportStart?: number;
  viewportEnd?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bins, setBins] = useState<WaveBin[]>(EMPTY_BINS);

  useEffect(() => {
    const ctrl = new AbortController();
    setBins(EMPTY_BINS);
    decodeAudio(audioUrl, ctrl.signal)
      .then((buffer) => {
        if (!ctrl.signal.aborted) setBins(analyzeBuffer(buffer));
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setBins(EMPTY_BINS);
      });
    return () => ctrl.abort();
  }, [audioUrl]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const render = () => {
      const rect = wrap.getBoundingClientRect();
      drawWaveform(canvas, Math.max(1, Math.floor(rect.width)), height, bins, viewportStart, viewportEnd);
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [bins, height, viewportEnd, viewportStart]);

  return (
    <div ref={wrapRef} className="relative h-full w-full min-w-0 overflow-hidden rounded" style={{ height, background: '#06070d' }}>
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
    </div>
  );
}
