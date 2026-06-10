#!/bin/bash
# ScreenTinker backup - nightly DB + content backup with point-in-time history.
#
# Install (self-hosters):
#   1. Set SCREENTINKER_DIR if your install isn't at /opt/screentinker.
#   2. Add a root (or service-user) cron entry, e.g.:
#        0 3 * * * /opt/screentinker/scripts/backup.sh
#   3. Restore with:  sqlite3 .backup files copy straight back;
#        cp -a backups/content-<ts>/<file> server/uploads/<file>
#
# What it keeps in $BACKUP_DIR:
#   remote_display-<ts>.db       atomic SQLite snapshot   (kept $DB_KEEP_DAYS days)
#   content-latest/              live mirror of uploads/  (current-state recovery)
#   content-<ts>/                daily point-in-time copy (kept newest $DAILY_KEEP)
#   content-monthly-<YYYYMM>/    long-horizon keep        (kept newest $MONTHLY_KEEP)
#   backup.log                   run log (errors are recorded, not swallowed)
#
# Design notes (learned the hard way):
#   - Content snapshots EXCLUDE uploads/screenshots/: per-device *_latest.jpg files
#     are rewritten 24/7, and `cp -al` aborts when a file mutates mid-copy. That race
#     silently broke snapshots in one deployment for ~8 weeks. rsync --link-dest below
#     hard-links unchanged files (cheap, like cp -al) but tolerates in-flight changes.
#   - Retention sorts by NAME, not mtime: rsync -a / cp -al preserve the source dir's
#     (often frozen) mtime, so `ls -dt` would treat a fresh snapshot as oldest and
#     prune it. The timestamp is in the dir name, so name-sort is chronological.

set -o pipefail
APP_DIR="${SCREENTINKER_DIR:-/opt/screentinker}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
DB="${DB:-$APP_DIR/server/db/remote_display.db}"
UPLOADS="${UPLOADS:-$APP_DIR/server/uploads}"
DAILY_KEEP="${DAILY_KEEP:-7}"
MONTHLY_KEEP="${MONTHLY_KEEP:-12}"
DB_KEEP_DAYS="${DB_KEEP_DAYS:-30}"

LOG="$BACKUP_DIR/backup.log"
TIMESTAMP="$(date +%Y%m%d-%H%M)"
MONTH="$(date +%Y%m)"
mkdir -p "$BACKUP_DIR"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
log "=== backup start $TIMESTAMP (app=$APP_DIR) ==="

# 1) Atomic DB backup (safe while the server is running).
if sqlite3 "$DB" ".backup '$BACKUP_DIR/remote_display-$TIMESTAMP.db'" 2>>"$LOG"; then
  log "db backup ok: remote_display-$TIMESTAMP.db"
else
  log "ERROR: db backup failed (exit $?)"
fi

# 2) Refresh the live content mirror (full, incl. screenshots - current-state DR).
if rsync -a --delete "$UPLOADS/" "$BACKUP_DIR/content-latest/" 2>>"$LOG"; then
  touch "$BACKUP_DIR/content-latest"   # rsync -a leaves the dir mtime frozen; correct it
  log "content-latest mirror refreshed"
else
  log "ERROR: content-latest rsync failed (exit $?)"
fi

# 3) Point-in-time content snapshot (hard-linked, screenshots excluded - see notes).
SNAP="$BACKUP_DIR/content-$TIMESTAMP"
rsync -a --link-dest="$BACKUP_DIR/content-latest" --exclude='/screenshots/' \
  "$BACKUP_DIR/content-latest/" "$SNAP/" 2>>"$LOG"
rc=$?
if { [ "$rc" -eq 0 ] || [ "$rc" -eq 24 ]; } && [ -d "$SNAP" ]; then
  touch "$SNAP"
  log "content snapshot ok: content-$TIMESTAMP ($(find "$SNAP" -type f | wc -l) files, rc=$rc)"
  MONTHLY="$BACKUP_DIR/content-monthly-$MONTH"
  if [ ! -d "$MONTHLY" ]; then
    cp -al "$SNAP" "$MONTHLY" 2>>"$LOG" && touch "$MONTHLY" && log "monthly keep created: content-monthly-$MONTH"
  fi
else
  log "ERROR: content snapshot failed (rsync exit $rc) - see above"
fi

# 4) Retention (name-sorted = chronological; see notes).
find "$BACKUP_DIR" -maxdepth 1 -name "remote_display-*.db" -mtime +"$DB_KEEP_DAYS" -delete 2>>"$LOG"
ls -d "$BACKUP_DIR"/content-2* 2>/dev/null | sort | head -n -"$DAILY_KEEP" | xargs -r rm -rf 2>>"$LOG"
ls -d "$BACKUP_DIR"/content-monthly-* 2>/dev/null | sort | head -n -"$MONTHLY_KEEP" | xargs -r rm -rf 2>>"$LOG"

log "=== backup done $TIMESTAMP ==="
