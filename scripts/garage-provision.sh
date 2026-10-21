#!/usr/bin/env bash
# Idempotently provisions the dev Garage (S3) instance:
#   - assigns this node to the cluster layout (required before any storage works)
#   - imports a fixed dev access key (id + secret, no random output to copy around)
#   - creates the app bucket and grants that key read/write/owner on it
#
# Used by both dev-service variants:
#   - docker:   `pnpm services:up` calls it with the default GARAGE below
#   - nix:      flake.nix reuses this script with GARAGE pointed at the nix
#               garage binary + the config it generates in .data/garage/
#
# Keep the key id/secret in sync with .env.example.
set -euo pipefail

# Garage invocation, overridable via env. Default targets the docker compose service.
# shellcheck disable=SC2086  # word-splitting of $GARAGE is intentional
GARAGE="${GARAGE:-docker compose exec -T garage /garage -c /etc/garage/garage.toml}"

BUCKET="${S3_BUCKET:-catalog-forge}"
KEY_ID="${S3_ACCESS_KEY_ID:-GK0123456789abcdef01234567}"
SECRET="${S3_SECRET_ACCESS_KEY:-941431a5c0f40a678c1ecf010982a2a23f9536ada8d3893cd0641d78ac6cf53c}"

# shellcheck disable=SC2086
g() { $GARAGE "$@"; }

# node key is written on first boot; retry briefly in case of a slow start
RAW_ID=""
for _ in $(seq 1 10); do
  RAW_ID="$(g node id 2>/dev/null || true)" && [ -n "$RAW_ID" ] && break
  sleep 1
done
[ -n "$RAW_ID" ] || { echo "error: could not read garage node id — is the server running?" >&2; exit 1; }
NODE_ID="${RAW_ID%%@*}"
echo "==> garage: node ${NODE_ID:0:16}…"

# A node must be assigned to the layout before it can store anything.
# layout show lists assigned nodes by 16-char id prefix.
if g layout show 2>/dev/null | grep -q "^${NODE_ID:0:16}"; then
  echo "==> garage: layout already assigned"
else
  g layout assign -z dc1 -c 2GB "$NODE_ID"
  g layout apply --version 1
fi

if g key info "$KEY_ID" >/dev/null 2>&1; then
  echo "==> garage: dev key already imported"
else
  g key import "$KEY_ID" "$SECRET" -n dev --yes
fi

if g bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "==> garage: bucket $BUCKET already exists"
else
  g bucket create "$BUCKET"
fi

# Re-granting is idempotent.
g bucket allow "$BUCKET" --read --write --owner --key "$KEY_ID"

echo "==> garage: ready — S3 at ${S3_ENDPOINT:-http://127.0.0.1:9000}, bucket '$BUCKET'"
