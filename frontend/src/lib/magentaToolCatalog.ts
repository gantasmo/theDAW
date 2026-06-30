/* ── Magenta RealTime 2 tool catalog ────────────────────────────────────────
   The three MRT2 instruments shipped as self-contained web UIs under
   frontend/public/magenta-tools/<id>/index.html. Each is the EXACT Google UI
   (Collider / Jam / MRT2 standalone) embedded verbatim in an <iframe>; a bridge
   shim (public/magenta-tools/bridge.js, injected as the first <head> script)
   recreates the macOS WKWebView host and routes the UI's control messages to
   theDAW's Magenta sidecar (/api/magenta/*). See MagentaToolStage. */

export interface MagentaTool {
  id: string;       // folder under /magenta-tools/<id>/
  name: string;
  color: string;    // accent (hex)
  desc: string;
  /** ModuleThumb renderer key (reuse an existing canvas thumbnail). */
  preview: string;
}

export const MAGENTA_TOOLS: MagentaTool[] = [
  {
    id: 'mrt2',
    name: 'MRT2',
    color: '#22d3ee',
    desc: 'Real-time prompt/style music generation — the core Magenta RT2 instrument',
    preview: 'promptfx',
  },
  {
    id: 'jam',
    name: 'Jam',
    color: '#34d399',
    desc: 'Continuous jam — generate & extend a live evolving track',
    preview: 'granular',
  },
  {
    id: 'collider',
    name: 'Collider',
    color: '#a855f7',
    desc: 'Style collision — blend & morph multiple weighted style embeddings',
    preview: 'vocoder',
  },
];

export const magentaToolById: Record<string, MagentaTool> = Object.fromEntries(
  MAGENTA_TOOLS.map((t) => [t.id, t]),
);
