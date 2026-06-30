/**
 * SWAY panel -- learn, meter, and route the Audima Sway's six expressive
 * dimensions, plus the VJ's six camera-pose channels. Each Sway row arms LEARN
 * (binds the dimension to the next CC the controller sends), shows the bound CC
 * (folded into the Learn button) and a live 0..1 meter, and routes the dimension
 * to a BindableTarget (DJ targets today). Lives as a tab in the global bottom
 * multi-tab panel, beside SLIDE.
 *
 * Laid out in two columns (Sway | Camera Pose) so the wide-but-short bottom
 * panel is filled horizontally instead of scrolling.
 *
 * Works with ANY MIDI controller via learn, not only a physical Sway; the Sway
 * profile just labels the surface.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useSwayStore, SWAY_DIMS } from '../../state/swayBus';
import { useSwayRoutingStore, loadSwayTargets } from '../../state/swayRouting';
import { usePoseStore, POSE_CHANNELS } from '../../state/poseBus';
import { usePoseRoutingStore } from '../../state/poseRouting';
import type { BindableTarget } from '../surface/widgetTypes';
import { useMidiTriggerStore } from '../../state/midiTriggerStore';

type TargetGroups = Array<[string, BindableTarget[]]>;

/** Shared route picker — both Sway dims and pose channels fan out to the same
 *  grouped target catalog. */
const RouteSelect: React.FC<{
  id: string;
  label: string;
  value: string;
  groups: TargetGroups;
  accent: 'fuchsia' | 'cyan';
  onChange: (v: string | null) => void;
}> = ({ id, label, value, groups, accent, onChange }) => (
  <>
    <label htmlFor={id} className="sr-only">{`Route ${label} to a target`}</label>
    <select
      id={id}
      name={id}
      value={value}
      onChange={(e) => onChange(e.target.value || null)}
      className={`shrink-0 w-28 bg-black/40 border border-zinc-800 rounded px-1 py-1 text-[9px] font-mono text-zinc-200 outline-none ${
        accent === 'fuchsia' ? 'focus:border-fuchsia-500/50' : 'focus:border-cyan-500/50'
      }`}
    >
      <option value="">route to</option>
      {groups.map(([g, list]) => (
        <optgroup key={g} label={g}>
          {list.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  </>
);

const Meter: React.FC<{ value: number; accent: 'fuchsia' | 'cyan' }> = ({ value, accent }) => (
  <div className="flex-1 min-w-8 h-2 rounded bg-black/50 overflow-hidden" aria-hidden="true">
    <div
      className={`h-full ${accent === 'fuchsia' ? 'bg-fuchsia-500/70' : 'bg-cyan-500/70'}`}
      style={{ width: `${Math.round(value * 100)}%` }}
    />
  </div>
);

export const SwayPanel: React.FC = () => {
  const bindings = useSwayStore((s) => s.bindings);
  const values = useSwayStore((s) => s.values);
  const learningDim = useSwayStore((s) => s.learningDim);
  const startLearn = useSwayStore((s) => s.startLearn);
  const cancelLearn = useSwayStore((s) => s.cancelLearn);
  const clearBinding = useSwayStore((s) => s.clearBinding);
  const routes = useSwayRoutingStore((s) => s.routes);
  const setRoute = useSwayRoutingStore((s) => s.setRoute);
  const poseValues = usePoseStore((s) => s.values);
  const poseActive = usePoseStore((s) => s.active);
  const poseRoutes = usePoseRoutingStore((s) => s.routes);
  const setPoseRoute = usePoseRoutingStore((s) => s.setRoute);
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);
  const [targets, setTargets] = useState<BindableTarget[]>([]);

  useEffect(() => {
    let alive = true;
    void loadSwayTargets().then((t) => {
      if (alive) setTargets(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo<TargetGroups>(() => {
    const m = new Map<string, BindableTarget[]>();
    for (const t of targets) {
      const arr = m.get(t.group) ?? [];
      arr.push(t);
      m.set(t.group, arr);
    }
    return Array.from(m.entries());
  }, [targets]);

  return (
    <div className="h-full overflow-y-auto p-2.5 text-zinc-200">
      {!midiEnabled && (
        <p className="mb-2 text-[9px] font-mono text-amber-300/80 leading-snug">
          MIDI is off. Enable the master MIDI toggle to receive Sway input, then Learn each dimension.
        </p>
      )}

      <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
        {/* Sway dimensions */}
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-fuchsia-300">Sway</h3>
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">6-dim motion</span>
          </div>
          <div className="space-y-1">
            {SWAY_DIMS.map((d) => {
              const b = bindings[d.id];
              const learning = learningDim === d.id;
              return (
                <div key={d.id} className="flex items-center gap-1.5 rounded border border-white/10 bg-white/3 px-1.5 py-1">
                  <span className="w-11 shrink-0 text-[10px] font-bold uppercase tracking-wider text-fuchsia-200">{d.label}</span>
                  <button
                    onClick={() => (learning ? cancelLearn() : startLearn(d.id))}
                    aria-label={learning ? `Cancel learning ${d.label}` : `Learn ${d.label}`}
                    title={b ? `Bound to Ch${b.channel + 1} CC${b.cc} — click to relearn` : 'Learn — bind to the next CC'}
                    className={`shrink-0 w-14 px-1.5 py-0.5 rounded border text-[8px] font-black uppercase tracking-widest ${
                      learning
                        ? 'border-amber-400/60 bg-amber-400/15 text-amber-200 animate-pulse'
                        : b
                          ? 'border-fuchsia-400/40 text-fuchsia-200/90 hover:border-fuchsia-400/70'
                          : 'border-white/15 text-zinc-300 hover:border-fuchsia-400/50 hover:text-fuchsia-200'
                    }`}
                  >
                    {learning ? 'Listen' : b ? `CC${b.cc}` : 'Learn'}
                  </button>
                  {b && (
                    <button
                      onClick={() => clearBinding(d.id)}
                      aria-label={`Clear ${d.label} binding`}
                      title="Clear binding"
                      className="shrink-0 text-[10px] text-zinc-600 hover:text-rose-300 leading-none"
                    >
                      x
                    </button>
                  )}
                  <Meter value={values[d.id] ?? 0} accent="fuchsia" />
                  <RouteSelect
                    id={`sway-route-${d.id}`}
                    label={d.label}
                    value={routes[d.id] ?? ''}
                    groups={groups}
                    accent="fuchsia"
                    onChange={(v) => setRoute(d.id, v)}
                  />
                </div>
              );
            })}
          </div>
        </section>

        {/* Camera pose */}
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300">Camera Pose</h3>
            <span className={`text-[8px] font-mono uppercase tracking-widest ${poseActive ? 'text-cyan-400' : 'text-zinc-600'}`}>
              {poseActive ? 'live' : 'enable GESTURE in the VJ'}
            </span>
          </div>
          <div className="space-y-1">
            {POSE_CHANNELS.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5 rounded border border-white/10 bg-white/3 px-1.5 py-1">
                <span className="w-16 shrink-0 text-[10px] font-bold uppercase tracking-wider text-cyan-200">{c.label}</span>
                <Meter value={poseValues[c.id] ?? 0} accent="cyan" />
                <RouteSelect
                  id={`pose-route-${c.id}`}
                  label={c.label}
                  value={poseRoutes[c.id] ?? ''}
                  groups={groups}
                  accent="cyan"
                  onChange={(v) => setPoseRoute(c.id, v)}
                />
              </div>
            ))}
          </div>
        </section>
      </div>

      <p className="mt-2.5 text-[8px] font-mono text-zinc-600 leading-snug">
        Learn binds a dimension to the next CC sent; routing drives DJ targets today (VJ, MAKE, and vocal join as the unified matrix lands). Camera pose comes from the VJ webcam (toggle GESTURE there) and routes like Sway, no learn needed.
      </p>
    </div>
  );
};
