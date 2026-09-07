# Releasing theDAW

This document is the full recipe for cutting a release. The automation
lives in `.github/workflows/release.yml`.

## Version authority and sync rule

`electron-ui/package.json` holds the canonical application version.
`pyproject.toml` must carry the identical version string at all times.
The release workflow fails fast when the pushed tag, `electron-ui/package.json`,
and `pyproject.toml` disagree, so every version bump touches both files in
the same commit.

Tags follow v-prefixed semver: tag `v0.2.0` corresponds to version `0.2.0`
in both files.

## Release recipe

1. Bump `version` in `electron-ui/package.json` to the new `X.Y.Z`.
2. Bump `version` in `pyproject.toml` to the identical `X.Y.Z`.
3. Commit both files together on `main`.
4. Create the tag: `git tag vX.Y.Z`.
5. Push the tag: `git push origin vX.Y.Z`.

The tag push triggers the Release workflow.

## What CI produces on a tag push

The workflow runs four jobs:

- `version-check` verifies that the tag, `electron-ui/package.json`, and
  `pyproject.toml` all declare the same version, then creates a DRAFT
  GitHub Release named `vX.Y.Z`.
- `windows-exe` builds `theDAW-Setup-X.Y.Z.exe` (NSIS installer), uploads
  it as a workflow artifact (7-day retention), and attaches it to the
  draft release.
- `macos-dmg` builds `theDAW-X.Y.Z-arm64.dmg` (Apple Silicon only),
  uploads it as a workflow artifact (7-day retention), and attaches it to
  the draft release.
- `docker-ghcr` builds the root `Dockerfile` and pushes
  `ghcr.io/gantasmo/thedaw:X.Y.Z` and `ghcr.io/gantasmo/thedaw:latest`.

CI never publishes the GitHub Release. A maintainer finishes the release
manually: open the draft release on GitHub, confirm both installers are
attached, write the release notes, and click "Publish release" (or run
`gh release edit vX.Y.Z --draft=false`).

## Manual dispatch builds

Running the workflow via `workflow_dispatch` produces a dry build without
a release. The version is taken from `electron-ui/package.json`, the
installers exist only as 7-day workflow artifacts, and the Docker job
pushes `ghcr.io/gantasmo/thedaw:sha-<shortsha>` instead of `:latest`.

## Local builds

CI builds with Node 22, pinned as `NODE_VERSION` in
`.github/workflows/release.yml`. Local builds should use the same major
version.

- Windows installer: run `npm ci` in `frontend/` and `electron-ui/`, then
  `npm run dist:win` inside `electron-ui/`. The installer lands at
  `electron-ui/release/theDAW-Setup-X.Y.Z.exe`.
- Docker: run `docker compose up` from the repo root to build and start
  the image locally.

## Required repository secret

The installer jobs build the SwayCommand embed bundle (the SWAY tab) from a
checkout of the private `danieljtrujillo/SwayCommand` repo, which the
workflow's built-in `GITHUB_TOKEN` cannot read, so the workflow needs one
extra secret:

- `SWAY_REPO_TOKEN`: a fine-grained personal access token with
  `Contents: read` on `danieljtrujillo/SwayCommand`, stored as an Actions
  repository secret on `gantasmo/theDAW` (Settings > Secrets and
  variables > Actions).

Each installer job checks SwayCommand out at the commit pinned as
`SWAY_REF` in `.github/workflows/release.yml` and hands the path to
`electron-ui/scripts/fetch-sway-build.mjs` through `SWAY_PROJECT`; the
script runs `npm run build:renderer:embed` there. Bump `SWAY_REF` when a
newer cockpit should ship. No SwayCommand release asset is involved.

`version-check` fails in seconds when the secret is missing, before either
installer job starts. Adding the secret and re-running the failed jobs is
enough; the tag does not need to move. The v0.1.4 tag build failed for
exactly this reason: both installer jobs died in the SwayCommand fetch step.

## Signing status

- The Windows installer is unsigned. SmartScreen shows a warning on first
  run; choosing "More info" and then "Run anyway" proceeds with the
  install.
- The macOS disk image is unsigned and un-notarized, and it targets arm64
  (Apple Silicon) only. Gatekeeper blocks a plain double-click. Either
  right-click (Control-click) the app and choose "Open", or clear the
  quarantine attribute:
  `xattr -d com.apple.quarantine /Applications/theDAW.app`.
- First launch of the desktop app bootstraps the Python backend with uv
  and downloads several GB of dependencies and model weights.

## Docker image usage

```
docker run --rm -p 8600:8600 ghcr.io/gantasmo/thedaw:latest
```

The app is then reachable at `http://localhost:8600`.
