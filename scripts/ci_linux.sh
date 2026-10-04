#!/usr/bin/env bash
# The pull-request pytest job, run on Linux on this machine before a PR opens.
#
#   scripts/ci_linux.sh <branch>
#
# Runs inside WSL (scripts/ci_linux.ps1 and scripts/ci_linux.cmd call it from
# Windows). The branch must be COMMITTED locally first: the mirror clone's
# origin is the Windows repository, so it sees commits and nothing else.
#
# What it does:
#   0. ffmpeg, ffprobe, node and npm on a Linux PATH (scripts/ci_linux_tools.sh
#      installs any that are missing under ~/.local, with no sudo).
#   1. ~/theDAW-ci: fetch <branch> from origin and check it out as ci-mirror.
#   2. Sync ~/.venvs/thedaw-ci with the workflow's own install command, only
#      when uv.lock changed since the last sync (its hash is kept beside the
#      venv).
#   3. Run the EXACT pytest command of the `pytest` job, parsed out of
#      .github/workflows/test.yml by scripts/ci_pytest_command.py at run time,
#      with the job's env. The gate excludes timing tests (-m "not timing").
#   4. Echo the FAILED and ERROR lines again at the end and exit with pytest's
#      code.
#
# CLAUDE.md hard rule 5: this must pass before any pull request is opened.
set -u

branch="${1:-}"
if [ -z "$branch" ]; then
  echo "usage: scripts/ci_linux.sh <branch>   (commit the branch locally first:" >&2
  echo "       the mirror's origin is the Windows repository)" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mirror="${THEDAW_CI_MIRROR:-$HOME/theDAW-ci}"
venv="${THEDAW_CI_VENV:-$HOME/.venvs/thedaw-ci}"
# Linux tools only: WSL appends the Windows PATH (/mnt/c/...), and a Windows
# node.exe or ffmpeg.exe found there fails the tests that start them.
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)"
export PATH="$HOME/.local/bin:$PATH"
# ffmpeg and Node, which the runner has; installed under ~/.local when missing.
bash "$here/ci_linux_tools.sh" || exit 2

cd "$mirror" || { echo "ci_linux: no mirror clone at $mirror" >&2; exit 2; }
git fetch -q origin "$branch" || { echo "ci_linux: origin has no branch $branch (commit it first)" >&2; exit 2; }
git checkout -q -B ci-mirror FETCH_HEAD || exit 2
echo "ci_linux: $branch at $(git log -1 --format='%h %s')"

export UV_PROJECT_ENVIRONMENT="$venv"
stamp="$venv.uv-lock.sha256"
want="$(sha256sum uv.lock | cut -d' ' -f1)"
if [ ! -x "$venv/bin/python" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$want" ]; then
  install="$(python3 "$here/ci_pytest_command.py" --step 'Install dependencies')" \
    || install="uv sync --frozen --group dev"
  echo "ci_linux: uv.lock changed since the last sync: $install"
  eval "$install" || { echo "ci_linux: the install failed" >&2; exit 2; }
  echo "$want" > "$stamp"
fi

exports="$(python3 "$here/ci_pytest_command.py" --env)" || exit 2
eval "$exports"
cmd="$(python3 "$here/ci_pytest_command.py")" || exit 2
case "$cmd" in
  *"not timing"*) ;;
  *) cmd="$cmd -m 'not timing'" ;;
esac
echo "ci_linux: $cmd"

log="$(mktemp)"
set -o pipefail
eval "$cmd" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}

echo
echo "ci_linux: FAILED and ERROR lines"
grep -E '^(FAILED|ERROR) ' "$log" || echo "(none)"
echo "ci_linux: $(grep -E '(passed|failed|error)' "$log" | tail -n 1)"
rm -f "$log"
exit "$code"
