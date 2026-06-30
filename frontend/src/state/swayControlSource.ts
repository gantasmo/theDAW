/**
 * Sway control source for the XR control bus.
 *
 * Publishes the Audima Sway's six expressive dimensions as named manifest entries
 * (`sway.strike` ... `sway.sculpt`, each 0..1) so they are first-class routable
 * signals on the same bus DJ uses, and mirrors their live values out to XR so a
 * headset sees the motion. Unlike djControlSource, Sway is an INPUT: values flow
 * outward to bound targets, so an inbound control-set has nothing to set here.
 *
 * The six dims are target-agnostic. The fan-out to concrete targets (VFX, the
 * Spatializer, MAKE / Magenta generation, the vocal / SoulX path) is the binding
 * layer's job; today a Sway can already drive DJ controls through the existing DJ
 * MIDI-learn, and this source makes the named dims available to everything else.
 */
import type { XrControlSource, XrManifestEntry } from './xrControlClient';
import { publishControlChanged } from './xrControlClient';
import { SWAY_DIMS, subscribeSwayValue } from './swayBus';

export const swayControlSource: XrControlSource = {
  area: 'sway',

  buildEntries(): XrManifestEntry[] {
    return SWAY_DIMS.map((d) => ({
      id: `sway.${d.id}`,
      area: 'sway',
      group: 'Sway',
      label: d.label,
      kind: 'knob',
      min: 0,
      max: 1,
      step: 0.001,
    }));
  },

  apply(): boolean {
    // Input-only source: XR cannot set a physical dimension.
    return false;
  },
};

let mirroring = false;

/** Mirror live Sway dimension values out to XR widgets so a headset sees the
 *  motion. publishControlChanged is a no-op when no headset is connected, so this
 *  is safe to run whenever MIDI is enabled. Returns a stop function. */
export function startSwayXrMirror(): () => void {
  if (mirroring) return () => {};
  mirroring = true;
  const unsub = subscribeSwayValue((dim, value) => {
    publishControlChanged(`sway.${dim}`, value);
  });
  return () => {
    mirroring = false;
    unsub();
  };
}
