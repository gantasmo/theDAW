import { type NoteEvent, QuantizeValue, ScaleType, type SoundProfile } from './types';
import { SCALES, SOUND_PROFILES } from './constants';

// --- Signal Processing Helpers ---

// A simplified YIN algorithm for pitch detection
// Now accepts a dynamic confidence threshold
export const detectPitch = (float32AudioBuffer: Float32Array, sampleRate: number, minConfidence: number = 0.5): number | null => {
  const bufferSize = float32AudioBuffer.length;
  const yinBuffer = new Float32Array(bufferSize / 2);
  let probability = 0.0;
  // Dynamic threshold for difference calculation based on confidence requested
  // If we want high confidence (strict), we lower the error threshold allowed
  const threshold = minConfidence < 0.6 ? 0.2 : 0.15;

  // Step 1: Difference function
  for (let t = 0; t < yinBuffer.length; t++) {
    yinBuffer[t] = 0;
    for (let i = 0; i < yinBuffer.length; i++) {
      const delta = float32AudioBuffer[i] - float32AudioBuffer[i + t];
      yinBuffer[t] += delta * delta;
    }
  }

  // Step 2: Cumulative mean normalized difference function
  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let t = 1; t < yinBuffer.length; t++) {
    runningSum += yinBuffer[t];
    yinBuffer[t] *= t / runningSum;
  }

  // Step 3: Absolute threshold
  let tau = -1;
  for (let t = 2; t < yinBuffer.length; t++) {
    if (yinBuffer[t] < threshold) {
      while (t + 1 < yinBuffer.length && yinBuffer[t + 1] < yinBuffer[t]) {
        t++;
      }
      tau = t;
      probability = 1 - yinBuffer[t];
      break;
    }
  }

  if (tau === -1 || probability < minConfidence) return null;

  return sampleRate / tau;
};

export const frequencyToMidi = (freq: number): number => {
  return Math.round(69 + 12 * Math.log2(freq / 440));
};

// Clean up and deduplicate notes - removes noise and merges close consecutive notes
export const cleanupNotes = (notes: NoteEvent[], minNoteDuration: number = 0.05, mergeGap: number = 0.08): NoteEvent[] => {
  if (notes.length === 0) return [];

  // Sort by start time
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);

  // Filter out very short notes (likely noise)
  const filtered = sorted.filter(n => n.duration >= minNoteDuration);

  if (filtered.length === 0) return [];

  // Merge consecutive notes of the same pitch that are very close together
  const merged: NoteEvent[] = [];
  let current = { ...filtered[0] };

  for (let i = 1; i < filtered.length; i++) {
    const next = filtered[i];
    const gapBetween = next.startTime - (current.startTime + current.duration);

    // If same pitch and gap is very small, merge them
    if (next.midiNote === current.midiNote && gapBetween < mergeGap && gapBetween >= -0.01) {
      // Extend current note to include the next one
      current.duration = (next.startTime + next.duration) - current.startTime;
      current.velocity = Math.max(current.velocity, next.velocity);
    } else {
      // Different pitch or too far apart - save current and start new
      merged.push(current);
      current = { ...next };
    }
  }
  // Don't forget the last note
  merged.push(current);

  return merged;
};

export const snapToScale = (midiNote: number, rootNote: number, scaleType: ScaleType): number => {
  if (scaleType === ScaleType.CHROMATIC) return midiNote;

  const scaleIntervals = SCALES[scaleType];
  const normalizedNote = midiNote % 12;
  const normalizedRoot = rootNote % 12;

  // Find the closest note in the scale
  let minDiff = Infinity;
  let closestNote = midiNote;

  // Check all octaves around
  for (let i = -1; i <= 1; i++) {
     const octaveOffset = i * 12;
     for (const interval of scaleIntervals) {
       const targetNote = (normalizedRoot + interval) % 12;
       // Reconstruct absolute MIDI note
       const absoluteTarget = (Math.floor(midiNote / 12) * 12) + targetNote + octaveOffset;

       const diff = Math.abs(midiNote - absoluteTarget);
       if (diff < minDiff) {
         minDiff = diff;
         closestNote = absoluteTarget;
       }
     }
  }
  return closestNote;
};

// Applies both quantization AND sound profile transformations
export const processNotesWithProfile = (
  notes: NoteEvent[],
  bpm: number,
  quantizeVal: QuantizeValue,
  profile: SoundProfile
): NoteEvent[] => {

  const secondsPerBeat = 60 / bpm;
  const gridUnit = quantizeVal !== QuantizeValue.OFF ? secondsPerBeat * (4 / quantizeVal) : 0;

  // Sort first
  const sortedNotes = [...notes].sort((a, b) => a.startTime - b.startTime);

  return sortedNotes.map((note, index) => {
    let { startTime, duration, velocity, midiNote } = note;

    // 1. Quantization (Time Correction) - preserves gaps/rests
    if (gridUnit > 0) {
      // Apply quantization strength (mix between original and grid)
      const targetStart = Math.round(startTime / gridUnit) * gridUnit;
      const targetDuration = Math.round(duration / gridUnit) * gridUnit;

      // Interpolate based on profile quantization strength
      const qStr = profile.transformation.quantizeStrength;
      startTime = startTime + (targetStart - startTime) * qStr;

      // Keep original duration character - don't force to grid minimum
      // Just apply quantization strength to duration
      const quantizedDuration = duration + (targetDuration - duration) * qStr;
      // Minimum 0.02s to prevent zero-length notes, but preserve short notes
      duration = Math.max(0.02, quantizedDuration);
    }

    // 2. Profile Duration Handling - NEVER fill gaps, only adjust individual note lengths
    if (profile.transformation.durationMode === 'gated') {
      // Force short durations for percussive sounds
      duration = Math.min(duration, profile.transformation.minDuration || 0.15);
    } else if (profile.transformation.durationMode === 'legato') {
      // Just apply minimum duration - NEVER extend to fill gaps
      // Gaps are intentional rests and must be preserved
      duration = Math.max(duration, profile.transformation.minDuration || 0.2);
    }
    // 'natural' mode: preserve exact recorded durations

    // 3. Velocity Handling
    let finalVelocity = velocity;
    if (profile.transformation.velocityCurve === 'fixed-high') {
      finalVelocity = profile.transformation.baseVelocity;
    } else if (profile.transformation.velocityCurve === 'soft') {
      finalVelocity = Math.min(velocity, profile.transformation.baseVelocity);
    } else {
      // Dynamic: center around baseVelocity but keep variance
      const variance = velocity - 100; // range -100 to 27
      finalVelocity = Math.max(1, Math.min(127, profile.transformation.baseVelocity + (variance * 0.8)));
    }

    return {
      midiNote,
      startTime,
      duration,
      velocity: Math.round(finalVelocity)
    };
  });
};

// --- MIDI File Generation (Binary) ---

const numberToBytes = (num: number, bytes: number) => {
  const result = [];
  for (let i = bytes - 1; i >= 0; i--) {
    result.push((num >> (8 * i)) & 0xFF);
  }
  return result;
};

// Correct VarInt implementation
const toVarInt = (num: number): number[] => {
  if (num === 0) return [0];
  const bytes = [];
  let n = num;
  while (n > 0) {
    bytes.unshift(n & 0x7F);
    n >>= 7;
  }
  for (let i = 0; i < bytes.length - 1; i++) {
    bytes[i] |= 0x80;
  }
  return bytes;
};


export interface MidiExportOptions {
  experimentalPitchBend?: boolean;
}

export const generateMidiFile = (
  notes: NoteEvent[],
  bpm: number,
  profile?: SoundProfile,
  options?: MidiExportOptions
): Blob => {
  const { experimentalPitchBend = false } = options || {};

  // MIDI Header
  const ticksPerBeat = 480; // Standard PPQ
  const header = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // Chunk size
    0x00, 0x01, // Format 1 (multi-track, though we use 1 here mostly)
    0x00, 0x02, // 2 Tracks (1 for Tempo, 1 for Notes)
    ...numberToBytes(ticksPerBeat, 2)
  ];

  // Track 1: Tempo
  const microsecondsPerBeat = Math.round(60000000 / bpm);
  const tempoEvent = [
    0x00, // Delta time 0
    0xFF, 0x51, 0x03, // Meta event: Set Tempo
    ...numberToBytes(microsecondsPerBeat, 3)
  ];
  const endOfTrack1 = [0x00, 0xFF, 0x2F, 0x00];
  const track1Data = [...tempoEvent, ...endOfTrack1];
  const track1Header = [
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    ...numberToBytes(track1Data.length, 4)
  ];

  // Track 2: Notes & Control Changes
  let track2Data: number[] = [];

  // Convert seconds to ticks
  const secToTicks = (sec: number) => Math.round(sec * (bpm / 60) * ticksPerBeat);

  // Define Event Type
  interface MidiEvent {
    tick: number;
    type: 'on' | 'off' | 'cc' | 'pitchbend';
    note?: number;
    ccNum?: number;
    val: number;
    pitchBendVal?: number; // 0-16383, 8192 = center
  }
  let events: MidiEvent[] = [];

  // 1. Inject CC messages at Tick 0 if profile has them
  if (profile && profile.transformation.midiCC) {
    const { attack, release, brightness, reverb } = profile.transformation.midiCC;
    if (attack !== undefined) events.push({ tick: 0, type: 'cc', ccNum: 73, val: attack });
    if (release !== undefined) events.push({ tick: 0, type: 'cc', ccNum: 72, val: release });
    if (brightness !== undefined) events.push({ tick: 0, type: 'cc', ccNum: 74, val: brightness });
    if (reverb !== undefined) events.push({ tick: 0, type: 'cc', ccNum: 91, val: reverb });
  }

  // 2. Add Note Events
  const sortedNotes = [...notes].sort((a, b) => a.startTime - b.startTime);
  sortedNotes.forEach(n => {
    const startTick = secToTicks(n.startTime);
    const endTick = secToTicks(n.startTime + n.duration);
    events.push({ tick: startTick, type: 'on', note: n.midiNote, val: n.velocity });
    events.push({ tick: endTick, type: 'off', note: n.midiNote, val: 0 });
  });

  // 3. EXPERIMENTAL: Add Pitch Bend for slides between consecutive notes
  if (experimentalPitchBend && sortedNotes.length > 1) {
    // Reset pitch bend at the start
    events.push({ tick: 0, type: 'pitchbend', val: 0, pitchBendVal: 8192 });

    for (let i = 0; i < sortedNotes.length - 1; i++) {
      const currentNote = sortedNotes[i];
      const nextNote = sortedNotes[i + 1];

      const currentEnd = currentNote.startTime + currentNote.duration;
      const gap = nextNote.startTime - currentEnd;

      // Detect potential slide: notes are close (gap < 100ms) and different pitches
      const isSlideCandidate = gap < 0.1 && gap >= -0.05; // Allow small overlap
      const pitchDiff = nextNote.midiNote - currentNote.midiNote;

      if (isSlideCandidate && pitchDiff !== 0 && Math.abs(pitchDiff) <= 12) {
        // Calculate slide parameters
        // Standard pitch bend range is ±2 semitones (can be set via RPN, we assume default)
        // pitchBendVal: 0 = -2 semitones, 8192 = center, 16383 = +2 semitones
        // For larger intervals, we'll bend as much as we can (±2 semitones) then jump

        const bendSemitones = Math.min(Math.abs(pitchDiff), 2) * Math.sign(pitchDiff);
        // Convert semitones to pitch bend value: 8192 + (semitones * 4096)
        const targetBend = 8192 + (bendSemitones * 4096);

        const slideStartTick = secToTicks(currentEnd - 0.05); // Start slide 50ms before note ends
        const slideEndTick = secToTicks(nextNote.startTime);

        // Generate slide events (interpolate pitch bend)
        const numSteps = 8; // 8 steps for smooth-ish slide
        for (let step = 0; step <= numSteps; step++) {
          const t = step / numSteps;
          const tick = Math.round(slideStartTick + (slideEndTick - slideStartTick) * t);
          const bendVal = Math.round(8192 + (targetBend - 8192) * t);
          events.push({
            tick: Math.max(0, tick),
            type: 'pitchbend',
            val: 0,
            pitchBendVal: Math.max(0, Math.min(16383, bendVal))
          });
        }

        // Reset pitch bend shortly after the next note starts
        events.push({
          tick: secToTicks(nextNote.startTime + 0.02),
          type: 'pitchbend',
          val: 0,
          pitchBendVal: 8192
        });
      }
    }
  }

  // 4. Sort events (Tick -> Type Priority: CC/PitchBend first, then Note Off, then Note On)
  events.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    // Priority: CC/PitchBend -> Note Off -> Note On
    const typePriority = { cc: 0, pitchbend: 1, off: 2, on: 3 };
    return typePriority[a.type] - typePriority[b.type];
  });

  let lastTick = 0;

  events.forEach(e => {
    const delta = e.tick - lastTick;
    const deltaBytes = toVarInt(delta);

    if (e.type === 'pitchbend') {
      // Pitch Bend: 0xE0, LSB, MSB (14-bit value split into two 7-bit bytes)
      const bendVal = e.pitchBendVal ?? 8192;
      const lsb = bendVal & 0x7F;
      const msb = (bendVal >> 7) & 0x7F;
      track2Data.push(...deltaBytes);
      track2Data.push(0xE0, lsb, msb);
    } else {
      // Note On: 0x90, CC: 0xB0
      // Using Note On with Velocity 0 for Note Off (maximum compatibility)
      let statusByte = 0x90;
      let data1 = 0;
      let data2 = e.val;

      if (e.type === 'cc') {
        statusByte = 0xB0;
        data1 = e.ccNum || 0;
      } else if (e.type === 'off') {
        statusByte = 0x90; // Use Note On
        data1 = e.note || 0;
        data2 = 0; // Velocity 0 = Off
      } else {
        statusByte = 0x90;
        data1 = e.note || 0;
      }

      track2Data.push(...deltaBytes);
      track2Data.push(statusByte, data1, data2);
    }

    lastTick = e.tick;
  });

  const endOfTrack2 = [0x00, 0xFF, 0x2F, 0x00];
  track2Data.push(...endOfTrack2);

  const track2Header = [
    0x4d, 0x54, 0x72, 0x6b,
    ...numberToBytes(track2Data.length, 4)
  ];

  const fileBytes = new Uint8Array([
    ...header,
    ...track1Header,
    ...track1Data,
    ...track2Header,
    ...track2Data
  ]);

  return new Blob([fileBytes], { type: 'audio/midi' });
};