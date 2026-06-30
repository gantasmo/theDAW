import { type NoteEvent, type KeyDetectionResult, ScaleType } from './types';
import { SCALES } from './constants';

/**
 * Analyzes a set of notes to determine the most likely Key (Root + Scale).
 * Uses a weighted histogram approach based on note duration.
 */
export const detectKeyAndScale = (notes: NoteEvent[]): KeyDetectionResult => {
  if (!notes.length) {
    return { root: 0, scale: ScaleType.CHROMATIC, confidence: 0 };
  }

  // 1. Build a Pitch Class Histogram (weighted by duration)
  // We care more about long sustained notes than passing grace notes.
  const chromaProfile = new Array(12).fill(0);
  let totalDuration = 0;

  notes.forEach(note => {
    const pitchClass = note.midiNote % 12;
    chromaProfile[pitchClass] += note.duration;
    totalDuration += note.duration;
  });

  // Normalize
  if (totalDuration > 0) {
    for (let i = 0; i < 12; i++) chromaProfile[i] /= totalDuration;
  }

  // 2. Score against Scale Templates
  // We primarily check Major and Minor as they are the most common tonal centers.
  let bestRoot = 0;
  let bestScale = ScaleType.MAJOR;
  let maxScore = -1;

  // We only check Major and Minor for auto-detection logic to keep it robust
  const templates = [
    { type: ScaleType.MAJOR, intervals: SCALES.Major },
    { type: ScaleType.MINOR, intervals: SCALES.Minor }
  ];

  for (let root = 0; root < 12; root++) {
    for (const template of templates) {
      let score = 0;

      // Sum the chroma weights for all notes that fit in this scale
      for (const interval of template.intervals) {
        const pitchClass = (root + interval) % 12;
        score += chromaProfile[pitchClass];
      }

      // Basic heuristic: penalize scales that miss high-weight notes
      // (This assumes the user played *mostly* inside the key)
      if (score > maxScore) {
        maxScore = score;
        bestRoot = root;
        bestScale = template.type;
      }
    }
  }

  return {
    root: bestRoot,
    scale: bestScale,
    confidence: maxScore // 0 to 1
  };
};

export interface RelatedKey {
  root: number; // 0-11 pitch class
  midiNote: number; // 60-71 for dropdown
  scale: ScaleType;
  relationship: string;
  priority: number; // 1 = highest priority (closest relationship)
}

/**
 * Gets harmonically related keys based on music theory relationships.
 * Returns keys sorted by harmonic closeness.
 *
 * @param rootNote - Current root (MIDI note, e.g. 60 for C4)
 * @param scale - Current scale type
 */
export const getRelatedKeys = (rootNote: number, scale: ScaleType): RelatedKey[] => {
  const root = rootNote % 12; // Get pitch class (0-11)
  const results: RelatedKey[] = [];

  if (scale === ScaleType.MAJOR) {
    // Relative Minor (same key signature) - 3 semitones down
    const relMinor = (root + 9) % 12;
    results.push({
      root: relMinor,
      midiNote: relMinor + 60,
      scale: ScaleType.MINOR,
      relationship: 'Relative Minor',
      priority: 1
    });

    // Parallel Minor (same root)
    results.push({
      root,
      midiNote: root + 60,
      scale: ScaleType.MINOR,
      relationship: 'Parallel Minor',
      priority: 2
    });

    // Dominant (V) - 7 semitones up / perfect 5th
    const dominant = (root + 7) % 12;
    results.push({
      root: dominant,
      midiNote: dominant + 60,
      scale: ScaleType.MAJOR,
      relationship: 'Dominant (V)',
      priority: 3
    });

    // Subdominant (IV) - 5 semitones up / perfect 4th
    const subdominant = (root + 5) % 12;
    results.push({
      root: subdominant,
      midiNote: subdominant + 60,
      scale: ScaleType.MAJOR,
      relationship: 'Subdominant (IV)',
      priority: 3
    });

    // Relative of Dominant (ii)
    const relDom = (dominant + 9) % 12;
    results.push({
      root: relDom,
      midiNote: relDom + 60,
      scale: ScaleType.MINOR,
      relationship: 'ii (Dorian)',
      priority: 4
    });

    // Relative of Subdominant (vi already covered as relative minor)

  } else if (scale === ScaleType.MINOR) {
    // Relative Major (same key signature) - 3 semitones up
    const relMajor = (root + 3) % 12;
    results.push({
      root: relMajor,
      midiNote: relMajor + 60,
      scale: ScaleType.MAJOR,
      relationship: 'Relative Major',
      priority: 1
    });

    // Parallel Major (same root)
    results.push({
      root,
      midiNote: root + 60,
      scale: ScaleType.MAJOR,
      relationship: 'Parallel Major',
      priority: 2
    });

    // Minor Dominant (v) - natural minor's fifth
    const minorDom = (root + 7) % 12;
    results.push({
      root: minorDom,
      midiNote: minorDom + 60,
      scale: ScaleType.MINOR,
      relationship: 'v (Minor)',
      priority: 3
    });

    // Subdominant minor (iv)
    const subdominant = (root + 5) % 12;
    results.push({
      root: subdominant,
      midiNote: subdominant + 60,
      scale: ScaleType.MINOR,
      relationship: 'iv (Subdominant)',
      priority: 3
    });

    // VII (natural 7th) - common in EDM/metal
    const flatSeven = (root + 10) % 12;
    results.push({
      root: flatSeven,
      midiNote: flatSeven + 60,
      scale: ScaleType.MAJOR,
      relationship: 'bVII (Mixolydian feel)',
      priority: 4
    });

  } else if (scale === ScaleType.PENTATONIC) {
    // Pentatonic usually implies minor pentatonic
    // Relative major pent
    const relMajor = (root + 3) % 12;
    results.push({
      root: relMajor,
      midiNote: relMajor + 60,
      scale: ScaleType.PENTATONIC,
      relationship: 'Relative Pent (Major feel)',
      priority: 1
    });

    // Up a 4th (common blues move)
    const fourth = (root + 5) % 12;
    results.push({
      root: fourth,
      midiNote: fourth + 60,
      scale: ScaleType.PENTATONIC,
      relationship: 'IV Pentatonic',
      priority: 2
    });

    // Up a 5th
    const fifth = (root + 7) % 12;
    results.push({
      root: fifth,
      midiNote: fifth + 60,
      scale: ScaleType.PENTATONIC,
      relationship: 'V Pentatonic',
      priority: 2
    });

    // Natural minor (same notes, different feel)
    results.push({
      root,
      midiNote: root + 60,
      scale: ScaleType.MINOR,
      relationship: 'Full Minor Scale',
      priority: 3
    });
  }

  // Sort by priority
  return results.sort((a, b) => a.priority - b.priority);
};
