import { create } from 'zustand';
import {
  projectApi,
  type ProjectManifest,
  type RecentItem,
  type TasmoProjectInput,
  type TasmoProjectLoaded,
  type TasmoTrackInput,
} from '../lib/projectClient';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';

type ProjectTab = 'save' | 'open';

interface ProjectState {
  isOpen: boolean;
  tab: ProjectTab;
  busy: boolean;
  error: string | null;
  recent: RecentItem[];

  // Save form
  projectName: string;
  tempo: number;
  embedAudio: boolean;
  savePath: string;
  pendingTracks: TasmoTrackInput[];
  sourceDaw: string | null;
  importWarnings: string[];
  lastSaved: { path: string; manifest: ProjectManifest } | null;

  // Open form
  openPath: string;
  loaded: { project: TasmoProjectLoaded; manifest: ProjectManifest } | null;

  open: (tab?: ProjectTab, seed?: TasmoProjectInput) => void;
  close: () => void;
  setTab: (tab: ProjectTab) => void;
  setProjectName: (name: string) => void;
  setTempo: (tempo: number) => void;
  setEmbedAudio: (embed: boolean) => void;
  setSavePath: (path: string) => void;
  setOpenPath: (path: string) => void;
  refreshRecent: () => Promise<void>;
  save: () => Promise<void>;
  loadPath: (path?: string) => Promise<void>;
  clearError: () => void;
}

const status = (text: string) => useStatusBarStore.getState().setText(text);

export const useProjectStore = create<ProjectState>()((set, get) => ({
  isOpen: false,
  tab: 'save',
  busy: false,
  error: null,
  recent: [],

  projectName: 'Untitled',
  tempo: 120,
  embedAudio: false,
  savePath: '',
  pendingTracks: [],
  sourceDaw: null,
  importWarnings: [],
  lastSaved: null,

  openPath: '',
  loaded: null,

  open: (tab = 'save', seed) => {
    if (seed) {
      set({
        projectName: seed.project_name || 'Untitled',
        tempo: seed.tempo ?? 120,
        pendingTracks: seed.tracks ?? [],
        sourceDaw: seed.source_daw ?? null,
        importWarnings: seed.import_warnings ?? [],
        lastSaved: null,
      });
    }
    set({ isOpen: true, tab, error: null });
    void get().refreshRecent();
  },

  close: () => set({ isOpen: false }),
  setTab: (tab) => set({ tab, error: null }),
  setProjectName: (projectName) => set({ projectName }),
  setTempo: (tempo) => set({ tempo: Number.isFinite(tempo) ? tempo : 120 }),
  setEmbedAudio: (embedAudio) => set({ embedAudio }),
  setSavePath: (savePath) => set({ savePath, error: null }),
  setOpenPath: (openPath) => set({ openPath, error: null }),

  refreshRecent: async () => {
    try {
      const recent = await projectApi.recent();
      set({ recent });
    } catch (e) {
      logError('project', e instanceof Error ? e.message : 'Failed to list recent projects.');
    }
  },

  save: async () => {
    const { projectName, tempo, embedAudio, savePath, pendingTracks, sourceDaw, importWarnings } =
      get();
    if (!savePath.trim()) {
      set({ error: 'Choose where to save the .tasmo file.' });
      return;
    }
    const project: TasmoProjectInput = {
      project_name: projectName.trim() || 'Untitled',
      tempo,
      tracks: pendingTracks,
      source_daw: sourceDaw,
      import_warnings: importWarnings,
    };
    set({ busy: true, error: null });
    try {
      logInfo('project', `POST /api/project/save — ${savePath} embed=${embedAudio}`);
      const res = await projectApi.save(project, savePath.trim(), embedAudio);
      set({ busy: false, lastSaved: { path: res.path, manifest: res.manifest } });
      status(`PROJECT SAVED (${res.manifest.audio_mode}): ${res.path}`);
      void get().refreshRecent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed.';
      set({ busy: false, error: msg });
      status(`PROJECT SAVE FAILED: ${msg}`);
      logError('project', msg);
    }
  },

  loadPath: async (path) => {
    const target = (path ?? get().openPath).trim();
    if (!target) {
      set({ error: 'Choose a .tasmo file to open.' });
      return;
    }
    set({ busy: true, error: null, openPath: target });
    try {
      logInfo('project', `POST /api/project/load — ${target}`);
      const res = await projectApi.load(target);
      set({ busy: false, loaded: res });
      status(`PROJECT OPENED: ${res.project.project_name}`);
      void get().refreshRecent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Open failed.';
      set({ busy: false, error: msg });
      status(`PROJECT OPEN FAILED: ${msg}`);
      logError('project', msg);
    }
  },

  clearError: () => set({ error: null }),
}));
