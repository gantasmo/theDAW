// LAN config: the normal dev config served over HTTPS on a second port, beside
// the developer's own http://localhost:5173.
//
// Why it exists: a browser only exposes AudioContext.audioWorklet, the
// microphone, Web MIDI, the clipboard and crypto.subtle in a SECURE CONTEXT --
// https:// or localhost. Opened from another computer at http://<lan-ip>:5173
// the page is neither, `ctx.audioWorklet` is undefined, and the EDIT tab dies
// with "Cannot read properties of undefined (reading 'addModule')". Serving the
// same app over TLS on the LAN gives every device a secure context with nothing
// to configure on the device. The http server on :5173 is left exactly as it is.
//
// Same wrapper shape as vite.shots.config.ts: import the base config, change
// the listener, keep everything else (proxy, xfwd, aliases, plugins) as-is so
// the backend's trust gates see the real client address exactly as they do now.
//
//   theDAW_HTTPS_CERT=<cert.pem> theDAW_HTTPS_KEY=<key.pem> \
//     npx vite --config vite.lan.config.ts
import fs from 'node:fs';
import { defineConfig, type UserConfig } from 'vite';
import base from './vite.config.ts';

/** Mirrors `backend.ports.LAN_HTTPS_PORT`: the one port the LAN listener uses
 *  unless `theDAW_HTTPS_PORT` says otherwise. */
export const LAN_HTTPS_DEFAULT_PORT = 5443;

/** Whether this environment can serve HTTPS, and — when it cannot — one short
 *  clause saying why, for a launcher to put in its log. */
export interface LanHttpsDescription {
  enabled: boolean;
  /** Absent when `enabled`. */
  reason?: string;
}

/**
 * Can the LAN listener start with this environment, and if not, why not?
 *
 * Pure over the environment alone: no filesystem, no network. A launcher
 * (`backend/_devstack.py`, `electron-ui/main/index.ts`) decides whether to
 * spawn `vite --config vite.lan.config.ts` at all, and when it decides not to
 * the user needs to be told the reason rather than left wondering why the LAN
 * address is still plain http. Whether the paths actually EXIST is the
 * launcher's question (it is the side that mints the certificate); this
 * answers only whether it was told about a pair.
 *
 * `reason` is deliberately absent — not empty-string — when enabled, so a
 * caller that logs `reason` unconditionally prints nothing rather than a
 * dangling separator.
 */
export function describeLanHttps(env: Record<string, string | undefined>): LanHttpsDescription {
  const certPath = (env.theDAW_HTTPS_CERT ?? '').trim();
  const keyPath = (env.theDAW_HTTPS_KEY ?? '').trim();
  if (certPath && keyPath) return { enabled: true };
  if (!certPath && !keyPath) {
    return { enabled: false, reason: 'no certificate: theDAW_HTTPS_CERT and theDAW_HTTPS_KEY are both unset' };
  }
  return {
    enabled: false,
    reason: certPath
      ? 'incomplete certificate pair: theDAW_HTTPS_CERT is set but theDAW_HTTPS_KEY is not'
      : 'incomplete certificate pair: theDAW_HTTPS_KEY is set but theDAW_HTTPS_CERT is not',
  };
}

/** The listener options for the LAN server, from the environment. Pure, so it
 *  is testable without a certificate on disk: `read` is injectable. Throws a
 *  message a person can act on when the pair is incomplete. */
export function lanHttpsOptions(
  env: Record<string, string | undefined>,
  read: (path: string) => Buffer | string = (p) => fs.readFileSync(p),
): { port: number; https: { cert: Buffer | string; key: Buffer | string } } {
  const certPath = (env.theDAW_HTTPS_CERT ?? '').trim();
  const keyPath = (env.theDAW_HTTPS_KEY ?? '').trim();
  const described = describeLanHttps(env);
  if (!described.enabled) {
    // One source of truth for the diagnosis, so the thrown message and the
    // launcher's log line can never drift apart.
    throw new Error(
      `vite.lan.config.ts cannot serve HTTPS — ${described.reason}. Set both to the paths of a PEM ` +
        'certificate and its key.',
    );
  }
  const rawPort = Number((env.theDAW_HTTPS_PORT ?? '').trim() || LAN_HTTPS_DEFAULT_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : LAN_HTTPS_DEFAULT_PORT;
  return { port, https: { cert: read(certPath), key: read(keyPath) } };
}

/**
 * The LAN server's own dependency cache, apart from `node_modules/.vite`.
 *
 * In desktop mode this server starts a few seconds after the Electron shell's
 * renderer server (electron-ui/electron.vite.config.ts), which is a different
 * Vite with a different config. Sharing one cache folder, each found the
 * other's cache, rebuilt it under its own file names, and replaced the folder
 * the other was serving from. The window then asked for dependency chunks that
 * no longer existed and stayed black after the boot cinematic, until a second
 * launch happened to finish in the other order.
 */
export const LAN_CACHE_DIR = 'node_modules/.vite-lan';

export default defineConfig(async (env) => {
  const cfg = (await (base as unknown as (e: typeof env) => Promise<UserConfig> | UserConfig)(env)) as UserConfig;
  const { port, https } = lanHttpsOptions(process.env);
  const server = { ...(cfg.server ?? {}), port, https, host: '0.0.0.0', strictPort: true };
  return { ...cfg, cacheDir: LAN_CACHE_DIR, server };
});
