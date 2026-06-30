/**
 * vocalExport.ts - turn a VocalArtifact into a .mid download or an inpaint guide.
 *
 * Reuses the existing note/render surface end to end: artifact notes (ms) map to
 * RenderNote (seconds), notesToSmf writes the SMF for a .mid download, and
 * renderNotesToBlob renders a guide WAV. Arming an inpaint guide just patches
 * generateParamsStore's existing inpaint fields, so the normal Generate flow
 * regenerates the masked window (no new generate path).
 */

import { useGenerateParamsStore } from '../state/generateParamsStore';
import { notesToSmf } from './midiWrite';
import type { RenderNote } from './midiSynth';
import { renderNotesToBlob } from './midiSynth';

export interface ArtifactNote {
  start_ms: number;
  end_ms: number;
  pitch: number;
  velocity: number;
}

export interface ArtifactSegment {
  id: number;
  start_ms: number;
  end_ms: number;
  kind: string;
}

export interface VocalArtifactDoc {
  notes: ArtifactNote[];
  segments: ArtifactSegment[];
  timing: { tempo_bpm: number | null };
  source: { asset_id: string; duration_ms: number };
  lyrics: { language: string; text: string; source: string };
  review: { reviewed: boolean; notes: string };
}

export const fetchVocalArtifact = async (
  assetId: string,
): Promise<VocalArtifactDoc | null> => {
  const res = await fetch(`/api/vocal/metadata/${encodeURIComponent(assetId)}`);
  if (!res.ok) return null;
  return (await res.json()) as VocalArtifactDoc;
};

export const artifactNotesToRenderNotes = (notes: ArtifactNote[]): RenderNote[] =>
  notes.map((n) => ({
    midi: n.pitch,
    startSec: n.start_ms / 1000,
    durationSec: Math.max(0.02, (n.end_ms - n.start_ms) / 1000),
    velocity: n.velocity,
  }));

const anchorDownload = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Export the artifact notes as a .mid (type-0 SMF) and trigger a download. */
export const downloadVocalMidi = (notes: ArtifactNote[], baseName = 'vocal'): void => {
  const bytes = notesToSmf(artifactNotesToRenderNotes(notes));
  anchorDownload(new Blob([bytes], { type: 'audio/midi' }), `${baseName}.mid`);
};

/** Render the artifact notes to a guide WAV (soundfont when active, else the
 * built-in voice). */
export const renderVocalGuideBlob = async (
  notes: ArtifactNote[],
): Promise<{ blob: Blob; duration: number }> =>
  renderNotesToBlob(artifactNotesToRenderNotes(notes), { sampleRate: 44100, tailSec: 0.6 });

/**
 * Arm an inpaint regeneration of one segment: render the whole performance as a
 * guide, then patch the Generate params with the guide file + the segment's mask
 * window (seconds). The user triggers Generate to actually regenerate.
 * Returns false when the segment has no usable mask window (mask_start and
 * mask_end both 0 read as "no mask" at the API boundary).
 */
export const armInpaintGuide = async (
  doc: VocalArtifactDoc,
  segmentIndex: number,
): Promise<boolean> => {
  const seg = doc.segments[segmentIndex];
  if (!seg) return false;
  const maskStart = seg.start_ms / 1000;
  const maskEnd = seg.end_ms / 1000;
  if (maskStart <= 0 && maskEnd <= 0) return false;

  const { blob } = await renderVocalGuideBlob(doc.notes);
  const guide = new File([blob], 'vocal-guide.wav', { type: 'audio/wav' });
  useGenerateParamsStore.getState().patch({
    inpaintAudioFile: guide,
    inpaintEnabled: true,
    maskStart,
    maskEnd,
  });
  return true;
};
