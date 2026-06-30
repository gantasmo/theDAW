import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uuid } from '../orb-kit/utils';

export const EFFECT_CATEGORIES: Record<string, string[]> = {
  'Dynamics': ['compression', 'volume', 'loudnorm', 'mastering_chain'],
  'EQ & Tone': ['highpass', 'lowpass', 'eq_mid', 'sub_exciter'],
  'Space': ['reverb_delay', 'delay', 'echo', 'stereo_widener'],
  'Cleanup': ['denoise', 'declick', 'silence_remove'],
  'Creative': ['lofi_vinyl', 'pitch_shift', 'tempo', 'vocal_processing', 'phase_isolation'],
  'Fade': ['fade'],
  'Export': ['export_flac', 'export_mp3', 'export_aac', 'export_opus'],
};

export const EFFECT_DEFAULTS: Record<string, Record<string, number>> = {
  mastering_chain: { lowBoost: 0, highBoost: 0, limiterCeiling: 0.95, targetLUFS: -14 },
  compression: { attack: 0.1, decay: 0.3 },
  highpass: { frequency: 80 },
  volume: { level: 1.0 },
  tempo: { rate: 1.0 },
  vocal_processing: { highpassFreq: 80, presenceBoost: 2, targetLUFS: -16 },
  lofi_vinyl: { degradation: 3, lowpassFreq: 8000 },
  stereo_widener: { delayMs: 15 },
  reverb_delay: { delayMs: 400, decay: 0.5, reverbDecay: 0.4 },
  sub_exciter: { subBoost: 4, trebleBoost: 2 },
  phase_isolation: { cancelAmount: 0.8 },
  eq_mid: { frequency: 1000, width: 500, gain: 0 },
  loudnorm: { targetLUFS: -14, truePeak: -1 },
  lowpass: { frequency: 8000 },
  pitch_shift: { shift: 0 },
  delay: { leftMs: 250, rightMs: 375 },
  echo: { delayMs: 300, decay: 0.4 },
  fade: { fadeInDuration: 1, fadeOutDuration: 2 },
  denoise: { noiseReduction: 20 },
  declick: { windowSize: 30 },
  silence_remove: { threshold: -40 },
  export_flac: { compressionLevel: 5 },
  export_mp3: { bitrate: 320 },
  export_aac: { bitrate: 256 },
  export_opus: { bitrate: 128 },
};

export const EFFECT_LABELS: Record<string, string> = {
  mastering_chain: 'Mastering Chain',
  compression: 'Compressor',
  highpass: 'High-Pass Filter',
  volume: 'Volume',
  tempo: 'Tempo',
  vocal_processing: 'Vocal Processing',
  lofi_vinyl: 'Lo-Fi / Vinyl',
  stereo_widener: 'Stereo Widener',
  reverb_delay: 'Reverb + Delay',
  sub_exciter: 'Sub / Exciter',
  phase_isolation: 'Phase Isolation',
  eq_mid: 'Parametric EQ',
  loudnorm: 'Loudness Norm',
  lowpass: 'Low-Pass Filter',
  pitch_shift: 'Pitch Shift',
  delay: 'Stereo Delay',
  echo: 'Echo',
  fade: 'Fade In/Out',
  denoise: 'Denoise',
  declick: 'De-Click',
  silence_remove: 'Silence Remove',
  export_flac: 'Export FLAC',
  export_mp3: 'Export MP3',
  export_aac: 'Export AAC',
  export_opus: 'Export Opus',
};

/** Identity of a VST3 plugin node in the chain. Present only on VST entries;
 *  FFmpeg/built-in effects leave it undefined. */
export interface VstNode {
  plugin_path: string;
  plugin_name: string;
}

export interface ChainEntry {
  id: string;
  effect: string;
  params: Record<string, number>;
  enabled: boolean;
  /** Set when this entry is a hosted VST3 plugin (effect === 'vst3'). */
  vst?: VstNode;
}

interface EffectChainState {
  chain: ChainEntry[];
  addEffect: (effect: string) => void;
  addVst: (plugin: VstNode) => void;
  removeEffect: (id: string) => void;
  updateParams: (id: string, params: Record<string, number>) => void;
  toggleEnabled: (id: string) => void;
  reorder: (fromIndex: number, toIndex: number) => void;
  clearChain: () => void;
}

export const useEffectChainStore = create<EffectChainState>()(
  persist(
    (set) => ({
      chain: [],
      addEffect: (effect) =>
        set((s) => ({
          chain: [...s.chain, { id: uuid(), effect, params: { ...(EFFECT_DEFAULTS[effect] || {}) }, enabled: true }],
        })),
      addVst: (plugin) =>
        set((s) => ({
          chain: [...s.chain, { id: uuid(), effect: 'vst3', params: {}, enabled: true, vst: plugin }],
        })),
      removeEffect: (id) => set((s) => ({ chain: s.chain.filter((e) => e.id !== id) })),
      updateParams: (id, params) =>
        set((s) => ({ chain: s.chain.map((e) => (e.id === id ? { ...e, params } : e)) })),
      toggleEnabled: (id) =>
        set((s) => ({ chain: s.chain.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
      reorder: (from, to) =>
        set((s) => {
          const next = [...s.chain];
          const [item] = next.splice(from, 1);
          next.splice(to, 0, item);
          return { chain: next };
        }),
      clearChain: () => set({ chain: [] }),
    }),
    {
      name: 'thedaw-effect-chain',
      partialize: (s) => ({ chain: s.chain }),
    },
  ),
);

