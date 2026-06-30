// Client for the .gan web-plugin backend (/api/plugin/*).
import { postJson } from './apiJson';

export interface GanPackageResult {
  manifest: Record<string, unknown>;
  gan_path: string;
}

export const ganApi = {
  /** Build (or rebuild) the bundled "The Owl" sidecar .gan; returns its path. */
  packageOwl: () => postJson<GanPackageResult>('/api/plugin/package-owl'),
  /** Reveal a file in the OS file manager (Explorer/Finder), selecting it. */
  reveal: (path: string) => postJson<{ status: string; path: string }>('/api/plugin/reveal', { path }),
};
