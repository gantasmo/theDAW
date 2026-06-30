import { create } from 'zustand';
import {
  canImport,
  dawApi,
  hasHint,
  type DawDetect,
  type DawExportHint,
  type DawProject,
} from '../lib/dawImportClient';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';

interface DawImportState {
  isOpen: boolean;
  sourcePath: string;
  detected: DawDetect | null;
  project: DawProject | null;
  hint: DawExportHint | null;
  busy: boolean;
  error: string | null;

  open: () => void;
  close: () => void;
  setSourcePath: (path: string) => void;
  detectAndImport: () => Promise<void>;
  reset: () => void;
}

const status = (text: string) => useStatusBarStore.getState().setText(text);

export const useDawImportStore = create<DawImportState>()((set, get) => ({
  isOpen: false,
  sourcePath: '',
  detected: null,
  project: null,
  hint: null,
  busy: false,
  error: null,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setSourcePath: (path) => set({ sourcePath: path, error: null }),

  detectAndImport: async () => {
    const path = get().sourcePath.trim();
    if (!path) {
      set({ error: 'Choose a DAW project file first.' });
      return;
    }
    set({ busy: true, error: null, project: null, hint: null, detected: null });
    try {
      logInfo('dawimport', `POST /api/dawimport/detect — ${path}`);
      const detected = await dawApi.detect(path);
      set({ detected });

      if (canImport(detected.daw)) {
        const project = await dawApi.import(detected.daw, path);
        set({ project, busy: false });
        status(`IMPORTED ${detected.daw.toUpperCase()}: ${project.tracks.length} track(s)`);
      } else if (hasHint(detected.daw)) {
        const hint = await dawApi.hint(detected.daw);
        set({ hint, busy: false });
        status(`${detected.daw.toUpperCase()}: export-to-audio required`);
      } else {
        set({ busy: false, error: `Unsupported project type: ${detected.format || 'unknown'}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import failed.';
      set({ busy: false, error: msg });
      status(`IMPORT FAILED: ${msg}`);
      logError('dawimport', msg);
    }
  },

  reset: () =>
    set({ sourcePath: '', detected: null, project: null, hint: null, error: null, busy: false }),
}));
