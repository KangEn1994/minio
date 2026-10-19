#!/usr/bin/env bash
set -euo pipefail

# Local-only convenience launcher. Use a TLS reverse proxy and separate process
# supervision for a remote deployment.
MINIO_BIN="${MINIO_BIN:-minio}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-$SCRIPT_DIR/minio-data}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9000}"
CONSOLE_HOST="${CONSOLE_HOST:-127.0.0.1}"
CONSOLE_PORT="${CONSOLE_PORT:-9090}"
if [[ -z "${MINIO_ROOT_USER:-}" || -z "${MINIO_ROOT_PASSWORD:-}" ]]; then
  echo 'Set MINIO_ROOT_USER and MINIO_ROOT_PASSWORD before starting.' >&2
  exit 1
fi
if ! command -v "$MINIO_BIN" >/dev/null 2>&1; then
  echo "MinIO executable not found: $MINIO_BIN" >&2
  exit 1
fi
mkdir -p "$MINIO_DATA_DIR"
"$MINIO_BIN" server "$MINIO_DATA_DIR" --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 &
minio_pid=$!
trap 'kill "$minio_pid" 2>/dev/null || true' EXIT INT TERM
unset MINIO_ROOT_USER MINIO_ROOT_PASSWORD
export MINIO_ENDPOINT CONSOLE_HOST CONSOLE_PORT
node "$SCRIPT_DIR/server.js"
