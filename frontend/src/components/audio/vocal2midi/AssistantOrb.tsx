import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Send, X, Play, Square } from 'lucide-react';
import type { ProcessingConfig, NoteEvent, ScaleType } from './types';
import { askAssistant, type AssistantContext, type AssistantResponse } from './geminiAssistant';

interface PianoRollControls {
    notes: NoteEvent[];
    bpm: number;
    rootNote: number;
    scale: ScaleType;
    isPlaying: boolean;
    onNotesChange: (notes: NoteEvent[]) => void;
    onBpmChange: (bpm: number) => void;
    onKeyChange: (rootNote: number, scale: ScaleType) => void;
    onPlay: () => void;
    onStop: () => void;
    onInstrumentChange: (instrument: string) => void;
}

interface AssistantOrbProps {
    currentConfig: ProcessingConfig;
    onConfigUpdate: (updates: Partial<ProcessingConfig>) => void;
    pianoRollControls: PianoRollControls;
}

export const AssistantOrb: React.FC<AssistantOrbProps> = ({
    currentConfig,
    onConfigUpdate,
    pianoRollControls
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<{ role: 'user' | 'ai', text: string, actions?: string[] }[]>([
        { role: 'ai', text: "I am the Architect. I can control all settings, edit your MIDI notes, change tempo, transpose keys, and preview your work. What would you like me to do?" }
    ]);
    const [input, setInput] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isOpen]);

    const handleSend = async () => {
        if (!input.trim()) return;

        const userMsg = input;
        setInput('');
        setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
        setIsThinking(true);

        // Build context for the assistant
        const context: AssistantContext = {
            config: currentConfig,
            pianoRoll: {
                notes: pianoRollControls.notes,
                bpm: pianoRollControls.bpm,
                rootNote: pianoRollControls.rootNote,
                scale: pianoRollControls.scale,
                isPlaying: pianoRollControls.isPlaying
            }
        };

        const response = await askAssistant(userMsg, context);

        setIsThinking(false);

        // Track what actions were taken
        const actions: string[] = [];

        // Apply all the response updates
        if (response.configUpdates) {
            onConfigUpdate(response.configUpdates);
            actions.push('Updated settings');
        }

        if (response.notesUpdate !== undefined) {
            console.log('[AssistantOrb] Updating notes:', response.notesUpdate.length, 'notes');
            console.log('[AssistantOrb] First note before:', pianoRollControls.notes[0]);
            console.log('[AssistantOrb] First note after:', response.notesUpdate[0]);
            pianoRollControls.onNotesChange(response.notesUpdate);
            if (response.notesUpdate.length === 0) {
                actions.push('Cleared all notes');
            } else {
                actions.push(`Modified ${response.notesUpdate.length} notes`);
            }
        }

        if (response.bpmUpdate !== undefined) {
            pianoRollControls.onBpmChange(response.bpmUpdate);
            actions.push(`Set BPM to ${response.bpmUpdate}`);
        }

        if (response.keyUpdate) {
            pianoRollControls.onKeyChange(response.keyUpdate.rootNote, response.keyUpdate.scale);
            const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
            actions.push(`Changed key to ${noteNames[response.keyUpdate.rootNote % 12]} ${response.keyUpdate.scale}`);
        }

        if (response.playbackAction === 'play') {
            pianoRollControls.onPlay();
            actions.push('Started playback');
        } else if (response.playbackAction === 'stop') {
            pianoRollControls.onStop();
            actions.push('Stopped playback');
        }

        if (response.instrumentUpdate) {
            pianoRollControls.onInstrumentChange(response.instrumentUpdate);
            actions.push(`Changed instrument to ${response.instrumentUpdate}`);
        }

        setMessages(prev => [...prev, {
            role: 'ai',
            text: response.text,
            actions: actions.length > 0 ? actions : undefined
        }]);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // Quick action buttons
    const quickActions = [
        { label: 'Play', action: 'play the preview', icon: Play },
        { label: 'Stop', action: 'stop playback', icon: Square },
    ];

    return (
        <>
            {/* The Orb Trigger */}
            <div
                className={`fixed bottom-8 right-8 z-50 transition-all duration-300 ${isOpen ? 'scale-0 opacity-0' : 'scale-100 opacity-100'}`}
            >
                <button
                    onClick={() => setIsOpen(true)}
                    title="Open AI Assistant"
                    className="relative w-16 h-16 rounded-full bg-black border border-violet-500 shadow-[0_0_30px_rgba(139,92,246,0.5)] flex items-center justify-center group overflow-hidden"
                >
                    <div className="absolute inset-0 bg-linear-to-tr from-violet-500/20 to-cyan-500/20 animate-pulse" />
                    <Sparkles className="text-violet-400 group-hover:text-white transition-colors relative z-10" size={24} />
                </button>
            </div>

            {/* Chat Interface */}
            <div
                className={`fixed bottom-8 right-8 w-80 md:w-96 h-137.5 bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl z-50 flex flex-col transition-all duration-300 origin-bottom-right ${isOpen ? 'scale-100 opacity-100' : 'scale-90 opacity-0 pointer-events-none'
                    }`}
            >
                {/* Header */}
                <div className="p-4 border-b border-white/10 flex justify-between items-center bg-black/40 rounded-t-2xl">
                    <div className="flex items-center gap-2">
                        <Sparkles size={16} className="text-violet-400" />
                        <span className="font-bold text-sm tracking-wide">ARCHITECT_AI</span>
                        <span className="text-[9px] text-gray-500 bg-zinc-950 px-2 py-0.5 rounded">FULL CONTROL</span>
                    </div>
                    <button
                        onClick={() => setIsOpen(false)}
                        title="Close assistant"
                        className="text-gray-500 hover:text-white transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Status Bar */}
                <div className="px-4 py-2 bg-black/20 border-b border-white/10 flex items-center justify-between text-[10px] font-mono">
                    <span className="text-gray-500">
                        {pianoRollControls.notes.length} notes | {pianoRollControls.bpm} BPM
                    </span>
                    <span className={pianoRollControls.isPlaying ? 'text-cyan-400' : 'text-gray-600'}>
                        {pianoRollControls.isPlaying ? '▶ PLAYING' : '■ STOPPED'}
                    </span>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {messages.map((m, i) => (
                        <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[85%] rounded-lg p-3 text-xs leading-relaxed ${m.role === 'user'
                                    ? 'bg-violet-500/20 text-white border border-violet-500/30'
                                    : 'bg-black border border-white/10 text-gray-300'
                                }`}>
                                {m.text}
                                {m.actions && m.actions.length > 0 && (
                                    <div className="mt-2 pt-2 border-t border-white/5">
                                        <div className="text-[9px] text-cyan-400 font-mono">
                                            {m.actions.map((action, j) => (
                                                <div key={j}>✓ {action}</div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {isThinking && (
                        <div className="flex justify-start">
                            <div className="bg-black border border-white/10 rounded-lg p-3 flex gap-1">
                                <div className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" />
                                <div className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce delay-150" />
                                <div className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce delay-300" />
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Quick Commands */}
                <div className="px-3 py-2 border-t border-white/10 bg-black/20">
                    <div className="flex gap-1 flex-wrap">
                        <button
                            onClick={() => { setInput('play the preview'); }}
                            className="text-[9px] px-2 py-1 bg-zinc-800 hover:bg-cyan-500 hover:text-black rounded transition-colors"
                        >
                            ▶ Play
                        </button>
                        <button
                            onClick={() => { setInput('stop'); }}
                            className="text-[9px] px-2 py-1 bg-zinc-800 hover:bg-cyan-500 hover:text-black rounded transition-colors"
                        >
                            ■ Stop
                        </button>
                        <button
                            onClick={() => { setInput('quantize to 1/16'); }}
                            className="text-[9px] px-2 py-1 bg-zinc-800 hover:bg-cyan-500 hover:text-black rounded transition-colors"
                        >
                            Quantize
                        </button>
                        <button
                            onClick={() => { setInput('transpose up one octave'); }}
                            className="text-[9px] px-2 py-1 bg-zinc-800 hover:bg-cyan-500 hover:text-black rounded transition-colors"
                        >
                            +Octave
                        </button>
                        <button
                            onClick={() => { setInput('set tempo to 140 bpm'); }}
                            className="text-[9px] px-2 py-1 bg-zinc-800 hover:bg-cyan-500 hover:text-black rounded transition-colors"
                        >
                            140 BPM
                        </button>
                        <button
                            onClick={() => { setInput('change to A minor'); }}
                            className="text-[9px] px-2 py-1 bg-zinc-800 hover:bg-cyan-500 hover:text-black rounded transition-colors"
                        >
                            A minor
                        </button>
                    </div>
                </div>

                {/* Input */}
                <div className="p-3 border-t border-white/10 bg-black/40 rounded-b-2xl">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Try: 'make it faster' or 'change to E major'"
                            className="flex-1 bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-violet-500 transition-colors"
                        />
                        <button
                            onClick={handleSend}
                            disabled={!input.trim() || isThinking}
                            title="Send message"
                            className="bg-violet-500 hover:bg-violet-400 text-white p-2 rounded-lg transition-colors disabled:opacity-50"
                        >
                            <Send size={16} />
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
};
