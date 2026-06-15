'use strict';

// #73 email digest robustness. Proves the two rules the design hinges on: (1) the queue
// never balloons when SMTP is off (drain-and-discard); (2) sent_at is stamped ONLY after a
// successful send, so a failure retries next cycle instead of silently dropping. Plus
// recipient resolution (org owner/admins + playlist owner, deduped) and digest grouping.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { flushAgencyDigests, resolveRecipients } = require('../services/agency-digest');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agency_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, token_id TEXT, playlist_id TEXT, action TEXT, content_id TEXT, created_at INTEGER, sent_at INTEGER);
    CREATE TABLE organization_members (organization_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE workspaces (id TEXT, organization_id TEXT);
    CREATE TABLE users (id TEXT, email TEXT);
    CREATE TABLE playlists (id TEXT, user_id TEXT, name TEXT);
    CREATE TABLE api_tokens (id TEXT, name TEXT);
    INSERT INTO workspaces VALUES ('ws1','org1');
    INSERT INTO users VALUES ('uOwner','owner@x'), ('uAdmin','admin@x'), ('uViewer','viewer@x'), ('uPlOwner','plowner@x');
    INSERT INTO organization_members VALUES ('org1','uOwner','org_owner'), ('org1','uAdmin','org_admin'), ('org1','uViewer','member');
    INSERT INTO playlists VALUES ('pl1','uPlOwner','Lobby');
    INSERT INTO api_tokens VALUES ('tok1','Acme Agency');
  `);
  return db;
}
function enqueue(db, n, action = 'draft') {
  const ins = db.prepare("INSERT INTO agency_notifications (workspace_id, token_id, playlist_id, action) VALUES ('ws1','tok1','pl1',?)");
  for (let i = 0; i < n; i++) ins.run(action);
}
const cfg = (sendEmail) => ({ isConfigured: () => true, sendEmail });
const sink = () => { const sent = []; return { sent, sendEmail: async (m) => { sent.push(m); } }; };

test('#73 digest recipients: org owner + admins + playlist owner, deduped (NOT the viewer)', () => {
  const emails = resolveRecipients(freshDb(), 'ws1', 'pl1').map(r => r.email).sort();
  assert.deepEqual(emails, ['admin@x', 'owner@x', 'plowner@x']);
});

test('#73 digest: 30 uploads -> ONE email per recipient (not 30), all rows stamped sent', async () => {
  const db = freshDb();
  enqueue(db, 30, 'draft');
  const { sent, sendEmail } = sink();
  await flushAgencyDigests(db, cfg(sendEmail));
  assert.equal(sent.length, 3, '1 group x 3 recipients = 3 emails, not 30 per recipient');
  assert.match(sent[0].subject, /Acme Agency added 30 items to "Lobby"/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM agency_notifications WHERE sent_at IS NULL').get().c, 0);
});

test('#73 digest: a failed send leaves rows UNSENT for retry (never silently dropped)', async () => {
  const db = freshDb();
  enqueue(db, 5, 'draft');
  await flushAgencyDigests(db, cfg(async () => { throw new Error('smtp down'); }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM agency_notifications WHERE sent_at IS NULL').get().c, 5, 'still unsent -> retried next cycle');
});

test('#73 digest: SMTP off -> queue drained-and-discarded (never balloons)', async () => {
  const db = freshDb();
  enqueue(db, 10, 'draft');
  await flushAgencyDigests(db, { isConfigured: () => false, sendEmail: async () => { throw new Error('must not send'); } });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM agency_notifications').get().c, 0, 'drained when email is off');
});

test('#73 digest: draft vs published produce different subjects, grouped per action', async () => {
  const db = freshDb();
  enqueue(db, 2, 'draft');
  enqueue(db, 3, 'published');
  const { sent, sendEmail } = sink();
  await flushAgencyDigests(db, cfg(sendEmail));
  const subjects = sent.map(s => s.subject);
  assert.ok(subjects.some(s => /awaiting your approval/.test(s)), 'draft digest mentions approval');
  assert.ok(subjects.some(s => /updated "Lobby"/.test(s)), 'published digest says updated');
});
