# Maintenance: `device_status_log` growth & space reclaim (#142)

## What changed in 1.9.2-beta1

`device_status_log` previously grew without an effective bound (the per-device
insert-time prune missed removed/idle devices and the heartbeat `offline_timeout`
insert). In one deployment it reached ~1.2M rows / ~119 MB over ~23 days and
degraded dashboard performance.

1.9.2-beta1 bounds further growth:

- **Index** `idx_device_status_log_device_ts(device_id, timestamp)` — the dashboard
  uptime query and the prunes now use an index instead of a full scan.
- **Global retention sweep** (`pruneStatusLog()`), run on startup and on the
  heartbeat interval, deletes rows older than **`STATUS_LOG_RETENTION_DAYS`**
  (default **3**) across *all* devices — including removed/idle devices and the
  `offline_timeout` rows the per-device prune never revisited.

## Reclaiming space on an already-bloated database

> **Operator action — only needed once, only if your `device_status_log` is already
> bloated from a pre-1.9.2 deployment.**

Retention bounds *future* growth, but SQLite does **not** return freed pages to the
filesystem on `DELETE` — the file stays at its high-water mark until a `VACUUM`.
After upgrading (which prunes the old rows), reclaim the disk with a **one-time
manual `VACUUM` in a maintenance window**:

```sh
# stop the server (or do this during a low-traffic window — VACUUM takes a global
# write lock and rewrites the whole DB file; the app cannot write during it)
sqlite3 /opt/screentinker/server/db/remote_display.db 'VACUUM;'
```

In the reference incident this took the DB from **119 MB → 39 MB**.

### Why VACUUM is not automatic

`VACUUM` locks the database and rewrites the entire file — unacceptable on the hot
path. `PRAGMA auto_vacuum=INCREMENTAL` is **not** enabled either: it only takes
effect on a freshly-created database (set before the first table) or after a
one-time full `VACUUM` to convert an existing DB, so enabling it would be a no-op on
existing installs and a silent behavior change on new ones. Space reclaim is left as
a deliberate operator decision; ongoing growth is already bounded by retention.
