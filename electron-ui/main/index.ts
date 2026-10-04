import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  screen,
  session,
  shell,
} from 'electron'
import { ChildProcess, spawn, execFile } from 'child_process'
// Node's own net, under a name of its own: `net` in this file is ELECTRON's
// net module (the app:// protocol handler fetches through it).
import { connect as netConnect } from 'net'
import { autoUpdater } from 'electron-updater'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
// Every backend line is folded to plain ASCII before it reaches the LOG panel
// or the console. Python libraries print status with emoji -- basic-pitch does,
// and those lines used to raise UnicodeEncodeError on a Windows console running
// a legacy code page and take the conversion down with them. A glyph that
// carries meaning is transliterated rather than dropped, so a key of F-sharp
// still reads as F# in the log.
import { plainAscii } from '../../frontend/src/lib/plainText'
import { stopBackend } from './backendStop'
import { AutoDownloadClaims, uniqueDownloadPath } from './downloadNaming'
import { DialogFolderMemory, dialogDefaultPath, folderAfterDialog } from './dialogFolder'
import {
  lanHttpsLogLine,
  lanListenerCommand,
  lanListenerEnv,
  parseLanHttpsPlan,
  rendererDevPort,
  type LanHttpsPlan,
} from './lanHttps'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getRepoRoot(): string {
  if (app.isPackaged) {
    // In a packaged app, resources are at process.resourcesPath
    // The repo root concept doesn't apply the same way, but we keep
    // a reference for log directory placement next to the executable.
    return path.resolve(path.dirname(app.getPath('exe')))
  }
  // In dev: electron-vite transpiles to electron-ui/out/main/index.js
  // so __dirname = electron-ui/out/main. Three levels up = repo root.
  return path.resolve(__dirname, '..', '..', '..')
}

const repoRoot = getRepoRoot()

// theDAW's icon for every window's title bar and taskbar button. A packaged
// build has it baked into theDAW.exe, which Windows uses; the dev shell runs
// electron.exe, whose own icon showed until the window was handed this file.
const WINDOW_ICON = app.isPackaged ? undefined : path.join(__dirname, '..', '..', 'resources', 'icon.png')

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

// Guarded: on a read-only mount (AppImage squashfs, running a mac app straight
// off the dmg) an unguarded mkdirSync here killed the main process before any
// window existed. Fall back to Electron's per-user logs dir, then to a no-op
// stream so logging can never take the app down.
function openLogStream(): fs.WriteStream | null {
  for (const dir of [path.join(repoRoot, 'logs'), app.getPath('logs')]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const stream = fs.createWriteStream(path.join(dir, 'backend.log'), {
        flags: 'a',
      })
      // Disk-full or revoked-handle write errors surface as an 'error' event;
      // without a listener that event crashes the process.
      stream.on('error', () => {})
      return stream
    } catch {
      // try the next location
    }
  }
  return null
}

const logStream = openLogStream()

function log(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  try {
    logStream?.write(line)
  } catch {
    // never let logging take the app down
  }
}

// ---------------------------------------------------------------------------
// Backend management
// ---------------------------------------------------------------------------

let backendProcess: ChildProcess | null = null
let weSpawnedBackend = false
let isQuitting = false
// A backend that dies under a running window is brought back (see the exit
// handler in spawnBackend). Bounded, so a backend that cannot start is not
// respawned forever: at most this many times inside the window.
const BACKEND_RESPAWN_MAX = 5
const BACKEND_RESPAWN_WINDOW_MS = 10 * 60_000
// backend/run.py: another instance already owns the port. Respawning cannot help.
const BACKEND_PORT_IN_USE_EXIT_CODE = 90
let backendRespawnTimes: number[] = []
// First-run `uv sync` child; tracked so before-quit can kill it (an orphaned
// sync keeps downloading and holds the venv lock against the next launch).
let uvSyncProcess: ChildProcess | null = null

// 127.0.0.1, never 'localhost': the backend binds 0.0.0.0 (IPv4 only) and
// Chromium's resolver prefers ::1 for 'localhost' on Windows. When it does,
// every proxied /api/* call below fails to connect and the catch returns a
// synthetic 502 — which the renderer reported as "couldn't reach
// huggingface.co", sending users to debug their internet over a loopback
// mismatch. An address cannot resolve to the wrong family.
const BACKEND_BASE = 'http://127.0.0.1:8600'
const HEALTH_URL = `${BACKEND_BASE}/api/health`
const SHUTDOWN_URL = `${BACKEND_BASE}/api/admin/shutdown`

// A secret shared by this main process and the backend it spawns, and nothing
// else. It goes to the backend only through buildBackendEnv
// (THEDAW_LAUNCH_TOKEN) and comes back only on main-process requests
// (X-TheDAW-Launch-Token), so the backend can tell a request made here from one
// a page made. It is never put in process.env, sent over IPC or logged, so the
// renderer and preload have no way to read it. A backend this process did not
// spawn has no token and treats every request as coming from a page.
const LAUNCH_TOKEN = crypto.randomBytes(24).toString('hex')
const LAUNCH_TOKEN_HEADER = 'X-TheDAW-Launch-Token'

// ---------------------------------------------------------------------------
// Packaged-app paths + first-run bootstrap
//
// In a packaged build the Python project, a bundled uv.exe, and ffmpeg.exe ship
// under process.resourcesPath (see electron-builder.yml -> extraResources). In
// dev none of this applies: the backend runs from the repo via uv on PATH
// exactly as before.
//
// This used to assume the install directory was writable, because the NSIS
// config asks for a per-user install under %LOCALAPPDATA%\Programs\theDAW. But
// electron-builder.yml also sets allowToChangeInstallationDirectory, so a user
// can install into C:\Program Files\theDAW, and then NOTHING may be written
// beside the app. First run died on the very first step:
//
//   error: Failed to initialize cache at `.uv-cache`
//   Caused by: failed to create directory
//   `C:\Program Files\theDAW\resources\python\.uv-cache`: Access is denied.
//
// after which the backend exited 2 and every request answered 502. Three
// separate things wanted to write into the install directory: uv's package
// cache, the venv itself, and the backend's data/ tree. getWritableRuntimeDir
// decides once where all three go.
// ---------------------------------------------------------------------------

function getPythonDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'python') : repoRoot
}

/** Per-user base for anything large. Deliberately LOCAL app data, not roaming:
 *  the venv and uv's cache are several GB and a roaming profile syncs. */
function localAppDataRoot(): string {
  const local = process.env.LOCALAPPDATA
  if (process.platform === 'win32' && local) return path.join(local, 'theDAW')
  // app.getPath('userData') is already per-user and per-app everywhere else.
  return app.getPath('userData')
}

/** Can we actually create a file in `dir`? Probed, never inferred from ACLs:
 *  a directory can look writable and still refuse, and the reverse. */
function isWritableDir(dir: string): boolean {
  const probe = path.join(dir, `.thedaw-write-probe-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    try {
      fs.rmSync(probe, { force: true })
    } catch {
      /* nothing to clean up */
    }
    return false
  }
}

let cachedRuntimeDir: string | null = null

/**
 * Where the packaged app may write: uv's cache, the venv, the data tree.
 *
 * The install directory when that is writable, which keeps every existing
 * per-user install exactly as it was, venv included. Otherwise a per-user
 * directory, so a Program Files install works without elevation.
 */
function getWritableRuntimeDir(): string {
  if (!app.isPackaged) return repoRoot
  if (cachedRuntimeDir) return cachedRuntimeDir
  const pyDir = getPythonDir()
  if (isWritableDir(pyDir)) {
    cachedRuntimeDir = pyDir
  } else {
    const fallback = path.join(localAppDataRoot(), 'runtime')
    log(`Install directory is read-only (${pyDir}); using ${fallback} for the venv, cache and data.`)
    cachedRuntimeDir = fallback
  }
  return cachedRuntimeDir
}

/** True when the runtime had to move out of the install directory. */
function runtimeIsRelocated(): boolean {
  return app.isPackaged && getWritableRuntimeDir() !== getPythonDir()
}

function getToolsDir(): string {
  return path.join(process.resourcesPath, 'tools')
}

function getUvCommand(): string {
  if (!app.isPackaged) return 'uv'
  // Packaged builds bundle the uv binary under resources/tools: 'uv.exe' on
  // Windows, 'uv' on macOS (see scripts/fetch-runtime-tools.mjs).
  return path.join(
    getToolsDir(),
    process.platform === 'win32' ? 'uv.exe' : 'uv',
  )
}

/** The venv root. Beside the project when the install dir is writable, in the
 *  per-user runtime dir when it is not. uv is pointed at it with
 *  UV_PROJECT_ENVIRONMENT (buildBaseEnv), which relocates the environment
 *  without moving the project. */
function getVenvDir(): string {
  return path.join(getWritableRuntimeDir(), '.venv')
}

function venvPython(venvRoot: string): string {
  return process.platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python')
}

// Environment for every process this main process starts. Packaged builds
// prepend the bundled tools dir (uv.exe, ffmpeg.exe, ffprobe.exe) to PATH so the
// backend's audio I/O resolves ffmpeg without a system install. The PATH key is
// matched case-insensitively because Windows exposes it as "Path".
//
// It carries no launch token. uv sync runs package build scripts, so a
// THEDAW_LAUNCH_TOKEN inherited from the launching shell is removed under every
// spelling: Windows environment names ignore case.
function buildBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SA3_SUPERVISOR_PRESENT: '1' }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'THEDAW_LAUNCH_TOKEN') delete env[key]
  }
  if (app.isPackaged) {
    const toolsDir = getToolsDir()
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    env[key] = `${toolsDir}${path.delimiter}${env[key] ?? ''}`
  }
  // Keep uv's package cache on the SAME volume as the venv (getPythonDir()) so
  // wheels hardlink into .venv on first-run sync instead of falling back to
  // slow full copies. uv cannot hardlink across volumes, and its default cache
  // lives on the system drive — which may differ from the drive the app is
  // installed on (or the repo lives on in dev). Same-volume cache = fast setup,
  // no "failed to hardlink" fallback, less disk. This also reaches any uv the
  // backend itself invokes (e.g. the on-demand Underfit trainer env). An
  // explicit UV_CACHE_DIR (e.g. from theDAW.bat's dev/web launch) is respected.
  const cacheKey = Object.keys(env).find((k) => k.toLowerCase() === 'uv_cache_dir')
  if (!cacheKey) env.UV_CACHE_DIR = path.join(getWritableRuntimeDir(), '.uv-cache')
  if (runtimeIsRelocated()) {
    // The install directory is read-only, so neither the venv nor anything the
    // backend persists can live beside the project. Both honour an env var, and
    // an explicit value from the caller still wins.
    if (!env.UV_PROJECT_ENVIRONMENT) env.UV_PROJECT_ENVIRONMENT = getVenvDir()
    // theDAW_DATA_DIR moves the backend's WHOLE writable tree at once --
    // settings.json, every registry, the caches, the library, sidecar logs.
    // backend/lib/paths.py is the single resolver; pointing only the library
    // elsewhere still left /api/settings answering 500 on first launch, because
    // SettingsStore went on trying to mkdir <install>/data. A user-set
    // theDAW_GENERATIONS_DIR still moves the library on its own.
    if (!env.theDAW_DATA_DIR) {
      env.theDAW_DATA_DIR = path.join(getWritableRuntimeDir(), 'data')
    }
  }
  return env
}

// The backend's environment: the base plus this process's launch token, which
// the download hook sends back. Only spawnBackend uses it. The backend starts
// its own children with child_env (backend/lib/launch_token.py), which leaves
// the token out.
function buildBackendEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...buildBaseEnv(), THEDAW_LAUNCH_TOKEN: LAUNCH_TOKEN }
  // Tell the backend the port the renderer's dev server actually got (5173,
  // strictPort in electron.vite.config.ts); /api/network/lan reports it
  // (backend.ports.frontend_port). A packaged build has no dev server and the
  // backend keeps its default.
  const rendererPort = rendererDevPort(process.env.ELECTRON_RENDERER_URL)
  if (rendererPort) env.theDAW_FRONTEND_PORT = String(rendererPort)
  // Live VST host: a packaged build may ship the exe under resourcesPath (see
  // electron-builder.yml's win.extraResources, staged by
  // scripts/stage-vst-host.mjs). Point the backend's HostLocator at it unless
  // the user (or a wrapping launcher) already set THEDAW_VST_HOST -- checked
  // case-insensitively like the PATH lookup above, since Windows env names
  // aren't case-sensitive. Only set it when the exe is actually there: the
  // native host doesn't ship on every platform/build, and HostLocator treats
  // an explicit env var as an unconditional path, not a hint.
  if (app.isPackaged) {
    const hasVstHostEnv = Object.keys(env).some((k) => k.toUpperCase() === 'THEDAW_VST_HOST')
    if (!hasVstHostEnv) {
      const vstHostExe = path.join(process.resourcesPath, 'vst-host', 'thedaw-vst-host.exe')
      if (fs.existsSync(vstHostExe)) {
        env.THEDAW_VST_HOST = vstHostExe
      }
    }
  }
  return env
}

function coreImportsOk(py: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(py, ['-c', 'import uvicorn, fastapi'], {
        env: buildBaseEnv(),
        stdio: 'ignore',
        windowsHide: true,
      })
      proc.on('exit', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

function runUvSync(uvCmd: string, cwd: string): Promise<void> {
  return new Promise((resolve) => {
    // --frozen: use the shipped uv.lock as-is and never rewrite it. Required
    // when the install directory is read-only, and correct regardless -- the
    // lock is generated with the build and must not be re-resolved on a user's
    // machine.
    log(`Running ${uvCmd} sync --frozen --group dev in ${cwd}`)
    // The base environment: package build scripts run in this sync, and none of
    // them may hold the launch token.
    const proc = spawn(uvCmd, ['sync', '--frozen', '--group', 'dev'], {
      cwd,
      env: buildBaseEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // Track the child so quitting mid-setup kills it instead of orphaning a
    // multi-GB download that holds the venv lock against the next launch.
    uvSyncProcess = proc
    const emit = (data: Buffer): void => {
      for (const raw of data.toString().split('\n')) {
        const text = raw.replace(/\r$/, '').trimEnd()
        if (!text.trim()) continue
        log(`[uv] ${text}`)
        sendLoadingLog(text, '')
      }
    }
    proc.stdout?.on('data', emit)
    proc.stderr?.on('data', emit)
    proc.on('exit', (code) => {
      uvSyncProcess = null
      if (code === 0) {
        sendLoadingLog('Dependencies installed.', 'load')
      } else {
        sendLoadingStatus('Setup failed — see the error below')
        sendLoadingLog(
          `Setup step exited with code ${code}. The app may not start until this is resolved.`,
          'err',
        )
      }
      resolve()
    })
    proc.on('error', (err) => {
      uvSyncProcess = null
      sendLoadingStatus('Setup failed — see the error below')
      sendLoadingLog(`Setup failed to start: ${err.message}`, 'err')
      resolve()
    })
  })
}

// First-run bootstrap: build the venv when it is missing or a core import fails
// (a uv sync interrupted after the venv is created but before packages install
// leaves a half-built env). Streams progress into the boot cinematic. No-op in
// dev, where the repo venv is managed by theDAW.bat / uv on PATH.
async function ensurePythonEnv(): Promise<void> {
  if (!app.isPackaged) return
  const pyDir = getPythonDir()
  const py = venvPython(getVenvDir())
  let ok = fs.existsSync(py)
  if (ok) ok = await coreImportsOk(py)
  if (ok) {
    log('Python env present and complete — skipping sync.')
    return
  }
  sendLoadingStatus('First run: setting up the audio engine')
  sendLoadingLog(
    'Installing the Python runtime and dependencies. The first run downloads several GB and can take several minutes.',
    'load',
  )
  await runUvSync(getUvCommand(), pyDir)
}

async function isBackendRunning(): Promise<boolean> {
  try {
    const res = await globalThis.fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

function spawnBackend(): void {
  log('Spawning backend process...')

  const isWindows = process.platform === 'win32'
  const cwd = getPythonDir()
  const env = buildBackendEnv()
  const devVenvPy = venvPython(path.join(cwd, '.venv'))
  const useDevVenv = !app.isPackaged && fs.existsSync(devVenvPy)

  if (app.isPackaged) {
    // The bundled uv is an absolute path, so it is invoked directly (no shell).
    backendProcess = spawn(
      getUvCommand(),
      // --frozen for the same reason as the sync above: `uv run` re-checks the
      // lock and would try to rewrite it, which fails in a read-only install.
      // ensurePythonEnv has already built and verified the env by this point.
      ['run', '--frozen', 'python', '-m', 'backend._supervisor'],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWindows,
      },
    )
  } else if (useDevVenv) {
    // Dev: launch with the project venv's Python directly. `uv run` can fail when
    // uv's cache is unavailable, which silently leaves no backend on :8600 — the
    // frontend then shows 500s for every /api call (Vite's proxy returns 500 on
    // ECONNREFUSED). theDAW.bat already provisions the venv, so this is the
    // reliable dev path; the uv branches below remain the fallback.
    log(`Spawning backend via venv Python: ${devVenvPy}`)
    backendProcess = spawn(
      devVenvPy,
      ['-m', 'backend._supervisor'],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: isWindows,
        detached: !isWindows,
      },
    )
  } else if (isWindows) {
    backendProcess = spawn(
      'cmd',
      ['/c', 'uv run python -m backend._supervisor'],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
  } else {
    backendProcess = spawn(
      'uv',
      ['run', 'python', '-m', 'backend._supervisor'],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    )
  }

  weSpawnedBackend = true

  let stdoutCarry = ''
  backendProcess.stdout?.on('data', (data: Buffer) => {
    stdoutCarry += data.toString()
    const parts = stdoutCarry.split('\n')
    stdoutCarry = parts.pop()!
    for (const raw of parts) {
      const text = plainAscii(raw.replace(/\r$/, ''))
      if (!text) continue
      log(`[backend:stdout] ${text}`)
      const cls = text.includes('[LOAD]') ? 'load' : ''
      sendLoadingLog(text, cls)
      if (text.includes('[LOAD]')) {
        sendLoadingStatus(text.replace(/.*\[LOAD\]\s*/, ''))
      }
    }
  })

  let stderrCarry = ''
  backendProcess.stderr?.on('data', (data: Buffer) => {
    stderrCarry += data.toString()
    const parts = stderrCarry.split('\n')
    stderrCarry = parts.pop()!
    for (const raw of parts) {
      const text = plainAscii(raw.replace(/\r$/, ''))
      if (!text) continue
      log(`[backend:stderr] ${text}`)
      sendLoadingLog(text, stderrLineClass(text))
    }
  })

  backendProcess.on('exit', (code, signal) => {
    const msg =
      `Backend process exited (code=${code}, signal=${signal}). ` +
      (weSpawnedBackend
        ? 'We spawned it — this may indicate a crash.'
        : 'External process.')
    log(msg)
    sendLoadingLog(msg, 'err')
    backendProcess = null

    // The window used to stay up over a dead backend, every /api call answering
    // 500 until the whole app was restarted. Bring the backend back instead —
    // except after a deliberate stop (code 0: the in-app Shutdown button), when
    // another instance owns the port, or while quitting (every intentional kill
    // sets isQuitting first).
    if (isQuitting || !weSpawnedBackend) return
    if (code === 0 || code === BACKEND_PORT_IN_USE_EXIT_CODE) return
    const now = Date.now()
    backendRespawnTimes = backendRespawnTimes.filter((t) => now - t < BACKEND_RESPAWN_WINDOW_MS)
    if (backendRespawnTimes.length >= BACKEND_RESPAWN_MAX) {
      const giveUp = `Backend died ${BACKEND_RESPAWN_MAX} times in ten minutes — not restarting it again.`
      log(giveUp)
      sendLoadingLog(giveUp, 'err')
      return
    }
    backendRespawnTimes.push(now)
    const delayMs = 1000 * backendRespawnTimes.length
    const again = `Restarting the backend in ${delayMs} ms (attempt ${backendRespawnTimes.length}/${BACKEND_RESPAWN_MAX})...`
    log(again)
    sendLoadingLog(again, '')
    setTimeout(() => {
      if (isQuitting || backendProcess) return
      void isBackendRunning().then((up) => {
        if (!up && !isQuitting && !backendProcess) spawnBackend()
      })
    }, delayMs)
  })

  backendProcess.on('error', (err) => {
    log(`Backend process error: ${err.message}`)
    sendLoadingLog(`Backend process error: ${err.message}`, 'err')
    backendProcess = null
  })
}

// ---------------------------------------------------------------------------
// Kill backend on quit
// ---------------------------------------------------------------------------

function killBackend(): Promise<void> {
  // Before the early return below: the LAN listener exists whether or not
  // this process spawned the backend, and it must not outlive the app.
  killLanHttps()
  if (!backendProcess || !weSpawnedBackend) return Promise.resolve()

  log('Stopping the backend...')
  const proc = backendProcess
  const pid = proc.pid
  // The order lives in ./backendStop.ts: ask the backend to shut down, wait out
  // its shutdown handlers when it accepts, force-kill its tree when it refuses,
  // never answers or runs past its budget.
  return stopBackend({
    requestShutdown: () =>
      globalThis
        .fetch(SHUTDOWN_URL, { method: 'POST', signal: AbortSignal.timeout(2000) })
        .then((response) => response.ok),
    onExit: (listener) => {
      proc.on('exit', listener)
    },
    forceKill: () =>
      new Promise<void>((done) => {
        if (!pid) {
          done()
          return
        }
        try {
          if (process.platform === 'win32') {
            execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { env: buildBaseEnv() }, (err) => {
              if (err) log(`taskkill error: ${err.message}`)
              else log('taskkill /T completed.')
              done()
            })
          } else {
            // Kill the process group (negative PID) created by detached:true
            process.kill(-pid, 'SIGKILL')
            log('Sent SIGKILL to backend process group.')
            done()
          }
        } catch {
          done()
        }
      }),
    log,
  }).then(() => undefined)
}

// ---------------------------------------------------------------------------
// The LAN HTTPS listener (dev only)
//
// electron-vite's renderer dev server is plain http on :5173. A second computer
// opening theDAW at http://<lan-ip>:5173 is not a secure context, so Chromium
// withholds AudioContext.audioWorklet, the microphone, Web MIDI, the clipboard
// and crypto.subtle -- the EDIT tab dies on `ctx.audioWorklet` being undefined.
// So dev mode also serves the SAME app over TLS on the LAN port.
//
// Whether it runs at all is one decision, shared with the web launcher and
// owned by backend/lib/lan_https.py (the setting, the LAN address, the
// certificate). This side asks that module rather than reimplementing it, and
// nothing here can hold up the window: the plan is read on its own timeline,
// the spawn is never awaited, and every failure is one log line.
//
// A packaged build serves its UI over app:// and has no dev server to mirror;
// the packaged LAN path is separate work.
// ---------------------------------------------------------------------------

let lanHttpsProcess: ChildProcess | null = null

/** The short-lived `--json` child that answers the plan. Tracked for the same
 *  reason the listener is: a cold `uv run` can take tens of seconds, and a
 *  quit inside that window must not leave it -- or the shell it runs under --
 *  behind holding the venv lock. */
let lanPlanProcess: ChildProcess | null = null

/** Stop one of the two LAN children, and on Windows the whole tree under it.
 *  Both run through a shell (`cmd /c`, `uv run`), so killing the process this
 *  side holds leaves the real work behind: a vite still on the port against
 *  the next launch, or a uv still in the venv. Synchronous and idempotent:
 *  quitting must not wait on either. */
function killLanChild(proc: ChildProcess | null, what: string): void {
  // A child killed by a signal has `exitCode === null` and `signalCode` set --
  // node reports one or the other, never both. Testing only exitCode meant a
  // listener already taken down by taskkill (or a SIGTERM'd uv on posix) was
  // "killed" a second time, logging a line and, on Windows, running a taskkill
  // against a pid the OS is free to have reused.
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const pid = proc.pid
  log(`Stopping ${what}...`)
  try {
    if (process.platform === 'win32' && pid) {
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { env: buildBaseEnv() }, (err) => {
        if (err) log(`LAN (https): taskkill error: ${err.message}`)
      })
    } else {
      proc.kill()
    }
  } catch {
    // already gone
  }
}

/** Is something already answering on 127.0.0.1:port? A 300 ms connect, on the
 *  way to a spawn nothing waits for. Without this, vite's strictPort exit was
 *  all the log had to say about a port someone else holds: "the listener
 *  exited (code=1)". */
function portIsHeld(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    const settle = (held: boolean): void => {
      socket.destroy()
      resolve(held)
    }
    socket.setTimeout(300, () => settle(false))
    socket.once('connect', () => settle(true))
    // `on`, not `once`: a socket destroyed by settle() can still raise, and an
    // unhandled 'error' on a socket takes the main process down.
    socket.on('error', () => settle(false))
  })
}

/** The Python that answers the plan: the dev venv's when it exists (the same
 *  reliable path spawnBackend prefers), otherwise `uv run`. */
function lanHttpsPlanCommand(): { command: string; args: string[] } {
  const module = ['-m', 'backend.lib.lan_https', '--json']
  const devVenvPy = venvPython(path.join(getPythonDir(), '.venv'))
  if (fs.existsSync(devVenvPy)) return { command: devVenvPy, args: module }
  return { command: getUvCommand(), args: ['run', 'python', ...module] }
}

/** The plan, or null when it could not be read. Never rejects. */
function readLanHttpsPlan(): Promise<LanHttpsPlan | null> {
  return new Promise((resolve) => {
    const { command, args } = lanHttpsPlanCommand()
    let stdout = ''
    let settled = false
    const done = (plan: LanHttpsPlan | null): void => {
      if (settled) return
      settled = true
      resolve(plan)
    }
    try {
      const proc = spawn(command, args, {
        cwd: getPythonDir(),
        env: buildBaseEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      lanPlanProcess = proc
      const release = (): void => {
        if (lanPlanProcess === proc) lanPlanProcess = null
      }
      // A cold `uv run` can be slow; a hung one must still not keep this
      // pending forever.
      const deadline = setTimeout(() => {
        killLanChild(proc, 'the LAN HTTPS plan (it took too long)')
        release()
        log('LAN (https): the plan took too long — no listener this launch.')
        done(null)
      }, 30_000)
      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        const text = plainAscii(data.toString()).trimEnd()
        if (text) log(`[lan:plan] ${text}`)
      })
      proc.on('error', (err) => {
        clearTimeout(deadline)
        release()
        log(`LAN (https): the plan could not be read (${err.message})`)
        done(null)
      })
      // 'close', not 'exit': 'exit' fires when the process ends, while its
      // stdio pipes can still have buffered data on the way. Parsing there
      // could read a truncated final line -- exactly the line the plan is on --
      // and silently turn a good plan into "no plan". 'close' fires once every
      // stream is drained and closed, so the plan is whole by then.
      proc.on('close', () => {
        clearTimeout(deadline)
        release()
        done(parseLanHttpsPlan(stdout))
      })
    } catch (err) {
      log(`LAN (https): the plan could not be read (${String(err)})`)
      done(null)
    }
  })
}

async function startLanHttps(): Promise<void> {
  if (app.isPackaged || isQuitting || lanHttpsProcess) return

  const plan = await readLanHttpsPlan()
  log(lanHttpsLogLine(plan))
  // The user began quitting while the plan was being read: a listener started
  // now is one nothing would ever kill.
  if (!plan || !plan.enabled || isQuitting) return

  // Somebody else is on the port -- another copy of theDAW, or a listener run
  // by hand. Say so once and leave it alone: vite would exit 1 on strictPort
  // and a retry loop would only fight whatever owns it.
  if (await portIsHeld(plan.port)) {
    log(`LAN (https): port ${plan.port} is already in use — no listener this launch.`)
    return
  }
  if (isQuitting) return

  const { command, args } = lanListenerCommand(process.platform, plan)
  const frontendDir = path.join(repoRoot, 'frontend')
  try {
    lanHttpsProcess = spawn(command, args, {
      cwd: frontendDir,
      // buildBaseEnv() drops the launch token; lanListenerEnv drops it again
      // and adds only the three names vite.lan.config.ts reads. Vite runs the
      // frontend's own devDependencies, so none of it may pass as this shell.
      env: lanListenerEnv(buildBaseEnv(), plan),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    lanHttpsProcess = null
    log(`LAN (https): the listener could not start (${String(err)})`)
    return
  }

  const emit = (data: Buffer): void => {
    for (const raw of data.toString().split('\n')) {
      const text = plainAscii(raw.replace(/\r$/, '')).trimEnd()
      if (text) log(`[lan] ${text}`)
    }
  }
  lanHttpsProcess.stdout?.on('data', emit)
  lanHttpsProcess.stderr?.on('data', emit)
  lanHttpsProcess.on('exit', (code, signal) => {
    lanHttpsProcess = null
    if (!isQuitting) log(`LAN (https): the listener exited (code=${code}, signal=${signal}).`)
  })
  lanHttpsProcess.on('error', (err) => {
    lanHttpsProcess = null
    log(`LAN (https): listener process error: ${err.message}`)
  })
}

/** Stop the listener, and the plan child if one is still being read.
 *  Synchronous and idempotent: quitting must not wait on it, and it is called
 *  from both will-quit and killBackend. */
function killLanHttps(): void {
  const plan = lanPlanProcess
  lanPlanProcess = null
  killLanChild(plan, 'the LAN HTTPS plan')
  const listener = lanHttpsProcess
  lanHttpsProcess = null
  killLanChild(listener, 'the LAN HTTPS listener')
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null

// ---------------------------------------------------------------------------
// OS file-open (.tasmo / .gan associations)
//
// Double-clicking an associated file launches (or re-uses) theDAW with the path
// in argv (Windows/Linux) or via the 'open-file' event (macOS). We forward the
// path to the renderer, which routes .tasmo -> project load and .gan -> the MIX
// plugin loader. If the window isn't ready yet, the path is held and flushed on
// did-finish-load.
// ---------------------------------------------------------------------------

let pendingOpenFile: string | null = null

function fileArgFrom(argv: string[]): string | null {
  for (const a of argv) {
    if (typeof a !== 'string') continue
    const lower = a.toLowerCase()
    if ((lower.endsWith('.tasmo') || lower.endsWith('.gan')) && fs.existsSync(a)) {
      return a
    }
  }
  return null
}

function deliverOpenFile(filePath: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-file', filePath)
  } else {
    pendingOpenFile = filePath
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'theDAW',
    icon: WINDOW_ICON,
    // Open windowed at the default size (reverted from forced fullscreen).
    fullscreen: false,
    // Paint solid black immediately so there's no white window flash before
    // content loads — one continuous black background from the first frame to
    // the app (matches index.html's <body> + the boot splash).
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      // The boot cinematic's logo is a muted, looping video — allow it to
      // autoplay without a user gesture (Chromium blocks this by default).
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // Route outbound http(s) links (update/release pages, the Hugging Face
  // sign-in) to the user's default browser, where they may already be signed
  // in. Same-origin http(s) — the dev server's own navigations — stays in-app,
  // and so does the local backend origin (the packaged renderer opens the VJ
  // pop-out at BACKEND_BASE/vj-app, which must be an in-app child window so
  // the renderer keeps a window handle for postMessage control).
  const isExternal = (url: string): boolean => {
    if (!/^https?:\/\//i.test(url)) return false
    try {
      const target = new URL(url)
      if (target.origin === new URL(BACKEND_BASE).origin) return false
      const here = mainWindow?.webContents.getURL() || 'app://./'
      return target.origin !== new URL(here).origin
    } catch {
      return false
    }
  }
  // F9 starts and stops the screen recorder. The key is taken here, before the
  // page sees it, so it works whichever frame has focus (an embedded page
  // keeps its own key events). The toggle runs with the gesture flag because
  // the page's getDisplayMedia call needs user activation, and a key the page
  // never receives gives it none.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F9' || input.isAutoRepeat) return
    if (input.control || input.alt || input.meta || input.shift) return
    event.preventDefault()
    const wc = mainWindow?.webContents
    if (!wc || wc.isDestroyed()) return
    wc.executeJavaScript("window.dispatchEvent(new CustomEvent('thedaw:screen-record-toggle'))", true).catch(
      () => undefined,
    )
  })

  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    if (isExternal(url)) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    // The VJ pop-out asks for a specific monitor (Settings -> Inputs & outputs
    // -> Pop-out screen). It travels in the window.open features string because
    // that is the only channel available from inside the click handler — and
    // the call HAS to stay in the gesture or the pop-out is blocked.
    const bounds = requestedDisplayBounds(frameName, features)
    if (bounds) return { action: 'allow', overrideBrowserWindowOptions: { ...bounds, icon: WINDOW_ICON } }
    return { action: 'allow', overrideBrowserWindowOptions: { icon: WINDOW_ICON } }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isExternal(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  // The renderer guards an unsaved arrangement with a `beforeunload` veto
  // (Shell.tsx). A browser turns that into its "Leave site?" prompt; Electron
  // shows nothing and silently cancels the close, so a window holding unsaved
  // work could not be closed at all — not by the X, not by Alt+F4, not by Quit.
  // Ask here instead. preventDefault() on THIS event means "ignore the page's
  // veto", i.e. let the window close.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const win = mainWindow
    const choice = win
      ? dialog.showMessageBoxSync(win, {
          type: 'question',
          buttons: ['Close anyway', 'Keep editing'],
          defaultId: 1,
          cancelId: 1,
          title: 'theDAW',
          message: 'This project has unsaved changes.',
          detail: 'Closing now discards everything since the last save. The autosave keeps a recovery copy.',
          noLink: true,
        })
      : 0
    if (choice === 0) {
      event.preventDefault()
      return
    }
    // The user stays, so a quit that was under way is over: the window lives
    // on, and it needs its backend (and the auto-restart) back.
    isQuitting = false
    if (weSpawnedBackend && !backendProcess) {
      void isBackendRunning().then((up) => {
        if (!up && !isQuitting && !backendProcess) spawnBackend()
      })
    }
  })

  // Load the React renderer IMMEDIATELY (no separate spinner page). The renderer
  // shows the boot cinematic and polls /api/health on its own, holding until the
  // backend is ready — exactly like the web app. This keeps ONE background the
  // whole time and keeps the desktop + web boot flows in sync.
  loadRenderer()
}

/**
 * Where a pop-out asked to be placed. Returns null when the window is not one
 * we position, when no display was asked for, or when that display is gone —
 * in which case Chromium's own default placement applies.
 */
function requestedDisplayBounds(
  frameName: string,
  features: string,
): { x: number; y: number; width: number; height: number } | null {
  if (frameName !== 'sa3-vj-window') return null
  const match = /(?:^|,)\s*thedawDisplay=([^,]+)/.exec(features || '')
  const wanted = match?.[1]?.trim()
  if (!wanted) return null
  try {
    const target = screen.getAllDisplays().find((d) => String(d.id) === wanted)
    if (!target) return null
    const area = target.workArea
    const width = Math.min(1280, area.width)
    const height = Math.min(800, area.height)
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    }
  } catch {
    return null
  }
}

function flushPendingOpenFile(): void {
  if (!pendingOpenFile || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('open-file', pendingOpenFile)
  pendingOpenFile = null
}

/**
 * loadURL, with its promise settled.
 *
 * Electron attaches its own did-stop-loading / did-fail-load listeners to the
 * WebContents to settle the promise loadURL returns, and removes them when it
 * settles. Dropping the promise on the floor leaves a rejection unhandled when a
 * load is superseded or refused -- which happens in dev whenever the Vite server
 * is not up yet, and this machine's console carries repeated
 * "connect failed: 10055" from exactly that. Awaiting it lets those listeners go.
 * ERR_ABORTED is the ordinary case of one navigation replacing another.
 */
function load(url: string): void {
  if (!mainWindow) return
  mainWindow.webContents.loadURL(url).catch((err: Error) => {
    const msg = String(err?.message ?? err)
    if (msg.includes('ERR_ABORTED')) return
    log(`Renderer load failed for ${url}: ${msg}`)
  })
}

function loadRenderer(): void {
  if (!mainWindow) return
  // Flush any file the app was opened with once the renderer has loaded.
  // removeListener first: this function runs once today, but a second call
  // would stack a second flush on the same WebContents, and a listener that
  // accumulates on a reload is exactly what the MaxListenersExceededWarning in
  // the console is reporting.
  mainWindow.webContents.removeListener('did-finish-load', flushPendingOpenFile)
  mainWindow.webContents.on('did-finish-load', flushPendingOpenFile)
  const devURL = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devURL) {
    load(devURL)
  } else if (!app.isPackaged) {
    // 127.0.0.1, not 'localhost': the Vite dev server binds 0.0.0.0 (IPv4
    // only, see electron.vite.config.ts) and Chromium prefers ::1 for
    // 'localhost' on Windows, which loads a blank ERR_CONNECTION_REFUSED
    // window with a running dev server sitting right there.
    load('http://127.0.0.1:5173')
  } else {
    load('app://./index.html')
  }
}

function escapeForJS(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

/** The LOG panel class for one backend stderr line. A Python logging line
 *  opens with its level ("WARNING root: ...", uvicorn's "INFO:     ..."), and
 *  that level decides: WARNING shows as a warning, ERROR and CRITICAL count as
 *  errors, DEBUG and INFO as plain lines. A line with no level (a traceback
 *  frame, a library print) counts as an error when it names one. */
function stderrLineClass(text: string): string {
  const level = /^(DEBUG|INFO|WARNING|ERROR|CRITICAL)\b/.exec(text)?.[1]
  if (level === 'WARNING') return 'warn'
  if (level === 'ERROR' || level === 'CRITICAL') return 'err'
  if (level) return ''
  if (text.includes('ERROR') || text.includes('Error')) return 'err'
  return text.includes('WARNING') ? 'warn' : ''
}

function sendLoadingLog(msg: string, cls?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const escaped = escapeForJS(msg)
  mainWindow.webContents.executeJavaScript(
    `if(typeof addLog==='function')addLog('${escaped}','${cls || ''}')`,
  ).catch(() => {})
}

function sendLoadingStatus(msg: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const escaped = escapeForJS(msg)
  mainWindow.webContents.executeJavaScript(
    `if(typeof setStatus==='function')setStatus('${escaped}')`,
  ).catch(() => {})
}

// ---------------------------------------------------------------------------
// Downloads the renderer starts (an <a download>, a blob save)
//
// Chromium writes these straight to disk, so the backend never sees where they
// went. When one finishes, the path goes to /api/places/record so the app's
// pickers and "Recent" menus can offer that file back, and the renderer hears
// about it on 'download-done' so it can say where the file landed.
// ---------------------------------------------------------------------------

const PLACES_RECORD_URL = `${BACKEND_BASE}/api/places/record`
const LAUNCH_TOKEN_CHECK_URL = `${BACKEND_BASE}/api/places/launch-token-check`

/** Record a finished download with the launch token. Resolves once the backend
 *  answered, failed or timed out; it never rejects, because a backend that is
 *  down or restarting must not surface as an error for a download that already
 *  succeeded. */
async function recordDownload(savePath: string): Promise<void> {
  try {
    const res = await globalThis.fetch(PLACES_RECORD_URL, {
      method: 'POST',
      // The token tells /api/places/record this path came from Chromium's
      // download manager, which is what lets the backend serve it back.
      headers: {
        'content-type': 'application/json',
        [LAUNCH_TOKEN_HEADER]: LAUNCH_TOKEN,
      },
      body: JSON.stringify({ path: savePath }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) log(`Recording the download failed: /api/places/record answered ${res.status}.`)
  } catch (err) {
    log(`Recording the download failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Item 4 (T17 audit): which exact filenames the renderer's autoDownload
// toggle is about to click — set by the downloads:markAutomatic IPC call,
// right before it clicks an <a download> once per finished take. Matched on
// filename (not just counted) so an unrelated user download never gets
// silently auto-saved by a leftover count, and each mark expires on its own
// (AutoDownloadClaims' TTL) so a mismatch never leaks a slot indefinitely —
// see downloadNaming.ts.
const autoDownloads = new AutoDownloadClaims()

function watchDownloads(ses: Electron.Session): void {
  ses.on('will-download', (_event, item) => {
    if (autoDownloads.claim(item.getFilename())) {
      // setSavePath() is what skips Electron's "original routine" (the save
      // dialog) — see download-item.md. Unique against the real Downloads
      // folder so a batch's takes never silently overwrite one another.
      const dir = app.getPath('downloads')
      const savePath = uniqueDownloadPath(dir, item.getFilename(), (p) => fs.existsSync(p))
      item.setSavePath(savePath)
      log(`Auto-download: saving to ${savePath}`)
    }
    item.once('done', async (_doneEvent, state) => {
      const filename = item.getFilename()
      const savePath = state === 'completed' ? item.getSavePath() || null : null
      if (savePath) {
        log(`Download completed: ${savePath}`)
        // Recorded before the renderer hears about it, so the Recent menus it
        // refetches on 'download-done' already list the file.
        await recordDownload(savePath)
      } else {
        log(`Download ${state}: ${filename}`)
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-done', { path: savePath, filename, state })
      }
    })
  })
}

/** Ask a backend this process did not spawn whether it holds this session's
 *  launch token, and log one warning when it does not. Such a backend records
 *  a finished download as a path a page named. */
async function warnIfBackendLacksLaunchToken(): Promise<void> {
  let matches: boolean
  try {
    const res = await globalThis.fetch(LAUNCH_TOKEN_CHECK_URL, {
      headers: { [LAUNCH_TOKEN_HEADER]: LAUNCH_TOKEN },
      signal: AbortSignal.timeout(5000),
    })
    // A backend from before this route has no launch token either.
    if (res.status === 404) {
      matches = false
    } else if (res.ok) {
      const body = (await res.json()) as { matches?: unknown }
      matches = body?.matches === true
    } else {
      log(`Launch token check answered ${res.status}; skipping it.`)
      return
    }
  } catch (err) {
    log(`Launch token check failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (!matches) {
    log(
      'WARNING: The backend on port 8600 was started outside this app, so it does not hold ' +
        "this session's launch token. Downloads from this session will not appear in Recent menus.",
    )
  }
}

// ---------------------------------------------------------------------------
// Production: custom protocol for renderer files
// ---------------------------------------------------------------------------

/** Statuses the fetch spec forbids a body on. Re-wrapping one of these with a
 *  stream body throws, which would turn a perfectly good 204 into a hard
 *  failure of whatever request produced it. 1xx is deliberately absent: the
 *  Response constructor rejects any status below 200 outright, so 101/103 are
 *  handled by the range guard below, not by passing a null body. */
const NULL_BODY_STATUS = new Set([204, 205, 304])

/**
 * Cross-origin isolation: OPT-IN, off by default, same switch as the dev
 * server (`ISOLATION_ENABLED` in frontend/vite.config.ts).
 *
 * COOP + COEP are what make SharedArrayBuffer constructible, but COEP also
 * blocks every embedded document that carries no embedder policy of its own —
 * the Underfit (:8791), VST Foundry (:5472) and Lyria sidecar tabs, which run
 * on their own origins — and COOP severs the window handle the VJ pop-out is
 * driven through, because the packaged pop-out loads from the backend's http
 * origin, not app://. Until those are proxied same-origin (T29B), isolation
 * stays behind the flag: start the app with theDAW_ISOLATE=1 to get it.
 *
 * With the flag unset, nothing below runs — the handler returns the very
 * Response object net.fetch produced, so not one byte of any response changes.
 */
const ISOLATION_ENABLED = process.env.theDAW_ISOLATE === '1'

/**
 * Re-issue a response with cross-origin isolation headers attached.
 *
 * A Response that came out of `net.fetch` has an immutable header guard, so
 * its headers cannot be appended to in place — the only way to add one is to
 * construct a new Response around the same body. The body is passed through
 * untouched, so streamed responses (audio, model downloads, SSE) stay streamed.
 *
 * `document` responses — the renderer's own HTML and the embedded VJ /
 * SwayCommand builds — get COOP + COEP, which is what makes
 * `crossOriginIsolated` true and SharedArrayBuffer constructible (see
 * frontend/src/lib/sabSupport.ts). Everything else gets only
 * Cross-Origin-Resource-Policy, which is what an isolated document demands of
 * each subresource it pulls in. In dev the same headers come from
 * `server.headers` and the proxy hooks in frontend/vite.config.ts.
 *
 * The proxy branches that call this assume the backend sets no `Set-Cookie`:
 * the header would survive the copy, but nothing in theDAW's API issues one,
 * and a future cookie-bearing route should be checked against this path rather
 * than assumed to pass through intact.
 */
function withIsolationHeaders(res: Response, kind: 'document' | 'resource'): Response {
  // The default path: hand back the exact object net.fetch returned. No new
  // Response, no header copy, no body re-plumbing — so a streamed response
  // cannot be perturbed by a feature that is switched off.
  if (!ISOLATION_ENABLED) return res
  // The Response constructor accepts 200-599 and throws on anything else, so a
  // 1xx or a malformed status is handed back untouched rather than re-wrapped
  // into an exception that would take the whole request down.
  if (res.status < 200 || res.status > 599) return res
  const headers = new Headers(res.headers)
  // The body we are about to re-attach is the DECODED stream — net.fetch has
  // already undone any gzip/br — so the upstream encoding and length describe
  // bytes that no longer exist. Left in place they make the renderer try to
  // inflate plain text, or truncate it at the compressed length.
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  if (kind === 'document') {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  }
  const body = NULL_BODY_STATUS.has(res.status) ? null : res.body
  return new Response(body, { status: res.status, statusText: res.statusText, headers })
}

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url)

    // Intercept /api/* requests and proxy to backend. duplex:'half' is
    // REQUIRED whenever body is a stream — without it the fetch-spec Request
    // constructor throws and every body-carrying POST/PUT in the packaged app
    // fails with net::ERR_FAILED. The catch turns backend-down into a clean
    // 502 instead of an opaque network error.
    if (url.pathname.startsWith('/api/')) {
      return net
        .fetch(`${BACKEND_BASE}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          duplex: 'half',
        } as RequestInit)
        // A subresource of an isolated document, so CORP — and only CORP. The
        // /api branch keeps its method, headers, body, streaming and 502
        // behaviour exactly as before; one response header is the whole change.
        .then((res) => withIsolationHeaders(res, 'resource'))
        .catch((err) => {
          // The reason travels with the status. A bare 502 here was read as
          // "huggingface.co is down" for two days; the header says which hop
          // actually failed, and the body says why.
          const why = err instanceof Error ? err.message : String(err)
          log(`API proxy failed: ${request.method} ${url.pathname} -> ${why}`)
          return new Response(`theDAW backend unreachable at ${BACKEND_BASE}: ${why}`, {
            status: 502,
            headers: {
              'x-thedaw-proxy-error': 'backend-unreachable',
              // Only under isolation: without CORP the isolated renderer cannot
              // read the 502 at all — it would surface as an opaque network
              // error and hide the reason this header exists to carry. Off by
              // default, the 502 is exactly the one-header response it was.
              ...(ISOLATION_ENABLED ? { 'Cross-Origin-Resource-Policy': 'same-origin' } : {}),
            },
          })
        })
    }

    // Proxy the backend-served static VJ build too, so any relative /vj-app/
    // URL works under the app:// origin (the renderer bundle contains no
    // vj-app; the build ships beside the backend and is mounted by server.py).
    if (url.pathname === '/vj-app' || url.pathname.startsWith('/vj-app/')) {
      return net
        .fetch(`${BACKEND_BASE}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
        })
        // The VJ build is a DOCUMENT in an iframe of an isolated page, and an
        // iframe is checked against its embedder's COEP: without an embedder
        // policy of its own it is blocked and the tab goes blank. Its own
        // subresources are served from this same branch, so they get the same
        // treatment and the whole build loads.
        .then((res) => withIsolationHeaders(res, 'document'))
        .catch(() => new Response('backend unavailable', { status: 502 }))
    }

    // Same for the SwayCommand cockpit embed. Exact-match-or-slash-prefix, not
    // a bare startsWith('/sway-app'), which would also swallow paths like
    // /sway-application.
    if (url.pathname === '/sway-app' || url.pathname.startsWith('/sway-app/')) {
      return net
        .fetch(`${BACKEND_BASE}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
        })
        // Same as /vj-app: an embedded document needs its own embedder policy.
        .then((res) => withIsolationHeaders(res, 'document'))
        .catch(() => new Response('backend unavailable', { status: 502 }))
    }

    // Serve static files from the built renderer output
    let filePath = url.pathname
    if (filePath === '/' || filePath === '') {
      filePath = '/index.html'
    }

    const rendererDir = path.join(__dirname, '../renderer')
    const fullPath = path.join(rendererDir, filePath)

    // Security: ensure the resolved path is within the renderer dir
    const resolved = path.resolve(fullPath)
    if (!resolved.startsWith(path.resolve(rendererDir))) {
      return new Response('Forbidden', { status: 403 })
    }

    // The renderer's own files. index.html is the top-level document whose
    // COOP + COEP decide whether the whole app is cross-origin isolated; the
    // bundles, styles, fonts and the /splash and /owl iframes beside it are
    // served from this same branch, so handing every one of them the document
    // pair is both correct (each embedded HTML file needs its own COEP) and
    // harmless for the rest — COOP/COEP on a script or a font is ignored.
    return net.fetch(pathToFileURL(resolved).href).then((res) => withIsolationHeaders(res, 'document'))
  })
}

// ---------------------------------------------------------------------------
// IPC handlers for native dialogs
// ---------------------------------------------------------------------------

/** What the renderer may set on an open dialog: where it starts, what it lists
 *  and its title. Anything else in the payload is dropped, so the renderer can
 *  never turn a file picker into a multi-select or a directory picker. */
function openDialogOptions(raw: unknown): Pick<Electron.OpenDialogOptions, 'defaultPath' | 'filters' | 'title'> {
  const out: Pick<Electron.OpenDialogOptions, 'defaultPath' | 'filters' | 'title'> = {}
  if (!raw || typeof raw !== 'object') return out
  const o = raw as { defaultPath?: unknown; filters?: unknown; title?: unknown }
  if (typeof o.defaultPath === 'string' && o.defaultPath) out.defaultPath = o.defaultPath
  if (typeof o.title === 'string' && o.title) out.title = o.title
  if (Array.isArray(o.filters)) {
    const filters = o.filters.filter(
      (f): f is Electron.FileFilter =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as Electron.FileFilter).name === 'string' &&
        Array.isArray((f as Electron.FileFilter).extensions) &&
        (f as Electron.FileFilter).extensions.every((e) => typeof e === 'string'),
    )
    if (filters.length) out.filters = filters
  }
  return out
}

function registerIpcHandlers(): void {
  // Electron opens a dialog with no defaultPath in Downloads and the OS does
  // not restore the last folder, so every dialog starts in the folder the
  // previous one ended in (see dialogFolder.ts).
  const dialogFolder = new DialogFolderMemory(path.join(app.getPath('userData'), 'dialog-folder.json'))

  ipcMain.handle('dialog:selectFile', async (_event, options?: unknown) => {
    if (!mainWindow) return { canceled: true, filePaths: [] }
    const opts = openDialogOptions(options)
    const result = await dialog.showOpenDialog(mainWindow, {
      ...opts,
      defaultPath: dialogDefaultPath(opts.defaultPath, dialogFolder.get()),
      properties: ['openFile'],
    })
    dialogFolder.set(folderAfterDialog('openFile', result))
    return result
  })

  ipcMain.handle('dialog:selectDirectory', async (_event, options?: unknown) => {
    if (!mainWindow) return { canceled: true, filePaths: [] }
    const opts = openDialogOptions(options)
    const result = await dialog.showOpenDialog(mainWindow, {
      ...opts,
      defaultPath: dialogDefaultPath(opts.defaultPath, dialogFolder.get()),
      properties: ['openDirectory'],
    })
    dialogFolder.set(folderAfterDialog('openDirectory', result))
    return result
  })

  ipcMain.handle(
    'dialog:showSave',
    async (_event, options: Electron.SaveDialogOptions) => {
      if (!mainWindow) return { canceled: true, filePath: undefined }
      const result = await dialog.showSaveDialog(mainWindow, {
        ...options,
        defaultPath: dialogDefaultPath(options?.defaultPath, dialogFolder.get()),
      })
      dialogFolder.set(folderAfterDialog('save', result))
      return result
    },
  )

  // Quit the app on request (Settings "Shutdown" in desktop mode). app.quit()
  // triggers before-quit, which kills the spawned backend, then closes the window.
  ipcMain.handle('app:quit', () => {
    app.quit()
  })

  // Native window handle (HWND on Windows) for embedding a VST3 editor window
  // into the MIX area: the backend sidecar reparents the editor under this HWND.
  // getNativeWindowHandle() returns a Buffer holding the pointer; encode it as a
  // decimal string so it survives JSON/IPC without precision loss.
  // The monitors this machine has, so the renderer can offer them as a choice
  // for pop-out windows. Web has no equivalent API, which is why that row reads
  // "desktop app only" in a browser.
  ipcMain.handle('display:list', () => {
    try {
      const primary = screen.getPrimaryDisplay().id
      return screen.getAllDisplays().map((d) => ({
        id: String(d.id),
        label: `${d.label || `Display ${d.id}`} (${d.size.width}x${d.size.height})${d.id === primary ? ' · primary' : ''}`,
        bounds: d.workArea,
        primary: d.id === primary,
      }))
    } catch {
      return []
    }
  })

  ipcMain.handle('window:getNativeHandle', () => {
    if (!mainWindow) return null
    try {
      const buf = mainWindow.getNativeWindowHandle()
      const value = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
      return value.toString()
    } catch {
      return null
    }
  })

  // Screen-space rect of the web content area (DIP), so the renderer can convert
  // an element's client rect into absolute screen pixels for positioning the
  // embedded VST window. Changes as the window moves/resizes.
  ipcMain.handle('window:getContentBounds', () => {
    if (!mainWindow) return null
    try {
      return mainWindow.getContentBounds()
    } catch {
      return null
    }
  })

  // Item 4 (T17 audit): the renderer's auto-download loop calls this once,
  // just before it clicks, with the EXACT filenames it's about to save —
  // watchDownloads' will-download handler (above) claims a slot only for a
  // matching filename, within AutoDownloadClaims' TTL.
  ipcMain.handle('downloads:markAutomatic', (_event, names: unknown) => {
    autoDownloads.mark(Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [])
  })

  registerUpdaterHandlers()
}

// ---------------------------------------------------------------------------
// In-place updates for the packaged app (electron-updater over GitHub releases)
// ---------------------------------------------------------------------------
//
// Windows only in practice: the NSIS installer updates unsigned. The macOS
// dmg is unsigned, and Squirrel.Mac refuses to install an unsigned update, so
// check() reports unsupported there and the renderer opens the dmg download
// instead. In dev (not packaged) there is no app-update.yml, so the renderer
// falls back to the backend's git-pull path.

function updaterSupport(): { supported: boolean; reason?: string } {
  if (!app.isPackaged) return { supported: false, reason: 'dev' }
  if (process.platform === 'darwin') return { supported: false, reason: 'unsigned-mac' }
  return { supported: true }
}

let updateDownloaded = false

function registerUpdaterHandlers(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (m: unknown) => log(`[updater] ${String(m)}`),
    warn: (m: unknown) => log(`[updater] warn: ${String(m)}`),
    error: (m: unknown) => log(`[updater] error: ${String(m)}`),
    debug: () => {},
  }
  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents.send('updates:progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
    })
  })
  autoUpdater.on('update-downloaded', () => {
    updateDownloaded = true
  })

  ipcMain.handle('updates:check', async () => {
    const support = updaterSupport()
    if (!support.supported) return support
    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version ?? null
      const available = version !== null && version !== app.getVersion()
      return { supported: true, version, available, current: app.getVersion() }
    } catch (err) {
      return { supported: true, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updates:download', async () => {
    const support = updaterSupport()
    if (!support.supported) return support
    try {
      updateDownloaded = false
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updates:install', async () => {
    if (!updateDownloaded) return { ok: false, error: 'No update has been downloaded yet.' }
    // The installer overwrites resources/python, so the backend (and the venv
    // interpreters under it) must be gone first. before-quit would do this
    // too, but the installer is already launching by then.
    isQuitting = true
    await killBackend()
    // isSilent=false shows the NSIS UI; isForceRunAfter=true relaunches theDAW.
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Windows camera backend: Chromium defaults to the Media Foundation video-capture
// backend, which does NOT enumerate many virtual / phone-as-webcam bridges
// (Iriun, Camo, DroidCam, EpocCam, NDI, OBS virtual camera) that register only as
// DirectShow devices — so they never appear in enumerateDevices() and can't be
// picked in the camera selector. Forcing the DirectShow capturer surfaces them.
// Physical cameras keep working under DirectShow on Windows 10/11; remove this
// switch only if a specific Media-Foundation-only device regresses.
//
// IsolateSandboxedIframes: Chromium moves every sandboxed srcdoc frame (the
// Foundry's 24 custom-code pads, `sandbox="allow-scripts"`) into a renderer
// process of its own. In this app that process grows about 250 MB a second
// whether or not the pads' scripts run, is killed near 2.4 GB about ten
// seconds after the frames load, and Chromium paints the dead frames grey.
// Measured 2026-09-10 on Electron 42.11 / Chromium 148; browser tabs and
// headless runs never isolate these frames, so it only showed in the desktop
// app. With the feature off the frames stay sandboxed (opaque origin, no
// same-origin access) inside the Foundry's own renderer, all of them stay
// alive, and memory stays flat. Re-check on every Electron upgrade: the leak
// is Chromium's and may be fixed upstream.
const disabledFeatures = ['IsolateSandboxedIframes']
if (process.platform === 'win32') disabledFeatures.push('MediaFoundationVideoCapture')
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','))

// Register custom protocol scheme before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

// Single-instance: a second launch (e.g. double-clicking a .tasmo while running)
// forwards its file arg to the existing window instead of starting a second app.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
app.on('second-instance', (_event, argv) => {
  const f = fileArgFrom(argv)
  if (f) deliverOpenFile(f)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})
// macOS delivers associated files via this event rather than argv.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  deliverOpenFile(filePath)
})

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  // The path the app was launched with (Windows/Linux argv), flushed to the
  // renderer once it loads.
  const launchFile = fileArgFrom(process.argv)
  if (launchFile) pendingOpenFile = launchFile


  // Identify as theDAW, not "Electron": names the process / menu / userData dir
  // and, via the AppUserModelID, the Windows taskbar grouping + shortcut binding.
  app.setName('theDAW')
  app.setAppUserModelId('com.gantasmo.thedaw')

  // Grant media (microphone / camera) capture to the renderer. Electron layers
  // its own permission gate on top of the OS; with no handler a getUserMedia
  // track can return MUTED — the OS opens the device but the renderer receives
  // silence. The renderer only ever loads our own local content, so granting is
  // safe. Mic capture (vocal record) and camera (VJ) both depend on this.
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true))
  ses.setPermissionCheckHandler(() => true)
  // Screen recording (frontend/src/lib/screenRecorder.ts). The app window asks
  // for its own picture and sound through getDisplayMedia, and it is granted
  // the frame that asked: the window's content and the audio of everything in
  // it, with no picker. enableLocalEcho keeps that audio on the speakers while
  // it is captured. Any other frame (an embedded page) is refused.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame
    const own = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.mainFrame : null
    if (!frame || !own || frame.frameTreeNodeId !== own.frameTreeNodeId) {
      // No stream for a video request is how a request is refused; Electron
      // throws on it here and rejects the page's promise.
      try {
        callback({})
      } catch {
        // refused
      }
      return
    }
    callback({
      video: frame,
      ...(request.audioRequested ? { audio: frame, enableLocalEcho: true } : {}),
    })
  })
  watchDownloads(ses)

  registerIpcHandlers()

  // In production, register our custom protocol
  if (app.isPackaged) {
    registerAppProtocol()
  }

  // Window loads the renderer (boot cinematic) right away.
  createWindow()

  // Spawn the backend in the background if it isn't already up. The renderer's
  // own health polling + cinematic cover the wait; if the backend never comes
  // up, the app surfaces its "continue without backend" escape — same as web.
  const alreadyRunning = await isBackendRunning()
  if (!alreadyRunning) {
    // Packaged builds bootstrap the Python env on first launch before the
    // backend can start; dev builds no-op here.
    await ensurePythonEnv()
    // The await above can resume AFTER the user began quitting mid-setup;
    // spawning then would launch a backend nothing ever kills.
    if (!isQuitting) spawnBackend()
  } else {
    log('Backend already running — skipping spawn.')
    await warnIfBackendLacksLaunchToken()
  }

  // The same app over TLS for other devices on the network. Deliberately not
  // awaited: reading the plan shells out to Python, and the window must never
  // wait on it. Dev only; a failure is one log line and the app runs as before.
  void startLanHttps()
})

app.on('window-all-closed', () => {
  // Quit on all platforms — theDAW is a DAW, not a utility app
  app.quit()
})

app.on('before-quit', () => {
  if (isQuitting) return
  isQuitting = true
  // Kill an in-flight first-run sync so it doesn't outlive the app holding
  // the venv lock (on Windows the child survives parent death otherwise).
  if (uvSyncProcess && uvSyncProcess.exitCode === null) {
    try {
      uvSyncProcess.kill()
    } catch {
      // already gone
    }
  }
})

// The backend goes down here, not in before-quit: before-quit fires BEFORE the
// windows are asked to close, and a window can still refuse (unsaved changes ->
// "Keep editing"). Killing the backend first left that window open over a dead
// backend. will-quit only fires once every window has really closed.
let backendStoppedForQuit = false
app.on('will-quit', (event) => {
  if (backendStoppedForQuit) return
  backendStoppedForQuit = true
  // Unconditionally, unlike the backend below: the LAN listener is ours even
  // when the backend was already running and we never spawned one.
  killLanHttps()
  if (weSpawnedBackend && backendProcess) {
    event.preventDefault()
    killBackend().finally(() => {
      app.quit()
    })
  }
})
