/**
 * EDIT-timeline input and grid preferences (F05 wheel profile + zoom speeds,
 * F06 click profile, F08 grid style). View preferences only: they persist per
 * browser in localStorage and are never part of the project document or the
 * undo history.
 *
 * Grid visibility and snapping are independent — this store holds no snap
 * field; snapping stays wherever the editor already keeps it.
 *
 * Units: zoom speeds are the per-wheel-delta-unit exponent factors the
 * viewport math multiplies wheel deltas by (dimensionless); opacities are
 * alpha in [0, 1]; `barWidthPx` is the bar-line width in local CSS px.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './persistStorage';

/** Identical to `WheelProfileId` in lib/timeline/viewport.ts. */
export type WheelProfileId = 'thedaw' | 'reaper';
/** Identical to `ClickProfile` in lib/timeline/pointerGesture.ts. */
export type ClickProfile = 'default' | 'clip-seeks' | 'ruler-only';
export type GridPreset = 'subtle' | 'normal' | 'high-contrast' | 'custom';

export interface GridStyle {
  visible: boolean;
  /** Bar-line alpha, [0, 1]. */
  barOpacity: number;
  /** Beat-line alpha, [0, 1]. */
  beatOpacity: number;
  /** Subdivision-line alpha, [0, 1]. */
  subdivOpacity: number;
  /** Lane-divider alpha, [0, 1]. */
  laneDividerOpacity: number;
  /** Bar-line width in CSS px. */
  barWidthPx: 1 | 2;
}

type NamedPreset = Exclude<GridPreset, 'custom'>;

export const GRID_PRESETS: Readonly<Record<NamedPreset, Omit<GridStyle, 'visible'>>> = Object.freeze({
  subtle: Object.freeze({ barOpacity: 0.14, beatOpacity: 0.06, subdivOpacity: 0.025, laneDividerOpacity: 0.06, barWidthPx: 1 as const }),
  normal: Object.freeze({ barOpacity: 0.24, beatOpacity: 0.11, subdivOpacity: 0.045, laneDividerOpacity: 0.1, barWidthPx: 1 as const }),
  'high-contrast': Object.freeze({ barOpacity: 0.45, beatOpacity: 0.22, subdivOpacity: 0.1, laneDividerOpacity: 0.2, barWidthPx: 2 as const }),
});

export const FINE_ZOOM_SPEED_MIN = 0.0001;
export const FINE_ZOOM_SPEED_MAX = 0.003;
export const COARSE_ZOOM_SPEED_MIN = 0.0005;
export const COARSE_ZOOM_SPEED_MAX = 0.006;

const DEFAULT_WHEEL_PROFILE: WheelProfileId = 'thedaw';
const DEFAULT_FINE_ZOOM_SPEED = 0.0006;
const DEFAULT_COARSE_ZOOM_SPEED = 0.002;
const DEFAULT_CLICK_PROFILE: ClickProfile = 'default';
const DEFAULT_GRID_PRESET: GridPreset = 'normal';

const WHEEL_PROFILES: readonly WheelProfileId[] = ['thedaw', 'reaper'];
const CLICK_PROFILES: readonly ClickProfile[] = ['default', 'clip-seeks', 'ruler-only'];
const NAMED_PRESETS: readonly NamedPreset[] = ['subtle', 'normal', 'high-contrast'];
const ALL_PRESETS: readonly GridPreset[] = [...NAMED_PRESETS, 'custom'];

/** The style keys that are not `visible`; changing any of them makes the preset 'custom'. */
const STYLE_KEYS = ['barOpacity', 'beatOpacity', 'subdivOpacity', 'laneDividerOpacity', 'barWidthPx'] as const;
const OPACITY_KEYS = ['barOpacity', 'beatOpacity', 'subdivOpacity', 'laneDividerOpacity'] as const;

export interface TimelinePrefsState {
  wheelProfile: WheelProfileId;
  /** Fine (default) wheel-zoom speed, clamped to [FINE_ZOOM_SPEED_MIN, FINE_ZOOM_SPEED_MAX]. */
  fineZoomSpeed: number;
  /** Coarse wheel-zoom speed, clamped to [COARSE_ZOOM_SPEED_MIN, COARSE_ZOOM_SPEED_MAX]. */
  coarseZoomSpeed: number;
  clickProfile: ClickProfile;
  gridPreset: GridPreset;
  grid: GridStyle;
  /** Pinned master row visibility (view-only pref). */
  showMasterTrack: boolean;
  /** Volume line drawn over each track lane (view-only pref). */
  showVolumeLine: boolean;
  setWheelProfile(id: WheelProfileId): void;
  setFineZoomSpeed(v: number): void;
  setCoarseZoomSpeed(v: number): void;
  setClickProfile(p: ClickProfile): void;
  /** Copies the preset's style values; keeps `grid.visible`. */
  applyGridPreset(p: NamedPreset): void;
  /** Clamps opacities to [0, 1] and barWidthPx to 1 | 2; switches the preset to
   *  'custom' when a style value actually changes (`visible` alone does not). */
  setGrid(patch: Partial<GridStyle>): void;
  setGridVisible(v: boolean): void;
  setShowMasterTrack(v: boolean): void;
  setShowVolumeLine(v: boolean): void;
  /** Every field back to its default. */
  reset(): void;
}

type PrefsData = Pick<
  TimelinePrefsState,
  'wheelProfile' | 'fineZoomSpeed' | 'coarseZoomSpeed' | 'clickProfile' | 'gridPreset' | 'grid' | 'showMasterTrack'
  | 'showVolumeLine'
>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** Clamp a finite number to an opacity; undefined for anything else. */
const asOpacity = (v: unknown): number | undefined => (isFiniteNumber(v) ? clamp(v, 0, 1) : undefined);
/** Round and clamp a finite number to a bar width; undefined for anything else. */
const asBarWidth = (v: unknown): 1 | 2 | undefined =>
  isFiniteNumber(v) ? (Math.round(v) >= 2 ? 2 : 1) : undefined;

function defaultData(): PrefsData {
  return {
    wheelProfile: DEFAULT_WHEEL_PROFILE,
    fineZoomSpeed: DEFAULT_FINE_ZOOM_SPEED,
    coarseZoomSpeed: DEFAULT_COARSE_ZOOM_SPEED,
    clickProfile: DEFAULT_CLICK_PROFILE,
    gridPreset: DEFAULT_GRID_PRESET,
    grid: { visible: true, ...GRID_PRESETS.normal },
    showMasterTrack: true,
    showVolumeLine: true,
  };
}

/** Apply a grid patch onto `base`: each field is validated/clamped, invalid ones keep `base`. */
function patchGrid(base: GridStyle, patch: Record<string, unknown>): GridStyle {
  const next: GridStyle = { ...base };
  if (typeof patch.visible === 'boolean') next.visible = patch.visible;
  for (const k of OPACITY_KEYS) {
    const o = asOpacity(patch[k]);
    if (o !== undefined) next[k] = o;
  }
  const w = asBarWidth(patch.barWidthPx);
  if (w !== undefined) next.barWidthPx = w;
  return next;
}

/**
 * What a persisted blob becomes on hydrate (the store's `merge`) and on a
 * version change (its `migrate`). Every field is validated on its own; a wrong
 * type or unknown enum falls back to that field's default, numbers are clamped.
 * Exported because zustand's own hydrate cannot be driven from a node test.
 */
export function sanitizeTimelinePrefs<S extends PrefsData>(persisted: unknown, current: S): S {
  const d = defaultData();
  const p = isRecord(persisted) ? persisted : {};
  return {
    ...current,
    wheelProfile: oneOf(WHEEL_PROFILES, p.wheelProfile) ? p.wheelProfile : d.wheelProfile,
    fineZoomSpeed: isFiniteNumber(p.fineZoomSpeed)
      ? clamp(p.fineZoomSpeed, FINE_ZOOM_SPEED_MIN, FINE_ZOOM_SPEED_MAX)
      : d.fineZoomSpeed,
    coarseZoomSpeed: isFiniteNumber(p.coarseZoomSpeed)
      ? clamp(p.coarseZoomSpeed, COARSE_ZOOM_SPEED_MIN, COARSE_ZOOM_SPEED_MAX)
      : d.coarseZoomSpeed,
    clickProfile: oneOf(CLICK_PROFILES, p.clickProfile) ? p.clickProfile : d.clickProfile,
    gridPreset: oneOf(ALL_PRESETS, p.gridPreset) ? p.gridPreset : d.gridPreset,
    grid: patchGrid(d.grid, isRecord(p.grid) ? p.grid : {}),
    showMasterTrack: typeof p.showMasterTrack === 'boolean' ? p.showMasterTrack : d.showMasterTrack,
    showVolumeLine: typeof p.showVolumeLine === 'boolean' ? p.showVolumeLine : d.showVolumeLine,
  };
}

export const useTimelinePrefs = create<TimelinePrefsState>()(
  persist(
    (set) => ({
      ...defaultData(),
      setWheelProfile: (id) => {
        if (oneOf(WHEEL_PROFILES, id)) set({ wheelProfile: id });
      },
      setFineZoomSpeed: (v) => {
        if (isFiniteNumber(v)) set({ fineZoomSpeed: clamp(v, FINE_ZOOM_SPEED_MIN, FINE_ZOOM_SPEED_MAX) });
      },
      setCoarseZoomSpeed: (v) => {
        if (isFiniteNumber(v)) set({ coarseZoomSpeed: clamp(v, COARSE_ZOOM_SPEED_MIN, COARSE_ZOOM_SPEED_MAX) });
      },
      setClickProfile: (p) => {
        if (oneOf(CLICK_PROFILES, p)) set({ clickProfile: p });
      },
      applyGridPreset: (p) => {
        if (!oneOf(NAMED_PRESETS, p)) return;
        set((s) => ({ gridPreset: p, grid: { visible: s.grid.visible, ...GRID_PRESETS[p] } }));
      },
      setGrid: (patch) => {
        if (!isRecord(patch)) return;
        set((s) => {
          const grid = patchGrid(s.grid, patch);
          const styleChanged = STYLE_KEYS.some((k) => grid[k] !== s.grid[k]);
          return { grid, gridPreset: styleChanged ? 'custom' : s.gridPreset };
        });
      },
      setGridVisible: (v) => {
        if (typeof v === 'boolean') set((s) => ({ grid: { ...s.grid, visible: v } }));
      },
      setShowMasterTrack: (v) => {
        if (typeof v === 'boolean') set({ showMasterTrack: v });
      },
      setShowVolumeLine: (v) => {
        if (typeof v === 'boolean') set({ showVolumeLine: v });
      },
      reset: () => set(defaultData()),
    }),
    {
      name: 'thedaw.timelineprefs.v1',
      version: 1,
      storage: persistStorage(),
      partialize: (s): PrefsData => ({
        wheelProfile: s.wheelProfile,
        fineZoomSpeed: s.fineZoomSpeed,
        coarseZoomSpeed: s.coarseZoomSpeed,
        clickProfile: s.clickProfile,
        gridPreset: s.gridPreset,
        grid: s.grid,
        showMasterTrack: s.showMasterTrack,
        showVolumeLine: s.showVolumeLine,
      }),
      merge: (persisted, current) => sanitizeTimelinePrefs(persisted, current),
      migrate: (persisted) => sanitizeTimelinePrefs(persisted, defaultData()),
    },
  ),
);
