/**
 * Shared "send audio / midi to <target>" helpers.
 *
 * Right-click menus on the library tracks list, stems sub-tab, midi sub-tab,
 * and the mic recorder all need the same set of destinations:
 *
 *   - Editor (append to first track / new track)
 *   - Init audio (the generation panel's init slot)
 *   - Inpaint audio (the generation panel's inpaint slot)
 *   - Chimera (for multi-clip batching)
 *   - Piano roll / Step sequencer (MIDI only)
 *
 * Without this module each call site re-implements blob fetching + editor
 * peak caching + bottom-panel switching, which is how `LibraryView.tsx`
 * grew to 1100+ lines. Centralizing keeps the right-click menus thin and
 * makes mic-recorded blobs reusable.
 */
import { useEditorStore, computePeaks } from '../state/editorStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { usePianoRollStore } from '../state/pianoRollStore';
import { addBlobsToChimera } from './chimeraClient';
import { parseMidi } from './midi';
import { renderMidiBufferToBlob } from './midiSynth';
import { fetchMidiBytesWithRetry, fetchBlobWithRetry } from './fetchRetry';
import { logError, logInfo } from '../state/logStore';

/** Default mime for stems / mic recordings when none provided. */
const DEFAULT_AUDIO_MIME = 'audio/wav';

export interface SendableAudio {
  /** Human label shown in the editor / chimera / init source pill. */
  label: string;
  /** A fetcher that resolves the audio bytes the first time it's used. */
  fetcher: () => Promise<Blob>;
  /** Mime hint for the resulting File / source label. */
  mimeType?: string;
}

export type AudioSendTarget =
  | 'editor-first-track'
  | 'editor-new-track'
  | 'init'
  | 'inpaint'
  | 'chimera';

export type MidiSendTarget = 'piano-roll' | 'step-seq';

/**
 * Append an audio blob to the waveform editor — either to the tail of the
 * first existing track, or as a new track. Decodes peaks so the waveform
 * shows up immediately.
 */
export async function sendAudioToEditor(
  audio: SendableAudio,
  target: 'editor-first-track' | 'editor-new-track' = 'editor-first-track',
): Promise<string | null> {
  try {
    const editor = useEditorStore.getState();
    let trackId: string;
    if (target === 'editor-new-track' || editor.tracks.length === 0) {
      trackId = editor.addTrack({ name: audio.label });
    } else {
      trackId = editor.tracks[0].id;
    }
    const tail =
      target === 'editor-new-track'
        ? 0
        : Math.max(
            0,
            ...editor.clips
              .filter((c) => c.trackId === trackId)
              .map((c) => c.startSec + c.durationSec),
          );
    const blob = await audio.fetcher();
    const { peaks, duration } = await computePeaks(blob, 240);
    const trackColor =
      useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#8b5cf6';
    const clipId = editor.addClipToTrack({
      trackId,
      label: audio.label,
      audioBlob: blob,
      mimeType: audio.mimeType || DEFAULT_AUDIO_MIME,
      sourceDuration: duration,
      offsetIntoSource: 0,
      durationSec: duration,
      startSec: tail,
      color: trackColor,
    });
    editor.cachePeaks(clipId, peaks);
    return clipId;
  } catch (e) {
    logError('send-to', `Could not send to editor: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Stash a single blob in the generate panel's init slot. */
export async function sendAudioToInit(audio: SendableAudio): Promise<void> {
  try {
    const blob = await audio.fetcher();
    const file = new File([blob], audio.label, { type: audio.mimeType || DEFAULT_AUDIO_MIME });
    useGenerateParamsStore.getState().patch({
      initAudioFile: file,
      initAudioEnabled: true,
      initAudioSourceLabel: audio.label,
      initAudioSourceClipLabels: [],
    });
    logInfo('send-to', `Sent "${audio.label}" → Init audio`);
  } catch (e) {
    logError('send-to', `Could not send to init: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Stash a blob in the inpaint slot with a zero-length mask (user picks the window). */
export async function sendAudioToInpaint(audio: SendableAudio): Promise<void> {
  try {
    const blob = await audio.fetcher();
    const file = new File([blob], audio.label, { type: audio.mimeType || DEFAULT_AUDIO_MIME });
    useGenerateParamsStore.getState().patch({
      inpaintAudioFile: file,
      inpaintEnabled: true,
      maskStart: 0,
      maskEnd: 0,
    });
    logInfo('send-to', `Sent "${audio.label}" → Inpaint`);
  } catch (e) {
    logError('send-to', `Could not send to inpaint: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Push 1+ blobs into the chimera mashup bucket. */
export async function sendAudioToChimera(items: SendableAudio[]): Promise<void> {
  try {
    const resolved = await Promise.all(
      items.map(async (it) => ({
        blob: await it.fetcher(),
        mimeType: it.mimeType || DEFAULT_AUDIO_MIME,
        label: it.label,
      })),
    );
    addBlobsToChimera(resolved);
    logInfo('send-to', `Sent ${items.length} clip(s) → Chimera`);
  } catch (e) {
    logError('send-to', `Could not send to chimera: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Decode a MIDI byte buffer into the piano roll's note grid, then surface
 * the chosen bottom-panel tab. Used by:
 *   - Library MIDI sub-tab right-click → Send to piano roll / step seq
 *   - The mic recorder / external midi dropzone
 */
export function loadMidiIntoPianoRoll(
  buf: ArrayBuffer | Uint8Array,
  target: MidiSendTarget = 'piano-roll',
  labelForLog = 'midi',
): boolean {
  try {
    const midi = parseMidi(buf);
    const ppq = midi.ppq || 480;
    const stepTicks = ppq / 4;
    const notes = midi.tracks.flatMap((t) =>
      t.notes.map((n) => ({
        id: `pn-${Math.random().toString(36).slice(2)}`,
        note: n.note,
        step: Math.round(n.tick / stepTicks),
        length: Math.max(1, Math.round(n.durationTicks / stepTicks)),
        velocity: n.velocity,
      })),
    );
    if (notes.length === 0) {
      logError('send-to', `MIDI ${labelForLog} parsed empty — no note-on events`);
      return false;
    }
    const piano = usePianoRollStore.getState();
    piano.importNotes(notes, midi.bpm); // auto-fits length + pitch range to the import
    useBottomPanelStore.getState().showTab(target === 'piano-roll' ? 'midi' : 'step-seq');
    const totalSteps = usePianoRollStore.getState().totalSteps;
    logInfo(
      'send-to',
      `Loaded ${notes.length} note(s) → ${target === 'piano-roll' ? 'piano roll' : 'step sequencer'} (bpm=${midi.bpm.toFixed(0)}, ${totalSteps} steps)`,
    );
    return true;
  } catch (e) {
    logError('send-to', `MIDI parse failed for ${labelForLog}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Fetch a midi file from the backend by id, then load it into the piano roll. */
export async function sendMidiIdToTarget(midiId: string, target: MidiSendTarget): Promise<void> {
  try {
    const buf = await fetchMidiBytesWithRetry(`/api/midi/file/${midiId}`, { label: midiId });
    loadMidiIntoPianoRoll(buf, target, midiId);
  } catch (e) {
    logError('send-to', `Send MIDI failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Build a SendableAudio that synthesizes a library MIDI row into audio on
 * demand. Lets MIDI flow into every audio destination (editor / init / inpaint
 * / chimera) the same way a stem or track does. Rendering is lazy — the synth
 * only runs when a consumer actually pulls the blob.
 */
export function midiIdToSendable(midiId: string, label = 'midi'): SendableAudio {
  return {
    label,
    mimeType: 'audio/wav',
    fetcher: async () => {
      const buf = await fetchMidiBytesWithRetry(`/api/midi/file/${midiId}`, { label });
      const { blob } = await renderMidiBufferToBlob(buf);
      return blob;
    },
  };
}

/** Build a SendableAudio from a stem row pulled from /api/library/_all/stems. */
export function stemRowToSendable(row: Record<string, unknown>): SendableAudio {
  const stemId = String(row.id ?? '');
  const stemName = String(row.stem_name ?? 'stem');
  const parentTitle = String(row.parent_title ?? '');
  const label = parentTitle ? `${parentTitle} · ${stemName}` : stemName;
  return {
    label,
    mimeType: 'audio/wav',
    fetcher: () => fetchBlobWithRetry(`/api/library/stems/${stemId}/audio`, { label }),
  };
}

