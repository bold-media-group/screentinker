#!/usr/bin/env node
'use strict';

// #146 BILLING — owner-only CLI to mint / revoke / list `billing:read` API tokens.
//
//   node scripts/mint-billing-token.js --name "Bold invoicing"   # mint (prints secret ONCE)
//   node scripts/mint-billing-token.js --list                    # list billing tokens
//   node scripts/mint-billing-token.js --revoke <id>             # revoke one
//
// OWNER-ONLY BY CONSTRUCTION: this is a server-side script with NO network endpoint. The
// access control IS filesystem/shell access to the host — i.e. the platform owner. It is
// deliberately NOT in the workspace API-Tokens UI (that surface is workspace-scoped, self-
// service; a billing token grants platform-wide billing-read and must be issued by the owner).
// On the container: `docker exec screentinker node ../scripts/mint-billing-token.js --name "…"`.
//
// The logic lives in server/lib/billing-token.js (unit-tested); this file is a thin wrapper.

const { db } = require('../server/db/database');
const { mintBillingToken, revokeBillingToken, listBillingTokens } = require('../server/lib/billing-token');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] || '') : undefined;
}
const has = (flag) => process.argv.includes(flag);

function fmtTime(t) { return t ? new Date(t * 1000).toISOString() : '—'; }

function main() {
  if (has('--help') || has('-h')) {
    console.log('Usage:\n  --name "<label>"   mint a billing:read token\n  --list             list billing tokens\n  --revoke <id>      revoke a billing token');
    return 0;
  }

  if (has('--list')) {
    const rows = listBillingTokens(db);
    if (!rows.length) { console.log('No billing:read tokens.'); return 0; }
    for (const r of rows) {
      console.log(`${r.id}  ${r.prefix}…  "${r.name}"  created=${fmtTime(r.created_at)}  last_used=${fmtTime(r.last_used_at)}  ${r.revoked_at ? 'REVOKED ' + fmtTime(r.revoked_at) : 'active'}`);
    }
    return 0;
  }

  const revokeId = arg('--revoke');
  if (revokeId !== undefined) {
    if (!revokeId) { console.error('ERROR: --revoke needs a token id (see --list)'); return 1; }
    const res = revokeBillingToken(db, revokeId);
    if (!res.ok) { console.error(`ERROR: ${res.reason}`); return 1; }
    console.log(res.alreadyRevoked ? `Token ${revokeId} was already revoked.` : `✔ Revoked billing token ${revokeId}. It is refused on the next request.`);
    return 0;
  }

  const name = arg('--name');
  if (name === undefined) { console.error('ERROR: nothing to do. Use --name "<label>" to mint, --list, or --revoke <id>.'); return 1; }

  let minted;
  try { minted = mintBillingToken(db, { name }); }
  catch (e) { console.error(`ERROR: ${e.message}`); return 1; }

  console.log('');
  console.log(`✔ Minted billing:read token "${minted.name}"`);
  console.log(`  id:      ${minted.id}        (use this to revoke)`);
  console.log(`  token:   ${minted.secret}`);
  console.log('           ^^^ STORE THIS NOW — it will NOT be shown again ^^^');
  console.log(`  scope:   ${minted.scope}   (read-only; authorizes ONLY GET /api/billing/usage)`);
  console.log(`  bound:   owner=${minted.owner_email || minted.owner_id}  workspace=${minted.workspace_id}  (vestigial — billing is platform-global)`);
  console.log('');
  console.log('  ⚠  Run only as the platform OWNER on the host. Anyone holding this token can read');
  console.log(`     billing figures until revoked:  node scripts/mint-billing-token.js --revoke ${minted.id}`);
  console.log('');
  return 0;
}

process.exit(main());
