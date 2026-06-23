import { isMidiMessageIgnored } from './midiIgnoreStore';

/**
 * Global MIDI event bus.
 *
 * One Web MIDI listener lives in App.tsx; it dispatches every
 * incoming message through this bus. Any feature that wants raw
 * MIDI input (piano synth, VJ iframe forwarder, the MidiMapper
 * popups in PianoRoll and StepSequencer) subscribes here instead
 * of opening its own MIDIAccess — that way only ONE handler is
 * attached to each MIDIInput, so we don't have the
 * last-listener-wins problem that the VJView used to have.
 */

export interface MidiBusMessage {
  /** 3-byte MIDI status + data1 + data2 (or shorter for system messages). */
  data: number[];
  /** Performance.now() at dispatch time. */
  t: number;
}

type MidiListener = (msg: MidiBusMessage) => void;

const listeners = new Set<MidiListener>();

export function publishMidi(data: Uint8Array | number[], t: number = performance.now()): void {
  if (isMidiMessageIgnored(data)) return;
  const arr = Array.from(data, (n) => Number(n) | 0);
  const msg: MidiBusMessage = { data: arr, t };
  for (const cb of listeners) {
    try {
      cb(msg);
    } catch (err) {
      // A faulty subscriber should not silence the rest of the bus.
      console.error('[midiBus] subscriber threw:', err);
    }
  }
}

export function subscribeToMidi(cb: MidiListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
