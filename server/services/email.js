// Email sender backed by Microsoft Graph (Mail.Send application permission,
// client-credentials flow). Drop-in replacement for the previous
// EMAIL_WEBHOOK_URL POST-to-Mailgun-style sender.
//
// Configured via env vars:
//   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET (Azure AD app)
//   GRAPH_SENDER_EMAIL                                   (mailbox that sends)
//   GRAPH_SENDER_NAME                                    (display name)
//
// When unconfigured, sendEmail() logs an [EMAIL] line to stdout and returns
// { sent: false, reason: 'not_configured' } so local dev / test environments
// without M365 access keep working.
//
// MSAL is required lazily so the module loads cleanly when no env vars are
// present (avoids a hard dep on @azure/msal-node for stripped-down deploys).

const https = require('https');
const config = require('../config');

let _msalClient = null;
let _cachedToken = null;   // { token: string, expiresAtMs: number }

function isConfigured() {
  return !!(config.graphTenantId
         && config.graphClientId
         && config.graphClientSecret
         && config.graphSenderEmail);
}

function getMsalClient() {
  if (!isConfigured()) return null;
  if (_msalClient) return _msalClient;
  const msal = require('@azure/msal-node');
  _msalClient = new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.graphClientId,
      authority: `https://login.microsoftonline.com/${config.graphTenantId}`,
      clientSecret: config.graphClientSecret,
    },
  });
  return _msalClient;
}

// Acquire a Graph access token via client credentials. Cached in memory until
// 60s before reported expiry; on cache miss or near-expiry, refresh.
async function getAccessToken() {
  if (_cachedToken && _cachedToken.expiresAtMs > Date.now() + 60_000) {
    return _cachedToken.token;
  }
  const client = getMsalClient();
  if (!client) throw new Error('Graph email not configured');
  const result = await client.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('No accessToken returned from MSAL');
  const expiresAtMs = result.expiresOn ? result.expiresOn.getTime() : (Date.now() + 3_300_000); // 55min fallback
  _cachedToken = { token: result.accessToken, expiresAtMs };
  return _cachedToken.token;
}

// POST /users/{sender}/sendMail. Plain HTTPS, no Graph SDK. Resolves on 2xx,
// rejects with status + body on anything else so the caller can log.
function postSendMail(token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'graph.microsoft.com',
      port: 443,
      path: `/v1.0/users/${encodeURIComponent(config.graphSenderEmail)}/sendMail`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Graph sendMail ${res.statusCode}: ${chunks.slice(0, 500)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// rawSubject: when true, the subject is sent verbatim (no "[ScreenTinker] "
// prefix) — used by the signup emails which carry their own clean subjects.
// fromName: overrides the default GRAPH_SENDER_NAME display name (the From
// address is always graphSenderEmail, so replies still land in that mailbox).
function buildSendMailPayload(to, subject, text, html, fromName, rawSubject) {
  return {
    message: {
      subject: rawSubject ? subject : `[ScreenTinker] ${subject}`,
      body: {
        contentType: 'HTML',
        content: html || `<pre style="font-family:sans-serif">${escapeHtml(text || '')}</pre>`,
      },
      toRecipients: [{ emailAddress: { address: to } }],
      from: {
        emailAddress: {
          address: config.graphSenderEmail,
          name: fromName || config.graphSenderName || 'ScreenTinker',
        },
      },
    },
    saveToSentItems: false,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Public surface. Caller passes { to, subject, text, html } (html optional;
// derived from text if absent). Returns a result object - never throws to the
// caller. Graph errors are logged and the function returns sent:false so
// app-level flow (e.g. the device-offline alert) keeps running even when
// email delivery is broken.
async function sendEmail({ to, subject, text, html, fromName, rawSubject }) {
  if (!isConfigured()) {
    console.log(`[EMAIL] not configured - would send to ${to}: ${subject}`);
    if (text) console.log(`  ${text.split('\n')[0]}`);
    return { sent: false, reason: 'not_configured' };
  }
  // Dev allow-list. Bypass Graph entirely for any recipient not in the list.
  // Skipped when graphDevRestrictTo is empty (i.e. prod).
  if (config.graphDevRestrictTo) {
    const allowed = config.graphDevRestrictTo
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(String(to).toLowerCase())) {
      console.log(`[EMAIL] dev restrict - would send to ${to}: ${subject} (suppressed)`);
      return { sent: false, reason: 'dev_restricted' };
    }
  }
  try {
    const token = await getAccessToken();
    await postSendMail(token, buildSendMailPayload(to, subject, text, html, fromName, rawSubject));
    console.log(`[EMAIL] sent to ${to}: ${subject}`);
    return { sent: true };
  } catch (e) {
    console.error(`[EMAIL] Graph send failed for ${to}: ${e.message}`);
    return { sent: false, reason: 'graph_error', error: e.message };
  }
}

module.exports = { sendEmail, isConfigured };
