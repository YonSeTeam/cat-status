# Shared settings for the scripts, all from the environment:
#   CAT_SERVER      user@host the scripts reach over SSH (required)
#   CAT_SSH_KEY     private key for that host (default: ssh's own choice)
#   CAT_REMOTE_DIR  where the server lives on that host (default: /opt/cat-sync)
#   CAT_PUBLIC_URL  the server's address as friends reach it, for the checks
#                   (default: http://<host of CAT_SERVER>:9797); when set, the
#                   container gets it as PUBLIC_URL for /install
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${CAT_SERVER:?set CAT_SERVER to the user@host of your server}"
REMOTE_DIR="${CAT_REMOTE_DIR:-/opt/cat-sync}"
PUBLIC_URL="${CAT_PUBLIC_URL:-http://${SERVER#*@}:9797}"
SSH_OPTS=(-o BatchMode=yes)
if [ -n "${CAT_SSH_KEY:-}" ]; then SSH_OPTS+=(-i "$CAT_SSH_KEY"); fi
