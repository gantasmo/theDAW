/**
 * XR control client (spatialization P0/P1).
 *
 * Holds a WebSocket to the backend `xrcontrol` relay (`/api/xr/control/ws`), the
 * transport between theDAW (this browser, which owns the control manifest and
 * the wired setters) and a theDAW-XR headset. This browser is the HOST peer: it
 * publishes a control manifest aggregated from registered sources and applies
 * inbound `control-set` messages by routing them to the source that owns the id.
 * A new control surfaces in XR the moment its source contributes a manifest
 * entry, with no Unity edit.
 *
 * Same-origin URL so it rides the Vite dev proxy in development and is direct in
 * production. Auto-reconnects while running.
 */
import { logInfo, logWarn } from './logStore';

export type XrControlValue = number | boolean;

/** One self-describing control in the manifest XR consumes. Mirrors the shape
 *  theDAW's own registries already use (DJ_TARGETS, the VJ control manifest). */
export interface XrManifestEntry {
  id: string;
  area: string;
  group: string;
  label: string;
  /** knob | fader | button | toggle | crossfader | select | xy | xyz | jog | grid */
  kind: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  unit?: string;
  /** Current value, when the source can read one (seeds the XR widget). */
  value?: XrControlValue;
}

/** A contributor of controls for one namespace (e.g. "dj", "vj", "make"). */
export interface XrControlSource {
  /** Namespace that owns this source's ids, e.g. "dj" for "dj.eqHi.A". */
  area: string;
  /** Contribute this source's manifest entries (async so it can lazy-load). */
  buildEntries: () => Promise<XrManifestEntry[]> | XrManifestEntry[];
  /** Apply an inbound control value. Returns true when the id was handled. */
  apply: (id: string, value: XrControlValue) => boolean | Promise<boolean>;
}

const sources = new Map<string, XrControlSource>();
let manifestVersion = 0;

/**
 * Register a control source (DJ, then VJ / MAKE in later phases). Bumps the
 * manifest version and re-publishes when connected. Idempotent and safe to call
 * before or after {@link startXrControl}.
 */
export function registerXrControlSource(source: XrControlSource): void {
  sources.set(source.area, source);
  manifestVersion += 1;
  void publishManifest();
}

let ws: WebSocket | null = null;
let reconnectTimer = 0;
let running = false;
let everConnected = false;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/xr/control/ws`;
}

async function buildManifest(): Promise<XrManifestEntry[]> {
  const all: XrManifestEntry[] = [];
  for (const s of sources.values()) {
    try {
      const entries = await s.buildEntries();
      all.push(...entries);
    } catch {
      /* a source that cannot build right now is skipped, never fatal */
    }
  }
  return all;
}

async function publishManifest(): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const entries = await buildManifest();
  ws.send(JSON.stringify({ type: 'manifest', version: manifestVersion, entries }));
}

/** Mirror a host-side value move to XR so its widget follows theDAW state. */
export function publishControlChanged(id: string, value: XrControlValue): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'control-changed', id, value }));
  }
}

async function applyControlSet(id: string, value: XrControlValue): Promise<void> {
  const area = id.split('.')[0];
  const source = sources.get(area);
  if (!source) return;
  try {
    await source.apply(id, value);
  } catch {
    /* a setter that throws (e.g. engine not started yet) is non-fatal */
  }
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
    logInfo('xrcontrol', 'XR control bus connected.');
    // Seed any controller already waiting on the relay.
    void publishManifest();
  };
  sock.onmessage = (e) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof e.data === 'string' ? e.data : '');
    } catch {
      return; /* ignore malformed frame */
    }
    if (!parsed || typeof parsed !== 'object') return;
    const m = parsed as { type?: unknown; id?: unknown; value?: unknown };
    if (typeof m.type !== 'string') return;
    if (m.type === 'request-controls') {
      void publishManifest();
    } else if (m.type === 'control-set' && typeof m.id === 'string') {
      void applyControlSet(m.id, m.value as XrControlValue);
    }
  };
  sock.onerror = () => {
    try { sock.close(); } catch { /* already closing */ }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (running && everConnected) logWarn('xrcontrol', 'XR control bus disconnected — retrying…');
    scheduleReconnect();
  };
}

/** Open (and keep open) the XR control bus. Safe to call repeatedly. */
export function startXrControl(): void {
  if (running) return;
  running = true;
  everConnected = false;
  connect();
}

/** Close the bus and stop reconnecting. */
export function stopXrControl(): void {
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

export function isXrControlConnected(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
