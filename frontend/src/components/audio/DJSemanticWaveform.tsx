import { useEffect, useRef, useState } from 'react';

type WaveBin = {
  peak: number;
  rms: number;
  min: number;
  max: number;
  low: number;
  mid: number;
  bright: number;
  transient: number;
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

function pickColor(peak: number, rms: number, low: number, mid: number, bright: number, zcr: number, transient: number): string {
  if (peak < 0.012 || rms < 0.004) return SILENCE;

  const total = low + mid + bright + 1e-9;
  const lowShare = low / total;
  const midShare = mid / total;
  const brightShare = bright / total;
  const noisyTop = clamp(zcr / 0.28, 0, 1);

  if (transient > 0.48 && (lowShare > 0.22 || peak > 0.72)) return BEAT;
  if (midShare > lowShare * 1.08 && midShare > brightShare * 0.86) return VOCAL;
  if (lowShare > 0.46) return BASS;
  if (brightShare > 0.34 || noisyTop > 0.58) return BRIGHT;
  return BODY;
}

function semanticRgb(color: string): [number, number, number] {
  switch (color) {
    case BEAT:
      return [255, 89, 64];
    case VOCAL:
      return [76, 241, 112];
    case BASS:
      return [46, 169, 255];
    case BRIGHT:
      return [255, 182, 65];
    case BODY:
      return [188, 168, 255];
    default:
      return [72, 83, 100];
  }
}

function semanticRgba(color: string, alpha: number): string {
  const [r, g, b] = semanticRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  const bins = clamp(Math.round(buffer.duration * 32), 900, 6400);
  const samplesPerBin = Math.max(1, Math.floor(buffer.length / bins));
  const maxAnalysisSamples = 512;
  const out: WaveBin[] = [];
  let globalPeak = 0;
  let globalLow = 0;
  let globalMid = 0;
  let globalBright = 0;

  for (let i = 0; i < bins; i += 1) {
    const start = i * samplesPerBin;
    const end = i === bins - 1 ? buffer.length : Math.min(buffer.length, start + samplesPerBin);
    const stride = Math.max(1, Math.floor((end - start) / maxAnalysisSamples));
    const analysisCount = Math.max(1, Math.floor((end - start) / stride));
    const samples = new Float32Array(analysisCount);

    let peak = 0;
    let min = 0;
    let max = 0;
    let sumSq = 0;
    let crossings = 0;
    let prev = 0;

    for (let n = 0; n < analysisCount; n += 1) {
      const sample = getMonoSample(buffer, Math.min(buffer.length - 1, start + n * stride));
      samples[n] = sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
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
    const transient = clamp((crest - 1.45) / 3.2, 0, 1);

    out.push({
      peak,
      rms,
      min,
      max,
      low,
      mid,
      bright,
      transient,
      color: pickColor(peak, rms, low, mid, bright, zcr, transient),
    });
    if (peak > globalPeak) globalPeak = peak;
    if (low > globalLow) globalLow = low;
    if (mid > globalMid) globalMid = mid;
    if (bright > globalBright) globalBright = bright;
  }

  if (globalPeak > 0) {
    for (const bin of out) {
      bin.peak = clamp(bin.peak / globalPeak, 0, 1);
      bin.min = clamp(bin.min / globalPeak, -1, 1);
      bin.max = clamp(bin.max / globalPeak, -1, 1);
      bin.rms = clamp(bin.rms / globalPeak, 0, 1);
    }
  }
  for (const bin of out) {
    bin.low = clamp(Math.sqrt(bin.low / Math.max(globalLow, 1e-9)), 0, 1);
    bin.mid = clamp(Math.sqrt(bin.mid / Math.max(globalMid, 1e-9)), 0, 1);
    bin.bright = clamp(Math.sqrt(bin.bright / Math.max(globalBright, 1e-9)), 0, 1);
  }

  return out;
}

type SliceStats = {
  peak: number;
  rms: number;
  min: number;
  max: number;
  low: number;
  mid: number;
  bright: number;
  transient: number;
  color: string;
};

function sliceStats(bins: WaveBin[], start: number, end: number): SliceStats {
  const first = bins[start] ?? bins[0];
  let strongest = first;
  let peak = 0;
  let rms = 0;
  let min = 0;
  let max = 0;
  let low = 0;
  let mid = 0;
  let bright = 0;
  let transient = 0;
  let count = 0;

  for (let i = start; i < end; i += 1) {
    const bin = bins[i] ?? first;
    count += 1;
    if (bin.peak > peak) {
      peak = bin.peak;
      strongest = bin;
    }
    rms += bin.rms;
    if (bin.min < min) min = bin.min;
    if (bin.max > max) max = bin.max;
    if (bin.low > low) low = bin.low;
    mid += bin.mid;
    bright += bin.bright;
    if (bin.transient > transient) transient = bin.transient;
  }

  return {
    peak,
    rms: rms / Math.max(1, count),
    min,
    max,
    low,
    mid: mid / Math.max(1, count),
    bright: bright / Math.max(1, count),
    transient,
    color: strongest.color,
  };
}

function fillSymmetricBar(ctx: CanvasRenderingContext2D, x: number, center: number, topHalf: number, bottomHalf: number, width: number): void {
  ctx.fillRect(x, center - topHalf, width, Math.max(1, topHalf + bottomHalf));
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
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(0, pixelHeight / 2 - 0.5, width, 1);
    return;
  }

  const center = pixelHeight / 2;
  const maxBar = Math.max(3, pixelHeight * 0.47);

  const spanNorm = Math.max(0.001, viewportEnd - viewportStart);

  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fillRect(0, Math.floor(center * 0.5), width, 1);
  ctx.fillRect(0, Math.floor(center * 1.5), width, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.055)';
  ctx.fillRect(0, center - 0.5, width, 1);

  ctx.globalCompositeOperation = 'lighter';
  for (let x = 0; x < width; x += 1) {
    const startNorm = viewportStart + (x / width) * spanNorm;
    const endNorm = viewportStart + ((x + 1) / width) * spanNorm;
    if (endNorm <= 0 || startNorm >= 1) {
      ctx.fillStyle = 'rgba(72, 83, 100, 0.13)';
      fillSymmetricBar(ctx, x, center, 1, 1, 1);
      continue;
    }
    const start = Math.floor(clamp(startNorm, 0, 0.999) * bins.length);
    const end = Math.max(start + 1, Math.ceil(clamp(endNorm, 0.001, 1) * bins.length));
    const bin = sliceStats(bins, start, end);
    const amp = Math.pow(clamp(bin.peak, 0, 1), 0.58);
    const minHalf = Math.max(1, Math.abs(bin.min) * maxBar);
    const maxHalf = Math.max(1, Math.abs(bin.max) * maxBar);
    const fallbackHalf = Math.max(1.25, amp * maxBar);
    const upper = Math.max(maxHalf, fallbackHalf * 0.72);
    const lower = Math.max(minHalf, fallbackHalf * 0.72);

    if (amp < 0.012) {
      ctx.fillStyle = 'rgba(72, 83, 100, 0.24)';
      fillSymmetricBar(ctx, x, center, 1, 1, 1);
      continue;
    }

    const semanticAlpha = clamp(0.26 + amp * 0.34 + bin.rms * 0.22, 0.28, 0.86);
    const lowAlpha = clamp(0.04 + bin.low * 0.34 + amp * 0.08, 0.05, 0.48);
    const midAlpha = clamp(0.04 + bin.mid * 0.44 + bin.rms * 0.28, 0.06, 0.6);
    const brightAlpha = clamp(0.03 + bin.bright * 0.5 + bin.transient * 0.16, 0.04, 0.62);
    const transientAlpha = clamp((bin.transient - 0.24) * 0.82 + amp * 0.08, 0, 0.66);

    ctx.fillStyle = semanticRgba(bin.color, semanticAlpha);
    fillSymmetricBar(ctx, x, center, upper, lower, 1);

    const lowHalf = Math.max(1, fallbackHalf * clamp(0.52 + bin.low * 0.34, 0.42, 0.86));
    ctx.fillStyle = `rgba(30, 144, 255, ${lowAlpha})`;
    fillSymmetricBar(ctx, x, center, lowHalf, lowHalf, 1);

    const midHalf = Math.max(1, fallbackHalf * clamp(0.34 + bin.mid * 0.42, 0.28, 0.72));
    ctx.fillStyle = `rgba(76, 241, 112, ${midAlpha})`;
    fillSymmetricBar(ctx, x, center, midHalf, midHalf, 1);

    const brightHalf = Math.max(1, fallbackHalf * clamp(0.16 + bin.bright * 0.36, 0.14, 0.5));
    ctx.fillStyle = `rgba(255, 182, 65, ${brightAlpha})`;
    fillSymmetricBar(ctx, x, center, brightHalf, brightHalf, 1);

    if (transientAlpha > 0.03) {
      ctx.fillStyle = `rgba(255, 246, 210, ${transientAlpha})`;
      fillSymmetricBar(ctx, x, center, Math.max(1, upper * 0.96), Math.max(1, lower * 0.96), 1);
    }

    if (bin.color === BEAT) {
      const rail = Math.max(1, Math.round(1 + bin.low * 3 + bin.transient * 2));
      ctx.fillStyle = `rgba(255, 89, 64, ${clamp(0.18 + bin.low * 0.4 + bin.transient * 0.34, 0.2, 0.86)})`;
      ctx.fillRect(x, pixelHeight - rail - 1, 1, rail);
    } else if (bin.low > 0.56) {
      const rail = Math.max(1, Math.round(1 + bin.low * 2));
      ctx.fillStyle = `rgba(46, 169, 255, ${clamp(0.12 + bin.low * 0.35, 0.18, 0.58)})`;
      ctx.fillRect(x, pixelHeight - rail - 1, 1, rail);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  const spine = ctx.createLinearGradient(0, 0, width, 0);
  spine.addColorStop(0, 'rgba(255,255,255,0.04)');
  spine.addColorStop(0.5, 'rgba(255,255,255,0.32)');
  spine.addColorStop(1, 'rgba(255,255,255,0.04)');
  ctx.fillStyle = spine;
  ctx.fillRect(0, center - 0.5, width, 1);

  const vignette = ctx.createLinearGradient(0, 0, 0, pixelHeight);
  vignette.addColorStop(0, 'rgba(0,0,0,0.34)');
  vignette.addColorStop(0.12, 'rgba(0,0,0,0)');
  vignette.addColorStop(0.88, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.36)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, pixelHeight);
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
