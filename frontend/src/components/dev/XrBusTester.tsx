/**
 * XR control-bus tester (dev only).
 *
 * A simulated theDAW-XR controller in the browser: it opens its OWN WebSocket
 * peer to the `xrcontrol` relay (`/api/xr/control/ws`), asks for the live
 * control manifest, and renders one real control per entry that sends
 * `control-set` back over the bus. That exercises the full P0 + P1 loop
 * (controller -> relay -> theDAW host -> the wired setter) with no headset and
 * no console snippet.
 *
 * Mounted only under import.meta.env.DEV (see App.tsx), so it never ships in a
 * production build. The theDAW host peer (xrControlClient, started when MIDI is
 * enabled) must be connected for control-sets to take effect; until it is, this
 * panel connects but receives no manifest.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Radio, X } from 'lucide-react';
import type { XrManifestEntry, XrControlValue } from '../../state/xrControlClient';

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/xr/control/ws`;
}

const RANGE_KINDS = new Set(['knob', 'fader', 'crossfader', 'xy', 'xyz', 'jog']);

export function XrBusTester(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState<XrManifestEntry[]>([]);
  const [values, setValues] = useState<Record<string, XrControlValue>>({});
  const [lastEcho, setLastEcho] = useState('');
  const wsRef = useRef<WebSocket | null>(null);

  const disconnect = useCallback(() => {
    const sock = wsRef.current;
    wsRef.current = null;
    if (sock) {
      try { sock.close(); } catch { /* already closing */ }
    }
    setConnected(false);
    setEntries([]);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(wsUrl());
    } catch {
      return;
    }
    wsRef.current = sock;
    sock.onopen = () => {
      setConnected(true);
      sock.send(JSON.stringify({ type: 'request-controls' }));
    };
    sock.onmessage = (e) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const m = parsed as { type?: unknown; id?: unknown; value?: unknown; entries?: unknown };
      if (m.type === 'manifest' && Array.isArray(m.entries)) {
        setEntries(m.entries as XrManifestEntry[]);
      } else if (m.type === 'control-changed' && typeof m.id === 'string') {
        const id = m.id;
        const value = m.value as XrControlValue;
        setValues((v) => ({ ...v, [id]: value }));
        setLastEcho(`${id} = ${String(value)}`);
      }
    };
    sock.onerror = () => {
      try { sock.close(); } catch { /* already closing */ }
    };
    sock.onclose = () => {
      if (wsRef.current === sock) wsRef.current = null;
      setConnected(false);
    };
  }, []);

  // Close the peer when the panel unmounts.
  useEffect(() => () => disconnect(), [disconnect]);

  const send = useCallback((id: string, value: XrControlValue) => {
    const sock = wsRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'control-set', id, value }));
    }
    setValues((v) => ({ ...v, [id]: value }));
  }, []);

  const toggleConnect = useCallback(() => {
    if (connected || wsRef.current) disconnect();
    else connect();
  }, [connected, connect, disconnect]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open the XR control-bus tester"
        title="XR control-bus tester (dev)"
        className="fixed bottom-3 right-3 z-200 flex items-center gap-1.5 rounded-full border border-cyan-400/50 bg-cyan-500/15 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-cyan-100 shadow-[0_0_14px_rgba(34,211,238,0.4)] hover:bg-cyan-500/30"
      >
        <Radio className="h-3.5 w-3.5" />
        XR bus
      </button>
    );
  }

  // Group entries by their manifest group for tidy clusters.
  const groups: Record<string, XrManifestEntry[]> = {};
  for (const en of entries) {
    (groups[en.group] ??= []).push(en);
  }

  return (
    <section
      aria-label="XR control-bus tester"
      className="fixed bottom-3 right-3 z-200 flex max-h-[70vh] w-80 flex-col rounded-lg border border-cyan-400/40 bg-zinc-950/95 text-zinc-200 shadow-[0_0_24px_rgba(34,211,238,0.35)] backdrop-blur"
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-cyan-300" />
          <span className="text-[11px] font-black uppercase tracking-widest text-cyan-100">
            XR control bus
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close the XR control-bus tester"
          className="rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={toggleConnect}
          aria-pressed={connected}
          aria-label={connected ? 'Disconnect the simulated XR controller' : 'Connect the simulated XR controller'}
          className={
            connected
              ? 'flex items-center gap-2 rounded border border-emerald-400/60 bg-emerald-500/20 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-100'
              : 'flex items-center gap-2 rounded border border-white/15 bg-white/5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-zinc-300 hover:bg-white/10'
          }
        >
          <span
            className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-zinc-500'}`}
            aria-hidden="true"
          />
          {connected ? 'Connected' : 'Connect'}
        </button>
        <span className="text-[10px] tabular-nums text-zinc-400">
          {entries.length} control{entries.length === 1 ? '' : 's'}
        </span>
      </div>

      {connected && entries.length === 0 && (
        <p className="px-3 pb-2 text-[10px] leading-snug text-amber-300/90">
          Connected, but theDAW sent no manifest yet. Enable MIDI in Settings so the
          control host attaches, then reconnect.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {Object.entries(groups).map(([group, items]) => (
          <fieldset key={group} className="mb-3 border-0 p-0">
            <legend className="mb-1 text-[9px] font-black uppercase tracking-widest text-cyan-300/80">
              {group}
            </legend>
            <div className="flex flex-col gap-1.5">
              {items.map((en) => (
                <ControlRow
                  key={en.id}
                  entry={en}
                  value={values[en.id]}
                  onSend={send}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      {lastEcho && (
        <footer className="border-t border-white/10 px-3 py-1.5 text-[9px] text-zinc-500">
          last echo: <span className="text-zinc-300">{lastEcho}</span>
        </footer>
      )}
    </section>
  );
}

function ControlRow({
  entry,
  value,
  onSend,
}: {
  entry: XrManifestEntry;
  value: XrControlValue | undefined;
  onSend: (id: string, value: XrControlValue) => void;
}): React.ReactElement {
  const fieldId = `xr-${entry.id}`;

  if (RANGE_KINDS.has(entry.kind)) {
    const min = entry.min ?? 0;
    const max = entry.max ?? 1;
    const step = entry.step ?? 0.01;
    const current = typeof value === 'number' ? value : min;
    return (
      <label htmlFor={fieldId} className="flex items-center gap-2 text-[10px]">
        <span className="w-28 shrink-0 truncate text-zinc-300" title={entry.label}>
          {entry.label}
        </span>
        <input
          id={fieldId}
          name={fieldId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={current}
          onChange={(e) => onSend(entry.id, Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-cyan-400"
        />
        <span className="w-10 shrink-0 text-right tabular-nums text-zinc-400">
          {current}
          {entry.unit ? <span className="text-zinc-600">{entry.unit}</span> : null}
        </span>
      </label>
    );
  }

  if (entry.kind === 'toggle') {
    const on = Boolean(value);
    return (
      <button
        type="button"
        onClick={() => onSend(entry.id, !on)}
        aria-pressed={on}
        aria-label={`${entry.label} toggle`}
        className={
          on
            ? 'flex items-center justify-between rounded border border-emerald-400/50 bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-100'
            : 'flex items-center justify-between rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-zinc-300 hover:bg-white/10'
        }
      >
        <span className="truncate" title={entry.label}>{entry.label}</span>
        <span className="ml-2 shrink-0 text-[9px] font-black uppercase tracking-widest">
          {on ? 'On' : 'Off'}
        </span>
      </button>
    );
  }

  // button / pad / grid: momentary trigger.
  return (
    <button
      type="button"
      onClick={() => onSend(entry.id, true)}
      aria-label={`Trigger ${entry.label}`}
      className="flex items-center justify-between rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-zinc-300 hover:border-cyan-400/40 hover:bg-cyan-500/10"
    >
      <span className="truncate" title={entry.label}>{entry.label}</span>
      <span className="ml-2 shrink-0 text-[9px] font-black uppercase tracking-widest text-cyan-300/70">
        Tap
      </span>
    </button>
  );
}
