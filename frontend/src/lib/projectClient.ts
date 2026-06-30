// Typed client for the .tasmo project backend (/api/project/*).
import { getJson, postJson } from './apiJson';
import type { DawProject } from './dawImportClient';

// --- Save payload (built in the frontend, validated by the backend) ---
export interface TasmoClipInput {
  id: string;
  name: string;
  clip_type: string; // "audio" | "midi" | "generated"
  track_id: string;
  start_time?: number;
  end_time?: number;
  audio_file?: string | null;
}

export interface TasmoTrackInput {
  id: string;
  name: string;
  type: string; // "audio" | "midi" | ...
  volume_db?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  clips?: TasmoClipInput[];
}

export interface TasmoProjectInput {
  project_name: string;
  tempo?: number;
  time_signature?: number[];
  sample_rate?: number;
  author?: string;
  tracks?: TasmoTrackInput[];
  source_daw?: string | null;
  import_warnings?: string[];
}

// --- Load result (minimal view; extra backend fields are ignored) ---
export interface TasmoLoadedClip {
  name: string;
  clip_type: string;
  audio_file: string | null;
}

export interface TasmoLoadedTrack {
  name: string;
  type: string;
  clips: TasmoLoadedClip[];
}

export interface TasmoProjectLoaded {
  project_name: string;
  tempo: number;
  sample_rate: number;
  tracks: TasmoLoadedTrack[];
  import_warnings?: string[];
}

export interface ProjectManifest {
  format: string;
  format_version: number;
  project_name: string;
  audio_mode: string; // "embedded" | "linked"
  total_tracks: number;
  total_clips?: number;
  sample_rate: number;
  created_at?: string;
  modified_at?: string;
}

export interface RecentItem {
  path: string;
  name: string;
}

export const projectApi = {
  save: (project: TasmoProjectInput, path: string, embed_audio: boolean) =>
    postJson<{ status: string; path: string; manifest: ProjectManifest }>('/api/project/save', {
      project,
      path,
      embed_audio,
    }),
  load: (path: string) =>
    postJson<{ project: TasmoProjectLoaded; manifest: ProjectManifest }>('/api/project/load', {
      path,
    }),
  info: (path: string) =>
    getJson<ProjectManifest>(`/api/project/info?path=${encodeURIComponent(path)}`),
  recent: () => getJson<RecentItem[]>('/api/project/recent'),
  listAudio: (path: string) =>
    getJson<{ files: string[] }>(`/api/project/list-audio?path=${encodeURIComponent(path)}`),
};

// Build a .tasmo save payload from an imported DAW project.
let _seq = 0;
const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${_seq++}`;

export function dawProjectToTasmo(d: DawProject): TasmoProjectInput {
  const tracks: TasmoTrackInput[] = d.tracks.map((t) => {
    const trackId = uid('t');
    const clipType = t.type === 'midi' ? 'midi' : 'audio';
    return {
      id: trackId,
      name: t.name,
      type: t.type === 'midi' ? 'midi' : 'audio',
      volume_db: t.volume_db,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      clips: (t.clips ?? []).map((c) => ({
        id: uid('c'),
        name: c.name,
        clip_type: clipType,
        track_id: trackId,
        start_time: c.start_time,
        end_time: c.end_time,
        audio_file: c.file_path ?? null,
      })),
    };
  });
  return {
    project_name: d.name,
    tempo: d.tempo,
    time_signature: Array.isArray(d.time_signature) ? d.time_signature.slice(0, 2) : [4, 4],
    sample_rate: d.sample_rate,
    source_daw: d.source_daw,
    import_warnings: d.warnings,
    tracks,
  };
}
