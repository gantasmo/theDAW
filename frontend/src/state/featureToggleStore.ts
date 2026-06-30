/**
 * Feature toggle store — mirrors the backend `/api/settings` payload.
 *
 * Backend is authoritative (it persists to data/settings.json and the
 * background workers read from it). The frontend keeps a local zustand-
 * persist mirror so toggles read instantly from cache and survive a
 * reload before the first /api/settings round-trip resolves.
 *
 * Write flow: any user-facing toggle calls `patch({...})` which (a)
 * optimistically updates the local store and (b) PATCHes the backend.
 * If the PATCH fails the next refresh() will reconcile.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AnalysisSettings {
  auto_on_import: boolean;
  auto_on_generate: boolean;
  include_genre: boolean;
  include_key: boolean;
}

export interface StemsSettings {
  auto_on_import: boolean;
  auto_on_generate: boolean;
  default_count: number;
  /** 'cuda' | 'cpu' | 'auto'. Default 'cuda' — demucs on CPU is glacial. */
  device: string;
  /** 'fast' | 'balanced' | 'hq'. Default 'balanced' — sidecar's old
   *  default of 'hq' (overlap=0.9, shifts=10) routinely takes 10+ min
   *  per track and stalls at single percent points. */
  quality: string;
}

export interface MidiSettings {
  auto_on_import: boolean;
  auto_on_generate: boolean;
  from_stems: boolean;
}

export interface IdleSettings {
  min_idle_seconds: number;
  respect_vram_pressure: boolean;
}

export interface VjSettings {
  /** Root folder for VJ recording exports. Relative paths resolve
   *  against the backend project root; absolute paths are used as-is.
   *  Each take also lands in a per-export subfolder named in the VJ bar. */
  export_root: string;
}

export interface AppSettings {
  /** How theDAW opens on the next launch: 'web' (browser) | 'desktop' (Electron).
   *  Read by theDAW.bat before it starts anything. */
  launch_mode: string;
}

export interface NotationSettings {
  /** Global artist/composer name, stamped on every generated sheet + appended
   *  to song titles. Defaults to GANTASMO. */
  artist: string;
}

export interface FeatureSettings {
  schema_version: number;
  app: AppSettings;
  analysis: AnalysisSettings;
  stems: StemsSettings;
  midi: MidiSettings;
  idle: IdleSettings;
  vj: VjSettings;
  notation: NotationSettings;
}

export const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
  schema_version: 7,
  app: {
    launch_mode: 'web',
  },
  analysis: {
    auto_on_import: true,
    auto_on_generate: true,
    include_genre: false,
    include_key: true,
  },
  stems: {
    auto_on_import: true,
    auto_on_generate: true,
    default_count: 4,
    device: 'cuda',
    quality: 'balanced',
  },
  midi: {
    auto_on_import: false,
    auto_on_generate: false,
    from_stems: true,
  },
  idle: {
    min_idle_seconds: 30,
    respect_vram_pressure: true,
  },
  vj: {
    export_root: 'exports/vj',
  },
  notation: {
    artist: 'GANTASMO',
  },
};

interface FeatureToggleState {
  settings: FeatureSettings;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  patch: (partial: DeepPartial<FeatureSettings>) => Promise<void>;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function mergeSettings(base: FeatureSettings, patch: DeepPartial<FeatureSettings>): FeatureSettings {
  const next: FeatureSettings = {
    ...base,
    app: { ...DEFAULT_FEATURE_SETTINGS.app, ...(base.app ?? {}), ...(patch.app ?? {}) },
    analysis: { ...base.analysis, ...(patch.analysis ?? {}) },
    stems: { ...base.stems, ...(patch.stems ?? {}) },
    midi: { ...base.midi, ...(patch.midi ?? {}) },
    idle: { ...base.idle, ...(patch.idle ?? {}) },
    vj: { ...base.vj, ...(patch.vj ?? {}) },
    notation: { ...DEFAULT_FEATURE_SETTINGS.notation, ...(base.notation ?? {}), ...(patch.notation ?? {}) },
  };
  if (patch.schema_version != null) next.schema_version = patch.schema_version;
  return next;
}

export const useFeatureToggleStore = create<FeatureToggleState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_FEATURE_SETTINGS,
      loaded: false,
      loading: false,
      error: null,

      refresh: async () => {
        if (get().loading) return;
        set({ loading: true, error: null });
        try {
          const res = await fetch('/api/settings');
          if (!res.ok) throw new Error(`GET /api/settings → ${res.status}`);
          const payload = (await res.json()) as FeatureSettings;
          set({
            settings: mergeSettings(DEFAULT_FEATURE_SETTINGS, payload),
            loaded: true,
            loading: false,
          });
        } catch (e) {
          set({ loading: false, error: e instanceof Error ? e.message : String(e) });
        }
      },

      patch: async (partial) => {
        const optimistic = mergeSettings(get().settings, partial);
        set({ settings: optimistic });
        try {
          const res = await fetch('/api/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(partial),
          });
          if (!res.ok) throw new Error(`PATCH /api/settings → ${res.status}`);
          const payload = (await res.json()) as FeatureSettings;
          set({ settings: mergeSettings(DEFAULT_FEATURE_SETTINGS, payload), loaded: true });
        } catch (e) {
          set({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
    {
      name: 'thedaw-feature-settings',
      partialize: (s) => ({ settings: s.settings }),
    },
  ),
);
