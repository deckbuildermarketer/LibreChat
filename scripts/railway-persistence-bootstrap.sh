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
PERSISTENCE_MARKER="$PERSIST_UPLOADS/.dbm-persistence-marker"

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

# A non-secret sentinel gives production logs an explicit cross-deployment
# persistence check without exposing or inspecting user/skill file contents.
if [ -f "$PERSISTENCE_MARKER" ]; then
  log "cross-deploy persistence marker verified"
else
  printf '%s\n' "initialized" > "$PERSISTENCE_MARKER"
  log "cross-deploy persistence marker initialized"
fi

log "uploads -> persistent Railway volume: $PERSIST_UPLOADS"

# One-time, explicitly enabled recovery for a generated GitHub Skill Sync
# mirror cache. The author directory is synthetic and reproducible from the
# configured source id; deleting it is safe because the corrected sync will
# rehydrate the current mirror from GitHub. This is opt-in so ordinary user
# upload directories can never be selected by accident.
REPAIR_AUTHOR_ID="${DBM_REPAIR_GITHUB_SKILL_SYNC_AUTHOR_ID:-}"
if [ -n "$REPAIR_AUTHOR_ID" ]; then
  case "$REPAIR_AUTHOR_ID" in
    *[!0-9a-fA-F]*)
      log "invalid DBM_REPAIR_GITHUB_SKILL_SYNC_AUTHOR_ID; expected 24 hex characters"
      exit 1
      ;;
  esac
  if [ "${#REPAIR_AUTHOR_ID}" -ne 24 ]; then
    log "invalid DBM_REPAIR_GITHUB_SKILL_SYNC_AUTHOR_ID length; expected 24 hex characters"
    exit 1
  fi

  REPAIR_TARGET="$PERSIST_UPLOADS/$REPAIR_AUTHOR_ID"
  REPAIR_MARKER="$PUBLIC_IMAGES/.dbm-skill-sync-local-path-repair-$REPAIR_AUTHOR_ID.done"

  if [ -f "$REPAIR_MARKER" ]; then
    log "one-time GitHub Skill Sync mirror repair marker verified"
  else
    case "$REPAIR_TARGET" in
      "$PERSIST_UPLOADS"/*) ;;
      *)
        log "refusing GitHub Skill Sync mirror repair outside persistent uploads"
        exit 1
        ;;
    esac

    if [ -d "$REPAIR_TARGET" ]; then
      rm -rf -- "$REPAIR_TARGET"
      log "purged one-time GitHub Skill Sync mirror cache for synthetic author $REPAIR_AUTHOR_ID"
    else
      log "GitHub Skill Sync mirror cache was already absent for synthetic author $REPAIR_AUTHOR_ID"
    fi

    printf '%s\n' "completed" > "$REPAIR_MARKER"
    log "one-time GitHub Skill Sync mirror repair completed"
  fi
fi

exec npm run backend
