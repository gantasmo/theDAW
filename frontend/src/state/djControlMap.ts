import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* DJ MIDI-learn (D6) — an ACTION-based control map (distinct from the SLIDE
 * surface's position-based controllerMapStore). Each DJ action (crossfader,
 * deck play/cue/sync, EQ, filter, volume, pitch, hotcues, headphone-cue) can be
 * bound to a MIDI CC or note. The dispatch loop lives in DJView (it has the
 * handlers); this store just holds the bindings + the learn arming. Bindings
 * persist; learn/map state is session-only. Input comes from the shared
 * `midiBus` (App publishes when MIDI is enabled). */

export type MidiKind = 'cc' | 'note';
export interface MidiSig {
  kind: MidiKind;
  number: number;
  channel: number | null; // 0-15; null = any channel (useful for reusable presets)
}

export const sigLabel = (s?: MidiSig | null): string =>
  s ? `${s.kind.toUpperCase()} ${s.number}${s.channel !== null ? ` ·${s.channel + 1}` : ''}` : '—';

interface DjControlMapState {
  bindings: Record<string, MidiSig>; // actionId → signature
  learnAction: string | null; // action currently waiting to capture a control
  mapMode: boolean; // the map panel is open
  setMapMode: (on: boolean) => void;
  arm: (actionId: string | null) => void;
  bind: (actionId: string, sig: MidiSig) => void;
  replaceAll: (bindings: Record<string, MidiSig>) => void;
  clear: (actionId: string) => void;
  clearAll: () => void;
}

export const useDjControlMap = create<DjControlMapState>()(
  persist(
    (set) => ({
      bindings: {},
      learnAction: null,
      mapMode: false,
      setMapMode: (on) => set(on ? { mapMode: true } : { mapMode: false, learnAction: null }),
      arm: (actionId) => set({ learnAction: actionId }),
      bind: (actionId, sig) => set((s) => ({ bindings: { ...s.bindings, [actionId]: sig }, learnAction: null })),
      replaceAll: (bindings) => set({ bindings, learnAction: null }),
      clear: (actionId) => set((s) => {
        const b = { ...s.bindings };
        delete b[actionId];
        return { bindings: b, learnAction: s.learnAction === actionId ? null : s.learnAction };
      }),
      clearAll: () => set({ bindings: {}, learnAction: null }),
    }),
    { name: 'thedaw.dj.midimap.v1', partialize: (s) => ({ bindings: s.bindings }) },
  ),
);
