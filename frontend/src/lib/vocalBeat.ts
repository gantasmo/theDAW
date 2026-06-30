/**
 * vocalBeat.ts - turn a sung/captured melody into a beat, and suggest an effect.
 *
 * Two Phase-6 pieces, both deterministic and composed from existing engines:
 *
 *  - notesToDrumPattern + renderDrumBeatBlob: map each note onset to a GM drum
 *    voice by register and render a beat bed through the SpessaSynth GM soundfont
 *    on channel 9 (renderNotesToBlobSF forces channel 0, so it cannot address a
 *    kit; building the SMF with notesToSmf(..., 9) is the documented way in).
 *
 *  - vocalizeEffect: a feature-based heuristic ("vocalize an effect") that reads
 *    note density / dynamics / pitch spread and names a rack effect. It is a
 *    transparent stand-in, NOT a trained timbre classifier; applying the result
 *    to the live rack chain is a follow-up that needs the editor's rack plumbing.
 */

import type { RenderNote } from './midiSynth';
import { notesToSmf } from './midiWrite';
import { ensureSoundfontReady, renderMidiBufferToBlobSF } from './soundfontEngine';

// General MIDI percussion notes (channel 9).
export const GM_KICK = 36;
export const GM_SNARE = 38;
export const GM_CLOSED_HAT = 42;

const HIT_SEC = 0.12;

/** Map melody notes to drum hits by register: low -> kick, mid -> snare,
 * high -> closed hat. Onset timing and velocity are preserved. */
export const notesToDrumPattern = (notes: RenderNote[]): RenderNote[] =>
  notes.map((n) => ({
    midi: n.midi < 50 ? GM_KICK : n.midi <= 64 ? GM_SNARE : GM_CLOSED_HAT,
    startSec: n.startSec,
    durationSec: HIT_SEC,
    velocity: n.velocity,
  }));

/** Render a GM drum bed (channel 9) from melody notes. */
export const renderDrumBeatBlob = async (
  notes: RenderNote[],
): Promise<{ blob: Blob; duration: number }> => {
  await ensureSoundfontReady();
  const smf = notesToSmf(notesToDrumPattern(notes), 0, 9);
  return renderMidiBufferToBlobSF(smf, { sampleRate: 44100, tailSec: 0.5 });
};

export interface FxSuggestion {
  effectId: string; // a RACK_EFFECTS id (gater | chop | ringmod | bitcrush)
  reason: string;
}

/**
 * Suggest a rack effect from melody features. Deterministic heuristic, not a
 * model: dense onsets favour stutter chop, wide dynamics a rhythmic gate, wide
 * pitch range ring modulation, otherwise a bitcrush texture.
 */
export const vocalizeEffect = (
  notes: RenderNote[],
  durationSec: number,
): FxSuggestion => {
  if (!notes.length) return { effectId: 'gater', reason: 'no input' };
  const density = notes.length / Math.max(0.5, durationSec);
  const pitches = notes.map((n) => n.midi);
  const spread = Math.max(...pitches) - Math.min(...pitches);
  const vels = notes.map((n) => n.velocity);
  const meanV = vels.reduce((a, b) => a + b, 0) / vels.length;
  const dynV = Math.sqrt(
    vels.reduce((a, b) => a + (b - meanV) ** 2, 0) / vels.length,
  );
  if (density >= 5)
    return { effectId: 'chop', reason: `dense ${density.toFixed(1)}/s -> stutter chop` };
  if (dynV >= 25) return { effectId: 'gater', reason: 'wide dynamics -> rhythmic gate' };
  if (spread >= 12) return { effectId: 'ringmod', reason: 'wide pitch range -> ring mod' };
  return { effectId: 'bitcrush', reason: 'steady tone -> bitcrush texture' };
};
