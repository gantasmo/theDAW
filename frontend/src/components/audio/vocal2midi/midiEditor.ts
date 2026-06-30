/**
 * MIDI Editor Utilities
 * Provides quantization, transposition, and grid snapping for the piano roll editor
 */

import { type NoteEvent, QuantizeValue, ScaleType } from './types';
import { SCALES } from './constants';

/**
 * Convert BPM and quantize value to seconds per grid unit
 */
export function getGridSize(bpm: number, quantize: QuantizeValue): number {
  if (quantize === QuantizeValue.OFF) return 0;
  const beatsPerSecond = bpm / 60;
  const secondsPerBeat = 1 / beatsPerSecond;
  return secondsPerBeat / (quantize / 4); // quantize is notes per bar (4, 8, 16, 32)
}

/**
 * Get beat positions for the grid visualization
 */
export function getBeatPositions(
  totalDuration: number,
  bpm: number,
  quantize: QuantizeValue = QuantizeValue.Q_1_4
): { time: number; isMajor: boolean; label: string }[] {
  const positions: { time: number; isMajor: boolean; label: string }[] = [];
  const secondsPerBeat = 60 / bpm;
  const gridSize = getGridSize(bpm, quantize);

  if (gridSize === 0) {
    // Just show beats when quantize is off
    for (let beat = 0; beat * secondsPerBeat <= totalDuration + 0.5; beat++) {
      const time = beat * secondsPerBeat;
      const isMajor = beat % 4 === 0; // Every bar (4 beats)
      const bar = Math.floor(beat / 4) + 1;
      const beatInBar = (beat % 4) + 1;
      positions.push({
        time,
        isMajor,
        label: isMajor ? `${bar}` : `${bar}.${beatInBar}`
      });
    }
  } else {
    // Show grid divisions
    const stepsPerBeat = (quantize / 4);
    for (let step = 0; step * gridSize <= totalDuration + 0.5; step++) {
      const time = step * gridSize;
      const beat = Math.floor(step / stepsPerBeat);
      const isMajor = step % (stepsPerBeat * 4) === 0; // Every bar
      const isOnBeat = step % stepsPerBeat === 0;
      const bar = Math.floor(beat / 4) + 1;
      const beatInBar = (beat % 4) + 1;
      positions.push({
        time,
        isMajor,
        label: isOnBeat ? (isMajor ? `${bar}` : `${bar}.${beatInBar}`) : ''
      });
    }
  }

  return positions;
}

/**
 * Snap a time value to the nearest grid position
 */
export function snapToGrid(time: number, bpm: number, quantize: QuantizeValue): number {
  const gridSize = getGridSize(bpm, quantize);
  if (gridSize === 0) return time;
  return Math.round(time / gridSize) * gridSize;
}

/**
 * Quantize all notes to the grid
 */
export function quantizeNotes(
  notes: NoteEvent[],
  bpm: number,
  quantize: QuantizeValue
): NoteEvent[] {
  if (quantize === QuantizeValue.OFF) return notes;

  const gridSize = getGridSize(bpm, quantize);

  return notes.map(note => ({
    ...note,
    startTime: Math.round(note.startTime / gridSize) * gridSize,
    duration: Math.max(gridSize, Math.round(note.duration / gridSize) * gridSize)
  }));
}

/**
 * Transpose notes by semitones
 */
export function transposeNotes(notes: NoteEvent[], semitones: number): NoteEvent[] {
  return notes.map(note => ({
    ...note,
    midiNote: Math.max(0, Math.min(127, note.midiNote + semitones))
  }));
}

/**
 * Snap notes to a specific scale
 */
export function snapNotesToScale(
  notes: NoteEvent[],
  rootNote: number,
  scale: ScaleType
): NoteEvent[] {
  const scaleNotes = SCALES[scale];
  const root = rootNote % 12;

  return notes.map(note => {
    const noteClass = note.midiNote % 12;
    const octave = Math.floor(note.midiNote / 12);

    // Find the closest scale note
    let minDistance = 12;
    let closestScaleNote = noteClass;

    for (const interval of scaleNotes) {
      const scaleNoteClass = (root + interval) % 12;
      const distance = Math.min(
        Math.abs(noteClass - scaleNoteClass),
        12 - Math.abs(noteClass - scaleNoteClass)
      );
      if (distance < minDistance) {
        minDistance = distance;
        closestScaleNote = scaleNoteClass;
      }
    }

    // Calculate the new MIDI note
    let newMidiNote = octave * 12 + closestScaleNote;

    // Handle octave boundary
    if (closestScaleNote < noteClass && noteClass - closestScaleNote > 6) {
      newMidiNote += 12;
    } else if (closestScaleNote > noteClass && closestScaleNote - noteClass > 6) {
      newMidiNote -= 12;
    }

    return {
      ...note,
      midiNote: Math.max(0, Math.min(127, newMidiNote))
    };
  });
}

/**
 * Change key (transpose to new root while maintaining scale relationships)
 */
export function changeKey(
  notes: NoteEvent[],
  fromRoot: number,
  toRoot: number
): NoteEvent[] {
  const semitones = (toRoot % 12) - (fromRoot % 12);
  return transposeNotes(notes, semitones);
}

/**
 * Move a single note
 */
export function moveNote(
  notes: NoteEvent[],
  noteIndex: number,
  newStartTime: number,
  newMidiNote: number,
  bpm: number,
  quantize: QuantizeValue
): NoteEvent[] {
  const result = [...notes];
  const snappedTime = snapToGrid(Math.max(0, newStartTime), bpm, quantize);
  const clampedNote = Math.max(0, Math.min(127, newMidiNote));

  result[noteIndex] = {
    ...result[noteIndex],
    startTime: snappedTime,
    midiNote: clampedNote
  };

  return result;
}

/**
 * Resize a note's duration
 */
export function resizeNote(
  notes: NoteEvent[],
  noteIndex: number,
  newDuration: number,
  bpm: number,
  quantize: QuantizeValue
): NoteEvent[] {
  const result = [...notes];
  const gridSize = getGridSize(bpm, quantize);
  const minDuration = gridSize > 0 ? gridSize : 0.05;
  const snappedDuration = gridSize > 0
    ? Math.max(minDuration, Math.round(newDuration / gridSize) * gridSize)
    : Math.max(minDuration, newDuration);

  result[noteIndex] = {
    ...result[noteIndex],
    duration: snappedDuration
  };

  return result;
}

/**
 * Delete a note
 */
export function deleteNote(notes: NoteEvent[], noteIndex: number): NoteEvent[] {
  return notes.filter((_, i) => i !== noteIndex);
}

/**
 * Add a new note
 */
export function addNote(
  notes: NoteEvent[],
  startTime: number,
  midiNote: number,
  duration: number,
  velocity: number,
  bpm: number,
  quantize: QuantizeValue
): NoteEvent[] {
  const gridSize = getGridSize(bpm, quantize);
  const snappedTime = snapToGrid(startTime, bpm, quantize);
  const snappedDuration = gridSize > 0
    ? Math.max(gridSize, Math.round(duration / gridSize) * gridSize)
    : Math.max(0.1, duration);

  return [
    ...notes,
    {
      midiNote: Math.max(0, Math.min(127, midiNote)),
      startTime: snappedTime,
      duration: snappedDuration,
      velocity: Math.max(1, Math.min(127, velocity))
    }
  ].sort((a, b) => a.startTime - b.startTime);
}

/**
 * Get scale name from root and scale type
 */
export function getKeyName(rootNote: number, scale: ScaleType): string {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${noteNames[rootNote % 12]} ${scale}`;
}

/**
 * Parse key string to root and scale
 */
export function parseKeyString(keyString: string): { root: number; scale: ScaleType } | null {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const parts = keyString.split(' ');
  if (parts.length < 2) return null;

  const noteName = parts[0];
  const scaleName = parts.slice(1).join(' ') as ScaleType;

  const rootIndex = noteNames.indexOf(noteName);
  if (rootIndex === -1) return null;

  if (!Object.values(ScaleType).includes(scaleName)) return null;

  return { root: rootIndex + 60, scale: scaleName };
}
