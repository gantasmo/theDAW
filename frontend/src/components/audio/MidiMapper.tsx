/**
 * Shared MIDI mapper popup, mounted next to features that want a
 * controller-friendly interface (Piano, Sequence). Matches the same
 * pill → LEARN editor pattern the VJ sidecar uses, but is generic:
 * the caller passes a list of `MidiParamDef`s describing what's
 * mappable, plus an `onChange(key, value)` callback fired whenever
 * a mapped CC produces a fresh value. Mappings persist to
 * localStorage under `storageKey`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, Music2, Plug, X, RotateCcw, Crosshair, Zap } from 'lucide-react';
import { subscribeToMidi } from '../../state/midiBus';
import { midiIgnoreLabel, useMidiIgnoreStore } from '../../state/midiIgnoreStore';
import { enableMidi } from '../../state/midiTriggerStore';

export interface MidiParamDef<K extends string = string> {
  key: K;
  label: string;
  min: number;
  max: number;
  /** CC# this param auto-maps to on first run. null = no auto-map. */
  autoCc: number | null;
  /** True if the param value should be rounded to an integer (BPM,
   *  step count, etc). */
  integer?: boolean;
}

export interface MidiMapping {
  kind: 'cc' | 'note';
  /** CC# (0-127) or note number. */
  number: number;
  /** Channel 0-15 or null = any. */
  channel: number | null;
  inverted?: boolean;
}

interface MidiMapperProps<K extends string = string> {
  /** Human label shown in the panel header (e.g. "PIANO" / "SEQUENCE"). */
  title: string;
  /** Mappable parameters this surface exposes. */
  params: ReadonlyArray<MidiParamDef<K>>;
  /** Fires when a mapped CC produces a new value for one of `params`. */
  onChange: (key: K, value: number) => void;
  /** localStorage key for the mappings dictionary. Make this unique
   *  per surface so Piano and Sequence don't collide. */
  storageKey: string;
  /** Color accent — affects the pill border and active LEARN highlight. */
  accent?: 'purple' | 'cyan' | 'emerald';
}

function scaleCcValue(value: number, def: MidiParamDef): number {
  const clamped = Math.max(0, Math.min(127, value));
  const norm = clamped / 127;
  const scaled = def.min + norm * (def.max - def.min);
  return def.integer ? Math.round(scaled) : scaled;
}

function loadMappings<K extends string>(
  storageKey: string,
  params: ReadonlyArray<MidiParamDef<K>>,
): Record<K, MidiMapping> {
  const out: Record<string, MidiMapping> = {};
  // Seed with auto-map defaults so a fresh user sees something
  // wired up to their controller immediately.
  for (const def of params) {
    if (def.autoCc !== null) {
      out[def.key] = { kind: 'cc', number: def.autoCc, channel: null };
    }
  }
  if (typeof window === 'undefined') return out as Record<K, MidiMapping>;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, MidiMapping>;
      const keys = new Set(params.map((p) => p.key));
      for (const [k, v] of Object.entries(parsed)) {
        if (keys.has(k as K) && v && typeof v.number === 'number') out[k] = v;
      }
    }
  } catch {
    /* corrupted store; fall back to defaults */
  }
  return out as Record<K, MidiMapping>;
}

function saveMappings(storageKey: string, m: Record<string, MidiMapping>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(m));
  } catch {
    /* quota / private mode — silently skip */
  }
}

const ACCENTS = {
  purple: {
    pillBorder: 'border-purple-500/40',
    pillBg: 'bg-purple-500/10',
    pillText: 'text-purple-200',
    pillDot: 'bg-purple-400',
    icon: 'text-purple-300',
    headerText: 'text-purple-200',
    headerBorder: 'border-purple-500/20',
    panelBorder: 'border-purple-500/40',
    learn: 'border-amber-400/60 bg-amber-500/15 text-amber-200',
    learnHover: 'hover:text-purple-200 hover:border-purple-500/40',
  },
  cyan: {
    pillBorder: 'border-cyan-500/40',
    pillBg: 'bg-cyan-500/10',
    pillText: 'text-cyan-200',
    pillDot: 'bg-cyan-400',
    icon: 'text-cyan-300',
    headerText: 'text-cyan-200',
    headerBorder: 'border-cyan-500/20',
    panelBorder: 'border-cyan-500/40',
    learn: 'border-amber-400/60 bg-amber-500/15 text-amber-200',
    learnHover: 'hover:text-cyan-200 hover:border-cyan-500/40',
  },
  emerald: {
    pillBorder: 'border-emerald-500/40',
    pillBg: 'bg-emerald-500/10',
    pillText: 'text-emerald-200',
    pillDot: 'bg-emerald-400',
    icon: 'text-emerald-300',
    headerText: 'text-emerald-200',
    headerBorder: 'border-emerald-500/20',
    panelBorder: 'border-emerald-500/40',
    learn: 'border-amber-400/60 bg-amber-500/15 text-amber-200',
    learnHover: 'hover:text-emerald-200 hover:border-emerald-500/40',
  },
} as const;

export function MidiMapper<K extends string = string>({
  title,
  params,
  onChange,
  storageKey,
  accent = 'purple',
}: MidiMapperProps<K>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [mappings, setMappings] = useState<Record<K, MidiMapping>>(
    () => loadMappings(storageKey, params),
  );
  const [learning, setLearning] = useState<K | null>(null);
  const [lastSeenCc, setLastSeenCc] = useState<{ cc: number; value: number; channel: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const ignoredControls = useMidiIgnoreStore((s) => s.controls);
  const ignoreControl = useMidiIgnoreStore((s) => s.ignoreControl);
  const ignoreChannel = useMidiIgnoreStore((s) => s.ignoreChannel);
  const removeIgnoredControl = useMidiIgnoreStore((s) => s.removeIgnoredControl);
  const clearIgnoredControls = useMidiIgnoreStore((s) => s.clearIgnoredControls);

  // Refs so the bus subscriber callback (set up once below) always
  // sees the freshest mapping table + learn target.
  const mappingsRef = useRef(mappings);
  mappingsRef.current = mappings;
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    saveMappings(storageKey, mappings);
  }, [mappings, storageKey]);

  // Opening a mapper is an explicit MIDI opt-in — turn on the master
  // gate so the global listener starts and bus messages flow here. This
  // is what triggers the browser's one-time Web MIDI permission prompt,
  // now tied to a deliberate user action rather than app load.
  useEffect(() => {
    if (open) enableMidi();
  }, [open]);

  // Subscribe to the global MIDI bus. The bus publishes raw
  // [status, data1, data2] for every message; we apply our mapping
  // table and call onChange for matched params.
  useEffect(() => {
    const unsub = subscribeToMidi((msg) => {
      setConnected(true);
      const [status, data1, data2] = msg.data;
      if (typeof status !== 'number') return;
      const command = status & 0xf0;
      const channel = status & 0x0f;

      if (command === 0xb0) {
        setLastSeenCc({ cc: data1, value: data2, channel });
        const target = learningRef.current;
        if (target) {
          setMappings((prev) => ({
            ...prev,
            [target]: { kind: 'cc', number: data1, channel },
          }));
          setLearning(null);
          return;
        }
        for (const def of paramsRef.current) {
          const m = mappingsRef.current[def.key];
          if (!m || m.kind !== 'cc') continue;
          if (m.number !== data1) continue;
          if (m.channel !== null && m.channel !== channel) continue;
          const value = scaleCcValue(m.inverted ? 127 - data2 : data2, def);
          onChangeRef.current(def.key, value);
        }
      } else if (command === 0x90 || command === 0x80) {
        const kind: 'on' | 'off' = command === 0x90 && data2 > 0 ? 'on' : 'off';
        const target = learningRef.current;
        if (target && kind === 'on') {
          setMappings((prev) => ({
            ...prev,
            [target]: { kind: 'note', number: data1, channel },
          }));
          setLearning(null);
          return;
        }
        for (const def of paramsRef.current) {
          const m = mappingsRef.current[def.key];
          if (!m || m.kind !== 'note') continue;
          if (m.number !== data1) continue;
          if (m.channel !== null && m.channel !== channel) continue;
          const value = scaleCcValue(m.inverted ? 127 - data2 : data2, def);
          onChangeRef.current(def.key, value);
        }
      }
    });
    return unsub;
  }, []);

  const setMapping = useCallback((key: K, mapping: MidiMapping | null) => {
    setMappings((prev) => {
      const next = { ...prev };
      if (mapping === null) delete next[key];
      else next[key] = mapping;
      return next;
    });
  }, []);

  const resetMappings = useCallback(() => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey);
    setMappings(loadMappings(storageKey, paramsRef.current));
  }, [storageKey]);

  const cls = ACCENTS[accent];

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`absolute top-1.5 right-1.5 z-30 flex items-center gap-1.5 px-2 py-0.5 rounded border text-[9px] font-mono uppercase tracking-widest ${cls.pillBorder} ${cls.pillBg} ${cls.pillText}`}
        title={`MIDI mapper for ${title} — ${connected ? 'controller seen' : 'waiting for controller'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? `${cls.pillDot} animate-pulse` : 'bg-zinc-700'}`} />
        <Music2 className="w-3 h-3" />
        <span>MIDI</span>
      </button>
    );
  }

  return (
    <div className={`absolute top-1.5 right-1.5 z-40 w-72 max-h-[70vh] flex flex-col bg-black/90 backdrop-blur-md border rounded text-[10px] font-mono text-zinc-200 shadow-[0_8px_24px_rgba(0,0,0,0.6)] ${cls.panelBorder}`}>
      <div className={`flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0 ${cls.headerBorder}`}>
        <div className="flex items-center gap-1.5">
          <Music2 className={`w-3.5 h-3.5 ${cls.icon}`} />
          <span className={`font-black uppercase tracking-widest ${cls.headerText}`}>{title} · MIDI</span>
        </div>
        <button onClick={() => setOpen(false)} className="p-1 text-zinc-500 hover:text-white">
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-white/5 shrink-0 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Plug className={`w-3 h-3 ${connected ? cls.icon : 'text-zinc-500'}`} />
          <span className="text-zinc-400">{connected ? 'Receiving controller input' : 'Waiting for controller'}</span>
        </div>
        {lastSeenCc && (
          <div className="text-[9px] text-zinc-600 mt-0.5 flex items-center gap-1.5">
            <span className="min-w-0 flex-1">
              last seen: CC <span className={cls.icon}>{lastSeenCc.cc}</span> = <span className={cls.icon}>{lastSeenCc.value}</span> (ch <span className={cls.icon}>{lastSeenCc.channel + 1}</span>)
            </span>
            <button
              type="button"
              onClick={() => ignoreControl({ kind: 'cc', number: lastSeenCc.cc, channel: lastSeenCc.channel })}
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-rose-500/30 bg-rose-500/10 text-[8px] uppercase tracking-wider text-rose-200 hover:bg-rose-500/20"
              title={`Ignore CC ${lastSeenCc.cc} on channel ${lastSeenCc.channel + 1}`}
            >
              <Ban className="w-2.5 h-2.5" /> Ignore
            </button>
            <button
              type="button"
              onClick={() => ignoreControl({ kind: 'cc', number: lastSeenCc.cc, channel: lastSeenCc.channel }, { anyChannel: true })}
              className="shrink-0 px-1.5 py-0.5 rounded border border-rose-500/20 bg-rose-500/5 text-[8px] uppercase tracking-wider text-rose-200 hover:bg-rose-500/15"
              title={`Ignore CC ${lastSeenCc.cc} on any MIDI channel`}
            >
              Any ch
            </button>
            <button
              type="button"
              onClick={() => ignoreChannel('cc', lastSeenCc.channel)}
              className="shrink-0 px-1.5 py-0.5 rounded border border-rose-500/20 bg-rose-500/5 text-[8px] uppercase tracking-wider text-rose-200 hover:bg-rose-500/15"
              title={`Ignore all CC messages on channel ${lastSeenCc.channel + 1}`}
            >
              Ch
            </button>
          </div>
        )}
        {ignoredControls.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {ignoredControls.map((control) => (
              <button
                key={control.id}
                type="button"
                onClick={() => removeIgnoredControl(control.id)}
                className="inline-flex items-center gap-1 rounded border border-rose-500/25 bg-rose-500/10 px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-rose-200 hover:bg-rose-500/20"
                title="Stop ignoring this MIDI control"
              >
                <Ban className="w-2.5 h-2.5" />
                {midiIgnoreLabel(control)}
                <X className="w-2.5 h-2.5" />
              </button>
            ))}
            <button
              type="button"
              onClick={clearIgnoredControls}
              className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-zinc-500 hover:text-zinc-200 hover:bg-white/5"
              title="Clear all ignored MIDI controls"
            >
              Clear
            </button>
          </div>
        )}
        {learning && (
          <div className="text-[9px] text-amber-300 animate-pulse mt-0.5 flex items-center gap-1">
            <Crosshair className="w-2.5 h-2.5" /> LEARN: move a knob to bind {String(learning)}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
        {params.map((param) => {
          const m = mappings[param.key];
          const isLearning = learning === param.key;
          return (
            <div key={param.key} className="flex items-center gap-2 px-2 py-1 rounded border border-white/5 bg-white/3 hover:bg-white/5">
              <div className="flex flex-col flex-1 min-w-0">
                <span className="text-[10px] text-zinc-200 truncate">{param.label}</span>
                <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-wider">
                  {m
                    ? `${m.kind === 'cc' ? 'CC' : 'NOTE'} ${m.number}${m.channel !== null ? ` · ch ${m.channel + 1}` : ''}${m.inverted ? ' · INV' : ''}`
                    : 'unmapped'}
                </span>
              </div>
              <button
                onClick={() => setLearning(isLearning ? null : param.key)}
                className={`p-1 rounded border ${isLearning ? `${cls.learn} animate-pulse` : `border-white/10 text-zinc-500 ${cls.learnHover}`}`}
                title={isLearning ? 'Cancel learn' : 'MIDI LEARN — move a knob to bind'}
              >
                <Crosshair className="w-3 h-3" />
              </button>
              {m && (
                <>
                  <button
                    onClick={() => setMapping(param.key, { ...m, inverted: !m.inverted })}
                    className={`p-1 rounded border ${m.inverted ? 'border-purple-500/40 text-purple-200 bg-purple-500/15' : 'border-white/10 text-zinc-500 hover:text-purple-200'}`}
                    title="Invert range"
                  >
                    <Zap className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => setMapping(param.key, null)}
                    className="p-1 rounded border border-white/10 text-zinc-500 hover:text-rose-300 hover:border-rose-500/40"
                    title="Clear mapping"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between px-3 py-2 border-t border-white/5 shrink-0">
        <button
          onClick={resetMappings}
          className="flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 text-[9px] uppercase tracking-widest text-zinc-400 hover:text-zinc-100 hover:bg-white/5"
          title="Restore auto-map defaults"
        >
          <RotateCcw className="w-3 h-3" /> Defaults
        </button>
        <span className="text-[8px] text-zinc-700">global MIDI bus · audio runs in parallel</span>
      </div>
    </div>
  );
}
