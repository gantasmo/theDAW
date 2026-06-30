import React, { useEffect, useRef, useState } from 'react';
import { Music } from 'lucide-react';
import type { MagentaTool } from '../../lib/magentaToolCatalog';
import { registerMakeInstrument } from '../../state/makeBridge';

/* ── MagentaToolStage ────────────────────────────────────────────────────────
   Mounts a Magenta RealTime 2 instrument (Collider / Jam / MRT2 standalone) in
   an <iframe> filling the whole stage. The UI is the EXACT Google web app served
   from /magenta-tools/<id>/index.html; its first <head> script (bridge.js)
   recreates the macOS WKWebView host (window.webkit.messageHandlers.auHost +
   window.updateState) and routes generate/continue control messages to theDAW's
   Magenta sidecar (/api/magenta/*). Same-origin, so the iframe's fetches hit the
   same backend the rest of the app uses. No audio is pushed in — these tools
   GENERATE audio (they don't process a source); the bridge plays it via Web
   Audio inside the iframe. */

const FILL_CSS = `
  html,body{width:100%!important;height:100%!important;margin:0!important;padding:0!important;display:block!important;overflow:hidden!important;background:#07080c!important;position:relative!important}
`;

export const MagentaToolStage: React.FC<{
  tool: MagentaTool | null;
  className?: string;
}> = ({ tool, className }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [, setLoaded] = useState(false);

  const handleLoad = () => {
    // Make the instrument fill the stage; it redraws responsively via its rAF loops.
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc && !doc.querySelector('style[data-thedaw="fill"]')) {
        const style = doc.createElement('style');
        style.setAttribute('data-thedaw', 'fill');
        style.textContent = FILL_CSS;
        doc.head?.appendChild(style);
        try { doc.defaultView?.dispatchEvent(new Event('resize')); } catch { /* ignore */ }
      }
    } catch { /* cross-origin guard — same-origin in practice */ }
    // Hand the instrument's window to the MAKE bridge so SWAY and an XR headset
    // can drive its live generation params. Cleared when the tool changes or the
    // stage unmounts (the effect cleanup below).
    try { registerMakeInstrument(iframeRef.current?.contentWindow ?? null); } catch { /* ignore */ }
    setLoaded(true);
  };

  useEffect(() => {
    setLoaded(false);
    return () => { registerMakeInstrument(null); };
  }, [tool?.id]);

  if (!tool) {
    return (
      <div className={`h-full w-full min-h-0 flex flex-col items-center justify-center gap-2 text-center px-4 ${className ?? ''}`}>
        <Music className="w-6 h-6 text-zinc-700" />
        <span className="text-[11px] text-zinc-500">Pick a Magenta tool to open its instrument here.</span>
        <span className="text-[9px] font-mono text-zinc-600">Collider · Jam · MRT2 · live generation via the Windows sidecar</span>
      </div>
    );
  }

  return (
    <div className={`h-full w-full min-h-0 overflow-hidden bg-[#07080c] ${className ?? ''}`}>
      <iframe
        ref={iframeRef}
        key={tool.id}
        src={`/magenta-tools/${tool.id}/index.html`}
        title={tool.name}
        onLoad={handleLoad}
        allow="autoplay"
        className="w-full h-full border-0 block"
      />
    </div>
  );
};
