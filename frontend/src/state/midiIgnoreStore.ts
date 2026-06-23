import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type MidiIgnoredKind = 'cc' | 'note';

export interface MidiIgnoredControl {
  id: string;
  kind: MidiIgnoredKind;
  /** CC/note number. null means every number for the matching kind/channel. */
  number: number | null;
  /** MIDI channel 0-15. null means every channel. */
  channel: number | null;
  createdAt: number;
}

export interface MidiControlSig {
  kind: MidiIgnoredKind;
  number: number;
  channel: number;
}

interface MidiIgnoreState {
  controls: MidiIgnoredControl[];
  ignoreControl: (sig: MidiControlSig, opts?: { anyChannel?: boolean }) => void;
  ignoreChannel: (kind: MidiIgnoredKind, channel: number) => void;
  removeIgnoredControl: (id: string) => void;
  clearIgnoredControls: () => void;
}

export function midiSigFromData(data: number[] | Uint8Array): MidiControlSig | null {
  const statusByte = data[0];
  const number = data[1];
  if (typeof statusByte !== 'number' || typeof number !== 'number') return null;
  const command = statusByte & 0xf0;
  const channel = statusByte & 0x0f;
  if (command === 0xb0) return { kind: 'cc', number, channel };
  if (command === 0x90 || command === 0x80) return { kind: 'note', number, channel };
  return null;
}

export function midiIgnoreLabel(control: Pick<MidiIgnoredControl, 'kind' | 'number' | 'channel'>): string {
  const kind = control.kind === 'cc' ? 'CC' : 'NOTE';
  const number = control.number === null ? '*' : control.number;
  const channel = control.channel === null ? 'any ch' : `ch ${control.channel + 1}`;
  return `${kind} ${number} · ${channel}`;
}

function controlId(kind: MidiIgnoredKind, number: number | null, channel: number | null): string {
  return `${kind}:${number ?? '*'}:${channel ?? '*'}`;
}

function matches(control: MidiIgnoredControl, sig: MidiControlSig): boolean {
  return (
    control.kind === sig.kind &&
    (control.number === null || control.number === sig.number) &&
    (control.channel === null || control.channel === sig.channel)
  );
}

export const useMidiIgnoreStore = create<MidiIgnoreState>()(
  persist(
    (set) => ({
      controls: [],
      ignoreControl: (sig, opts) =>
        set((s) => {
          const channel = opts?.anyChannel ? null : sig.channel;
          const id = controlId(sig.kind, sig.number, channel);
          if (s.controls.some((c) => c.id === id)) return s;
          return {
            controls: [
              ...s.controls,
              { id, kind: sig.kind, number: sig.number, channel, createdAt: Date.now() },
            ],
          };
        }),
      ignoreChannel: (kind, channel) =>
        set((s) => {
          const id = controlId(kind, null, channel);
          if (s.controls.some((c) => c.id === id)) return s;
          return {
            controls: [
              ...s.controls,
              { id, kind, number: null, channel, createdAt: Date.now() },
            ],
          };
        }),
      removeIgnoredControl: (id) =>
        set((s) => ({ controls: s.controls.filter((c) => c.id !== id) })),
      clearIgnoredControls: () => set({ controls: [] }),
    }),
    { name: 'thedaw.midiIgnore.v1' },
  ),
);

export function isMidiSigIgnored(sig: MidiControlSig): boolean {
  return useMidiIgnoreStore.getState().controls.some((control) => matches(control, sig));
}

export function isMidiMessageIgnored(data: number[] | Uint8Array): boolean {
  const sig = midiSigFromData(data);
  return sig ? isMidiSigIgnored(sig) : false;
}
