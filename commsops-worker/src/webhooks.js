// Inbound provider webhooks (status receipts) + the unsubscribe endpoint.
const A = require('./auth.js');
const emailAdapter = require('./adapters/email.js');
const { applyOptOut } = require('./optout.js');

// ── svix signature verification (Resend uses svix) ──
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function verifySvix(secret, headers, rawBody) {
  const id = headers.get('svix-id'); const ts = headers.get('svix-timestamp'); const sig = headers.get('svix-signature');
  if (!id || !ts || !sig) return false;
  const signed = `${id}.${ts}.${rawBody}`;
  const keyBytes = b64ToBytes(secret.replace(/^whsec_/, ''));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = bytesToB64(new Uint8Array(mac));
  return sig.split(' ').some((p) => p.split(',')[1] === expected);
}

// POST /webhooks/resend — normalize status → update messages + emit engagement event (+ suppress on bounce/complaint)
async function handleResendWebhook(env, request) {
  const raw = await request.text();
  if (env.RESEND_WEBHOOK_SECRET) {
    const okSig = await verifySvix(env.RESEND_WEBHOOK_SECRET, request.headers, raw).catch(() => false);
    if (!okSig) return { ok: false, error: 'bad_signature', status: 401 };
  }
  let payload; try { payload = JSON.parse(raw); } catch { return { ok: false, error: 'bad_json', status: 400 }; }

  const updates = emailAdapter.parseStatusWebhook(payload);
  for (const u of updates) {
    if (!u.provider_message_id) continue;
    // find the message
    const m = await A.sbComms(
      `/rest/v1/messages?provider=eq.resend&provider_message_id=eq.${A.enc(u.provider_message_id)}&select=id,profile_id,channel,to_address&limit=1`, env);
    const msg = m.ok ? m.data?.[0] : null;
    // update status + timestamp
    if (msg && u.canonical_status) {
      const patch = { status: u.canonical_status, provider_status: payload.type };
      if (u.canonical_status === 'delivered') patch.delivered_at = u.at;
      if (u.canonical_status === 'opened') patch.read_at = u.at;
      await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(msg.id)}`, env,
        { method: 'PATCH', body: JSON.stringify(patch) });
    }
    // emit engagement event onto the profile's stream
    // link_clicked carries the clicked URL + channel; its idempotency key includes the
    // url + timestamp so distinct link-clicks are recorded (not collapsed one-per-message),
    // while exact webhook retries still dedupe. A clicked webhook with no link → skip.
    const isClick = u.engagement_event === 'link_clicked';
    if (msg?.profile_id && u.engagement_event && !(isClick && !u.clicked_url)) {
      const props = { provider_message_id: u.provider_message_id, message_id: msg.id };
      if (isClick) { props.url = u.clicked_url; props.channel = msg.channel; }
      const idem = isClick
        ? `resend:clicked:${u.provider_message_id}:${u.clicked_url}:${u.at}`
        : `resend:${payload.type}:${u.provider_message_id}`;
      await A.sbComms('/rest/v1/events', env, {
        method: 'POST',
        body: JSON.stringify({
          profile_id: msg.profile_id, name: u.engagement_event,
          occurred_at: u.at, source: 'resend_webhook',
          properties: props, idempotency_key: idem,
        }),
        headers: { Prefer: 'resolution=ignore-duplicates' },
      });
    }
    // hard bounce / complaint → suppress forever
    if (u.reason === 'hard_bounce' || u.reason === 'complaint') {
      const addr = msg?.to_address || u.to;
      if (addr) await A.sbComms('/rest/v1/suppressions?on_conflict=channel,value', env, {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify({ channel: msg?.channel || 'email', value: addr,
          profile_id: msg?.profile_id || null, reason: u.reason }),
      });
    }
  }
  return { ok: true, processed: updates.length };
}

// One-click List-Unsubscribe target. `all=1` withdraws marketing on EVERY channel
// (DPDP s.6(4) — withdrawal must be as easy as consent was to give).
async function handleUnsubscribe(env, token, all) {
  if (!token) return { html: page('Invalid unsubscribe link.'), status: 400 };
  const c = await A.sbComms(
    `/rest/v1/consent?unsubscribe_token=eq.${A.enc(token)}&select=profile_id,channel&order=captured_at.desc&limit=1`, env);
  const row = c.ok ? c.data?.[0] : null;
  if (!row) return { html: page('This unsubscribe link is no longer valid.'), status: 404 };

  const channels = all ? ['email', 'sms', 'whatsapp'] : [row.channel];
  for (const ch of channels) {
    await applyOptOut(env, {
      profile_id: row.profile_id,
      channel: ch,
      purpose: 'marketing',
      state: 'opted_out',
      source: all ? 'unsubscribe_link_all' : 'unsubscribe_link',
      // Forward the token — unsubscribeUrl() keys off the LATEST consent row's token, and
      // a token-less row makes it mint a fresh one on the next send (token churn).
      // Only stamp it on the row for the token's own channel; the others never had it.
      unsubscribe_token: ch === row.channel ? token : null,
      evidence: { unsubscribe_token: token, all_channels: !!all, at: new Date().toISOString() },
    });
  }

  if (all) {
    return { html: page("You've been unsubscribed from all Legend of Toys marketing. You'll still get essential order updates."), status: 200 };
  }
  return {
    html: page("You've been unsubscribed from marketing emails. You'll still get essential order updates.",
      `<p style="margin-top:18px"><a href="/unsubscribe?token=${encodeURIComponent(token)}&all=1" style="color:#F2CD1A;font-size:13px">Stop all marketing (email, SMS and WhatsApp)</a></p>`),
    status: 200,
  };
}

function page(msg, extra) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe · Legend of Toys</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#282828;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1c1c1c;border:1px solid #333;border-radius:14px;padding:40px;max-width:440px;text-align:center}
.bar{height:4px;width:60px;background:#F2CD1A;border-radius:2px;margin:0 auto 20px}
h1{font-size:18px;margin:0 0 10px}p{color:#bbb;font-size:14px;line-height:1.5;margin:0}</style></head>
<body><div class="card"><div class="bar"></div><h1>Legend of Toys</h1><p>${msg}</p>${extra || ''}</div></body></html>`;
}

module.exports = { handleResendWebhook, handleUnsubscribe };
