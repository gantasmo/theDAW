/**
 * PERFORM's right rail — UI state (persisted) plus the bridge that lets the
 * rail push effect-parameter edits into DawSessionGrid's LIVE per-track
 * chains without owning them.
 *
 * The grid registers a push function on mount (it holds the lazily-built
 * ChainHandles); the rail calls pushPerformDeviceParams with the same
 * track/device indexing the CC routes use (`perform-{track}-{device}` entry
 * ids), so a rail edit and a hardware knob land on the same live instance —
 * and chain instances keep sticky param state, so single-key pushes merge.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './persistStorage';
import type { DawDevice, DawTrack } from '../lib/dawImportClient';
import { addPerformDevice } from '../lib/performModel';

export type PerformRailTab = 'routes' | 'params';

interface PerformRailState {
  open: boolean;
  width: number;
  tab: PerformRailTab;
  /** Session-only: the device whose params the PARAMS tab edits. */
  selTrack: number | null;
  selDevice: number | null;
  /** Session-only: counts the changes made to a track's device list (an effect
   *  or a plugin put in a slot, a slot bypassed). The list lives ON the
   *  project's track object, which is what a save writes, so a change to it is
   *  nothing React can see and the views that list devices read this. */
  devicesVersion: number;
  bumpDevices: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (w: number) => void;
  setTab: (tab: PerformRailTab) => void;
  select: (trackIndex: number | null, deviceIndex: number | null) => void;
}

export const usePerformRailStore = create<PerformRailState>()(
  persist(
    (set) => ({
      // DEFAULT CLOSED (user mandate) — the rail opens only when asked.
      open: false,
      width: 264,
      tab: 'routes',
      selTrack: null,
      selDevice: null,
      devicesVersion: 0,
      bumpDevices: () => set((s) => ({ devicesVersion: s.devicesVersion + 1 })),
      setOpen: (open) => set({ open }),
      setWidth: (w) => set({ width: Math.round(Math.max(208, Math.min(440, w))) }),
      setTab: (tab) => set({ tab }),
      select: (selTrack, selDevice) => set({ selTrack, selDevice, tab: 'params' }),
    }),
    {
      name: 'thedaw-perform-rail-v1',
      storage: persistStorage(),
      // v2 forces the closed default once onto profiles that briefly stored
      // the v1 open-by-default state; explicit choices persist from then on.
      version: 2,
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Partial<PerformRailState>;
        return { ...p, open: false } as PerformRailState;
      },
      partialize: (s) => ({ open: s.open, width: s.width, tab: s.tab }),
    },
  ),
);

/* ── live-chain bridge ───────────────────────────────────────────────────── */

type ChainPush = (trackIndex: number, deviceIndex: number, params: Record<string, number>) => void;

let chainPush: ChainPush | null = null;

/** DawSessionGrid registers its live-chain writer here (null on unmount). */
export const registerPerformChainPush = (fn: ChainPush | null): void => {
  chainPush = fn;
};

/** Push param values onto a track device's RUNNING chain instance (no-op when
 *  the grid is not mounted). */
export const pushPerformDeviceParams: ChainPush = (trackIndex, deviceIndex, params) => {
  chainPush?.(trackIndex, deviceIndex, params);
};

type ChainSync = (trackIndex: number) => void;

let chainSync: ChainSync | null = null;

/** DawSessionGrid registers the function that re-wires one column's live chain
 *  to its track's current device list (null on unmount). */
export const registerPerformChainSync = (fn: ChainSync | null): void => {
  chainSync = fn;
};

/** Build a column's live chain if it has none yet, and re-wire it to the
 *  track's current devices: a device just put in a slot starts processing, a
 *  hosted plugin's host starts, a bypassed one is routed around. A no-op when
 *  the grid is not mounted. */
export const syncPerformTrackChain: ChainSync = (trackIndex) => {
  chainSync?.(trackIndex);
};

/** Put `device` in a track's chain and start it: the device joins the track's
 *  own list (what a save writes), the column's live chain is re-wired, and the
 *  views that list devices are told. Returns the device's chain index. */
export function putPerformDevice(trackIndex: number, track: DawTrack, device: DawDevice): number {
  const deviceIndex = addPerformDevice(track, device);
  syncPerformTrackChain(trackIndex);
  usePerformRailStore.getState().bumpDevices();
  return deviceIndex;
}
