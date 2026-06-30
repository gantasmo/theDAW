// Fetch the two native binaries the packaged Windows app bootstraps with:
//   - uv.exe     (Astral) builds the Python venv and pulls a managed CPython 3.10
//   - ffmpeg.exe (gyan.dev) backs every audio I/O path in the backend
//
// Both land in electron-ui/resources/tools/ so electron-builder copies them into
// the installer under resources/tools/ (see electron-builder.yml -> extraResources).
// The directory is gitignored; this script repopulates it before each packaged
// build. It is idempotent: an existing, non-empty binary is left untouched.
//
// Sources match install/setup.ps1 (astral.sh for uv, gyan.dev for FFmpeg) so the
// installer trusts the same upstreams the manual setup path already does.
//
// Run:  node scripts/fetch-runtime-tools.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, statSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const toolsDir = resolve(__dirname, '..', 'resources', 'tools')

const UV_URL =
  'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

function log(msg) {
  process.stdout.write(`[fetch-tools] ${msg}\n`)
}

// A zero-byte or missing file means we still need to fetch it.
function present(p) {
  try {
    return existsSync(p) && statSync(p).size > 0
  } catch {
    return false
  }
}

async function download(url, dest) {
  log(`downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`download failed (${res.status} ${res.statusText}) for ${url}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const { writeFileSync } = await import('node:fs')
  writeFileSync(dest, buf)
  log(`saved ${(buf.length / 1e6).toFixed(1)} MB -> ${dest}`)
}

// Extract with PowerShell Expand-Archive. This script only runs on the Windows
// build host (it fetches .exe binaries), and Windows tar.exe misparses a drive
// path like C:\... as an [user@]host:path remote, so Expand-Archive is the
// reliable choice here.
function unzip(zipPath, outDir) {
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force`,
    ],
    { stdio: 'inherit' },
  )
}

// Depth-first search for the first file named `name` under `root`.
function findFile(root, name) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.toLowerCase() === name.toLowerCase()) return full
    }
  }
  return null
}

async function fetchUv() {
  const dest = join(toolsDir, 'uv.exe')
  if (present(dest)) {
    log('uv.exe already present, skipping')
    return
  }
  const work = join(tmpdir(), 'thedaw-fetch-uv')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const zip = join(work, 'uv.zip')
  await download(UV_URL, zip)
  unzip(zip, work)
  const found = findFile(work, 'uv.exe')
  if (!found) throw new Error('uv.exe not found in the downloaded archive')
  copyFileSync(found, dest)
  log(`installed uv.exe -> ${dest}`)
  rmSync(work, { recursive: true, force: true })
}

async function fetchFfmpeg() {
  const ffmpeg = join(toolsDir, 'ffmpeg.exe')
  const ffprobe = join(toolsDir, 'ffprobe.exe')
  if (present(ffmpeg) && present(ffprobe)) {
    log('ffmpeg.exe + ffprobe.exe already present, skipping')
    return
  }
  const work = join(tmpdir(), 'thedaw-fetch-ffmpeg')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const zip = join(work, 'ffmpeg.zip')
  await download(FFMPEG_URL, zip)
  unzip(zip, work)
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    const found = findFile(work, exe)
    if (!found) throw new Error(`${exe} not found in the downloaded archive`)
    copyFileSync(found, join(toolsDir, exe))
    log(`installed ${exe} -> ${join(toolsDir, exe)}`)
  }
  rmSync(work, { recursive: true, force: true })
}

async function main() {
  mkdirSync(toolsDir, { recursive: true })
  await fetchUv()
  await fetchFfmpeg()
  log('done')
}

main().catch((err) => {
  process.stderr.write(`[fetch-tools] ERROR: ${err.message}\n`)
  process.exit(1)
})
