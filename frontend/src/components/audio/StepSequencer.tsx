import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play, Square, Target,
  Trash2, Sparkles, Plus, Activity,
  Download, Send, Music,
} from 'lucide-react';
import { SlideTrack } from './SlideTrack';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx, getMasterGain } from '../../state/playerStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { logError, logInfo } from '../../state/logStore';
import { MidiMapper } from './MidiMapper';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';

const SEQUENCE_MIDI_PARAMS = [
  { key: 'bpm' as const, label: 'BPM', min: 40, max: 240, autoCc: 14, integer: true },
];

type Voice = 'kick' | 'snare' | 'hat' | 'tone' | 'noise';

interface Track {
  id: string;
  name: string;
  steps: boolean[];
  color: string;
  gain: number;
  voice: Voice;
  freq: number; // base frequency for tonal voices
}

const STEPS = 16;

const defaultTracks: Track[] = [
  { id: '1', name: 'Kick', steps: Array(STEPS).fill(false).map((_, i) => i % 4 === 0), color: '#ef4444', gain: 0.9, voice: 'kick', freq: 60 },
  { id: '2', name: 'Snare', steps: Array(STEPS).fill(false).map((_, i) => i === 4 || i === 12), color: '#f59e0b', gain: 0.7, voice: 'snare', freq: 180 },
  { id: '3', name: 'Hi-Hat', steps: Array(STEPS).fill(false).map((_, i) => i % 2 === 0), color: '#3b82f6', gain: 0.4, voice: 'hat', freq: 0 },
  { id: '4', name: 'Bass', steps: Array(STEPS).fill(false), color: '#8b5cf6', gain: 0.6, voice: 'tone', freq: 110 },
];

const VOICE_OPTIONS: Voice[] = ['kick', 'snare', 'hat', 'tone', 'noise'];
const NEW_TRACK_COLORS = ['#10b981', '#ec4899', '#06b6d4', '#a855f7', '#facc15', '#f97316'];

// All sequencer voices route through the shared engine master → analyser.
const getAudioCtx = (): AudioContext => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
};

/**
 * Schedule a single voice hit at time `when` on the supplied context, routed
 * to the supplied destination. Used for both live playback (engine context +
 * master gain) and offline rendering (OfflineAudioContext + its destination).
 */
const triggerVoice = (
  voice: Voice,
  freq: number,
  gain: number,
  masterGain: number,
  when: number,
  ctx: BaseAudioContext,
  dest: AudioNode,
): void => {
  const out = ctx.createGain();
  out.gain.value = gain * masterGain;
  out.connect(dest);

  switch (voice) {
    case 'kick': {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 2.5, when);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq), when + 0.12);
      const env = ctx.createGain();
      env.gain.setValueAtTime(1, when);
      env.gain.exponentialRampToValueAtTime(0.001, when + 0.25);
      osc.connect(env).connect(out);
      osc.start(when);
      osc.stop(when + 0.3);
      break;
    }
    case 'snare': {
      // Tonal body
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, when);
      const oscEnv = ctx.createGain();
      oscEnv.gain.setValueAtTime(0.6, when);
      oscEnv.gain.exponentialRampToValueAtTime(0.001, when + 0.12);
      osc.connect(oscEnv).connect(out);
      osc.start(when); osc.stop(when + 0.15);
      // Noise body
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * 0.6;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1500;
      const noiseEnv = ctx.createGain();
      noiseEnv.gain.setValueAtTime(0.8, when);
      noiseEnv.gain.exponentialRampToValueAtTime(0.001, when + 0.15);
      noise.connect(hp).connect(noiseEnv).connect(out);
      noise.start(when); noise.stop(when + 0.2);
      break;
    }
    case 'hat': {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.8, when);
      env.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
      noise.connect(hp).connect(env).connect(out);
      noise.start(when); noise.stop(when + 0.08);
      break;
    }
    case 'tone': {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, when);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.001, when);
      env.gain.exponentialRampToValueAtTime(0.8, when + 0.005);
      env.gain.exponentialRampToValueAtTime(0.001, when + 0.4);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      osc.connect(lp).connect(env).connect(out);
      osc.start(when); osc.stop(when + 0.45);
      break;
    }
    case 'noise': {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * 0.5;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.7, when);
      env.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
      noise.connect(env).connect(out);
      noise.start(when); noise.stop(when + 0.3);
      break;
    }
  }
};

// =============================================================================
// MIDI export — Standard MIDI File encoder
// =============================================================================

const writeVLQ = (value: number): number[] => {
  // Variable-length quantity, 7-bit chunks, MSB=1 on all but last.
  if (value < 0) value = 0;
  const out: number[] = [];
  let v = value;
  out.push(v & 0x7f);
  v >>>= 7;
  while (v > 0) {
    out.unshift(0x80 | (v & 0x7f));
    v >>>= 7;
  }
  return out;
};

const writeUint32BE = (v: number): number[] => [
  (v >>> 24) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 8) & 0xff,
  v & 0xff,
];

const writeUint16BE = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

// General-MIDI drum-channel notes for our voices.
const VOICE_TO_MIDI: Record<Voice, { channel: number; note: number }> = {
  kick:  { channel: 9, note: 36 }, // C1  Bass Drum 1
  snare: { channel: 9, note: 38 }, // D1  Acoustic Snare
  hat:   { channel: 9, note: 42 }, // F#1 Closed Hi-Hat
  noise: { channel: 9, note: 39 }, // D#1 Hand Clap
  tone:  { channel: 0, note: 60 }, // C4  on melodic channel 1
};

const PPQ = 480; // pulses per quarter note (MIDI division)
const STEP_TICKS = PPQ / 4; // a 16th note = PPQ/4 ticks
const NOTE_DURATION_TICKS = STEP_TICKS - 8; // slightly shorter than one step

interface MidiEvent {
  tick: number;
  bytes: number[];
}

const eventsForTrack = (track: Track): MidiEvent[] => {
  const { channel, note } = VOICE_TO_MIDI[track.voice];
  const velocity = Math.max(1, Math.min(127, Math.round(track.gain * 127)));
  const events: MidiEvent[] = [];
  for (let i = 0; i < track.steps.length; i += 1) {
    if (!track.steps[i]) continue;
    const tick = i * STEP_TICKS;
    events.push({ tick, bytes: [0x90 | channel, note, velocity] });
    events.push({ tick: tick + NOTE_DURATION_TICKS, bytes: [0x80 | channel, note, 0] });
  }
  return events.sort((a, b) => a.tick - b.tick);
};

const serializeTrackChunk = (events: MidiEvent[], trackName: string): number[] => {
  const body: number[] = [];
  // Track name meta event at tick 0.
  body.push(...writeVLQ(0), 0xff, 0x03, ...writeVLQ(trackName.length), ...ascii(trackName));
  let lastTick = 0;
  for (const ev of events) {
    const delta = ev.tick - lastTick;
    body.push(...writeVLQ(delta), ...ev.bytes);
    lastTick = ev.tick;
  }
  // End-of-track meta event.
  body.push(0, 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...writeUint32BE(body.length), ...body];
};

const buildConductorTrack = (bpm: number): number[] => {
  const microsPerQuarter = Math.round(60_000_000 / Math.max(20, bpm));
  const body: number[] = [];
  // Track name.
  body.push(...writeVLQ(0), 0xff, 0x03, 5, ...ascii('Tempo'));
  // Tempo meta event: FF 51 03 tt tt tt.
  body.push(...writeVLQ(0), 0xff, 0x51, 0x03,
    (microsPerQuarter >>> 16) & 0xff,
    (microsPerQuarter >>> 8) & 0xff,
    microsPerQuarter & 0xff,
  );
  // 4/4 time signature (FF 58 04 nn dd cc bb) — nn=4, dd=2 (denominator=2^2=4), cc=24, bb=8.
  body.push(...writeVLQ(0), 0xff, 0x58, 0x04, 4, 2, 24, 8);
  body.push(0, 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...writeUint32BE(body.length), ...body];
};

const buildMidiFile = (
  tracks: Track[],
  bpm: number,
  mode: 'single' | 'multi',
): Uint8Array => {
  const conductor = buildConductorTrack(bpm);
  const noteChunks: number[][] = [];
  if (mode === 'single') {
    // Merge every track's events into one note track.
    const merged: MidiEvent[] = [];
    for (const t of tracks) merged.push(...eventsForTrack(t));
    merged.sort((a, b) => a.tick - b.tick);
    noteChunks.push(serializeTrackChunk(merged, 'Pattern'));
  } else {
    for (const t of tracks) {
      noteChunks.push(serializeTrackChunk(eventsForTrack(t), t.name || `Voice ${t.voice}`));
    }
  }
  const ntrks = 1 + noteChunks.length;
  const header = [
    ...ascii('MThd'),
    ...writeUint32BE(6),
    ...writeUint16BE(1), // format 1 (always — works even with one note track)
    ...writeUint16BE(ntrks),
    ...writeUint16BE(PPQ),
  ];
  const out: number[] = [...header, ...conductor];
  for (const c of noteChunks) out.push(...c);
  return new Uint8Array(out);
};

const downloadMidi = (tracks: Track[], bpm: number, mode: 'single' | 'multi'): void => {
  const bytes = buildMidiFile(tracks, bpm, mode);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `thedaw-pattern-${stamp}-${mode}.mid`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// =============================================================================
// Offline audio bounce — render the pattern (or each voice) to a WAV Blob
// =============================================================================

const encodeWav = (audioBuf: AudioBuffer): Blob => {
  const numCh = audioBuf.numberOfChannels;
  const sr = audioBuf.sampleRate;
  const len = audioBuf.length;
  const buffer = new ArrayBuffer(44 + len * numCh * 2);
  const view = new DataView(buffer);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  view.setUint32(4, 36 + len * numCh * 2, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  wstr(36, 'data');
  view.setUint32(40, len * numCh * 2, true);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c += 1) channels.push(audioBuf.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
};

const renderPatternBars = async (
  trackSubset: Track[],
  bpm: number,
  bars: number,
): Promise<{ blob: Blob; duration: number }> => {
  const sr = 44100;
  const barSec = (60 / bpm) * 4;
  const stepSec = barSec / STEPS;
  const totalSec = barSec * bars + 0.5; // tail
  const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);
  for (let bar = 0; bar < bars; bar += 1) {
    for (let i = 0; i < STEPS; i += 1) {
      for (const t of trackSubset) {
        if (!t.steps[i]) continue;
        const when = bar * barSec + i * stepSec;
        triggerVoice(t.voice, t.freq, t.gain, 1, when, offline, offline.destination);
      }
    }
  }
  const rendered = await offline.startRendering();
  return { blob: encodeWav(rendered), duration: rendered.duration };
};

export const StepSequencer: React.FC = () => {
  const [tracks, setTracks] = useState<Track[]>(defaultTracks);
  const [currentStep, setCurrentStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(128);
  const [exportMode, setExportMode] = useState<'single' | 'multi'>('single');
  const [exportBars, setExportBars] = useState(2);
  const [isBouncing, setIsBouncing] = useState(false);
  const trackMenu = useContextMenu<{ trackId: string }>();

  // Refs so the timer callback always reads the latest state without re-creating the interval.
  const tracksRef = useRef(tracks);
  const currentStepRef = useRef(currentStep);
  const masterGain = usePlaybackStore((s) => (s.muted ? 0 : s.volume / 100));
  const masterGainRef = useRef(masterGain);

  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { currentStepRef.current = currentStep; }, [currentStep]);
  useEffect(() => { masterGainRef.current = masterGain; }, [masterGain]);

  // Sequencer clock — advance step + fire active voices.
  useEffect(() => {
    if (!isPlaying) return;
    const stepMs = 60000 / Math.max(40, Math.min(240, bpm)) / 4; // 16th notes
    const interval = window.setInterval(() => {
      const nextStep = (currentStepRef.current + 1) % STEPS;
      currentStepRef.current = nextStep;
      setCurrentStep(nextStep);
      const ctx = getAudioCtx();
      const when = ctx.currentTime + 0.02;
      const master = masterGainRef.current;
      for (const t of tracksRef.current) {
        if (t.steps[nextStep]) {
          triggerVoice(t.voice, t.freq, t.gain, master, when, ctx, getMasterGain());
        }
      }
    }, stepMs);
    return () => window.clearInterval(interval);
  }, [isPlaying, bpm]);

  const handlePlayToggle = useCallback(() => {
    if (!isPlaying) {
      // Unlock AudioContext on user gesture.
      void getAudioCtx().resume();
      // Fire step 0 immediately so the user hears something on press.
      const ctx = getAudioCtx();
      const when = ctx.currentTime + 0.02;
      for (const t of tracksRef.current) {
        if (t.steps[0]) triggerVoice(t.voice, t.freq, t.gain, masterGainRef.current, when, ctx, getMasterGain());
      }
      setCurrentStep(0);
      currentStepRef.current = 0;
      setIsPlaying(true);
      logInfo('sequencer', `Started at ${bpm} BPM`);
    } else {
      setIsPlaying(false);
      logInfo('sequencer', 'Stopped');
    }
  }, [isPlaying, bpm]);

  const toggleStep = (trackId: string, stepIndex: number) => {
    setTracks(tracks.map((t) =>
      t.id === trackId
        ? { ...t, steps: t.steps.map((s, i) => (i === stepIndex ? !s : s)) }
        : t,
    ));
  };

  const setTrackName = (trackId: string, name: string) => {
    setTracks(tracks.map((t) => (t.id === trackId ? { ...t, name } : t)));
  };

  const cycleVoice = (trackId: string) => {
    setTracks(tracks.map((t) => {
      if (t.id !== trackId) return t;
      const next = VOICE_OPTIONS[(VOICE_OPTIONS.indexOf(t.voice) + 1) % VOICE_OPTIONS.length];
      return { ...t, voice: next };
    }));
  };

  const addTrack = () => {
    const id = `t${Date.now()}`;
    const color = NEW_TRACK_COLORS[tracks.length % NEW_TRACK_COLORS.length];
    setTracks([...tracks, {
      id,
      name: `Track ${tracks.length + 1}`,
      steps: Array(STEPS).fill(false),
      color,
      gain: 0.6,
      voice: 'tone',
      freq: 220,
    }]);
  };

  const removeTrack = (trackId: string) => {
    setTracks(tracks.filter((t) => t.id !== trackId));
  };

  const clearAll = () => {
    setTracks(tracks.map((t) => ({ ...t, steps: Array(STEPS).fill(false) })));
  };

  // Per-track step rewrite, used by the row right-click menu.
  const patchTrackSteps = (trackId: string, fn: (steps: boolean[]) => boolean[]) => {
    setTracks(tracks.map((t) => (t.id === trackId ? { ...t, steps: fn(t.steps) } : t)));
  };

  const randomizeFill = () => {
    setTracks(tracks.map((t) => ({
      ...t,
      steps: Array(STEPS).fill(false).map(() => Math.random() > 0.7),
    })));
  };

  const handleExportMidi = () => {
    const active = tracks.filter((t) => t.steps.some(Boolean));
    if (active.length === 0) {
      logError('sequencer', 'No active steps to export');
      return;
    }
    downloadMidi(active, bpm, exportMode);
    logInfo('sequencer', `MIDI exported: ${active.length} voice(s), ${exportMode} mode, ${bpm} BPM`);
  };

  const handleSendToEditor = async () => {
    const active = tracks.filter((t) => t.steps.some(Boolean));
    if (active.length === 0) {
      logError('sequencer', 'No active steps to bounce');
      return;
    }
    setIsBouncing(true);
    const start = performance.now();
    try {
      const editor = useEditorStore.getState();
      const bars = Math.max(1, Math.min(16, exportBars));
      if (exportMode === 'single') {
        const { blob, duration } = await renderPatternBars(active, bpm, bars);
        const peaksResult = await computePeaks(blob, 240);
        const trackId = editor.addTrack({ name: `Sequencer ${bpm} BPM` });
        const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
        const clipId = editor.addClipToTrack({
          trackId,
          label: `seq_${bars}bar_${bpm}bpm`,
          audioBlob: blob,
          mimeType: 'audio/wav',
          sourceDuration: duration,
          offsetIntoSource: 0,
          durationSec: duration,
          startSec: 0,
          color: trackColor,
        });
        editor.cachePeaks(clipId, peaksResult.peaks);
      } else {
        // Render each voice on its own editor track.
        for (const voice of active) {
          const { blob, duration } = await renderPatternBars([voice], bpm, bars);
          const peaksResult = await computePeaks(blob, 240);
          const trackId = editor.addTrack({ name: voice.name, color: voice.color });
          const clipId = editor.addClipToTrack({
            trackId,
            label: `${voice.name}_${bpm}bpm`,
            audioBlob: blob,
            mimeType: 'audio/wav',
            sourceDuration: duration,
            offsetIntoSource: 0,
            durationSec: duration,
            startSec: 0,
            color: voice.color,
          });
          editor.cachePeaks(clipId, peaksResult.peaks);
        }
      }
      const ms = (performance.now() - start).toFixed(0);
      logInfo('sequencer', `Bounced ${exportMode === 'single' ? '1 mixdown' : `${active.length} per-voice tracks`} → editor in ${ms}ms`);
    } catch (e) {
      logError('sequencer', `Bounce failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsBouncing(false);
    }
  };

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40 relative">
      <MidiMapper
        title="SEQUENCE"
        accent="cyan"
        storageKey="sa3-midi-map:sequence-v1"
        params={SEQUENCE_MIDI_PARAMS}
        onChange={(key, value) => {
          if (key === 'bpm') setBpm(Math.round(value));
        }}
      />
      {/* Extra right padding reserves space for the MIDI mapper pill (absolute
          top-right) so it never covers the + / CLEAR controls. */}
      <div className="flex items-center justify-between py-2 pl-2 pr-20 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <span className="text-[7px] font-mono text-zinc-600 uppercase leading-none">Tempo (BPM)</span>
              <input
                type="number"
                name="step-seq-bpm"
                value={bpm}
                min={40}
                max={240}
                onChange={(e) => setBpm(parseInt(e.target.value) || 120)}
                className="bg-transparent border-none outline-none text-[12px] font-mono text-cyan-500 w-14 font-black"
              />
            </div>
            <button
              onClick={handlePlayToggle}
              className={`p-1.5 rounded transition-all ${isPlaying ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 hover:bg-cyan-500/30'}`}
              title={isPlaying ? 'Stop' : 'Play'}
            >
              {isPlaying ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Single / Multitrack toggle — controls both MIDI export and editor bounce. */}
          <div className="flex items-center bg-black/40 rounded border border-white/5 overflow-hidden">
            <button
              onClick={() => setExportMode('single')}
              className={`px-1.5 py-0.5 text-[8px] uppercase font-bold tracking-widest transition-colors ${exportMode === 'single' ? 'bg-purple-600/30 text-purple-200' : 'text-zinc-500 hover:text-white'}`}
              title="Export as a single mixed track / single-track MIDI"
            >
              Single
            </button>
            <button
              onClick={() => setExportMode('multi')}
              className={`px-1.5 py-0.5 text-[8px] uppercase font-bold tracking-widest transition-colors ${exportMode === 'multi' ? 'bg-purple-600/30 text-purple-200' : 'text-zinc-500 hover:text-white'}`}
              title="Export as one track per voice / multi-track MIDI"
            >
              Multi
            </button>
          </div>

          {/* Bars selector for editor bounce */}
          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded">
            <Music className="w-2.5 h-2.5 text-zinc-500" />
            <input
              type="number"
              name="step-seq-export-bars"
              min={1}
              max={16}
              value={exportBars}
              onChange={(e) => setExportBars(Math.max(1, Math.min(16, parseInt(e.target.value) || 1)))}
              className="bg-transparent border-none outline-none text-[10px] font-mono text-zinc-300 w-6"
              title="Number of bars to render when sending to the editor"
            />
            <span className="text-[7px] font-mono text-zinc-600 uppercase">bar{exportBars === 1 ? '' : 's'}</span>
          </div>

          <button
            onClick={handleExportMidi}
            className="btn-ghost flex items-center gap-1.5 py-1 text-[9px]"
            title="Download this pattern as a Standard MIDI File (.mid)"
          >
            <Download className="w-3 h-3 text-purple-300" /> EXPORT MIDI
          </button>
          <button
            onClick={() => void handleSendToEditor()}
            disabled={isBouncing}
            className="btn-ghost flex items-center gap-1.5 py-1 text-[9px] disabled:opacity-40"
            title="Render this pattern to audio and add to the waveform editor"
          >
            <Send className={`w-3 h-3 text-purple-300 ${isBouncing ? 'animate-pulse' : ''}`} />
            {isBouncing ? 'BOUNCING…' : 'SEND TO EDITOR'}
          </button>
          <button
            onClick={randomizeFill}
            className="btn-ghost flex items-center gap-1.5 py-1 text-[9px]"
            title="Randomize all step patterns"
          >
            <Sparkles className="w-3 h-3 text-purple-400" /> RANDOM
          </button>
          <button
            onClick={clearAll}
            className="btn-ghost flex items-center gap-1.5 py-1 text-[9px]"
            title="Clear all steps"
          >
            <Trash2 className="w-3 h-3" /> CLEAR
          </button>
          <button
            onClick={addTrack}
            className="p-1 px-2 border border-white/5 rounded hover:bg-white/5"
            title="Add track"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]">
        {tracks.map((track) => (
          <div
            key={track.id}
            className="flex gap-2 group"
            onContextMenu={(e) => trackMenu.open(e, { trackId: track.id })}
          >
            <div className="w-32 shrink-0 flex flex-col bg-black/40 rounded p-1.5 border border-white/5 group-hover:border-white/10 transition-colors">
              <div className="flex justify-between items-center mb-1 gap-1">
                <input
                  type="text"
                  name={`step-seq-track-name-${track.id}`}
                  value={track.name}
                  onChange={(e) => setTrackName(track.id, e.target.value)}
                  className="bg-transparent border-none outline-none text-[9px] font-black uppercase truncate hover:bg-white/5 px-1 -mx-1 rounded transition-colors flex-1 min-w-0"
                  style={{ color: track.color }}
                />
                <button
                  onClick={() => cycleVoice(track.id)}
                  className="text-[7px] font-mono uppercase text-zinc-500 hover:text-white px-1 rounded bg-black/40 border border-white/5"
                  title={`Voice: ${track.voice} — click to change`}
                >
                  {track.voice}
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[7px] font-mono text-zinc-600 uppercase w-3">Vol</span>
                <SlideTrack min={0} max={1} step={0.01} value={track.gain}
                  onChange={(v) => setTracks(tracks.map((t) => t.id === track.id ? { ...t, gain: v } : t))}
                  className="flex-1" ariaLabel="Voice volume" />
              </div>
            </div>

            <div className="flex-1 grid grid-cols-16 gap-1">
              {track.steps.map((active, i) => (
                <button
                  key={i}
                  onClick={() => toggleStep(track.id, i)}
                  className={`relative aspect-square rounded-sm border transition-all
                    ${active ? 'shadow-[0_0_10px]' : 'border-white/5 hover:border-white/20 bg-white/2'}
                    ${i === currentStep && isPlaying ? 'ring-1 ring-white z-10 scale-110' : ''}
                    ${i % 4 === 0 ? 'opacity-100' : 'opacity-70'}
                  `}
                  style={{
                    backgroundColor: active ? track.color : undefined,
                    borderColor: active ? track.color : undefined,
                    boxShadow: active ? `0 0 10px ${track.color}66` : undefined,
                  }}
                >
                  {i % 4 === 0 && !active && <div className="absolute top-0.5 left-0.5 w-0.5 h-0.5 rounded-full bg-zinc-700" />}
                </button>
              ))}
            </div>

            <div className="w-8 flex flex-col items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                className="text-zinc-700 hover:text-white"
                onClick={() => {
                  const ctx = getAudioCtx();
                  triggerVoice(track.voice, track.freq, track.gain, masterGainRef.current, ctx.currentTime + 0.02, ctx, getMasterGain());
                }}
                title="Preview voice"
              >
                <Target className="w-3 h-3" />
              </button>
              <button
                className="text-zinc-700 hover:text-red-500"
                onClick={() => removeTrack(track.id)}
                title="Remove track"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}

        <div className="flex gap-2 mt-1">
          <div className="w-32 shrink-0" />
          <div className="flex-1 grid grid-cols-16 gap-1">
            {Array.from({ length: STEPS }).map((_, i) => (
              <div key={i} className="flex justify-center">
                <div className={`w-1 h-1 rounded-full transition-all ${i === currentStep && isPlaying ? 'bg-cyan-500 scale-150' : 'bg-zinc-800'}`} />
              </div>
            ))}
          </div>
          <div className="w-8" />
        </div>
      </div>

      <div className="h-6 border-t border-white/5 bg-black/60 flex items-center justify-between px-3">
        <div className="flex items-center gap-4">
          <span className="text-[7px] font-mono text-zinc-600 uppercase flex items-center gap-1.5">
            <Activity className="w-2.5 h-2.5" /> {isPlaying ? 'PLAYING' : 'STOPPED'}
          </span>
          <span className="text-[7px] font-mono text-zinc-600 uppercase tracking-tighter">
            Step {currentStep + 1}/{STEPS} // {tracks.length} tracks
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[7px] font-mono text-cyan-500/80 uppercase">Web Audio Engine</span>
        </div>
      </div>

      {/* Right-click menu for a sequencer track row. */}
      {(() => {
        const payload = trackMenu.payload;
        if (!payload) return null;
        const track = tracks.find((t) => t.id === payload.trackId);
        if (!track) return null;
        const id = track.id;
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: 'Fill every step',
            onSelect: () => patchTrackSteps(id, () => Array(STEPS).fill(true)),
          },
          {
            type: 'item',
            label: 'Fill every 2nd',
            onSelect: () => patchTrackSteps(id, () => Array(STEPS).fill(false).map((_, i) => i % 2 === 0)),
          },
          {
            type: 'item',
            label: 'Fill every 4th',
            onSelect: () => patchTrackSteps(id, () => Array(STEPS).fill(false).map((_, i) => i % 4 === 0)),
          },
          {
            type: 'item',
            label: 'Randomize row',
            icon: <Sparkles className="w-3 h-3" />,
            onSelect: () => patchTrackSteps(id, () => Array(STEPS).fill(false).map(() => Math.random() > 0.7)),
          },
          {
            type: 'item',
            label: 'Invert row',
            onSelect: () => patchTrackSteps(id, (steps) => steps.map((s) => !s)),
          },
          {
            type: 'item',
            label: 'Clear row',
            onSelect: () => patchTrackSteps(id, () => Array(STEPS).fill(false)),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Remove track',
            icon: <Trash2 className="w-3 h-3" />,
            danger: true,
            disabled: tracks.length <= 1,
            onSelect: () => removeTrack(id),
          },
        ];
        return (
          <ContextMenu
            position={trackMenu.position}
            onClose={trackMenu.close}
            items={items}
            title={`Track · ${track.name}`}
            minWidth="12rem"
          />
        );
      })()}
    </div>
  );
};

