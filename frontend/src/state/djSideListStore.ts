import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* DJ side list (D7) — an ephemeral "prepare / play-next" staging queue, distinct
 * from the persisted named Setlists. The DJ drags tracks here from the browser
 * while a set is playing, reorders them into the order they want to hear them,
 * then fires each onto a deck (→A/→B) or pushes the whole queue into the active
 * Automix set. Only the library-entry id + a display label are stored (the
 * browser resolves BPM/key/art live), so a staged queue survives a reload and
 * silently drops tracks that no longer exist in the library. */

export interface SideListItem {
  entryId: string;
  label: string;
}

interface DjSideListState {
  items: SideListItem[];
  /** Append a track to the end of the queue; no-ops if already staged. */
  add: (item: SideListItem) => void;
  /** Replace the queue order atomically. */
  setItems: (items: SideListItem[]) => void;
  /** Remove a staged track by entry id. */
  remove: (entryId: string) => void;
  /** Move the item at `from` to index `to` (clamped). */
  reorder: (from: number, to: number) => void;
  /** Empty the queue. */
  clear: () => void;
}

export const useDjSideList = create<DjSideListState>()(
  persist(
    (set) => ({
      items: [],
      add: (item) => set((s) => (
        s.items.some((it) => it.entryId === item.entryId)
          ? s
          : { items: [...s.items, item] }
      )),
      setItems: (items) => set({ items }),
      remove: (entryId) => set((s) => ({ items: s.items.filter((it) => it.entryId !== entryId) })),
      reorder: (from, to) => set((s) => {
        if (to < 0 || to >= s.items.length || from === to) return s;
        const arr = [...s.items];
        const [it] = arr.splice(from, 1);
        arr.splice(to, 0, it);
        return { items: arr };
      }),
      clear: () => set({ items: [] }),
    }),
    { name: 'thedaw.dj.sidelist.v1' },
  ),
);
