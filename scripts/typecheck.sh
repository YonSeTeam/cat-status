#!/usr/bin/env bash
# Type-checks the mod against the API of the installed Claude Code.
#
# Claude Code writes tsconfig.json and .claude-plugin/types/ beside the mod
# each time it loads it, so open a session first if they are missing. With
# Node here, tsc runs locally; without it, in a throwaway Node container on
# $CAT_SERVER (see scripts/env.sh).
#
#   scripts/typecheck.sh
#
# Not checked here: the engine's own rule that `$` may only be passed to
# functions declared at the top level of the file. A "reload failed" line in the
# transcript is where that one shows up.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if command -v npx >/dev/null 2>&1; then
  cd "$ROOT"
  npx -y -p typescript@5.6 tsc -p tsconfig.json --pretty false
  echo "tsc done"
  exit
fi

. "$(dirname "$0")/env.sh"
cd "$ROOT/.."
tar czf /tmp/cat-typecheck.tgz "$(basename "$ROOT")"
scp "${SSH_OPTS[@]}" /tmp/cat-typecheck.tgz "$SERVER:/tmp/cat-typecheck.tgz"
ssh "${SSH_OPTS[@]}" "$SERVER" '
  set -e
  rm -rf /tmp/cat-typecheck && mkdir -p /tmp/cat-typecheck
  tar xzf /tmp/cat-typecheck.tgz -C /tmp/cat-typecheck
  docker run --rm -v /tmp/cat-typecheck/'"$(basename "$ROOT")"':/w -w /w node:24-alpine \
    sh -c "npx -y -p typescript@5.6 tsc -p tsconfig.json --pretty false 2>&1 | grep -v \"npm notice\" || true"
  echo "tsc done"
  rm -rf /tmp/cat-typecheck /tmp/cat-typecheck.tgz
'
