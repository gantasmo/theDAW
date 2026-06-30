/**
 * MAKE (Magenta RT2) live-control bridge.
 *
 * The Magenta instrument runs in a same-origin <iframe> (MagentaToolStage) whose
 * bridge.js recreates the WKWebView host at
 * `window.webkit.messageHandlers.auHost`. Posting `{type:'param', name, value}`
 * sets the bridge's live `state[name]`, which the NEXT generate chunk (~every 4s)
 * reads. So a control move here shapes the next generated chunk, not the audio
 * currently playing: continuous and chunk-rate, not knob-instant. The post is a
 * direct same-origin function call, so no throttling or store mirror is needed.
 *
 * When no instrument is mounted, a move stages into `pending` and flushes to the
 * iframe the moment one registers, so a staged gesture applies when the
 * instrument opens. No engine is ever auto-started from a move.
 *
 * Param keys are the bridge's live state keys (see public/magenta-tools/bridge.js):
 * temperature, topk, cfgmusiccoca, cfgnotes, cfgdrums, drumless, volume, bypass, seed.
 */
type AuHostWindow = Window & {
  webkit?: { messageHandlers?: { auHost?: { postMessage: (m: unknown) => void } } };
};

let target: AuHostWindow | null = null;
const pending: Record<string, number> = {};

function post(win: AuHostWindow, msg: unknown): void {
  try {
    win.webkit?.messageHandlers?.auHost?.postMessage(msg);
  } catch {
    /* iframe torn down between mount and post — non-fatal */
  }
}

/** Register (or clear with null) the mounted Magenta instrument's window. On
 *  register, any staged params are flushed so a gesture made before the
 *  instrument opened takes effect immediately. */
export function registerMakeInstrument(win: Window | null): void {
  target = (win as AuHostWindow | null) ?? null;
  if (target) {
    for (const [name, value] of Object.entries(pending)) post(target, { type: 'param', name, value });
  }
}

/** Set a live Magenta param by its bridge state key (e.g. 'temperature', 'cfgdrums'). */
export function setMakeParam(name: string, value: number): void {
  pending[name] = value;
  if (target) post(target, { type: 'param', name, value });
}

/** Toggle the instrument's play/pause. No-op when nothing is mounted (a gesture
 *  never auto-starts the engine). */
export function toggleMakePlay(): void {
  if (target) post(target, { type: 'togglePlay' });
}

/** Whether a Magenta instrument is currently mounted, so a move will actually sound. */
export function isMakeInstrumentLive(): boolean {
  return target != null;
}
