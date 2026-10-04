// Typed client for the VST3 hosting backend (/api/vst/*).
// MIX consumes VSTs as effect-chain nodes: it scans for plugins here, and the
// per-stage processing is an UPLOAD POST to /api/vst/process-file driven from
// studioStore (mirroring /api/studio/process). EDIT's offline prints of an
// insert go through `processFileThroughVst` below, to the same route.
import { delJson, describeApiError, getJson, pairingHeaderFor, postJson } from './apiJson';
import { parseInstrumentRender, type InstrumentRenderResult, type InstrumentRenderTrack } from './vstInstrumentMidi';
import { editorWindowsSuppressed, OFFLINE_EDITOR_SUPPRESSED_LOG } from './vstLive/editorWindowSwitch';
import type { HostParamAutomation } from './render/vstParamAutomation';

export interface Vst3PluginInfo {
  /** The bundle/file stem. Always present, because it costs nothing to read —
   *  but it is the plugin FILE's name, not necessarily the plugin's own. */
  name: string;
  path: string;
  manufacturer: string;
  version: string;
  category: string; // "effect" | "instrument" | "unknown"
  file_size_mb: number;
  last_modified: number;
  /** The plugin's OWN name, read from the plugin by the backend metadata probe
   *  ("Pro-Q 4" where `name` is "FabFilter Pro-Q 4"). Absent until that probe
   *  lands, and for a plugin that never loads — always fall back to `name`. */
  display_name?: string;
  /** The plugin's VST3 identifier (probe-supplied), stable across file renames.
   *  Absent for the same reasons as `display_name`. */
  identifier?: string;
}

// Result of a native-GUI editor session (see /api/vst/open-editor). When status
// is 'ok', raw_state is the base64 plugin state to store on the chain node.
export interface VstEditorResult {
  status: 'none' | 'launching' | 'opening' | 'ok' | 'error';
  raw_state?: string;
  error?: string;
  plugin_path?: string;
}

// Embed rect for reparenting the editor into the MIX area (CSS px + DPR).
export interface VstEmbedRect { x: number; y: number; w: number; h: number; dpr: number; }

type ElectronEmbedApi = {
  getNativeWindowHandle?: () => Promise<string | null>;
  getContentBounds?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
};

// Electron exposes the host window handle via the preload bridge; null in a
// plain browser (the editor then opens as a floating native window).
export async function getNativeWindowHandle(): Promise<string | null> {
  const api = (window as unknown as { electronAPI?: ElectronEmbedApi }).electronAPI;
  if (!api?.getNativeWindowHandle) return null;
  try {
    return await api.getNativeWindowHandle();
  } catch {
    return null;
  }
}

// Screen-space content bounds (DIP) of the Electron window, for converting an
// element's client rect into absolute screen coordinates.
export async function getContentBounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const api = (window as unknown as { electronAPI?: ElectronEmbedApi }).electronAPI;
  if (!api?.getContentBounds) return null;
  try {
    return await api.getContentBounds();
  } catch {
    return null;
  }
}

/** Handles a rect update for a plugin whose LIVE editor is open; returns true
 *  when it took ownership of the call. Installed by `vstEditorStore` for as
 *  long as a live editor session exists — see `setLiveEditorRectRouter`. */
type LiveEditorRectRouter = (
  pluginPath: string,
  rect: VstEmbedRect & { sx?: number; sy?: number; close?: boolean },
) => boolean;

let liveEditorRectRouter: LiveEditorRectRouter | null = null;

/**
 * Point `vstApi.editorRect` at a live host session (or `null` to send rects
 * back to the offline sidecar).
 *
 * A hook rather than a direct import because the flow runs the other way:
 * `vstEditorStore` already depends on this module, and the live session
 * registry depends on it too, so reaching for either from here would close an
 * import cycle.
 */
export function setLiveEditorRectRouter(router: LiveEditorRectRouter | null): void {
  liveEditorRectRouter = router;
}

/** The size of a plugin's LIVE editor in physical px: `null` while the host has
 *  not reported one, `undefined` when the path is not this router's plugin. */
type LiveEditorSizeRouter = (pluginPath: string) => { w: number; h: number } | null | undefined;

let liveEditorSizeRouter: LiveEditorSizeRouter | null = null;

/**
 * Point `vstApi.editorSize` at a live host session (or `null` to read the
 * offline sidecar's size file again). The live host reports its editor's size
 * on the session's socket and writes no size file, so without this a live
 * editor never had a size and its window stayed at the opening box.
 */
export function setLiveEditorSizeRouter(router: LiveEditorSizeRouter | null): void {
  liveEditorSizeRouter = router;
}

export const vstApi = {
  // `install_folder`: the folder the scan reads for installed plugins, which an
  // empty plugin list names (vstStore vst3InstallHint).
  scan: (refresh = false) =>
    getJson<{ plugins: Vst3PluginInfo[]; install_folder?: string }>(`/api/vst/scan?refresh=${refresh ? 'true' : 'false'}`),
  // Open the plugin's real native editor window (sidecar process). Pass the
  // node's current raw_state so the editor opens where the user left off. When
  // `embed` is given (Electron), the editor is reparented into the MIX area over
  // its rect; otherwise it opens as a floating window.
  openEditor: (
    pluginPath: string,
    rawState?: string | null,
    embed?: { parentHwnd: string; rect: VstEmbedRect },
  ) => {
    // The one place an OFFLINE plugin window can be asked for (see editorWindowSwitch.ts).
    // Rejecting, not resolving: the caller must not record an editor that never opened.
    if (editorWindowsSuppressed()) {
      console.info(OFFLINE_EDITOR_SUPPRESSED_LOG);
      return Promise.reject(new Error('plugin windows are switched off (test mode)'));
    }
    return postJson<{ status: string; preset_path: string }>('/api/vst/open-editor', {
      plugin_path: pluginPath,
      raw_state: rawState ?? null,
      parent_hwnd: embed?.parentHwnd ?? null,
      rect: embed?.rect ?? null,
    });
  },
  // Push a live embed-rect update (viewport + scroll offset), or close the
  // embedded editor (close=true). sx/sy let an oversized editor pan as the host
  // scrolls. All values are physical px.
  editorRect: (
    pluginPath: string,
    rect: VstEmbedRect & { sx?: number; sy?: number; close?: boolean },
  ) => {
    // A LIVE session's editor belongs to the host process that is making the
    // sound, not to the offline sidecar, so its rect updates go over that
    // session's socket. Routing here rather than at the call site means
    // `VstEmbedHost` keeps pushing rects the one way it always has, and this is
    // the single place both editors are reached from.
    if (liveEditorRectRouter?.(pluginPath, rect)) return Promise.resolve({ status: 'live' });
    return postJson<{ status: string }>('/api/vst/editor-rect', { plugin_path: pluginPath, ...rect });
  },
  editorResult: (pluginPath: string) =>
    getJson<VstEditorResult>(`/api/vst/editor-result?plugin_path=${encodeURIComponent(pluginPath)}`),
  // The editor's natural (physical px) size, so the host can size its scroll area.
  editorSize: (pluginPath: string): Promise<{ status: string; w?: number; h?: number }> => {
    const live = liveEditorSizeRouter?.(pluginPath);
    if (live !== undefined) return Promise.resolve(live ? { status: 'ok', w: live.w, h: live.h } : { status: 'none' });
    return getJson<{ status: string; w?: number; h?: number }>(`/api/vst/editor-size?plugin_path=${encodeURIComponent(pluginPath)}`);
  },
};

/**
 * Print one EDIT track through its VST3 instrument: POST /api/vst/render-midi
 * with the track's messages, and its WAV back. One track per request, so a
 * print can report and be called off track by track. Rejects with the
 * backend's own words.
 */
export async function renderInstrumentTrack(
  track: InstrumentRenderTrack,
  sampleRate: number,
  fetchImpl: typeof fetch = fetch,
): Promise<InstrumentRenderResult> {
  const url = '/api/vst/render-midi';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...pairingHeaderFor(url) },
    body: JSON.stringify({ sample_rate: sampleRate, channels: 2, tracks: [track] }),
  });
  if (!res.ok) throw new Error(await describeApiError(res));
  const [result] = await parseInstrumentRender(await res.formData());
  if (!result) throw new Error('the instrument render answered with no track');
  return result;
}

/** The plugin a `processFileThroughVst` hop runs: `VstNode`'s fields. */
export interface VstHopPlugin {
  plugin_path: string;
  /** Which plugin inside the file (a .vst3 can hold several). */
  plugin_name?: string;
  raw_state?: string;
  state_host?: string;
}

/**
 * Run one audio file through one VST3 plugin: POST /api/vst/process-file, and
 * the plugin's WAV back, 32-bit float. Every offline print of an insert goes
 * through here (a track freeze, a stem, an export, the frozen master), one
 * call per plugin in chain order.
 *
 * The entry's captured state rides along: without it every plugin rendered at
 * its factory defaults, silently discarding whatever the user dialled in. So
 * does WHICH host captured it: a state theDAW's live host wrote is rendered
 * back through that host (`state_host: 'thedaw'`), and absent means the
 * pedalboard path the backend has always taken. And so does WHICH plugin in
 * the file: a .vst3 can hold several, the live host loads the one the entry
 * names, and theDAW's render host loads the first one when it is given no
 * name, so a print without it could run a different plugin from the one heard.
 *
 * `automation` is the plugin's automated parameters over this file
 * (lib/render/vstParamAutomation); the backend moves them block by block as it
 * renders. Their indices are the live host's own list, so an automated plugin
 * with no captured state at all prints through that host: no state stands in
 * the way, and the host is the one whose parameter numbers the lanes name.
 *
 * A failure rejects in the backend's own words and is not retried through the
 * other host: a silent fall back would print a state that host cannot read and
 * report a clean render of the wrong sound. What the plugin did not take (a
 * state or a parameter it refused) comes back in `X-Vst-Warnings`, since the
 * body is audio, and is handed to `onWarning` one line at a time.
 */
export async function processFileThroughVst(
  file: Blob,
  vst: VstHopPlugin,
  name: string,
  opts: {
    onWarning?: (warning: string) => void;
    fetchImpl?: typeof fetch;
    automation?: readonly HostParamAutomation[];
  } = {},
): Promise<File> {
  const url = '/api/vst/process-file';
  const form = new FormData();
  form.append('audio', file, name);
  form.append('plugin_path', vst.plugin_path);
  if (vst.plugin_name) form.append('plugin_name', vst.plugin_name);
  form.append('params', '{}');
  if (vst.raw_state) form.append('raw_state', vst.raw_state);
  const automated = (opts.automation?.length ?? 0) > 0;
  if (vst.state_host === 'thedaw' || (automated && !vst.raw_state)) form.append('state_host', 'thedaw');
  if (automated) form.append('automation', JSON.stringify(opts.automation));
  // pairingHeaderFor: a device opened from the Mobile Access share link renders
  // through the same route, paired; {} on this machine's own UI.
  const res = await (opts.fetchImpl ?? fetch)(url, { method: 'POST', body: form, headers: pairingHeaderFor(url) });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  const warned = res.headers.get('X-Vst-Warnings');
  if (warned && opts.onWarning) {
    let lines: unknown = [warned];
    try { lines = JSON.parse(warned); } catch { /* not JSON: the header as it came */ }
    for (const w of Array.isArray(lines) ? lines : [warned]) opts.onWarning(String(w));
  }
  return new File([await res.blob()], name, { type: 'audio/wav' });
}

/* ── live host sessions (/api/vst/live/*) ───────────────────────────────────
   The LIVE path is a different thing from the routes above. Those drive the
   offline pedalboard renderer and its one editor sidecar; these spawn a native
   host process per chain entry that processes the signal in real time, and the
   editor they open belongs to the instance that is making the sound. The wire
   protocol behind `ws_url` is docs/design/vst-live-protocol.md. */

/** What `GET /api/vst/live/host` says about the host binary on this machine. */
export interface VstLiveHostInfo {
  available: boolean;
  path?: string;
  version?: string;
  /** Why it is not available — shown on the FX row, so it must be a sentence. */
  reason?: string;
}

/** A spawned host process, from `POST /api/vst/live/session`. */
export interface VstLiveSessionInfo {
  session_id: string;
  /** `ws://127.0.0.1:<port>` — loopback only; nothing leaves the machine. */
  ws_url: string;
  pid: number;
  protocol: number;
}

/** Request body for `POST /api/vst/live/session`. */
export interface VstLiveSessionRequest {
  chain_entry_id: string;
  plugin_path: string;
  plugin_name?: string;
  sample_rate: number;
  block_size?: number;
  channels?: number;
  /** The entry's stored `raw_state`, written to the session's state file before
   *  the spawn so the plugin starts where the user left it. */
  raw_state?: string;
}

export const vstLiveApi = {
  host: () => getJson<VstLiveHostInfo>('/api/vst/live/host'),
  /** Idempotent per `chain_entry_id` while the process is alive. */
  createSession: (body: VstLiveSessionRequest) =>
    postJson<VstLiveSessionInfo>('/api/vst/live/session', body),
  session: (id: string) =>
    getJson<{ alive: boolean; pid: number; port: number; started_at: number; log_tail?: string }>(
      `/api/vst/live/session/${encodeURIComponent(id)}`,
    ),
  /** Shuts the host down cleanly and returns the state it wrote on the way out. */
  deleteSession: (id: string) =>
    delJson<{ raw_state?: string }>(`/api/vst/live/session/${encodeURIComponent(id)}`),
};

/**
 * Close a session during `pagehide`/`beforeunload`, where a normal `fetch` is
 * cancelled with the document. `sendBeacon` cannot issue a DELETE, so this
 * prefers a keepalive fetch and falls back to a beacon POST to the same path
 * with an explicit method override — the backend treats either as a close.
 *
 * Returns nothing and never throws: an unload handler has no way to report a
 * failure, and a leaked host process is reaped by `--parent-pid` anyway.
 */
export function closeLiveSessionOnUnload(id: string): void {
  const url = `/api/vst/live/session/${encodeURIComponent(id)}`;
  try {
    void fetch(url, { method: 'DELETE', keepalive: true });
    return;
  } catch {
    /* fall through to the beacon */
  }
  try {
    navigator.sendBeacon?.(`${url}?_method=DELETE`);
  } catch {
    /* nothing else to try; --parent-pid covers it */
  }
}
