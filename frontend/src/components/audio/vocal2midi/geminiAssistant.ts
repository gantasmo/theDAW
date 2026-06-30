import { GoogleGenAI, Type } from "@google/genai";
import type { FunctionDeclaration } from "@google/genai";
import { QuantizeValue, ScaleType, Genre } from "./types";
import type { ProcessingConfig, NoteEvent } from "./types";
import { quantizeNotes, transposeNotes, changeKey, snapNotesToScale, deleteNote } from "./midiEditor";
import { GENRE_PROFILES } from "./constants";

// theDAW keeps API keys server-side; route all Gemini calls through the backend proxy.
const PROXY_BASE = (typeof window !== 'undefined' ? window.location.origin : '') + '/api/genai-proxy';
const ai = new GoogleGenAI({ apiKey: 'thedaw-proxy', httpOptions: { baseUrl: PROXY_BASE } });

// Helper to convert config enums to string description for the prompt
const getConfigDescription = (config: ProcessingConfig) => {
    return JSON.stringify(config, null, 2);
};

const getNotesDescription = (notes: NoteEvent[]) => {
    if (notes.length === 0) return "No notes recorded yet.";
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return `${notes.length} notes: ${notes.slice(0, 10).map(n => {
        const name = noteNames[n.midiNote % 12];
        const octave = Math.floor(n.midiNote / 12) - 1;
        return `${name}${octave}`;
    }).join(', ')}${notes.length > 10 ? '...' : ''}`;
};

// Tool 1: Update app configuration settings
const updateConfigTool: FunctionDeclaration = {
    name: 'updateAppConfiguration',
    description: 'Updates the processing/recording settings of the Vocal2Midi application.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            rootNote: { type: Type.INTEGER, description: 'MIDI root note number (60=C4, 61=C#4, 62=D4, etc.). Only 60-71 for root selection.' },
            scale: { type: Type.STRING, description: 'Scale type: "Chromatic", "Major", "Minor", "Pentatonic".' },
            genre: { type: Type.STRING, description: 'Genre for MIDI structure: "None", "Dubstep", "House", "Techno", "Drum & Bass", "Trance", "Ambient", "Hip-Hop", "Trap", "Pop", "Rock". Affects note lengths, quantization style, and velocity.' },
            quantizeMode: { type: Type.STRING, description: '"AUTO" or "MANUAL".' },
            manualQuantizeValue: { type: Type.INTEGER, description: 'Quantize value: 4 (1/4), 8 (1/8), 16 (1/16), 32 (1/32), or 0 (OFF/Free).' },
            sensitivity: { type: Type.INTEGER, description: 'Recording sensitivity 0-100. Higher = more sensitive, catches quieter notes.' },
            activeProfileId: { type: Type.STRING, description: 'Sound Profile ID: "DEFAULT", "DRIVING", "SOARING", "ATMOSPHERIC".' },
            autoKeyDetection: { type: Type.BOOLEAN, description: 'Enable automatic key detection on recording.' },
            responseMessage: { type: Type.STRING, description: 'A short confirmation message to speak back to the user.' }
        },
        required: ['responseMessage']
    }
};

// Tool 2: Modify the piano roll / MIDI notes (bulk operations)
const modifyNotesTool: FunctionDeclaration = {
    name: 'modifyMidiNotes',
    description: 'Bulk operations on MIDI notes: quantize, transpose, change key, snap to scale, or delete.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            action: {
                type: Type.STRING,
                description: 'Action to perform: "quantize", "transpose", "changeKey", "snapToScale", "deleteAll", "deleteByRange".'
            },
            quantizeValue: {
                type: Type.INTEGER,
                description: 'For quantize action: 4 (1/4), 8 (1/8), 16 (1/16), 32 (1/32).'
            },
            semitones: {
                type: Type.INTEGER,
                description: 'For transpose action: number of semitones to shift (+12 = up octave, -12 = down octave).'
            },
            targetKey: {
                type: Type.INTEGER,
                description: 'For changeKey action: target root note (0-11, where 0=C, 1=C#, 2=D, etc.).'
            },
            targetScale: {
                type: Type.STRING,
                description: 'For snapToScale action: "Chromatic", "Major", "Minor", "Pentatonic".'
            },
            pitchMin: {
                type: Type.INTEGER,
                description: 'For deleteByRange: minimum MIDI note to delete.'
            },
            pitchMax: {
                type: Type.INTEGER,
                description: 'For deleteByRange: maximum MIDI note to delete.'
            },
            responseMessage: { type: Type.STRING, description: 'A short confirmation message.' }
        },
        required: ['action', 'responseMessage']
    }
};

// Tool 2b: Add a single MIDI note
const addNoteTool: FunctionDeclaration = {
    name: 'addNote',
    description: 'Adds a single MIDI note to the piano roll. Use this when the user wants to add a specific note.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            pitch: {
                type: Type.INTEGER,
                description: 'MIDI note number. Middle C (C4) = 60. C3=48, C5=72. Notes: C=0, C#=1, D=2, D#=3, E=4, F=5, F#=6, G=7, G#=8, A=9, A#=10, B=11 (add to octave*12).'
            },
            startBeat: {
                type: Type.NUMBER,
                description: 'Start position in beats (0 = beginning, 1 = beat 2, 4 = measure 2 in 4/4). Use decimals for sub-beats.'
            },
            durationBeats: {
                type: Type.NUMBER,
                description: 'Duration in beats. 1 = quarter note, 0.5 = eighth note, 0.25 = sixteenth note, 2 = half note.'
            },
            velocity: {
                type: Type.INTEGER,
                description: 'Note velocity/loudness 1-127. Default is 100. Soft=60, Medium=100, Loud=120.'
            },
            responseMessage: { type: Type.STRING, description: 'Confirmation message.' }
        },
        required: ['pitch', 'startBeat', 'durationBeats', 'responseMessage']
    }
};

// Tool 2c: Delete a specific note by index
const deleteNoteTool: FunctionDeclaration = {
    name: 'deleteNote',
    description: 'Deletes a specific note from the piano roll by its index (0-based) or by matching pitch and approximate time.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            noteIndex: {
                type: Type.INTEGER,
                description: 'Index of the note to delete (0-based, in order of start time).'
            },
            matchPitch: {
                type: Type.INTEGER,
                description: 'Alternative: MIDI pitch to match for deletion.'
            },
            matchBeat: {
                type: Type.NUMBER,
                description: 'Alternative: Approximate beat position to match (used with matchPitch).'
            },
            responseMessage: { type: Type.STRING, description: 'Confirmation message.' }
        },
        required: ['responseMessage']
    }
};

// Tool 3: Control playback and BPM
const controlPlaybackTool: FunctionDeclaration = {
    name: 'controlPlayback',
    description: 'Controls the piano roll playback and tempo settings.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            action: {
                type: Type.STRING,
                description: 'Action: "play", "stop", "setBpm".'
            },
            bpm: {
                type: Type.INTEGER,
                description: 'For setBpm action: tempo in beats per minute (20-300).'
            },
            instrument: {
                type: Type.STRING,
                description: 'Preview instrument: "synth", "piano", "kick", "bass", "guitar".'
            },
            responseMessage: { type: Type.STRING, description: 'A short confirmation message.' }
        },
        required: ['action', 'responseMessage']
    }
};

// Tool 4: Get status/info about current state
const getStatusTool: FunctionDeclaration = {
    name: 'getStatus',
    description: 'Gets information about the current state of the app, notes, or settings. Use this to answer questions about the current configuration.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            query: {
                type: Type.STRING,
                description: 'What to query: "notes", "config", "bpm", "key", "all".'
            },
            responseMessage: { type: Type.STRING, description: 'Information to relay to the user.' }
        },
        required: ['query', 'responseMessage']
    }
};

export interface PianoRollState {
    notes: NoteEvent[];
    bpm: number;
    rootNote: number;
    scale: ScaleType;
    isPlaying: boolean;
}

export interface AssistantResponse {
    text: string;
    configUpdates?: Partial<ProcessingConfig>;
    notesUpdate?: NoteEvent[];
    bpmUpdate?: number;
    keyUpdate?: { rootNote: number; scale: ScaleType };
    playbackAction?: 'play' | 'stop';
    instrumentUpdate?: string;
}

export interface AssistantContext {
    config: ProcessingConfig;
    pianoRoll: PianoRollState;
}

export const askAssistant = async (
    message: string,
    context: AssistantContext
): Promise<AssistantResponse> => {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const currentKeyName = `${noteNames[context.pianoRoll.rootNote % 12]} ${context.pianoRoll.scale}`;

    // Get genre-specific hints if a genre is selected
    const genreProfile = context.config.genre !== Genre.NONE ? GENRE_PROFILES[context.config.genre] : null;
    const genreContext = genreProfile ? `
=== GENRE CONTEXT: ${genreProfile.name.toUpperCase()} ===
${genreProfile.geminiPromptHint}

MIDI Hints for ${genreProfile.name}:
- Note Length Bias: ${genreProfile.midiHints.noteLengthBias}
- Quantize Tightness: ${genreProfile.midiHints.quantizeTightness}
- Velocity Style: ${genreProfile.midiHints.velocityStyle}
- Typical BPM: ${genreProfile.midiHints.typicalBpmRange[0]}-${genreProfile.midiHints.typicalBpmRange[1]}
- Common Scales: ${genreProfile.midiHints.commonScales.join(', ')}

When modifying MIDI for this genre, consider these characteristics. The goal is to create MIDI that will sound authentic when loaded into a DAW with appropriate VSTs.
` : '';

    // Comprehensive system instruction
    const systemInstruction = `
You are the "Digital Architect", an intelligent AI assistant for the Vocal2Midi web application.
You have full control over the application settings and the MIDI piano roll editor.
The purpose of this app is to create MIDI files for export to DAWs (like Reaper, Ableton) where they will be used with VST instruments.
${genreContext}
=== CURRENT APPLICATION STATE ===

Recording/Processing Config:
${getConfigDescription(context.config)}

Piano Roll State:
- BPM: ${context.pianoRoll.bpm}
- Key: ${currentKeyName}
- Genre: ${context.config.genre}
- Notes: ${getNotesDescription(context.pianoRoll.notes)}
- Total Duration: ${context.pianoRoll.notes.length > 0 ? Math.max(...context.pianoRoll.notes.map(n => n.startTime + n.duration)).toFixed(2) : 0}s
- Playing: ${context.pianoRoll.isPlaying}

=== YOUR CAPABILITIES ===

1. **updateAppConfiguration** - Change recording settings:
   - sensitivity (0-100): Higher catches quieter notes
   - scale: Chromatic, Major, Minor, Pentatonic
   - rootNote: The key (60=C4, 61=C#4, 62=D4...)
   - quantizeMode: AUTO or MANUAL
   - manualQuantizeValue: 0 (free), 4, 8, 16, 32
   - activeProfileId: DEFAULT, DRIVING, SOARING, ATMOSPHERIC
   - autoKeyDetection: true/false

2. **modifyMidiNotes** - Edit the MIDI notes:
   - "quantize": Snap notes to grid (specify quantizeValue: 4, 8, 16, 32)
   - "transpose": Shift all notes by semitones (+12 = up octave, -1 = down half step)
   - "changeKey": Transpose to a new key (targetKey: 0-11 where 0=C)
   - "snapToScale": Force notes to fit a scale (targetScale: Major, Minor, etc.)
   - "deleteAll": Clear all notes
   - "deleteByRange": Delete notes in pitch range (pitchMin, pitchMax)

3. **controlPlayback** - Control the preview:
   - "play": Start playback
   - "stop": Stop playback
   - "setBpm": Change tempo (bpm: 20-300)
   - instrument: synth, piano, kick, bass, guitar

4. **getStatus** - Answer questions about current state

=== RESPONSE GUIDELINES ===

- Be concise and professional
- When changing settings, briefly explain WHY (e.g., "Increased sensitivity to catch softer notes")
- For music theory questions, answer directly without tools
- If user says "play it" or "preview", use controlPlayback with action "play"
- If user says "stop", use controlPlayback with action "stop"
- "Make it tighter" → quantize to 1/16 or change to DRIVING profile
- "Transpose up" → transpose by +12 (octave) or specify semitones
- "Change to A minor" → changeKey to 9 (A) and update scale to Minor
- "Speed it up" → increase BPM
- "Slow it down" → decrease BPM

Always include a helpful responseMessage in your tool calls.
`;

    try {
        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: message,
            config: {
                systemInstruction: systemInstruction,
                tools: [{
                    functionDeclarations: [
                        updateConfigTool,
                        modifyNotesTool,
                        addNoteTool,
                        deleteNoteTool,
                        controlPlaybackTool,
                        getStatusTool
                    ]
                }],
                thinkingConfig: {
                    thinkingBudget: 4096
                }
            }
        });

        // Check for function calls
        const functionCalls = response.functionCalls;

        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            const args = call.args as any;

            switch (call.name) {
                case 'updateAppConfiguration': {
                    const { responseMessage, ...configChanges } = args;
                    return {
                        text: responseMessage || "Configuration updated.",
                        configUpdates: configChanges
                    };
                }

                case 'modifyMidiNotes': {
                    const { action, responseMessage } = args;
                    let newNotes = [...context.pianoRoll.notes];
                    let keyUpdate: { rootNote: number; scale: ScaleType } | undefined;

                    switch (action) {
                        case 'quantize':
                            const qValue = args.quantizeValue as QuantizeValue || QuantizeValue.Q_1_8;
                            newNotes = quantizeNotes(newNotes, context.pianoRoll.bpm, qValue);
                            break;

                        case 'transpose':
                            const semitones = args.semitones || 0;
                            newNotes = transposeNotes(newNotes, semitones);
                            break;

                        case 'changeKey':
                            const targetKey = (args.targetKey ?? 0) + 60; // Convert 0-11 to MIDI
                            newNotes = changeKey(newNotes, context.pianoRoll.rootNote, targetKey);
                            keyUpdate = { rootNote: targetKey, scale: context.pianoRoll.scale };
                            break;

                        case 'snapToScale':
                            const targetScale = args.targetScale as ScaleType || ScaleType.MAJOR;
                            newNotes = snapNotesToScale(newNotes, context.pianoRoll.rootNote, targetScale);
                            keyUpdate = { rootNote: context.pianoRoll.rootNote, scale: targetScale };
                            break;

                        case 'deleteAll':
                            newNotes = [];
                            break;

                        case 'deleteByRange':
                            const pitchMin = args.pitchMin ?? 0;
                            const pitchMax = args.pitchMax ?? 127;
                            newNotes = newNotes.filter(n => n.midiNote < pitchMin || n.midiNote > pitchMax);
                            break;
                    }

                    return {
                        text: responseMessage || `Notes ${action} complete.`,
                        notesUpdate: newNotes,
                        keyUpdate
                    };
                }

                case 'controlPlayback': {
                    const { action, responseMessage, bpm, instrument } = args;

                    const result: AssistantResponse = {
                        text: responseMessage || `Playback ${action}.`
                    };

                    if (action === 'play') {
                        result.playbackAction = 'play';
                    } else if (action === 'stop') {
                        result.playbackAction = 'stop';
                    } else if (action === 'setBpm' && bpm) {
                        result.bpmUpdate = Math.max(20, Math.min(300, bpm));
                    }

                    if (instrument) {
                        result.instrumentUpdate = instrument;
                    }

                    return result;
                }

                case 'addNote': {
                    const { pitch, startBeat, durationBeats, velocity = 100, responseMessage } = args;

                    // Convert beats to seconds
                    const secondsPerBeat = 60 / context.pianoRoll.bpm;
                    const startTime = startBeat * secondsPerBeat;
                    const duration = durationBeats * secondsPerBeat;

                    const newNote: NoteEvent = {
                        midiNote: pitch,
                        startTime,
                        duration,
                        velocity: Math.max(1, Math.min(127, velocity))
                    };

                    // Add note and sort by start time
                    const updatedNotes = [...context.pianoRoll.notes, newNote]
                        .sort((a, b) => a.startTime - b.startTime);

                    return {
                        text: responseMessage || `Added note.`,
                        notesUpdate: updatedNotes
                    };
                }

                case 'deleteNote': {
                    const { noteIndex, matchPitch, matchBeat, responseMessage } = args;
                    let updatedNotes = [...context.pianoRoll.notes];

                    if (noteIndex !== undefined && noteIndex >= 0 && noteIndex < updatedNotes.length) {
                        // Delete by index
                        updatedNotes.splice(noteIndex, 1);
                    } else if (matchPitch !== undefined) {
                        // Delete by pitch and optional beat match
                        const secondsPerBeat = 60 / context.pianoRoll.bpm;
                        const matchTime = matchBeat !== undefined ? matchBeat * secondsPerBeat : undefined;

                        const indexToDelete = updatedNotes.findIndex(n => {
                            if (n.midiNote !== matchPitch) return false;
                            if (matchTime !== undefined) {
                                // Allow 0.1 beat tolerance
                                return Math.abs(n.startTime - matchTime) < (0.1 * secondsPerBeat);
                            }
                            return true; // Just match pitch
                        });

                        if (indexToDelete >= 0) {
                            updatedNotes.splice(indexToDelete, 1);
                        }
                    }

                    return {
                        text: responseMessage || `Note deleted.`,
                        notesUpdate: updatedNotes
                    };
                }

                case 'getStatus': {
                    // Just return the response message - the AI already has the context
                    return {
                        text: args.responseMessage || "Here's the current status."
                    };
                }
            }
        }

        // Standard text response (no tool call)
        return {
            text: response.text || "I heard you, but I'm not sure how to help with that specific request."
        };

    } catch (error: any) {
        console.error(`[Assistant] Request failed:`, error.message || error);
        return { text: `Failed: ${error?.message || 'Unknown error'}` };
    }
};
