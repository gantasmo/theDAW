/**
 * swayHostFx: the rack-effect API theDAW hands the SWAY cockpit's window.
 *
 *  - `catalog()` lists every RACK_EFFECTS entry with a schema the cockpit can draw.
 *  - `build()` makes each of them on a context it did not create, through that
 *    context's own factory methods (the three worklet effects construct an
 *    AudioWorkletNode on it), and `prepare()` registers their modules there.
 *  - A node's `setParams` merges into the values it already holds.
 *  - sway/host-ready lists 'rack-fx' only when the API reached the cockpit.
 *
 * There is no Web Audio under tsx: the context is a recording stand-in whose
 * `create*` calls answer a node that accepts any call or assignment.
 *
 * Run: npx tsx src/lib/swayHostFx.test.ts
 */
import assert from 'node:assert/strict';

import { RACK_EFFECTS } from './rackEffects.ts';
import { HOST_CAP_PLUGIN_FILE, HOST_CAP_RACK_FX, HOST_CAP_VST_LIVE, HOST_CAPS, hostCapsFor } from './swayHost.ts';
import { SWAY_HOST_API_KEY, createSwayHostApi, handSwayHostApi, swayHostApi } from './swayHostFx.ts';

/* ── a stand-in context ────────────────────────────────────────────────────── */

/** Every assignment made on a stand-in node, in order. */
const sets: { key: string; value: unknown }[] = [];

/** A node, an AudioParam or a method: any call, read or write is accepted. */
function anything(): unknown {
  const target = function () {} as unknown as Record<PropertyKey, unknown>;
  return new Proxy(target, {
    get: (t, k) => {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'then') return undefined;
      if (!(k in t)) t[k] = anything();
      return t[k];
    },
    set: (t, k, v) => {
      t[k] = v;
      sets.push({ key: String(k), value: v });
      return true;
    },
    has: () => false,
    apply: () => anything(),
  });
}

function standInContext(): { ctx: BaseAudioContext; created: string[]; modules: string[] } {
  const created: string[] = [];
  const modules: string[] = [];
  const own: Record<string, unknown> = {
    sampleRate: 48000,
    currentTime: 0,
    audioWorklet: {
      addModule: (url: string) => {
        modules.push(url);
        return Promise.resolve();
      },
    },
    createBuffer: (_ch: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
  };
  const ctx = new Proxy(own, {
    get: (t, k) => {
      if (typeof k !== 'string' || k in t) return t[k as string];
      if (!k.startsWith('create')) return undefined;
      return () => {
        created.push(k);
        return anything();
      };
    },
  }) as unknown as BaseAudioContext;
  return { ctx, created, modules };
}

/** The worklet nodes built, as [context, processor name]. */
const worklets: [unknown, string][] = [];
(globalThis as Record<string, unknown>).AudioWorkletNode = class {
  constructor(ctx: unknown, name: string) {
    worklets.push([ctx, name]);
    return anything() as object;
  }
};

/* ── catalog ───────────────────────────────────────────────────────────────── */

const catalog = swayHostApi.catalog();
assert.deepEqual(catalog.map((e) => e.id), RACK_EFFECTS.map((d) => d.id), 'the catalog is every rack effect, in rack order');
assert.equal(catalog.length, 19);
for (const e of catalog) {
  assert.ok(e.name && e.params.length > 0, `${e.id} has a name and parameters`);
  for (const p of e.params) {
    assert.ok(p.max > p.min && p.default >= p.min && p.default <= p.max, `${e.id}.${p.key} has a range around its default`);
    assert.equal(p.options?.length ?? 0, p.values?.length ?? 0, `${e.id}.${p.key} has a value per option`);
    if (p.kind === 'select' || p.kind === 'toggle') assert.ok(p.options, `${e.id}.${p.key} names its options`);
    if (p.curve === 'log') assert.ok(p.min > 0, `${e.id}.${p.key} has log travel on a positive range`);
  }
}
const filterType = catalog.find((e) => e.id === 'ares')?.params.find((p) => p.key === 'filterType');
assert.deepEqual(filterType?.values, [0, 0.4, 0.6, 0.8, 1], 'an option carries the value it sets');
assert.equal(catalog.find((e) => e.id === 'reverb')?.mix, 'wet');
assert.equal(JSON.parse(JSON.stringify(catalog)).length, 19, 'the catalog is plain data');

/* ── build: all nineteen, on a context this module did not create ──────────── */

const api = createSwayHostApi();
const { ctx, created, modules } = standInContext();
for (const e of catalog) {
  const before = created.length;
  const node = api.build(ctx, e.id, {});
  assert.ok(node, `${e.id} builds`);
  assert.ok(node.input && node.output, `${e.id} has an input and an output`);
  assert.ok(created.length > before, `${e.id} made its nodes with the given context's factory methods`);
  assert.doesNotThrow(() => node.setParams({ [e.params[0].key]: e.params[0].max }), `${e.id} takes a parameter`);
  assert.doesNotThrow(() => node.dispose(), `${e.id} disposes`);
}
const processors = worklets.map(([, name]) => name).sort();
assert.deepEqual(processors, ['chop-processor', 'granular-processor', 'subharmonic-processor'], 'the three worklet effects construct their node');
assert.ok(worklets.every(([c]) => c === ctx), 'each on the given context');
assert.equal(api.build(ctx, 'no-such-effect', {}), null);

/* ── prepare registers the worklet modules on the given context ────────────── */

const fresh = standInContext();
assert.deepEqual(await api.prepare(fresh.ctx), [], 'no effect is left without its module');
assert.deepEqual([...fresh.modules].sort(), ['/chop.worklet.js', '/granular.worklet.js', '/subharmonic.worklet.js']);
const bare = { sampleRate: 48000, currentTime: 0 } as unknown as BaseAudioContext;
assert.deepEqual((await api.prepare(bare)).sort(), ['ares', 'chop', 'kargyraa'], 'a context without a worklet names what cannot run');

/* ── setParams merges; values stay inside the schema's range ───────────────── */

const hp = api.build(ctx, 'highpass', { frequency: 300, resonance: 2, stray: 9 } as Record<string, number>);
assert.ok(hp);
sets.length = 0;
hp.setParams({ resonance: 999 });
const written = sets.filter((s) => s.key === 'value').map((s) => s.value);
assert.deepEqual(written, [300, 18], 'the cutoff set at build is kept, and the new Q stops at its maximum');

/* ── the handoff and the cap ───────────────────────────────────────────────── */

const cockpit = {} as unknown as Window;
assert.equal(handSwayHostApi(cockpit), true);
assert.equal((cockpit as unknown as Record<string, unknown>)[SWAY_HOST_API_KEY], swayHostApi);
assert.equal(handSwayHostApi(null), false);
const sealed = Object.freeze({}) as unknown as Window;
assert.equal(handSwayHostApi(sealed), false, 'a window that refuses the write gets no API');
assert.ok(HOST_CAPS.includes(HOST_CAP_RACK_FX));
assert.deepEqual(hostCapsFor(true), [HOST_CAP_PLUGIN_FILE, HOST_CAP_RACK_FX]);
assert.deepEqual(hostCapsFor(false), [HOST_CAP_PLUGIN_FILE], 'no API on the cockpit, no cap');
assert.ok(HOST_CAPS.includes(HOST_CAP_VST_LIVE));
assert.deepEqual(hostCapsFor(true, true), [HOST_CAP_PLUGIN_FILE, HOST_CAP_RACK_FX, HOST_CAP_VST_LIVE]);
assert.deepEqual(hostCapsFor(false, true), [HOST_CAP_PLUGIN_FILE], 'live plugins ride on the API, so no API, no live cap');

console.log('swayHostFx: ok');
