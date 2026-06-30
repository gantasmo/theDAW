import { type SoundProfile, QuantizeValue, Genre, type GenreProfile, ScaleType } from "./types";

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES: Record<string, number[]> = {
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10], // Natural Minor
  Pentatonic: [0, 3, 5, 7, 10] // Minor Pentatonic
};

// MIDI File Header Constants
export const MIDI_HEADER = [0x4d, 0x54, 0x68, 0x64];
export const MIDI_TRACK_HEADER = [0x4d, 0x54, 0x72, 0x6b];

export const SOUND_PROFILES: Record<string, SoundProfile> = {
  'DEFAULT': {
    id: 'DEFAULT',
    name: 'Natural Capture',
    description: 'Preserves original performance dynamics.',
    suggestedQuantization: QuantizeValue.Q_1_8, // Gentle correction
    transformation: {
      velocityCurve: 'dynamic',
      durationMode: 'natural',
      quantizeStrength: 0.5,
      baseVelocity: 100,
      midiCC: {
        attack: 64, // Neutral
        release: 64, // Neutral
        brightness: 64,
        reverb: 40
      }
    }
  },
  'DRIVING': {
    id: 'DRIVING',
    name: 'Driving / Percussive',
    description: 'Short, punchy notes with high velocity. Sharpened Attack.',
    suggestedQuantization: QuantizeValue.Q_1_16, // Tight grid for beats
    transformation: {
      velocityCurve: 'fixed-high',
      durationMode: 'gated',
      minDuration: 0.1, // Force staccato
      quantizeStrength: 1.0, // Strict timing
      baseVelocity: 120,
      midiCC: {
        attack: 0,   // Immediate attack (CC 73)
        release: 20, // Short release (CC 72)
        brightness: 110, // Open filter (CC 74)
        reverb: 10
      }
    }
  },
  'SOARING': {
    id: 'SOARING',
    name: 'Soaring / Lead',
    description: 'Legato sustain with slow attack and heavy reverb.',
    suggestedQuantization: QuantizeValue.Q_1_8, // Melodic structure
    transformation: {
      velocityCurve: 'dynamic',
      durationMode: 'legato',
      minDuration: 0.25,
      quantizeStrength: 0.6,
      baseVelocity: 100,
      midiCC: {
        attack: 50,  // Softer attack
        release: 70, // Longer tail
        brightness: 90, // Bright lead
        reverb: 80 // Epic hall
      }
    }
  },
  'ATMOSPHERIC': {
    id: 'ATMOSPHERIC',
    name: 'Atmospheric / Pad',
    description: 'Swelling attacks, long releases, overlapping notes.',
    suggestedQuantization: QuantizeValue.Q_1_4, // Very loose, anchored to beat
    transformation: {
      velocityCurve: 'soft',
      durationMode: 'legato',
      minDuration: 0.5,
      quantizeStrength: 0.2, // Loose timing
      baseVelocity: 75,
      midiCC: {
        attack: 90,  // Very slow swell
        release: 100, // Very long fade
        brightness: 40, // Darker filter
        reverb: 110 // Massive space
      }
    }
  }
};

// Genre profiles - affects how MIDI is structured for DAW export
export const GENRE_PROFILES: Record<Genre, GenreProfile> = {
  [Genre.NONE]: {
    id: Genre.NONE,
    name: 'No Genre',
    description: 'No genre-specific processing. Use your own settings.',
    suggestedQuantization: QuantizeValue.Q_1_8,
    suggestedProfileId: 'DEFAULT',
    midiHints: {
      noteLengthBias: 'medium',
      quantizeTightness: 'medium',
      velocityStyle: 'dynamic',
      typicalBpmRange: [60, 180],
      commonScales: [ScaleType.CHROMATIC]
    },
    geminiPromptHint: ''
  },
  [Genre.DUBSTEP]: {
    id: Genre.DUBSTEP,
    name: 'Dubstep',
    description: 'Heavy bass wobbles, half-time feel, long sustained notes for LFO modulation.',
    suggestedQuantization: QuantizeValue.Q_1_8,
    suggestedProfileId: 'SOARING',
    midiHints: {
      noteLengthBias: 'long',
      quantizeTightness: 'loose',
      velocityStyle: 'dynamic',
      typicalBpmRange: [140, 150],
      commonScales: [ScaleType.MINOR, ScaleType.CHROMATIC]
    },
    geminiPromptHint: 'Dubstep bass: Create LONG sustained notes suitable for wobble bass with LFO modulation. Half-time feel. Notes should be held, not staccato. Think Skrillex, Excision - bass notes that sustain and can be modulated with filters/LFOs in a DAW.'
  },
  [Genre.HOUSE]: {
    id: Genre.HOUSE,
    name: 'House',
    description: 'Four-on-the-floor, tight quantization, punchy and consistent.',
    suggestedQuantization: QuantizeValue.Q_1_16,
    suggestedProfileId: 'DRIVING',
    midiHints: {
      noteLengthBias: 'short',
      quantizeTightness: 'tight',
      velocityStyle: 'consistent',
      typicalBpmRange: [120, 130],
      commonScales: [ScaleType.MINOR, ScaleType.MAJOR]
    },
    geminiPromptHint: 'House music: Tight to the grid, punchy short notes. 4/4 driving rhythm. Notes should be quantized precisely. Think disco-influenced, groovy but mechanical precision.'
  },
  [Genre.TECHNO]: {
    id: Genre.TECHNO,
    name: 'Techno',
    description: 'Hypnotic, repetitive, mechanical precision with subtle variations.',
    suggestedQuantization: QuantizeValue.Q_1_16,
    suggestedProfileId: 'DRIVING',
    midiHints: {
      noteLengthBias: 'short',
      quantizeTightness: 'tight',
      velocityStyle: 'consistent',
      typicalBpmRange: [125, 140],
      commonScales: [ScaleType.MINOR, ScaleType.CHROMATIC]
    },
    geminiPromptHint: 'Techno: Mechanical, hypnotic, precisely quantized. Repetitive patterns with subtle velocity variations. Dark, industrial feel. Notes locked to grid.'
  },
  [Genre.DRUM_AND_BASS]: {
    id: Genre.DRUM_AND_BASS,
    name: 'Drum & Bass',
    description: 'Fast breakbeats, rolling bass, very short punchy notes.',
    suggestedQuantization: QuantizeValue.Q_1_32,
    suggestedProfileId: 'DRIVING',
    midiHints: {
      noteLengthBias: 'short',
      quantizeTightness: 'tight',
      velocityStyle: 'punchy',
      typicalBpmRange: [160, 180],
      commonScales: [ScaleType.MINOR, ScaleType.PENTATONIC]
    },
    geminiPromptHint: 'Drum & Bass: Fast tempo, very short staccato notes. Reese bass with quick articulation. Rolling, syncopated patterns. High energy, notes should be tight and punchy.'
  },
  [Genre.TRANCE]: {
    id: Genre.TRANCE,
    name: 'Trance',
    description: 'Uplifting, melodic, arpeggiated patterns with medium-length notes.',
    suggestedQuantization: QuantizeValue.Q_1_16,
    suggestedProfileId: 'SOARING',
    midiHints: {
      noteLengthBias: 'medium',
      quantizeTightness: 'medium',
      velocityStyle: 'dynamic',
      typicalBpmRange: [135, 145],
      commonScales: [ScaleType.MINOR, ScaleType.MAJOR]
    },
    geminiPromptHint: 'Trance: Euphoric, melodic, arpeggiated. Build-ups and breakdowns. Notes should flow melodically with emotional dynamics. Supersaw-friendly note lengths.'
  },
  [Genre.AMBIENT]: {
    id: Genre.AMBIENT,
    name: 'Ambient',
    description: 'Atmospheric pads, very long notes, free-flowing timing.',
    suggestedQuantization: QuantizeValue.OFF,
    suggestedProfileId: 'ATMOSPHERIC',
    midiHints: {
      noteLengthBias: 'long',
      quantizeTightness: 'free',
      velocityStyle: 'soft',
      typicalBpmRange: [60, 100],
      commonScales: [ScaleType.MAJOR, ScaleType.PENTATONIC]
    },
    geminiPromptHint: 'Ambient: Ethereal, floating, no strict timing. Very long sustained notes for pads. Gentle velocity. Overlapping notes are fine. Think Brian Eno - textures, not beats.'
  },
  [Genre.HIPHOP]: {
    id: Genre.HIPHOP,
    name: 'Hip-Hop',
    description: 'Laid-back groove, slightly behind the beat, varied note lengths.',
    suggestedQuantization: QuantizeValue.Q_1_8,
    suggestedProfileId: 'DEFAULT',
    midiHints: {
      noteLengthBias: 'varied',
      quantizeTightness: 'loose',
      velocityStyle: 'dynamic',
      typicalBpmRange: [80, 100],
      commonScales: [ScaleType.MINOR, ScaleType.PENTATONIC]
    },
    geminiPromptHint: 'Hip-Hop: Laid-back, swung groove. Notes can sit slightly behind the grid for that human feel. 808-style bass - some short, some sustained. Boom-bap influence.'
  },
  [Genre.TRAP]: {
    id: Genre.TRAP,
    name: 'Trap',
    description: 'Hard-hitting 808s, mix of sustained bass and rapid hi-hat patterns.',
    suggestedQuantization: QuantizeValue.Q_1_16,
    suggestedProfileId: 'DRIVING',
    midiHints: {
      noteLengthBias: 'varied',
      quantizeTightness: 'medium',
      velocityStyle: 'punchy',
      typicalBpmRange: [130, 170],
      commonScales: [ScaleType.MINOR, ScaleType.PENTATONIC]
    },
    geminiPromptHint: 'Trap: Hard 808 bass - sustained low notes with punchy hits. Triplet hi-hat feel. Mix of long gliding bass notes and short percussive hits. Think Metro Boomin, Southside.'
  },
  [Genre.POP]: {
    id: Genre.POP,
    name: 'Pop',
    description: 'Clean, melodic, moderate quantization with dynamic expression.',
    suggestedQuantization: QuantizeValue.Q_1_8,
    suggestedProfileId: 'DEFAULT',
    midiHints: {
      noteLengthBias: 'medium',
      quantizeTightness: 'medium',
      velocityStyle: 'dynamic',
      typicalBpmRange: [100, 130],
      commonScales: [ScaleType.MAJOR, ScaleType.MINOR]
    },
    geminiPromptHint: 'Pop: Clean, polished, singable melodies. Notes should be clear and well-defined. Natural dynamics. Radio-friendly structure and timing.'
  },
  [Genre.ROCK]: {
    id: Genre.ROCK,
    name: 'Rock',
    description: 'Energetic, power chords feel, strong downbeats.',
    suggestedQuantization: QuantizeValue.Q_1_8,
    suggestedProfileId: 'DRIVING',
    midiHints: {
      noteLengthBias: 'medium',
      quantizeTightness: 'medium',
      velocityStyle: 'punchy',
      typicalBpmRange: [110, 140],
      commonScales: [ScaleType.MINOR, ScaleType.PENTATONIC]
    },
    geminiPromptHint: 'Rock: Energetic, guitar-influenced. Strong accents on downbeats. Power chord-friendly note groupings. Raw energy with some human feel in timing.'
  }
};
