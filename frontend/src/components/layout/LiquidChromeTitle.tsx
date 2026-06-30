import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Boot cinematic — the theDAW model only.
 *   - the theDAW.gltf model in liquid chrome (the cymatics chrome material),
 *     assembling from scattered vertices into the solid object over ~7s
 *   - rendered on a TRANSPARENT canvas so the one shared dark background shows
 *     through (no separate metallic backdrop, no different scene)
 *   - the "by" line + the GANTASMO logo live in the DOM around this canvas (see
 *     LoadingScreen) so the three credit elements keep an exact size proportion.
 * Reports inactive if WebGL won't start; reports complete once the model has
 * fully resolved so the host holds for the real runtime.
 */

interface LiquidChromeTitleProps {
  onActive?: (active: boolean) => void;
  onComplete?: () => void;
}

const FORM_SECONDS = 7;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// The gltf node transform bakes a +45deg Y turn into the logo (verified from the
// matrix columns), which makes it lie back at an angle. Counter it so the logo
// faces the camera.
const DAW_BASE_ROT_Y = -Math.PI / 4;

export const LiquidChromeTitle: React.FC<LiquidChromeTitleProps> = ({ onActive, onComplete }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Keep a transient WebGL context loss from permanently bricking the boot
    // screen: preventDefault marks the context as restorable.
    const onContextLost = (e: Event) => e.preventDefault();
    canvas.addEventListener('webglcontextlost', onContextLost, false);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      onActive?.(true);
    } catch {
      onActive?.(false);
      return;
    }
    let w = canvas.clientWidth || window.innerWidth;
    let h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(w, h, false);
    renderer.setClearColor(0x000000, 0); // transparent — the DOM background shows through
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35; // a touch stronger overall

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    camera.position.set(0, 0, 4.2);

    // Cymatics chrome light rig — bumped a smidgen.
    const key = new THREE.DirectionalLight(0xfff5ea, 1.7);
    key.position.set(6, 9, 5);
    // Opposing key, horizontally mirrored (-x), so a highlight rakes the model
    // from the other side and it stays legible at any rotation.
    const key2 = new THREE.DirectionalLight(0xfff5ea, 1.5);
    key2.position.set(-6, 9, 5);
    const rim = new THREE.DirectionalLight(0xb14dff, 1.1);
    rim.position.set(-6, -3, -4);
    const fill = new THREE.DirectionalLight(0x00d2ff, 0.5);
    fill.position.set(0, -6, 5);
    scene.add(key, key2, rim, fill, new THREE.AmbientLight(0x0c0714, 0.18));

    // The cymatics chrome material plus a formation vertex shader
    // (uForm 0 = vertices flung out along random dirs, 1 = solid).
    let dawShader: THREE.WebGLProgramParametersWithUniforms | null = null;
    const chrome = new THREE.MeshStandardMaterial({
      color: 0x010101,
      metalness: 0.99,
      roughness: 0.008,
      emissive: 0x000000,
      envMapIntensity: 1.8, // stronger reflections so the model reads at any angle
    });
    chrome.onBeforeCompile = (shader) => {
      shader.uniforms.uForm = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uForm;
           float h11(float n){ return fract(sin(n)*43758.5453); }`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float seed = dot(position, vec3(12.9898, 78.233, 37.719));
           vec3 dir = normalize(vec3(h11(seed)-0.5, h11(seed+1.7)-0.5, h11(seed+3.1)-0.5));
           float spread = 1.0 - uForm;
           vec3 scattered = position + dir * spread * 5.0 + normal * spread * 1.1;
           scattered += normal * sin(uForm * 6.2832 + h11(seed) * 6.2832) * spread * 0.35;
           transformed = mix(scattered, position, smoothstep(0.0, 1.0, uForm));`,
        );
      dawShader = shader;
    };

    const dawGroup = new THREE.Group();
    dawGroup.position.y = 0; // centered in its own canvas box
    dawGroup.position.z = -0.6; // a little further from camera: flatter, less lit-from-below
    dawGroup.rotation.y = DAW_BASE_ROT_Y; // face the camera
    dawGroup.visible = false;
    scene.add(dawGroup);

    // Env reflections. The chrome is a near-perfect mirror, so without an env map
    // it renders black (invisible). A synchronous RoomEnvironment is installed
    // immediately so the model is reflective the instant it loads — the formation
    // then starts on the model alone and no longer waits on the EXR download. The
    // EXR upgrades the reflections when it arrives.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    let envRT: THREE.WebGLRenderTarget | null = null;
    let disposed = false;
    let modelReady = false;
    try {
      const roomRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      chrome.envMap = roomRT.texture;
      scene.environment = roomRT.texture;
      envRT = roomRT;
    } catch {
      /* fallback environment is best-effort */
    }
    new EXRLoader().load('/piz_compressed.exr', (tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      tex.mapping = THREE.EquirectangularReflectionMapping;
      const exrRT = pmrem.fromEquirectangular(tex);
      chrome.envMap = exrRT.texture;
      scene.environment = exrRT.texture;
      tex.dispose();
      envRT?.dispose(); // drop the room fallback
      envRT = exrRT;
    });

    new GLTFLoader().load('/theDAW.gltf', (gltf) => {
      if (disposed) return;
      // Smooth the faceted normals: weld duplicate verts (-> indexed) then average
      // shared face normals, so the chrome reads as liquid metal, not low-poly.
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) {
          const welded = mergeVertices(m.geometry);
          welded.computeVertexNormals();
          m.geometry = welded;
          m.material = chrome;
        }
      });
      // Centre the content at the group origin (so the counter-rotation turns it
      // in place), then measure it FRONT-FACING (after the -45deg counter-rotation)
      // for the scale.
      const cbox = new THREE.Box3().setFromObject(gltf.scene);
      const center = new THREE.Vector3();
      cbox.getCenter(center);
      gltf.scene.position.sub(center);
      dawGroup.add(gltf.scene);
      dawGroup.updateMatrixWorld(true);
      const fbox = new THREE.Box3().setFromObject(dawGroup);
      const size = new THREE.Vector3();
      fbox.getSize(size);
      // 2x size: the theDAW logo is doubled vs the prior fill (was 4.0). The
      // "by GANTASMO" text/image live outside this canvas (LoadingScreen DOM
      // siblings), so enlarging the model here does not move them.
      const scale = 8.0 / Math.max(size.x, 0.001);
      dawGroup.scale.setScalar(scale);
      modelReady = true;
    });

    // Post: bloom gives the chrome its hot highlights.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.15, 0.8, 0.18);
    composer.addPass(bloom);

    const clockStart = performance.now(); // elapsed seconds, no deprecated THREE.Clock
    let raf = 0;
    let startedAt = -1; // formation clock starts once the model is ready
    let completed = false;

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const t = (performance.now() - clockStart) / 1000;

      // Start the ~7s formation as soon as the model is ready (the env map is
      // already present via the room fallback), instead of waiting on the EXR.
      if (modelReady && startedAt < 0) startedAt = t;
      const form = startedAt < 0 ? 0 : clamp01((t - startedAt) / FORM_SECONDS);

      const dawForm = easeOutCubic(form);
      dawGroup.visible = dawGroup.children.length > 0;
      if (dawShader) dawShader.uniforms.uForm.value = dawForm;
      dawGroup.rotation.y = DAW_BASE_ROT_Y + Math.sin(t * 0.28) * 0.05;

      // Report completion once the model has fully resolved, so the host can hold
      // for the real runtime instead of a blind timer.
      if (!completed && startedAt >= 0 && form >= 1) {
        completed = true;
        onComplete?.();
      }

      // Orbit the key lights and sweep the environment reflections so the chrome
      // stays lit + legible the WHOLE time (it was going dark / near-invisible by
      // the end with a static rig). environmentRotation is guarded for older three.
      const orbit = t * 0.45;
      key.position.set(Math.cos(orbit) * 8, 8, Math.sin(orbit) * 8 + 3);
      key2.position.set(Math.cos(orbit + Math.PI) * 8, 8, Math.sin(orbit + Math.PI) * 8 + 3);
      const envRot = (scene as unknown as { environmentRotation?: THREE.Euler }).environmentRotation;
      if (envRot) envRot.y = orbit * 0.6;

      camera.position.x = Math.sin(t * 0.18) * 0.14;
      // Look slightly up so the model sits LOW in its canvas box (its bottom near
      // the box bottom), keeping "by" tight beneath it.
      camera.lookAt(0, 0.9, 0);
      composer.render();
    };
    raf = requestAnimationFrame(animate);

    const onResize = () => {
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      envRT?.dispose();
      pmrem.dispose();
      chrome.dispose();
      composer.dispose();
      renderer.dispose();
      // NOTE: do NOT forceContextLoss() here. Under React StrictMode (dev) the
      // effect runs mount -> unmount -> mount; force-losing the context on the
      // first unmount leaves the shared canvas with a dead context that the
      // remount reuses, so nothing paints (white screen / CONTEXT_LOST_WEBGL).
      // dispose() frees the three resources; the canvas context stays alive.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="block w-full h-full" />;
};
