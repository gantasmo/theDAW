/**
 * The add area of one PERFORM track's effect slots: EDIT's own add menu
 * (`FxAddMenu`: every rack effect, every scanned VST3 plugin) wired to the
 * track's device list. The rail's PARAMS tab and the Sway deck's FX picker both
 * mount it, so a track takes the whole catalog from either place.
 *
 * A picked device goes on the end of the track's chain and starts processing
 * at once: the grid re-wires the column, and a hosted plugin's host starts.
 */
import React from 'react';
import type { DawTrack } from '../../lib/dawImportClient';
import { performRackDevice, performSlots, performVstDevice } from '../../lib/performModel';
import { putPerformDevice, usePerformRailStore } from '../../state/performRailStore';
import { useVstStore } from '../../state/vstStore';
import { FxAddMenu } from '../audio/EffectWindows';

export const PerformSlotAdd: React.FC<{
  trackIndex: number;
  track: DawTrack;
  /** The chain index the pick landed on: a device just added, or the slot
   *  already holding the picked plugin. */
  onPlaced: (deviceIndex: number) => void;
}> = ({ trackIndex, track, onPlaced }) => {
  // The device list lives on the track object; this is what says it changed.
  usePerformRailStore((s) => s.devicesVersion);
  const vstPlugins = useVstStore((s) => s.plugins);
  const vstScanning = useVstStore((s) => s.scanning);
  const vstScanned = useVstStore((s) => s.scanned);
  const scanVst = useVstStore((s) => s.scan);

  // The plugin list is the one MIX and EDIT read; ask for it when PERFORM is
  // the first tab to want it.
  React.useEffect(() => {
    if (!vstScanned && !vstScanning) void scanVst();
  }, [vstScanned, vstScanning, scanVst]);

  const slots = performSlots(track, trackIndex);

  return (
    <FxAddMenu
      onAddEffect={(effectId) => onPlaced(putPerformDevice(trackIndex, track, performRackDevice(effectId)))}
      onAddVst={(plugin) => {
        // A plugin the track already holds opens its slot; one it does not is
        // put on the end of the chain.
        const held = slots.find((x) => x.entry.vst?.plugin_path === plugin.path);
        onPlaced(held ? held.deviceIndex : putPerformDevice(trackIndex, track, performVstDevice(plugin)));
      }}
      vstPlugins={vstPlugins}
      vstScanning={vstScanning}
      onRescanVst={() => void scanVst(true)}
      inChain={(plugin) => slots.some((x) => x.entry.vst?.plugin_path === plugin.path)}
    />
  );
};
