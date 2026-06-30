import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  Upload, X, Eye, EyeOff, ChevronLeft, ChevronRight, Trash2,
  Download, Send, Sparkles, Plus, Gauge, History, Library, LayoutList, Grid3x3,
  Plug, RefreshCw, Loader2, Play, Pause, Square,
} from 'lucide-react';
import { useEffectChainStore, EFFECT_LABELS, EFFECT_DEFAULTS } from '../state/effectChainStore';
import { useVstStore } from '../state/vstStore';
import type { Vst3PluginInfo } from '../lib/vstClient';
import { useAdvancedEditorSourceStore } from '../state/advancedEditorStore';
import { useStudioStore } from '../state/studioStore';
import { useLibraryStore } from '../state/libraryStore';
import { usePlayerStore } from '../state/playerStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useAppUiStore } from '../state/appUiStore';
import { logError } from '../state/logStore';
import { SlideKnob } from '../components/audio/SlideKnob';
import { SlideRow } from '../components/audio/SlideRow';
import { MixVizRow, type MixVizMode } from '../components/audio/MixVizRow';
import { EffectsVizPanel } from './EffectsVizPanel';
import { EffectGuiStage } from '../components/audio/EffectGuiStage';
import { TheOwl } from '../components/audio/TheOwl';
import { ModuleThumb } from '../components/audio/ModuleThumb';
import { ControlSurface } from '../components/surface/ControlSurface';
import { FxRack } from '../components/audio/FxRack';
import { useMixRackStore } from '../state/mixRackStore';
import { attachMixLiveRack } from '../state/mixLiveRack';
import { buildEffectChain, ensureChopModule, RACK_EFFECTS } from '../lib/rackEffects';
import { encodeWav } from '../lib/wavEncode';
import type { WidgetRegistry } from '../components/surface/widgetTypes';
import type { SurfaceLayout } from '../state/surfaceLayoutStore';
import { EFFECT_CATALOG, PARAM_BOUNDS, CATEGORY_META, fxToCategory, type CategoryMeta } from '../lib/effectCatalog';
import { STUDIO_MODULES, moduleById, effectToModuleId, type StudioModule } from '../lib/moduleCatalog';
import { MAGENTA_TOOLS, magentaToolById, type MagentaTool } from '../lib/magentaToolCatalog';
import { MagentaToolStage } from '../components/audio/MagentaToolStage';
import { Boxes, Headphones, Music } from 'lucide-react';
import '../components/layout/track-controls.css';

/* ── Psychoacoustic effects shown as Studio-style tiles ──────────────────────
   The 11 real-time psychoacoustic rack effects, surfaced in the effects library
   as tiles (the old standalone "Psychoacoustic Rack" panel is gone). Each tile
   gets a Studio-matching canvas thumbnail keyed by effect group; selecting one
   adds it to the rack engine and opens the rack in the Effect Stage. */
interface PsychoModule { id: string; name: string; color: string; desc: string; preview: string; }
const PSYCHO_GROUP_STYLE: Record<string, { color: string; preview: string }> = {
  Spatial: { color: '#ab47bc', preview: 'psy-spatial' },
  'Low end': { color: '#f59e0b', preview: 'psy-lowend' },
  Tone: { color: '#ef5350', preview: 'psy-tone' },
  Performance: { color: '#8b5cf6', preview: 'psy-performance' },
};
const PSYCHO_MODULES: PsychoModule[] = RACK_EFFECTS.map((fx) => {
  const s = PSYCHO_GROUP_STYLE[fx.group] ?? { color: '#a855f7', preview: 'psy-spatial' };
  return { id: fx.id, name: fx.label, color: s.color, desc: fx.description, preview: s.preview };
});
if (import.meta.env.DEV) {
  const uncovered = [...new Set(RACK_EFFECTS.map((fx) => fx.group))].filter((g) => !(g in PSYCHO_GROUP_STYLE));
  if (uncovered.length) console.warn('[MixView] psychoacoustic groups with no tile style (fallback used):', uncovered);
}

/* ── "All" browser cells — shared by the list and tile (icon) views ──────────── */
const AllHeader: React.FC<{ icon: React.ComponentType<{ className?: string }>; color: string; label: string; count: number }> = ({ icon: Icon, color, label, count }) => (
  <div className="flex items-center gap-1.5 px-1 pt-0.5">
    <Icon className={`w-3 h-3 shrink-0 ${color}`} />
    <span className={`text-[9px] font-black uppercase tracking-widest ${color}`}>{label}</span>
    <span className="text-[8px] font-mono text-zinc-600">{count}</span>
  </div>
);
// A Studio module / psychoacoustic effect cell (color is a hex accent).
const ModuleRow: React.FC<{ name: string; desc: string; color: string; marked: boolean; onClick: () => void }> = ({ name, desc, color, marked, onClick }) => (
  <div onClick={onClick} className={`flex items-center gap-2 border rounded px-3 py-2 cursor-pointer transition-all ${marked ? 'border-white/30 bg-white/5' : 'border-zinc-800 hover:border-white/25 hover:bg-white/5'}`}>
    <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
    <div className="flex-1 min-w-0">
      <span className="text-[11px] font-medium block truncate" style={{ color }}>{name}</span>
      <p className="text-[9px] text-zinc-500 truncate mt-0.5">{desc}</p>
    </div>
    {marked && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />}
  </div>
);
const ModuleTile: React.FC<{ name: string; color: string; marked: boolean; onClick: () => void }> = ({ name, color, marked, onClick }) => (
  <div onClick={onClick} style={{ width: 90, height: 98 }} className={`relative flex flex-col items-center justify-center gap-2 rounded border cursor-pointer transition-all overflow-hidden p-2 ${marked ? 'border-white/30 bg-white/5' : 'border-white/8 hover:border-white/20 hover:brightness-110'}`}>
    <span className="w-7 h-7 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 10px ${color}80` }} />
    <span className="text-[10px] font-medium text-center leading-tight line-clamp-2" style={{ color }}>{name}</span>
  </div>
);
// A backend effect cell (color comes from its category classes).
const FxRow: React.FC<{ name: string; desc: string; cat: CategoryMeta; inChain: boolean; onClick: () => void }> = ({ name, desc, cat, inChain, onClick }) => (
  <div onClick={onClick} className={`flex items-center gap-2 border rounded px-3 py-2 cursor-pointer transition-all ${inChain ? 'border-white/30 bg-white/5' : 'border-zinc-800 hover:border-white/25 hover:bg-white/5'}`}>
    <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />
    <div className="flex-1 min-w-0">
      <span className={`text-[11px] font-medium block truncate ${cat.tile.text}`}>{name}</span>
      <p className="text-[9px] text-zinc-500 truncate mt-0.5">{desc}</p>
    </div>
    {inChain && <span className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />}
  </div>
);
const FxTile: React.FC<{ name: string; cat: CategoryMeta; inChain: boolean; onClick: () => void }> = ({ name, cat, inChain, onClick }) => {
  const Icon = cat.icon;
  return (
    <div onClick={onClick} style={{ width: 90, height: 98 }} className={`relative flex flex-col items-center justify-start gap-1.5 rounded border cursor-pointer transition-all overflow-hidden p-2 ${cat.tile.bg} ${inChain ? `${cat.tile.border} ring-2 ${cat.tile.ring}` : 'border-white/8 hover:border-white/20 hover:brightness-110'}`}>
      <div className={`absolute inset-0 ${cat.tile.glow} blur-xl pointer-events-none opacity-70`} />
      <div className="relative z-10 flex items-center justify-center w-10 h-10 mt-1.5"><Icon className={`w-7 h-7 ${cat.tile.text}`} /></div>
      <span className={`text-[10px] font-medium text-center leading-tight relative z-10 ${cat.tile.text} px-0.5 line-clamp-2`}>{name}</span>
      {inChain && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-white z-10" />}
    </div>
  );
};

/* ═══ MIX (PROCESS) tab — now on the Control-Surface editor ═══════════════════
   Layout (drag-arrangeable in Design Mode, like DJ):
     TOP    — 2 viz rows: input + output (toggle waveform / live scope, overlay A/B)
     MIDDLE — effect rail (categories + Quick Master) | library | chain
     LOWER  — effectStage (active effect's UI/viz; ModuleShell + hero viz lands here later)
   The footer is the PROCESS-CHAIN transport. */

const sectionTitle = 'text-[10px] font-black uppercase tracking-widest text-purple-300';

/* ── MIX transport — play / pause / stop for a row's audio (input source or
   processed output). Drives the global player engine; the row whose label is
   currently loaded shows the live play/pause state so either can be auditioned
   at any time. ── */
const MixTransport: React.FC<{ url: string | null; label: string }> = ({ url, label }) => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentLabel = usePlayerStore((s) => s.currentLabel);
  const isActive = currentLabel === label;
  const playing = isActive && isPlaying;

  const toggle = async () => {
    if (!url) return;
    if (isActive) { usePlayerStore.getState().toggle(); return; }
    try {
      const blob = await fetch(url).then((r) => r.blob());
      await usePlayerStore.getState().load(blob, { label });
      usePlayerStore.getState().play();
    } catch { /* non-fatal — load/play errors surface in the player log */ }
  };
  const stop = () => { if (isActive) usePlayerStore.getState().stop(); };

  return (
    <>
      <button
        onClick={() => void toggle()}
        disabled={!url}
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        className="p-1 rounded text-zinc-400 hover:text-purple-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
      </button>
      <button
        onClick={stop}
        disabled={!url || !isActive}
        title="Stop"
        aria-label="Stop"
        className="p-1 rounded text-zinc-400 hover:text-red-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Square className="w-3 h-3" />
      </button>
    </>
  );
};

const PARAM_LABELS: Record<string, string> = {
  lowBoost: 'Low', highBoost: 'High', limiterCeiling: 'Ceil', targetLUFS: 'LUFS',
  attack: 'Atk', decay: 'Dec', frequency: 'Freq', level: 'Lvl', rate: 'Rate',
  highpassFreq: 'HP', presenceBoost: 'Pres', degradation: 'Degr', lowpassFreq: 'LP',
  delayMs: 'Delay', reverbDecay: 'Verb', subBoost: 'Sub', trebleBoost: 'Treb',
  cancelAmount: 'Cancel', width: 'Width', gain: 'Gain', truePeak: 'Peak',
  shift: 'Shift', leftMs: 'Left', rightMs: 'Right', fadeInDuration: 'In',
  fadeOutDuration: 'Out', noiseReduction: 'Noise', windowSize: 'Win',
  threshold: 'Thr', compressionLevel: 'Lvl', bitrate: 'Rate',
};
const prettyParam = (k: string) => PARAM_LABELS[k] ?? (k.length > 6 ? k.slice(0, 6) : k);

interface AudioStats { peakDb: number; rmsDb: number; sampleRate: number; duration: number; }

function analyzeAudio(source: File | string): Promise<AudioStats> {
  return new Promise((resolve, reject) => {
    const ctx = new AudioContext();
    const load = typeof source === 'string'
      ? fetch(source).then((r) => r.arrayBuffer())
      : source.arrayBuffer();
    load.then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        const ch = decoded.getChannelData(0);
        let peak = 0, sumSq = 0;
        for (let i = 0; i < ch.length; i++) {
          const a = Math.abs(ch[i]);
          if (a > peak) peak = a;
          sumSq += ch[i] * ch[i];
        }
        const rms = Math.sqrt(sumSq / ch.length);
        ctx.close();
        resolve({
          peakDb: parseFloat((20 * Math.log10(Math.max(peak, 1e-10))).toFixed(1)),
          rmsDb: parseFloat((20 * Math.log10(Math.max(rms, 1e-10))).toFixed(1)),
          sampleRate: decoded.sampleRate,
          duration: decoded.duration,
        });
      })
      .catch((e) => { ctx.close(); reject(e); });
  });
}

async function fileFromDrop(e: React.DragEvent): Promise<File | null> {
  const libId = e.dataTransfer.getData('application/x-thedaw-library-id');
  if (libId) {
    const entry = useLibraryStore.getState().entries.find((en) => en.id === libId);
    if (entry) {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      return new File([blob], `${entry.title.slice(0, 40)}.wav`, { type: entry.mimeType || 'audio/wav' });
    }
  }
  return e.dataTransfer.files[0] || null;
}

function StatRow({ stats }: { stats: AudioStats }) {
  const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);
  const Pill = ({ label, value }: { label: string; value: string }) => (
    <span className="flex items-center gap-1">
      <span className="text-[8px] font-mono text-zinc-600 uppercase">{label}</span>
      <span className="text-[9px] font-mono text-zinc-300">{value}</span>
    </span>
  );
  return (
    <div className="flex items-center gap-2">
      <Pill label="SR" value={`${(stats.sampleRate / 1000).toFixed(1)}kHz`} />
      <span className="text-zinc-700">·</span>
      <Pill label="Peak" value={`${stats.peakDb}dBFS`} />
      <span className="text-zinc-700">·</span>
      <Pill label="RMS" value={`${stats.rmsDb}dB`} />
      <span className="text-zinc-700">·</span>
      <Pill label="Dur" value={fmtDur(stats.duration)} />
    </div>
  );
}

/* ═══ default layout ═════════════════════════════════════════════════════════ */
/* The user's hand-arranged MIX layout (Design Mode export):
     top    — Input / Output viz rows
     middle — Effects rail · [ Chain over Effect Stage ] · Library
   Version is bumped past any previously-persisted MIX layout so this default
   takes over cleanly. */
const MIX_LAYOUT_VERSION = 6;
const defaultMixLayout: SurfaceLayout = {
  version: MIX_LAYOUT_VERSION,
  root: 'root',
  nodes: {
    root: { id: 'root', type: 'container', axis: 'column', children: ['topViz', 'mid'], fr: { topViz: 1.6506024096385525, mid: 5.349397590361448 } },
    topViz: { id: 'topViz', type: 'container', axis: 'column', children: ['inputVizP', 'outputVizP'], fr: { inputVizP: 1, outputVizP: 1 } },
    inputVizP: { id: 'inputVizP', type: 'panel', title: 'Input', flow: 'row', widgets: [], pinned: 'inputViz' },
    outputVizP: { id: 'outputVizP', type: 'panel', title: 'Output', flow: 'row', widgets: [], pinned: 'outputViz' },
    mid: { id: 'mid', type: 'container', axis: 'row', children: ['railP', 'cont-3-b45ab2a0'], fr: { railP: 0.7625161264148641, 'cont-3-b45ab2a0': 3.652897886323994 }, framed: true },
    railP: { id: 'railP', type: 'panel', title: 'Effects', flow: 'row', widgets: [], pinned: 'effectRail' },
    libraryP: { id: 'libraryP', type: 'panel', title: 'Library', flow: 'row', widgets: [], pinned: 'library' },
    chainP: { id: 'chainP', type: 'panel', title: 'Chain', flow: 'row', widgets: [], pinned: 'chain' },
    stageP: { id: 'stageP', type: 'panel', title: 'Effect Stage', flow: 'row', widgets: [], pinned: 'effectStage' },
    'cont-3-b45ab2a0': { id: 'cont-3-b45ab2a0', type: 'container', axis: 'row', children: ['cont-4-4768bad0', 'libraryP'], fr: { libraryP: 0.45836297448789, 'cont-4-4768bad0': 1.5416370255121108 }, framed: true },
    'cont-4-4768bad0': { id: 'cont-4-4768bad0', type: 'container', axis: 'column', children: ['chainP', 'stageP'], fr: { chainP: 0.6536796536796542, stageP: 1.3463203463203457 }, framed: true },
  },
};

interface ChainEntry { id: string; effect: string; enabled: boolean; params: Record<string, number>; vst?: { plugin_path: string; plugin_name: string }; }

interface MixRegArgs {
  // input/output viz
  sourceUrl: string | null; outputUrl: string | null;
  srcStats: AudioStats | null; outStats: AudioStats | null;
  sourceFile: File | null;
  inputMode: MixVizMode; setInputMode: (m: MixVizMode) => void;
  outputMode: MixVizMode; setOutputMode: (m: MixVizMode) => void;
  inputOverlay: boolean; toggleInputOverlay: () => void;
  outputOverlay: boolean; toggleOutputOverlay: () => void;
  dragOverSource: boolean;
  onDrop: (e: React.DragEvent) => void; onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void;
  onClickUpload: () => void; onClearSource: () => void;
  isChainProcessing: boolean;
  onDownload: () => void; onSendToDAW: () => void; onSendToInpaint: () => void;
  // rail
  activeCategory: string; setActiveCategory: (c: string) => void; allEffectCount: number;
  quickMaster: Record<string, number>; setQuickParam: (k: string, v: number) => void;
  applyQuickMaster: () => void; masterEntry: boolean;
  // library
  activeEffects: Array<{ id: string; name: string; desc: string }>; viewMode: 'list' | 'tile';
  setViewMode: (m: 'list' | 'tile') => void; addEffect: (id: string) => void; chainEffectIds: Set<string>;
  // VST3 plugins (hosted via pedalboard) — shown in the effects browser and
  // added to the chain as 'vst3' nodes.
  vstPlugins: Vst3PluginInfo[]; vstScanning: boolean; rescanVst: () => void;
  addVstToChain: (p: Vst3PluginInfo) => void; vstInChain: Set<string>;
  // studio modules (exact-GUI instruments)
  onPickModule: (id: string) => void; activeModuleId: string | null; activeModule: StudioModule | null;
  onPickPsycho: (id: string) => void; activePsychoId: string | null;
  // magenta RT2 tools (Collider / Jam / MRT2 — generative instruments)
  onPickMagenta: (id: string) => void; activeMagentaId: string | null; activeMagentaTool: MagentaTool | null;
  // chain
  chain: ChainEntry[]; selectedId: string | null; setSelectedId: (id: string) => void;
  removeEffect: (id: string) => void; updateParams: (id: string, p: Record<string, number>) => void;
  toggleEnabled: (id: string) => void; reorder: (from: number, to: number) => void; clearChain: () => void;
  outputFormat: string; setOutputFormat: (f: string) => void;
  showHistory: boolean; setShowHistory: (v: boolean) => void;
  processHistory: Array<{ id: string; effect: string; createdAt: number }>;
  selectedEntry: ChainEntry | null;
  // psychoacoustic rack — the EDIT FX engine, applied to the MIX source and baked
  // into the output (separate from the backend effect chain above)
  rackChain: ChainEntry[];
  rackAdd: (id: string) => void; rackRemove: (id: string) => void;
  rackReorder: (from: number, to: number) => void; rackToggle: (id: string) => void;
  rackUpdateParams: (id: string, params: Record<string, number>) => void; rackClear: () => void;
  applyRack: () => void; applyingRack: boolean; hasSource: boolean;
}

function buildMixRegistry(p: MixRegArgs): WidgetRegistry {
  const reg: WidgetRegistry = {};
  const pinned = (id: string, label: string, node: React.ReactNode) => {
    reg[id] = { id, label, group: 'Panels', kind: 'fixed', source: 'builtin', render: () => <div className="h-full w-full min-h-0 overflow-hidden">{node}</div> };
  };

  /* ── INPUT viz row (with drop affordance) ── */
  pinned('inputViz', 'Input', (
    <div
      className={`h-full w-full min-h-0 transition-colors ${p.dragOverSource ? 'ring-1 ring-purple-500/60 bg-purple-500/5' : ''}`}
      onDrop={p.onDrop}
      onDragOver={p.onDragOver}
      onDragLeave={p.onDragLeave}
    >
      <MixVizRow
        label="Input" url={p.sourceUrl} overlayUrl={p.outputUrl} accent="#22d3ee" overlayAccent="#a855f7"
        mode={p.inputMode} onMode={p.setInputMode} overlay={p.inputOverlay} onToggleOverlay={p.toggleInputOverlay}
        placeholder="drop audio or click ⬆ to load"
        headerExtra={
          <>
            {p.srcStats && <StatRow stats={p.srcStats} />}
            <MixTransport url={p.sourceUrl} label="MIX Input" />
            <button onClick={p.onClickUpload} title={p.sourceFile ? 'Replace source' : 'Load source'} className="p-1 rounded text-zinc-400 hover:text-purple-200 hover:bg-white/5">
              <Upload className="w-3 h-3" />
            </button>
            {p.sourceFile && (
              <button onClick={p.onClearSource} title="Clear source" className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-white/5">
                <X className="w-3 h-3" />
              </button>
            )}
          </>
        }
      />
    </div>
  ));

  /* ── OUTPUT viz row (with result actions) ── */
  pinned('outputViz', 'Output', (
    <div className="h-full w-full min-h-0 relative">
      <MixVizRow
        label="Output" url={p.outputUrl} overlayUrl={p.sourceUrl} accent="#a855f7" overlayAccent="#22d3ee"
        mode={p.outputMode} onMode={p.setOutputMode} overlay={p.outputOverlay} onToggleOverlay={p.toggleOutputOverlay}
        placeholder="output appears after processing"
        headerExtra={
          <>
            {p.outStats && <StatRow stats={p.outStats} />}
            <MixTransport url={p.outputUrl} label="MIX Output" />
            <button onClick={p.onDownload} disabled={!p.outputUrl} title="Save" className="p-1 rounded text-zinc-400 hover:text-green-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"><Download className="w-3 h-3" /></button>
            <button onClick={p.onSendToDAW} disabled={!p.outputUrl} title="Send to Edit" className="p-1 rounded text-zinc-400 hover:text-emerald-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"><Send className="w-3 h-3" /></button>
            <button onClick={p.onSendToInpaint} disabled={!p.outputUrl} title="Send to Inpaint" className="p-1 rounded text-zinc-400 hover:text-purple-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"><Sparkles className="w-3 h-3" /></button>
          </>
        }
      />
      {p.isChainProcessing && (
        <div className="absolute inset-0 grid place-items-center bg-black/50 backdrop-blur-sm pointer-events-none">
          <span className="text-[10px] font-mono text-purple-300 animate-pulse">processing chain…</span>
        </div>
      )}
    </div>
  ));

  /* ── effect rail: categories + Quick Master ── */
  pinned('effectRail', 'Effects', (
    <div className="h-full w-full flex flex-col min-h-0 overflow-hidden p-1.5 gap-1.5">
      <span className={sectionTitle}>Effects</span>
      <div className="flex flex-col gap-0.5 overflow-y-auto min-h-0">
        <button onClick={() => p.setActiveCategory('all')}
          title="Every effect in MIX, grouped by category"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'all' ? 'border-purple-400 text-purple-200 bg-purple-500/10' : 'border-transparent text-zinc-300 hover:text-zinc-100 hover:bg-white/5'}`}>
          <Library className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">All</span>
          <span className="text-[8px] font-mono text-zinc-500 shrink-0">{p.allEffectCount}</span>
        </button>
        <button onClick={() => p.setActiveCategory('studio')}
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'studio' ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-transparent text-cyan-400/80 hover:text-cyan-200 hover:bg-cyan-500/5'}`}>
          <Boxes className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">Studio</span>
          <span className="text-[8px] font-mono text-cyan-600 shrink-0">{STUDIO_MODULES.length}</span>
        </button>
        <button onClick={() => p.setActiveCategory('psychoacoustics')}
          title="Psychoacoustic effects — pick one to open the rack in the Effect Stage"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'psychoacoustics' ? 'border-fuchsia-400 text-fuchsia-200 bg-fuchsia-500/10' : 'border-transparent text-fuchsia-400/80 hover:text-fuchsia-200 hover:bg-fuchsia-500/5'}`}>
          <Headphones className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">Psychoacoustics</span>
          <span className="text-[8px] font-mono text-fuchsia-600 shrink-0">{PSYCHO_MODULES.length}</span>
        </button>
        <button onClick={() => p.setActiveCategory('magenta')}
          title="Magenta RealTime 2 — generative instruments (Collider · Jam · MRT2)"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'magenta' ? 'border-sky-400 text-sky-200 bg-sky-500/10' : 'border-transparent text-sky-400/80 hover:text-sky-200 hover:bg-sky-500/5'}`}>
          <Music className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">Magenta</span>
          <span className="text-[8px] font-mono text-sky-600 shrink-0">{MAGENTA_TOOLS.length}</span>
        </button>
        <button onClick={() => p.setActiveCategory('vst')}
          title="VST3 plugins hosted via pedalboard — add them to the chain like any effect"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'vst' ? 'border-teal-400 text-teal-200 bg-teal-500/10' : 'border-transparent text-teal-400/80 hover:text-teal-200 hover:bg-teal-500/5'}`}>
          <Plug className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">VST</span>
          <span className="text-[8px] font-mono text-teal-600 shrink-0">{p.vstPlugins.length}</span>
        </button>
        {CATEGORY_META.map((cat) => {
          const Icon = cat.icon;
          const active = p.activeCategory === cat.id;
          return (
            <button key={cat.id} onClick={() => p.setActiveCategory(cat.id)}
              className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${active ? cat.rail.active : cat.rail.idle}`}>
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[10px] font-semibold flex-1 truncate">{cat.label}</span>
              <span className="text-[8px] font-mono text-zinc-600 shrink-0">{cat.count}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-auto pt-2 border-t border-white/8 shrink-0">
        <div className="flex items-center gap-1 mb-2"><Gauge className="w-3 h-3 text-purple-300" /><span className={sectionTitle}>Quick Master</span></div>
        <div className="grid grid-cols-2 gap-x-1 gap-y-2 place-items-center mb-2">
          <SlideKnob label="Punch" value={p.quickMaster.lowBoost} onChange={(v) => p.setQuickParam('lowBoost', v)} min={-6} max={6} step={0.5} size={34} />
          <SlideKnob label="Air" value={p.quickMaster.highBoost} onChange={(v) => p.setQuickParam('highBoost', v)} min={-6} max={6} step={0.5} size={34} />
          <SlideKnob label="Drive" value={p.quickMaster.targetLUFS} onChange={(v) => p.setQuickParam('targetLUFS', v)} min={-24} max={-8} step={0.5} size={34} />
          <SlideKnob label="Ceil" value={p.quickMaster.limiterCeiling} onChange={(v) => p.setQuickParam('limiterCeiling', v)} min={0.8} max={1} step={0.01} size={34} />
        </div>
        <button onClick={p.applyQuickMaster} className="w-full btn-ghost text-[9px] py-1 flex items-center justify-center gap-1 text-purple-300 border-purple-500/20 bg-purple-500/5">
          <Plus className="w-3 h-3" /> {p.masterEntry ? 'Sync Master' : 'Add Quick Master'}
        </button>
      </div>
    </div>
  ));

  /* ── library ── */
  pinned('library', 'Library', (
    <div className="h-full w-full flex flex-col min-h-0 min-w-0 overflow-hidden p-2">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <span className={sectionTitle}>{p.activeCategory === 'studio' ? 'Studio Modules' : p.activeCategory === 'magenta' ? 'Magenta Tools' : p.activeCategory === 'psychoacoustics' ? 'Psychoacoustics' : p.activeCategory === 'vst' ? 'VST3 Plugins' : p.activeCategory === 'all' ? 'All Effects' : (CATEGORY_META.find((c) => c.id === p.activeCategory)?.label ?? 'Effects')}</span>
        {p.activeCategory !== 'studio' && p.activeCategory !== 'psychoacoustics' && p.activeCategory !== 'magenta' && p.activeCategory !== 'vst' && (
          <div className="flex items-center gap-0.5 bg-black/40 rounded p-0.5">
            <button onClick={() => p.setViewMode('list')} title="List view" className={`p-1 rounded transition-colors ${p.viewMode === 'list' ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}><LayoutList className="w-3 h-3" /></button>
            <button onClick={() => p.setViewMode('tile')} title="Icon view" className={`p-1 rounded transition-colors ${p.viewMode === 'tile' ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}><Grid3x3 className="w-3 h-3" /></button>
          </div>
        )}
      </div>
      {p.activeCategory === 'magenta' ? (
        <div className="flex-1 overflow-y-auto"><div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
          {MAGENTA_TOOLS.map((m) => {
            const active = p.activeMagentaTool?.id === m.id;
            return (
              <button key={m.id} onClick={() => p.onPickMagenta(m.id)} title={m.desc}
                className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${active ? 'border-cyan-400/60 ring-1 ring-cyan-400/40 bg-cyan-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                style={{ width: 132 }}>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: m.color, boxShadow: `0 0 5px ${m.color}80` }} />
                  <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{m.name}</span>
                </div>
                <div className="relative w-full h-20 rounded bg-[#0a0c14] border border-white/5 overflow-hidden">
                  <ModuleThumb preview={m.preview} className="w-full h-full" />
                </div>
                <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{m.desc}</span>
              </button>
            );
          })}
        </div></div>
      ) : p.activeCategory === 'studio' ? (
        <div className="flex-1 overflow-y-auto"><div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
          {STUDIO_MODULES.map((m) => {
            const active = p.activeModule?.id === m.id;
            return (
              <button key={m.id} onClick={() => p.onPickModule(m.id)} title={m.desc}
                className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${active ? 'border-cyan-400/60 ring-1 ring-cyan-400/40 bg-cyan-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                style={{ width: 132 }}>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: m.color, boxShadow: `0 0 5px ${m.color}80` }} />
                  <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{m.name}</span>
                </div>
                <div className="relative w-full h-20 rounded bg-[#0a0c14] border border-white/5 overflow-hidden">
                  <ModuleThumb preview={m.preview} className="w-full h-full" />
                </div>
                <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{m.desc}</span>
              </button>
            );
          })}
        </div></div>
      ) : p.activeCategory === 'psychoacoustics' ? (
        <div className="flex-1 overflow-y-auto"><div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
          {PSYCHO_MODULES.map((m) => {
            const active = p.activePsychoId === m.id;
            const inRack = p.rackChain.some((e) => e.effect === m.id);
            return (
              <button key={m.id} onClick={() => p.onPickPsycho(m.id)} title={m.desc}
                className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${active ? 'border-fuchsia-400/60 ring-1 ring-fuchsia-400/40 bg-fuchsia-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                style={{ width: 132 }}>
                <div className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: m.color, boxShadow: `0 0 5px ${m.color}80` }} />
                  <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{m.name}</span>
                  {inRack && <span role="img" aria-label="In rack" className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 shrink-0" />}
                </div>
                <div className="relative w-full h-20 rounded bg-[#0a0c14] border border-white/5 overflow-hidden">
                  <ModuleThumb preview={m.preview} className="w-full h-full" />
                </div>
                <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{m.desc}</span>
              </button>
            );
          })}
        </div></div>
      ) : p.activeCategory === 'vst' ? (
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
          <div className="flex items-center gap-2 px-1.5 pb-1.5 shrink-0">
            <button onClick={p.rescanVst} disabled={p.vstScanning} className="btn-ghost inline-flex items-center gap-1 disabled:opacity-40" title="Rescan the standard VST3 folders">
              {p.vstScanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Rescan
            </button>
            <span className="text-[8px] font-mono text-zinc-600">host: pedalboard</span>
          </div>
          {p.vstPlugins.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center opacity-30 italic gap-2 py-8">
              <Plug className="w-7 h-7" />
              <span className="text-[10px]">{p.vstScanning ? 'Scanning…' : 'No VST3 plugins found. Click Rescan.'}</span>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
              {p.vstPlugins.map((pl) => {
                const inChain = p.vstInChain.has(pl.path);
                return (
                  <button key={pl.path} onClick={() => p.addVstToChain(pl)} title={pl.path}
                    className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${inChain ? 'border-teal-400/60 ring-1 ring-teal-400/40 bg-teal-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                    style={{ width: 132 }}>
                    <div className="flex items-center gap-1.5">
                      <Plug className="w-3 h-3 text-teal-300 shrink-0" />
                      <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{pl.name}</span>
                      {inChain && <span aria-label="In chain" className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />}
                    </div>
                    <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{[pl.manufacturer, pl.version].filter(Boolean).join(' · ') || pl.category}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : p.activeCategory === 'all' ? (() => {
        // Everything in MIX, in either list or icon view. Order: Studio +
        // Psychoacoustics first, then the backend effect categories.
        const tile = p.viewMode === 'tile';
        const boxCls = tile ? 'flex flex-wrap gap-3 content-start justify-center p-1' : 'flex flex-col gap-1';
        return (
          <div className="flex-1 overflow-y-auto"><div className="flex flex-col gap-2 content-start">
            <div className="flex flex-col gap-1">
              <AllHeader icon={Boxes} color="text-cyan-300" label="Studio" count={STUDIO_MODULES.length} />
              <div className={boxCls}>
                {STUDIO_MODULES.map((m) => (tile
                  ? <ModuleTile key={m.id} name={m.name} color={m.color} marked={p.activeModule?.id === m.id} onClick={() => p.onPickModule(m.id)} />
                  : <ModuleRow key={m.id} name={m.name} desc={m.desc} color={m.color} marked={p.activeModule?.id === m.id} onClick={() => p.onPickModule(m.id)} />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <AllHeader icon={Headphones} color="text-fuchsia-300" label="Psychoacoustics" count={PSYCHO_MODULES.length} />
              <div className={boxCls}>
                {PSYCHO_MODULES.map((m) => {
                  const marked = p.activePsychoId === m.id || p.rackChain.some((e) => e.effect === m.id);
                  return tile
                    ? <ModuleTile key={m.id} name={m.name} color={m.color} marked={marked} onClick={() => p.onPickPsycho(m.id)} />
                    : <ModuleRow key={m.id} name={m.name} desc={m.desc} color={m.color} marked={marked} onClick={() => p.onPickPsycho(m.id)} />;
                })}
              </div>
            </div>
            {p.vstPlugins.length > 0 && (
              <div className="flex flex-col gap-1">
                <AllHeader icon={Plug} color="text-teal-300" label="VST3" count={p.vstPlugins.length} />
                <div className={boxCls}>
                  {p.vstPlugins.map((pl) => {
                    const inChain = p.vstInChain.has(pl.path);
                    const desc = [pl.manufacturer, pl.version].filter(Boolean).join(' · ') || pl.category;
                    return tile
                      ? <ModuleTile key={pl.path} name={pl.name} color="#2dd4bf" marked={inChain} onClick={() => p.addVstToChain(pl)} />
                      : <ModuleRow key={pl.path} name={pl.name} desc={desc} color="#2dd4bf" marked={inChain} onClick={() => p.addVstToChain(pl)} />;
                  })}
                </div>
              </div>
            )}
            {CATEGORY_META.map((cat) => {
              const fxs = EFFECT_CATALOG[cat.id] || [];
              if (!fxs.length) return null;
              return (
                <div key={cat.id} className="flex flex-col gap-1">
                  <AllHeader icon={cat.icon} color={cat.tile.text} label={cat.label} count={fxs.length} />
                  <div className={boxCls}>
                    {fxs.map((fx) => {
                      const inChain = p.chainEffectIds.has(fx.id);
                      return tile
                        ? <FxTile key={fx.id} name={fx.name} cat={cat} inChain={inChain} onClick={() => p.addEffect(fx.id)} />
                        : <FxRow key={fx.id} name={fx.name} desc={fx.desc} cat={cat} inChain={inChain} onClick={() => p.addEffect(fx.id)} />;
                    })}
                  </div>
                </div>
              );
            })}
          </div></div>
        );
      })() : p.viewMode === 'list' ? (
        <div className="flex-1 overflow-y-auto"><div className="flex flex-col gap-1 content-start">
          {p.activeEffects.map((fx) => {
            const cat = fxToCategory[fx.id] ?? CATEGORY_META[0];
            const inChain = p.chainEffectIds.has(fx.id);
            return (
              <div key={fx.id} onClick={() => p.addEffect(fx.id)}
                className={`flex items-center gap-2 border rounded px-3 py-2 cursor-pointer transition-all ${inChain ? 'border-white/30 bg-white/5' : 'border-zinc-800 hover:border-white/25 hover:bg-white/5'}`}>
                <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />
                <div className="flex-1 min-w-0">
                  <span className={`text-[11px] font-medium block truncate ${cat.tile.text}`}>{fx.name}</span>
                  <p className="text-[9px] text-zinc-500 truncate mt-0.5">{fx.desc}</p>
                </div>
                {inChain && <span className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />}
              </div>
            );
          })}
        </div></div>
      ) : (
        <div className="flex-1 overflow-y-auto"><div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
          {p.activeEffects.map((fx) => {
            const inChain = p.chainEffectIds.has(fx.id);
            const cat = fxToCategory[fx.id] ?? CATEGORY_META[0];
            const Icon = cat.icon;
            return (
              <div key={fx.id} onClick={() => p.addEffect(fx.id)}
                className={`relative flex flex-col items-center justify-start gap-1.5 rounded border cursor-pointer transition-all overflow-hidden p-2 ${cat.tile.bg} ${inChain ? `${cat.tile.border} ring-2 ${cat.tile.ring}` : 'border-white/8 hover:border-white/20 hover:brightness-110'}`}
                style={{ width: 90, height: 98 }}>
                <div className={`absolute inset-0 ${cat.tile.glow} blur-xl pointer-events-none opacity-70`} />
                <div className="relative z-10 flex items-center justify-center w-10 h-10 mt-1.5"><Icon className={`w-7 h-7 ${cat.tile.text}`} /></div>
                <span className={`text-[10px] font-medium text-center leading-tight relative z-10 ${cat.tile.text} px-0.5 line-clamp-2`}>{fx.name}</span>
                {inChain && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-white z-10" />}
              </div>
            );
          })}
        </div></div>
      )}
    </div>
  ));

  /* ── chain — horizontal signal flow, left → right ── */
  pinned('chain', 'Chain', (
    <div className="h-full w-full flex flex-col min-h-0 overflow-hidden p-2">
      <div className="flex items-center gap-2 mb-1.5 shrink-0">
        <span className={sectionTitle}>Chain {p.chain.length > 0 && <span className="text-zinc-600">({p.chain.length})</span>}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-zinc-500 shrink-0">FORMAT</span>
          <select name="mix-output-format" className="compact-input text-[10px] w-20" value={p.outputFormat} onChange={(e) => p.setOutputFormat(e.target.value)}>
            <option value="wav">WAV</option><option value="flac">FLAC</option><option value="mp3">MP3</option><option value="ogg">OGG</option>
          </select>
          <button onClick={() => p.setShowHistory(!p.showHistory)} title="Process history" className={`btn-ghost p-1 shrink-0 ${p.showHistory ? 'text-purple-300' : 'text-zinc-500 hover:text-zinc-300'}`}><History className="w-3.5 h-3.5" /></button>
          {p.chain.length > 0 && <button className="text-zinc-600 hover:text-red-400 transition-colors shrink-0" onClick={p.clearChain} title="Clear chain"><Trash2 className="w-3.5 h-3.5" /></button>}
        </div>
      </div>
      {p.showHistory && (
        <div className="max-h-14 overflow-y-auto flex flex-col gap-0.5 mb-1.5 shrink-0">
          {p.processHistory.length === 0 ? <span className="text-[9px] font-mono text-zinc-600 px-1">No process jobs yet.</span> : p.processHistory.map((h) => (
            <div key={h.id} className="flex items-center justify-between px-1.5 py-0.5 bg-white/5 rounded">
              <span className="text-[9px] font-mono text-zinc-300 uppercase truncate">{EFFECT_LABELS[h.effect] || h.effect}</span>
              <span className="text-[8px] font-mono text-zinc-600 shrink-0">{new Date(h.createdAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-x-auto overflow-y-hidden flex flex-row items-stretch gap-0 min-h-0">
        {p.chain.length === 0 ? (
          <div className="flex-1 flex items-center justify-center px-2"><span className="text-[10px] text-zinc-600 text-center">Add effects from the library — they flow left → right</span></div>
        ) : (
          p.chain.map((entry, index) => (
            <React.Fragment key={entry.id}>
              {index > 0 && <div className="self-center px-0.5 text-zinc-700 shrink-0"><ChevronRight className="w-3 h-3" /></div>}
              <div onClick={() => p.setSelectedId(entry.id)}
                className={`rounded p-1.5 border transition-all cursor-pointer shrink-0 w-40 flex flex-col ${p.selectedEntry?.id === entry.id ? 'border-purple-500/60 bg-purple-500/5' : 'border-zinc-800 hover:border-white/10'} ${!entry.enabled ? 'opacity-40' : ''}`}>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="text-zinc-600 hover:text-purple-400 disabled:opacity-20 shrink-0" disabled={index === 0} title="Move earlier" onClick={(e) => { e.stopPropagation(); p.reorder(index, index - 1); }}><ChevronLeft className="w-3 h-3" /></button>
                  <span className="text-[10px] font-mono text-purple-300 font-semibold flex-1 truncate">{entry.vst ? entry.vst.plugin_name : (EFFECT_LABELS[entry.effect] || entry.effect)}</span>
                  <button className="text-zinc-500 hover:text-purple-400 shrink-0" onClick={(e) => { e.stopPropagation(); p.toggleEnabled(entry.id); }}>{entry.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}</button>
                  <button className="text-zinc-600 hover:text-red-400 shrink-0" onClick={(e) => { e.stopPropagation(); p.removeEffect(entry.id); }}><X className="w-3 h-3" /></button>
                  <button className="text-zinc-600 hover:text-purple-400 disabled:opacity-20 shrink-0" disabled={index === p.chain.length - 1} title="Move later" onClick={(e) => { e.stopPropagation(); p.reorder(index, index + 1); }}><ChevronRight className="w-3 h-3" /></button>
                </div>
                {Object.keys(entry.params).length > 0 && (
                  <div className="flex flex-col gap-1 mt-1.5 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                    {Object.entries(entry.params).map(([key, val]) => {
                      const [min, max, step] = PARAM_BOUNDS[entry.effect]?.[key] || [0, 1, 0.01];
                      return <SlideRow key={key} label={prettyParam(key)} value={val} min={min} max={max} step={step} onChange={(v) => p.updateParams(entry.id, { ...entry.params, [key]: v })} />;
                    })}
                  </div>
                )}
              </div>
            </React.Fragment>
          ))
        )}
      </div>
    </div>
  ));

  /* ── effect stage — the active effect's EXACT GUI (the Edit Tool Stack
     instrument, live Web-Audio preview), falling back to the generic viz for
     chain effects that have no dedicated instrument, and a pick-a-module prompt
     when nothing is focused. ── */
  const psychoRackStage = (
    <div className="h-full w-full flex flex-col min-h-0 overflow-hidden p-2 gap-2">
      <div className="flex items-center gap-2 shrink-0">
        <span className={sectionTitle}>Psychoacoustic Rack</span>
        <span className="text-[8px] font-mono text-zinc-600">live FX, baked to output</span>
        {p.rackChain.length > 0 && (
          <button onClick={p.rackClear} title="Clear rack" className="ml-auto text-zinc-600 hover:text-red-400 transition-colors shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <FxRack
          chain={p.rackChain}
          idPrefix="mix-rack"
          onAdd={p.rackAdd}
          onRemove={p.rackRemove}
          onReorder={p.rackReorder}
          onToggle={p.rackToggle}
          onUpdateParams={p.rackUpdateParams}
        />
      </div>
      <button
        onClick={p.applyRack}
        disabled={!p.hasSource || p.rackChain.length === 0 || p.applyingRack}
        title={!p.hasSource ? 'Load a source first' : 'Render the source through the rack into the output'}
        className="shrink-0 w-full py-1.5 rounded bg-purple-600/30 border border-purple-500/40 text-purple-200 text-[9px] font-black uppercase tracking-widest hover:bg-purple-600/50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
      >
        {p.applyingRack ? 'Rendering…' : 'Apply rack to output'}
      </button>
    </div>
  );
  // "The Owl" (the spatializer) gets its dedicated front-end in the Effect Stage
  // footprint — the same spot Studio Modules land. It drives the live rack entry's
  // params directly. Falls back to the rack view if the entry isn't present yet.
  const owlEntry = p.rackChain.find((e) => e.effect === 'spatializer');
  const owlStage = owlEntry ? (
    <TheOwl
      params={owlEntry.params}
      idPrefix={`mix-owl-${owlEntry.id}`}
      onChange={(np) => p.rackUpdateParams(owlEntry.id, np)}
    />
  ) : psychoRackStage;
  // A focused psycho tile shows the rack; an explicit Studio module or selected
  // chain entry takes priority; otherwise a populated rack still shows here so it
  // can never be orphaned (and the Apply button stays reachable).
  pinned('effectStage', 'Effect Stage', (
    p.activeMagentaTool
      ? <MagentaToolStage tool={p.activeMagentaTool} />
    : p.activePsychoId === 'spatializer'
      ? owlStage
    : p.activePsychoId
      ? psychoRackStage
      : p.activeModule
        ? <EffectGuiStage module={p.activeModule} sourceFile={p.sourceFile} />
        : p.selectedEntry
          ? <EffectsVizPanel effect={p.selectedEntry.effect} params={p.selectedEntry.params} className="h-full! border-purple-500/15!" />
          : p.rackChain.length > 0
            ? psychoRackStage
            : <EffectGuiStage module={null} sourceFile={p.sourceFile} />
  ));

  return reg;
}

/* ═══════════════════════════════ MixView ═══════════════════════════════════ */

export const MixView: React.FC = () => {
  const sourceFile = useAdvancedEditorSourceStore((s) => s.sourceFile);
  const outputUrl = useAdvancedEditorSourceStore((s) => s.outputUrl);
  const setSource = useAdvancedEditorSourceStore((s) => s.setSource);
  const setOutputUrl = useAdvancedEditorSourceStore((s) => s.setOutputUrl);

  // Psychoacoustic rack (EDIT's Web-Audio FX engine) applied to the MIX source.
  const rackChain = useMixRackStore((s) => s.chain);
  const rackAdd = useMixRackStore((s) => s.add);
  const rackRemove = useMixRackStore((s) => s.remove);
  const rackReorder = useMixRackStore((s) => s.reorder);
  const rackToggle = useMixRackStore((s) => s.toggle);
  const rackUpdateParams = useMixRackStore((s) => s.updateParams);
  const rackClear = useMixRackStore((s) => s.clear);
  const [applyingRack, setApplyingRack] = useState(false);

  const chain = useEffectChainStore((s) => s.chain) as ChainEntry[];
  const addEffect = useEffectChainStore((s) => s.addEffect);
  const addVst = useEffectChainStore((s) => s.addVst);
  // VST3 plugins for the effects browser (hosted via pedalboard).
  const vstPlugins = useVstStore((s) => s.plugins);
  const vstScanning = useVstStore((s) => s.scanning);
  const scanVst = useVstStore((s) => s.scan);
  const removeEffect = useEffectChainStore((s) => s.removeEffect);
  const updateParams = useEffectChainStore((s) => s.updateParams);
  const toggleEnabled = useEffectChainStore((s) => s.toggleEnabled);
  const reorder = useEffectChainStore((s) => s.reorder);
  const clearChain = useEffectChainStore((s) => s.clearChain);

  const outputFormat = useStudioStore((s) => s.outputFormat);
  const setOutputFormat = useStudioStore((s) => s.setOutputFormat);
  const isChainProcessing = useStudioStore((s) => s.isChainProcessing);
  const processHistory = useStudioStore((s) => s.processHistory);

  const [activeCategory, setActiveCategory] = useState('all');
  const [viewMode, setViewMode] = useState<'list' | 'tile'>('tile');
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [activeModuleId, setActiveModuleId] = useState<string | null>(null);
  // The psychoacoustic effect focused in the Effect Stage (opens the rack there).
  const [activePsychoId, setActivePsychoId] = useState<string | null>(null);
  // The Magenta RT2 tool focused in the Effect Stage (Collider / Jam / MRT2).
  const [activeMagentaId, setActiveMagentaId] = useState<string | null>(null);
  const [srcStats, setSrcStats] = useState<AudioStats | null>(null);
  const [outStats, setOutStats] = useState<AudioStats | null>(null);
  const [dragOverSource, setDragOverSource] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [inputMode, setInputMode] = useState<MixVizMode>('wave');
  const [outputMode, setOutputMode] = useState<MixVizMode>('wave');
  const [inputOverlay, setInputOverlay] = useState(false);
  const [outputOverlay, setOutputOverlay] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [quickMaster, setQuickMaster] = useState<Record<string, number>>(() => ({ ...EFFECT_DEFAULTS.mastering_chain }));

  const sourceUrl = useMemo(() => (sourceFile ? URL.createObjectURL(sourceFile) : null), [sourceFile]);
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);

  // Wire the psychoacoustic rack onto the footer's master insert so it is heard
  // LIVE on the transport and is never rebuilt when a new clip is applied. Attached
  // once for the session; an empty rack is a clean passthrough (see mixLiveRack).
  useEffect(() => { attachMixLiveRack(); }, []);

  // Populate the VST3 browser on first open (cached scan — cheap).
  useEffect(() => { void scanVst(false); }, [scanVst]);

  useEffect(() => {
    if (!sourceFile) { setSrcStats(null); return; }
    analyzeAudio(sourceFile).then(setSrcStats).catch(() => setSrcStats(null));
  }, [sourceFile]);
  useEffect(() => {
    if (!outputUrl) { setOutStats(null); return; }
    analyzeAudio(outputUrl).then(setOutStats).catch(() => setOutStats(null));
  }, [outputUrl]);

  const setSourceBoth = (file: File | null) => {
    setSource(file);
    useStudioStore.getState().setSourceFile(file);
    // Bind the MIX working file to the footer transport so pressing Play auditions
    // it LIVE through the master rack. The rack stays put across source swaps, so a
    // new clip starts cleanly without tearing down or restarting the effects.
    if (file) void usePlayerStore.getState().load(file, { label: file.name });
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOverSource(false);
    const file = await fileFromDrop(e);
    if (file) setSourceBoth(file);
  };
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setSourceBoth(f);
    e.target.value = '';
  };

  const masterEntry = chain.find((e) => e.effect === 'mastering_chain');
  const setQuickParam = (key: string, v: number) => {
    setQuickMaster((qm) => ({ ...qm, [key]: v }));
    const m = useEffectChainStore.getState().chain.find((e) => e.effect === 'mastering_chain');
    if (m) updateParams(m.id, { ...m.params, [key]: v });
  };
  const applyQuickMaster = () => {
    const existing = useEffectChainStore.getState().chain.find((e) => e.effect === 'mastering_chain');
    if (existing) {
      updateParams(existing.id, { ...quickMaster });
      setSelectedChainId(existing.id);
    } else {
      addEffect('mastering_chain');
      const next = useEffectChainStore.getState().chain;
      const added = next[next.length - 1];
      if (added) { updateParams(added.id, { ...quickMaster }); setSelectedChainId(added.id); }
    }
  };

  // Render the source through the psychoacoustic rack in an OfflineAudioContext and
  // set it as the MIX output (mirrors EDIT's offline bounce; chop worklet preloaded).
  const applyRack = async () => {
    const file = useAdvancedEditorSourceStore.getState().sourceFile;
    const chainNow = useMixRackStore.getState().chain;
    if (!file || chainNow.length === 0 || applyingRack) return;
    setApplyingRack(true);
    const decodeCtx = new AudioContext({ sampleRate: 44100 });
    try {
      const ab = await file.arrayBuffer();
      const buf = await decodeCtx.decodeAudioData(ab.slice(0));
      const offline = new OfflineAudioContext(2, buf.length, buf.sampleRate);
      if (chainNow.some((e) => e.effect === 'chop' && e.enabled)) {
        try { await ensureChopModule(offline); } catch { /* falls back to passthrough */ }
      }
      const inGain = offline.createGain();
      buildEffectChain(offline, inGain, offline.destination, chainNow);
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.connect(inGain);
      src.start(0);
      const rendered = await offline.startRendering();
      const wav = encodeWav(rendered);
      setOutputUrl(URL.createObjectURL(wav));
      // Persist the rendered result to the library (mirrors the backend chain's
      // save). Without this the rack output only appears in the Output viz and
      // is never saved.
      const label = chainNow.filter((e) => e.enabled).map((e) => e.effect).join(' + ') || 'rack';
      const title = `rack-${label.slice(0, 40)}.wav`;
      try {
        await useLibraryStore.getState().importEntry({
          blob: wav,
          filename: title,
          mimeType: 'audio/wav',
          metadata: { title, prompt: `Psychoacoustic rack: ${label}`, source: 'studio', tags: ['psychoacoustic-rack'] },
        });
      } catch (e) {
        logError('studio', `Rack library save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch { /* non-fatal: leave the prior output in place */ } finally {
      decodeCtx.close().catch(() => {});
      setApplyingRack(false);
    }
  };

  const handleDownload = () => {
    if (!outputUrl) return;
    const a = document.createElement('a');
    a.href = outputUrl; a.download = `mix-output.${outputFormat}`; a.click();
  };
  const handleSendToDAW = async () => {
    if (!outputUrl) return;
    try {
      const blob = await fetch(outputUrl).then((r) => r.blob());
      await usePlayerStore.getState().load(blob, { label: `mix-output.${outputFormat}` });
    } catch { /* non-fatal */ }
    useAppUiStore.getState().setCenterTab('edit');
  };
  const handleSendToInpaint = async () => {
    if (!outputUrl) return;
    try {
      const blob = await fetch(outputUrl).then((r) => r.blob());
      const file = new File([blob], `mix-output.${outputFormat}`, { type: blob.type });
      useGenerateParamsStore.getState().patch({ inpaintAudioFile: file, inpaintEnabled: true, maskStart: 0, maskEnd: 0 });
    } catch { /* non-fatal */ }
    useAppUiStore.getState().setCenterTab('make');
  };

  const allEffects = Object.values(EFFECT_CATALOG).flat();
  const activeEffects = activeCategory === 'all' ? allEffects : (EFFECT_CATALOG[activeCategory] || []);
  const chainEffectIds = new Set(chain.map((e) => e.effect));
  const vstInChain = new Set(chain.filter((e) => e.vst).map((e) => e.vst!.plugin_path));
  const addVstToChain = (pl: Vst3PluginInfo) => addVst({ plugin_path: pl.path, plugin_name: pl.name });
  const selectedEntry = chain.find((e) => e.id === selectedChainId) ?? chain[0] ?? null;

  // The instrument shown in the effect stage: an explicitly-picked Studio Module
  // takes priority; otherwise the selected chain effect opens its mapped module.
  const mappedModuleId = selectedEntry ? effectToModuleId[selectedEntry.effect] : undefined;
  const activeModule: StudioModule | null =
    (activeModuleId ? moduleById[activeModuleId] ?? null : null)
    ?? (mappedModuleId ? moduleById[mappedModuleId] ?? null : null);

  // Picking a module from the library toggles its instrument open/closed.
  const handlePickModule = (id: string) => { setActivePsychoId(null); setActiveMagentaId(null); setActiveModuleId((cur) => (cur === id ? null : id)); };
  // Selecting a chain entry hands the stage back to the effect→module mapping.
  const selectChain = (id: string) => { setActivePsychoId(null); setActiveMagentaId(null); setSelectedChainId(id); setActiveModuleId(null); };
  // Picking a psychoacoustic tile adds it to the rack engine (once) and opens the
  // rack in the Effect Stage; clicking the focused one again closes the stage.
  const handlePickPsycho = (id: string) => {
    if (activePsychoId === id) { setActivePsychoId(null); return; }
    if (!rackChain.some((e) => e.effect === id)) rackAdd(id);
    setActiveModuleId(null);
    setActiveMagentaId(null);
    setActivePsychoId(id);
  };
  // Picking a Magenta tool opens its generative instrument in the Effect Stage;
  // clicking the focused one again closes it. Mutually exclusive with the above.
  const activeMagentaTool: MagentaTool | null = activeMagentaId ? magentaToolById[activeMagentaId] ?? null : null;
  const handlePickMagenta = (id: string) => {
    setActivePsychoId(null); setActiveModuleId(null);
    setActiveMagentaId((cur) => (cur === id ? null : id));
  };

  const registry = buildMixRegistry({
    sourceUrl, outputUrl, srcStats, outStats, sourceFile,
    inputMode, setInputMode, outputMode, setOutputMode,
    inputOverlay, toggleInputOverlay: () => setInputOverlay((v) => !v),
    outputOverlay, toggleOutputOverlay: () => setOutputOverlay((v) => !v),
    dragOverSource,
    onDrop: handleDrop,
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverSource(true); },
    onDragLeave: () => setDragOverSource(false),
    onClickUpload: () => fileInputRef.current?.click(),
    onClearSource: () => setSourceBoth(null),
    isChainProcessing,
    onDownload: handleDownload, onSendToDAW: () => void handleSendToDAW(), onSendToInpaint: () => void handleSendToInpaint(),
    activeCategory, setActiveCategory, allEffectCount: allEffects.length + PSYCHO_MODULES.length + STUDIO_MODULES.length + vstPlugins.length,
    quickMaster, setQuickParam, applyQuickMaster, masterEntry: !!masterEntry,
    activeEffects, viewMode, setViewMode, addEffect, chainEffectIds,
    vstPlugins, vstScanning, rescanVst: () => void scanVst(true), addVstToChain, vstInChain,
    onPickModule: handlePickModule, activeModuleId, activeModule,
    onPickPsycho: handlePickPsycho, activePsychoId,
    onPickMagenta: handlePickMagenta, activeMagentaId, activeMagentaTool,
    chain, selectedId: selectedChainId, setSelectedId: selectChain,
    removeEffect, updateParams, toggleEnabled, reorder, clearChain,
    outputFormat, setOutputFormat, showHistory, setShowHistory, processHistory,
    selectedEntry,
    rackChain, rackAdd, rackRemove, rackReorder, rackToggle, rackUpdateParams, rackClear,
    applyRack: () => void applyRack(), applyingRack, hasSource: !!sourceFile,
  });

  return (
    <div className="relative h-full w-full overflow-hidden text-zinc-200">
      <ControlSurface surfaceId="mix" registry={registry} defaultLayout={defaultMixLayout} className="p-1.5" />
      <input ref={fileInputRef} name="mix-audio-file" type="file" accept="audio/*" className="hidden" onChange={handleFileSelect} title="Upload audio file" />
    </div>
  );
};
