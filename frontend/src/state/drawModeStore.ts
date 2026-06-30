/**
 * drawModeStore — the DRAW tab's per-stroke "mode" slots.
 *
 * Each slot holds one effect id and is fully reassignable, so the numbered mode
 * buttons can be set to whatever effect the user wants. Persisted so a custom
 * mode layout survives reloads. The engine reads the slots via setModeSlots.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_MODE_SLOTS } from '../lib/drawEngine';

interface DrawModeState {
  slots: string[];
  setSlot: (index: number, effect: string) => void;
  reset: () => void;
}

export const useDrawModeStore = create<DrawModeState>()(
  persist(
    (set) => ({
      slots: DEFAULT_MODE_SLOTS.slice(),
      setSlot: (index, effect) =>
        set((s) => {
          const next = s.slots.slice();
          if (index >= 0 && index < next.length) next[index] = effect;
          return { slots: next };
        }),
      reset: () => set({ slots: DEFAULT_MODE_SLOTS.slice() }),
    }),
    {
      name: 'thedaw-draw-modes',
      version: 1,
      partialize: (s) => ({ slots: s.slots }),
      // v0 persisted 12 slots; reset to the 8-slot default on upgrade.
      migrate: (state, version) =>
        version < 1 ? { slots: DEFAULT_MODE_SLOTS.slice() } : (state as DrawModeState),
    },
  ),
);
