// Typed client for the VST3 hosting backend (/api/vst/*).
// MIX consumes VSTs as effect-chain nodes: it scans for plugins here, and the
// per-stage processing is an UPLOAD POST to /api/vst/process-file driven from
// studioStore (mirroring /api/studio/process), so no other client calls are
// needed here.
import { getJson } from './apiJson';

export interface Vst3PluginInfo {
  name: string;
  path: string;
  manufacturer: string;
  version: string;
  category: string; // "effect" | "instrument" | "unknown"
  file_size_mb: number;
  last_modified: number;
}

export const vstApi = {
  scan: (refresh = false) =>
    getJson<{ plugins: Vst3PluginInfo[] }>(`/api/vst/scan?refresh=${refresh ? 'true' : 'false'}`),
};
