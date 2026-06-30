/* ── MRT2 ⇄ theDAW bridge shim ────────────────────────────────────────────────
   The three Magenta RealTime 2 instruments (Collider / Jam / MRT2 standalone)
   were built to run inside a macOS WKWebView whose native host they reach via
   `window.webkit.messageHandlers.auHost.postMessage({type,...})`, and which pushes
   state back into the UI by calling `window.updateState(...)`.

   On Windows there is no WKWebView host. This shim recreates that host in the
   browser: it defines `window.webkit.messageHandlers.auHost` + `window.__HOST_MODE__`
   BEFORE the app bundle evaluates, then translates the UI's control messages into
   calls against theDAW's Magenta sidecar (`/api/magenta/*`) and feeds results back
   through `window.updateState`.

   It MUST be loaded as the first <script> in <head> so the host globals exist
   before the React bundle reads `window.__HOST_MODE__` / captures `window.webkit`.

   Backend contract (backend/modules/magenta/router.py):
     POST /api/magenta/generate  (form) → { ok, job:{ id } }
          fields: prompt, duration, temperature, top_k, cfg_musiccoca, cfg_notes,
                  cfg_drums, drums, chunk_frames, notes(JSON), seed, extend(bool),
                  styles(JSON blend list), model_size, audio_file(upload)
     GET  /api/magenta/jobs/{id} → { status, progress, result, error }
     POST /api/magenta/engine/start | /engine/stop ; GET /engine/status | /probe

   Real-time note: the sidecar generates at ~0.8–1.0 RTF, so "play" buffers
   short chunks (extend=true for gapless continuation) and schedules them in Web
   Audio. It is continuous, not zero-latency. Honest by design.
*/
(function () {
  'use strict';

  // ── host-mode flag the bundle reads at eval time ──────────────────────────
  // "standalone" (not "auv3") → the UI shows its own transport + model surface.
  window.__HOST_MODE__ = 'standalone';

  // gg: the param-index → name map the UI uses for {type:"param"/"range"} msgs.
  // Mirrors the bundle's own table so we decode index-addressed params.
  var PARAM_NAMES = {
    0: 'temperature', 1: 'topk', 3: 'cfgmusiccoca', 4: 'cfgnotes', 5: 'volume',
    6: 'mute', 7: 'unmaskwidth', 8: 'buffersize', 9: 'latencycomp',
    10: 'weight_0', 11: 'weight_1', 12: 'weight_2', 13: 'weight_3',
    14: 'weight_4', 15: 'weight_5', 31: 'resetstate', 32: 'bypass',
    39: 'drumless', 45: 'midigate', 46: 'onsetmode', 47: 'seedrotation',
    48: 'cfgdrums',
  };

  // ── live control state, mapped onto the backend's /generate form ───────────
  var state = {
    temperature: 1.3,
    topk: 40,
    cfgmusiccoca: 3.0,
    cfgnotes: 1.0,
    cfgdrums: 1.0,
    drumless: 0,
    volume: 1.0,
    bypass: 0,
    seed: 0,
  };
  // Up to 6 weighted style slots. text[i] is the prompt for slot i, weight[i]
  // its blend weight. An audio style (from a dropped clip) lives in audioStyle.
  var prompts = ['', '', '', '', '', ''];
  var weights = [1, 0, 0, 0, 0, 0];
  var audioStyle = null; // { audio_b64, weight }

  var MODEL_SIZE = 'small';
  var CHUNK_SECONDS = 4.0; // per-request buffer length while playing
  var FPS = 25;            // sidecar frame rate (chunk_frames = seconds * FPS)
  // Warm generation runs faster than real-time on a GPU (~RTF 1.3 for mrt2_small),
  // but the FIRST chunk still takes ~one chunk's worth of wall time to produce.
  // Start playback one generation behind so the scheduler always has the next
  // chunk ready before the current one ends → gapless continuous playback.
  var PREROLL = CHUNK_SECONDS; // initial latency before sound, in seconds

  // ── Web Audio playback (gapless scheduler) ─────────────────────────────────
  var audioCtx = null;
  var nextStartTime = 0;   // scheduled play head in audioCtx time
  var playing = false;
  var firstChunk = true;   // first chunk of a play session → extend=false
  var loopAbort = null;    // AbortController for the in-flight request

  function ctx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    return audioCtx;
  }

  // ── outbound: send state into the UI ───────────────────────────────────────
  function push(obj) {
    try { if (typeof window.updateState === 'function') window.updateState(obj); }
    catch (e) { console.warn('[mrt2-bridge] updateState threw', e); }
  }

  // Build the styles blend list the sidecar expects from the current prompts.
  function buildStyles() {
    var list = [];
    for (var i = 0; i < 6; i++) {
      var w = Number(weights[i]) || 0;
      var t = (prompts[i] || '').trim();
      if (w > 0 && t) list.push({ type: 'text', text: t, weight: w });
    }
    if (audioStyle) list.push({ type: 'audio', audio_b64: audioStyle.audio_b64, weight: audioStyle.weight });
    return list;
  }

  // The primary text prompt (highest-weight slot) — also sent as `prompt`.
  function primaryPrompt() {
    var best = '', bestW = -1;
    for (var i = 0; i < 6; i++) {
      var w = Number(weights[i]) || 0;
      if (w > bestW && (prompts[i] || '').trim()) { bestW = w; best = prompts[i].trim(); }
    }
    return best;
  }

  // ── one generation chunk: POST /generate → poll job → decode → schedule ────
  function generateChunk() {
    var fd = new FormData();
    fd.append('prompt', primaryPrompt() || 'warm analog pads');
    fd.append('duration', String(CHUNK_SECONDS));
    fd.append('temperature', String(state.temperature));
    fd.append('top_k', String(Math.round(state.topk)));
    fd.append('cfg_musiccoca', String(state.cfgmusiccoca));
    fd.append('cfg_notes', String(state.cfgnotes));
    fd.append('cfg_drums', String(state.cfgdrums));
    fd.append('drums', String(state.drumless ? 0 : -1));
    fd.append('chunk_frames', String(Math.round(CHUNK_SECONDS * FPS)));
    fd.append('seed', String(Math.round(state.seed) || 0));
    fd.append('extend', firstChunk ? 'false' : 'true');
    fd.append('styles', JSON.stringify(buildStyles()));
    fd.append('model_size', MODEL_SIZE);

    loopAbort = new AbortController();
    var t0 = performance.now();

    return fetch('/api/magenta/generate', { method: 'POST', body: fd, signal: loopAbort.signal })
      .then(function (r) {
        if (r.status === 412) {
          return r.json().then(function (j) {
            push({ resourcesMissing: true });
            throw new Error(j && j.message ? j.message : 'Magenta RT2 not installed');
          });
        }
        if (!r.ok) throw new Error('generate HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var jobId = j && j.job && j.job.id;
        if (!jobId) throw new Error('no job id');
        return pollJob(jobId);
      })
      .then(function (wavUrl) {
        if (!wavUrl) return null;
        return fetch(wavUrl, { signal: loopAbort.signal })
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) { return ctx().decodeAudioData(buf); })
          .then(function (fullBuf) {
            // The sidecar's extend mode returns the CUMULATIVE track (the whole
            // evolving piece so far), not just the new chunk. Each call appends
            // exactly CHUNK_SECONDS of new audio, so schedule only that tail —
            // otherwise every loop replays the entire (growing) track on top of
            // itself.
            var audioBuf = firstChunk ? fullBuf : tailBuffer(fullBuf, CHUNK_SECONDS);
            scheduleBuffer(audioBuf);
            pushLevels(audioBuf);
            var compute = (performance.now() - t0) / 1000;
            push({ metrics: { rtf: compute > 0 ? (CHUNK_SECONDS / compute) : 0, lastChunkMs: Math.round(compute * 1000) } });
            firstChunk = false;
          });
      });
  }

  // Poll the job registry until the WAV result url is ready.
  function pollJob(jobId) {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function tick() {
        if (!playing && !firstChunk) { resolve(null); return; }
        fetch('/api/magenta/jobs/' + jobId, { signal: loopAbort ? loopAbort.signal : undefined })
          .then(function (r) { return r.json(); })
          .then(function (s) {
            if (s.status === 'done' || s.status === 'complete' || s.status === 'completed') {
              // router.py shape: result = { batch, item: { audio_base64, mime_type, ... } }
              var item = (s.result && s.result.item) || {};
              var b64 = item.audio_base64 || item.audio_b64 || null;
              var mime = item.mime_type || 'audio/wav';
              resolve(b64 ? ('data:' + mime + ';base64,' + b64) : null);
            } else if (s.status === 'error' || s.status === 'failed') {
              reject(new Error((s.error && s.error.message) || s.error || 'job failed'));
            } else {
              if (s.progress) push({ metrics: { step: s.progress.step, steps: s.progress.steps } });
              if (++tries > 600) { reject(new Error('job timeout')); return; }
              setTimeout(tick, 200);
            }
          })
          .catch(reject);
      })();
    });
  }

  // Return the last `seconds` of an AudioBuffer as a new buffer (the new audio
  // appended by an extend call). Returns the whole buffer if it's shorter.
  function tailBuffer(buf, seconds) {
    var frames = Math.round(seconds * buf.sampleRate);
    if (frames >= buf.length) return buf;
    var start = buf.length - frames;
    var out = ctx().createBuffer(buf.numberOfChannels, frames, buf.sampleRate);
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      out.getChannelData(ch).set(buf.getChannelData(ch).subarray(start));
    }
    return out;
  }

  // Push peak L/R levels from a buffer so the UI's meters show activity.
  function pushLevels(buf) {
    var peakL = 0, peakR = 0;
    var L = buf.getChannelData(0);
    var R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    var step = Math.max(1, Math.floor(L.length / 2000)); // subsample — cheap
    for (var i = 0; i < L.length; i += step) {
      var a = Math.abs(L[i]); if (a > peakL) peakL = a;
      var b = Math.abs(R[i]); if (b > peakR) peakR = b;
    }
    push({ audioLevels: { left: peakL, right: peakR } });
  }

  function scheduleBuffer(audioBuf) {
    var c = ctx();
    var src = c.createBufferSource();
    src.buffer = audioBuf;
    var gain = c.createGain();
    gain.gain.value = state.bypass ? 0 : (Number(state.volume) || 1);
    src.connect(gain).connect(c.destination);
    var now = c.currentTime;
    // First chunk: start one PREROLL ahead so generation stays in front of the
    // playhead. Later underruns (generation briefly fell behind) catch up with a
    // tiny gap rather than stalling.
    if (nextStartTime < now) nextStartTime = now + (firstChunk ? PREROLL : 0.04);
    src.start(nextStartTime);
    nextStartTime += audioBuf.duration;
  }

  // The continuous play loop: keep at most ~2 chunks queued ahead.
  function runLoop() {
    if (!playing) return;
    generateChunk()
      .then(function () { if (playing) runLoop(); })
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;
        console.error('[mrt2-bridge] generate loop error:', e);
        stopPlayback();
      });
  }

  function startPlayback() {
    if (playing) return;
    playing = true;
    firstChunk = true;
    nextStartTime = 0;
    ctx().resume && ctx().resume();
    push({ isPlaying: true });
    runLoop();
  }

  function stopPlayback() {
    playing = false;
    if (loopAbort) { try { loopAbort.abort(); } catch (e) {} loopAbort = null; }
    push({ isPlaying: false });
  }

  // ── inbound: handle a message the UI posted to the (virtual) native host ──
  function handleHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'uiReady':
        // Boot the UI into its play surface: no missing resources, one local
        // model, empty remote list, current params + neutral meters.
        push({
          resourcesMissing: false,
          modelName: 'magenta-' + MODEL_SIZE,
          // localModels is a list of model-name STRINGS (the UI runs each through
          // a `name.endsWith('.mlxfn')` filename normalizer), not objects.
          localModels: ['magenta-' + MODEL_SIZE],
          remoteModels: [],
          isPlaying: false,
          params: stateToParams(),
          metrics: { rtf: 0 },
          audioLevels: { left: 0, right: 0 },
        });
        // Warm the sidecar so the first generate isn't a cold-load stall.
        fetch('/api/magenta/engine/start', { method: 'POST' }).catch(function () {});
        break;

      case 'param':
      case 'range': {
        var name = (typeof msg.index === 'number') ? PARAM_NAMES[msg.index] : (msg.name || msg.param);
        var val = (msg.value !== undefined) ? msg.value : msg.val;
        if (!name) break;
        if (name === 'resetstate') { resetState(); break; }
        if (/^weight_(\d)$/.test(name)) { weights[Number(name.split('_')[1])] = Number(val); break; }
        state[name] = Number(val);
        break;
      }

      case 'prompt':
      case 'text': {
        // single-slot prompt edit: {slot, text} (slot defaults to 0)
        var slot = (typeof msg.slot === 'number') ? msg.slot : (typeof msg.index === 'number' ? msg.index : 0);
        prompts[slot] = String(msg.text != null ? msg.text : (msg.value != null ? msg.value : ''));
        break;
      }

      case 'textPrompts': {
        // full list: {prompts:[{text,weight}, ...]} or string[]
        var arr = msg.prompts || msg.value || [];
        for (var i = 0; i < 6; i++) {
          var p = arr[i];
          if (p == null) { prompts[i] = ''; continue; }
          if (typeof p === 'string') { prompts[i] = p; }
          else { prompts[i] = String(p.text || ''); if (p.weight != null) weights[i] = Number(p.weight); }
        }
        break;
      }

      case 'promptSurfaceState':
        // 2-D morph surface — captured but mapped to weights elsewhere; the
        // weight_* params already carry the resolved blend, so nothing to do.
        break;

      case 'togglePlay':
        if (playing) stopPlayback(); else startPlayback();
        break;

      case 'loadAudioPrompt':
      case 'audioPrefill': {
        var b64 = msg.audio_b64 || msg.data || null;
        if (b64) {
          if (typeof b64 === 'string' && b64.indexOf(',') >= 0 && b64.indexOf('base64') >= 0) b64 = b64.split(',')[1];
          audioStyle = { audio_b64: b64, weight: msg.weight != null ? Number(msg.weight) : 1.0 };
        }
        break;
      }

      case 'clearAudioPrompt':
        audioStyle = null;
        break;

      case 'silentPrefill':
        firstChunk = true;
        fetch('/api/magenta/reset', { method: 'POST' }).catch(function () {});
        break;

      // ── gracefully unsupported on Windows/theDAW (no backend equivalent) ──
      case 'listRemoteModels':
        push({ remoteModels: [] });
        break;
      case 'checkBanks':
        push({ banks: [] });
        break;
      case 'selectModel':
      case 'downloadModel':
      case 'deleteModel':
      case 'initResources':
      case 'resetToFactory':
      case 'loadBank':
      case 'saveBank':
      case 'selectDownloadFolder':
      case 'selectMidiSource':
      case 'kbdNote':
      case 'listener':
      case 'search':
        // no-op: single bundled model, no bank store / external MIDI host here
        break;

      default:
        console.debug('[mrt2-bridge] unhandled host message:', msg.type, msg);
    }
  }

  function stateToParams() {
    var p = {};
    for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) p[k] = state[k];
    for (var i = 0; i < 6; i++) p['weight_' + i] = weights[i];
    return p;
  }

  function resetState() {
    firstChunk = true;
    fetch('/api/magenta/reset', { method: 'POST' }).catch(function () {});
  }

  // ── install the virtual WKWebView host BEFORE the bundle evaluates ─────────
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.auHost = { postMessage: function (msg) { try { handleHostMessage(msg); } catch (e) { console.error('[mrt2-bridge]', e); } } };

  console.info('[mrt2-bridge] installed — Magenta RT2 UI ⇄ /api/magenta');
})();
