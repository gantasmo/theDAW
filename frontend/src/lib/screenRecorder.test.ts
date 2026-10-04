/**
 * The screen recorder (lib/screenRecorder.ts): the file type it picks, the
 * name it saves under, the elapsed readout, and one whole recording driven
 * through fake capture and encoder objects: start, stop, one file saved, the
 * capture released.
 *
 *   cd frontend && node node_modules/tsx/dist/cli.mjs src/lib/screenRecorder.test.ts
 */
import assert from 'node:assert/strict';
import {
  formatElapsed,
  pickRecordingMime,
  recordingExtension,
  recordingFilename,
  setScreenRecorderDeps,
  startScreenRecording,
  stopScreenRecording,
  toggleScreenRecording,
  useScreenRecorder,
  type ScreenRecorderDeps,
} from './screenRecorder.ts';

// The file type: WebM with VP9 and Opus first, MP4 only when no WebM is on offer.
assert.equal(pickRecordingMime(() => true), 'video/webm;codecs=vp9,opus');
assert.equal(pickRecordingMime((m) => m !== 'video/webm;codecs=vp9,opus'), 'video/webm;codecs=vp8,opus');
assert.equal(pickRecordingMime((m) => m === 'video/webm'), 'video/webm');
assert.equal(pickRecordingMime((m) => m.startsWith('video/mp4')), 'video/mp4;codecs=avc1.640028,mp4a.40.2');
assert.equal(pickRecordingMime(() => false), null);
assert.equal(pickRecordingMime(() => { throw new Error('unknown type'); }), null);
assert.equal(recordingExtension('video/mp4;codecs=avc1.640028,mp4a.40.2'), 'mp4');
assert.equal(recordingExtension('video/webm;codecs=vp9,opus'), 'webm');

// The name: local date and time, sortable, no characters a file system refuses.
assert.equal(recordingFilename(new Date(2026, 9, 1, 14, 5, 9), 'mp4'), 'theDAW-screen-2026-10-01_14-05-09.mp4');

// The elapsed readout.
assert.equal(formatElapsed(0), '0:00');
assert.equal(formatElapsed(59_999), '0:59');
assert.equal(formatElapsed(61_000), '1:01');
assert.equal(formatElapsed(3_723_000), '1:02:03');
assert.equal(formatElapsed(Number.NaN), '0:00');

// One whole recording.
interface FakeTrack { stopped: boolean; stop(): void; addEventListener(): void }
const track = (): FakeTrack => ({ stopped: false, stop() { this.stopped = true; }, addEventListener() { /* never ends by itself */ } });

function rig(overrides: Partial<ScreenRecorderDeps> = {}) {
  const video = track();
  const audio = track();
  const stream = {
    getTracks: () => [video, audio],
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  } as unknown as MediaStream;
  const saved: { blob: Blob; filename: string }[] = [];
  const recorderOptions: MediaRecorderOptions[] = [];
  const deps: ScreenRecorderDeps = {
    getDisplayMedia: async () => stream,
    isTypeSupported: (m) => m === 'video/webm;codecs=vp9,opus',
    createRecorder: (_s, options) => {
      recorderOptions.push(options);
      const rec = {
        state: 'inactive',
        ondataavailable: null as ((e: { data: Blob }) => void) | null,
        onstop: null as (() => void) | null,
        onerror: null,
        start() { rec.state = 'recording'; },
        stop() {
          rec.state = 'inactive';
          rec.ondataavailable?.({ data: new Blob(['frames']) });
          rec.onstop?.();
        },
      };
      return rec as unknown as MediaRecorder;
    },
    save: async (blob, filename) => { saved.push({ blob, filename }); },
    now: () => new Date(2026, 9, 1, 14, 5, 9),
    clock: () => 1000,
    ...overrides,
  };
  setScreenRecorderDeps(deps);
  return { video, audio, saved, recorderOptions };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

{
  const r = rig();
  assert.equal(useScreenRecorder.getState().status, 'idle');
  await startScreenRecording();
  assert.equal(useScreenRecorder.getState().status, 'recording');
  assert.equal(useScreenRecorder.getState().startedAtMs, 1000);
  assert.equal(r.recorderOptions[0].mimeType, 'video/webm;codecs=vp9,opus', 'the recorder gets the type the encoder offers');
  // A second start while one runs does nothing.
  await startScreenRecording();
  assert.equal(r.recorderOptions.length, 1);

  stopScreenRecording();
  await settle();
  assert.equal(useScreenRecorder.getState().status, 'idle');
  assert.equal(r.saved.length, 1, 'one file per recording');
  assert.equal(r.saved[0].filename, 'theDAW-screen-2026-10-01_14-05-09.webm');
  assert.equal(r.saved[0].blob.type, 'video/webm');
  assert.ok(r.saved[0].blob.size > 0);
  assert.ok(r.video.stopped && r.audio.stopped, 'the capture is released');

  // Stop with nothing running does nothing.
  stopScreenRecording();
  await settle();
  assert.equal(r.saved.length, 1);
}

// The toggle starts when idle and stops when recording.
{
  const r = rig();
  toggleScreenRecording();
  await settle();
  assert.equal(useScreenRecorder.getState().status, 'recording');
  toggleScreenRecording();
  await settle();
  assert.equal(useScreenRecorder.getState().status, 'idle');
  assert.equal(r.saved.length, 1);
}

// A capture the user declines leaves the recorder idle and saves nothing.
{
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const r = rig({ getDisplayMedia: async () => { throw denied; } });
  await startScreenRecording();
  assert.equal(useScreenRecorder.getState().status, 'idle');
  assert.equal(r.saved.length, 0);
}

// No encoder: the capture is released and the recorder stays idle.
{
  const r = rig({ isTypeSupported: () => false });
  await startScreenRecording();
  assert.equal(useScreenRecorder.getState().status, 'idle');
  assert.ok(r.video.stopped && r.audio.stopped);
}

setScreenRecorderDeps(null);
console.log('screenRecorder: ok');
