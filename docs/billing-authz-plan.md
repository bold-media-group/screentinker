# Billing-read authorization — findings, options, recommendation

**Status: PLAN. No code changed.** Goal: a least-privilege way to read `GET /api/billing/usage`
that does NOT require platform-admin, while platform-admin can still read it.

---

## Phase 0 — how authz actually works here

**1. Roles = a fixed, hardcoded enum on `users.role`.** There is NO role→permission mapping.
Authz is `Array.includes(role)` against hardcoded sets in `middleware/auth.js`:
`PLATFORM_ROLES = ['superadmin','platform_admin']`, `ELEVATED_ROLES = ['admin','superadmin',
'platform_admin']`, `PLATFORM_STAFF = [...,'platform_operator']`. Guards are hardcoded
functions: `requireAuth`, `requireAdmin`, `requireSuperAdmin` (`requirePlatformAdmin` is an
alias). The enum is threaded through **~20 server files** plus the frontend role dropdown
(`PLATFORM_ROLE_OPTIONS` in `frontend/js/views/admin.js`) and the #14 role-normalization
migration. Adding a role is a wide change.

**2. The authz seam is per-route middleware, not centralized.** Billing today:
`server.js:582 → app.use('/api/billing', requireAuth, require('./routes/billing'))`, and
`routes/billing.js` gates the handler with `requirePlatformAdmin`. Other endpoints declare
their guard at mount or per-handler. **Note:** this billing mount is *bespoke* — it is NOT in
`config/api-surface.js` (the partition source of truth) and is therefore **not covered by the
firewall test** (`test/api.test.js`). Fixing that is a side-benefit of Option C.

**3. Identity: JWT sessions AND scoped API tokens.** `middleware/apiToken.js` implements a
`Bearer st_…` token front door (`api_tokens` table, SHA-256 hash, `scope` column). Its
security model is the important part:
   - A token authenticates **as its owner but with `role` forced to `'user'`** (line 63) —
     every `PLATFORM_ROLES`/`ELEVATED_ROLES` check downstream is false. So a token can never
     pass `requirePlatformAdmin`; **billing is unreachable by any token today.**
   - Routers are partitioned in `config/api-surface.js`: `PUBLIC_ROUTERS` (token + JWT, gated
     by `tokenScopeGate` read<write<full), `JWT_ONLY_ROUTERS` (`/api/admin`, etc. — tokens
     `jwt.verify`-fail → 401), and **`AGENCY_ROUTERS`** — an **off-ladder capability scope**
     (`agencyGate`: token must be exactly `scope==='agency'`, tied to no role, reaches only
     `/api/agency`). This #73 `agency` pattern is a working precedent for exactly what we want.
   - Token creation (`routes/tokens.js`) is JWT-only, workspace-scoped; `SCOPES =
     ['read','write','full','agency']`; **any workspace member can mint** read/write/full
     tokens for their workspace.

**4. Smallest change that grants ONLY billing-read:** a new off-ladder token scope
`billing`, mirroring `agency` — additive, isolated from the shared role checks.

---

## The three options

### A. New ROLE (`billing_viewer`)
Add a role to the enum and let the billing route accept it. **Effort: MEDIUM–LARGE.**
- Touches: `middleware/auth.js` (role set + a guard), `routes/billing.js`, the frontend role
  dropdown (`PLATFORM_ROLE_OPTIONS`), the #14 role-normalization migration/comments, and an
  audit of the ~20 files that assume the closed role set. **Migration:** likely (role
  normalization). **Tests:** new guard + regression across role checks.
- **Blast radius: HIGH** — modifies the shared role model every endpoint depends on, right
  before release. And a role lives on a *human* `users` row (one role column), so it doesn't
  cleanly serve the real consumer (tooling / invoice-time pulls) and is coarse to revoke.
- Least privilege: mediocre (a human login, not a scoped credential).

### B. New PERMISSION / CAPABILITY (`billing:read`)
Gate billing on a permission granted independently of role. **Effort: LARGE.**
- **There is no permission seam to hang this on** — no permissions table, no role→permission
  map. Option B means *introducing* one (table + checker) or faking it with a bespoke
  `billing:read` flag on `users`. Either way it adds a new concept to the shared auth path.
  **Migration:** yes (new table/column). **Tests:** a whole new permission surface.
- **Blast radius: MEDIUM–HIGH** — new seam in shared auth; not additive/isolated.
- Least privilege: good in principle, but the effort/risk is disproportionate for one route.

### C. Dedicated scoped BILLING TOKEN  ✅ RECOMMENDED
A revocable, read-only `billing`-scoped API token that authorizes ONLY the billing route —
mirroring the existing off-ladder `agency` scope (#73). **Effort: SMALL–MEDIUM. No migration.**
- Changes, all **additive and isolated** (do NOT touch `PLATFORM_ROLES`/`requireAuth`/shared
  checks):
  1. `middleware/apiToken.js` — add `billingGate` (mirror `agencyGate`), but allow the JWT
     platform-admin too: `req.viaToken ? req.tokenScope==='billing' : isPlatformRole(req.user.role)`. ~6 lines, export it.
  2. `config/api-surface.js` — add `BILLING_ROUTERS = [{ path:'/api/billing', mod:'./routes/billing' }]`;
     `server.js` mounts it with `bearerAuth + billingGate` (mirroring the AGENCY mount) and the
     bespoke `app.use('/api/billing', requireAuth, …)` at server.js:582 is removed. This also
     **brings billing under the firewall-test partition** (closes the current gap).
  3. `routes/tokens.js` — add `'billing'` to `SCOPES`; because a billing token grants
     **global** billing-read, gate its creation on platform-admin:
     `if (scope==='billing' && !isPlatformRole(req.user.role)) return 403`. ~3 lines.
  4. `routes/billing.js` — drop `requirePlatformAdmin` from the handler (the mount-level
     `billingGate` now authorizes both a billing token and a platform-admin JWT).
  5. `db/schema.sql` — update the `api_tokens.scope` comment to include `billing` (doc only;
     column is free-text TEXT — no migration).
  - **Tests:** billing token → 200; a read/write/full/agency token → 403 (off-ladder,
    `tokenScopeGate` already rejects it everywhere else); platform-admin JWT → 200; non-admin
    JWT → 403; anon → 401; a non-platform-admin cannot MINT a billing token (403); firewall
    partition test extended.
- **Blast radius: LOW / isolated.** The `billing` scope is off the read/write/full ladder, so
  `tokenScopeGate` rejects it on every other router — `billingGate` is its only door. Nothing
  the rest of the app depends on is modified.
- **Least privilege: EXCELLENT.** Grants billing-read and nothing else; tied to no human role;
  **revocable** (`revoked_at`); minted only by platform-admin. Fits the real consumer —
  tooling / invoice-time pulls / the agreement's §4.2 verification access.
- Platform-admin still reads billing via the JWT branch of `billingGate` — allowed, not required.

**Two nuances to document when built:** (a) a billing token's `workspace_id` binding is
*vestigial* — billing is platform-global, so the read ignores it (unlike agency's per-target
binding); (b) if per-tenant billing ever lands, a billing token could then be workspace-scoped.

---

## Recommendation: **Option C**

It is the only option that is simultaneously least-privilege (billing-read only, revocable,
no human role), lowest effort (no migration; reuses the proven #73 `agency` pattern), and —
decisively for a pre-release change — **additive and isolated**: it never touches the shared
role/permission checks every other endpoint depends on. Options A and B both modify or extend
the shared auth path, which is exactly the destabilization we want to avoid before beta7 ships.

**Next step:** Dan picks A / B / C. If C, the build is a separate task (~4–5 files, no
migration, one new test file + a firewall-test line).
