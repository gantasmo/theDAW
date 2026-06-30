import { create } from 'zustand';
import { useStatusBarStore } from './statusBarStore';
import { logError, logInfo } from './logStore';
import { uuid } from '../orb-kit/utils';
import { useLibraryStore } from './libraryStore';
import { usePlayerStore } from './playerStore';
import { useEffectChainStore, EFFECT_LABELS } from './effectChainStore';
import { useAdvancedEditorSourceStore } from './advancedEditorStore';

interface StudioHistoryEntry {
  id: string;
  effect: string;
  format: string;
  createdAt: number;
}

interface StudioStoreState {
  sourceFile: File | null;
  outputUrl: string | null;
  outputFormat: string;
  isProcessing: boolean;
  // True for the whole multi-effect chain run (processAudio toggles
  // isProcessing per effect, which would flicker the footer between
  // effects — the footer keys its PROCESS state off this flag instead).
  isChainProcessing: boolean;
  error: string | null;
  processHistory: StudioHistoryEntry[];
  // Legacy single-effect "pending action" path (kept for the footer's
  // edit-tab branch). The MIX tab now runs the full chain via processChain().
  pendingEffect: string;
  pendingParams: Record<string, number>;
  setSourceFile: (file: File | null) => void;
  setOutputFormat: (format: string) => void;
  setPendingAction: (effect: string, params: Record<string, number>) => void;
  processAudio: (payload: { effect: string; params: Record<string, number>; skipLibrary?: boolean }) => Promise<void>;
  // VST3 chain stage: uploads the current audio + plugin path to
  // /api/vst/process-file (mirrors processAudio) and returns processed audio.
  processVst: (payload: { pluginPath: string; pluginName: string; params: Record<string, number>; skipLibrary?: boolean }) => Promise<void>;
  // Runs the enabled effects in useEffectChainStore in series over the
  // source in useAdvancedEditorSourceStore, then imports the final result
  // to the library, loads the player, and writes advancedEditorStore.outputUrl.
  processChain: () => Promise<void>;
  triggerPendingProcess: () => Promise<void>;
  reuseOutputAsSource: () => Promise<void>;
  clearOutput: () => void;
}

const parseErrorText = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    // Guard against non-JSON responses (e.g. Vite returning HTML for
    // unmatched routes when the backend is down).
    if (text.startsWith('<') || text.startsWith('<!')) {
      return `Backend returned HTML instead of JSON (HTTP ${response.status}). Is the backend running on port 8600?`;
    }
    const payload = JSON.parse(text) as { detail?: string; error?: string };
    return payload.detail || payload.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};

/** Fetch with an AbortController timeout (default 10 minutes). */
const fetchWithTimeout = (input: RequestInfo | URL, init?: RequestInit, timeoutMs = 600_000): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

export const useStudioStore = create<StudioStoreState>()((set, get) => ({
  sourceFile: null,
  outputUrl: null,
  outputFormat: 'wav',
  isProcessing: false,
  isChainProcessing: false,
  error: null,
  processHistory: [],
  pendingEffect: 'mastering_chain',
  pendingParams: { lowBoost: 0, highBoost: 0, limiterCeiling: 0.95, targetLUFS: -14 },

  setSourceFile: (file) => {
    set({ sourceFile: file });
    useStatusBarStore.getState().setText(file ? `STUDIO SOURCE LOADED: ${file.name}` : 'STUDIO SOURCE CLEARED');
  },

  setOutputFormat: (format) => {
    set({ outputFormat: format });
  },

  setPendingAction: (effect, params) => {
    set({ pendingEffect: effect, pendingParams: params });
  },

  triggerPendingProcess: async () => {
    const { pendingEffect, pendingParams, processAudio } = get();
    await processAudio({ effect: pendingEffect, params: pendingParams });
  },

  processAudio: async ({ effect, params, skipLibrary }) => {
    const source = get().sourceFile;
    if (!source) {
      const message = 'Load a source audio file before processing.';
      set({ error: message });
      useStatusBarStore.getState().setText(`STUDIO FAILED: ${message}`);
      return;
    }

    const previous = get().outputUrl;
    if (previous) {
      URL.revokeObjectURL(previous);
    }

    set({ isProcessing: true, error: null, outputUrl: null });
    useStatusBarStore.getState().setText(`STUDIO PROCESS STARTED: ${effect}`);
    logInfo('studio', `Processing: effect=${effect} format=${get().outputFormat} source=${source.name} (${Math.round(source.size / 1024)}KB)`);

    const form = new FormData();
    form.append('audio', source);
    form.append('effect', effect);
    form.append('params', JSON.stringify(params));
    form.append('output_format', get().outputFormat);

    try {
      logInfo('studio', `POST /api/studio/process — effect=${effect} params=${JSON.stringify(params)}`);
      const response = await fetchWithTimeout('/api/studio/process', {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        const detail = await parseErrorText(response);
        logError('studio', `POST /api/studio/process → ${response.status} ${response.statusText} — ${detail}`);
        throw new Error(detail);
      }

      // Guard: make sure we actually got audio back, not HTML from Vite's
      // SPA fallback (which would happen if the proxy silently failed).
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const msg = 'Backend returned HTML instead of audio. Is the backend running on port 8600?';
        logError('studio', msg);
        throw new Error(msg);
      }

      const blob = await response.blob();
      logInfo('studio', `POST /api/studio/process → 200 OK — ${Math.round(blob.size / 1024)}KB ${get().outputFormat}`);
      const outputUrl = URL.createObjectURL(blob);
      const nextEntry: StudioHistoryEntry = {
        id: uuid(),
        effect,
        format: get().outputFormat,
        createdAt: Date.now(),
      };

      set((state) => ({
        isProcessing: false,
        outputUrl,
        processHistory: [nextEntry, ...state.processHistory].slice(0, 8),
        error: null,
      }));
      useStatusBarStore.getState().setText(`STUDIO PROCESS COMPLETE: ${effect}`);

      if (!skipLibrary) {
        const fmt = get().outputFormat;
        const title = `studio-${effect}.${fmt}`;
        try {
          const entry = await useLibraryStore.getState().importEntry({
            blob,
            filename: title,
            mimeType: blob.type || 'audio/wav',
            metadata: {
              title,
              prompt: `Effect: ${effect}`,
              model: effect,
              source: 'studio',
              tags: ['studio', effect],
            },
          });
          await usePlayerStore.getState().load(blob, { label: title, entryId: entry.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logError('studio', `Library save failed: ${msg}`);
          useStatusBarStore
            .getState()
            .setText(`STUDIO LIBRARY SAVE FAILED — check Processing Log: ${msg}`);
          // Best-effort: still play it in the footer so user can review.
          try {
            await usePlayerStore.getState().load(blob, { label: title, entryId: `studio-fail-${Date.now()}` });
          } catch { /* swallow */ }
        }
      }
    } catch (error) {
      let message: string;
      if (error instanceof DOMException && error.name === 'AbortError') {
        message = 'Effect processing timed out after 10 minutes. Try a shorter audio file or simpler effect.';
      } else if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
        message = 'Network error — the backend may not be running on port 8600, or the response was interrupted. Restart the backend and try again.';
      } else {
        message = error instanceof Error ? error.message : 'Studio process failed.';
      }
      set({ isProcessing: false, error: message });
      useStatusBarStore.getState().setText(`STUDIO PROCESS FAILED: ${message}`);
      logError('studio', `effect=${effect} FAILED — ${message}`);
    }
  },

  processVst: async ({ pluginPath, pluginName, params, skipLibrary }) => {
    const source = get().sourceFile;
    if (!source) {
      const message = 'Load a source audio file before processing.';
      set({ error: message });
      useStatusBarStore.getState().setText(`VST FAILED: ${message}`);
      return;
    }

    const previous = get().outputUrl;
    if (previous) URL.revokeObjectURL(previous);

    set({ isProcessing: true, error: null, outputUrl: null });
    useStatusBarStore.getState().setText(`VST PROCESS STARTED: ${pluginName}`);
    logInfo('studio', `POST /api/vst/process-file — ${pluginName} (${pluginPath})`);

    const form = new FormData();
    form.append('audio', source);
    form.append('plugin_path', pluginPath);
    form.append('params', JSON.stringify(params || {}));

    try {
      const response = await fetchWithTimeout('/api/vst/process-file', {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        const detail = await parseErrorText(response);
        logError('studio', `POST /api/vst/process-file → ${response.status} — ${detail}`);
        throw new Error(detail);
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        throw new Error('Backend returned HTML instead of audio. Is the backend running on port 8600?');
      }

      const blob = await response.blob();
      const outputUrl = URL.createObjectURL(blob);
      const nextEntry: StudioHistoryEntry = {
        id: uuid(),
        effect: pluginName,
        format: get().outputFormat,
        createdAt: Date.now(),
      };
      set((state) => ({
        isProcessing: false,
        outputUrl,
        processHistory: [nextEntry, ...state.processHistory].slice(0, 8),
        error: null,
      }));
      useStatusBarStore.getState().setText(`VST PROCESS COMPLETE: ${pluginName}`);

      if (!skipLibrary) {
        const fmt = get().outputFormat;
        const title = `vst-${pluginName}.${fmt}`;
        try {
          const entry = await useLibraryStore.getState().importEntry({
            blob,
            filename: title,
            mimeType: blob.type || 'audio/wav',
            metadata: { title, prompt: `VST: ${pluginName}`, source: 'studio', tags: ['vst', pluginName] },
          });
          await usePlayerStore.getState().load(blob, { label: title, entryId: entry.id });
        } catch (e) {
          logError('studio', `VST library save failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'VST process failed.';
      set({ isProcessing: false, error: message });
      useStatusBarStore.getState().setText(`VST PROCESS FAILED: ${message}`);
      logError('studio', `vst=${pluginName} FAILED — ${message}`);
    }
  },

  processChain: async () => {
    if (get().isProcessing || get().isChainProcessing) return;

    const source = useAdvancedEditorSourceStore.getState().sourceFile;
    if (!source) {
      const message = 'Load a source audio file before processing.';
      set({ error: message });
      useStatusBarStore.getState().setText(`MIX FAILED: ${message}`);
      return;
    }

    const enabled = useEffectChainStore.getState().chain.filter((e) => e.enabled);
    if (enabled.length === 0) {
      const message = 'Add at least one enabled effect to the chain.';
      set({ error: message });
      useStatusBarStore.getState().setText(`MIX FAILED: ${message}`);
      return;
    }

    const fmt = get().outputFormat;
    const chainLabel = enabled
      .map((e) => (e.vst ? e.vst.plugin_name : EFFECT_LABELS[e.effect] || e.effect))
      .join(' → ');
    set({ isChainProcessing: true, error: null });
    useStatusBarStore.getState().setText(`MIX CHAIN STARTED: ${chainLabel}`);
    logInfo('studio', `Chain process: ${chainLabel} (${enabled.length} effects) format=${fmt}`);

    try {
      // Run each enabled effect in series, feeding each output into the
      // next effect's input. Per-effect processing skips the library so
      // only the final result is saved.
      let currentFile = source;
      for (const entry of enabled) {
        get().setSourceFile(currentFile);
        if (entry.vst) {
          await get().processVst({
            pluginPath: entry.vst.plugin_path,
            pluginName: entry.vst.plugin_name,
            params: entry.params,
            skipLibrary: true,
          });
        } else {
          await get().processAudio({ effect: entry.effect, params: entry.params, skipLibrary: true });
        }
        const url = get().outputUrl;
        // The per-stage call already set an error + status if this failed.
        if (!url) return;
        const blob = await (await fetch(url)).blob();
        const stageName = entry.vst ? entry.vst.plugin_name : entry.effect;
        currentFile = new File([blob], `chain-${stageName}.${fmt}`, { type: blob.type });
      }

      const finalUrl = get().outputUrl;
      if (!finalUrl) return;
      useAdvancedEditorSourceStore.getState().setOutputUrl(finalUrl);

      const finalBlob = await fetch(finalUrl).then((r) => r.blob());
      const title = `chain-${chainLabel.slice(0, 40)}.${fmt}`;
      try {
        const entry = await useLibraryStore.getState().importEntry({
          blob: finalBlob,
          filename: title,
          mimeType: finalBlob.type || 'audio/wav',
          metadata: { title, prompt: chainLabel, source: 'studio', tags: ['effects-chain'] },
        });
        await usePlayerStore.getState().load(finalBlob, { label: title, entryId: entry.id });
        useStatusBarStore.getState().setText(`MIX CHAIN COMPLETE: ${chainLabel}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError('studio', `Chain library save failed: ${msg}`);
        set({ error: `Library save failed: ${msg}` });
        useStatusBarStore
          .getState()
          .setText(`MIX CHAIN LIBRARY SAVE FAILED — check Processing Log: ${msg}`);
        try {
          await usePlayerStore.getState().load(finalBlob, { label: title, entryId: `chain-fail-${Date.now()}` });
        } catch { /* swallow */ }
      }
    } finally {
      set({ isChainProcessing: false });
    }
  },

  reuseOutputAsSource: async () => {
    const output = get().outputUrl;
    if (!output) {
      return;
    }

    const response = await fetch(output);
    const blob = await response.blob();
    const sourceFile = new File([blob], `studio-output.${get().outputFormat}`, { type: blob.type || 'audio/wav' });
    set({ sourceFile });
    useStatusBarStore.getState().setText('STUDIO OUTPUT PROMOTED TO SOURCE');
  },

  clearOutput: () => {
    const output = get().outputUrl;
    if (output) {
      URL.revokeObjectURL(output);
    }
    set({ outputUrl: null, error: null });
    useStatusBarStore.getState().setText('STUDIO OUTPUT CLEARED');
  },
}));

