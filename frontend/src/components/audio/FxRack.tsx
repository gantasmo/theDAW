/**
 * FxRack — UI for a real-time insert-effect chain (the psychoacoustic rack).
 *
 * Presentational + a11y only: it renders the add control, per-effect enable /
 * reorder / remove, and SLIDE param sliders, and calls back into the store. The
 * same component drives the master bus (Phase A) and per-track chains (Phase B);
 * the caller supplies the chain array and the mutators.
 */

import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { RACK_EFFECTS, getRackEffect } from '../../lib/rackEffects';
import type { ChainEntry } from '../../state/effectChainStore';
import { SlideTrack } from './SlideTrack';
import { SpatializerPad } from './SpatializerPad';
import { OwlPad } from './OwlPad';
import { ChopControls } from './ChopControls';
import { GaterControls } from './GaterControls';

interface FxRackProps {
  chain: ChainEntry[];
  /** Stable prefix for input ids (must be unique per rack instance). */
  idPrefix: string;
  onAdd: (effectId: string) => void;
  onRemove: (entryId: string) => void;
  onReorder: (from: number, to: number) => void;
  onToggle: (entryId: string) => void;
  onUpdateParams: (entryId: string, params: Record<string, number>) => void;
  /** Project tempo, forwarded to the Gater's tempo-sync controls. */
  projectBpm?: number;
  /** During playback, returns the automation-sampled param overrides for an entry
   *  at the current playhead, so a control's displayed value follows its lane.
   *  Display-only: edits still write the stored params. */
  displayParams?: (entryId: string) => Record<string, number> | undefined;
  /** Hide the built-in "+ Add effect" select (the caller supplies its own add UI,
   *  e.g. DRAW's colored effect palette). The chain rows still render. */
  hideAdd?: boolean;
}

const fmtValue = (v: number, step: number, unit?: string): string => {
  const decimals = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
  return `${v.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
};

export function FxRack({
  chain,
  idPrefix,
  onAdd,
  onRemove,
  onReorder,
  onToggle,
  onUpdateParams,
  projectBpm,
  displayParams,
  hideAdd,
}: FxRackProps) {
  const addId = `${idPrefix}-add`;

  return (
    <div className="flex flex-col gap-2">
      {!hideAdd && (
        <div className="flex items-center gap-2">
          <label htmlFor={addId} className="sr-only">Add insert effect</label>
          <select
            id={addId}
            name={addId}
            value=""
            onChange={(e) => {
              if (e.target.value) onAdd(e.target.value);
            }}
            className="form-select px-2 py-1 text-[11px] font-mono"
            style={{ colorScheme: 'dark' }}
            title="Add a psychoacoustic insert effect to this chain"
          >
            <option value="">+ Add effect…</option>
            {RACK_EFFECTS.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
          {chain.length === 0 && (
            <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider">no inserts</span>
          )}
        </div>
      )}

      {/* Effects tile and wrap (capped width) so they use horizontal space
          instead of one full-width column of stretched sliders. */}
      <div className="flex flex-wrap gap-2 items-start">
      {chain.map((entry, i) => {
        const def = getRackEffect(entry.effect);
        if (!def) return null;
        // While a lane plays back, show the sampled value so the control follows
        // the automation; edits still write the stored params (onUpdateParams).
        const shown = displayParams ? { ...entry.params, ...(displayParams(entry.id) ?? {}) } : entry.params;
        const sizing = entry.effect === 'spatializer' ? 'grow basis-80 max-w-sm' : 'grow basis-60 max-w-xs';
        return (
          <div
            key={entry.id}
            className={`${sizing} rounded border border-white/5 bg-black/30 p-2 flex flex-col gap-1.5 transition-opacity ${entry.enabled ? '' : 'opacity-50'}`}
          >
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onToggle(entry.id)}
                aria-pressed={entry.enabled}
                aria-label={`${def.label} ${entry.enabled ? 'enabled' : 'bypassed'}`}
                title={entry.enabled ? 'Bypass this effect' : 'Enable this effect'}
                className={`w-2.5 h-2.5 rounded-full shrink-0 transition-colors ${entry.enabled ? 'bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.8)]' : 'bg-zinc-700'}`}
              />
              <span className="text-[10px] font-mono text-zinc-200 flex-1 truncate" title={def.description}>
                {def.label}
              </span>
              <button
                onClick={() => onReorder(i, i - 1)}
                disabled={i === 0}
                aria-label={`Move ${def.label} earlier`}
                title="Move earlier in the chain"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-20 disabled:pointer-events-none"
              >
                <ChevronUp className="w-3 h-3" />
              </button>
              <button
                onClick={() => onReorder(i, i + 1)}
                disabled={i === chain.length - 1}
                aria-label={`Move ${def.label} later`}
                title="Move later in the chain"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-20 disabled:pointer-events-none"
              >
                <ChevronDown className="w-3 h-3" />
              </button>
              <button
                onClick={() => onRemove(entry.id)}
                aria-label={`Remove ${def.label}`}
                title="Remove this effect"
                className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {entry.effect === 'spatializer' ? (
              <div className="pl-4">
                <SpatializerPad
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            ) : entry.effect === 'owlpad' ? (
              <div className="pl-4">
                <OwlPad
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            ) : entry.effect === 'chop' ? (
              <div className="pl-4">
                <ChopControls
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            ) : entry.effect === 'gater' ? (
              <div className="pl-4">
                <GaterControls
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  projectBpm={projectBpm}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            ) : (
            <div className="flex flex-col gap-1 pl-4">
              {def.params.map((p) => {
                const value = shown[p.key] ?? p.default;
                const labelId = `${idPrefix}-${entry.id}-${p.key}-label`;
                return (
                  <div key={p.key} className="flex items-center gap-2">
                    <span id={labelId} className="text-[9px] font-mono text-zinc-500 w-16 shrink-0">{p.label}</span>
                    <SlideTrack
                      value={value}
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      defaultValue={p.default}
                      ariaLabelledBy={labelId}
                      className="flex-1"
                      onChange={(v) => onUpdateParams(entry.id, { ...entry.params, [p.key]: v })}
                    />
                    <span className="text-[9px] font-mono text-zinc-400 w-16 shrink-0 text-right tabular-nums">
                      {fmtValue(value, p.step, p.unit)}
                    </span>
                  </div>
                );
              })}
            </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
