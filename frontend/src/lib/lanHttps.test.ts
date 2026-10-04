/**
 * The LAN HTTPS listener's decision, tested without starting a dev server.
 *
 * `vite.lan.config.ts` is the second Vite listener: the same app, the same
 * proxy, served over TLS on `theDAW_HTTPS_PORT` so a browser on another
 * computer gets a SECURE CONTEXT and therefore `AudioContext.audioWorklet`,
 * the microphone, Web MIDI, the clipboard and `crypto.subtle`. Without it the
 * EDIT tab dies on the LAN with "Cannot read properties of undefined (reading
 * 'addModule')".
 *
 * `lanHttpsOptions` and `describeLanHttps` are pure functions of the
 * environment precisely so this file can exist — the alternative is booting a
 * real TLS server, which no suite here does (and the standing rules forbid).
 * The environment variable NAMES are the contract between three sides: this
 * config, `backend/_devstack.py` and `electron-ui/main/index.ts`. A rename
 * here silently leaves both launchers spawning a listener that throws, so the
 * exact names are asserted as literals rather than via a shared constant.
 *
 * Imported from the root config the same way `src/lib/isolationHeaders.test.ts`
 * imports `vite.config.ts`, which is also what pulls the config file into the
 * `tsc --noEmit` program (tsconfig only includes `src`).
 *
 * Run: `npx tsx src/lib/lanHttps.test.ts`
 */
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LAN_CACHE_DIR,
  LAN_HTTPS_DEFAULT_PORT,
  describeLanHttps,
  lanHttpsOptions,
} from '../../vite.lan.config.ts';

/** A `read` that records what it was asked for and returns recognisable PEM. */
const recordingRead = (seen: string[]) => (path: string) => {
  seen.push(path);
  return `-----PEM(${path})-----`;
};

// ── the default port matches backend/ports.py LAN_HTTPS_PORT ────────────────
assert.equal(
  LAN_HTTPS_DEFAULT_PORT,
  5443,
  'the default LAN HTTPS port must stay 5443 — backend/ports.py LAN_HTTPS_PORT and both launcher ' +
    'sweep lists name the same number, and a phone already bookmarked on it',
);

// ── describeLanHttps: enabled, with no reason riding along ──────────────────
{
  const d = describeLanHttps({ theDAW_HTTPS_CERT: '/c/cert.pem', theDAW_HTTPS_KEY: '/c/key.pem' });
  assert.equal(d.enabled, true);
  assert.equal('reason' in d, false, 'no reason key at all when enabled — a launcher logs it unconditionally');
}

// ── describeLanHttps: off, and it says why ─────────────────────────────────
{
  const none = describeLanHttps({});
  assert.equal(none.enabled, false, 'no certificate means no listener');
  assert.match(none.reason ?? '', /theDAW_HTTPS_CERT/, 'the reason names the variable to set');
  assert.match(none.reason ?? '', /theDAW_HTTPS_KEY/);

  // An incomplete pair is a DIFFERENT fault from an absent one: somebody set
  // one variable and expected TLS. Saying "no certificate" there sends them
  // looking in the wrong place.
  const certOnly = describeLanHttps({ theDAW_HTTPS_CERT: '/c/cert.pem' });
  assert.equal(certOnly.enabled, false);
  assert.match(certOnly.reason ?? '', /theDAW_HTTPS_KEY is not/, 'names the MISSING half');
  assert.notEqual(certOnly.reason, none.reason, 'a half-set pair is not reported as an unset one');

  const keyOnly = describeLanHttps({ theDAW_HTTPS_KEY: '/c/key.pem' });
  assert.equal(keyOnly.enabled, false);
  assert.match(keyOnly.reason ?? '', /theDAW_HTTPS_CERT is not/, 'names the MISSING half');

  // Whitespace is not a path. An env var set to "" or " " by a launcher that
  // could not find a cert must read as unset, not as a file named " ".
  assert.equal(describeLanHttps({ theDAW_HTTPS_CERT: '  ', theDAW_HTTPS_KEY: '  ' }).enabled, false);
  assert.equal(
    describeLanHttps({ theDAW_HTTPS_CERT: '  ', theDAW_HTTPS_KEY: '/c/key.pem' }).enabled,
    false,
    'a blank cert path with a real key is still an incomplete pair',
  );
}

// ── lanHttpsOptions: reads exactly the two paths it was given ──────────────
{
  const seen: string[] = [];
  const opts = lanHttpsOptions(
    { theDAW_HTTPS_CERT: '/e/lan-cert.pem', theDAW_HTTPS_KEY: '/e/lan-key.pem' },
    recordingRead(seen),
  );
  assert.deepEqual(seen, ['/e/lan-cert.pem', '/e/lan-key.pem'], 'cert then key, nothing else opened');
  assert.equal(opts.https.cert, '-----PEM(/e/lan-cert.pem)-----', 'cert goes to `cert`');
  assert.equal(opts.https.key, '-----PEM(/e/lan-key.pem)-----', 'key goes to `key` — swapping them serves nothing');
  assert.equal(opts.port, LAN_HTTPS_DEFAULT_PORT, 'no theDAW_HTTPS_PORT means the default');
}

// ── lanHttpsOptions: the paths are trimmed before they are opened ──────────
{
  const seen: string[] = [];
  lanHttpsOptions(
    { theDAW_HTTPS_CERT: ' /e/lan-cert.pem ', theDAW_HTTPS_KEY: '\t/e/lan-key.pem\n' },
    recordingRead(seen),
  );
  assert.deepEqual(seen, ['/e/lan-cert.pem', '/e/lan-key.pem'], 'a stray newline from a shell must not ENOENT');
}

// ── lanHttpsOptions: the port ──────────────────────────────────────────────
{
  const read = () => 'pem';
  const withPort = (value: string | undefined) =>
    lanHttpsOptions(
      { theDAW_HTTPS_CERT: '/c/c.pem', theDAW_HTTPS_KEY: '/c/k.pem', theDAW_HTTPS_PORT: value },
      read,
    ).port;

  assert.equal(withPort('5443'), 5443);
  assert.equal(withPort('8443'), 8443, 'an explicit port is honoured');
  assert.equal(withPort(' 8443 '), 8443, 'and trimmed');
  assert.equal(withPort(''), LAN_HTTPS_DEFAULT_PORT, 'empty falls back rather than binding port 0');
  assert.equal(withPort(undefined), LAN_HTTPS_DEFAULT_PORT);
  // Garbage must not reach `server.port`, where Vite would either bind
  // something surprising or crash with strictPort set.
  assert.equal(withPort('not-a-port'), LAN_HTTPS_DEFAULT_PORT);
  assert.equal(withPort('0'), LAN_HTTPS_DEFAULT_PORT, 'port 0 would pick a random port nothing could reach');
  assert.equal(withPort('-1'), LAN_HTTPS_DEFAULT_PORT);
  assert.equal(withPort('65536'), LAN_HTTPS_DEFAULT_PORT, 'above the port range');
  assert.equal(withPort('5443.5'), LAN_HTTPS_DEFAULT_PORT, 'not an integer');
}

// ── lanHttpsOptions: an unusable environment throws, and says what to set ──
{
  const read = () => assert.fail('must not open any file when the pair is incomplete');
  for (const env of [
    {},
    { theDAW_HTTPS_CERT: '/c/c.pem' },
    { theDAW_HTTPS_KEY: '/c/k.pem' },
    { theDAW_HTTPS_CERT: ' ', theDAW_HTTPS_KEY: ' ' },
  ]) {
    assert.throws(
      () => lanHttpsOptions(env, read),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /theDAW_HTTPS_CERT/, 'the thrown message names the variables');
        assert.match(message, /theDAW_HTTPS_KEY/);
        // The throw and the launcher's log line come from one diagnosis, so
        // they cannot drift: the message must CONTAIN describeLanHttps' reason.
        assert.ok(
          message.includes(describeLanHttps(env).reason ?? '\u0000'),
          `the thrown message must carry describeLanHttps' reason verbatim, got: ${message}`,
        );
        return true;
      },
      `lanHttpsOptions(${JSON.stringify(env)}) must refuse rather than serve a broken listener`,
    );
  }
}

// ── each dev server keeps its own dependency cache ─────────────────────────
// The desktop shell runs two dev servers at once: its renderer server and this
// LAN server, a different Vite with a different config. On one shared cache
// folder each rebuilt the other's cache and replaced the files it was serving,
// and the window stayed black after the boot cinematic. So the LAN server and
// the desktop renderer each name a folder of their own, and neither is Vite's
// default, which the browser-mode server uses.
{
  const VITE_DEFAULT = 'node_modules/.vite';
  assert.notEqual(LAN_CACHE_DIR, VITE_DEFAULT, 'the LAN server leaves the default cache alone');
  const here = dirname(fileURLToPath(import.meta.url));
  const desktop = readFileSync(resolve(here, '../../../electron-ui/electron.vite.config.ts'), 'utf8');
  const named = /cacheDir:\s*resolve\(__dirname,\s*'\.\.\/frontend\/(node_modules\/[^']+)'\)/.exec(desktop);
  assert.ok(named, 'the desktop renderer server names its own cacheDir');
  assert.notEqual(named![1], VITE_DEFAULT, 'the desktop renderer leaves the default cache alone');
  assert.notEqual(named![1], LAN_CACHE_DIR, 'the desktop renderer and the LAN server do not share a cache');
}

console.log('lanHttps: all assertions passed');
