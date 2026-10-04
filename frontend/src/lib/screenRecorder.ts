/**
 * Screen recorder: the app's own picture and sound into one video file.
 *
 * One `getDisplayMedia` stream goes into one `MediaRecorder`, which encodes in
 * real time with the browser's own encoder (hardware where the machine has
 * one), so recording costs no extra pass and no second copy of the frames.
 *
 * Where the stream comes from:
 *   - Desktop app: the main process grants the requesting frame its own
 *     content and audio (`setDisplayMediaRequestHandler` in
 *     electron-ui/main/index.ts), with local echo on, so there is no picker and
 *     the sound stays audible while it is captured.
 *   - Browser: Chrome asks which surface to share, offering this tab first with
 *     its audio.
 *
 * The file is WebM (VP9 + Opus); RECORDING_MIME_PREFERENCE says why MP4 is the
 * last resort. It is saved through the same download path a finished take
 * uses: in the desktop app that is the Downloads folder with no dialog, and the
 * saved path lands in the LOG and the Recent menus (App.tsx `onDownloadDone`).
 *
 * `ScreenRecordButton` is the one control; F9 toggles it.
 */
import { create } from 'zustand';
import { logError, logInfo, logWarn } from '../state/logStore';

export type ScreenRecordStatus = 'idle' | 'starting' | 'recording' | 'saving';

interface ScreenRecorderState {
  status: ScreenRecordStatus;
  /** `performance.now()` when the recorder started, while recording. */
  startedAtMs: number | null;
}

export const useScreenRecorder = create<ScreenRecorderState>(() => ({ status: 'idle', startedAtMs: null }));

/** The event the desktop shell dispatches for the hotkey (it swallows the key
 *  itself so the press reaches the app whichever frame has focus). */
export const SCREEN_RECORD_TOGGLE_EVENT = 'thedaw:screen-record-toggle';
/** The key that starts and stops a recording. */
export const SCREEN_RECORD_KEY = 'F9';

/**
 * Containers and codecs, in the order they are tried.
 *
 * WebM comes first. Measured on the desktop app's Electron 44.4.5 (Chromium
 * 152) on 2026-10-01: MP4 (H.264 + AAC) files from MediaRecorder decoded with
 * macroblock errors in 9 of 24 recordings, and in every recording where the
 * window was resized while it ran. WebM decoded clean in all 25, VP9 through a
 * resize included. MP4 stays at the end for a browser that writes nothing else.
 */
export const RECORDING_MIME_PREFERENCE: readonly string[] = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4',
];

/** The first type the recorder can write, or null when it can write none. */
export function pickRecordingMime(isSupported: (mime: string) => boolean): string | null {
  for (const mime of RECORDING_MIME_PREFERENCE) {
    try {
      if (isSupported(mime)) return mime;
    } catch {
      // A browser that throws on an unknown type just does not have it.
    }
  }
  return null;
}

/** The file extension of a recording type. */
export function recordingExtension(mime: string): 'mp4' | 'webm' {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

const two = (n: number): string => String(n).padStart(2, '0');

/** `theDAW-screen-2026-10-01_14-05-09.mp4`, in local time. */
export function recordingFilename(now: Date, ext: string): string {
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
  return `theDAW-screen-${day}_${time}.${ext}`;
}

/** Elapsed time as `m:ss`, or `h:mm:ss` from one hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Bit rates: sharp text at 1080p, and audio a mix can be judged by. */
const VIDEO_BITS_PER_SECOND = 8_000_000;
const AUDIO_BITS_PER_SECOND = 192_000;
/** How often the recorder hands over what it has encoded. */
const CHUNK_MS = 1000;

/** What the recorder needs from its surroundings; a test swaps these. */
export interface ScreenRecorderDeps {
  getDisplayMedia: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
  isTypeSupported: (mime: string) => boolean;
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  save: (blob: Blob, filename: string) => Promise<void>;
  now: () => Date;
  clock: () => number;
}

/** Save through an `<a download>`. The desktop app is told the name first, so
 *  its download handler writes the file straight into Downloads. */
async function saveThroughDownload(blob: Blob, filename: string): Promise<void> {
  const api = (window as unknown as {
    electronAPI?: { markAutomaticDownloads?: (names: string[]) => Promise<void> };
  }).electronAPI;
  if (api?.markAutomaticDownloads) await api.markAutomaticDownloads([filename]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The download reads the blob after the click returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const browserDeps = (): ScreenRecorderDeps => ({
  getDisplayMedia: (options) => navigator.mediaDevices.getDisplayMedia(options),
  isTypeSupported: (mime) => MediaRecorder.isTypeSupported(mime),
  createRecorder: (stream, options) => new MediaRecorder(stream, options),
  save: saveThroughDownload,
  now: () => new Date(),
  clock: () => performance.now(),
});

let deps: ScreenRecorderDeps | null = null;
const getDeps = (): ScreenRecorderDeps => (deps ??= browserDeps());

/** Swap the recorder's surroundings (tests). Null puts the browser's back. */
export function setScreenRecorderDeps(next: ScreenRecorderDeps | null): void {
  deps = next;
}

interface ActiveRecording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  mime: string;
}
let active: ActiveRecording | null = null;

const setState = (status: ScreenRecordStatus, startedAtMs: number | null = null): void =>
  useScreenRecorder.setState({ status, startedAtMs });

/** Start recording. Does nothing unless the recorder is idle. */
export async function startScreenRecording(): Promise<void> {
  if (useScreenRecorder.getState().status !== 'idle') return;
  const d = getDeps();
  setState('starting');
  let stream: MediaStream;
  try {
    stream = await d.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      // Stereo, with the voice-call processing off. A bare `audio: true` came
      // back as one channel (measured in the desktop app, 2026-10-01).
      audio: { channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chrome in a browser: offer this tab first, with its sound.
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      systemAudio: 'include',
    } as DisplayMediaStreamOptions);
  } catch (e) {
    setState('idle');
    // Closing the browser's picker is a choice, not a failure.
    if (e instanceof Error && e.name === 'NotAllowedError') logWarn('files', 'Screen recording was not started.');
    else logError('files', `Screen recording could not start: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const mime = pickRecordingMime(d.isTypeSupported);
  if (!mime) {
    stream.getTracks().forEach((t) => t.stop());
    setState('idle');
    logError('files', 'Screen recording could not start: this browser cannot encode video.');
    return;
  }
  const chunks: Blob[] = [];
  let recorder: MediaRecorder;
  try {
    recorder = d.createRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    setState('idle');
    logError('files', `Screen recording could not start: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const session: ActiveRecording = { recorder, stream, chunks, mime };
  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  recorder.onstop = () => { void finishRecording(session); };
  recorder.onerror = () => {
    logError('files', 'Screen recording stopped: the encoder reported an error.');
    stopScreenRecording();
  };
  // The capture can end from outside (the browser's own "Stop sharing" bar).
  for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => stopScreenRecording());
  active = session;
  recorder.start(CHUNK_MS);
  setState('recording', d.clock());
  if (stream.getAudioTracks().length === 0) logWarn('files', 'Screen recording has no sound: the capture came without audio.');
  logInfo('files', `Screen recording started (${recordingExtension(mime)}).`);
}

/** Stop recording and save the file. Does nothing unless recording. */
export function stopScreenRecording(): void {
  const session = active;
  if (!session || useScreenRecorder.getState().status !== 'recording') return;
  setState('saving');
  try {
    if (session.recorder.state !== 'inactive') session.recorder.stop();
    else void finishRecording(session);
  } catch {
    void finishRecording(session);
  }
}

async function finishRecording(session: ActiveRecording): Promise<void> {
  if (active !== session) return; // already finished
  active = null;
  session.stream.getTracks().forEach((t) => t.stop());
  const d = getDeps();
  try {
    const blob = new Blob(session.chunks, { type: session.mime.split(';')[0] });
    if (blob.size === 0) {
      logWarn('files', 'Screen recording was empty; nothing was saved.');
      return;
    }
    const filename = recordingFilename(d.now(), recordingExtension(session.mime));
    await d.save(blob, filename);
    logInfo('files', `Screen recording saved as ${filename}`);
  } catch (e) {
    logError('files', `Screen recording could not be saved: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setState('idle');
  }
}

/** Start when idle, stop when recording. */
export function toggleScreenRecording(): void {
  const { status } = useScreenRecorder.getState();
  if (status === 'idle') void startScreenRecording();
  else if (status === 'recording') stopScreenRecording();
}
