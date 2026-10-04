import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Smartphone, X, Copy, ExternalLink, ChevronUp, ChevronDown, GripHorizontal, ChevronRight, ChevronLeft, Library, Maximize2, Minimize2 } from 'lucide-react';
import { LibraryView } from '../../views/LibraryView';
import { DAWCenterPanel } from './DAWCenterPanel';

const CatalogueView = lazy(() => import('../../catalog/CatalogueView').then((m) => ({ default: m.CatalogueView })));
import { CenterTabBar } from './CenterTabBar';
import { LogBody, LogStripCompactInfo } from './ProcessingLog';
import { BottomMultiTabPanel, BOTTOM_TAB_LABELS } from './BottomMultiTabPanel';
import { AutosaveRecoveryNotice } from './AutosaveRecoveryNotice';
import { AudioWorkletUnavailableNotice } from './AudioWorkletUnavailableNotice';
import { initEditorAutosave } from '../../lib/editorAutosave';
// Lazy: the docs modal bundles a markdown/HTML renderer + screenshots; keep it
// out of first paint and only fetch the chunk when the user opens Docs.
const DocsModal = lazy(() => import('./DocsModal').then((m) => ({ default: m.DocsModal })));
// T20 re-audit item 1: QR codes for the mobile-access link and the phone
// companion link (the latter can carry the LAN pairing token in its URL
// fragment) used to be rendered by GETting a third-party QR-image service
// with the full URL folded into a query param — that leaks the token to
// that service's access logs and any TLS-terminating proxy in between.
// Render locally instead; lazy so the QR renderer chunk only loads when a
// share/companion panel is actually opened, the same pattern
// DocsModal/CatalogueView use.
const QRCode = lazy(() => import('react-qr-code'));
import { SettingsModal } from './SettingsModal';
import { DawImportModal } from './DawImportModal';
import { ProjectModal } from './ProjectModal';
import { DownloadDock } from './DownloadDock';
import { useAppUiStore } from '../../state/appUiStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { useDawImportStore } from '../../state/dawImportStore';
import { useProjectStore } from '../../state/projectStore';
import { useEditLayoutStore } from '../../state/editLayoutStore';
import { useEditorStore } from '../../state/editorStore';
import { HamburgerMenu } from '../menu/HamburgerMenu';
import { HomeScreen, useHomeScreenStore } from '../home/HomeScreen';
import { OnboardingTour } from '../../onboarding/OnboardingTour';
import { FeatureNotes } from '../../onboarding/FeatureNotes';
import { HelpSearchPopover } from '../../onboarding/HelpSearchPopover';
import { ScreenRecordButton } from './ScreenRecordButton';
import { useOnboardingStore } from '../../onboarding/onboardingStore';
import { TopBarButton } from './TopBarButton';
import { ImportMenu, IMPORT_AUDIO_EVENT } from './ImportMenu';
import FeatureGateNotices from '../../notices/FeatureGateNotices';
import { useStatusBarStore } from '../../state/statusBarStore';
import { backendHttpBase, lanReachablePort } from '../../lib/backendBase';
import { pairedShareLink } from '../../lib/shareLink';
import { clickNewPairingLink, scheduleDisarm, type RevokeState } from '../../lib/pairingRevoke';
import { setXrHostPosture, onXrPeersChanged, kickXrPeer, type XrPeer } from '../../state/xrControlClient';
import { useEditThemeStore } from '../../state/editThemeStore';
import { resolveEditThemeVars } from '../../lib/editThemes';
import { useLayoutZoom, FOOTER_H } from '../../lib/layoutScale';
import { keyBelongsToFocusedControl } from '../../lib/keyTargets';

const RIGHT_RAIL_MIN = 280;
const RIGHT_RAIL_MAX = 640;

// How often, and for how long, the share panel re-asks `/api/network/lan`
// whether the LAN TLS listener has come up (see the effect that uses these).
// Fast enough to catch it appearing a few seconds into a launch, slow enough
// that nobody notices the requests; bounded, because after a minute the answer
// is not going to change.
const LAN_HTTPS_POLL_INTERVAL_MS = 3_000;
const LAN_HTTPS_POLL_WINDOW_MS = 60_000;

export const Shell: React.FC = () => {
  const navigateTo = useAppUiStore((state) => state.navigateTo);
  const centerTab = useAppUiStore((state) => state.centerTab);
  const setCenterTab = useAppUiStore((state) => state.setCenterTab);
  const isRightPanelOpen = useAppUiStore((state) => state.isRightPanelOpen);
  const setIsRightPanelOpen = useAppUiStore((state) => state.setRightPanelOpen);
  const rightPanelWidth = useAppUiStore((state) => state.rightPanelWidth);
  const setRightPanelWidth = useAppUiStore((state) => state.setRightPanelWidth);
  const isLibraryExpanded = useAppUiStore((state) => state.isLibraryExpanded);
  const setLibraryExpanded = useAppUiStore((state) => state.setLibraryExpanded);
  const docsOpen = useAppUiStore((state) => state.docsOpen);
  const setDocsOpen = useAppUiStore((state) => state.setDocsOpen);
  const openDawImport = useDawImportStore((state) => state.open);
  const openProject = useProjectStore((state) => state.open);
  const editLayoutActive = useEditLayoutStore((state) => state.active);
  const toggleEditLayout = useEditLayoutStore((state) => state.toggle);
  const loadProject = useEditorStore((state) => state.loadProject);
  const homeOpen = useHomeScreenStore((state) => state.open);
  const setHomeOpen = useHomeScreenStore((state) => state.setOpen);
  const homeShowAtStartup = useHomeScreenStore((state) => state.showAtStartup);
  const setHomeShowAtStartup = useHomeScreenStore((state) => state.setShowAtStartup);
  const startTour = useOnboardingStore((state) => state.start);
  /** The tour overlay is on screen — as a tour, or as a one-off spotlight. */
  const onboardingShowing = useOnboardingStore((state) => state.active || state.soloFeatureId !== null);

  // "New Project" clears the current arrangement back to a single empty track
  // (editorStore.loadProject falls back to a clean track for empty input and
  // resets undo history). Guarded so unsaved work is not lost silently.
  const handleNewProject = React.useCallback(() => {
    // Only interrupt when there is actually something to lose.
    if (useEditorStore.getState().dirty) {
      const ok = window.confirm(
        'Start a new project? You have unsaved changes — they will be lost. Save first if you want to keep them.',
      );
      if (!ok) return;
    }
    loadProject({ tracks: [], clips: [] });
  }, [loadProject]);

  // Editor autosave + crash recovery (OPFS asset layer). Started from Shell —
  // mounted for the app's life, unlike WaveformEditor — and idempotent, so the
  // StrictMode double-mount is harmless. Publishes a recovery offer (rendered
  // below as AutosaveRecoveryNotice) when an autosaved arrangement exists.
  React.useEffect(() => {
    initEditorAutosave();
  }, []);

  // Unsaved-changes guard. Clip audio lives in in-memory Blobs, so a refresh or a
  // closed tab could still destroy an arrangement younger than the autosave
  // debounce — this stays as the last line of defence. Lives in Shell, not
  // WaveformEditor, because EDIT unmounts on every tab switch (DAWCenterPanel)
  // while the document stays at risk.
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!useEditorStore.getState().dirty) return;
      e.preventDefault();
      // Modern browsers show their own generic wording; returnValue is set for
      // the older engines that still gate the prompt on it.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Ctrl/Cmd+S opens the project save modal. The app's only other Ctrl+S is the
  // control-surface layout save, which is scoped to design mode.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      // Not while typing. A focused fader is not typing: bailing out there let Ctrl+S fall
      // through to the browser's own "save page" dialog.
      if (keyBelongsToFocusedControl(e)) return;
      e.preventDefault();
      openProject('save');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openProject]);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareUrlOverride, setShareUrlOverride] = React.useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('thedaw.shareUrlOverride') ?? '';
  });
  const [copiedShareUrl, setCopiedShareUrl] = React.useState(false);

  // LAN-reachable URL for this app (host:frontend-port), auto-detected
  // from the backend so the QR points phones at a real address instead
  // of localhost. Falls back to window.location.origin when there's no
  // LAN IP (e.g. offline). Mirrors how the VJ tab builds its mobile QR.
  //
  // `GET /api/network/lan` answers with `https_url` as well when the launcher
  // has a TLS listener UP on this machine right now (backend/lib/lan_https.py,
  // frontend/vite.lan.config.ts). That address is the one to hand out: a
  // browser exposes AudioWorklet, the microphone, Web MIDI, the clipboard and
  // crypto.subtle only in a secure context, so a phone or second PC opening
  // the plain-http address gets an app whose EDIT tab cannot start audio at
  // all. When no listener is up the link is exactly the http one it was.
  const [lanUrl, setLanUrl] = React.useState('');
  const [lanHttpsUrl, setLanHttpsUrl] = React.useState('');
  const isBackendReadyForLan = useStatusBarStore((s) => s.isBackendReady);
  React.useEffect(() => {
    // Wait for the backend: on a packaged cold start this fetch used to fire
    // once before :8600 was bound, fail, and leave the share link on the
    // app://. origin fallback forever.
    //
    // Deliberately NOT guarded on `lanUrl`. `https_url` is a LIVENESS fact —
    // the route reports it only while something answers on the TLS port right
    // now — and on the desktop the listener comes up AFTER the backend is
    // ready: the plan is read (a cold `uv run`), a certificate is minted, then
    // vite starts. So the FIRST answer says "no listener" on the very machine
    // that hands out the link, and stopping there latched the http address for
    // the life of the window. Instead: show the http address at once, keep
    // asking on a bounded schedule, and adopt the secure address when it
    // arrives (which stops the polling, because `lanHttpsUrl` is the guard).
    //
    // Nor is it guarded on the share-URL override. The override decides what
    // the SHARE LINK is (see `shareUrl` below, where it still wins), but
    // `lanHttpsUrl` is a separate fact about this machine that the rest of the
    // UI needs: AudioWorkletUnavailableNotice names it as the address to
    // reopen the app on. Suspending the poll while an override was typed in
    // left that notice with no concrete https address to offer.
    if (!isBackendReadyForLan || lanHttpsUrl) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUpAt = Date.now() + LAN_HTTPS_POLL_WINDOW_MS;
    const askAgainLater = (): void => {
      // Bounded: after the window there is no listener coming, and an endless
      // poll would run for as long as the app is open.
      if (cancelled || Date.now() >= giveUpAt) return;
      timer = setTimeout(ask, LAN_HTTPS_POLL_INTERVAL_MS);
    };
    function ask(): void {
      void fetch('/api/network/lan')
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { lan_ip?: string | null; https_url?: string | null } | null) => {
          if (cancelled || typeof window === 'undefined') return;
          if (!j?.lan_ip) {
            askAgainLater();
            return;
          }
          // Only an https address is an upgrade; anything else and we would be
          // swapping one insecure origin for another.
          const secure = (j.https_url ?? '').trim();
          if (secure.toLowerCase().startsWith('https://')) {
            setLanHttpsUrl(secure);
            setLanUrl(secure);
            return;
          }
          // Packaged app has no window port (app://. origin) — phones reach it
          // on the backend port; browser dev keeps its own port (5173
          // fallback). Shown straight away, so the panel is never blank while
          // the secure address is still being waited for.
          const port = lanReachablePort() || '5173';
          setLanUrl(`http://${j.lan_ip}:${port}`);
          askAgainLater();
        })
        .catch(() => {
          /* no backend / no LAN — keep the http fallback and try again */
          askAgainLater();
        });
    }
    ask();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isBackendReadyForLan, lanHttpsUrl]);

  // Never fall back to window.location.origin blindly: in the packaged app
  // that is app://., which is useless on a phone AND opens a second copy of
  // the whole app when clicked. backendHttpBase() is always a real http URL.
  const detectedShareUrl =
    lanUrl || (typeof window === 'undefined' ? '' : backendHttpBase());
  const shareUrl = shareUrlOverride.trim() || detectedShareUrl;
  // True only when the link being handed out is THIS machine's own TLS
  // listener — not when the user has pasted some other https URL (a Cloudflare
  // tunnel, say) into the override, where the certificate note below would be
  // wrong: a tunnel presents a certificate the browser already trusts.
  const shareUrlIsLanHttps = Boolean(lanHttpsUrl) && shareUrl === lanHttpsUrl;

  // Phone-companion pairing. The host picks the posture (open LAN or a required
  // code) before handing out the QR; the code rides the URL as ?xrcode=<code>
  // (T20 re-audit item 7 — was ?pair=, which collided in NAME, though never in
  // code, with the unrelated LAN pairing token below that rides #pair=<token>
  // in the URL fragment; RemoteGate's on-screen guidance told a user holding
  // that token to paste it here, where it would silently fail as an XR
  // posture code) so scanning auto-fills it. See
  // docs/companion-control-contract.md.
  const [postureMode, setPostureMode] = React.useState<'open' | 'code'>('open');
  const [pairCode, setPairCode] = React.useState('');
  const [companionPeers, setCompanionPeers] = React.useState<XrPeer[]>([]);
  const [copiedCompanion, setCopiedCompanion] = React.useState(false);

  React.useEffect(() => onXrPeersChanged(setCompanionPeers), []);
  React.useEffect(() => {
    setXrHostPosture({ mode: postureMode, code: postureMode === 'code' ? pairCode : null });
  }, [postureMode, pairCode]);

  // T20 re-audit item 6: the LAN pairing token (backend/lib/pairing.py) was
  // minted by the backend and consumed by frontend/src/lib/pairing.ts, but
  // nothing in the UI ever fetched it or put it on a link — the companion
  // link worked only because SEC-001's loopback/cross-site gate on phones
  // reaching over a real LAN IP was never actually enforced end-to-end. This
  // fetches it once (loopback-or-launch-token gated route: this machine's own
  // UI or the desktop shell) and appends it to the companion link and the
  // Share URL as `#pair=<token>`, the URL FRAGMENT — never sent to any server
  // or proxy log, per pairing.ts. A failed fetch (no backend yet, route gate
  // rejected) must not break either link; they ship without the LAN pairing
  // token, and the dialog says what that leaves out.
  const [lanPairingToken, setLanPairingToken] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void fetch('/api/pairing/token')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { token?: string } | null) => {
        if (!cancelled && j?.token) setLanPairingToken(j.token);
      })
      .catch(() => {
        /* no backend yet, or this isn't the desktop shell — companion link
           still works, just without a LAN pairing token attached */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The Share URL for the full desktop UI carries the same token, so the device
  // that opens it (or scans its QR) is paired. Without it that device was a
  // stranger to the backend: every save, open, project clip, VST effect and
  // Gemini call it made was refused (backend/lib/cross_site.py). The companion
  // link below builds its own fragment the same way. See lib/shareLink.ts.
  const pairedShareUrl = useMemo(
    () => pairedShareLink(shareUrl, lanPairingToken),
    [shareUrl, lanPairingToken],
  );

  // "New pairing link" replaces the token (POST /api/pairing/token/regenerate,
  // same gate as the read), so every link handed out before stops working. It
  // un-pairs every device already paired, hence two clicks: the first arms it
  // for a few seconds, the second makes the new link. See lib/pairingRevoke.ts.
  const [revokeArmed, setRevokeArmed] = React.useState(false);
  const [revokeState, setRevokeState] = React.useState<RevokeState>('idle');
  React.useEffect(() => scheduleDisarm(revokeArmed, setRevokeArmed), [revokeArmed]);
  const revokePairing = () =>
    clickNewPairingLink({
      armed: revokeArmed,
      state: revokeState,
      setArmed: setRevokeArmed,
      setState: setRevokeState,
      adoptToken: setLanPairingToken,
    });

  const companionUrl = useMemo(() => {
    const base = (shareUrl || '').replace(/\/+$/, '');
    if (!base) return '';
    const q = postureMode === 'code' && pairCode ? `?xrcode=${pairCode}` : '';
    const fragment = lanPairingToken ? `#pair=${encodeURIComponent(lanPairingToken)}` : '';
    return `${base}/mobile.html${q}${fragment}`;
  }, [shareUrl, postureMode, pairCode, lanPairingToken]);
  const chooseCodePosture = () => {
    setPairCode((c) => c || Math.floor(1000 + Math.random() * 9000).toString());
    setPostureMode('code');
  };
  const copyCompanionUrl = async () => {
    try {
      await navigator.clipboard.writeText(companionUrl);
      setCopiedCompanion(true);
      window.setTimeout(() => setCopiedCompanion(false), 1500);
    } catch {
      /* clipboard blocked — the URL is still visible to copy manually */
    }
  };

  const updateShareUrlOverride = (value: string) => {
    setShareUrlOverride(value);
    if (typeof window === 'undefined') return;
    if (value.trim()) window.localStorage.setItem('thedaw.shareUrlOverride', value);
    else window.localStorage.removeItem('thedaw.shareUrlOverride');
  };

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(pairedShareUrl);
      setCopiedShareUrl(true);
      window.setTimeout(() => setCopiedShareUrl(false), 1400);
    } catch {
      setCopiedShareUrl(false);
    }
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab;
      navigateTo(tab);
    };
    const openDocsHandler = () => setDocsOpen(true);
    const closeDocsHandler = () => setDocsOpen(false);
    // CHANGED: let the Suno panel's "Open Settings" prompt open the modal.
    const openSettingsHandler = () => setSettingsOpen(true);
    window.addEventListener('thedaw:navigate', handler);
    window.addEventListener('thedaw:open-docs', openDocsHandler);
    window.addEventListener('thedaw:close-docs', closeDocsHandler);
    window.addEventListener('thedaw:open-settings', openSettingsHandler);
    return () => {
      window.removeEventListener('thedaw:navigate', handler);
      window.removeEventListener('thedaw:open-docs', openDocsHandler);
      window.removeEventListener('thedaw:close-docs', closeDocsHandler);
      window.removeEventListener('thedaw:open-settings', openSettingsHandler);
    };
  }, [navigateTo, setDocsOpen]);

  // ── Right rail drag-resize. When the Library is open, dragging the
  // rail's left edge widens / narrows the rail. The collapsed-rail
  // state is fixed-width (RIGHT_RAIL_COLLAPSED) and not resizable.
  const [isResizingRail, setIsResizingRail] = useState(false);
  useEffect(() => {
    if (!isResizingRail) return;
    const onMove = (e: MouseEvent) => {
      const next = window.innerWidth - e.clientX;
      const clamped = Math.max(RIGHT_RAIL_MIN, Math.min(RIGHT_RAIL_MAX, next));
      setRightPanelWidth(clamped);
    };
    const onUp = () => setIsResizingRail(false);
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizingRail, setRightPanelWidth]);

  // Continuous width+height aware shell scale (see lib/layoutScale.ts). Published
  // inline as --layout-zoom + zoom on the root so the CSS contract is unchanged.
  const layoutZoom = useLayoutZoom();
  const editThemeId = useEditThemeStore((s) => s.themeId);
  const editThemeImage = useEditThemeStore((s) => s.customImage);
  const editTheme = useMemo(
    () => resolveEditThemeVars(editThemeId, editThemeImage),
    [editThemeId, editThemeImage],
  );

  return (
    <div
      className="edit-theme-scope relative flex flex-col w-full bg-[#07050a] text-[#f5f3ff] overflow-hidden font-sans dense-layout"
      data-et-light={editTheme.light ? '1' : undefined}
      data-layout-zoom={layoutZoom}
      style={{
        ...({ '--layout-zoom': String(layoutZoom) } as React.CSSProperties),
        zoom: layoutZoom,
        // FOOTER_H (lib/layoutScale.ts) is the fixed, unzoomed PlayerFooter below.
        height: `calc((100vh - ${FOOTER_H}px) / var(--layout-zoom))`,
        ...(editTheme.vars as React.CSSProperties),
      }}
    >
      {/* Combined header + tab bar — logo (left), workspace tabs (center),
          Screen record / Fullscreen / Mobile / Help / Import / app-menu (right). G-Search moved to the footer.

          z-40 is about what DROPS OUT of this row, not about the row: the app
          menu, the import menu and the help search hang below it, over the library rail (z-20)
          and the bottom dock (z-30). At z-10 they were painted behind an open
          rail — the header never overlaps either strip itself, so raising it
          changes nothing else. It stays under the modal layer (z-50 and up). */}
      <header className="h-11 border-b border-white/5 flex items-center gap-3 px-3 bg-[#0a080f]/80 backdrop-blur-md z-40 shrink-0 relative">
        <a
          href="https://github.com/gantasmo/theDAW"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 relative z-10 select-none shrink-0 group/brand cursor-pointer"
          title="theDAW by GANTASMO — opens github.com/gantasmo/theDAW"
        >
          <BrandLogo />
          <div className="flex flex-col leading-none">
            <span className="text-[13px] font-black tracking-[0.18em] text-zinc-100 group-hover/brand:text-white transition-colors">theDAW</span>
            <span className="text-[8px] font-mono uppercase tracking-[0.3em] text-zinc-500 group-hover/brand:text-purple-300 transition-colors">by GANTASMO</span>
          </div>
        </a>

        {/* Workspace tabs — embedded so they share this row instead of a
            separate strip below. */}
        <CenterTabBar
          activeTab={centerTab}
          onTabChange={setCenterTab}
          embedded
        />

        <div className="flex items-center gap-2.5 shrink-0">
          {/* Order: Screen record, Fullscreen, Mobile, Help, Import, then the app menu (hamburger) on the far right. */}
          <ScreenRecordButton />
          <FullscreenToggle />
          <TopBarButton
            onClick={() => setShareOpen(true)}
            icon={<Smartphone className="w-3.5 h-3.5" />}
            title="Open mobile access QR/link"
          />
          {/* The Docs button used to sit here on its own. It now lives one step
              in, beside the search field, because "open the manual" is the
              answer to a question the search can usually answer better. */}
          <HelpSearchPopover onOpenDocs={() => setDocsOpen(true)} />
          {/* Global import — audio files to the library, a .tasmo, or a DAW
              project. On every tab, in one place, next to the menu that also
              lists the project ops, so nobody has to hunt per workspace. */}
          <ImportMenu
            onOpenProject={() => openProject('open')}
            onImportDawProject={() => openDawImport()}
          />
          {/* App menu — project ops, backup/migrate, updates, Settings, Edit
              Layout, DAW import (also under IMPORT), and .tasmo save/open all
              live here. It is the sole entry point for Settings (the header
              gear was retired). */}
          <span data-tour="app-menu" className="inline-flex">
            <HamburgerMenu
              onNewProject={handleNewProject}
              onOpenProject={() => openProject('open')}
              onSaveProject={() => openProject('save')}
              onImportDawProject={() => openDawImport()}
              onToggleEditLayout={toggleEditLayout}
              editLayoutActive={editLayoutActive}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenDocs={() => setDocsOpen(true)}
              onStartTour={startTour}
              onOpenHome={() => setHomeOpen(true)}
            />
          </span>
        </div>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden relative">
      {/* Main Canvas — hidden when library is expanded to full view. */}
      {!isLibraryExpanded && (
        <main className="flex-1 h-full overflow-hidden flex flex-col relative bg-[#110e1a]/60">
          <DAWCenterPanel onSwitchTab={(tab) => navigateTo(tab)} />
        </main>
      )}

      {/* Library rail — compact side panel or expanded full-width catalogue. */}
      {isRightPanelOpen && (
        <aside
          data-tour="library"
          className={`h-full min-h-0 flex flex-col bg-[#0a080f] border-l border-purple-500/20 shadow-[inset_1px_0_0_rgba(168,85,247,0.08)] z-20 relative ${isLibraryExpanded ? 'flex-1' : 'shrink-0'}`}
          style={isLibraryExpanded ? undefined : {
            width: rightPanelWidth,
            transition: isResizingRail ? 'none' : 'width 220ms cubic-bezier(.2,.7,.2,1)',
          }}
        >
          {/* Resize handle — only in compact mode. */}
          {!isLibraryExpanded && (
            <div
              className="absolute top-0 bottom-0 -left-1 w-2 cursor-col-resize z-30 group"
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingRail(true);
              }}
            >
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-white/10 group-hover:bg-purple-500/50 rounded-full transition-colors" />
            </div>
          )}

          <div className="flex-1 overflow-hidden relative min-h-0">
            {isLibraryExpanded ? (
              <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 animate-pulse">loading…</span></div>}>
                <CatalogueView onCollapse={() => setLibraryExpanded(false)} />
              </Suspense>
            ) : (
              <LibraryView onSwitchTab={(tab: string) => navigateTo(tab)} onExpand={() => setLibraryExpanded(true)} />
            )}
          </div>
        </aside>
      )}

      </div>

      {/* Global bottom dock — BottomMultiTabPanel (left, flex-1) and
          ProcessingLog (right, width = rightPanelWidth) live
          side-by-side at the bottom of the app. INDEPENDENT of the
          library panel state. Each column has its OWN height +
          collapse toggle + resize handle (multiHeight / logHeight in
          bottomPanelStore) — expanding or resizing one does NOT
          affect the other. */}
      <ShellBottomDock />

      {/* Library edge tab — root-level so it floats ABOVE every panel (bottom
          dock, log, maximized panels) and is never clipped by the work area's
          overflow. Vertically centered on the right edge. Click toggles the
          library; resize stays on the panel's inner edge.

          It says its own name. This was a 14px sliver whose only library-shaped
          hint appeared on hover, so at rest it read as a scrollbar artefact —
          and at the 0.6 floor of --layout-zoom it was eight PHYSICAL pixels
          wide. The rail labels itself the moment it opens, which is exactly
          when the label is no longer needed; the wordmark puts the name where
          someone hunting for it is actually looking. Widening it means the
          dock's right-hand cluster has to move too: BottomMultiTabPanel carries
          the matching clearance.

          The visible wordmark IS the accessible name — no aria-label, which
          would override what the button plainly says. `title` carries the
          direction and the shortcut instead. */}
      {/* data-edge-tab: the MIDI dock measures this tab and pads its strip and body clear of it. */}
      <button
        type="button"
        data-edge-tab="library"
        onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
        title={`${isRightPanelOpen ? 'Collapse' : 'Expand'} library (Ctrl+K opens it)`}
        aria-expanded={isRightPanelOpen}
        className="absolute right-0 top-1/2 -translate-y-1/2 z-50 flex flex-col items-center justify-center gap-1.5 h-32 w-6 rounded-l-lg border border-r-0 border-purple-400/70 bg-purple-500/25 text-purple-100 shadow-[0_0_16px_rgba(168,85,247,0.45)] hover:w-8 hover:text-white hover:border-purple-300/80 hover:bg-purple-500/40 hover:shadow-[0_0_22px_rgba(168,85,247,0.65)] transition-all outline-none focus-visible:ring-1 focus-visible:ring-purple-300"
      >
        <Library className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        {/* leading-none, not inherited: in vertical writing the line box is the
            span's WIDTH, and an inherited line-height clips it inside w-6. */}
        <span className="text-[10px] font-mono font-black uppercase tracking-widest leading-none select-none [writing-mode:vertical-rl]">
          Library
        </span>
        {isRightPanelOpen
          ? <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />
          : <ChevronLeft className="w-3 h-3 shrink-0" aria-hidden="true" />}
      </button>
      {docsOpen && (
        <Suspense fallback={null}>
          <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} />
        </Suspense>
      )}
      {shareOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setShareOpen(false)} />
          <div
            role="dialog"
            aria-labelledby="shell-share-title"
            className="relative flex max-h-[92vh] w-[min(460px,92vw)] flex-col overflow-hidden rounded-lg border border-emerald-500/30 bg-[#0c0a14] shadow-2xl"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-linear-to-r from-emerald-900/25 to-purple-900/15">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-300" />
                <div className="flex flex-col leading-tight">
                  <span id="shell-share-title" className="font-display text-sm font-bold uppercase tracking-widest text-emerald-200">Mobile Access</span>
                  <span className="text-xs font-semibold text-emerald-300/70">QR code and share link</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShareOpen(false)}
                aria-label="Close Mobile Access"
                className="p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 flex flex-col gap-4 overflow-y-auto">
              <div className="flex justify-center">
                <div className="p-3 rounded-lg bg-white shadow-[0_0_24px_rgba(16,185,129,0.16)]">
                  <Suspense fallback={<div className="w-55 h-55" role="img" aria-label="theDAW mobile access QR code loading" />}>
                    <QRCode value={pairedShareUrl} size={220} title="theDAW mobile access QR code" />
                  </Suspense>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="shell-share-url" className="text-xs font-bold uppercase tracking-wider text-zinc-300">Share URL</label>
                <div className="flex gap-2">
                  <input
                    id="shell-share-url"
                    type="text"
                    name="shell-share-url"
                    value={pairedShareUrl}
                    readOnly
                    className="min-w-0 flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs font-semibold text-zinc-200 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void copyShareUrl()}
                    className="px-2 py-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5"
                    title="Copy share URL"
                  >
                    <Copy className="w-3.5 h-3.5" /> {copiedShareUrl ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <a href={pairedShareUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300/80 hover:text-emerald-200 transition-colors">
                  <ExternalLink className="w-3.5 h-3.5" /> Open link in new tab
                </a>
                {lanPairingToken ? (
                  <p className="text-xs leading-relaxed text-zinc-400">
                    This link pairs the device that opens it: that device can save and open projects in your projects folder, run VST effects and use the Gemini assistant. Plugin windows and Show in folder stay on this computer. Share it only with devices you trust.
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-amber-300/80">
                    This link carries no pairing token, so the device that opens it cannot save or open projects, run VST effects or use the Gemini assistant. Open Mobile Access on the computer running theDAW to get a paired link.
                  </p>
                )}
                {shareUrlIsLanHttps && (
                  <p className="text-xs leading-relaxed text-emerald-300/80">
                    Secure address &mdash; audio, mic and MIDI work on other devices. The first visit shows a certificate warning; choose Proceed.
                  </p>
                )}
                {lanPairingToken && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => void revokePairing()}
                      disabled={revokeState === 'busy'}
                      className={`px-2 py-1.5 rounded border text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-50 ${revokeArmed ? 'border-red-500/50 bg-red-500/15 text-red-200 hover:bg-red-500/25' : 'border-white/10 bg-black/30 text-zinc-300 hover:text-white'}`}
                      title="Make a new pairing link; every link shared before stops working"
                    >
                      {revokeArmed ? 'Confirm: old links stop working' : 'New pairing link'}
                    </button>
                    {revokeState === 'done' && (
                      <span role="status" className="text-xs font-semibold text-emerald-300/80">New link made. Links shared before no longer work.</span>
                    )}
                    {revokeState === 'failed' && (
                      <span role="status" className="text-xs font-semibold text-red-300/80">Could not make a new link. The old one still works.</span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="shell-share-url-override" className="text-xs font-bold uppercase tracking-wider text-zinc-300">External URL override</label>
                <input
                  id="shell-share-url-override"
                  type="url"
                  name="shell-share-url-override"
                  value={shareUrlOverride}
                  onChange={(e) => updateShareUrlOverride(e.target.value)}
                  placeholder="Paste Cloudflare tunnel URL, e.g. https://name.trycloudflare.com"
                  className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs font-semibold text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                />
                <p className="text-xs leading-relaxed text-zinc-400">
                  By default this uses <span className="font-semibold text-zinc-300">{detectedShareUrl}</span>. Paste a Cloudflare Tunnel or other public URL here when your phone is not on the same network.
                </p>
              </div>

              {/* Phone companion — a lean remote app (library + player control),
                  separate from opening the full desktop UI above. */}
              <div className="flex flex-col gap-2 pt-3 border-t border-white/5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-xs font-bold uppercase tracking-widest text-purple-300">Phone companion</span>
                  <span className="text-xs font-semibold text-purple-300/70">Library and remote</span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  A lightweight phone app to browse and play the library and remote-control the player. Choose who may drive this desktop before you share the code.
                </p>

                {/* Posture: both options shown; the host selects before allowing a peer. */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    aria-pressed={postureMode === 'open'}
                    onClick={() => setPostureMode('open')}
                    className={`flex-1 px-2 py-1.5 rounded border text-xs font-bold uppercase tracking-wider transition-colors ${postureMode === 'open' ? 'border-purple-400/60 bg-purple-500/20 text-purple-100' : 'border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Open LAN
                  </button>
                  <button
                    type="button"
                    aria-pressed={postureMode === 'code'}
                    onClick={chooseCodePosture}
                    className={`flex-1 px-2 py-1.5 rounded border text-xs font-bold uppercase tracking-wider transition-colors ${postureMode === 'code' ? 'border-purple-400/60 bg-purple-500/20 text-purple-100' : 'border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Require code
                  </button>
                </div>

                {postureMode === 'code' && (
                  <div className="flex items-center justify-between px-3 py-2 rounded bg-black/40 border border-purple-500/20">
                    <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">Pair code</span>
                    <span className="text-base font-black tabular-nums tracking-[0.35em] text-purple-200">{pairCode}</span>
                  </div>
                )}

                {companionUrl && (
                  <div className="flex justify-center pt-1">
                    <div className="p-3 rounded-lg bg-white shadow-[0_0_24px_rgba(139,92,246,0.16)]">
                      <Suspense fallback={<div className="w-44 h-44" role="img" aria-label="theDAW phone companion QR code loading" />}>
                        <QRCode value={companionUrl} size={176} title="theDAW phone companion QR code" />
                      </Suspense>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="shell-companion-url" className="text-xs font-bold uppercase tracking-wider text-zinc-300">Companion URL</label>
                  <div className="flex gap-2">
                    <input
                      id="shell-companion-url"
                      type="text"
                      name="shell-companion-url"
                      value={companionUrl}
                      readOnly
                      className="min-w-0 flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs font-semibold text-zinc-200 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void copyCompanionUrl()}
                      className="px-2 py-1.5 rounded border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 text-purple-200 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5"
                      title="Copy companion URL"
                    >
                      <Copy className="w-3.5 h-3.5" /> {copiedCompanion ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>

                {companionPeers.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">Connected ({companionPeers.length})</span>
                    <ul className="flex flex-col gap-1">
                      {companionPeers.map((p) => (
                        <li key={p.peerId} className="flex items-center justify-between px-2 py-1.5 rounded bg-black/30 border border-white/10">
                          <span className="text-xs font-semibold text-zinc-200">{p.label}</span>
                          <button
                            type="button"
                            onClick={() => kickXrPeer(p.peerId)}
                            aria-label={`Disconnect ${p.label}`}
                            className="px-2 py-0.5 rounded border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-200 text-xs font-bold uppercase tracking-wider"
                          >
                            Kick
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DawImportModal />
      <ProjectModal />
      {/* Floating model-download manager — fixed bottom-right, self-hiding when
          there are no downloads. Mounted once at the app root so it floats over
          every view. */}
      <DownloadDock />
      {/* Feature-gate notices (bottom-right stack) — offsets itself above the
          DownloadDock when downloads are active. Renders null when empty. */}
      <FeatureGateNotices />
      {/* Crash-recovery offer for the editor autosave (top-center; renders null
          when there is nothing to recover). */}
      <AutosaveRecoveryNotice />
      {/* Standing explanation when this page cannot run AudioWorklet at all
          (plain-http LAN address, or a browser without it). Renders null on a
          page that is fine, and once dismissed for this session. */}
      <AudioWorkletUnavailableNotice secureUrl={lanHttpsUrl || null} />
      {/* Startup HOME landing (card grid per workspace). Auto-opened by App on
          returning launches; also reachable from the app menu. */}
      {homeOpen && (
        <HomeScreen
          showAtStartup={homeShowAtStartup}
          onToggleShowAtStartup={setHomeShowAtStartup}
          onNavigate={(tab) => setCenterTab(tab)}
          onOpenProject={() => openProject('open')}
          // Synchronous on purpose: the header's ImportMenu clicks its file
          // input inside this same user activation, and a deferred dispatch
          // would leave the browser refusing to open the picker.
          onImportAudio={() => window.dispatchEvent(new CustomEvent(IMPORT_AUDIO_EVENT))}
          onStartTour={startTour}
          onClose={() => setHomeOpen(false)}
        />
      )}
      {/* First-run feature tour (spotlight overlay). Reads its own store; the
          shell only supplies the tab-switch hook so steps can jump workspaces. */}
      <OnboardingTour onSwitchTab={setCenterTab} />
      {/* Pinned labels on the affordances that carry no label of their own —
          the LOG and PANELS strips. Each retires itself the first time its
          feature is used.

          Hidden while the tour or a spotlight is up. Two reasons, both real: a
          note sits at z-1000 and would float over the spotlight mask, including
          during the steps that explain those very strips; and the tour opens
          panels in order to point at them, which a note must not mistake for
          the user having found one. */}
      {!onboardingShowing && <FeatureNotes />}
    </div>
  );
};

/**
 * Global bottom dock.
 *
 * Layout (always one horizontal strip at the bottom):
 *
 *   ┌─────────── canvas / main ────────────┬│┬── log body ──────┐
 *   │                                       ││                   │
 *   │  (multi body if isBottomOpen)         ││ (log body if      │
 *   │                                       ││  isLogOpen)       │
 *   ├───────────────────────────────────────┼─────────┬─────────┤
 *   │   ^   multi toggle  (flex-1)          │ ^ LOG …│ CREATE  │  <- the strip
 *   └───────────────────────────────────────┴─────────┴─────────┘
 *                                            ←──── logWidth ─────→
 *                                            ← 40% ─→← 60% ──────→
 *
 * - The dock body has ONE shared height (multiHeight) via a single vertical
 *   handle, so the LOG can never grow taller than the dock and push into the
 *   center work area; LOG content scrolls internally instead.
 * - The LOG has its OWN width (logWidth) with a horizontal handle at its left
 *   edge (the `│` above). Dragging it also nudges the library rail above so
 *   they stay aligned — one-way: the rail's own handle never changes logWidth.
 * - The strip is fixed-height and always visible. The left `^` collapses the
 *   multi-tab body; the LOG's `^` collapses the LOG body.
 * - The CREATE / PROCESS / TRAIN action button lives in the footer's
 *   bottom-right corner (PlayerFooter), not in this strip.
 */
const STRIP_HEIGHT = 28;
/** Header row height (h-11), logical px; header + strip = the 4.5rem the
 *  maximized-dock calc reserves (72px). */
const HEADER_HEIGHT = 44;
const DOCK_MIN_HEIGHT = 60;
const DOCK_MAX_FRACTION = 0.85;
/** Open dock body ≤ this share of the work area (see effectiveMultiHeight). */
const DOCK_MAX_FRACTION_OF_WORK = 0.6;

/** window.innerHeight tracked across resizes (the zoom hook only re-renders
 *  when the rounded zoom changes; the dock clamp needs the raw height too). */
function useWindowInnerHeight(): number {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 0 : window.innerHeight));
  useEffect(() => {
    const update = () => setH(window.innerHeight);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return h;
}
const LOG_MIN_WIDTH = 220;
const LOG_MAX_WIDTH = 720;

const ShellBottomDock: React.FC = () => {
  const multiHeight = useBottomPanelStore((s) => s.multiHeight);
  const setMultiHeight = useBottomPanelStore((s) => s.setMultiHeight);
  const logWidth = useBottomPanelStore((s) => s.logWidth);
  const setLogWidth = useBottomPanelStore((s) => s.setLogWidth);
  const isBottomOpen = useBottomPanelStore((s) => s.isOpen);
  const setBottomOpen = useBottomPanelStore((s) => s.setOpen);
  const isLogOpen = useBottomPanelStore((s) => s.isLogOpen);
  const setLogOpen = useBottomPanelStore((s) => s.setLogOpen);
  const multiMaximized = useBottomPanelStore((s) => s.multiMaximized);
  const activeBottomTab = useBottomPanelStore((s) => s.activeTab);

  // Dock-body height — shared by the multi-tab panel (in-flow) and the floating
  // LOG overlay. Maximized fills the work area. The height MUST be computed in
  // the same zoom-aware space as the .dense-layout root (height =
  // calc((100vh - FOOTER_H) / var(--layout-zoom))); a raw `100vh` calc here ignores
  // --layout-zoom and, at zoom > 1, overflows the root's overflow-hidden so the
  // dock's own bottom (e.g. the Score viewer's page/zoom controls) is clipped.
  // Reserve 4.5rem inside the root for the header (h-11 = 44px) + the always-on
  // 28px strip (72px total).
  // Clamp: the open dock body never takes more than DOCK_MAX_FRACTION_OF_WORK
  // of the work area (shell minus header + strip, logical px), so a persisted
  // 320px dock on a 1366x768 laptop cannot squeeze the tab above it into a
  // clipped sliver. Re-evaluated on resize (zoom hook + innerHeight).
  const layoutZoom = useLayoutZoom();
  const innerH = useWindowInnerHeight();
  const workAreaH = Math.max(0, (innerH - FOOTER_H) / layoutZoom - HEADER_HEIGHT - STRIP_HEIGHT);
  const effectiveMultiHeight = Math.max(
    DOCK_MIN_HEIGHT,
    Math.min(multiHeight, Math.floor(workAreaH * DOCK_MAX_FRACTION_OF_WORK)),
  );
  const bodyHeight = multiMaximized
    ? `calc((100vh - ${FOOTER_H}px) / var(--layout-zoom) - 4.5rem)`
    : `${effectiveMultiHeight}px`;
  // The LOG strip section auto-fits its content (the telemetry readouts + the
  // fixed action button). Mirror its measured width into logWidth so the LOG
  // body directly below it stays column-aligned (opens to the same left edge).
  const logSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logSectionRef.current;
    if (!el) return;
    const sync = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setLogWidth(w);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [setLogWidth]);

  return (
    <div className="relative shrink-0 flex flex-col z-30 pointer-events-none">
      {/* Multi-tab body — in-flow; the global bottom panel legitimately lifts the
          work area. The LOG no longer shares this row (it floats, below).
          `dock-emerge` rises it out of the strip toggle beneath on open. */}
      {isBottomOpen && (
        <div
          className="relative shrink-0 bg-[#0a080f] overflow-hidden shadow-[0_-1px_0_rgba(168,85,247,0.08)] pointer-events-auto"
          style={{ height: bodyHeight, animation: 'dock-emerge 180ms cubic-bezier(.2,.7,.2,1)' }}
        >
          {!multiMaximized && (
            <ColumnResizeHandle
              currentHeight={effectiveMultiHeight}
              onSet={setMultiHeight}
              title="Drag to resize the bottom dock"
            />
          )}
          <div className="absolute inset-x-0 top-0 h-px bg-purple-500/20 pointer-events-none" />
          <BottomMultiTabPanel />
        </div>
      )}

      {/* LOG body — FLOATING overlay: anchored just above the strip, right-aligned,
          only logWidth wide. It autofits under the right panel and floats over the
          bottom-right of the work area instead of pushing the whole UI up. */}
      {isLogOpen && (
        <div
          className="absolute right-0 z-40 pointer-events-auto bg-[#0a080f] overflow-hidden border-l border-purple-500/15 shadow-[-2px_-2px_12px_rgba(0,0,0,0.5)]"
          style={{ bottom: STRIP_HEIGHT, width: logWidth, height: bodyHeight, animation: 'dock-emerge 180ms cubic-bezier(.2,.7,.2,1)' }}
        >
          {!multiMaximized && (
            <ColumnResizeHandle
              currentHeight={effectiveMultiHeight}
              onSet={setMultiHeight}
              title="Drag to resize the log height"
            />
          )}
          <div className="absolute inset-x-0 top-0 h-px bg-purple-500/20 pointer-events-none" />
          <LogBody />
        </div>
      )}

      {/* Single horizontal strip — always visible. `relative` anchors the
          viewport-centred expand chevron. Styled in the footer's own language
          (same tinted-blur background, same hairline border) so the toggles
          read as the footer's top row rather than a separate dock. */}
      <div className="relative shrink-0 flex items-stretch pointer-events-auto" style={{ height: STRIP_HEIGHT }}>

        {/* Multi-tab toggle — flex-1 clickable area (the chevron is centred
            separately, below, so it lines up with PLAY / DJ / the mirror line).
            Labeled like the LOG toggle: PANELS + the active tab's name, so the
            slab reads as a button instead of empty chrome. */}
        <button
          type="button"
          data-feature-note="panels"
          onClick={() => setBottomOpen(!isBottomOpen)}
          className="min-w-0 flex-1 flex items-center gap-1.5 px-2 bg-[#0a080f]/95 backdrop-blur-xl hover:bg-purple-500/8 transition-colors border-t border-r border-white/5 shadow-[0_-1px_0_rgba(168,85,247,0.08)] group"
          title={isBottomOpen ? 'Collapse bottom panel' : 'Expand bottom panel'}
          aria-label={isBottomOpen ? 'Collapse bottom panel' : 'Expand bottom panel'}
        >
          {isBottomOpen
            ? <ChevronDown className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors shrink-0" />
            : <ChevronUp className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors shrink-0" />
          }
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-200 shrink-0">Panels</span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 truncate">
            {BOTTOM_TAB_LABELS[activeBottomTab] ?? ''}
          </span>
        </button>

        {/* Expand chevron — centred on the viewport so it lines up with the PLAY
            button, the DJ tab, and the layout-editor mirror line. pointer-events
            pass through to the toggle button behind it. */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          {isBottomOpen
            ? <ChevronDown className="w-3.5 h-3.5 text-purple-300" />
            : <ChevronUp className="w-3.5 h-3.5 text-purple-300" />
          }
        </div>

        {/* LOG strip section — CONTENT width: auto-fits the CPU/GPU/TEMP/VRAM/RAM
            readouts (its measured width drives logWidth). The action button is a
            FIXED width and never grows with the LOG. */}
        <div ref={logSectionRef} className="shrink-0 bg-[#0a080f]/95 backdrop-blur-xl flex items-stretch border-t border-white/5 shadow-[0_-1px_0_rgba(168,85,247,0.08)]">
          {/* LOG header — natural width so every readout shows in full. */}
          <button
            type="button"
            data-feature-note="log"
            onClick={() => setLogOpen(!isLogOpen)}
            className="flex items-center gap-1.5 px-2 group hover:bg-purple-500/8 transition-colors border-r border-purple-500/15 shrink-0"
            title={isLogOpen ? 'Collapse log' : 'Expand log'}
            aria-label={isLogOpen ? 'Collapse log' : 'Expand log'}
          >
            {isLogOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors shrink-0" />
              : <ChevronUp className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors shrink-0" />
            }
            <span className="font-display font-bold text-xs leading-4 uppercase text-purple-200 shrink-0">LOG</span>
            {/* Live CPU · GPU · TEMP · VRAM · RAM — shown in full (the section sizes to fit). */}
            <span className="shrink-0"><LogStripCompactInfo /></span>
          </button>
          {/* The workspace action button (CREATE / PROCESS / TRAIN) now lives in
              the footer's bottom-right corner, on every tab — see PlayerFooter. */}
        </div>
      </div>
    </div>
  );
};

/**
 * Per-column resize handle. Lives at the TOP edge of the column it
 * controls. Dragging up grows that column only; the other column is
 * untouched. Clamped to [DOCK_MIN_HEIGHT, viewport * DOCK_MAX_FRACTION].
 */
interface ColumnResizeHandleProps {
  currentHeight: number;
  onSet: (h: number) => void;
  title: string;
}
const ColumnResizeHandle: React.FC<ColumnResizeHandleProps> = ({ currentHeight, onSet, title }) => {
  const [dragging, setDragging] = useState(false);
  const startY = React.useRef(0);
  const startH = React.useRef(currentHeight);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dy = startY.current - e.clientY; // up = positive
      const max = Math.floor(window.innerHeight * DOCK_MAX_FRACTION);
      const clamped = Math.max(DOCK_MIN_HEIGHT, Math.min(max, startH.current + dy));
      onSet(clamped);
    };
    const onUp = () => setDragging(false);
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onSet]);

  return (
    <>
      {/* While dragging, a full-window overlay sits ABOVE the center iframe
          (VJ) so the iframe can't swallow mousemove/mouseup — that swallow was
          what left the resize "stuck" as if the mouse never released. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-row-resize" />}
      <div
        className="absolute inset-x-0 top-0 h-1.5 -mt-0.5 cursor-row-resize flex items-center justify-center group z-40"
        onMouseDown={(e) => {
          e.preventDefault();
          startY.current = e.clientY;
          startH.current = currentHeight;
          setDragging(true);
        }}
        title={title}
      >
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 group-hover:bg-purple-500/40 transition-colors" />
        <GripHorizontal className="w-3.5 h-3.5 text-zinc-700 group-hover:text-purple-300 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </>
  );
};

/**
 * Fullscreen, in the header's right cluster immediately left of Mobile. It
 * toggles browser fullscreen on `document.documentElement`, and its icon follows
 * `fullscreenchange`, so leaving with Esc flips it back too. A component of its
 * own so a fullscreen change re-renders this button, not the whole shell.
 */
const FullscreenToggle: React.FC = () => {
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== 'undefined' && document.fullscreenElement != null,
  );
  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  };
  return (
    <TopBarButton
      onClick={toggleFullscreen}
      icon={isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      title="Toggle fullscreen"
      ariaPressed={isFullscreen}
    />
  );
};

/**
 * Brand logo — references the SAME SVG that index.html wires up as
 * the browser-tab favicon (frontend/public/favicon.svg). Browser
 * caches it after the first paint so the header logo, the tab icon,
 * and any other site reference all stay byte-identical with no
 * inline duplication. The file is too detailed (2723×2723 viewBox,
 * ~40KB) to inline cheaply, hence the <img> reference.
 */
const BrandLogo: React.FC = () => (
  <img
    src="/favicon.svg?v=4"
    alt="theDAW logo"
    className="w-7 h-7 shrink-0 rounded-md shadow-[0_0_12px_rgba(124,58,237,0.35)]"
    draggable={false}
  />
);
