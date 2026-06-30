import {
  Layers, Activity, SlidersHorizontal, Clock, Eraser, Download,
} from 'lucide-react';
import type React from 'react';

/* ── Effect catalog + param bounds ─────────────────────────────────────
   The library-browser taxonomy (Stacks / Dynamics / EQ / Tempo / Cleanup /
   Export) and the per-param [min, max, step] bounds used to render the
   SLIDE controls. Extracted from AdvancedEditorPanel so the MIX tab
   (MixPanel) and any future surface share one source of truth. The chain
   STORE keeps its own coarser grouping (EFFECT_CATEGORIES in
   effectChainStore) — this is purely the picker/UI catalog. */

export const PARAM_BOUNDS: Record<string, Record<string, [number, number, number]>> = {
  mastering_chain: { lowBoost: [-6, 6, 0.5], highBoost: [-6, 6, 0.5], limiterCeiling: [0.8, 1, 0.01], targetLUFS: [-24, -8, 0.5] },
  compression: { attack: [0.01, 1, 0.01], decay: [0.1, 2, 0.1] },
  highpass: { frequency: [20, 1000, 1] },
  volume: { level: [0, 3, 0.01] },
  tempo: { rate: [0.5, 2, 0.05] },
  vocal_processing: { highpassFreq: [40, 200, 1], presenceBoost: [-6, 6, 0.5], targetLUFS: [-24, -8, 0.5] },
  lofi_vinyl: { degradation: [0, 10, 0.5], lowpassFreq: [2000, 16000, 100] },
  stereo_widener: { delayMs: [1, 40, 1] },
  reverb_delay: { delayMs: [100, 2000, 10], decay: [0.1, 0.9, 0.01], reverbDecay: [0.1, 0.9, 0.01] },
  sub_exciter: { subBoost: [0, 12, 0.5], trebleBoost: [0, 8, 0.5] },
  phase_isolation: { cancelAmount: [0.5, 1, 0.01] },
  eq_mid: { frequency: [20, 20000, 1], width: [50, 5000, 10], gain: [-12, 12, 0.5] },
  loudnorm: { targetLUFS: [-30, -8, 0.5], truePeak: [-6, 0, 0.1] },
  lowpass: { frequency: [500, 20000, 100] },
  pitch_shift: { shift: [-4800, 4800, 100] },
  delay: { leftMs: [0, 2000, 10], rightMs: [0, 2000, 10] },
  echo: { delayMs: [100, 3000, 10], decay: [0.1, 0.8, 0.01] },
  fade: { fadeInDuration: [0, 10, 0.1], fadeOutDuration: [0, 10, 0.1] },
  denoise: { noiseReduction: [5, 50, 1] },
  declick: { windowSize: [10, 100, 1] },
  silence_remove: { threshold: [-80, -20, 1] },
  export_flac: { compressionLevel: [0, 12, 1] },
  export_mp3: { bitrate: [128, 320, 8] },
  export_aac: { bitrate: [128, 320, 8] },
  export_opus: { bitrate: [64, 256, 8] },
};

export interface CatalogEffect { id: string; name: string; desc: string; params: number; }

export const EFFECT_CATALOG: Record<string, CatalogEffect[]> = {
  stacks: [
    { id: 'mastering_chain', name: 'Mastering Chain', desc: 'EQ → Compression → Limiter → Loudness Normalization → 24-bit', params: 4 },
    { id: 'vocal_processing', name: 'Vocal Processing', desc: 'Highpass → EQ → Compression → Loudness Normalization', params: 3 },
    { id: 'lofi_vinyl', name: 'Lo-Fi / Vinyl', desc: 'Downsample → Highpass → Lowpass → Chorus for vintage character', params: 2 },
    { id: 'stereo_widener', name: 'Stereo Widener', desc: 'Haas effect — microscopic delay on right channel', params: 1 },
    { id: 'reverb_delay', name: 'Reverb + Delay', desc: 'Ping-pong delay cascade with long-decay ambient echo', params: 3 },
    { id: 'sub_exciter', name: 'Club EQ', desc: 'Sub bass boost + treble exciter for club-ready sound', params: 2 },
    { id: 'phase_isolation', name: 'Vocal Removal', desc: 'Phase cancellation to remove center-panned material', params: 1 },
  ],
  dynamics: [
    { id: 'compression', name: 'Compressor', desc: 'Dynamic range compression with adjustable attack and release', params: 2 },
    { id: 'loudnorm', name: 'Loudness Norm', desc: 'Normalize loudness to broadcast standards', params: 2 },
    { id: 'volume', name: 'Volume', desc: 'Simple volume gain control', params: 1 },
    { id: 'delay', name: 'Stereo Delay', desc: 'Independent left/right channel delay in milliseconds', params: 2 },
    { id: 'echo', name: 'Echo', desc: 'Echo with adjustable delay time and decay', params: 2 },
    { id: 'fade', name: 'Fade In/Out', desc: 'Linear fade-in and fade-out over configurable durations', params: 2 },
  ],
  eq: [
    { id: 'highpass', name: 'High-Pass', desc: 'Remove frequencies below cutoff — rolls off mud and rumble', params: 1 },
    { id: 'lowpass', name: 'Low-Pass', desc: 'Remove frequencies above cutoff — tame harshness', params: 1 },
    { id: 'eq_mid', name: 'Parametric EQ', desc: 'Bell-shaped boost or cut at a center frequency', params: 3 },
  ],
  tempo: [
    { id: 'tempo', name: 'Time Stretch', desc: 'Change tempo without affecting pitch', params: 1 },
    { id: 'pitch_shift', name: 'Pitch Shift', desc: 'Shift pitch up or down in cents', params: 1 },
  ],
  cleanup: [
    { id: 'denoise', name: 'Noise Reduction', desc: 'Spectral subtraction to reduce broadband noise', params: 1 },
    { id: 'declick', name: 'Click Removal', desc: 'Remove clicks and pops from recordings', params: 1 },
    { id: 'silence_remove', name: 'Silence Remove', desc: 'Strip leading silence below a dB threshold', params: 1 },
  ],
  export: [
    { id: 'export_mp3', name: 'MP3 Encoder', desc: 'Lossy MP3 at configurable bitrate', params: 1 },
    { id: 'export_flac', name: 'FLAC Encoder', desc: 'Lossless FLAC with configurable compression level', params: 1 },
    { id: 'export_aac', name: 'AAC Encoder', desc: 'AAC (M4A) at configurable bitrate', params: 1 },
    { id: 'export_opus', name: 'Opus Encoder', desc: 'Opus at configurable bitrate — best quality/size ratio', params: 1 },
  ],
};

export interface CategoryMeta {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  /** Solid dot/swatch color (bg-*) for list rows and chips. */
  dot: string;
  tile: { bg: string; text: string; border: string; ring: string; glow: string };
  /** Sidebar rail button classes, so each category reads its own color. */
  rail: { active: string; idle: string };
}

// Each category gets a distinct hue across the spectrum (purple → blue → cyan →
// amber → emerald → rose) so the effects panel has real color diversity rather
// than one all-purple wash.
export const CATEGORY_META: CategoryMeta[] = [
  { id: 'stacks',   label: 'Stacks',   icon: Layers,            count: 7, dot: 'bg-purple-400',
    tile: { bg: 'bg-purple-950',  text: 'text-purple-200',  border: 'border-purple-500/50', ring: 'ring-purple-400/50', glow: 'bg-purple-500/20' },
    rail: { active: 'border-purple-400 text-purple-200 bg-purple-500/10', idle: 'border-transparent text-purple-300/70 hover:text-purple-200 hover:bg-purple-500/5' } },
  { id: 'dynamics', label: 'Dynamics', icon: Activity,          count: 6, dot: 'bg-blue-400',
    tile: { bg: 'bg-blue-950',    text: 'text-blue-200',    border: 'border-blue-500/50',   ring: 'ring-blue-400/50',   glow: 'bg-blue-500/20' },
    rail: { active: 'border-blue-400 text-blue-200 bg-blue-500/10', idle: 'border-transparent text-blue-300/70 hover:text-blue-200 hover:bg-blue-500/5' } },
  { id: 'eq',       label: 'EQ',       icon: SlidersHorizontal, count: 3, dot: 'bg-cyan-400',
    tile: { bg: 'bg-cyan-950',    text: 'text-cyan-200',    border: 'border-cyan-500/50',   ring: 'ring-cyan-400/50',   glow: 'bg-cyan-500/20' },
    rail: { active: 'border-cyan-400 text-cyan-200 bg-cyan-500/10', idle: 'border-transparent text-cyan-300/70 hover:text-cyan-200 hover:bg-cyan-500/5' } },
  { id: 'tempo',    label: 'Tempo',    icon: Clock,             count: 2, dot: 'bg-amber-400',
    tile: { bg: 'bg-amber-950',   text: 'text-amber-200',   border: 'border-amber-500/50',  ring: 'ring-amber-400/50',  glow: 'bg-amber-500/20' },
    rail: { active: 'border-amber-400 text-amber-200 bg-amber-500/10', idle: 'border-transparent text-amber-300/70 hover:text-amber-200 hover:bg-amber-500/5' } },
  { id: 'cleanup',  label: 'Cleanup',  icon: Eraser,            count: 3, dot: 'bg-emerald-400',
    tile: { bg: 'bg-emerald-950', text: 'text-emerald-200', border: 'border-emerald-500/50',ring: 'ring-emerald-400/50',glow: 'bg-emerald-500/20' },
    rail: { active: 'border-emerald-400 text-emerald-200 bg-emerald-500/10', idle: 'border-transparent text-emerald-300/70 hover:text-emerald-200 hover:bg-emerald-500/5' } },
  { id: 'export',   label: 'Export',   icon: Download,          count: 4, dot: 'bg-rose-400',
    tile: { bg: 'bg-rose-950',    text: 'text-rose-200',    border: 'border-rose-500/50',   ring: 'ring-rose-400/50',   glow: 'bg-rose-500/20' },
    rail: { active: 'border-rose-400 text-rose-200 bg-rose-500/10', idle: 'border-transparent text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/5' } },
];

const catById = Object.fromEntries(CATEGORY_META.map((c) => [c.id, c])) as Record<string, CategoryMeta>;

export const fxToCategory: Record<string, CategoryMeta> = {};
Object.entries(EFFECT_CATALOG).forEach(([catId, fxs]) => {
  fxs.forEach((fx) => { fxToCategory[fx.id] = catById[catId] ?? CATEGORY_META[0]; });
});
