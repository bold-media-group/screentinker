// One-time signup emails (Slice 1):
//   (a) a personal welcome email to the new user, and
//   (b) an admin notification to Dan so no signup goes unnoticed.
//
// Fired fire-and-forget from all three signup paths (local /register, /google,
// /microsoft) at the point a NEW user is created. Reuses the single Microsoft
// Graph transport in ./email (no second mail path).
//
// Gating & safety:
//   - Hosted-instance only: skipped when SELF_HOSTED=true so self-host operators
//     never emit mail from our domain (and never CC Dan on their signups).
//   - Idempotent: users.welcome_email_sent_at is stamped after the send block;
//     a non-null value short-circuits, so a user is only ever emailed once.
//   - sendEmail() never throws, so a Graph hiccup is logged (per-email
//     {sent, reason}) but never blocks or fails the signup request.
//
// No retry logic by design: there is no path that re-enters the new-user branch
// for an existing user, so a failed Graph send is surfaced in the logs and left
// alone rather than retried (that code would be dead).

const { db } = require('../db/database');
const { sendEmail } = require('./email');
const { getClientIp } = require('./activity');
const config = require('../config');

// Admin signup-notify recipient. Sourced from env (not hardcoded) so the
// hosted .com address never ships in open-source code: a self-hoster who
// configures Graph but forgets SELF_HOSTED=true would otherwise fire their
// users' signup PII into our inbox. Unset -> admin notify is skipped entirely
// (the user's welcome email is unaffected). Hosted prod sets this env var.
const ADMIN_NOTIFY_TO = process.env.ADMIN_NOTIFY_EMAIL || null;

const LINKS = {
  player:     'https://screentinker.com/player/',
  pi:         'https://screentinker.com/guides/raspberry-pi-digital-signage.html',
  androidTv:  'https://screentinker.com/guides/digital-signage-android-tv.html',
  selfHosted: 'https://screentinker.com/guides/self-hosted-digital-signage.html',
  discord:    'https://discord.gg/utTdsrqq4Z',
};

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Plain-text body. Pure ASCII on purpose: "->" not the arrow glyph, "-" not the
// bullet glyph, straight apostrophes, no em-dashes. Unicode in text/plain gets
// mangled by some clients and hurts deliverability on a new sending pattern.
function welcomeText(name) {
  return `Hi ${name},

Thanks for signing up for ScreenTinker. Glad you're here.

One thing worth knowing up front. ScreenTinker is run by one person, me.
There's no support queue or ticket robot. If you hit reply to this email,
it comes straight to me and I'll answer.

The fastest way to see it work is to put something on a screen. You can turn
any browser into a display in about a minute with the web player:

  -> ${LINKS.player}

Open that on whatever you want to use as a screen, pair it from your
dashboard, and you're live.

Using real signage hardware? These walk you through it:
  - Raspberry Pi: ${LINKS.pi}
  - Android TV:   ${LINKS.androidTv}
  - Self-hosted:  ${LINKS.selfHosted}

Want to ask a human or see what others are building? Discord's here:
  ${LINKS.discord}

Just hit reply if anything's unclear or not working. I read every email.

- Dan
ScreenTinker`;
}

function welcomeHtml(name) {
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hi ${htmlEscape(name)},</p>
<p>Thanks for signing up for ScreenTinker. Glad you're here.</p>
<p>One thing worth knowing up front. ScreenTinker is run by one person, me. There's no support queue or ticket robot. If you hit reply to this email, it comes straight to me and I'll answer.</p>
<p>The fastest way to see it work is to put something on a screen. You can turn any browser into a display in about a minute with the web player:</p>
<p><a href="${LINKS.player}" style="font-weight:600">Open the web player</a></p>
<p>Open that on whatever you want to use as a screen, pair it from your dashboard, and you're live.</p>
<p>Using real signage hardware? These walk you through it:</p>
<ul>
  <li><a href="${LINKS.pi}">Raspberry Pi setup</a></li>
  <li><a href="${LINKS.androidTv}">Android TV setup</a></li>
  <li><a href="${LINKS.selfHosted}">Self-hosted setup</a></li>
</ul>
<p>Want to ask a human or see what others are building? <a href="${LINKS.discord}">Discord's here</a>.</p>
<p>Just hit reply if anything's unclear or not working. I read every email.</p>
<p>- Dan<br>ScreenTinker</p>
</div>`;
}

function fmtUtc(unixSec) {
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function fmtCentral(unixSec) {
  return new Date(unixSec * 1000).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function adminText({ name, email, orgName, signupUnix, ip, country, userAgent }) {
  return `New ScreenTinker signup.

Name:       ${name}
Email:      ${email}
Org:        ${orgName}
Plan:       pro (14-day trial)
Signed up:  ${fmtUtc(signupUnix)}  (${fmtCentral(signupUnix)} America/Chicago)
IP:         ${ip || 'unknown'}
Country:    ${country || 'unknown'}
User agent: ${userAgent || 'unknown'}`;
}

// Public entry point. `user` only needs `.id`; everything else is re-read from
// the row so the caller's column selection doesn't matter. `req` supplies the
// client IP (CF-aware), Cloudflare's free CF-IPCountry header, and user agent.
function sendSignupEmails(user, req) {
  try {
    // Hosted instance only.
    if (config.selfHosted) return;

    const row = db.prepare(
      'SELECT email, name, created_at, welcome_email_sent_at FROM users WHERE id = ?'
    ).get(user.id);
    if (!row || row.welcome_email_sent_at) return; // unknown or already handled

    const email = row.email;
    const name = (row.name && row.name.trim()) ? row.name.trim() : email.split('@')[0];
    const signupUnix = row.created_at || Math.floor(Date.now() / 1000);

    // Workspace name is always "Default" at signup, so use the org name instead.
    const orgRow = db.prepare(
      'SELECT name FROM organizations WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(user.id);
    const orgName = orgRow ? orgRow.name : `${name}'s organization`;

    const ip = getClientIp(req);
    const country = (req && req.headers && req.headers['cf-ipcountry']) || 'unknown';
    const userAgent = (req && req.headers && req.headers['user-agent']) || 'unknown';

    (async () => {
      const w = await sendEmail({
        to: email,
        fromName: 'Dan at ScreenTinker',
        rawSubject: true,
        subject: 'Welcome to ScreenTinker',
        text: welcomeText(name),
        html: welcomeHtml(name),
      });
      console.log(`[SIGNUP-EMAIL] welcome -> ${email}: ${JSON.stringify(w)}`);

      if (ADMIN_NOTIFY_TO) {
        const a = await sendEmail({
          to: ADMIN_NOTIFY_TO,
          rawSubject: true,
          subject: `New signup: ${email}`,
          text: adminText({ name, email, orgName, signupUnix, ip, country, userAgent }),
        });
        console.log(`[SIGNUP-EMAIL] admin-notify (${email}) -> ${ADMIN_NOTIFY_TO}: ${JSON.stringify(a)}`);
      } else {
        console.log('[SIGNUP-EMAIL] admin notify skipped (ADMIN_NOTIFY_EMAIL unset)');
      }

      // Stamp after the send block regardless of per-email outcome (no retry):
      // marks this user handled so we never double-send.
      db.prepare("UPDATE users SET welcome_email_sent_at = strftime('%s','now') WHERE id = ?")
        .run(user.id);
    })().catch(e => console.error(`[SIGNUP-EMAIL] unexpected failure for ${email}: ${e.message}`));
  } catch (e) {
    // Never let signup-email bookkeeping affect the signup request itself.
    console.error(`[SIGNUP-EMAIL] setup failed: ${e.message}`);
  }
}

module.exports = { sendSignupEmails };
