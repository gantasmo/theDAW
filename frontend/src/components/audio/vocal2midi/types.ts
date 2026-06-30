export interface NoteEvent {
  midiNote: number;
  startTime: number; // in seconds
  duration: number; // in seconds
  velocity: number; // 0-127
}

export interface AudioAnalysisResult {
  detectedBpm: number;
  timeSignature: string;
  suggestedInstrument: string;
  description: string;
  detectedProfileId?: string; // ID from our predefined library
  detectedNotes?: NoteEvent[]; // MIDI notes detected by Gemini from the audio
}

export enum QuantizeValue {
  OFF = 0,
  Q_1_4 = 4,
  Q_1_8 = 8,
  Q_1_16 = 16,
  Q_1_32 = 32
}

export type QuantizeMode = 'AUTO' | 'MANUAL';

export enum ScaleType {
  CHROMATIC = 'Chromatic',
  MAJOR = 'Major',
  MINOR = 'Minor',
  PENTATONIC = 'Pentatonic'
}

export enum Genre {
  NONE = 'None',
  DUBSTEP = 'Dubstep',
  HOUSE = 'House',
  TECHNO = 'Techno',
  DRUM_AND_BASS = 'Drum & Bass',
  TRANCE = 'Trance',
  AMBIENT = 'Ambient',
  HIPHOP = 'Hip-Hop',
  TRAP = 'Trap',
  POP = 'Pop',
  ROCK = 'Rock'
}

export interface ProcessingConfig {
  rootNote: number; // MIDI note number (e.g., 60 for C4)
  scale: ScaleType;
  genre: Genre; // Genre affects MIDI structure (note lengths, quantization, velocity)
  quantizeMode: QuantizeMode; // New explicit mode
  manualQuantizeValue: QuantizeValue; // Value used when in Manual mode
  useGeminiForBpm: boolean; // If false, uses manualBpm instead of AI detection
  manualBpm: number; // BPM to use when useGeminiForBpm is false
  prompt: string;
  autoKeyDetection: boolean; // New toggle
  activeProfileId: string; // New: selected sound profile
  sensitivity: number; // 0-100
  // EXPERIMENTAL: Pitch bend export for slides/glides
  experimentalPitchBend: boolean;
  // Toggle for note cleanup (filters short notes, merges fragments)
  enableCleanup: boolean;
}

// Genre-specific MIDI processing hints for Gemini and processing
export interface GenreProfile {
  id: Genre;
  name: string;
  description: string;
  suggestedQuantization: QuantizeValue;
  suggestedProfileId: string; // Links to SoundProfile
  midiHints: {
    noteLengthBias: 'short' | 'medium' | 'long' | 'varied';
    quantizeTightness: 'tight' | 'medium' | 'loose' | 'free';
    velocityStyle: 'punchy' | 'consistent' | 'dynamic' | 'soft';
    typicalBpmRange: [number, number];
    commonScales: ScaleType[];
  };
  geminiPromptHint: string; // Extra context for Gemini
}

export interface KeyDetectionResult {
  root: number; // 0-11 (C-B)
  scale: ScaleType;
  confidence: number;
}

// Recording history entry
export interface RecordingEntry {
  id: string;
  timestamp: number;
  name: string;
  notes: NoteEvent[];
  bpm: number;
  rootNote: number;
  scale: ScaleType;
  genre: Genre;
  profileId: string;
}

export interface SoundProfile {
  id: string;
  name: string;
  description: string;
  suggestedQuantization: QuantizeValue; // New: Auto-quantize setting
  transformation: {
    velocityCurve: 'fixed-high' | 'dynamic' | 'soft';
    durationMode: 'gated' | 'legato' | 'natural';
    minDuration?: number;
    quantizeStrength: number; // 0-1
    baseVelocity: number;
    // MIDI Control Changes (0-127) to shape the synth sound
    midiCC?: {
      attack?: number;  // CC 73
      release?: number; // CC 72
      brightness?: number; // CC 74 (Cutoff)
      reverb?: number; // CC 91
    };
  };
}
