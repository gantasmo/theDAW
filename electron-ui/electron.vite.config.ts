import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createLogger } from 'vite'
import { plainAscii } from '../frontend/src/lib/plainText'
import { buildInfoDefines } from '../frontend/buildInfo.config'

// The desktop console carries the backend, the Electron main process and the
// dev server in one stream, and it is read to find out what broke. Vite
// announces optimized dependencies with a sparkle; a pictograph in a
// diagnostic line carries no information, and on a Windows console running a
// legacy code page an astral-plane character raises UnicodeEncodeError and can
// take the operation down with it. Musical symbols and the dingbats this app
// uses as interface glyphs are kept; see frontend/src/lib/plainText.
// frontend/vite.config.ts carries the same logger for the browser dev path.
const plainLogger = createLogger()
const baseInfo = plainLogger.info.bind(plainLogger)
const baseWarn = plainLogger.warn.bind(plainLogger)
const baseError = plainLogger.error.bind(plainLogger)
const clean = (msg: string): string => (typeof msg === 'string' ? plainAscii(msg) : msg)
plainLogger.info = (msg, options) => baseInfo(clean(msg), options)
plainLogger.warn = (msg, options) => baseWarn(clean(msg), options)
plainLogger.error = (msg, options) => baseError(clean(msg), options)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, '../frontend'),
    // The desktop window's own dependency cache. Vite's default,
    // frontend/node_modules/.vite, is shared with every other dev server
    // started from the frontend folder: the LAN HTTPS server this shell spawns
    // (frontend/vite.lan.config.ts) and the browser-mode server. Those run a
    // different Vite with a different config, so each rebuilt the shared cache
    // under its own file names and the window was left asking for chunks that
    // had been replaced: a black screen after the boot cinematic.
    cacheDir: resolve(__dirname, '../frontend/node_modules/.vite-desktop'),
    customLogger: plainLogger,
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, '../frontend/index.html') }
      }
    },
    plugins: [react(), tailwindcss()],
    // Same build identity as frontend/vite.config.ts; electron-vite never
    // loads that file, so the defines have to be repeated here.
    define: buildInfoDefines(resolve(__dirname, '../frontend')),
    // alphaTab resolves its Bravura font + worker via import.meta.url relative
    // to its own dist/. Vite's dep pre-bundling rewrites that into .vite/deps/
    // where the worker does NOT exist, which wedges the renderer ("alphaTab.
    // worker.mjs does not exist in the optimize deps directory"). Excluding it
    // (matching frontend/vite.config.ts) keeps it served from node_modules so
    // the worker + font URLs stay valid. Without this, desktop mode hangs on
    // "loading" and scores never render.
    optimizeDeps: {
      exclude: ['@coderline/alphatab'],
    },
    resolve: {
      alias: { '@': resolve(__dirname, '../frontend') }
    },
    server: {
      port: 5173,
      // Never slide to 5174. The window's saved settings (every persisted store
      // in localStorage) and its mic/MIDI permissions belong to the ORIGIN, and
      // the port is part of it, so a silent move opened the app with all of them
      // empty. The launchers stop first and name whatever holds 5173
      // (python -m backend.ports --require-frontend-port); this makes a program
      // that grabs the port after that check a loud error, not a new origin.
      strictPort: true,
      // Bind ALL interfaces (not loopback) so a phone on the LAN can reach the
      // companion (mobile.html + the /api control-bus proxy) while the DESKTOP
      // app is the host. electron-vite/Vite default to localhost-only, which is
      // why the phone got connection-refused whenever the desktop app was open.
      // Never leave this loopback-only.
      host: '0.0.0.0',
      fs: {
        allow: [resolve(__dirname, '../frontend'), resolve(__dirname, '..')]
      },
      // Every target below is the LITERAL 127.0.0.1, never 'localhost'.
      // backend/run.py binds 0.0.0.0 — IPv4 only — while Node's resolver
      // prefers ::1 for 'localhost' on Windows 11. When it does, the proxy
      // cannot connect and answers 502, which the renderer reported as
      // "couldn't reach huggingface.co" (issue #144). This is the DEV path
      // theDAW.bat's desktop mode takes; main/index.ts already pinned the
      // packaged proxy the same way. An address cannot resolve to the wrong
      // family. Keep these in sync with frontend/vite.config.ts.
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8600',
          changeOrigin: true,
          // WebSocket upgrade (xr control bus, questmidi) — without this the
          // proxy silently drops WS connections and the control manifest
          // never reaches consumers (VST-Foundry bindings, XR headset).
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
          // Stamps X-Forwarded-For/-Proto/-Port (matches frontend/vite.config.ts)
          // so the backend can recover the real caller's address instead of
          // this proxy's own loopback peer — see that file's comment for why
          // this matters for loopback-gated routes (LAN2).
          xfwd: true
        },
        // Static VJ build served by the backend (matches frontend/vite.config.ts).
        // Without this the VJ iframe's /vj-app/ request fell through to Vite's
        // SPA fallback, which served the app's own index.html INTO the iframe —
        // the whole app nested inside itself (doubled header) in electron dev.
        '/vj-app': {
          target: 'http://127.0.0.1:8600',
          changeOrigin: true,
          ws: true,
          timeout: 0,
          proxyTimeout: 0
        },
        // Static SwayCommand cockpit served by the backend (matches
        // frontend/vite.config.ts). Missing this does NOT 404 — Vite's SPA
        // fallback serves theDAW's own index.html into the iframe and you
        // see the entire app nested inside itself, which is the single most
        // confusing failure in this pattern.
        '/sway-app': {
          target: 'http://127.0.0.1:8600',
          changeOrigin: true,
          ws: true,
          timeout: 0,
          proxyTimeout: 0
        }
      }
    }
  }
})
