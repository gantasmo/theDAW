/**
 * Pose control source for the XR control bus.
 *
 * Publishes the six body-pose channels (`pose.handLeft` ... `pose.lean`, each
 * 0..1) as manifest entries so they are first-class routable signals on the same
 * bus DJ and Sway use, and mirrors their live values out to XR so a headset sees
 * the motion. Pose is an INPUT source: values flow outward to bound targets, so an
 * inbound control-set has nothing to set here.
 */
import type { XrControlSource, XrManifestEntry } from './xrControlClient';
import { publishControlChanged } from './xrControlClient';
import { POSE_CHANNELS, subscribePoseValue } from './poseBus';

export const poseControlSource: XrControlSource = {
  area: 'pose',

  buildEntries(): XrManifestEntry[] {
    return POSE_CHANNELS.map((c) => ({
      id: `pose.${c.id}`,
      area: 'pose',
      group: 'Pose',
      label: c.label,
      kind: 'knob',
      min: 0,
      max: 1,
      step: 0.001,
    }));
  },

  apply(): boolean {
    return false;
  },
};

let mirroring = false;

/** Mirror live pose channel values out to XR widgets. publishControlChanged is a
 *  no-op when no headset is connected. Returns a stop function. */
export function startPoseXrMirror(): () => void {
  if (mirroring) return () => {};
  mirroring = true;
  const unsub = subscribePoseValue((ch, value) => {
    publishControlChanged(`pose.${ch}`, value);
  });
  return () => {
    mirroring = false;
    unsub();
  };
}
