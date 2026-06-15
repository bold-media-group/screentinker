'use strict';

// #73: batched digest of agency uploads. The agency endpoint enqueues a row per item added
// (ONLY when email is configured). This job flushes every 15 min: groups unsent rows per
// token+playlist+action, sends one email per group to the workspace owner/admins + the
// playlist owner (deduped), and stamps sent_at ONLY after a successful send. Two robustness
// rules: (1) never let the queue balloon when SMTP is off; (2) a failed send retries next
// cycle instead of silently dropping.

const { db: defaultDb } = require('../db/database');
const defaultEmail = require('./email');

const FLUSH_MS = 15 * 60 * 1000; // the digest window

// Workspace owner/admins (via the org) + the playlist owner. UNION dedupes by email.
function resolveRecipients(db, workspaceId, playlistId) {
  return db.prepare(`
    SELECT u.email FROM organization_members om
    JOIN workspaces w ON w.organization_id = om.organization_id
    JOIN users u ON u.id = om.user_id
    WHERE w.id = ? AND om.role IN ('org_owner', 'org_admin') AND u.email IS NOT NULL
    UNION
    SELECT u.email FROM playlists p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND u.email IS NOT NULL
  `).all(workspaceId, playlistId);
}

function composeDigest(db, g) {
  const agency = db.prepare('SELECT name FROM api_tokens WHERE id = ?').get(g.token_id)?.name || 'An agency';
  const playlist = db.prepare('SELECT name FROM playlists WHERE id = ?').get(g.playlist_id)?.name || 'a playlist';
  const n = g.n;
  if (g.action === 'draft') {
    return {
      subject: `${agency} added ${n} item${n === 1 ? '' : 's'} to "${playlist}" — awaiting your approval`,
      text: `${agency} added ${n} item${n === 1 ? '' : 's'} to the playlist "${playlist}".\n\nThey are saved as drafts and will NOT appear on screens until you publish the playlist.`,
    };
  }
  return {
    subject: `${agency} updated "${playlist}"`,
    text: `${agency} added ${n} item${n === 1 ? '' : 's'} to the playlist "${playlist}", now live (this token is set to auto-publish).`,
  };
}

// Core flush - testable: pass a db and an email impl ({ isConfigured, sendEmail }).
async function flushAgencyDigests(db = defaultDb, email = defaultEmail) {
  if (!email.isConfigured()) {
    // SMTP off -> drain-and-discard so the queue can't grow unbounded on self-hosters
    // who never set up email. (The endpoint also skips enqueue when off; this is the backstop.)
    db.prepare('DELETE FROM agency_notifications WHERE sent_at IS NULL').run();
    return;
  }
  const groups = db.prepare(`
    SELECT workspace_id, token_id, playlist_id, action, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
    FROM agency_notifications WHERE sent_at IS NULL
    GROUP BY token_id, playlist_id, action
  `).all();

  for (const g of groups) {
    try {
      const recipients = resolveRecipients(db, g.workspace_id, g.playlist_id);
      if (recipients.length) {
        const { subject, text } = composeDigest(db, g);
        for (const r of recipients) {
          await email.sendEmail({ to: r.email, subject, text }); // throw -> caught below -> NOT stamped -> retried
        }
      }
      // Stamp sent_at ONLY after every send for this group succeeded (or there were no
      // recipients). A throw above skips this -> the rows stay unsent for the next cycle.
      const now = Math.floor(Date.now() / 1000);
      const stamp = db.prepare('UPDATE agency_notifications SET sent_at = ? WHERE id = ?');
      db.transaction(() => { for (const id of g.ids.split(',')) stamp.run(now, id); })();
    } catch (e) {
      console.warn('agency digest: send failed, will retry next cycle:', e.message);
    }
  }
}

function startAgencyDigest() {
  setInterval(() => { flushAgencyDigests().catch(() => {}); }, FLUSH_MS);
  console.log('Agency digest service started');
}

module.exports = { startAgencyDigest, flushAgencyDigests, resolveRecipients, composeDigest };
