// Typed client for the DAW project import backend (/api/dawimport/*).
import { getJson, postJson } from './apiJson';

export interface DawClip {
  name: string;
  start_time: number;
  end_time: number;
  loop_start?: number | null;
  loop_end?: number | null;
  file_path: string | null;
  midi_notes?: unknown[] | null;
  warp_markers?: unknown[] | null;
}

export interface DawDevice {
  name: string;
  plugin_type: string; // "vst3" | "audiounit" | "builtin"
  plugin_path?: string | null;
  parameters?: Record<string, number>;
}

export interface DawTrack {
  name: string;
  type: string; // "audio" | "midi" | "return" | "master"
  volume_db: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  color?: string | null;
  clips: DawClip[];
  devices: DawDevice[];
}

export interface DawLocator {
  name: string;
  position: number;
  color?: string | null;
}

export interface DawProject {
  source_daw: string;
  source_version: string;
  name: string;
  tempo: number;
  time_signature: number[];
  sample_rate: number;
  tracks: DawTrack[];
  locators: DawLocator[];
  plugins_used: string[];
  warnings: string[];
  missing_files: string[];
}

export interface DawDetect {
  daw: string;
  name: string;
  format: string;
}

export interface DawExportHint {
  format: string;
  limitation: string;
  recommended_workflow: string[];
}

// Map a detected DAW key to the importer endpoint segment.
const IMPORT_ENDPOINT: Record<string, string> = {
  ableton: 'ableton',
  reaper: 'reaper',
  logic: 'logic',
  fl_studio: 'fl-studio',
  audacity: 'audacity',
  audition: 'audition',
  bitwig: 'bitwig',
  resolume: 'resolume',
};

// DAWs with no direct parser — export-hint guidance only.
const HINT_ENDPOINT: Record<string, string> = {
  logic: 'logic/export-hint',
  cubase: 'cubase/export-hint',
  pro_tools: 'pro-tools/export-hint',
};

export const DAW_LABELS: Record<string, string> = {
  ableton: 'Ableton Live',
  reaper: 'Reaper',
  logic: 'Logic Pro X',
  fl_studio: 'FL Studio',
  audacity: 'Audacity',
  audition: 'Adobe Audition',
  bitwig: 'Bitwig Studio',
  resolume: 'Resolume Arena',
  cubase: 'Cubase',
  pro_tools: 'Pro Tools',
  unknown: 'Unknown',
};

export const canImport = (daw: string): boolean => daw in IMPORT_ENDPOINT;
export const hasHint = (daw: string): boolean => daw in HINT_ENDPOINT;

export const dawApi = {
  detect: (path: string) => postJson<DawDetect>('/api/dawimport/detect', { path }),
  import: (daw: string, path: string) => {
    const seg = IMPORT_ENDPOINT[daw];
    if (!seg) throw new Error(`No importer available for ${DAW_LABELS[daw] ?? daw}`);
    return postJson<DawProject>(`/api/dawimport/${seg}`, { path });
  },
  hint: (daw: string) => {
    const seg = HINT_ENDPOINT[daw];
    if (!seg) throw new Error(`No export hint for ${DAW_LABELS[daw] ?? daw}`);
    return getJson<DawExportHint>(`/api/dawimport/${seg}`);
  },
};
