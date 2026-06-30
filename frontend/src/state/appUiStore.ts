import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const theDAW_VIEWS = ['create', 'edit', 'train', 'library', 'advanced'] as const;
export type theDAWView = typeof theDAW_VIEWS[number];

export function normalizetheDAWView(value: unknown): theDAWView | null {
  return typeof value === 'string' && theDAW_VIEWS.includes(value as theDAWView)
    ? value as theDAWView
    : null;
}

/** The center-bar tabs in user-locked order MAKE / EDIT / MIX / DJ / VJ /
 *  TRAIN / LEARN. All workspaces live here; the legacy left-side tabs
 *  (CREATE/PROCESS/TRAIN) are subsumed by these. */
export const CENTER_TABS = ['make', 'edit', 'mix', 'dj', 'vj', 'train', 'learn'] as const;
export type CenterTab = typeof CENTER_TABS[number];

/** Translate legacy navigation targets (used by orb-kit, library row
 *  clicks, assistant 'navigate' actions, etc.) into the new center-bar
 *  tabs so existing call sites keep working. */
const LEGACY_VIEW_TO_CENTER_TAB: Record<string, CenterTab> = {
  create: 'make',
  advanced: 'make',
  edit: 'mix',
  train: 'train',
};

export function normalizeCenterTab(value: unknown): CenterTab | null {
  return typeof value === 'string' && (CENTER_TABS as readonly string[]).includes(value)
    ? (value as CenterTab)
    : null;
}

interface AppUiState {
  activeView: theDAWView;
  centerTab: CenterTab;
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  isLibraryExpanded: boolean;
  rightPanelWidth: number;
  docsOpen: boolean;
  setActiveView: (view: unknown) => void;
  setCenterTab: (tab: unknown) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setLibraryExpanded: (expanded: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  setDocsOpen: (open: boolean) => void;
}

const RIGHT_PANEL_DEFAULT_WIDTH = 380;
const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 640;

function clampRightPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, Math.round(w)));
}

export const useAppUiStore = create<AppUiState>()(
  persist(
    (set) => ({
      activeView: 'create',
      centerTab: 'make',
      // Left panel defaults closed now that the center bar hosts all
      // tab content. It still exists (toggleable from the new
      // CenterTabBar) for future use as a context palette.
      isLeftPanelOpen: false,
      isRightPanelOpen: false,
      isLibraryExpanded: false,
      rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,
      docsOpen: false,
      setActiveView: (view) => {
        const normalized = normalizetheDAWView(view);
        if (!normalized) return;
        // The library used to be a left-tab; it now lives in a permanent
        // right-side dock. Any caller that asks to navigate to 'library'
        // gets the right panel opened instead of changing the left view.
        if (normalized === 'library') {
          set({ isRightPanelOpen: true });
          return;
        }
        // Mirror legacy view → center tab so existing 'navigate' callers
        // (orb-kit assistant, library row clicks, WaveformEditor's
        // "back to Create" buttons, etc.) route to the new center bar.
        const mapped = LEGACY_VIEW_TO_CENTER_TAB[normalized];
        if (mapped) {
          set({ activeView: normalized, centerTab: mapped });
        } else {
          set({ activeView: normalized });
        }
      },
      setCenterTab: (tab) => {
        const normalized = normalizeCenterTab(tab);
        if (!normalized) return;
        set({ centerTab: normalized });
      },
      setLeftPanelOpen: (open) => set({ isLeftPanelOpen: open }),
      setRightPanelOpen: (open) => set({ isRightPanelOpen: open, ...(open ? {} : { isLibraryExpanded: false }) }),
      setLibraryExpanded: (expanded) => set({ isLibraryExpanded: expanded, ...(expanded ? { isRightPanelOpen: true } : {}) }),
      setRightPanelWidth: (width) => set({ rightPanelWidth: clampRightPanelWidth(width) }),
      setDocsOpen: (open) => set({ docsOpen: open }),
    }),
    {
      name: 'thedaw-app-ui-v2',
      // Panel open/expand state is intentionally NOT persisted: every app open
      // starts with the shell chrome collapsed (left panel, right library rail).
      // Only the active center tab and the rail width are remembered.
      partialize: (s) => ({
        centerTab: s.centerTab,
        rightPanelWidth: s.rightPanelWidth,
      }),
    },
  ),
);


