#!/bin/sh
set -eu

PUBLIC_IMAGES="/app/client/public/images"
UPLOADS="/app/uploads"
PERSIST_ROOT="/app/persist"
PERSIST_IMAGES_NAME=".dbm-persist-images"
PERSIST_UPLOADS_NAME=".dbm-persist-uploads"

log() {
  printf '%s\n' "[dbm-persistence] $*"
}

# Final layout: Railway mounts the existing single persistent volume at
# /app/persist, then these two application paths point at separate directories
# on that private mount. This keeps private uploads outside the public images
# tree while preserving the existing image URLs.
if [ -d "$PERSIST_ROOT/$PERSIST_IMAGES_NAME" ] && [ -d "$PERSIST_ROOT/$PERSIST_UPLOADS_NAME" ]; then
  log "persistent root detected at $PERSIST_ROOT"

  rm -rf "$PUBLIC_IMAGES"
  ln -s "$PERSIST_ROOT/$PERSIST_IMAGES_NAME" "$PUBLIC_IMAGES"

  rm -rf "$UPLOADS"
  ln -s "$PERSIST_ROOT/$PERSIST_UPLOADS_NAME" "$UPLOADS"

  log "images -> $PERSIST_ROOT/$PERSIST_IMAGES_NAME"
  log "uploads -> $PERSIST_ROOT/$PERSIST_UPLOADS_NAME"
  exec npm run backend
fi

# Migration/staging mode. Before the Railway mount is moved, the same volume is
# still mounted directly at /app/client/public/images. Create private subtrees
# inside it and COPY existing user image directories there. Originals are left
# untouched so this deployment is fully reversible.
if [ -d "$PUBLIC_IMAGES" ]; then
  STAGED_IMAGES="$PUBLIC_IMAGES/$PERSIST_IMAGES_NAME"
  STAGED_UPLOADS="$PUBLIC_IMAGES/$PERSIST_UPLOADS_NAME"

  mkdir -p "$STAGED_IMAGES" "$STAGED_UPLOADS"

  for entry in "$PUBLIC_IMAGES"/*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in
      lost+found|uploads)
        continue
        ;;
    esac

    # Hidden staging directories are not matched by the shell glob above.
    # Copy instead of move so current image URLs remain valid during staging.
    cp -a "$entry" "$STAGED_IMAGES/"
  done

  log "migration staging prepared under current image volume"
  log "next step: remount this same Railway volume at $PERSIST_ROOT"
fi

exec npm run backend
