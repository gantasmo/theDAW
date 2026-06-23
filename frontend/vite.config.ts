import {alphaTab} from '@coderline/alphatab-vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {createLogger, defineConfig, loadEnv} from 'vite';

// During startup the frontend comes up before the backend binds :8600, so every
// proxied /api request (health, modules, library, assistant, …) fails with
// ECONNREFUSED until it does. Vite logs each one ("[vite] http proxy error: …"),
// which floods the console for 20-30s and looks like a crash. Those are benign
// retries — the app's own loading screen reflects real readiness — so this
// logger drops just that proxy-error noise and passes every other log through.
const quietLogger = createLogger();
const baseError = quietLogger.error.bind(quietLogger);
quietLogger.error = (msg, options) => {
  const s = typeof msg === 'string' ? msg : '';
  if (s.includes('proxy error') || s.includes('ECONNREFUSED')) return;
  baseError(msg, options);
};

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    customLogger: quietLogger,
    // alphaTab() copies the Bravura font + worker/worklet assets and wires
    // their URLs through Vite, so the Score-tab tab viewer needs no manual
    // font configuration. It returns an array of plugins; Vite flattens it.
    plugins: [react(), tailwindcss(), alphaTab()],
    optimizeDeps: {
      // alphaTab resolves its Bravura font and workers via import.meta.url
      // relative to its own dist/. Vite's dep pre-bundling rewrites that to
      // .vite/deps/, where the font does not exist (it 404s to index.html and
      // alphaTab reports "Font Loading Failed"), and the alphaTab() source
      // transform can't reach a pre-bundled copy. Excluding it keeps the
      // font/worker URLs correct in dev.
      exclude: ['@coderline/alphatab'],
    },
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Modern output → less transpilation across the ~3.5k modules.
      target: 'es2022',
      rollupOptions: {
        output: {
          // Split the big, stable leaf vendors into their own long-cached
          // chunks so an app-code edit doesn't bust them, and the main chunk
          // shrinks. `three` is loaded both eagerly (the boot cinematic,
          // LiquidChromeTitle) and lazily (the visualizer), so giving it a
          // dedicated chunk keeps exactly one cached copy and pulls ~600KB out of
          // the entry chunk. (react-force-graph stays code-split via LineageModal.)
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id)) return 'react-vendor';
            if (/[\\/]node_modules[\\/]three[\\/]/.test(id)) return 'three';
            if (/[\\/]node_modules[\\/](@wavesurfer[\\/]react|wavesurfer\.js)[\\/]/.test(id)) return 'wavesurfer';
            if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'icons';
            return undefined;
          },
        },
      },
    },
    server: {
      // Auto-reload is OFF BY DEFAULT so agent edits don't nuke app state.
      // To turn live reload back on: set ENABLE_HMR=true in the environment.
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:8600',
          changeOrigin: true,
          ws: true, // proxy WebSocket upgrades too (e.g. /api/questmidi/ws)
          timeout: 0,
          proxyTimeout: 0,
          configure: (proxy) => {
            proxy.on('error', (_err, _req, res) => {
              // For HTTP errors res is ServerResponse; for WebSocket errors it
              // is a net.Socket (no writeHead). Guard before writing headers.
              const r = res as Record<string, unknown>;
              if (typeof r['writeHead'] === 'function' && !r['headersSent']) {
                (r['writeHead'] as (s: number, h: Record<string, string>) => void)(
                  502, { 'Content-Type': 'application/json' }
                );
                (r['end'] as (b: string) => void)(JSON.stringify({
                  detail: 'Backend unreachable — is the server running on port 8600?',
                }));
              }
            });
          },
        },
      },
      hmr: process.env.ENABLE_HMR === 'true',
      watch: process.env.ENABLE_HMR === 'true' ? undefined : null,
    },
  };
});
