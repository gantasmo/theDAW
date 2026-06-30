/**
 * Quantum Lattice engine — a framework-agnostic port of the "Quantum Sacred
 * Geometry" high-energy shader engine (instanced node/beam lattice that morphs
 * between Torus / Cube / Star / Cage, with bloom + dithering post). The original
 * was a single-file three.js page bound to window/document; this class owns a
 * caller-supplied canvas, takes its own width/height, and exposes a full live
 * parameter surface so it can drive both the in-app Visualize tab and (copied
 * into the VJ tree) a captureStream camera source.
 *
 * Parameters: every control is declared once in QUANTUM_PARAMS (id/label/group/
 * range/default + optional default audio band). `resolveQuantumParams()` merges
 * UI overrides into a flat config the engine consumes each frame. Audio
 * reactivity mirrors the VJ shader system: bands are envelope-followed (fast
 * attack / slow release), each param eases toward `base + range*amt*level*drive`,
 * clamped to its range. With no audio the params sit at their slider value.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export interface QuantumLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

export interface QuantumStats {
  geomName: string;
  stability: number;
  fps: number;
  resonance: number;
  phasePercent: number;
  /** Currently active geometry index (may auto-advance when beat-cycle is on). */
  shape: number;
}

export interface QuantumOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Device pixel ratio cap. Defaults to min(devicePixelRatio, 2); offscreen
   *  capture sources pass 1 to keep the captured buffer at its nominal size. */
  pixelRatio?: number;
  /** Attach OrbitControls (in-app interactive view). Off for offscreen capture. */
  interactive?: boolean;
  /** Optional audio drive; returns 0..1 bands. */
  getLevels?: () => QuantumLevels;
  /** Optional HUD callback (geometry name, stability %, fps, resonance). */
  onStats?: (s: QuantumStats) => void;
  /** Fired the instant a hard hit auto-advances the geometry (beat-cycle on). */
  onShape?: (shapeIndex: number) => void;
}

export const QUANTUM_GEOMETRY_NAMES = ['Grand Torus', 'Cubic Frame', 'Merkabah Star', 'Cosmos Cage'];
export const QUANTUM_PALETTES = ['Quantum', 'Oceanic', 'Inferno', 'Glacier'];

/* ── parameter catalogue ──────────────────────────────────────────────────── */

export type QuantumAudioBand = 'none' | 'bass' | 'mid' | 'high' | 'volume';

export interface QuantumParamDef {
  id: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Default audio band that modulates this param (user can override). */
  audio?: QuantumAudioBand;
  /** Audio depth as a fraction of (max-min). Default 0.3. */
  audioAmt?: number;
  /** Bipolar slider (centre = 0), e.g. auto-rotate direction. */
  bipolar?: boolean;
}

/** Every live-tunable parameter, grouped. Audio defaults make it react out of
 *  the box; OFF bands leave a param as a plain slider. */
export const QUANTUM_PARAMS: QuantumParamDef[] = [
  // Motion
  { id: 'waveSpeed', label: 'Wave Speed', group: 'Motion', min: 0.2, max: 3.5, step: 0.05, default: 1.2, audio: 'mid', audioAmt: 0.35 },
  { id: 'morphAmount', label: 'Morph Push', group: 'Motion', min: 0, max: 0.6, step: 0.01, default: 0.15, audio: 'bass', audioAmt: 0.5 },
  { id: 'autoRotate', label: 'Auto-Spin', group: 'Motion', min: -1.5, max: 1.5, step: 0.05, default: 0, audio: 'none', bipolar: true },
  // Glow & Post
  { id: 'bloomStrength', label: 'Bloom', group: 'Glow & Post', min: 0, max: 2.5, step: 0.05, default: 0.2, audio: 'volume', audioAmt: 0.35 },
  { id: 'bloomRadius', label: 'Bloom Radius', group: 'Glow & Post', min: 0, max: 1, step: 0.05, default: 0.35, audio: 'none' },
  { id: 'bloomThreshold', label: 'Bloom Thresh', group: 'Glow & Post', min: 0, max: 1, step: 0.05, default: 0.82, audio: 'none' },
  { id: 'dither', label: 'Dither', group: 'Glow & Post', min: 0, max: 0.06, step: 0.002, default: 0.012, audio: 'high', audioAmt: 0.3 },
  { id: 'exposure', label: 'Exposure', group: 'Glow & Post', min: 0.4, max: 2.2, step: 0.05, default: 0.85, audio: 'none' },
  { id: 'vignette', label: 'Vignette', group: 'Glow & Post', min: 0, max: 2, step: 0.05, default: 1.1, audio: 'none' },
  { id: 'fog', label: 'Fog', group: 'Glow & Post', min: 0, max: 0.1, step: 0.005, default: 0.025, audio: 'none' },
  // Structure
  { id: 'nodeScale', label: 'Node Size', group: 'Structure', min: 0.2, max: 2.5, step: 0.05, default: 1, audio: 'bass', audioAmt: 0.3 },
  { id: 'beamScale', label: 'Beam Width', group: 'Structure', min: 0.2, max: 3, step: 0.05, default: 1, audio: 'none' },
  { id: 'coreScale', label: 'Core Size', group: 'Structure', min: 0.3, max: 2.2, step: 0.05, default: 1, audio: 'none' },
  // Camera
  { id: 'cameraDist', label: 'Camera Dist', group: 'Camera', min: 0.4, max: 2.5, step: 0.05, default: 1, audio: 'none' },
  { id: 'cameraFov', label: 'Field of View', group: 'Camera', min: 20, max: 90, step: 1, default: 45, audio: 'none' },
  // Detail (promoted GLSL uniforms)
  { id: 'gridIntensity', label: 'Grid Glow', group: 'Detail', min: 0, max: 1.2, step: 0.05, default: 0.45, audio: 'high', audioAmt: 0.4 },
  { id: 'waveDetail', label: 'Filament Detail', group: 'Detail', min: 0.3, max: 3, step: 0.05, default: 1, audio: 'mid', audioAmt: 0.3 },
  { id: 'beamFresnel', label: 'Beam Edge', group: 'Detail', min: 1, max: 5, step: 0.25, default: 3, audio: 'none' },
  { id: 'nodeFresnel', label: 'Node Edge', group: 'Detail', min: 1, max: 4, step: 0.25, default: 2.5, audio: 'none' },
  { id: 'heartbeat', label: 'Core Pulse', group: 'Detail', min: 1, max: 15, step: 0.5, default: 6.5, audio: 'bass', audioAmt: 0.3 },
];

/** The ordered group names, for laying out a control panel. */
export const QUANTUM_GROUPS = ['Motion', 'Glow & Post', 'Structure', 'Camera', 'Detail'];

export interface QuantumParamConfig {
  id: string;
  base: number;
  min: number;
  max: number;
  audio: QuantumAudioBand;
  amt: number;
}

/** Merge UI overrides (by param id) with the declared defaults into the flat
 *  config the engine consumes each frame. */
export function resolveQuantumParams(
  values?: Record<string, number>,
  audio?: Record<string, QuantumAudioBand>,
): QuantumParamConfig[] {
  return QUANTUM_PARAMS.map((p) => ({
    id: p.id,
    base: values?.[p.id] ?? p.default,
    min: p.min,
    max: p.max,
    audio: audio?.[p.id] ?? p.audio ?? 'none',
    amt: p.audioAmt ?? 0.3,
  }));
}

/* ── shaders ──────────────────────────────────────────────────────────────── */

const CustomVertexShader = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;
  void main() {
    vUv = uv;
    vec4 localNormal = instanceMatrix * vec4(normal, 0.0);
    vNormal = normalize(normalMatrix * localNormal.xyz);
    vec4 localPosition = instanceMatrix * vec4(position, 1.0);
    vec4 mvPosition = modelViewMatrix * localPosition;
    vViewPosition = -mvPosition.xyz;
    vec4 worldPosition = modelMatrix * localPosition;
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const TubeFragmentShader = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uGridIntensity;
  uniform float uFresnelPow;
  uniform float uWaveScale;
  uniform vec3 uColorCyan;
  uniform vec3 uColorMagenta;
  uniform vec3 uColorGold;
  uniform vec3 uColorWhite;
  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition + vec3(0.0, 0.0, 0.0001));
    float fresnel = pow(clamp(1.0 - abs(dot(viewDir, normal)), 0.0, 1.0), uFresnelPow);
    float speedFactor = uTime * uSpeed * 4.0;
    float wave1 = sin(vUv.y * 18.0 * uWaveScale - speedFactor);
    float wave2 = cos(vUv.y * 36.0 * uWaveScale + speedFactor * 0.8);
    float wave3 = sin(vUv.y * 90.0 * uWaveScale - speedFactor * 1.5) * 0.4;
    float energyFlux = smoothstep(0.2, 0.8, (wave1 * wave2 + wave3) * 0.5 + 0.5);
    float wireX = sin(vUv.x * 3.14159265 * 4.0);
    float dWireX = max(fwidth(wireX), 0.0001);
    float lineX = smoothstep(dWireX * 1.5, 0.0, abs(wireX));
    float wireY = sin(vUv.y * 3.14159265 * 30.0);
    float dWireY = max(fwidth(wireY), 0.0001);
    float lineY = smoothstep(dWireY * 1.5, 0.0, abs(wireY));
    float grid = max(lineX, lineY);
    vec3 surfaceColor = mix(uColorMagenta * 0.2, uColorCyan, fresnel);
    vec3 activeFilament = mix(surfaceColor, uColorMagenta * 1.8, energyFlux);
    vec3 finalColor = mix(activeFilament, uColorGold * 1.5, grid * uGridIntensity);
    float burst = smoothstep(0.96, 1.0, sin(vUv.y * 6.0 - speedFactor * 1.8));
    finalColor = mix(finalColor, uColorWhite, burst * 0.85);
    float alpha = mix(0.12 + fresnel * 0.65, 1.0, (grid * 0.75) + (energyFlux * 0.35));
    gl_FragColor = vec4(clamp(finalColor, vec3(0.0), vec3(8.0)), clamp(alpha, 0.0, 1.0));
  }
`;

const NodeFragmentShader = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uFresnelPow;
  uniform float uHeartbeat;
  uniform vec3 uColorCyan;
  uniform vec3 uColorMagenta;
  uniform vec3 uColorGold;
  uniform vec3 uColorWhite;
  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition + vec3(0.0, 0.0, 0.0001));
    float fresnel = pow(clamp(1.0 - abs(dot(viewDir, normal)), 0.0, 1.0), uFresnelPow);
    float speedFactor = uTime * uSpeed * 3.2;
    float distFromCenter = length(vUv - vec2(0.5));
    float thermalWave = sin(distFromCenter * 28.0 - speedFactor) * 0.5 + 0.5;
    float stormNoise = sin(vUv.x * 24.0 + speedFactor) * cos(vUv.y * 24.0 - speedFactor);
    float activeSolar = smoothstep(0.3, 0.9, stormNoise * thermalWave);
    vec3 basePlasma = mix(uColorMagenta, uColorCyan, fresnel);
    vec3 solarLatticeColor = mix(basePlasma, uColorGold * 1.8, activeSolar);
    float centralReactor = smoothstep(0.28, 0.0, distFromCenter);
    vec3 finalColor = mix(solarLatticeColor, uColorWhite, centralReactor * 0.95);
    float heartbeat = sin(uTime * uHeartbeat) * 0.5 + 0.5;
    finalColor += uColorGold * (fresnel * heartbeat * 0.4);
    float alpha = mix(0.3 + fresnel * 0.7, 1.0, activeSolar * 0.5 + centralReactor * 0.5);
    gl_FragColor = vec4(clamp(finalColor, vec3(0.0), vec3(8.0)), clamp(alpha, 0.0, 1.0));
  }
`;

const DitheringShader = {
  name: 'DitheringShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uNoiseAmount: { value: 0.012 },
    uVignetteDarkness: { value: 1.1 },
    uVignetteOffset: { value: 1.1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uNoiseAmount;
    uniform float uVignetteDarkness;
    uniform float uVignetteOffset;
    varying vec2 vUv;
    float random(vec2 coords) {
      return fract(sin(dot(coords, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      float noise = (random(vUv + sin(uTime)) - 0.5) * uNoiseAmount;
      vec3 color = texel.rgb + vec3(noise);
      vec2 uv = vUv - 0.5;
      float dist = length(uv);
      float vignette = smoothstep(uVignetteOffset, uVignetteOffset - 0.55, dist);
      color = mix(color, color * vignette, uVignetteDarkness);
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), texel.a);
    }
  `,
};

const N_POINTS = 120;
const STRANDS = 3;
const R_BASE = 3.0;
const r_base = 1.0;

export class QuantumLatticeEngine {
  private opts: QuantumOptions;
  private width: number;
  private height: number;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private ditherPass: ShaderPass;

  private nodeMaterial: THREE.ShaderMaterial;
  private beamMaterial: THREE.ShaderMaterial;
  private nodeMesh: THREE.InstancedMesh;
  private beamMesh: THREE.InstancedMesh;
  private sphereGeometry: THREE.SphereGeometry;
  private cylinderGeometry: THREE.CylinderGeometry;

  private config = {
    activeShape: 0,
    waveSpeed: 1.2,
    coreScale: 1.25,
    nodesCount: 373,
    beamsCount: 756,
  };
  private morphEnergy = 0;
  private currentBloomMultiplier = 1.0;
  private currentScaleFactor = 1.0;

  // live parameter state
  private params: QuantumParamConfig[] = resolveQuantumParams();
  private cur: Record<string, number> = {};
  private audioDrive = 1;
  private paletteOverride: number | null = null;
  // resolved param fields read by the per-frame logic
  private morphAmount = 0.15;
  private bloomBase = 0.2;
  private ditherBase = 0.012;
  private nodeScaleMul = 1;
  private beamScaleMul = 1;
  private coreScaleMul = 1;
  private cameraDistMul = 1;
  private autoRotateSpeed = 0;
  private baseCameraZ = 9.5;
  private curFov = 45;
  // envelope-smoothed audio bands
  private sm = { bass: 0, mid: 0, high: 0, vol: 0 };
  // hard-hit -> next-shape cycling (bass transient detector with hysteresis)
  private beatCycle = false;
  private beatArmed = true;
  private beatCooldown = 0;

  private latticePositions: THREE.Vector3[][] = [];
  private coreVertices: THREE.Vector3[] = [];
  private baseCuboctahedron: THREE.Vector3[];
  private coreEdges: number[][] = [];
  private centerPoint = new THREE.Vector3(0, 0, 0);

  private palettes: { cyan: THREE.Color; magenta: THREE.Color; gold: THREE.Color; white: THREE.Color }[];
  private activePalette: { cyan: THREE.Color; magenta: THREE.Color; gold: THREE.Color; white: THREE.Color };

  private tempMatrix = new THREE.Matrix4();
  private tempObject = new THREE.Object3D();
  private scratchDir = new THREE.Vector3();
  private upVector = new THREE.Vector3(0, 1, 0);
  private idealTargetVector = new THREE.Vector3();

  private clock = new THREE.Clock();
  private prevTime = 0;
  private rafId = 0;
  private disposed = false;
  private lastTime = 0;
  private frameCount = 0;
  private fps = 0;

  constructor(opts: QuantumOptions) {
    this.opts = opts;
    this.width = Math.max(1, opts.width);
    this.height = Math.max(1, opts.height);
    this.baseCameraZ = this.width < 768 ? 11.5 : 9.5;

    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(opts.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.setClearColor('#020005', 1.0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(new THREE.Color('#020005'), 0.025);

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 100);
    this.camera.position.set(0, 0, this.baseCameraZ);

    if (opts.interactive) {
      this.controls = new OrbitControls(this.camera, opts.canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.minDistance = 3.0;
      this.controls.maxDistance = 25.0;
      this.controls.target.set(0, 0, 0);
    }

    // lattice state
    for (let s = 0; s < STRANDS; s++) {
      this.latticePositions[s] = [];
      for (let i = 0; i < N_POINTS; i++) this.latticePositions[s].push(new THREE.Vector3());
    }
    this.baseCuboctahedron = [
      new THREE.Vector3(1, 1, 0), new THREE.Vector3(1, -1, 0), new THREE.Vector3(-1, 1, 0), new THREE.Vector3(-1, -1, 0),
      new THREE.Vector3(1, 0, 1), new THREE.Vector3(1, 0, -1), new THREE.Vector3(-1, 0, 1), new THREE.Vector3(-1, 0, -1),
      new THREE.Vector3(0, 1, 1), new THREE.Vector3(0, 1, -1), new THREE.Vector3(0, -1, 1), new THREE.Vector3(0, -1, -1),
    ];
    this.baseCuboctahedron.forEach(() => this.coreVertices.push(new THREE.Vector3()));
    const distSqMin = 1.9, distSqMax = 2.1;
    for (let i = 0; i < this.baseCuboctahedron.length; i++) {
      for (let j = i + 1; j < this.baseCuboctahedron.length; j++) {
        const dSq = this.baseCuboctahedron[i].distanceToSquared(this.baseCuboctahedron[j]);
        if (dSq > distSqMin && dSq < distSqMax) this.coreEdges.push([i, j]);
      }
    }

    this.palettes = [
      { cyan: new THREE.Color('#00ffff'), magenta: new THREE.Color('#ff007f'), gold: new THREE.Color('#ffaa00'), white: new THREE.Color('#ffffff') },
      { cyan: new THREE.Color('#00ff66'), magenta: new THREE.Color('#0055ff'), gold: new THREE.Color('#a800ff'), white: new THREE.Color('#ffffff') },
      { cyan: new THREE.Color('#ff3c00'), magenta: new THREE.Color('#ffcc00'), gold: new THREE.Color('#ff0055'), white: new THREE.Color('#ffffdd') },
      { cyan: new THREE.Color('#00aaff'), magenta: new THREE.Color('#00ffff'), gold: new THREE.Color('#9d4edd'), white: new THREE.Color('#e0f2fe') },
    ];
    this.activePalette = {
      cyan: this.palettes[0].cyan.clone(),
      magenta: this.palettes[0].magenta.clone(),
      gold: this.palettes[0].gold.clone(),
      white: this.palettes[0].white.clone(),
    };

    this.nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: CustomVertexShader,
      fragmentShader: NodeFragmentShader,
      uniforms: {
        uTime: { value: 0 }, uSpeed: { value: this.config.waveSpeed },
        uFresnelPow: { value: 2.5 }, uHeartbeat: { value: 6.5 },
        uColorCyan: { value: this.activePalette.cyan }, uColorMagenta: { value: this.activePalette.magenta },
        uColorGold: { value: this.activePalette.gold }, uColorWhite: { value: this.activePalette.white },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beamMaterial = new THREE.ShaderMaterial({
      vertexShader: CustomVertexShader,
      fragmentShader: TubeFragmentShader,
      uniforms: {
        uTime: { value: 0 }, uSpeed: { value: this.config.waveSpeed },
        uGridIntensity: { value: 0.45 }, uFresnelPow: { value: 3.0 }, uWaveScale: { value: 1.0 },
        uColorCyan: { value: this.activePalette.cyan }, uColorMagenta: { value: this.activePalette.magenta },
        uColorGold: { value: this.activePalette.gold }, uColorWhite: { value: this.activePalette.white },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });

    this.sphereGeometry = new THREE.SphereGeometry(1, 16, 16);
    this.cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
    this.nodeMesh = new THREE.InstancedMesh(this.sphereGeometry, this.nodeMaterial, this.config.nodesCount);
    this.nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.nodeMesh);
    this.beamMesh = new THREE.InstancedMesh(this.cylinderGeometry, this.beamMaterial, this.config.beamsCount);
    this.beamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.beamMesh);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.2, 0.35, 0.82);
    this.composer.addPass(this.bloomPass);
    this.ditherPass = new ShaderPass(DitheringShader);
    this.ditherPass.uniforms.uNoiseAmount.value = 0.012;
    this.composer.addPass(this.ditherPass);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(this.width, this.height);

    this.initializeLatticeCoordinates();
    this.lastTime = performance.now();
    this.animate();
  }

  /* ── public param API ───────────────────────────────────────────────────── */

  setShape(shapeIndex: number): void {
    const idx = Math.max(0, Math.min(3, Math.round(shapeIndex)));
    if (idx === this.config.activeShape) return; // no-op: don't re-kick the morph
    this.config.activeShape = idx;
    this.morphEnergy = 1.0;
  }

  get activeShape(): number {
    return this.config.activeShape;
  }

  /** When on, a hard bass hit advances to the next geometry (Torus->...->Cage->Torus). */
  setBeatCycle(on: boolean): void {
    this.beatCycle = on;
    this.beatArmed = true;
    this.beatCooldown = 0;
  }

  /** Replace the live param config (already resolved from UI + defaults). */
  setParams(params: QuantumParamConfig[]): void {
    this.params = params;
  }

  /** Master audio reactivity amount (0 = static, >1 = exaggerated). */
  setAudioDrive(drive: number): void {
    this.audioDrive = Math.max(0, drive);
  }

  /** Force a palette index, or null to follow the active shape (default). */
  setPaletteIndex(index: number | null): void {
    this.paletteOverride = index === null || index < 0 ? null : Math.min(3, Math.round(index));
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.baseCameraZ = this.width < 768 ? 11.5 : 9.5;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height);
  }

  /* ── lattice geometry (unchanged maths) ─────────────────────────────────── */

  private computeTargetCoordinate(shapeIndex: number, s: number, i: number, time: number, targetVector: THREE.Vector3): void {
    const alpha = (s * Math.PI * 2) / STRANDS;
    const phi = (i / N_POINTS) * Math.PI * 2;
    if (shapeIndex === 0) {
      const p = 3, q = 7;
      const delta_r = Math.sin(5.0 * phi - time * this.config.waveSpeed) * Math.cos(3.0 * phi + time * this.config.waveSpeed) * 0.15;
      const r_current = r_base + delta_r;
      const x = (R_BASE + r_current * Math.cos(q * phi + alpha)) * Math.cos(p * phi);
      const y = (R_BASE + r_current * Math.cos(q * phi + alpha)) * Math.sin(p * phi);
      const z = r_current * Math.sin(q * phi + alpha);
      targetVector.set(x, y, z);
    } else if (shapeIndex === 1) {
      const scaleFactor = [3.3, 2.2, 1.1][s];
      const edgeIdx = Math.floor(i / 10);
      const lerpFactor = (i % 10) / 9.0;
      const cubeVerts = [
        new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, -1, -1), new THREE.Vector3(1, 1, -1), new THREE.Vector3(-1, 1, -1),
        new THREE.Vector3(-1, -1, 1), new THREE.Vector3(1, -1, 1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(-1, 1, 1),
      ];
      const cubeEdges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      const edge = cubeEdges[edgeIdx % 12];
      targetVector.lerpVectors(cubeVerts[edge[0]], cubeVerts[edge[1]], lerpFactor);
      targetVector.multiplyScalar(scaleFactor);
      const pulse = 1.0 + Math.sin(time * 2.0 + i * 0.1) * 0.02;
      targetVector.multiplyScalar(pulse);
    } else if (shapeIndex === 2) {
      if (s === 0) {
        const verts = [new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, -1, -1), new THREE.Vector3(-1, 1, -1), new THREE.Vector3(-1, -1, 1)];
        const edges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
        const edgeIdx = Math.floor(i / 20) % 6;
        const lerpFactor = (i % 20) / 19.0;
        targetVector.lerpVectors(verts[edges[edgeIdx][0]], verts[edges[edgeIdx][1]], lerpFactor).multiplyScalar(2.6);
      } else if (s === 1) {
        const verts = [new THREE.Vector3(-1, -1, -1), new THREE.Vector3(-1, 1, 1), new THREE.Vector3(1, -1, 1), new THREE.Vector3(1, 1, -1)];
        const edges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
        const edgeIdx = Math.floor(i / 20) % 6;
        const lerpFactor = (i % 20) / 19.0;
        targetVector.lerpVectors(verts[edges[edgeIdx][0]], verts[edges[edgeIdx][1]], lerpFactor).multiplyScalar(2.6);
      } else {
        const verts = [
          new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
        ];
        const edges = [[0, 2], [2, 1], [1, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4], [0, 5], [1, 5], [2, 5], [3, 5]];
        const edgeIdx = Math.floor(i / 10) % 12;
        const lerpFactor = (i % 10) / 9.0;
        targetVector.lerpVectors(verts[edges[edgeIdx][0]], verts[edges[edgeIdx][1]], lerpFactor).multiplyScalar(1.6);
      }
    } else {
      const index = s * N_POINTS + i;
      const totalPoints = STRANDS * N_POINTS;
      const y = 1.0 - (index / (totalPoints - 1.0)) * 2.0;
      const radiusAtY = Math.sqrt(Math.max(0.0, 1.0 - y * y));
      const goldenRatio = (1.0 + Math.sqrt(5.0)) / 2.0;
      const theta = 2.0 * Math.PI * goldenRatio * index;
      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;
      const baseRad = 2.6 + Math.sin(time * 1.5 + index * 0.05) * 0.1;
      targetVector.set(x, y, z).multiplyScalar(baseRad);
    }
  }

  private initializeLatticeCoordinates(): void {
    for (let s = 0; s < STRANDS; s++) {
      for (let i = 0; i < N_POINTS; i++) this.computeTargetCoordinate(0, s, i, 0, this.latticePositions[s][i]);
    }
    const pulseScalar = this.config.coreScale;
    for (let i = 0; i < this.baseCuboctahedron.length; i++) {
      this.coreVertices[i].copy(this.baseCuboctahedron[i]).multiplyScalar(pulseScalar);
    }
  }

  private getCylinderMatrix(vA: THREE.Vector3, vB: THREE.Vector3, radius: number, targetMatrix: THREE.Matrix4): void {
    this.scratchDir.subVectors(vB, vA);
    const length = this.scratchDir.length();
    if (length < 0.0001) {
      this.tempObject.position.copy(vA);
      this.tempObject.scale.set(0, 0, 0);
      this.tempObject.updateMatrix();
      targetMatrix.copy(this.tempObject.matrix);
      return;
    }
    this.scratchDir.normalize();
    this.tempObject.position.addVectors(vA, vB).multiplyScalar(0.5);
    this.tempObject.quaternion.setFromUnitVectors(this.upVector, this.scratchDir);
    this.tempObject.scale.set(radius, length, radius);
    this.tempObject.updateMatrix();
    targetMatrix.copy(this.tempObject.matrix);
  }

  private computePositionsAndMorph(time: number, activeShapeIndex: number): number {
    let totalDeviation = 0;
    let count = 0;
    const morphShockwave = Math.sin(time * 25.0) * this.morphEnergy * this.morphAmount;
    for (let s = 0; s < STRANDS; s++) {
      for (let i = 0; i < N_POINTS; i++) {
        this.computeTargetCoordinate(activeShapeIndex, s, i, time, this.idealTargetVector);
        if (this.morphEnergy > 0.001) {
          const direction = this.idealTargetVector.clone().normalize();
          this.idealTargetVector.addScaledVector(direction, morphShockwave);
        }
        totalDeviation += this.latticePositions[s][i].distanceTo(this.idealTargetVector);
        count++;
        this.latticePositions[s][i].lerp(this.idealTargetVector, 0.06);
      }
    }
    const coreScaleTarget = [1.25, 0.75, 1.05, 0.6][activeShapeIndex];
    const lerpedBaseScale = THREE.MathUtils.lerp(this.config.coreScale, coreScaleTarget, 0.06);
    this.config.coreScale = lerpedBaseScale;
    const pulseScalar = lerpedBaseScale * this.coreScaleMul + Math.sin(time * 2.5) * 0.08;
    for (let i = 0; i < this.baseCuboctahedron.length; i++) {
      this.idealTargetVector.copy(this.baseCuboctahedron[i]).multiplyScalar(pulseScalar);
      this.coreVertices[i].lerp(this.idealTargetVector, 0.06);
    }
    const avgDeviation = totalDeviation / count;
    return Math.max(100.0 - avgDeviation * 45.0, 0.0);
  }

  private updateLatticeSystem(time: number, activeShapeIndex: number): number {
    const coherence = this.computePositionsAndMorph(time, activeShapeIndex);
    let nodeIdx = 0;
    for (let s = 0; s < STRANDS; s++) {
      for (let i = 0; i < N_POINTS; i++) {
        this.tempObject.position.copy(this.latticePositions[s][i]);
        const scaleMult = 1.0 + this.morphEnergy * 0.45;
        const baseNodeScale = 0.065 * this.currentScaleFactor * this.nodeScaleMul;
        this.tempObject.scale.setScalar(baseNodeScale * scaleMult);
        this.tempObject.updateMatrix();
        this.nodeMesh.setMatrixAt(nodeIdx++, this.tempObject.matrix);
      }
    }
    const coreNodeScaleFactor = [1.0, 0.8, 0.65, 0.5][activeShapeIndex];
    for (let i = 0; i < this.coreVertices.length; i++) {
      this.tempObject.position.copy(this.coreVertices[i]);
      this.tempObject.scale.setScalar(0.115 * coreNodeScaleFactor * this.nodeScaleMul);
      this.tempObject.updateMatrix();
      this.nodeMesh.setMatrixAt(nodeIdx++, this.tempObject.matrix);
    }
    this.tempObject.position.copy(this.centerPoint);
    const centerPulse = (0.2 + Math.sin(time * 5.0) * 0.05) * coreNodeScaleFactor * this.nodeScaleMul;
    this.tempObject.scale.setScalar(centerPulse);
    this.tempObject.updateMatrix();
    this.nodeMesh.setMatrixAt(nodeIdx++, this.tempObject.matrix);
    this.nodeMesh.instanceMatrix.needsUpdate = true;

    let beamIdx = 0;
    const primaryBeamRadius = 0.015 * this.currentScaleFactor * this.beamScaleMul;
    for (let s = 0; s < STRANDS; s++) {
      for (let i = 0; i < N_POINTS; i++) {
        const pA = this.latticePositions[s][i];
        const pB = this.latticePositions[s][(i + 1) % N_POINTS];
        this.getCylinderMatrix(pA, pB, primaryBeamRadius, this.tempMatrix);
        this.beamMesh.setMatrixAt(beamIdx++, this.tempMatrix);
      }
    }
    for (let i = 0; i < N_POINTS; i++) {
      for (let s = 0; s < STRANDS; s++) {
        const sNext = (s + 1) % STRANDS;
        const pA = this.latticePositions[s][i];
        const pB = this.latticePositions[sNext][i];
        this.getCylinderMatrix(pA, pB, primaryBeamRadius * 0.65, this.tempMatrix);
        this.beamMesh.setMatrixAt(beamIdx++, this.tempMatrix);
      }
    }
    for (let e = 0; e < this.coreEdges.length; e++) {
      const edge = this.coreEdges[e];
      this.getCylinderMatrix(this.coreVertices[edge[0]], this.coreVertices[edge[1]], primaryBeamRadius * 1.6, this.tempMatrix);
      this.beamMesh.setMatrixAt(beamIdx++, this.tempMatrix);
    }
    for (let i = 0; i < this.coreVertices.length; i++) {
      this.getCylinderMatrix(this.coreVertices[i], this.centerPoint, primaryBeamRadius * 0.8, this.tempMatrix);
      this.beamMesh.setMatrixAt(beamIdx++, this.tempMatrix);
    }
    this.beamMesh.instanceMatrix.needsUpdate = true;
    return coherence;
  }

  /* ── per-frame parameter + audio application ────────────────────────────── */

  private band(b: QuantumAudioBand): number {
    return b === 'bass' ? this.sm.bass : b === 'mid' ? this.sm.mid : b === 'high' ? this.sm.high : b === 'volume' ? this.sm.vol : 0;
  }

  private applyParams(dt: number): void {
    const tcPar = 1 - Math.exp(-dt / 0.08);
    for (const pm of this.params) {
      const level = this.band(pm.audio) * this.audioDrive;
      let target = pm.base + (pm.max - pm.min) * pm.amt * level;
      if (target < pm.min) target = pm.min;
      else if (target > pm.max) target = pm.max;
      const prev = this.cur[pm.id];
      const val = prev === undefined ? target : prev + (target - prev) * tcPar;
      this.cur[pm.id] = val;
      this.dispatch(pm.id, val);
    }
  }

  private dispatch(id: string, v: number): void {
    switch (id) {
      case 'waveSpeed':
        this.config.waveSpeed = v;
        this.nodeMaterial.uniforms.uSpeed.value = v;
        this.beamMaterial.uniforms.uSpeed.value = v;
        break;
      case 'morphAmount': this.morphAmount = v; break;
      case 'autoRotate': this.autoRotateSpeed = v; break;
      case 'bloomStrength': this.bloomBase = v; break;
      case 'bloomRadius': this.bloomPass.radius = v; break;
      case 'bloomThreshold': this.bloomPass.threshold = v; break;
      case 'dither': this.ditherBase = v; break;
      case 'exposure': this.renderer.toneMappingExposure = v; break;
      case 'vignette': this.ditherPass.uniforms.uVignetteDarkness.value = v; break;
      case 'fog': (this.scene.fog as THREE.FogExp2).density = v; break;
      case 'nodeScale': this.nodeScaleMul = v; break;
      case 'beamScale': this.beamScaleMul = v; break;
      case 'coreScale': this.coreScaleMul = v; break;
      case 'cameraDist': this.cameraDistMul = v; break;
      case 'cameraFov':
        if (Math.abs(v - this.curFov) > 0.01) {
          this.curFov = v;
          this.camera.fov = v;
          this.camera.updateProjectionMatrix();
        }
        break;
      case 'gridIntensity': this.beamMaterial.uniforms.uGridIntensity.value = v; break;
      case 'waveDetail': this.beamMaterial.uniforms.uWaveScale.value = v; break;
      case 'beamFresnel': this.beamMaterial.uniforms.uFresnelPow.value = v; break;
      case 'nodeFresnel': this.nodeMaterial.uniforms.uFresnelPow.value = v; break;
      case 'heartbeat': this.nodeMaterial.uniforms.uHeartbeat.value = v; break;
    }
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);
    if (this.renderer.getContext().isContextLost?.()) return;

    const time = this.clock.getElapsedTime();
    const dt = Math.min(0.1, Math.max(0.001, time - this.prevTime));
    this.prevTime = time;

    // envelope-follow audio bands (fast attack / slow release)
    if (this.opts.getLevels) {
      const lv = this.opts.getLevels();
      const tcUp = 1 - Math.exp(-dt / 0.025);
      const tcDn = 1 - Math.exp(-dt / 0.18);
      const sm = this.sm;
      const rb = Math.min(1, Math.max(0, lv.bass)), rm = Math.min(1, Math.max(0, lv.mid));
      const rh = Math.min(1, Math.max(0, lv.high)), rv = Math.min(1, Math.max(0, lv.volume));
      sm.bass += (rb - sm.bass) * (rb > sm.bass ? tcUp : tcDn);
      sm.mid += (rm - sm.mid) * (rm > sm.mid ? tcUp : tcDn);
      sm.high += (rh - sm.high) * (rh > sm.high ? tcUp : tcDn);
      sm.vol += (rv - sm.vol) * (rv > sm.vol ? tcUp : tcDn);
      // bass also kicks the morph shockwave (the on-beat pulse)
      this.morphEnergy = Math.max(this.morphEnergy, sm.bass * 0.6 * this.audioDrive);

      // hard hit -> advance geometry. Hysteresis gate: bass must dip below the
      // low threshold (re-arm) before a rise past the high threshold fires, so
      // one kick triggers one step, not a burst. Cooldown caps the rate.
      if (this.beatCycle) {
        this.beatCooldown = Math.max(0, this.beatCooldown - dt);
        if (sm.bass < 0.3) this.beatArmed = true;
        if (this.beatArmed && this.beatCooldown <= 0 && sm.bass > 0.55) {
          this.config.activeShape = (this.config.activeShape + 1) % 4;
          this.morphEnergy = 1.0;
          this.beatArmed = false;
          this.beatCooldown = 0.18;
          this.opts.onShape?.(this.config.activeShape);
        }
      }
    }

    this.applyParams(dt);

    const pIdx = this.paletteOverride ?? this.config.activeShape;
    const targetPalette = this.palettes[pIdx] ?? this.palettes[0];
    this.activePalette.cyan.lerp(targetPalette.cyan, 0.06);
    this.activePalette.magenta.lerp(targetPalette.magenta, 0.06);
    this.activePalette.gold.lerp(targetPalette.gold, 0.06);
    this.activePalette.white.lerp(targetPalette.white, 0.06);

    this.morphEnergy += (0.0 - this.morphEnergy) * 0.05;

    const targetBloomMultiplier = [1.0, 0.78, 0.42, 0.32][this.config.activeShape];
    this.currentBloomMultiplier = THREE.MathUtils.lerp(this.currentBloomMultiplier, targetBloomMultiplier, 0.06);
    const targetScaleFactor = [1.0, 0.8, 0.55, 0.45][this.config.activeShape];
    this.currentScaleFactor = THREE.MathUtils.lerp(this.currentScaleFactor, targetScaleFactor, 0.06);

    this.bloomPass.strength = this.bloomBase * this.currentBloomMultiplier + this.morphEnergy * 0.5;
    this.ditherPass.uniforms.uNoiseAmount.value = this.ditherBase + this.morphEnergy * 0.04;

    this.nodeMaterial.uniforms.uTime.value = time;
    this.beamMaterial.uniforms.uTime.value = time;
    this.ditherPass.uniforms.uTime.value = time;

    if (Math.abs(this.autoRotateSpeed) > 0.001) this.scene.rotation.y += this.autoRotateSpeed * dt;
    if (!this.controls) this.camera.position.z = this.baseCameraZ * this.cameraDistMul;

    const coherence = this.updateLatticeSystem(time, this.config.activeShape);

    this.controls?.update();
    this.composer.render();

    const now = performance.now();
    this.frameCount++;
    if (now - this.lastTime >= 500) {
      this.fps = (this.frameCount * 1000) / (now - this.lastTime);
      this.frameCount = 0;
      this.lastTime = now;
      if (this.opts.onStats) {
        const shapeMultiplier = [1.0, 1.35, 1.82, 2.25][this.config.activeShape];
        const resonance = 3 * 7 * 0.077 * (1 + this.config.waveSpeed * 0.12) * shapeMultiplier;
        this.opts.onStats({
          geomName: QUANTUM_GEOMETRY_NAMES[this.config.activeShape],
          stability: coherence,
          fps: this.fps,
          resonance,
          phasePercent: Math.max(0, Math.min(100, Math.round((coherence / 100.0) * 100.0))),
          shape: this.config.activeShape,
        });
      }
    }
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.controls?.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.sphereGeometry.dispose();
    this.cylinderGeometry.dispose();
    this.nodeMaterial.dispose();
    this.beamMaterial.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
