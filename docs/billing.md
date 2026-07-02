# Billing — Usage Metering (ByteTinker–Bold Media distribution agreement)

**This is the contractual SYSTEM-OF-RECORD for invoicing (agreement §4.1/§4.2).** The math
below is implemented exactly in `server/lib/billing.js`; the defaults in `config.billing`
ARE the agreement — change them only if the contract changes.

## The formula

- **Provisioned Screen** — any device registered/provisioned. Provisioning alone is **not**
  billed.
- **Active Screen-Day (ASD)** — per device, per calendar day:
  ```
  ASD = min(1.0, online_seconds_that_day / (BILLING_HOURS_PER_DAY * 3600))   # denom = 28800 (8h)
  ```
  Online ≥ 8h → 1.0; 4h → 0.5; offline → 0. Time beyond 8h does **not** increase it.
- **Billable Screens** — per billing month:
  ```
  BillableScreens = round( Σ ASD (all devices, all calendar days in month) / days_in_month )
  ```
  i.e. the average number of screens active during a standard 8-hour day, **rounded half up**.
- **Tier** — FLAT (not marginal): the single rate for the month's total Billable Screens.

  | Billable Screens | Rate / screen / month |
  |---|---|
  | 1 – 499 | $1.50 |
  | 500 – 999 | $1.25 |
  | 1000 or more | $1.00 |

- **Cost (USD)** = BillableScreens × applicable tier rate.

Single **global** rate card for now; per-tenant rate cards are a future concern (would key
the rate table by workspace/org). All values are config-driven: `BILLING_HOURS_PER_DAY`,
`BILLING_RATE_TABLE` (JSON override), `BILLING_USAGE_RETENTION_DAYS`.

## Data foundation

- **`device_usage_daily(device_id, day 'YYYY-MM-DD', online_seconds)`** — a durable daily
  rollup, one tiny row per device per calendar day (`day` is **UTC**). `device_status_log`
  (3-day) and `device_telemetry` (~24h) cannot back a billing month, so this is separate.
- **Accumulated incrementally** off the heartbeat tick from the **live connection map**
  (`services/heartbeat.js` `deviceConnections` — the same source `devices_connected` uses),
  never reconstructed from logs. Each tick credits every connected device's today-row with
  the elapsed seconds (`online_seconds = min(86400, online_seconds + credit)`), chunked and
  transactional so it never blocks the event loop. Per-tick credit is capped
  (`BILLING_ACCRUAL_CAP_SECONDS`) so a stalled loop / restart gap can't inject a bogus credit.
- **Retention** ~400 days, pruned via the chunked-prune helper (`pruneUsageDaily`) so it can
  never bloat-then-freeze.

## API (admin-only, standalone route)

`GET /api/billing/usage?month=YYYY-MM` (default: current month) — readable via a
**`billing:read` scoped API token** (owner/platform-admin-minted, revocable, grants
billing-read ONLY) **OR** a platform-admin session; a `billing:read` token is the intended
consumer (tooling / invoice-time pulls / §4.2 verification) and cannot reach any other
endpoint. Mounted separately from `/api/status` (billing is revenue data and a heavier
aggregate; it must not touch the hot status path). Reads the rollup only. Returns:
`{ month, days_in_month, days_elapsed, provisioned_screens, billable_screens,
billable_screens_final?, is_final, tier, rate_usd, cost_usd, daily:[{day, active_screen_days}] }`.

**Minting a `billing:read` token — owner only:** billing tokens are minted server-side by
the platform owner via `node scripts/mint-billing-token.js --name "<label>"` (printed ONCE;
`--list` / `--revoke <id>` to manage). They are **intentionally NOT** in the workspace
API-Tokens UI (that surface is workspace-scoped and self-service; a billing token grants
platform-wide billing-read). The token authorizes ONLY `GET /api/billing/usage` — off the
read/write/full ladder, refused everywhere else.

**Month-to-date rule:** for the current month the average is computed over **completed
calendar days only** — today accrues live and appears in `daily` but is excluded from the
running average until it completes, so a partial today doesn't drag the estimate.
`billable_screens_final` and `is_final:true` appear only once the month is complete.

## First-full-month caveat

Metering starts accumulating **at deploy**. The first partial calendar month is incomplete
(and there is **no backfill** — `device_status_log` only holds 3 days). **The first FULL,
clean billing month is the first whole calendar month after beta7 is deployed.**
