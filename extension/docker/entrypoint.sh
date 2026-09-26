#!/bin/sh
# Both node_modules live in named volumes, which Docker seeds from the image only once.
# Re-install a package when its package-lock.json (bind-mounted from the host) no longer matches its volume.
set -e
for dir in /repo/avatar /repo/extension; do
  stamp="$dir/node_modules/.package-lock.sha256"
  want=$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)
  if [ "$(cat "$stamp" 2>/dev/null)" != "$want" ]; then
    echo "entrypoint: $dir/package-lock.json changed, running npm ci" >&2
    find "$dir/node_modules" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    (cd "$dir" && npm ci --no-audit --no-fund)
    echo "$want" > "$stamp"
  fi
done
exec "$@"
