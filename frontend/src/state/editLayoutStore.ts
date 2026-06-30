import { create } from 'zustand';

/**
 * Global "Edit Layout" toggle. The single source of truth for whether the app
 * is in layout-design mode. The top-header button toggles it; each mounted
 * ControlSurface mirrors it one-way into its own (session-only) designMode, and
 * the in-surface Done button / Esc clear it. Centralizing the entry point lets
 * one header button drive layout editing across every surface (DJ, MIX, TRAIN,
 * and any future ones) instead of a per-surface floating button.
 */
interface EditLayoutState {
  active: boolean;
  setActive: (v: boolean) => void;
  toggle: () => void;
}

export const useEditLayoutStore = create<EditLayoutState>((set) => ({
  active: false,
  setActive: (v) => set({ active: v }),
  toggle: () => set((s) => ({ active: !s.active })),
}));
