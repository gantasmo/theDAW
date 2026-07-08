/**
 * djCuesStore — persistent hotcues per library track, for the DJ decks.
 *
 * A hotcue is just a saved position (seconds) on a track; the DJ deck seeks to
 * it sample-accurately via djEngine. We keep this separate from the engine so
 * the cues survive reloads and render reactively as pad state, while the engine
 * stays a stateless transport. Keyed by library entry id; HOTCUE_SLOTS pads per
 * track (VirtualDJ-style).
 *
 * Persisted in localStorage under 'thedaw.djcues.v1'.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const HOTCUE_SLOTS = 8;

/** Each track maps to a fixed-length array of cue positions (sec) or null. */
type CueArray = (number | null)[];

interface DjCuesState {
  byEntry: Record<string, CueArray>;
  /** Read a track's cues (always returns a HOTCUE_SLOTS-length array). */
  cuesFor: (entryId: string | null) => CueArray;
  /** Store a cue position at a slot. */
  setCue: (entryId: string, index: number, sec: number) => void;
  /** Clear a single cue slot. */
  clearCue: (entryId: string, index: number) => void;
  /** Clear all cues for a track. */
  clearAll: (entryId: string) => void;
}

const empty = (): CueArray => Array<number | null>(HOTCUE_SLOTS).fill(null);

function normalize(arr: CueArray | undefined): CueArray {
  const out = empty();
  if (arr) for (let i = 0; i < HOTCUE_SLOTS; i++) out[i] = arr[i] ?? null;
  return out;
}

export const useDjCuesStore = create<DjCuesState>()(
  persist(
    (set, get) => ({
      byEntry: {},
      cuesFor: (entryId) => (entryId ? normalize(get().byEntry[entryId]) : empty()),
      setCue: (entryId, index, sec) => set((s) => {
        if (index < 0 || index >= HOTCUE_SLOTS || !Number.isFinite(sec)) return s;
        const cur = normalize(s.byEntry[entryId]);
        cur[index] = Math.max(0, sec);
        return { byEntry: { ...s.byEntry, [entryId]: cur } };
      }),
      clearCue: (entryId, index) => set((s) => {
        if (index < 0 || index >= HOTCUE_SLOTS) return s;
        const cur = normalize(s.byEntry[entryId]);
        cur[index] = null;
        return { byEntry: { ...s.byEntry, [entryId]: cur } };
      }),
      clearAll: (entryId) => set((s) => {
        if (!(entryId in s.byEntry)) return s;
        const { [entryId]: _drop, ...rest } = s.byEntry;
        return { byEntry: rest };
      }),
    }),
    { name: 'thedaw.djcues.v1' },
  ),
);
