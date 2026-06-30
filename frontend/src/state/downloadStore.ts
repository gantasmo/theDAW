/**
 * Model download store — drives the floating DownloadDock.
 *
 * The dock is the single owner of download progress/error state. Settings
 * model chips are thin triggers: they call `startDownload(name)` and read job
 * status for display, but never poll or hold their own busy/error state.
 *
 * Lifecycle:
 *   - `startDownload` POSTs the job, then ensures the poll loop is running.
 *   - The poll loop (~1s) calls `refresh()` while ANY job is queued/downloading.
 *   - When no job is active it STOPS the interval but KEEPS the jobs in state,
 *     so finished/errored rows persist for the user to read and clear.
 *   - A page reload naturally drops the store (= a fresh session): the dock is
 *     empty again until the next download starts.
 */
import { create } from 'zustand';
import {
  clearDownloads,
  fetchDownloads,
  startModelDownload,
  type DownloadJob,
} from '../lib/modelDownloadClient';

const POLL_INTERVAL_MS = 1000;

/** True while the job still has work the poll loop should follow. */
const isActive = (job: DownloadJob): boolean =>
  job.status === 'queued' || job.status === 'downloading';

interface DownloadStore {
  jobs: DownloadJob[];
  expanded: boolean;
  /** Internal: whether the poll interval is currently running. */
  _polling: boolean;
  /** Internal: handle for the active poll interval (guards double-intervals). */
  _timer: ReturnType<typeof setInterval> | null;

  /** Trigger a download for `name`, then ensure the poll loop is running. */
  startDownload: (name: string) => Promise<void>;
  /** Pull the latest jobs from the backend into state. */
  refresh: () => Promise<void>;
  /** Clear finished/errored jobs on the backend, then refresh. */
  clear: () => Promise<void>;
  setExpanded: (expanded: boolean) => void;
  /** Internal: start the poll loop if not already running. */
  _ensurePolling: () => void;
  /** Internal: stop the poll loop (jobs are kept in state). */
  _stopPolling: () => void;
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  jobs: [],
  expanded: false,
  _polling: false,
  _timer: null,

  startDownload: async (name) => {
    // Open the dock so the user immediately sees the job arrive on next poll.
    set({ expanded: true });
    await startModelDownload(name);
    get()._ensurePolling();
    // Surface the queued job right away rather than waiting a full tick.
    void get().refresh();
  },

  refresh: async () => {
    try {
      const jobs = await fetchDownloads();
      set({ jobs });
      // Once nothing is active, stop polling but keep the rows on screen.
      if (!jobs.some(isActive)) get()._stopPolling();
    } catch {
      // Transient fetch failure (e.g. backend restarting) — keep the last
      // known jobs and let the next tick retry. Don't tear down the dock.
    }
  },

  clear: async () => {
    try {
      await clearDownloads();
      await get().refresh();
    } catch {
      // Fall back to dropping finished/errored rows locally so the UI still
      // reflects the user's intent even if the backend call failed.
      set((state) => ({ jobs: state.jobs.filter(isActive) }));
    }
    // Nothing left to follow once cleared.
    if (!get().jobs.some(isActive)) get()._stopPolling();
  },

  setExpanded: (expanded) => set({ expanded }),

  _ensurePolling: () => {
    if (get()._polling || get()._timer) return; // guard against double-intervals
    const timer = setInterval(() => {
      void get().refresh();
    }, POLL_INTERVAL_MS);
    set({ _polling: true, _timer: timer });
  },

  _stopPolling: () => {
    const { _timer } = get();
    if (_timer) clearInterval(_timer);
    set({ _polling: false, _timer: null });
  },
}));
