/**
 * PERFORM's hosted plugins keep what their editors capture.
 *
 * The editor session (state/vstEditorStore) writes a captured plugin state onto
 * the entry it belongs to, and finds entries outside EDIT's racks through the
 * owners registered with it. PERFORM's entries are derived from the devices of
 * the project the grid holds, so this owner finds the slot by its entry id and
 * keeps the state on the slot's device, where a save reads it.
 */
import { useDawImportStore } from './dawImportStore';
import { registerVstEntryOwner } from './vstEditorStore';
import type { VstStateHost } from './effectChainStore';
import { performSlotOfEntry, storePerformVstState } from '../lib/performModel';

/** Keep `rawState` on the PERFORM slot `entryId` names. */
export function keepPerformVstState(entryId: string, rawState: string, stateHost: VstStateHost): void {
  // No view shows the state, so nothing is told: a live host hands one back
  // every few seconds while its window is open.
  storePerformVstState(useDawImportStore.getState().project, entryId, rawState, stateHost);
}

registerVstEntryOwner({
  find: (entryId) => {
    const slot = performSlotOfEntry(useDawImportStore.getState().project, entryId);
    return slot?.kind === 'vst' ? slot.entry : undefined;
  },
  setRawState: keepPerformVstState,
});
