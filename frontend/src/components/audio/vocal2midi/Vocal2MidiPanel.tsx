/**
 * Vocal2MidiPanel — the full vocal2midi-architect suite, natively integrated into
 * theDAW's MIDI tab as a compact, collapsible control column. The ported recorder
 * runs YIN pitch detection (exact sensitivity/threshold math from the source); the
 * resulting notes are written into theDAW's EXISTING piano roll (pianoRollStore).
 * Every control from the suite is here: capture (mic + level visualizer +
 * sensitivity + cleanup), musical settings (key/scale/genre/profile/quantize),
 * editor tools (quantize/transpose/snap/change-key/related-keys), AI (analyze on
 * record, smart cleanup, assistant orb) on theDAW's Gemini, export (MIDI/WAV),
 * tap tempo, and recording history. Instrument selection uses theDAW's full GM
 * soundfont picker. AI calls convert audio to WAV first (gemini-3.5-flash audio).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic, Square, ChevronDown, ChevronRight, Download, Wand2, Loader2, Trash2,
  Activity, Music4, Save,
} from 'lucide-react';

import {
  type NoteEvent,
  type ProcessingConfig,
  type AudioAnalysisResult,
  type RecordingEntry,
  QuantizeValue,
  ScaleType,
  Genre,
} from './types';
import { NOTE_NAMES, SOUND_PROFILES, GENRE_PROFILES } from './constants';
import {
  detectPitch, frequencyToMidi, cleanupNotes, snapToScale, processNotesWithProfile, generateMidiFile,
} from './audioProcessing';
import { quantizeNotes, transposeNotes, snapNotesToScale, changeKey, getKeyName } from './midiEditor';
import { detectKeyAndScale, getRelatedKeys } from './musicTheory';
import { getMidiSynth } from './midiSynth';
import { analyzeAudioWithGemini, smartCleanupMidi, type AnalysisContext } from './geminiService';
import { Visualizer } from './Visualizer';
import { BpmTapper } from './BpmTapper';
import { RecordingHistory } from './RecordingHistory';
import { AssistantOrb } from './AssistantOrb';

import { usePianoRollStore, type PianoNote } from '../../../state/pianoRollStore';
import { encodeWav } from '../../../lib/wavEncode';
import { logInfo, logWarn } from '../../../state/logStore';
import { InstrumentPicker } from '../InstrumentPicker';

const HISTORY_KEY = 'vocal2midi_recordings';

const DEFAULT_CONFIG: ProcessingConfig = {
  rootNote: 60,
  scale: ScaleType.CHROMATIC,
  genre: Genre.NONE,
  quantizeMode: 'AUTO',
  manualQuantizeValue: QuantizeValue.OFF,
  useGeminiForBpm: true,
  manualBpm: 120,
  prompt: '',
  autoKeyDetection: true,
  activeProfileId: 'DEFAULT',
  sensitivity: 35,
  experimentalPitchBend: false,
  enableCleanup: true,
};

/* ── helpers ──────────────────────────────────────────────────────────────── */

const stepSec = (bpm: number): number => 60 / Math.max(1, bpm) / 4;

/** Bridge: vocal2midi NoteEvent[] (absolute seconds) -> theDAW step-based notes. */
const toPianoNotes = (notes: NoteEvent[], bpm: number): PianoNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n, i) => ({
    id: `v2m-${i}-${n.startTime.toFixed(3)}-${n.midiNote}`,
    note: Math.max(0, Math.min(127, Math.round(n.midiNote))),
    step: Math.max(0, Math.round(n.startTime / ss)),
    length: Math.max(1, Math.round(n.duration / ss)),
    velocity: Math.max(1, Math.min(127, Math.round(n.velocity))),
  }));
};

/** gemini-3.5-flash accepts wav/mp3/ogg/flac (not webm) — convert before AI. */
async function toWavBlob(blob: Blob): Promise<Blob> {
  const ab = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(ab.slice(0));
    return encodeWav(buf);
  } finally {
    void ctx.close().catch(() => {});
  }
}

const QUANT_BUTTONS: { label: string; value: QuantizeValue }[] = [
  { label: '1/4', value: QuantizeValue.Q_1_4 },
  { label: '1/8', value: QuantizeValue.Q_1_8 },
  { label: '1/16', value: QuantizeValue.Q_1_16 },
  { label: '1/32', value: QuantizeValue.Q_1_32 },
];

const Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }> = ({
  title, defaultOpen = true, children,
}) => (
  <details open={defaultOpen} className="rounded border border-white/10 bg-black/30">
    <summary className="cursor-pointer select-none px-2 py-1 text-[9px] font-mono font-bold uppercase tracking-widest text-cyan-300/80 hover:text-cyan-200">
      {title}
    </summary>
    <div className="px-2 pb-2 pt-1 space-y-1.5">{children}</div>
  </details>
);

const labelCls = 'text-[9px] font-mono uppercase tracking-wide text-zinc-400';
const selectCls = 'w-full bg-zinc-800 border border-zinc-600 rounded text-[10px] font-mono text-zinc-100 px-1 py-0.5';
const chip = 'px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors cursor-pointer';
const chipOff = 'border-white/15 bg-white/5 text-zinc-200 hover:border-cyan-500/40';
const chipOn = 'border-cyan-400 bg-cyan-500 text-black font-bold';

/* ── component ────────────────────────────────────────────────────────────── */

export const Vocal2MidiPanel: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [config, setConfig] = useState<ProcessingConfig>({ ...DEFAULT_CONFIG });
  const [capturedNotes, setCapturedNotes] = useState<NoteEvent[]>([]);
  const [processedNotes, setProcessedNotes] = useState<NoteEvent[]>([]);
  const [audioAnalysis, setAudioAnalysis] = useState<AudioAnalysisResult | null>(null);
  const [detectedKeyString, setDetectedKeyString] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSmartCleaning, setIsSmartCleaning] = useState(false);
  const [lastCleanupSummary, setLastCleanupSummary] = useState<string | null>(null);
  const [status, setStatus] = useState('ready');
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [recordings, setRecordings] = useState<RecordingEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch {
      return [];
    }
  });

  // recorder refs (ported from the source App)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const currentNoteRef = useRef<{ note: number; startTime: number } | null>(null);
  const startTimeRef = useRef(0);
  const bufferRef = useRef<NoteEvent[]>([]);
  const sensitivityRef = useRef(config.sensitivity);
  const lastBlobRef = useRef<Blob | null>(null);

  useEffect(() => { sensitivityRef.current = config.sensitivity; }, [config.sensitivity]);
  useEffect(() => { localStorage.setItem(HISTORY_KEY, JSON.stringify(recordings)); }, [recordings]);

  const bpm = audioAnalysis?.detectedBpm || config.manualBpm || 120;

  /** Write notes into theDAW's existing piano roll. */
  const applyToRoll = useCallback((notes: NoteEvent[], atBpm: number) => {
    usePianoRollStore.getState().importNotes(toPianoNotes(notes, atBpm), atBpm);
  }, []);

  /* ── recorder (ported YIN capture) ─────────────────────────────────────── */
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audioCtxRef.current = ctx;

      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      analyserRef.current = an;
      setAnalyser(an);

      const src = ctx.createMediaStreamSource(stream);
      sourceRef.current = src;
      src.connect(an);

      const proc = ctx.createScriptProcessor(2048, 1, 1);
      processorRef.current = proc;
      src.connect(proc);
      proc.connect(ctx.destination);

      startTimeRef.current = ctx.currentTime;
      bufferRef.current = [];
      currentNoteRef.current = null;
      isRecordingRef.current = true;
      setIsRecording(true);
      setAudioAnalysis(null);
      setProcessedNotes([]);
      setDetectedKeyString('');
      setStatus('listening...');

      proc.onaudioprocess = (e) => {
        if (!isRecordingRef.current) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const sampleRate = ctx.sampleRate;
        const currentTime = ctx.currentTime - startTimeRef.current;
        const s = sensitivityRef.current / 100;
        const gateThreshold = 0.05 - s * 0.049;
        const minConfidence = 0.9 - s * 0.5;
        const minDuration = 0.04 - s * 0.03;
        const frequency = detectPitch(inputData, sampleRate, minConfidence);
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / inputData.length);
        if (rms > gateThreshold && frequency) {
          const midiNote = frequencyToMidi(frequency);
          if (midiNote < 21 || midiNote > 108) return;
          const pitchChangeThreshold = 2;
          if (currentNoteRef.current) {
            const pitchDiff = Math.abs(currentNoteRef.current.note - midiNote);
            if (pitchDiff > pitchChangeThreshold) {
              const duration = currentTime - currentNoteRef.current.startTime;
              if (duration > minDuration) {
                bufferRef.current.push({ midiNote: currentNoteRef.current.note, startTime: currentNoteRef.current.startTime, duration, velocity: 100 });
              }
              currentNoteRef.current = { note: midiNote, startTime: currentTime };
            }
          } else {
            currentNoteRef.current = { note: midiNote, startTime: currentTime };
          }
        } else if (currentNoteRef.current) {
          const duration = currentTime - currentNoteRef.current.startTime;
          if (duration > minDuration) {
            bufferRef.current.push({ midiNote: currentNoteRef.current.note, startTime: currentNoteRef.current.startTime, duration, velocity: 100 });
          }
          currentNoteRef.current = null;
        }
      };

      const rec = new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
      rec.start();
    } catch (err) {
      logWarn('vocal2midi', `mic error: ${String(err)}`);
      setStatus('mic error - check permission');
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const rec = mediaRecorderRef.current;
    const ctx = audioCtxRef.current;
    if (!rec || !ctx) return;
    isRecordingRef.current = false;
    setIsRecording(false);
    setIsProcessing(true);
    setStatus('analyzing...');

    const s = sensitivityRef.current / 100;
    const minDuration = 0.04 - s * 0.03;
    if (currentNoteRef.current) {
      const currentTime = ctx.currentTime - startTimeRef.current;
      const duration = currentTime - currentNoteRef.current.startTime;
      if (duration > minDuration) {
        bufferRef.current.push({ midiNote: currentNoteRef.current.note, startTime: currentNoteRef.current.startTime, duration, velocity: 100 });
      }
      currentNoteRef.current = null;
    }

    rec.stop();
    sourceRef.current?.disconnect();
    processorRef.current?.disconnect();
    await new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
    streamRef.current?.getTracks().forEach((t) => t.stop());

    const webm = new Blob(chunksRef.current, { type: 'audio/webm' });
    lastBlobRef.current = webm;

    const rawUncleaned = [...bufferRef.current];
    let rawNotes: NoteEvent[];
    if (config.enableCleanup) {
      rawNotes = cleanupNotes(rawUncleaned, 0.05, 0.1);
    } else {
      rawNotes = rawUncleaned;
    }
    if (rawNotes.length === 0) {
      setStatus(`no notes detected (try raising sensitivity, now ${config.sensitivity}%)`);
      setIsProcessing(false);
      return;
    }

    // Gemini metadata (BPM/profile) — convert to WAV first (gemini-3.5-flash audio)
    let analysis: AudioAnalysisResult;
    if (config.useGeminiForBpm) {
      try {
        const wav = await toWavBlob(webm);
        const aCtx: AnalysisContext = {
          genre: config.genre, scale: config.scale, quantizeMode: config.quantizeMode,
          manualQuantizeValue: config.manualQuantizeValue, sensitivity: config.sensitivity,
          autoKeyDetection: config.autoKeyDetection,
        };
        analysis = await analyzeAudioWithGemini(wav, config.prompt, aCtx);
      } catch (e) {
        logWarn('vocal2midi', `Gemini analysis failed, using local defaults: ${String(e)}`);
        analysis = { detectedBpm: config.manualBpm || 120, timeSignature: '4/4', suggestedInstrument: 'Grand Piano', description: 'Local (AI unavailable)', detectedProfileId: 'DEFAULT' };
      }
    } else {
      analysis = { detectedBpm: config.manualBpm || 120, timeSignature: '4/4', suggestedInstrument: 'Unknown', description: 'Local processing', detectedProfileId: 'DEFAULT' };
    }
    setAudioAnalysis(analysis);

    let finalRoot = config.rootNote;
    let finalScale = config.scale;
    if (config.autoKeyDetection) {
      const k = detectKeyAndScale(rawNotes);
      finalRoot = k.root + 60;
      finalScale = k.scale;
      setDetectedKeyString(`${NOTE_NAMES[k.root]} ${k.scale} (${Math.round(k.confidence * 100)}%)`);
    }

    const profileId = analysis.detectedProfileId && SOUND_PROFILES[analysis.detectedProfileId] ? analysis.detectedProfileId : 'DEFAULT';
    const profile = SOUND_PROFILES[profileId];
    const finalQuant = config.quantizeMode === 'AUTO' ? profile.suggestedQuantization : config.manualQuantizeValue;

    setConfig((prev) => ({ ...prev, rootNote: finalRoot, scale: finalScale, activeProfileId: profileId }));

    const scaled = rawNotes.map((n) => ({ ...n, midiNote: snapToScale(n.midiNote, finalRoot, finalScale) }));
    const finalNotes = processNotesWithProfile(scaled, analysis.detectedBpm, finalQuant, profile);

    setCapturedNotes(rawNotes);
    setProcessedNotes(finalNotes);
    applyToRoll(finalNotes, analysis.detectedBpm);

    if (finalNotes.length > 0) {
      setRecordings((prev) => [{
        id: `rec_${Date.now()}`, timestamp: Date.now(), name: `Recording ${prev.length + 1}`,
        notes: [...finalNotes], bpm: analysis.detectedBpm, rootNote: finalRoot, scale: finalScale,
        genre: config.genre, profileId,
      }, ...prev]);
    }
    setStatus(`captured ${finalNotes.length} notes -> piano roll`);
    setIsProcessing(false);
    logInfo('vocal2midi', `captured ${finalNotes.length} notes @ ${analysis.detectedBpm} BPM -> piano roll`);
  }, [config, applyToRoll]);

  // Re-process on setting change (mirrors the source effect; AUTO forces OFF).
  useEffect(() => {
    if (capturedNotes.length === 0) return;
    const b = audioAnalysis?.detectedBpm || 120;
    const scaled = capturedNotes.map((n) => ({ ...n, midiNote: snapToScale(n.midiNote, config.rootNote, config.scale) }));
    const profile = SOUND_PROFILES[config.activeProfileId] || SOUND_PROFILES['DEFAULT'];
    const q = config.quantizeMode === 'AUTO' ? QuantizeValue.OFF : config.manualQuantizeValue;
    const finalNotes = processNotesWithProfile(scaled, b, q, profile);
    setProcessedNotes(finalNotes);
    applyToRoll(finalNotes, b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.rootNote, config.scale, config.quantizeMode, config.manualQuantizeValue, config.activeProfileId, capturedNotes, audioAnalysis]);

  /* ── editor tools (operate on processedNotes -> roll) ──────────────────── */
  const pushNotes = useCallback((notes: NoteEvent[], atBpm = bpm) => {
    setProcessedNotes(notes);
    applyToRoll(notes, atBpm);
  }, [applyToRoll, bpm]);

  const doQuantize = (q: QuantizeValue) => pushNotes(quantizeNotes(processedNotes, bpm, q));
  const doTranspose = (semis: number) => pushNotes(transposeNotes(processedNotes, semis));
  const doSnap = () => pushNotes(snapNotesToScale(processedNotes, config.rootNote, config.scale));
  const doChangeKey = (toRoot: number, toScale: ScaleType) => {
    pushNotes(changeKey(processedNotes, config.rootNote, toRoot));
    setConfig((p) => ({ ...p, rootNote: toRoot, scale: toScale }));
  };

  const handleSmartCleanup = useCallback(async () => {
    if (!lastBlobRef.current || processedNotes.length === 0) return;
    setIsSmartCleaning(true);
    setStatus('AI cleaning...');
    try {
      const wav = await toWavBlob(lastBlobRef.current);
      const res = await smartCleanupMidi(wav, processedNotes, config.prompt, bpm);
      pushNotes(res.cleanedNotes);
      setCapturedNotes(res.cleanedNotes);
      setLastCleanupSummary(res.summary);
      setStatus(`AI cleanup: ${res.summary}`);
    } catch (e) {
      setStatus(`AI cleanup failed: ${String(e)}`);
    } finally {
      setIsSmartCleaning(false);
    }
  }, [processedNotes, config.prompt, bpm, pushNotes]);

  const handleExportMidi = () => {
    if (processedNotes.length === 0) return;
    const profile = SOUND_PROFILES[config.activeProfileId] || SOUND_PROFILES['DEFAULT'];
    const blob = generateMidiFile(processedNotes, bpm, profile, { experimentalPitchBend: config.experimentalPitchBend });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `vocal2midi_${Date.now()}.mid`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const handleExportWav = async () => {
    if (processedNotes.length === 0) return;
    setStatus('rendering WAV...');
    try {
      const blob = await getMidiSynth().renderToWav(processedNotes);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `vocal2midi_${Date.now()}.wav`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      setStatus('WAV exported');
    } catch (e) {
      setStatus(`WAV export failed: ${String(e)}`);
    }
  };

  const playPreview = () => { void getMidiSynth().playNotes(processedNotes); };
  const stopPreview = () => getMidiSynth().stop();

  /* ── recording history ─────────────────────────────────────────────────── */
  const loadRecording = (r: RecordingEntry) => {
    setCapturedNotes(r.notes);
    setProcessedNotes(r.notes);
    setAudioAnalysis((prev) => ({ detectedBpm: r.bpm, timeSignature: prev?.timeSignature || '4/4', suggestedInstrument: prev?.suggestedInstrument || '', description: 'loaded from history', detectedProfileId: r.profileId }));
    setConfig((p) => ({ ...p, rootNote: r.rootNote, scale: r.scale, genre: r.genre, activeProfileId: r.profileId }));
    applyToRoll(r.notes, r.bpm);
    setStatus(`loaded "${r.name}" -> piano roll`);
  };

  const patch = (p: Partial<ProcessingConfig>) => setConfig((prev) => ({ ...prev, ...p }));
  const relatedKeys = config.scale !== ScaleType.CHROMATIC ? getRelatedKeys(config.rootNote, config.scale).slice(0, 4) : [];

  /* ── render ────────────────────────────────────────────────────────────── */
  if (collapsed) {
    return (
      <div className="h-full w-9 shrink-0 border-l border-white/8 bg-zinc-950 flex flex-col items-center gap-2 py-2">
        <button type="button" onClick={() => setCollapsed(false)} title="Expand Vocal2MIDI" aria-label="Expand Vocal2MIDI"
          className="text-cyan-300 hover:text-cyan-200"><ChevronRight className="w-4 h-4 rotate-180" /></button>
        <button type="button" onClick={() => (isRecording ? void stopRecording() : void startRecording())}
          title={isRecording ? 'Stop' : 'Record'} aria-label={isRecording ? 'Stop recording' : 'Record'}
          className={`grid place-items-center w-6 h-6 rounded border ${isRecording ? 'border-red-500 text-red-300 bg-red-600/25' : 'border-cyan-600 text-cyan-300 hover:bg-cyan-600/15'}`}>
          {isRecording ? <Square className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
        </button>
        <span className="text-[8px] font-mono text-zinc-600 [writing-mode:vertical-rl] rotate-180 tracking-widest">VOCAL2MIDI</span>
      </div>
    );
  }

  return (
    <div className="h-full w-72 shrink-0 border-l border-white/8 bg-zinc-950 flex flex-col min-h-0">
      {/* header */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-white/10">
        <button type="button" onClick={() => setCollapsed(true)} title="Collapse" aria-label="Collapse Vocal2MIDI"
          className="text-zinc-500 hover:text-zinc-200"><ChevronDown className="w-3.5 h-3.5 -rotate-90" /></button>
        <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-cyan-300">Vocal2MIDI</span>
        <div className="flex-1" />
        <button type="button" onClick={() => (isRecording ? void stopRecording() : void startRecording())}
          disabled={isProcessing}
          aria-label={isRecording ? 'Stop recording' : 'Record'}
          className={`grid place-items-center w-7 h-7 rounded border transition-colors disabled:opacity-40 ${isRecording ? 'border-red-500 text-red-300 bg-red-600/25' : 'border-cyan-600 text-cyan-300 hover:bg-cyan-600/15'}`}>
          {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isRecording ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        <Section title="Capture">
          <Visualizer analyser={analyser} isRecording={isRecording} threshold={0.05 - (config.sensitivity / 100) * 0.049} />
          <div className="flex items-center gap-2">
            <label htmlFor="v2m-sens" className={labelCls}>Sensitivity</label>
            <input id="v2m-sens" name="v2m-sens" type="range" min={0} max={100} value={config.sensitivity}
              onChange={(e) => patch({ sensitivity: parseInt(e.target.value, 10) })} className="flex-1 accent-cyan-500" />
            <span className="w-8 text-right text-[9px] font-mono text-cyan-300">{config.sensitivity}%</span>
          </div>
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-300">
            <input type="checkbox" name="v2m-cleanup" checked={config.enableCleanup} onChange={(e) => patch({ enableCleanup: e.target.checked })} className="accent-cyan-500" />
            Note cleanup
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-300">
            <input type="checkbox" name="v2m-pitchbend" checked={config.experimentalPitchBend} onChange={(e) => patch({ experimentalPitchBend: e.target.checked })} className="accent-cyan-500" />
            Pitch bend (experimental)
          </label>
          <span className="block text-[9px] font-mono text-zinc-500 truncate" title={status}>{status}</span>
        </Section>

        <Section title="Musical">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-300 flex-1">
              <input type="checkbox" name="v2m-autokey" checked={config.autoKeyDetection} onChange={(e) => patch({ autoKeyDetection: e.target.checked })} className="accent-cyan-500" />
              Auto key
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-300 flex-1">
              <input type="checkbox" name="v2m-autobpm" checked={config.useGeminiForBpm} onChange={(e) => patch({ useGeminiForBpm: e.target.checked })} className="accent-cyan-500" />
              Auto BPM (AI)
            </label>
          </div>
          {detectedKeyString && <span className="block text-[9px] font-mono text-emerald-400">key: {detectedKeyString}</span>}
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label htmlFor="v2m-root" className={labelCls}>Root</label>
              <select id="v2m-root" name="v2m-root" className={selectCls} value={config.rootNote} onChange={(e) => patch({ rootNote: parseInt(e.target.value, 10) })} style={{ colorScheme: 'dark' }}>
                {NOTE_NAMES.map((n, i) => <option key={n} value={60 + i}>{n}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="v2m-scale" className={labelCls}>Scale</label>
              <select id="v2m-scale" name="v2m-scale" className={selectCls} value={config.scale} onChange={(e) => patch({ scale: e.target.value as ScaleType })} style={{ colorScheme: 'dark' }}>
                {Object.values(ScaleType).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="v2m-genre" className={labelCls}>Genre</label>
              <select id="v2m-genre" name="v2m-genre" className={selectCls} value={config.genre}
                onChange={(e) => { const g = e.target.value as Genre; patch({ genre: g, activeProfileId: GENRE_PROFILES[g].suggestedProfileId }); }} style={{ colorScheme: 'dark' }}>
                {Object.values(Genre).map((g) => <option key={g} value={g}>{GENRE_PROFILES[g].name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="v2m-profile" className={labelCls}>Profile</label>
              <select id="v2m-profile" name="v2m-profile" className={selectCls} value={config.activeProfileId} onChange={(e) => patch({ activeProfileId: e.target.value })} style={{ colorScheme: 'dark' }}>
                {Object.values(SOUND_PROFILES).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <span className={labelCls}>Quantize</span>
            <div className="flex gap-1 mt-0.5">
              <button type="button" onClick={() => patch({ quantizeMode: 'AUTO' })} className={`${chip} ${config.quantizeMode === 'AUTO' ? chipOn : chipOff}`}>Auto</button>
              <button type="button" onClick={() => patch({ quantizeMode: 'MANUAL' })} className={`${chip} ${config.quantizeMode === 'MANUAL' ? chipOn : chipOff}`}>Manual</button>
              {config.quantizeMode === 'MANUAL' && (
                <>
                  <button type="button" onClick={() => patch({ manualQuantizeValue: QuantizeValue.OFF })} className={`${chip} ${config.manualQuantizeValue === QuantizeValue.OFF ? chipOn : chipOff}`}>Off</button>
                  {QUANT_BUTTONS.map((q) => (
                    <button key={q.label} type="button" onClick={() => patch({ manualQuantizeValue: q.value })} className={`${chip} ${config.manualQuantizeValue === q.value ? chipOn : chipOff}`}>{q.label}</button>
                  ))}
                </>
              )}
            </div>
          </div>
          <div>
            <span className={labelCls}>Instrument (theDAW soundfonts)</span>
            <div className="mt-0.5"><InstrumentPicker /></div>
          </div>
        </Section>

        <Section title="Edit tools" defaultOpen={false}>
          <div className="flex flex-wrap gap-1">
            <span className={`${labelCls} w-full`}>Re-quantize</span>
            {QUANT_BUTTONS.map((q) => (
              <button key={q.label} type="button" onClick={() => doQuantize(q.value)} className={`${chip} ${chipOff}`} disabled={processedNotes.length === 0}>{q.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className={labelCls}>Transpose</span>
            <button type="button" onClick={() => doTranspose(-12)} className={`${chip} ${chipOff}`}>-12</button>
            <button type="button" onClick={() => doTranspose(-1)} className={`${chip} ${chipOff}`}>-1</button>
            <button type="button" onClick={() => doTranspose(1)} className={`${chip} ${chipOff}`}>+1</button>
            <button type="button" onClick={() => doTranspose(12)} className={`${chip} ${chipOff}`}>+12</button>
            <button type="button" onClick={doSnap} className={`${chip} ${chipOff}`} disabled={processedNotes.length === 0}>Snap to scale</button>
          </div>
          {relatedKeys.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className={labelCls}>Change key</span>
              {relatedKeys.map((rk) => (
                <button key={rk.relationship} type="button" title={rk.relationship} onClick={() => doChangeKey(rk.midiNote, rk.scale)} className={`${chip} ${chipOff}`}>
                  {NOTE_NAMES[rk.root]} {rk.scale}
                </button>
              ))}
            </div>
          )}
          <div className="text-[9px] font-mono text-zinc-500">current: {getKeyName(config.rootNote, config.scale)} · {processedNotes.length} notes</div>
        </Section>

        <Section title="AI">
          <input name="v2m-prompt" type="text" value={config.prompt} onChange={(e) => patch({ prompt: e.target.value })}
            placeholder="AI context / instruction (optional)" aria-label="AI prompt"
            className="w-full bg-zinc-800 border border-zinc-600 rounded text-[10px] text-zinc-100 px-1.5 py-1" />
          <button type="button" onClick={() => void handleSmartCleanup()} disabled={isSmartCleaning || !lastBlobRef.current || processedNotes.length === 0}
            className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wide rounded border border-violet-500/50 text-violet-200 hover:bg-violet-500/15 disabled:opacity-40">
            {isSmartCleaning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} Smart cleanup (AI)
          </button>
          {lastCleanupSummary && <span className="block text-[9px] text-zinc-400 wrap-break-word">{lastCleanupSummary}</span>}
          <span className="block text-[8px] font-mono text-zinc-600">AI uses theDAW's Gemini (gemini-3.5-flash). Needs GEMINI_API_KEY set on the server.</span>
        </Section>

        <Section title="Play & export" defaultOpen={false}>
          <div className="flex items-center gap-1">
            <button type="button" onClick={playPreview} disabled={processedNotes.length === 0} className={`${chip} ${chipOff} flex items-center gap-1`}><Activity className="w-3 h-3" /> Play</button>
            <button type="button" onClick={stopPreview} className={`${chip} ${chipOff} flex items-center gap-1`}><Square className="w-3 h-3" /> Stop</button>
            <BpmTapper currentBpm={bpm} onBpmSet={(b) => { setAudioAnalysis((prev) => prev ? { ...prev, detectedBpm: b } : { detectedBpm: b, timeSignature: '4/4', suggestedInstrument: '', description: 'tap tempo', detectedProfileId: config.activeProfileId }); patch({ manualBpm: b }); if (capturedNotes.length) applyToRoll(processedNotes, b); }} />
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={handleExportMidi} disabled={processedNotes.length === 0} className={`${chip} ${chipOff} flex items-center gap-1`}><Download className="w-3 h-3" /> MIDI</button>
            <button type="button" onClick={() => void handleExportWav()} disabled={processedNotes.length === 0} className={`${chip} ${chipOff} flex items-center gap-1`}><Music4 className="w-3 h-3" /> WAV</button>
            <button type="button" onClick={() => { setCapturedNotes([]); setProcessedNotes([]); usePianoRollStore.getState().clear(); setStatus('cleared'); }} className={`${chip} ${chipOff} flex items-center gap-1`}><Trash2 className="w-3 h-3" /> Clear</button>
          </div>
        </Section>

        <Section title="History" defaultOpen={false}>
          <RecordingHistory
            recordings={recordings}
            onLoad={loadRecording}
            onDelete={(id) => setRecordings((p) => p.filter((r) => r.id !== id))}
            onClearAll={() => setRecordings([])}
            onExportAll={() => {
              const blob = new Blob([JSON.stringify(recordings, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = 'vocal2midi_recordings.json'; a.click();
              setTimeout(() => URL.revokeObjectURL(url), 5000);
            }}
            onImport={(recs) => setRecordings((p) => [...recs, ...p])}
          />
        </Section>
      </div>

      {/* AI assistant orb — drives config + the piano-roll notes */}
      <AssistantOrb
        currentConfig={config}
        onConfigUpdate={(updates) => patch(updates)}
        pianoRollControls={{
          notes: processedNotes,
          bpm,
          rootNote: config.rootNote,
          scale: config.scale,
          isPlaying: false,
          onNotesChange: (notes) => pushNotes(notes),
          onBpmChange: (b) => { setAudioAnalysis((prev) => prev ? { ...prev, detectedBpm: b } : { detectedBpm: b, timeSignature: '4/4', suggestedInstrument: '', description: '', detectedProfileId: config.activeProfileId }); patch({ manualBpm: b }); },
          onKeyChange: (root, scale) => setConfig((p) => ({ ...p, rootNote: root, scale })),
          onPlay: playPreview,
          onStop: stopPreview,
          onInstrumentChange: (inst) => { void getMidiSynth().setInstrument(inst as Parameters<ReturnType<typeof getMidiSynth>['setInstrument']>[0]); },
        }}
      />
    </div>
  );
};
