import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, '../frontend/index.html') }
      }
    },
    plugins: [react(), tailwindcss()],
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
      fs: {
        allow: [resolve(__dirname, '../frontend'), resolve(__dirname, '..')]
      },
      proxy: {
        '/api': {
          target: 'http://localhost:8600',
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0
        }
      }
    }
  }
})
