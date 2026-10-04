// theDAW's half of the SWAY tab's message protocol (v1), the parts that are data.
//
// SwayView relays MIDI, analysis and visibility to the embedded SwayCommand
// cockpit. A cockpit that shows theDAW's controls in its own header lists its
// capabilities in `sway/ready` and then asks for scenes, opens them and sets the
// audio source over the same channel. This module decides what an incoming
// frame asks for, orders the scene rows (the Gantasmo scenes theDAW ships
// first, then the user's saves, each newest first), reads the lists both "Open scene" and the cockpit show, and
// derives the hardware status the header shows.

import { getJson } from './apiJson';
import { basenameOf, pathKey, placesApi, type PlaceItem } from './placesClient';

/** The cockpit shows theDAW's controls in its own header. */
export const CAP_HOST_HEADER = 'host-header';
/** The cockpit posts sway/track-menu on a track's right-click and places audio
 *  the host answers with (sway/load-audio: a URL the host serves). */
export const CAP_TRACK_MENU = 'host-track-menu';
/** The cockpit shows the scene list theDAW sends. */
export const CAP_HOST_SCENES = 'host-scenes';

/** A scene in data/sway-projects, as GET /api/sway/projects lists it. */
export interface SwaySceneRow {
  name: string;
  path: string;
  /** True when the file is a scene theDAW's asset catalog installs. */
  builtin: boolean;
  /** Unix seconds. */
  mtime: number;
}

/** SwayView's audio source. The cockpit calls theDAW's master 'host'. */
export type HostAudioSource = 'thedaw' | 'input';

export type CockpitAction =
  | { kind: 'ready'; caps: string[] }
  | { kind: 'set-audio-source'; source: HostAudioSource }
  | { kind: 'request-scenes' }
  | { kind: 'open-scene'; name: string | null; path: string | null }
  | { kind: 'choose-scene-file' }
  | { kind: 'choose-plugin-file' }
  | { kind: 'track-menu'; trackId: string; name: string; empty: boolean; x: number; y: number };

/** This host answers sway/choose-plugin-file with sway/plugin-file. Listed in
 *  sway/host-ready's caps, so the cockpit waits for the dialog instead of
 *  giving up on a host that never answers. */
export const HOST_CAP_PLUGIN_FILE = 'plugin-file';

/** This host put its rack-effect API on the cockpit's window (lib/swayHostFx):
 *  every cockpit track's FX chain can list and play theDAW's rack effects. */
export const HOST_CAP_RACK_FX = 'rack-fx';

/** The same API object also carries `vst` (lib/swayHostVst): every cockpit
 *  track's VST3 plugins run live in theDAW's plugin host. */
export const HOST_CAP_VST_LIVE = 'vst-live';

/** What this host can do for the cockpit, sent in sway/host-ready. */
export const HOST_CAPS: readonly string[] = [HOST_CAP_PLUGIN_FILE, HOST_CAP_RACK_FX, HOST_CAP_VST_LIVE];

/** The caps one sway/host-ready lists. `rackFxHanded` is whether the host API
 *  reached the cockpit's window; a cockpit told 'rack-fx' reads it from there.
 *  `vstLive` is whether this machine can run plugins live; it needs the API too. */
export function hostCapsFor(rackFxHanded: boolean, vstLive = false): string[] {
  return HOST_CAPS.filter(
    (c) => (c !== HOST_CAP_RACK_FX || rackFxHanded) && (c !== HOST_CAP_VST_LIVE || (rackFxHanded && vstLive)),
  );
}

/** The sway/plugin-file frame that answers a sway/choose-plugin-file. */
export interface PluginFileFrame {
  type: 'sway/plugin-file';
  /** The picked .gan's absolute path, or null for a cancel or a failure. */
  path: string | null;
  /** The file's name, for the cockpit's notice; absent without a path. */
  name?: string;
  /** Why no file could be picked; absent for a pick or a plain cancel. */
  failure?: string;
}

/**
 * The answer to a sway/choose-plugin-file: a picked path, a cancel (no path,
 * no failure), or a failure. A path that is not a .gan is a failure too, so
 * the cockpit never asks theDAW to open a file of another kind.
 */
export function pluginFileFrame(picked: { path?: string | null; cancelled?: boolean } | null, failure?: string | null): PluginFileFrame {
  if (failure) return { type: 'sway/plugin-file', path: null, failure };
  const path = picked && !picked.cancelled && typeof picked.path === 'string' && picked.path.trim() ? picked.path : null;
  if (!path) return { type: 'sway/plugin-file', path: null };
  if (!/\.gan$/i.test(path)) return { type: 'sway/plugin-file', path: null, failure: 'Choose a file that ends in .gan.' };
  return { type: 'sway/plugin-file', path, name: basenameOf(path) };
}

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * What a frame from the cockpit asks for, or null when it is not a request this
 * host answers. The caller has already checked the frame's window and origin.
 * An open-scene frame with a name opens a row from `rows` by name, the way
 * "Open scene" does; one with only a path opens a `recent` file.
 */
export function cockpitAction(data: unknown): CockpitAction | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case 'sway/ready':
      return {
        kind: 'ready',
        caps: Array.isArray(d.caps) ? d.caps.filter((c): c is string => typeof c === 'string') : [],
      };
    case 'sway/set-audio-source':
      if (d.source === 'host') return { kind: 'set-audio-source', source: 'thedaw' };
      if (d.source === 'input') return { kind: 'set-audio-source', source: 'input' };
      return null;
    case 'sway/request-scenes':
      return { kind: 'request-scenes' };
    case 'sway/open-scene': {
      const name = nonEmpty(d.name);
      const path = nonEmpty(d.path);
      return name || path ? { kind: 'open-scene', name, path } : null;
    }
    case 'sway/choose-scene-file':
      return { kind: 'choose-scene-file' };
    case 'sway/choose-plugin-file':
      return { kind: 'choose-plugin-file' };
    case 'sway/track-menu': {
      // x, y are viewport px inside the cockpit's frame; the host adds the
      // frame's own offset before opening its menu.
      const trackId = nonEmpty(d.trackId);
      if (!trackId || typeof d.x !== 'number' || typeof d.y !== 'number') return null;
      return {
        kind: 'track-menu',
        trackId,
        name: nonEmpty(d.name) ?? 'this track',
        empty: d.empty === true,
        x: d.x,
        y: d.y,
      };
    }
    default:
      return null;
  }
}

/** The Gantasmo scenes theDAW ships first, then the user's saves, each newest first. */
export function orderSceneRows(rows: SwaySceneRow[]): SwaySceneRow[] {
  const newest = (a: SwaySceneRow, b: SwaySceneRow) => b.mtime - a.mtime;
  return [...rows.filter((r) => r.builtin).sort(newest), ...rows.filter((r) => !r.builtin).sort(newest)];
}

/** The rows of a /api/sway/projects body. A row without `builtin` is a save. */
export function sceneRowsFrom(projects: unknown): SwaySceneRow[] {
  if (!Array.isArray(projects)) return [];
  const rows: SwaySceneRow[] = [];
  for (const raw of projects) {
    const r = raw as Partial<SwaySceneRow> | null;
    if (!r || typeof r.name !== 'string' || typeof r.path !== 'string') continue;
    rows.push({
      name: r.name,
      path: r.path,
      builtin: r.builtin === true,
      mtime: typeof r.mtime === 'number' && Number.isFinite(r.mtime) ? r.mtime : 0,
    });
  }
  return rows;
}

/** Recent .sway files the backend will serve, less those already listed by name. */
export function recentOutsideSceneFolder(recent: PlaceItem[], rows: SwaySceneRow[]): PlaceItem[] {
  const inFolder = new Set(rows.map((r) => pathKey(r.path)));
  return recent.filter((it) => it.servable && !inFolder.has(pathKey(it.path)));
}

export interface SceneLists {
  rows: SwaySceneRow[];
  recent: PlaceItem[];
  /** Why the saved scenes could not be read, or null. */
  error: string | null;
}

/** The scene lists, read fresh: saved scenes in order, then recent files. */
export async function loadSceneLists(): Promise<SceneLists> {
  const saved = getJson<{ projects?: unknown }>('/api/sway/projects').then(
    (j) => ({ rows: sceneRowsFrom(j.projects), error: null as string | null }),
    (e: unknown) => ({ rows: [] as SwaySceneRow[], error: e instanceof Error ? e.message : String(e) }),
  );
  const [scenes, recent] = await Promise.all([saved, placesApi.recent({ kind: 'sway', exts: ['.sway'] })]);
  return {
    rows: orderSceneRows(scenes.rows),
    recent: recentOutsideSceneFolder(recent, scenes.rows),
    error: scenes.error,
  };
}

/** The sentence shown when the saved scenes cannot be read. */
export function scenesUnreadable(detail: string): string {
  return `Could not read the saved scenes: ${detail}`;
}

/** The body of a `sway/host-scenes` frame. `failure` wins over a read error. */
export function hostScenesFrame(
  lists: SceneLists,
  failure: string | null = null,
): {
  rows: SwaySceneRow[];
  recent: { name: string; path: string }[];
  error?: string;
} {
  const error = failure ?? (lists.error ? scenesUnreadable(lists.error) : null);
  return {
    rows: lists.rows.map(({ name, path, builtin, mtime }) => ({ name, path, builtin, mtime })),
    recent: lists.recent.map((it) => ({ name: it.name || basenameOf(it.path), path: it.path })),
    ...(error ? { error } : {}),
  };
}

export type HardwareTone = 'off' | 'none' | 'ok';

/** The name every label shows for the hardware. Its MIDI port is named
 *  "Audima Labs The Sway", and ports are still matched by that name. */
export const SWAY_HARDWARE_NAME = 'Audima Labs Sway';

/** The MIDI hardware line: what theDAW's own MIDIAccess has hooked up. */
export function hardwareStatus(midiEnabled: boolean, inputs: string[]): { hardware: string; tone: HardwareTone } {
  if (!midiEnabled) return { hardware: 'MIDI off', tone: 'off' };
  if (inputs.length === 0) return { hardware: 'no MIDI device', tone: 'none' };
  const sway = inputs.some((n) => /sway|audima/i.test(n));
  return { hardware: sway ? SWAY_HARDWARE_NAME : inputs.join(', '), tone: 'ok' };
}
