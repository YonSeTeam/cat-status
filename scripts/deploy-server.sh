#!/usr/bin/env bash
# Deploys the presence server: uploads server/, rebuilds the image, restarts
# the container. The friends' room state lives in memory, so a restart empties
# the rooms; the mods put everyone back at their next heartbeat (8 s).
#
#   scripts/deploy-server.sh
set -euo pipefail
. "$(dirname "$0")/env.sh"

ssh "${SSH_OPTS[@]}" "$SERVER" "mkdir -p $REMOTE_DIR/public"
scp "${SSH_OPTS[@]}" "$ROOT/server/server.js" "$ROOT/server/Dockerfile" "$SERVER:$REMOTE_DIR/"
scp "${SSH_OPTS[@]}" "$ROOT/server/public/install.md" "$SERVER:$REMOTE_DIR/public/install.md"

ssh "${SSH_OPTS[@]}" "$SERVER" "
  set -e
  cd $REMOTE_DIR
  docker build -q -t cat-sync:latest . >/dev/null
  docker rm -f cat-sync >/dev/null 2>&1 || true
  docker run -d --name cat-sync --restart unless-stopped ${CAT_PUBLIC_URL:+-e PUBLIC_URL=$CAT_PUBLIC_URL} \
    -p 0.0.0.0:9797:9797 -v $REMOTE_DIR/public:/app/public:ro cat-sync:latest >/dev/null
  sleep 2
  docker ps --filter name=cat-sync --format '{{.Status}}'
"
curl -s --max-time 8 "$PUBLIC_URL/health" || true
echo
