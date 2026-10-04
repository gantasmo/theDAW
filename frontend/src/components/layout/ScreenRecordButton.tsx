/**
 * The screen recorder's one control, in the header on every tab: a camera that
 * starts a recording of the app's picture and sound, and while one runs a red
 * stop key with the elapsed time. F9 does the same from anywhere in the app.
 * The recorder itself is lib/screenRecorder.ts.
 */
import React, { useEffect, useState } from 'react';
import { Square, Video } from 'lucide-react';
import { topBarButtonClass } from './TopBarButton';
import {
  SCREEN_RECORD_KEY,
  SCREEN_RECORD_TOGGLE_EVENT,
  formatElapsed,
  toggleScreenRecording,
  useScreenRecorder,
} from '../../lib/screenRecorder';

/** The header button's shape, in the red a running recording wears. */
const RECORDING_CLASS =
  'p-1.5 rounded border transition-colors flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-red-300 border-red-500/60 bg-red-500/15 text-red-300 hover:bg-red-500/25';

export function ScreenRecordButton() {
  const status = useScreenRecorder((s) => s.status);
  const startedAtMs = useScreenRecorder((s) => s.startedAtMs);
  const recording = status === 'recording';
  const [elapsedMs, setElapsedMs] = useState(0);

  // The elapsed time, twice a second, only while a recording runs.
  useEffect(() => {
    if (!recording || startedAtMs === null) {
      setElapsedMs(0);
      return undefined;
    }
    const tick = () => setElapsedMs(performance.now() - startedAtMs);
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [recording, startedAtMs]);

  // The hotkey. In a browser the key arrives here. The desktop shell takes the
  // key itself and dispatches the event instead, so a press inside an embedded
  // frame (SWAY, a plugin page) still reaches the recorder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== SCREEN_RECORD_KEY || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      toggleScreenRecording();
    };
    const onToggle = () => toggleScreenRecording();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener(SCREEN_RECORD_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener(SCREEN_RECORD_TOGGLE_EVENT, onToggle);
    };
  }, []);

  const title = recording
    ? `Stop recording (${SCREEN_RECORD_KEY})`
    : status === 'saving'
      ? 'Saving the recording'
      : status === 'starting'
        ? 'Starting the recording'
        : `Record the screen with sound (${SCREEN_RECORD_KEY})`;

  return (
    <button
      type="button"
      onClick={toggleScreenRecording}
      disabled={status === 'starting' || status === 'saving'}
      title={title}
      aria-label={title}
      aria-pressed={recording}
      data-screen-record={status}
      className={recording ? RECORDING_CLASS : `${topBarButtonClass(false)} disabled:opacity-50`}
    >
      {recording ? <Square className="w-3.5 h-3.5 fill-current" /> : <Video className="w-3.5 h-3.5" />}
      {recording && (
        <span className="font-sans text-xs font-bold tabular-nums leading-none">{formatElapsed(elapsedMs)}</span>
      )}
    </button>
  );
}
