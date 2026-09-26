#!/bin/sh
# node_modules lives in a named volume, which Docker seeds from the image only once.
# Re-install when package-lock.json (bind-mounted from the host) no longer matches what the volume holds.
set -e
stamp=node_modules/.package-lock.sha256
want=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ "$(cat "$stamp" 2>/dev/null)" != "$want" ]; then
  echo "entrypoint: package-lock.json changed, running npm ci" >&2
  find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  npm ci --no-audit --no-fund
  echo "$want" > "$stamp"
fi
exec "$@"
