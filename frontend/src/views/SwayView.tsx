/**
 * SWAY tab -- the embedded SwayCommand cockpit plus theDAW's own Sway plumbing.
 *
 * SwayCommand (github.com/danieljtrujillo/SwayCommand) is a standalone Electron
 * app. Its renderer also builds as a plain static bundle, which theDAW's backend
 * serves at /sway-app and this view shows in an iframe -- the same shape as the
 * VJ tab, and for the same reasons: one origin, no Node on the target machine,
 * identical behaviour packaged and in Docker.
 *
 * Three things here are load-bearing rather than stylistic:
 *
 *   1. The iframe src is RELATIVE ('/sway-app/'), not an absolute backend URL.
 *      Chromium throttles a cross-origin hidden iframe to zero rAF callbacks,
 *      and SwayCommand's transport clock runs on rAF -- so a cross-origin embed
 *      freezes its timeline the moment the user switches tabs. Relative also
 *      keeps Web MIDI attribution and storage on theDAW's own origin.
 *
 *   2. The trailing slash is required. Without it the document base is '/' and
 *      the cockpit's relative asset loads (its AudioWorklet in particular)
 *      resolve against theDAW's root and 404.
 *
 *   3. Visibility must be pushed to the child. DAWCenterPanel warms a tab and
 *      then never unmounts it, so effect cleanups here never run on tab switch.
 *      Without an explicit visible:false the cockpit renders WebGL at full rate
 *      for the rest of the session behind whatever tab you are actually using.
 *
 * theDAW owns the only navigator.requestMIDIAccess() in the app (see App.tsx);
 * hardware reaches the cockpit by relay over postMessage, never by the iframe
 * opening its own MIDI access.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { subscribeToMidi } from '../state/midiBus';
import { getAnalyser } from '../state/playerStore';
import { logError, logInfo, logWarn } from '../state/logStore';
import { describeHttpError } from '../lib/httpError';
import { basenameOf, dirnameOf, isLocalClient, type PlaceItem } from '../lib/placesClient';
import { pickFile } from '../lib/storageClient';
import { GAN_FILTER } from '../lib/fileFilters';
import { openSwayScene, openSwaySceneFromPath } from '../lib/swayOpen';
import {
  CAP_HOST_HEADER,
  cockpitAction,
  hardwareStatus,
  hostCapsFor,
  hostScenesFrame,
  loadSceneLists,
  pluginFileFrame,
  scenesUnreadable,
  type HardwareTone,
  type HostAudioSource,
  type SwaySceneRow,
} from '../lib/swayHost';
import { handSwayHostApi } from '../lib/swayHostFx';
import { SWAY_VST_ENTRY_PREFIX, swayHostVstApi } from '../lib/swayHostVst';
import { HostedVstWindow } from '../components/audio/HostedVstWindow';
import { useMidiDevicesStore } from '../state/midiDevicesStore';
import { useMidiTriggerStore } from '../state/midiTriggerStore';
import { useStatusBarStore } from '../state/statusBarStore';
import { useSwayOpenStore } from '../state/swayOpenStore';
import { SwayTrackMenu, type SwayTrackLoad, type SwayTrackMenuRequest } from '../components/sway/SwayTrackMenu';

/** Where the cockpit is mounted. Must match backend/modules/sway/sidecar.py. */
const SWAY_SRC = '/sway-app/';

/** The template the cockpit boots into when the user has no saved project. */
const DEFAULT_TEMPLATE = 'will-i-dream';

/**
 * The iframe URL, with `?autoplay=` so the cockpit boots STRAIGHT into a
 * loaded project. This is load-bearing, not cosmetic: without a loaded
 * project the cockpit's + TRACK button and transport are silent no-ops
 * (its addTrack/play guard on a null timeline), and without the autoplay
 * param its boot shows the SYSTEM splash modal over the deck. The cockpit
 * shares theDAW's localStorage (same origin), so the most recent
 * cockpit-saved project (`swayproject:/` paths resolve from
 * localStorage['sway:projects']) wins over the default template; transient
 * `swaydrop:/` handles die on reload and are skipped.
 *
 * An explicit `requested` target (a scene opened through openSwayScene) boots
 * the cockpit into that project.
 */
function swayBootSrc(requested?: string | null): string {
  let target: string = requested || DEFAULT_TEMPLATE;
  if (!requested) {
    try {
      const recents = JSON.parse(window.localStorage.getItem('sway:recents') ?? '[]') as Array<{ path?: string }>;
      const saved = Array.isArray(recents)
        ? recents.find((r) => typeof r?.path === 'string' && r.path.startsWith('swayproject:/'))
        : null;
      if (saved?.path) target = saved.path;
    } catch {
      /* unreadable recents — boot the default template */
    }
  }
  return `${SWAY_SRC}?autoplay=${encodeURIComponent(target)}`;
}

const SCENE_MENU_ID = 'sway-open-scene';

const SWAY_FILE_FILTER = 'SwayCommand scene (*.sway)|*.sway|All files (*.*)|*.*';

interface SceneEntry {
  key: string;
  label: string;
  detail: string | null;
  title: string;
  action: boolean;
  choose: () => void;
}

interface SceneGroup {
  key: string;
  /** Null for the row that closes the list without a heading. */
  label: string | null;
  entries: SceneEntry[];
}

const OPEN_FAILED = 'SCENE OPEN FAILED: ';

/** The reason a scene open just wrote to the status bar. openSwayScene and
 *  openSwaySceneFromPath write it there before they resolve false. */
function lastOpenFailure(): string {
  const text = useStatusBarStore.getState().text;
  return text.startsWith(OPEN_FAILED) ? text.slice(OPEN_FAILED.length) : 'The scene could not be opened.';
}

/** Opens a .sway file picked in the native dialog. A failure is logged, shown
 *  in the status bar and returned; a cancel or an open returns null. */
async function chooseSceneFile(): Promise<string | null> {
  try {
    const picked = await pickFile({ kind: 'sway', filter: SWAY_FILE_FILTER });
    if (picked.cancelled || !picked.path) return null;
    if (!/\.sway$/i.test(picked.path)) {
      const msg = 'Choose a file that ends in .sway.';
      logWarn('sway', msg);
      useStatusBarStore.getState().setText(`${OPEN_FAILED}${msg}`);
      return msg;
    }
    return (await openSwaySceneFromPath(picked.path)) ? null : lastOpenFailure();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('sway', `Could not choose a scene file: ${msg}`);
    useStatusBarStore.getState().setText(`${OPEN_FAILED}${msg}`);
    return msg;
  }
}

/** Answers the cockpit's sway/choose-plugin-file: the .gan picked in the
 *  native dialog (the same pick MIX's Open a .gan uses), a cancel, or why no
 *  file could be picked. Logged either way; the cockpit shows the failure. */
async function choosePluginFile(): Promise<ReturnType<typeof pluginFileFrame>> {
  if (!isLocalClient()) {
    const msg = 'A .gan file can be chosen only on the computer theDAW runs on.';
    logWarn('sway', msg);
    return pluginFileFrame(null, msg);
  }
  try {
    const frame = pluginFileFrame(await pickFile({ kind: 'gan', filter: GAN_FILTER, title: 'Open a .gan plugin' }));
    if (frame.failure) logWarn('sway', frame.failure);
    else if (frame.path) logInfo('sway', `${frame.name} sent to the SWAY cockpit's plugin panel`);
    return frame;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('sway', `Could not choose a .gan file: ${msg}`);
    return pluginFileFrame(null, msg);
  }
}

/**
 * "Open scene", in three parts:
 *   - the .sway scenes under data/sway-projects, the Gantasmo scenes the asset
 *     catalog installed first and then the user's saves, each newest first,
 *     opened by name through openSwayScene;
 *   - .sway files elsewhere that known places can serve (a Save a copy, a
 *     cockpit save that was downloaded), opened by path;
 *   - on the machine the backend runs on, a row that picks a .sway file in the
 *     native dialog.
 * The lists are read each time the menu opens, so a scene saved, installed or
 * downloaded a moment ago is already in it.
 */
const SceneMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SwaySceneRow[] | null>(null);
  const [files, setFiles] = useState<PlaceItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusPendingRef = useRef(false);
  const seqRef = useRef(0);
  const listId = `${SCENE_MENU_ID}-listbox`;

  const close = useCallback((restoreFocus: boolean) => {
    seqRef.current += 1;
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    const seq = ++seqRef.current;
    setOpen(true);
    setActiveIdx(0);
    setRows(null);
    setFiles([]);
    setError(null);
    focusPendingRef.current = true;
    // The cockpit's own scene list reads the same lists, in the same order.
    void loadSceneLists().then((lists) => {
      if (seq !== seqRef.current) return;
      setFiles(lists.recent);
      setError(lists.error);
      setRows(lists.rows);
    });
  };

  // Move focus into the list once it is read, so arrow keys work at once.
  useEffect(() => {
    if (!open || !rows || !focusPendingRef.current) return;
    focusPendingRef.current = false;
    optionRefs.current[0]?.focus({ preventScroll: true });
  }, [open, rows]);

  // Escape, a click outside, or a click into the cockpit closes it. A click in
  // the iframe never reaches this window as a mousedown; the window blurs.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node && wrapRef.current?.contains(e.target))) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onBlur = () => close(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close]);

  const sceneEntry = (row: SwaySceneRow): SceneEntry => ({
    key: `scene:${row.path}`,
    label: row.name,
    detail: new Date(row.mtime * 1000).toLocaleString(),
    title: row.path,
    action: false,
    choose: () => void openSwayScene(row.name),
  });

  // rows arrive already ordered, so each group keeps its newest-first order.
  const groups: SceneGroup[] = rows
    ? [
        { key: 'gantasmo', label: 'Gantasmo', entries: rows.filter((r) => r.builtin).map(sceneEntry) },
        { key: 'saved', label: 'Saved', entries: rows.filter((r) => !r.builtin).map(sceneEntry) },
        {
          key: 'recent',
          label: 'Recent',
          entries: files.map((it) => ({
            key: `file:${it.path}`,
            label: it.name || basenameOf(it.path),
            detail: dirnameOf(it.path),
            title: it.path,
            action: false,
            choose: () => void openSwaySceneFromPath(it.path),
          })),
        },
        {
          key: 'choose',
          label: null,
          // The native dialog opens on the backend's machine, so a browser on
          // another device gets no row for it.
          entries: isLocalClient()
            ? [
                {
                  key: 'choose-file',
                  label: 'Choose a .sway file',
                  detail: null,
                  title: 'Opens a .sway file you choose and loads it.',
                  action: true,
                  choose: () => void chooseSceneFile(),
                },
              ]
            : [],
        },
      ].filter((g) => g.entries.length > 0)
    : [];
  const entries = groups.flatMap((g) => g.entries);

  const choose = (entry: SceneEntry) => {
    close(false);
    entry.choose();
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const n = entries.length;
    if (!n) return;
    const current = Math.min(activeIdx, n - 1);
    let next = -1;
    if (e.key === 'ArrowDown') next = (current + 1) % n;
    else if (e.key === 'ArrowUp') next = (current - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    setActiveIdx(next);
    const el = optionRefs.current[next];
    el?.focus();
    // The first option of a group brings its heading into view with it.
    const heading = el?.previousElementSibling;
    if (heading?.getAttribute('role') === 'presentation') heading.scrollIntoView({ block: 'nearest' });
  };

  const loaded = rows !== null;
  const active = Math.min(activeIdx, Math.max(0, entries.length - 1));
  optionRefs.current.length = entries.length;
  const emptyNote = !loaded
    ? null
    : error
      ? scenesUnreadable(error)
      : rows.length === 0 && files.length === 0
        ? 'No scenes are saved yet.'
        : null;

  const option = (entry: SceneEntry, i: number) => (
    <button
      key={entry.key}
      ref={(el) => {
        optionRefs.current[i] = el;
      }}
      id={`${SCENE_MENU_ID}-opt-${i}`}
      type="button"
      role="option"
      aria-selected={i === active}
      tabIndex={i === active ? 0 : -1}
      onFocus={() => setActiveIdx(i)}
      onClick={() => choose(entry)}
      title={entry.title}
      // No border of its own: index.css gives a bordered button the control
      // contrast floor, which would draw every row line brighter than the
      // group lines. The headings and group borders separate the list.
      className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-fuchsia-500/15 focus:outline-none focus-visible:bg-fuchsia-500/15"
    >
      {entry.action ? (
        <span className="flex max-w-full items-center gap-1.5 text-sm font-semibold text-fuchsia-200">
          <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {entry.label}
        </span>
      ) : (
        <span className="max-w-full truncate text-sm font-semibold text-zinc-100">{entry.label}</span>
      )}
      {entry.detail && <span className="max-w-full truncate text-xs font-semibold text-zinc-400">{entry.detail}</span>}
    </button>
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        id={SCENE_MENU_ID}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && entries.length > 0 ? listId : undefined}
        title="Lists saved and recent scenes and loads the one you choose."
        className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-black/40 px-1.5 py-0 text-xs font-semibold leading-4.5 text-zinc-200 outline-none hover:border-fuchsia-500/50 focus-visible:border-fuchsia-500/50"
      >
        <FolderOpen className="h-3 w-3 text-fuchsia-300" />
        Open scene
        <ChevronDown className="h-3 w-3 text-zinc-400" />
      </button>
      {open && (
        // The bar keeps its readouts on one line; notes in the menu wrap.
        <div className="absolute left-0 top-full z-20 mt-1 min-w-64 max-w-sm whitespace-normal rounded border border-fuchsia-500/30 bg-[#0a080f] shadow-2xl">
          {!loaded ? (
            <p role="status" className="flex items-center gap-1.5 px-2 py-2 text-xs font-semibold text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the saved scenes…
            </p>
          ) : (
            <>
              {emptyNote && (
                <p
                  role="status"
                  className="border-b border-white/5 px-2 py-2 text-xs font-semibold leading-relaxed text-zinc-400"
                >
                  {emptyNote}
                </p>
              )}
              {entries.length > 0 && (
                <div
                  id={listId}
                  role="listbox"
                  aria-label="Scenes"
                  onKeyDown={onListKeyDown}
                  className="flex max-h-120 flex-col overflow-y-auto"
                >
                  {groups.map((group) => {
                    const start = entries.indexOf(group.entries[0]);
                    const options = group.entries.map((entry, j) => option(entry, start + j));
                    if (group.label === null) return <React.Fragment key={group.key}>{options}</React.Fragment>;
                    // A listbox may own groups of options; each group is named
                    // by its heading, which is not an option itself.
                    const labelId = `${SCENE_MENU_ID}-group-${group.key}`;
                    return (
                      <div
                        key={group.key}
                        role="group"
                        aria-labelledby={labelId}
                        className="flex flex-col border-b border-white/10 last:border-b-0"
                      >
                        <div
                          id={labelId}
                          role="presentation"
                          className="px-2 pb-1 pt-2 font-display text-xs font-bold uppercase tracking-wider text-zinc-400"
                        >
                          {group.label}
                        </div>
                        {options}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

/** Wire-protocol version for every frame exchanged with the cockpit. */
const PROTOCOL = 1;

/** Analysis frames per second pushed to the cockpit. It smooths internally. */
const ANALYSIS_HZ = 30;

type EmbedState = 'checking' | 'ready' | 'unavailable' | 'error';

/**
 * What drives the cockpit's visuals. theDAW's master is the reason to embed at
 * all -- the visuals react to what you are actually making. An input device is
 * what standalone does, kept here for performing to an external source.
 */
type AudioSource = HostAudioSource;

const HARDWARE_TONE_CLASS: Record<HardwareTone, string> = {
  off: 'text-amber-400',
  none: 'text-zinc-400',
  ok: 'text-emerald-400',
};

interface SwayUrlResponse {
  url: string | null;
  mode: string;
  detail?: string | null;
  build?: { sha?: string; builtAt?: string; version?: string } | null;
}

export const SwayView: React.FC = () => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** A track the cockpit reported a right-click on, until the menu closes. */
  const [trackMenu, setTrackMenu] = useState<SwayTrackMenuRequest | null>(null);
  const [embedState, setEmbedState] = useState<EmbedState>('checking');
  const [detail, setDetail] = useState<string | null>(null);
  const [build, setBuild] = useState<SwayUrlResponse['build']>(null);
  const [audioSource, setAudioSource] = useState<AudioSource>('thedaw');
  const [childReady, setChildReady] = useState(false);
  // What the cockpit said it can do in its last sway/ready. Cleared with
  // childReady, so a reloading cockpit shows theDAW's bar until it says hello.
  const [caps, setCaps] = useState<string[]>([]);

  // Readiness is a ref, not just state: the analysis and MIDI loops read it on
  // every frame and a state value captured in a closure would be stale.
  const readyRef = useRef(false);
  // Frames posted before the cockpit says hello are queued, not dropped -- the
  // handshake and the first MIDI event can race.
  const pendingRef = useRef<Record<string, unknown>[]>([]);
  // Bumped for every open request, which mounts a new iframe, so an answer read
  // for the old cockpit is never posted to the new one. The load event does not
  // bump it: that fires after the cockpit's first hello, and a scene request
  // sent at boot must still be answered.
  const frameGenRef = useRef(0);

  const post = useCallback((payload: Record<string, unknown>) => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    if (!readyRef.current) {
      // Bounded: a cockpit that never reports ready must not grow this forever.
      if (pendingRef.current.length < 128) pendingRef.current.push(payload);
      return;
    }
    try {
      w.postMessage(payload, window.location.origin);
    } catch {
      /* mid-navigation; the next frame retries */
    }
  }, []);

  // --- which project the cockpit boots into ---------------------------------
  // The cockpit reads its boot project only from its URL, so the src is fixed
  // per open request and per probe. Reading recents on every render would
  // change the src, and reload the cockpit, each time the cockpit saved a
  // project.
  //
  // Every probe (the first one and each Retry) bumps `rev`, so an iframe
  // mounted after it reads recents again. An open request boots its scene
  // until a probe runs after it; openSwayScene also put that scene at the top
  // of recents, so the read after a Retry still finds it unless the cockpit
  // has since loaded or saved another project.
  const openRequest = useSwayOpenStore((s) => s.request);
  const [probeMark, setProbeMark] = useState<{ rev: number; nonce: number | null }>({
    rev: 0,
    nonce: null,
  });
  const requestedTarget =
    openRequest && openRequest.nonce !== probeMark.nonce ? openRequest.target : null;
  const bootSrc = useMemo(
    () => swayBootSrc(requestedTarget),
    // probeMark.rev is read by swayBootSrc through localStorage, not as a value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestedTarget, probeMark.rev],
  );
  // Keyed on the nonce, so a second request for the same scene reloads too.
  const frameKey = openRequest?.nonce ?? 0;

  // A new request mounts a new iframe. Its document has not said hello, and
  // frames queued for the old one do not apply to it.
  useEffect(() => {
    if (!openRequest) return;
    readyRef.current = false;
    pendingRef.current = [];
    frameGenRef.current += 1;
    setChildReady(false);
    setCaps([]);
  }, [openRequest]);

  // --- is there a build to show? -------------------------------------------
  const probe = useCallback(async () => {
    // The next iframe reads recents again; a request already booted gives way.
    setProbeMark((p) => ({
      rev: p.rev + 1,
      nonce: useSwayOpenStore.getState().request?.nonce ?? null,
    }));
    setEmbedState('checking');
    try {
      const res = await fetch('/api/sway/url');
      if (!res.ok) {
        setEmbedState('error');
        // "GET /api/sway/url returned HTTP 502." named the request and hid the
        // cause. /api/sway/url never returns 502 -- that status comes from a
        // hop in FRONT of the backend (the packaged app's proxy, or Vite's),
        // meaning the backend was unreachable rather than the cockpit missing.
        // describeHttpError says which hop failed and what to do about it.
        setDetail(await describeHttpError(res));
        return;
      }
      const data = (await res.json()) as SwayUrlResponse;
      if (!data.url) {
        setEmbedState('unavailable');
        setDetail(data.detail ?? 'No SwayCommand build is staged.');
        return;
      }
      setBuild(data.build ?? null);
      setDetail(null);
      setEmbedState('ready');
    } catch (err) {
      setEmbedState('error');
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  // --- scene list for a cockpit that shows it ------------------------------
  // The same lists "Open scene" reads. `failure` is a message the cockpit shows
  // in place of theDAW's bar, which is hidden while it hosts the controls; the
  // caller has logged it. A saved-scene read error is logged here.
  const sendScenes = useCallback(
    async (failure: string | null) => {
      const gen = frameGenRef.current;
      const lists = await loadSceneLists();
      if (gen !== frameGenRef.current) return;
      if (lists.error) logWarn('sway', scenesUnreadable(lists.error));
      post({ type: 'sway/host-scenes', v: PROTOCOL, ...hostScenesFrame(lists, failure) });
    },
    [post],
  );

  // --- handshake and cockpit requests ---------------------------------------
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Two guards, both required: the right window AND the right origin. The
      // cockpit is same-origin, so asserting it costs nothing and shuts out any
      // other frame on the page.
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.origin !== window.location.origin) return;
      const action = cockpitAction(e.data);
      if (!action) return;

      switch (action.kind) {
        case 'ready': {
          readyRef.current = true;
          setChildReady(true);
          setCaps(action.caps);
          logInfo(
            'sway',
            `SwayCommand cockpit reported ready${action.caps.length ? ` (${action.caps.join(', ')})` : ''}`,
          );
          const queued = pendingRef.current;
          pendingRef.current = [];
          // The host API goes onto the cockpit's window first, so a cockpit
          // that reads 'rack-fx' or 'vst-live' in the caps finds it there.
          const rackFx = handSwayHostApi(iframeRef.current?.contentWindow);
          post({ type: 'sway/host-ready', v: PROTOCOL, host: 'theDAW', caps: hostCapsFor(rackFx, swayHostVstApi.available()) });
          for (const frame of queued) post(frame);
          break;
        }
        case 'set-audio-source':
          // The audio effect below answers with sway/audio-source.
          setAudioSource(action.source);
          break;
        case 'request-scenes':
          void sendScenes(null);
          break;
        case 'open-scene': {
          // A scene that opens reloads the cockpit, so only a failure answers.
          const opening =
            action.name !== null ? openSwayScene(action.name) : openSwaySceneFromPath(action.path ?? '');
          void opening.then((ok) => {
            if (!ok) void sendScenes(lastOpenFailure());
          });
          break;
        }
        case 'track-menu': {
          // The cockpit's point is inside its frame; the menu opens in this window.
          const rect = iframeRef.current?.getBoundingClientRect();
          setTrackMenu({
            trackId: action.trackId,
            name: action.name,
            empty: action.empty,
            x: (rect?.left ?? 0) + action.x,
            y: (rect?.top ?? 0) + action.y,
          });
          break;
        }
        case 'choose-scene-file': {
          if (!isLocalClient()) {
            const msg = 'A .sway file can be chosen only on the computer theDAW runs on.';
            logWarn('sway', msg);
            void sendScenes(msg);
            break;
          }
          void chooseSceneFile().then((failure) => {
            if (failure) void sendScenes(failure);
          });
          break;
        }
        case 'choose-plugin-file': {
          // Every outcome answers, so the cockpit's LOAD chooser never waits
          // on a dialog that already closed.
          const gen = frameGenRef.current;
          void choosePluginFile().then((frame) => {
            if (gen === frameGenRef.current) post({ ...frame, v: PROTOCOL });
          });
          break;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post, sendScenes]);

  // A reloaded iframe has not said hello yet; re-gate until it does.
  const handleIframeLoad = useCallback(() => {
    readyRef.current = false;
    setChildReady(false);
    setCaps([]);
  }, []);

  // --- visibility: this tab is warmed and never unmounted -------------------
  const [docVisible, setDocVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // This view only renders inside DAWCenterPanel's warm block, which hides it
  // with display:none rather than unmounting. An IntersectionObserver would
  // report nothing useful for a display:none subtree, so ask the element.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const check = () => setTabVisible(el.offsetParent !== null);
    check();
    const id = window.setInterval(check, 500);
    return () => window.clearInterval(id);
  }, []);

  const active = docVisible && tabVisible;

  useEffect(() => {
    post({ type: 'sway/visibility', v: PROTOCOL, visible: active });
  }, [active, childReady, post]);

  // --- MIDI relay -----------------------------------------------------------
  // theDAW holds the only MIDIAccess. Relaying raw bytes means the cockpit's
  // own decoding, its factory map and its learned overrides all apply
  // unchanged, with no duplicated semantics on this side.
  useEffect(() => {
    if (embedState !== 'ready') return;
    return subscribeToMidi((msg) => {
      if (!readyRef.current || !active) return;
      post({ type: 'sway/midi', v: PROTOCOL, data: msg.data, t: msg.t });
    });
  }, [embedState, active, post]);

  // --- audio analysis -------------------------------------------------------
  // childReady is a dependency so a cockpit reloaded into another scene is told
  // its audio source again once it says hello.
  useEffect(() => {
    if (embedState !== 'ready') return;
    if (audioSource !== 'thedaw') {
      // The cockpit opens its own input device in this mode; tell it to.
      post({ type: 'sway/audio-source', v: PROTOCOL, source: 'input' });
      return;
    }
    post({ type: 'sway/audio-source', v: PROTOCOL, source: 'host' });
    if (!active) return;

    let raf = 0;
    let lastPost = 0;
    const postDt = 1000 / ANALYSIS_HZ;
    let analyser: AnalyserNode;
    try {
      analyser = getAnalyser();
    } catch (err) {
      logWarn('sway', `analysis bridge unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const lowEnd = Math.floor(buf.length * 0.05);
    const midEnd = Math.floor(buf.length * 0.3);
    const SPEC_BINS = 256;
    const specBlock = Math.max(1, Math.floor(buf.length / SPEC_BINS));
    const spec = new Array<number>(SPEC_BINS);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!readyRef.current) return;
      const now = performance.now();
      if (now - lastPost < postDt) return;
      lastPost = now;
      analyser.getByteFrequencyData(buf);
      let bassSum = 0;
      let midSum = 0;
      let highSum = 0;
      for (let i = 0; i < lowEnd; i++) bassSum += buf[i];
      for (let i = lowEnd; i < midEnd; i++) midSum += buf[i];
      for (let i = midEnd; i < buf.length; i++) highSum += buf[i];
      for (let i = 0; i < SPEC_BINS; i++) {
        let sum = 0;
        const start = i * specBlock;
        for (let j = 0; j < specBlock; j++) sum += buf[start + j] ?? 0;
        spec[i] = sum / specBlock / 255;
      }
      post({
        type: 'sway/analysis',
        v: PROTOCOL,
        bass: lowEnd > 0 ? bassSum / lowEnd / 255 : 0,
        mid: midEnd - lowEnd > 0 ? midSum / (midEnd - lowEnd) / 255 : 0,
        high: buf.length - midEnd > 0 ? highSum / (buf.length - midEnd) / 255 : 0,
        volume: (bassSum + midSum + highSum) / (buf.length * 255),
        spectrum: spec,
        t: now,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [embedState, audioSource, active, childReady, post]);

  const buildLabel = useMemo(() => {
    if (!build) return null;
    const sha = build.sha ? build.sha.slice(0, 7) : null;
    return [build.version, sha].filter(Boolean).join(' @ ') || null;
  }, [build]);

  // What is ACTUALLY hooked up, from the host's own MIDIAccess — the cockpit
  // can only ever say "theDAW (relayed)" because raw bytes are relayed to it,
  // so the real device names have to be surfaced on this side. midiEnabled
  // matters too: with the master gate off there IS no relay, and saying
  // "linked" while hardware is silently ignored is exactly the kind of lie
  // this header used to tell.
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);
  const midiInputs = useMidiDevicesStore((s) => s.inputs);
  const { hardware: hardwareLabel, tone: hardwareTone } = useMemo(
    () => hardwareStatus(midiEnabled, midiInputs),
    [midiEnabled, midiInputs],
  );

  // The cockpit's header shows the same line when it hosts theDAW's controls.
  // childReady re-sends it to a cockpit that reloaded.
  useEffect(() => {
    post({ type: 'sway/host-status', v: PROTOCOL, hardware: hardwareLabel, tone: hardwareTone });
  }, [hardwareLabel, hardwareTone, childReady, post]);

  // A cockpit that reports 'host-header' shows these controls in its own
  // header, so theDAW's bar steps aside. Every other state keeps the bar:
  // checking, an error, a cockpit still loading, and a build without the cap.
  const hostHeader = embedState === 'ready' && childReady && caps.includes(CAP_HOST_HEADER);

  // The bar's build label has no place in the cockpit's header; the log keeps it.
  useEffect(() => {
    if (hostHeader && buildLabel) logInfo('sway', `SwayCommand build ${buildLabel} shows theDAW's controls in its header`);
  }, [hostHeader, buildLabel]);

  return (
    <div ref={hostRef} className="absolute inset-0 flex bg-black font-sans">
      {/* The SWAY tab is the SwayCommand cockpit, nothing else. theDAW's own
          Sway rail (routing selects, per-dim learn rows, the MIDI enable
          button) used to sit alongside it and duplicated what the cockpit
          already does properly. Its plumbing is unchanged and still feeds
          PERFORM — only the redundant UI is gone. */}
      <div className="relative min-w-0 grow">
        {!hostHeader && (
          <div data-tour="sway-bar" className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 whitespace-nowrap border-b border-white/10 bg-black/70 px-2 py-1 backdrop-blur">
            <span className="font-display text-sm font-extrabold uppercase leading-none tracking-wider text-fuchsia-200">
              SwayCommand
            </span>

            <label htmlFor="sway-audio-source" className="ml-3 text-xs font-semibold uppercase leading-none tracking-wider text-zinc-400">
              Audio
            </label>
            <select
              id="sway-audio-source"
              name="sway-audio-source"
              value={audioSource}
              onChange={(e) => setAudioSource(e.target.value as AudioSource)}
              className="rounded border border-zinc-800 bg-black/40 px-1.5 py-0 text-xs font-semibold leading-4.5 text-zinc-200 outline-none focus:border-fuchsia-500/50"
            >
              <option value="thedaw">theDAW master</option>
              <option value="input">Input device</option>
            </select>

            <SceneMenu />

            <span className={`ml-auto text-xs font-semibold leading-none ${HARDWARE_TONE_CLASS[hardwareTone]}`}>{hardwareLabel}</span>
            <span className="text-xs font-semibold leading-none text-zinc-500">
              · {embedState === 'ready' ? (childReady ? 'linked' : 'loading…') : embedState}
              {buildLabel ? ` · ${buildLabel}` : ''}
            </span>
          </div>
        )}

        {/* A cockpit track's plugin opens its own window here. */}
        <HostedVstWindow entryPrefix={SWAY_VST_ENTRY_PREFIX} ownerTab="sway" />
        <SwayTrackMenu
          request={trackMenu}
          onClose={() => setTrackMenu(null)}
          onLoad={(load: SwayTrackLoad) => {
            post({ type: 'sway/load-audio', v: PROTOCOL, trackId: load.trackId, path: load.url, name: load.name });
            logInfo('sway', `${load.name} sent to ${load.trackId ? 'the clicked SWAY track' : 'an empty SWAY track'}`);
          }}
        />
        {embedState === 'ready' ? (
          <iframe
            key={frameKey}
            ref={iframeRef}
            src={bootSrc}
            title="SwayCommand"
            onLoad={handleIframeLoad}
            // midi: the cockpit's own learn UI reads relayed frames, but the
            // permissions policy must still allow it for any direct use.
            // microphone: the 'Input device' audio source.
            allow="midi; microphone; autoplay; fullscreen"
            // The tour's SWAY step points at the bar; with the bar hidden the
            // cockpit's header holds those controls, so the step points here.
            data-tour={hostHeader ? 'sway-bar' : undefined}
            className={`absolute inset-0 h-full w-full border-0 bg-black ${hostHeader ? '' : 'pt-6'}`}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 pt-6 text-center">
            {embedState === 'checking' ? (
              <span className="font-display text-sm font-bold uppercase tracking-wider text-zinc-400">
                Looking for a SwayCommand build…
              </span>
            ) : (
              <>
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                <p className="max-w-lg text-sm font-semibold leading-relaxed text-zinc-200">
                  {detail ?? 'The SwayCommand cockpit is not available.'}
                </p>
                <p className="max-w-lg text-sm font-semibold leading-relaxed text-zinc-400">
                  SwayCommand also runs as its own desktop application; this tab embeds the same
                  cockpit inside theDAW.
                </p>
                <button
                  type="button"
                  onClick={() => void probe()}
                  className="mt-1 inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-zinc-200 hover:border-fuchsia-400/50 hover:text-fuchsia-200"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
