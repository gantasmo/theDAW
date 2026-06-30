/**
 * Quest MIDI client — the loopMIDI-free path.
 *
 * Holds a WebSocket to the backend `questmidi` module (`/api/questmidi/ws`),
 * which bridges the Quest app over USB (adb reverse) with no loopMIDI and no
 * separate Node bridge. Inbound Quest MIDI is republished on the global
 * `midiBus`, so every existing consumer (piano synth, VJ forwarder, MidiMapper,
 * the questControlStore) sees it exactly like a hardware controller. Return MIDI
 * (e.g. an audio-reactive feed for the headset MIDI Reactor) goes back via
 * `sendQuestMidi`.
 *
 * Same-origin URL so it rides the Vite dev proxy (ws:true) in development and is
 * direct in production. Auto-reconnects while running.
 */

import { publishMidi } from './midiBus';
import { logInfo, logWarn } from './logStore';

let ws: WebSocket | null = null;
let reconnectTimer = 0;
let running = false;
let everConnected = false;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/questmidi/ws`;
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, 2000);
}

function connect(): void {
  if (!running || ws) return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    everConnected = true;
    logInfo('questmidi', 'Bridge connected — Quest MIDI flowing into theDAW (no loopMIDI).');
  };
  sock.onmessage = (e) => {
    try {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : '');
      if (m && m.type === 'midi' && Array.isArray(m.data)) publishMidi(m.data);
    } catch {
      /* ignore malformed frame */
    }
  };
  sock.onerror = () => {
    try { sock.close(); } catch { /* already closing */ }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (running && everConnected) logWarn('questmidi', 'Bridge disconnected — retrying…');
    scheduleReconnect();
  };
}

/** Open (and keep open) the Quest MIDI bridge. Safe to call repeatedly. */
export function startQuestMidi(): void {
  if (running) return;
  running = true;
  everConnected = false;
  connect();
}

/** Close the bridge and stop reconnecting. */
export function stopQuestMidi(): void {
  running = false;
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
  if (ws) {
    try { ws.close(); } catch { /* already closing */ }
    ws = null;
  }
}

/** Send return MIDI to the headset (e.g. to drive the GANTASMO Visor). */
export function sendQuestMidi(data: number[]): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ data }));
    return true;
  }
  return false;
}

export function isQuestMidiConnected(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
