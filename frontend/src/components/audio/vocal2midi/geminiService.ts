import { GoogleGenAI, Type } from "@google/genai";
import type { AudioAnalysisResult, NoteEvent, ScaleType, QuantizeValue } from "./types";
import { Genre } from "./types";
import { GENRE_PROFILES } from "./constants";

// theDAW keeps API keys server-side: a single module-level client routes
// every Gemini call through the backend proxy. No keys live in the browser.
const PROXY_BASE = (typeof window !== 'undefined' ? window.location.origin : '') + '/api/genai-proxy';
const ai = new GoogleGenAI({ apiKey: 'thedaw-proxy', httpOptions: { baseUrl: PROXY_BASE } });

// ============================================
// MIDI CLEANUP WITH GEMINI
// ============================================
// Reviews locally-detected notes and removes obvious errors

export interface MidiCleanupResult {
  cleanedNotes: NoteEvent[];
  removedCount: number;
  reason: string;
}

export const cleanupMidiWithGemini = async (
  audioBlob: Blob,
  detectedNotes: NoteEvent[],
  userPrompt: string
): Promise<MidiCleanupResult> => {
  const base64Audio = await blobToBase64(audioBlob);

  const notesJson = JSON.stringify(detectedNotes.map(n => ({
    midi: n.midiNote,
    start: n.startTime.toFixed(3),
    dur: n.duration.toFixed(3)
  })));

  const promptText = `
    You are a MIDI cleanup assistant. I have detected these notes from audio using pitch detection:
    ${notesJson}

    Listen to the audio and REMOVE any notes that are OBVIOUSLY WRONG:
    - Notes during actual silence (no vocalization)
    - Duplicate/redundant notes at the same time
    - Notes that don't match what you hear in the audio
    - Noise artifacts (very short spurious notes)

    User context: "${userPrompt || "Vocal to MIDI"}"

    IMPORTANT RULES:
    - ONLY remove notes that are clearly errors
    - If unsure, KEEP the note
    - Return the indices (0-based) of notes to REMOVE
    - If all notes are valid, return empty array

    Return JSON with:
    - removeIndices: array of note indices to remove (e.g., [0, 3, 5])
    - reason: brief explanation of what was removed and why
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: {
        parts: [
          { inlineData: { mimeType: audioBlob.type || 'audio/webm', data: base64Audio } },
          { text: promptText }
        ]
      },
      config: {
        thinkingConfig: { thinkingBudget: 512 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            removeIndices: { type: Type.ARRAY, items: { type: Type.INTEGER } },
            reason: { type: Type.STRING }
          },
          required: ['removeIndices', 'reason']
        }
      }
    });

    const result = JSON.parse(response.text || '{}');
    const removeSet = new Set(result.removeIndices || []);
    const cleanedNotes = detectedNotes.filter((_, idx) => !removeSet.has(idx));

    console.log(`[Gemini Cleanup] Removed ${removeSet.size} notes: ${result.reason}`);

    return {
      cleanedNotes,
      removedCount: removeSet.size,
      reason: result.reason || 'No issues found'
    };
  } catch (error: any) {
    console.error(`[Gemini Cleanup] failed:`, error.message || error);
  }

  // Fallback: return original notes unchanged
  return {
    cleanedNotes: detectedNotes,
    removedCount: 0,
    reason: 'Cleanup skipped (API unavailable)'
  };
};

// ============================================
// DEEP SMART CLEANUP WITH 8K THINKING TOKENS
// ============================================
// More thorough analysis - can modify notes, not just remove

export interface SmartCleanupResult {
  cleanedNotes: NoteEvent[];
  changes: string[];
  summary: string;
}

export const smartCleanupMidi = async (
  audioBlob: Blob,
  detectedNotes: NoteEvent[],
  userPrompt: string,
  bpm: number
): Promise<SmartCleanupResult> => {
  const base64Audio = await blobToBase64(audioBlob);

  const notesJson = JSON.stringify(detectedNotes.map((n, i) => ({
    idx: i,
    midi: n.midiNote,
    start: Number(n.startTime.toFixed(3)),
    dur: Number(n.duration.toFixed(3)),
    vel: n.velocity
  })));

  const promptText = `
    You are an expert MIDI editor. Analyze this audio and the detected MIDI notes.

    DETECTED NOTES (from pitch detection):
    ${notesJson}

    BPM: ${bpm}
    User context: "${userPrompt || "Vocal to MIDI conversion"}"

    LISTEN CAREFULLY to the audio and compare with the detected notes.

    YOUR TASK - Return a CORRECTED note array:
    1. REMOVE notes that occur during silence (no vocalization heard)
    2. REMOVE duplicate/spurious notes
    3. FIX incorrect pitches if you clearly hear a different note
    4. MERGE fragmented notes that should be one sustained note
    5. ADJUST timing if notes are clearly off

    CRITICAL RULES:
    - Be CONSERVATIVE - only change what's clearly wrong
    - If you hear 3 sounds, return 3 notes. If you hear 5 sounds, return 5 notes.
    - Silence = NO NOTE. Never add notes where there's silence.
    - Preserve the user's intentional rhythm and gaps

    Return JSON with:
    - notes: array of corrected notes [{midiNote, startTime, duration, velocity}, ...]
    - changes: array of strings describing each change made
    - summary: one sentence summary of what was fixed
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: {
        parts: [
          { inlineData: { mimeType: audioBlob.type || 'audio/webm', data: base64Audio } },
          { text: promptText }
        ]
      },
      config: {
        // HIGH thinking budget for deep analysis
        thinkingConfig: { thinkingBudget: 8192 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            notes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  midiNote: { type: Type.INTEGER },
                  startTime: { type: Type.NUMBER },
                  duration: { type: Type.NUMBER },
                  velocity: { type: Type.INTEGER }
                },
                required: ['midiNote', 'startTime', 'duration', 'velocity']
              }
            },
            changes: { type: Type.ARRAY, items: { type: Type.STRING } },
            summary: { type: Type.STRING }
          },
          required: ['notes', 'changes', 'summary']
        }
      }
    });

    const result = JSON.parse(response.text || '{}');
    console.log(`[Smart Cleanup] ${result.summary}`);
    console.log(`[Smart Cleanup] Changes:`, result.changes);

    return {
      cleanedNotes: result.notes || detectedNotes,
      changes: result.changes || [],
      summary: result.summary || 'Analysis complete'
    };
  } catch (error: any) {
    console.error(`[Smart Cleanup] failed:`, error.message || error);
  }

  // Fallback
  return {
    cleanedNotes: detectedNotes,
    changes: [],
    summary: 'Smart cleanup unavailable (API limit reached)'
  };
};

// Helper to convert Blob to Base64
export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// User configuration context for analysis
export interface AnalysisContext {
  genre: Genre;
  scale: ScaleType;
  quantizeMode: 'AUTO' | 'MANUAL';
  manualQuantizeValue: QuantizeValue;
  sensitivity: number;
  autoKeyDetection: boolean;
}

export const analyzeAudioWithGemini = async (
  audioBlob: Blob,
  userPrompt: string,
  context?: AnalysisContext
): Promise<AudioAnalysisResult> => {
  const base64Audio = await blobToBase64(audioBlob);

  // Build context string from user's selected options (do this once)
  let contextInfo = "";
  if (context) {
    const genreProfile = GENRE_PROFILES[context.genre];
    contextInfo = `
    USER'S SELECTED OPTIONS (Consider these in your analysis):
    - Genre Selected: ${context.genre}${context.genre !== Genre.NONE ? ` (${genreProfile?.description || ''})` : ''}
    - Typical BPM Range for Genre: ${genreProfile?.midiHints?.typicalBpmRange ? `${genreProfile.midiHints.typicalBpmRange[0]}-${genreProfile.midiHints.typicalBpmRange[1]} BPM` : 'N/A'}
    - Scale Preference: ${context.scale}
    - Quantization Mode: ${context.quantizeMode}${context.quantizeMode === 'MANUAL' ? ` (1/${context.manualQuantizeValue})` : ''}
    - Auto Key Detection: ${context.autoKeyDetection ? 'Enabled' : 'Disabled'}
    - Sensitivity: ${context.sensitivity}% (${context.sensitivity > 70 ? 'loose/permissive' : context.sensitivity < 30 ? 'strict/precise' : 'balanced'})

    ${context.genre !== Genre.NONE ? `Genre Hints from ${context.genre}:
    - Note Length Bias: ${genreProfile?.midiHints?.noteLengthBias || 'varied'}
    - Quantize Tightness: ${genreProfile?.midiHints?.quantizeTightness || 'medium'}
    - Velocity Style: ${genreProfile?.midiHints?.velocityStyle || 'dynamic'}
    - Common Scales: ${genreProfile?.midiHints?.commonScales?.join(', ') || 'any'}` : ''}
    `;
  }

  // Structured prompt - Gemini analyzes METADATA only (BPM, profile, instrument)
  // NOTE DETECTION is done locally via YIN pitch detection algorithm
  const promptText = `
    Analyze this audio clip. The user wants to convert this vocalization into MIDI.

    User Context/Prompt: "${userPrompt || "No specific prompt provided"}"
    ${contextInfo}

    Your Task (ANALYSIS ONLY - do NOT create notes):
    1. Listen critically to the groove, swing, and timing nuances.
    2. Determine the precise BPM (Beats Per Minute) based on the rhythm.
    3. Identify the Time Signature (e.g., "4/4", "6/8").
    4. Suggest the best Instrument timbre (e.g., "Deep House Kick", "Acid Bass", "Sawtooth Lead", "Grand Piano").
    5. Analyze the dynamic profile and map it to one of the Profile IDs below.

    Profile IDs:
       - 'DRIVING': Short, punchy, percussive, staccato, rhythmic.
       - 'SOARING': Long, connected, legato, melodic, sustained.
       - 'ATMOSPHERIC': Soft, ambient, long release, loose timing.
       - 'DEFAULT': Natural, generic, mixed.

    Return the result in JSON format with: detectedBpm, timeSignature, suggestedInstrument, description, detectedProfileId.
  `;

  // Using Gemini 3 Flash Preview which supports Thinking
  const model = "gemini-3.5-flash";

  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: audioBlob.type || 'audio/webm',
              data: base64Audio
            }
          },
          { text: promptText }
        ]
      },
      config: {
        // Enable Thinking Tokens for analysis
        thinkingConfig: { thinkingBudget: 1024 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detectedBpm: { type: Type.NUMBER },
            timeSignature: { type: Type.STRING },
            suggestedInstrument: { type: Type.STRING },
            description: { type: Type.STRING },
            detectedProfileId: { type: Type.STRING }
            // NOTE: We do NOT ask Gemini to create notes anymore
            // Local YIN pitch detection handles note creation (more accurate for silence)
          },
          required: ['detectedBpm', 'timeSignature']
        }
      }
    });

    const resultText = response.text;
    if (!resultText) throw new Error("No response from Gemini");

    const analysis = JSON.parse(resultText) as AudioAnalysisResult;
    console.log(`[Gemini] Success! Detected ${analysis.detectedNotes?.length || 0} notes`);
    return analysis;

  } catch (error: any) {
    console.error(`[Gemini] analysis failed:`, error.message || error);
  }

  // Return fallback
  return {
    detectedBpm: 120,
    timeSignature: "4/4",
    suggestedInstrument: "Grand Piano",
    description: `Analysis failed: ${'Unknown error'}`,
    detectedProfileId: "DEFAULT"
  };
};
