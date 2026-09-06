#!/bin/sh
set -eu

# Railway currently mounts one persistent volume for DBM Chat at the public
# images directory. Reuse a hidden subtree of that same volume for private
# LibreChat uploads/skill reference files, then expose it only to the backend
# through /app/uploads. This avoids a second Railway volume while keeping the
# application-facing upload path stable across redeploys.
PUBLIC_IMAGES="${RAILWAY_VOLUME_MOUNT_PATH:-/app/client/public/images}"
UPLOADS="/app/uploads"
PERSIST_UPLOADS_NAME=".dbm-persist-uploads"
PERSIST_UPLOADS="$PUBLIC_IMAGES/$PERSIST_UPLOADS_NAME"

log() {
  printf '%s\n' "[dbm-persistence] $*"
}

if [ ! -d "$PUBLIC_IMAGES" ]; then
  log "persistent Railway volume not found at $PUBLIC_IMAGES; starting without upload persistence"
  exec npm run backend
fi

mkdir -p "$PERSIST_UPLOADS"

# Migrate any files that already exist in the image/container upload directory
# before replacing it with the persistent symlink. Copy first, then switch.
# Existing persistent files are preserved by cp -a unless the current runtime
# carries a newer file with the same path, which is the correct recovery
# behavior after an interrupted migration.
if [ ! -L "$UPLOADS" ] && [ -d "$UPLOADS" ]; then
  if [ -n "$(find "$UPLOADS" -mindepth 1 -print -quit 2>/dev/null || true)" ]; then
    cp -a "$UPLOADS"/. "$PERSIST_UPLOADS"/
    log "migrated existing runtime uploads into persistent storage"
  fi
  rm -rf "$UPLOADS"
fi

# Repair an old or incorrect symlink if one exists.
if [ -L "$UPLOADS" ]; then
  current_target="$(readlink "$UPLOADS" || true)"
  if [ "$current_target" != "$PERSIST_UPLOADS" ]; then
    rm -f "$UPLOADS"
  fi
fi

if [ ! -e "$UPLOADS" ]; then
  ln -s "$PERSIST_UPLOADS" "$UPLOADS"
fi

log "uploads -> persistent Railway volume: $PERSIST_UPLOADS"

exec npm run backend
