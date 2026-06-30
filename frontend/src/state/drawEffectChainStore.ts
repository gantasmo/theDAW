/**
 * drawEffectChainStore — the DRAW tab's global insert-effect chain.
 *
 * Same ChainEntry shape and mutators as the MIX effect chain, but its own
 * persisted list so the DRAW rack is independent of the EDIT/MIX rack. The chain
 * is built live by drawEngine via buildEffectChain (rackEffects), so every entry
 * is one of the pure Web-Audio RACK_EFFECTS and runs in real time on the drawn
 * audio (the offline Studio modules are surfaced separately in the panel).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uuid } from '../orb-kit/utils';
import { rackEffectDefaults } from '../lib/rackEffects';
import type { ChainEntry } from './effectChainStore';

interface DrawFxState {
  chain: ChainEntry[];
  addEffect: (effect: string) => void;
  removeEffect: (id: string) => void;
  updateParams: (id: string, params: Record<string, number>) => void;
  toggleEnabled: (id: string) => void;
  reorder: (from: number, to: number) => void;
  clearChain: () => void;
}

export const useDrawFxStore = create<DrawFxState>()(
  persist(
    (set) => ({
      chain: [],
      addEffect: (effect) =>
        set((s) => ({
          chain: [...s.chain, { id: uuid(), effect, params: { ...rackEffectDefaults(effect) }, enabled: true }],
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
      name: 'thedaw-draw-fx-chain',
      partialize: (s) => ({ chain: s.chain }),
    },
  ),
);
