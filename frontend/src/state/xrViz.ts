/**
 * XR visualization feed (waveform pack).
 *
 * Streams compact visual data to a theDAW-XR headset over the SAME questmidi
 * return channel the MIDI Reactor uses (`QuestMidiSender`'s inbound path), so
 * there is no new transport. Each frame is a valid MIDI SysEx message,
 * `[0xF0, 0x7D, type, ...7-bit payload, 0xF7]` (<= 255 bytes), which passes
 * cleanly whether the bridge is the loopMIDI-free relay or a loopMIDI port.
 *
 * Frame types:
 *   0x01 waveform  — WAVE_POINTS time-domain samples, each 0..127 (64 = silence)
 *
 * The audio source is the shared player-engine master AnalyserNode
 * (`getAnalyser`), the same tap the in-app visualizers use. The Quest renders
 * these natively (XrVizReceiver + XrWaveformRibbon).
 */
import { getAnalyser } from './playerStore';
import { sendQuestMidi, isQuestMidiConnected } from './questMidiClient';

const SYSEX_START = 0xf0;
const MFG = 0x7d; // SysEx "non-commercial / experimental" id
const SYSEX_END = 0xf7;
const T_WAVE = 0x01;

const WAVE_POINTS = 128;
const SEND_INTERVAL_MS = 33; // ~30 Hz

let running = false;
let rafId = 0;
let lastSend = 0;
let timeBuf: Uint8Array | null = null;

function sendWaveform(): void {
  let analyser: AnalyserNode;
  try {
    analyser = getAnalyser();
  } catch {
    return; // audio engine not up yet
  }
  const fft = analyser.fftSize;
  if (!timeBuf || timeBuf.length !== fft) timeBuf = new Uint8Array(fft);
  analyser.getByteTimeDomainData(timeBuf);

  const payload: number[] = [SYSEX_START, MFG, T_WAVE];
  const step = fft / WAVE_POINTS;
  for (let i = 0; i < WAVE_POINTS; i++) {
    // time-domain 0..255 (128 = silence) -> 7-bit 0..127
    payload.push(timeBuf[Math.floor(i * step)] >> 1);
  }
  payload.push(SYSEX_END);
  sendQuestMidi(payload);
}

function tick(now: number): void {
  if (!running) return;
  if (isQuestMidiConnected() && now - lastSend >= SEND_INTERVAL_MS) {
    lastSend = now;
    sendWaveform();
  }
  rafId = requestAnimationFrame(tick);
}

/** Start streaming the viz feed. Safe to call repeatedly; only sends while the
 *  Quest bridge is connected. */
export function startXrViz(): void {
  if (running) return;
  running = true;
  lastSend = 0;
  rafId = requestAnimationFrame(tick);
}

/** Stop the viz feed. */
export function stopXrViz(): void {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}
