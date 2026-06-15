import './style.css';

const canvas = document.getElementById('vj-canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const trackEl = document.getElementById('track');
const setEl = document.getElementById('set');
const cameraEl = document.getElementById('camera');

const state = {
  playing: false,
  visible: true,
  cameraOn: false,
  cameraStream: null,
  inputs: { mic: true, audio: true, midi: true },
  audio: { bass: 0.08, mid: 0.12, high: 0.16, volume: 0.1 },
  midi: 0,
  trackTitle: 'LIVE VISUALS',
  setName: null,
  setCount: 0,
  controls: {
    intensity: 68,
    bloom: 72,
    warp: 45,
    hue: 62,
    particles: 76,
    scanlines: true,
  },
};

const manifest = [
  { key: 'intensity', label: 'Intensity', kind: 'range', min: 0, max: 100, value: state.controls.intensity },
  { key: 'bloom', label: 'Bloom', kind: 'range', min: 0, max: 100, value: state.controls.bloom },
  { key: 'warp', label: 'Warp', kind: 'range', min: 0, max: 100, value: state.controls.warp },
  { key: 'hue', label: 'Hue', kind: 'range', min: 0, max: 100, value: state.controls.hue },
  { key: 'particles', label: 'Particles', kind: 'range', min: 0, max: 100, value: state.controls.particles },
  { key: 'scanlines', label: 'Scanlines', kind: 'toggle', value: state.controls.scanlines },
];

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function resize() {
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const width = Math.floor(window.innerWidth * dpr);
  const height = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function post(payload) {
  window.parent?.postMessage(payload, '*');
}

function postManifest() {
  post({ type: 'sa3-vj/controls-manifest', manifest, values: state.controls });
}

function postPlayback() {
  post({ type: 'sa3-vj/playback-state', state: state.playing ? 'playing' : 'paused' });
}

async function setCamera(on) {
  if (!on) {
    state.cameraOn = false;
    cameraEl.srcObject = null;
    state.cameraStream?.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
    post({ type: 'sa3-vj/camera-state', on: false });
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    state.cameraStream = stream;
    state.cameraOn = true;
    cameraEl.srcObject = stream;
    await cameraEl.play().catch(() => {});
    post({ type: 'sa3-vj/camera-state', on: true });
  } catch (error) {
    state.cameraOn = false;
    post({
      type: 'sa3-vj/camera-state',
      on: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function loadSet(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  state.setName = typeof data.name === 'string' ? data.name : 'VJ Set';
  state.setCount = items.length || (typeof data.count === 'number' ? data.count : 0);
  const first = items.find((item) => item && typeof item.label === 'string');
  if (first) state.trackTitle = first.label;
  trackEl.textContent = state.trackTitle;
  setEl.textContent = state.setCount > 0 ? `${state.setName} - ${state.setCount}` : '';
  post({ type: 'sa3-vj/set-loaded', count: state.setCount, name: state.setName });
}

function handleMessage(event) {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'sa3-vj/audio-levels':
      if (state.inputs.audio) {
        state.audio = {
          bass: clamp01(data.bass),
          mid: clamp01(data.mid),
          high: clamp01(data.high),
          volume: clamp01(data.volume),
        };
      }
      break;
    case 'sa3-vj/inputs':
      state.inputs = {
        mic: Boolean(data.mic),
        audio: Boolean(data.audio),
        midi: Boolean(data.midi),
      };
      break;
    case 'sa3-vj/midi':
      if (state.inputs.midi) state.midi = 1;
      break;
    case 'sa3-vj/playback':
      state.playing = data.action === 'play';
      postPlayback();
      break;
    case 'sa3-vj/visibility':
      state.visible = data.visible !== false;
      if (state.visible) requestAnimationFrame(draw);
      break;
    case 'sa3-vj/request-controls':
      postManifest();
      break;
    case 'sa3-vj/control-set':
      if (typeof data.key === 'string' && data.key in state.controls) {
        state.controls[data.key] = typeof state.controls[data.key] === 'boolean'
          ? Boolean(data.value)
          : Math.max(0, Math.min(100, Number(data.value) || 0));
        post({ type: 'sa3-vj/control-changed', key: data.key, value: state.controls[data.key] });
      }
      break;
    case 'sa3-vj/load-set':
      loadSet(data);
      break;
    case 'sa3-vj/load-track':
      state.trackTitle = typeof data.label === 'string' ? data.label : 'VJ TRACK';
      trackEl.textContent = state.trackTitle;
      post({ type: 'sa3-vj/set-loaded', count: 1, name: state.trackTitle });
      break;
    case 'sa3-vj/track-meta':
      if (typeof data.title === 'string' && data.title.trim()) {
        state.trackTitle = data.title;
        trackEl.textContent = state.trackTitle;
      }
      state.playing = Boolean(data.isPlaying);
      postPlayback();
      break;
    case 'sa3-vj/camera':
      void setCamera(Boolean(data.on));
      break;
  }
}

function draw(now = 0) {
  if (!state.visible) return;
  resize();

  const width = window.innerWidth;
  const height = window.innerHeight;
  const controls = state.controls;
  const pulse = state.playing ? 1 : 0.38;
  const energy = Math.max(state.audio.volume, state.audio.bass * 0.8, state.midi * 0.9) * pulse;
  const hue = (controls.hue * 3.6 + now * 0.015) % 360;
  const warp = controls.warp / 100;
  const intensity = controls.intensity / 100;
  const bloom = controls.bloom / 100;

  state.midi *= 0.9;
  state.audio.bass = state.audio.bass * 0.965 + 0.035 * 0.08;
  state.audio.mid = state.audio.mid * 0.965 + 0.035 * 0.1;
  state.audio.high = state.audio.high * 0.965 + 0.035 * 0.12;
  state.audio.volume = state.audio.volume * 0.965 + 0.035 * 0.08;

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, `hsl(${(hue + 220) % 360} 42% 5%)`);
  bg.addColorStop(0.5, `hsl(${(hue + 290) % 360} 52% 7%)`);
  bg.addColorStop(1, `hsl(${(hue + 30) % 360} 48% 4%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  if (state.cameraOn && cameraEl.readyState >= 2) {
    ctx.globalAlpha = 0.18 + energy * 0.22;
    ctx.drawImage(cameraEl, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(Math.sin(now * 0.00012) * 0.12);
  const rings = 11;
  for (let r = rings; r >= 1; r -= 1) {
    const radius = Math.min(width, height) * (0.045 + r * 0.045) * (1 + energy * 0.18);
    ctx.beginPath();
    for (let i = 0; i <= 240; i += 1) {
      const a = (i / 240) * Math.PI * 2;
      const wave = Math.sin(a * (3 + r) + now * 0.0015 + r) * warp;
      const kick = Math.sin(a * 7 - now * 0.002) * state.audio.bass * 0.7;
      const rr = radius * (1 + wave * 0.11 + kick);
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr * (0.58 + state.audio.mid * 0.5);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = `hsla(${(hue + r * 17) % 360} 92% ${58 + bloom * 22}% / ${0.08 + intensity * 0.055})`;
    ctx.lineWidth = 1 + bloom * 3 + energy * 6;
    ctx.shadowBlur = 16 + bloom * 34;
    ctx.shadowColor = `hsl(${(hue + r * 20) % 360} 95% 64%)`;
    ctx.stroke();
  }
  ctx.restore();

  const bars = 96;
  const barWidth = width / bars;
  for (let i = 0; i < bars; i += 1) {
    const phase = i / bars;
    const band = phase < 0.2 ? state.audio.bass : phase < 0.55 ? state.audio.mid : state.audio.high;
    const h = (Math.sin(phase * Math.PI * 9 + now * 0.003) * 0.5 + 0.5) * height * 0.16;
    const y = height - 38 - h * (0.35 + band * 3.2 + intensity);
    ctx.fillStyle = `hsla(${(hue + phase * 140) % 360} 90% 62% / ${0.2 + band * 0.58})`;
    ctx.fillRect(i * barWidth, y, Math.max(1, barWidth - 2), height - y);
  }

  const count = Math.floor((controls.particles / 100) * 140);
  ctx.shadowBlur = 18 + bloom * 22;
  for (let i = 0; i < count; i += 1) {
    const a = i * 2.399 + now * 0.00018;
    const d = ((i * 37) % 100) / 100;
    const radius = d * Math.max(width, height) * (0.32 + energy * 0.28);
    const x = width / 2 + Math.cos(a) * radius + Math.sin(now * 0.0005 + i) * 24 * warp;
    const y = height / 2 + Math.sin(a * 0.87) * radius * 0.62;
    const size = 1.2 + ((i % 7) / 7) * 3 + energy * 8;
    ctx.fillStyle = `hsla(${(hue + i * 11) % 360} 96% 68% / ${0.18 + d * 0.42})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  if (controls.scanlines) {
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);
  }

  requestAnimationFrame(draw);
}

window.addEventListener('resize', resize);
window.addEventListener('message', handleMessage);
window.addEventListener('load', () => {
  resize();
  postManifest();
  postPlayback();
  requestAnimationFrame(draw);
});
