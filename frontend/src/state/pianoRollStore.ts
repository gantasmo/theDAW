import { create } from 'zustand';

export interface PianoNote {
  id: string;
  /** MIDI note number (0-127). 60 = middle C. */
  note: number;
  /** Step index where the note starts (16th notes from 0). */
  step: number;
  /** Length in steps. */
  length: number;
  velocity: number;
}

interface PianoRollState {
  notes: PianoNote[];
  bpm: number;
  /** Total grid length in 16th-note steps. */
  totalSteps: number;
  /** Lowest and highest MIDI note numbers in view (inclusive). */
  lowestNote: number;
  highestNote: number;
  selectedNoteId: string | null;
  isPlaying: boolean;
  currentStep: number;
  /** If set, the roll is editing an existing editor clip — next "send to editor" updates that clip in place. */
  editingClipId: string | null;
  /** Step span of the most recent live recording, highlighted in the grid; null
   *  when no recording has been placed. */
  recordedRange: { startStep: number; endStep: number } | null;

  setBpm: (bpm: number) => void;
  setTotalSteps: (s: number) => void;
  setRange: (lo: number, hi: number) => void;
  addNote: (note: Omit<PianoNote, 'id'>) => string;
  removeNote: (id: string) => void;
  updateNote: (id: string, patch: Partial<PianoNote>) => void;
  setSelectedNote: (id: string | null) => void;
  setPlaying: (playing: boolean) => void;
  setCurrentStep: (s: number) => void;
  replaceAll: (notes: PianoNote[]) => void;
  clear: () => void;
  setEditingClip: (id: string | null) => void;
  loadFromClip: (clipId: string, notes: PianoNote[], bpm: number, totalSteps: number) => void;
  /** Replace the grid with imported notes, auto-fitting length AND pitch range
   *  to the content (so a full-song / out-of-range import is fully visible). */
  importNotes: (notes: PianoNote[], bpm?: number) => void;
  /** Place a live recording WITHOUT shrinking the grid (keeps at least the 256
   *  default), expanding the pitch range to fit, and marks the recorded span. */
  placeRecording: (notes: PianoNote[], range: { startStep: number; endStep: number }) => void;
}

const DEFAULT_STEPS = 256;

const MIN_STEPS = 16;
const MAX_STEPS = 4096; // ~256 bars; enough for full-song MIDI imports
const FULL_LOW = 21; // A0 — the full 88-key piano stays in view so the roll scrolls
const FULL_HIGH = 108; // C8

/** Fit grid LENGTH (snapped up to a bar) to a note set, and keep the full piano
 *  range in view (expanded if content goes beyond it) so vertical scrolling
 *  always works and notes are never cropped. */
const fitToNotes = (notes: PianoNote[]): { totalSteps: number; lowestNote: number; highestNote: number } => {
  const lastStep = notes.reduce((m, n) => Math.max(m, n.step + Math.max(1, n.length)), 0);
  const totalSteps = Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.ceil(lastStep / 16) * 16));
  const lo = Math.max(0, Math.min(FULL_LOW, notes.reduce((m, n) => Math.min(m, n.note), 127) - 2));
  const hi = Math.min(127, Math.max(FULL_HIGH, notes.reduce((m, n) => Math.max(m, n.note), 0) + 2));
  return { totalSteps, lowestNote: lo, highestNote: hi };
};

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `pn-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const seed = (): PianoNote[] => {
  // A short C-major arpeggio across two bars so the grid isn't empty on first load.
  const arr: PianoNote[] = [];
  const pitches = [60, 64, 67, 72, 67, 64, 60, 67]; // C E G C G E C G
  for (let i = 0; i < pitches.length; i += 1) {
    arr.push({ id: uid(), note: pitches[i], step: i * 2, length: 2, velocity: 90 });
  }
  return arr;
};

export const usePianoRollStore = create<PianoRollState>()((set) => ({
  notes: seed(),
  bpm: 120,
  totalSteps: DEFAULT_STEPS, // 16 bars at 16ths — a roomy default canvas
  lowestNote: FULL_LOW, // A0 — full piano in view, scrollable
  highestNote: FULL_HIGH, // C8
  selectedNoteId: null,
  isPlaying: false,
  currentStep: 0,
  editingClipId: null,
  recordedRange: null,

  setBpm: (bpm) => set({ bpm: Math.max(40, Math.min(240, bpm)) }),
  setTotalSteps: (totalSteps) => set({ totalSteps: Math.max(MIN_STEPS, Math.min(MAX_STEPS, totalSteps)) }),
  setRange: (lo, hi) => set({ lowestNote: Math.max(0, lo), highestNote: Math.min(127, hi) }),

  addNote: (note) => {
    const id = uid();
    set((s) => ({ notes: [...s.notes, { ...note, id }], selectedNoteId: id }));
    return id;
  },

  removeNote: (id) =>
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      selectedNoteId: s.selectedNoteId === id ? null : s.selectedNoteId,
    })),

  updateNote: (id, patch) =>
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })),

  setSelectedNote: (selectedNoteId) => set({ selectedNoteId }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentStep: (currentStep) => set({ currentStep }),
  replaceAll: (notes) => set({ notes, selectedNoteId: null }),
  clear: () => set({ notes: [], selectedNoteId: null, editingClipId: null, recordedRange: null }),

  setEditingClip: (editingClipId) => set({ editingClipId }),
  loadFromClip: (clipId, incoming, bpm, totalSteps) =>
    set(() => {
      const notes = incoming.map((n) => ({ ...n }));
      const fit = notes.length > 0 ? fitToNotes(notes) : null;
      return {
        notes,
        bpm: Math.max(40, Math.min(240, bpm)),
        totalSteps: Math.max(
          MIN_STEPS,
          Math.min(MAX_STEPS, Math.max(totalSteps, fit?.totalSteps ?? MIN_STEPS)),
        ),
        ...(fit ? { lowestNote: fit.lowestNote, highestNote: fit.highestNote } : {}),
        editingClipId: clipId,
        selectedNoteId: null,
        isPlaying: false,
        currentStep: 0,
        recordedRange: null,
      };
    }),

  importNotes: (incoming, bpm) =>
    set(() => {
      const notes = incoming.map((n) => ({ ...n }));
      if (notes.length === 0) {
        return { notes, selectedNoteId: null, currentStep: 0, isPlaying: false, recordedRange: null };
      }
      return {
        notes,
        ...fitToNotes(notes),
        selectedNoteId: null,
        currentStep: 0,
        isPlaying: false,
        recordedRange: null,
        ...(typeof bpm === 'number' && Number.isFinite(bpm)
          ? { bpm: Math.max(40, Math.min(240, Math.round(bpm))) }
          : {}),
      };
    }),

  placeRecording: (incoming, range) =>
    set((s) => {
      const notes = incoming.map((n) => ({ ...n }));
      // Keep at least the 256-step default — never shrink the grid for a short
      // take. Expand the pitch range to include the take (full keyboard stays).
      const lo = notes.length
        ? Math.max(0, Math.min(s.lowestNote, notes.reduce((m, n) => Math.min(m, n.note), 127) - 2))
        : s.lowestNote;
      const hi = notes.length
        ? Math.min(127, Math.max(s.highestNote, notes.reduce((m, n) => Math.max(m, n.note), 0) + 2))
        : s.highestNote;
      return {
        notes,
        totalSteps: Math.max(DEFAULT_STEPS, s.totalSteps),
        lowestNote: lo,
        highestNote: hi,
        recordedRange: range,
        selectedNoteId: null,
        currentStep: 0,
        isPlaying: false,
      };
    }),
}));

/** Convert the store's note list into the shared MIDI util's note format. */
export const pianoNotesToMidiNotes = (
  notes: PianoNote[],
  ppq: number,
): Array<{ tick: number; note: number; velocity: number; durationTicks: number; channel: number }> => {
  // 16th note = ppq / 4 ticks
  const stepTicks = ppq / 4;
  return notes.map((n) => ({
    tick: Math.round(n.step * stepTicks),
    note: n.note,
    velocity: Math.max(1, Math.min(127, n.velocity)),
    durationTicks: Math.max(1, Math.round(n.length * stepTicks)),
    channel: 0,
  }));
};

