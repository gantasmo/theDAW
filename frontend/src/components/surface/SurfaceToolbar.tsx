/**
 * Floating Design-Mode toolbar (generalized from the DJ DesignToolbar). Entering
 * Design Mode is now driven by the global top-header "Edit Layout" button, so
 * out of Design Mode this renders nothing. In Design Mode it offers Add Panel,
 * Copy (layout JSON to clipboard, to bake a new default), Reset, and Done.
 * Reads/writes the surface's own store instance through context; Done clears the
 * global edit-layout flag (the single source of truth) which mirrors back here.
 */
import React, { useState } from 'react';
import { Plus, Copy, RotateCcw, Check, Move, Undo2, Redo2, Save, Crosshair, FlipHorizontal2 } from 'lucide-react';
import { useSurface } from './surfaceContext';
import { useEditLayoutStore } from '../../state/editLayoutStore';

export const SurfaceToolbar: React.FC = () => {
  const { store } = useSurface();
  const design = store((s) => s.designMode);
  const canUndo = store((s) => s.past.length > 0);
  const canRedo = store((s) => s.future.length > 0);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const addPanel = () => {
    const { layout, addPanel: add, splitPanel } = store.getState();
    const root = layout.nodes[layout.root];
    if (root && root.type === 'container') add(layout.root, root.children.length);
    else splitPanel(layout.root, 'row');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(store.getState().exportJSON());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  if (!design) return null;

  return (
    <div className="absolute top-1.5 right-2 z-60 flex items-center gap-1.5 px-2 py-1 rounded border border-purple-400/50 bg-[#150f22]/95 shadow-xl">
      <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-purple-200">
        <Move className="w-3 h-3" /> Design
      </span>
      <span className="text-[8px] font-mono text-zinc-500 max-w-40 leading-tight">
        drag controls + panels · Ctrl+Z undo · Ctrl+S save
      </span>
      <button
        onClick={() => store.getState().undo()}
        disabled={!canUndo}
        className="grid place-items-center w-6 h-6 rounded border border-white/10 text-zinc-300 enabled:hover:text-purple-200 enabled:hover:border-purple-400/50 disabled:opacity-30"
        title="Undo (Ctrl+Z)"
      >
        <Undo2 className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().redo()}
        disabled={!canRedo}
        className="grid place-items-center w-6 h-6 rounded border border-white/10 text-zinc-300 enabled:hover:text-purple-200 enabled:hover:border-purple-400/50 disabled:opacity-30"
        title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
      >
        <Redo2 className="w-3 h-3" />
      </button>
      <button
        onClick={addPanel}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-purple-200 hover:border-purple-400/50 text-[8px] font-bold uppercase tracking-wider"
        title="Add an empty panel"
      >
        <Plus className="w-3 h-3" /> Panel
      </button>
      <button
        onClick={() => store.getState().centerHero()}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-amber-200 hover:border-amber-400/50 text-[8px] font-bold uppercase tracking-wider"
        title="Balance the layout symmetrically — centre the hero (equalize each row/column around its middle)"
      >
        <Crosshair className="w-3 h-3" /> Center
      </button>
      <button
        onClick={() => store.getState().mirrorSide('left')}
        className="grid place-items-center w-6 h-6 rounded border border-white/10 text-zinc-300 hover:text-amber-200 hover:border-amber-400/50"
        title="Mirror the LEFT side onto the right (left is the base)"
      >
        <FlipHorizontal2 className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().mirrorSide('right')}
        className="grid place-items-center w-6 h-6 rounded border border-white/10 text-zinc-300 hover:text-amber-200 hover:border-amber-400/50"
        title="Mirror the RIGHT side onto the left (right is the base)"
      >
        <FlipHorizontal2 className="w-3 h-3 -scale-x-100" />
      </button>
      <button
        onClick={() => void copy()}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-cyan-200 hover:border-cyan-400/50 text-[8px] font-bold uppercase tracking-wider"
        title="Copy layout JSON (to bake in as the default)"
      >
        <Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        onClick={() => {
          store.getState().saveAsDefault();
          setSaved(true);
          window.setTimeout(() => setSaved(false), 1400);
        }}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-emerald-200 hover:border-emerald-400/50 text-[8px] font-bold uppercase tracking-wider"
        title="Save the current layout as the default this surface resets to (Ctrl+S)"
      >
        <Save className="w-3 h-3" /> {saved ? 'Saved' : 'Save'}
      </button>
      <button
        onClick={() => store.getState().reset()}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-rose-300 hover:border-rose-400/50 text-[8px] font-bold uppercase tracking-wider"
        title="Reset to the saved/shipped default layout"
      >
        <RotateCcw className="w-3 h-3" /> Reset
      </button>
      <button
        onClick={() => useEditLayoutStore.getState().setActive(false)}
        className="flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 text-[8px] font-black uppercase tracking-wider"
        title="Exit Design Mode"
      >
        <Check className="w-3 h-3" /> Done
      </button>
    </div>
  );
};
