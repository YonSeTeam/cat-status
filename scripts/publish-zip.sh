#!/usr/bin/env bash
# Packs the mod and puts the archive where friends download it from
# (GET /cat-status.zip on the server). Run it after every change to the mod
# that friends should get; otherwise they install a stale version.
#
#   scripts/publish-zip.sh
set -euo pipefail
. "$(dirname "$0")/env.sh"

python "$ROOT/scripts/pack-zip.py" "$ROOT/dist/cat-status.zip"
scp "${SSH_OPTS[@]}" "$ROOT/dist/cat-status.zip" "$SERVER:$REMOTE_DIR/public/cat-status.zip"
curl -s -o /dev/null -w "$PUBLIC_URL/cat-status.zip -> %{http_code}, %{size_download} bytes\n" \
  "$PUBLIC_URL/cat-status.zip"
