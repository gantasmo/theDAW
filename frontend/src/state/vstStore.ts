import { create } from 'zustand';
import { vstApi, type Vst3PluginInfo } from '../lib/vstClient';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';

// Holds the scanned VST3 plugin list for the MIX effects browser. Plugins are
// added to the effect chain as 'vst3' nodes (see effectChainStore.addVst) and
// processed per-stage by studioStore via /api/vst/process-file.
interface VstState {
  plugins: Vst3PluginInfo[];
  scanning: boolean;
  scanned: boolean;
  error: string | null;
  scan: (refresh?: boolean) => Promise<void>;
}

export const useVstStore = create<VstState>()((set) => ({
  plugins: [],
  scanning: false,
  scanned: false,
  error: null,

  scan: async (refresh = false) => {
    set({ scanning: true, error: null });
    try {
      logInfo('vst', `GET /api/vst/scan refresh=${refresh}`);
      const res = await vstApi.scan(refresh);
      set({ plugins: res.plugins, scanning: false, scanned: true });
      if (refresh) {
        useStatusBarStore.getState().setText(`VST SCAN: ${res.plugins.length} plugin(s)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'VST scan failed.';
      set({ scanning: false, error: msg });
      useStatusBarStore.getState().setText(`VST SCAN FAILED: ${msg}`);
      logError('vst', msg);
    }
  },
}));
