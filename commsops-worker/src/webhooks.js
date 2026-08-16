// Inbound provider webhooks (status receipts) + the unsubscribe endpoint.
const A = require('./auth.js');
const emailAdapter = require('./adapters/email.js');
const { applyOptOut } = require('./optout.js');

// Canonical message status is monotonic — an out-of-order webhook must never regress it
// (e.g. a late 'delivered' arriving after 'read'/'opened' — review M6). Deliberately
// duplicated in wa-webhooks.js: the two files share no util module and this guard is
// tiny enough not to warrant one.
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 9, failed: 9, suppressed: 9, skipped: 9 };
const isUpgrade = (from, to) => (STATUS_RANK[to] ?? 0) >= (STATUS_RANK[from] ?? 0) || (STATUS_RANK[to] ?? 0) >= 9;

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
      `/rest/v1/messages?provider=eq.resend&provider_message_id=eq.${A.enc(u.provider_message_id)}&select=id,profile_id,channel,to_address,status&limit=1`, env);
    const msg = m.ok ? m.data?.[0] : null;
    // update status + timestamp
    if (msg && u.canonical_status) {
      const patch = { status: u.canonical_status, provider_status: payload.type };
      if (!isUpgrade(msg.status, u.canonical_status)) delete patch.status;   // late 'delivered' after 'read' keeps opened (review M6)
      if (u.canonical_status === 'delivered') patch.delivered_at = u.at;
      if (u.canonical_status === 'opened') patch.read_at = u.at;
      // Persist WHY it bounced. `reason` was NULL on every bounced row, so the 7 addresses
      // suppressed on 10–11 Aug could not be classified from the DB at all — it took a payload
      // pasted out of the Resend dashboard to discover one of them was merely a full mailbox.
      if (u.reason) {
        patch.reason = u.bounce_type
          ? `${u.reason}:${u.bounce_type}${u.bounce_subtype ? '/' + u.bounce_subtype : ''}`
          : u.reason;
      }
      A.checkWrite('resend_status_patch_failed',
        await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(msg.id)}`, env,
          { method: 'PATCH', body: JSON.stringify(patch) }),
        { message_id: msg.id, to: u.canonical_status });
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
      A.checkWrite('resend_engagement_event_failed', await A.sbComms('/rest/v1/events', env, {
        method: 'POST',
        body: JSON.stringify({
          profile_id: msg.profile_id, name: u.engagement_event,
          occurred_at: u.at, source: 'resend_webhook',
          properties: props, idempotency_key: idem,
        }),
        headers: { Prefer: 'resolution=ignore-duplicates' },
      }), { message_id: msg.id, event: u.engagement_event });
    }
    // PERMANENT bounce / complaint → suppress forever.
    // ⚠️ `soft_bounce` (SES `Transient` — full mailbox, throttled, deferred) and
    // `undetermined_bounce` MUST NOT land here. Suppression is the one gate transactional and
    // utility cannot bypass (gate.js:3), so suppressing on a recoverable bounce silently ends
    // that customer's order confirmations and shipping updates — for a full inbox. The message
    // is still marked failed and still carries its reason; only the permanent block is withheld.
    if (u.reason === 'hard_bounce' || u.reason === 'complaint') {
      const addr = msg?.to_address || u.to;
      if (addr) {
        const sup = await A.sbComms('/rest/v1/suppressions?on_conflict=channel,value', env, {
          method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify({ channel: msg?.channel || 'email', value: addr,
            profile_id: msg?.profile_id || null, reason: u.reason }),
        });
        // ⚠️ MUST be checked (PATTERN-218 sweep, S261). `comms.suppressions` is step ① of the send
        // gate and blocks EVERY purpose including transactional, so a dropped write here means we
        // keep mailing an address that hard-bounced or reported us as spam — a deliverability and
        // consent consequence, not an analytics one. sbComms returns {ok:false} on a non-2xx and
        // never throws, so without this the failure was completely silent.
        if (!sup.ok) console.log('suppression_write_failed',
          JSON.stringify({ channel: msg?.channel || 'email', reason: u.reason, detail: sup.data }));
      }
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

// TrustSignal SMS DLR → message status + DND suppression.
// Only ever moves state FORWARD: a late 'sent' must not overwrite a 'delivered'.
const TERMINAL = new Set(['delivered', 'failed', 'bounced']);

async function handleTrustsignalSms(env, body) {
  const events = require('./adapters/sms.js').parseStatusWebhook(body);
  for (const ev of events) {
    if (!ev.provider_message_id) continue;
    const cur = await A.sbComms(
      `/rest/v1/messages?provider_message_id=eq.${A.enc(ev.provider_message_id)}` +
      `&select=id,status,to_address,profile_id,channel&limit=1`, env);
    const row = cur.ok && cur.data?.[0];
    if (!row) continue;                       // unknown id — log-only, never create a row
    if (TERMINAL.has(row.status)) continue;   // forward-only
    if (ev.canonical_status) {
      A.checkWrite('sms_dlr_patch_failed',
        await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(row.id)}`, env, {
          method: 'PATCH',
          body: JSON.stringify({
            status: ev.canonical_status,
            ...(ev.reason ? { reason: ev.reason } : {}),
            ...(ev.canonical_status === 'delivered' && ev.at ? { delivered_at: ev.at } : {}),
          }),
        }),
        { message_id: row.id, to: ev.canonical_status });
    }
    if (ev.suppress) {
      // ⚠️ THE ADDRESS COMES FROM OUR OWN messages ROW, NOT FROM THE CALLBACK.
      // gate.js:93 matches suppressions with `value=eq.<the address being sent to>`, and that
      // address is canonical E.164 (+919876543210). But we SEND bare 10 digits to /v1/sms, so
      // whatever the vendor echoes back is bare-10 or 919876543210 — and normalising it can
      // strip punctuation but cannot invent a missing +91. Using the payload would write a row
      // that looks correct in the suppressions list and is NEVER matched, so the channel keeps
      // sending to a DND number forever. `to_address` is what the gate will compare against.
      // It also removes a dependency on an undocumented field: the vendor collection publishes
      // no SMS delivery-callback payload at all (25+ exist for WhatsApp, zero for SMS).
      const addr = row.to_address || null;
      if (addr) {
        // Normalise exactly as index.js's manual addSuppression does, and use the same
        // on_conflict target — `ignore-duplicates` with no target 409s on the second DND
        // for the same number.
        const norm = String(addr).replace(/[^\d+]/g, '');
        const sup = await A.sbComms('/rest/v1/suppressions?on_conflict=channel,value', env, {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({
            channel: ev.suppress_channel, value: norm,
            profile_id: row.profile_id || null, reason: ev.suppress,
          }),
        });
        // ⚠️ Same rule as the Resend bounce path above (PATTERN-218 sweep, S261): a dropped DND
        // suppression means we keep texting a DND-registered number. India's DND is category-based,
        // so this write is the ONLY record that this number withdrew — SMS has no inbound channel
        // through which the customer could tell us again.
        if (!sup.ok) console.log('suppression_write_failed',
          JSON.stringify({ channel: ev.suppress_channel, reason: ev.suppress, detail: sup.data }));
      }
    }
  }
}

// TrustSignal RCS events → message status, the fallback channel flip, and link_clicked.
// Same posture as the SMS handler: unknown transaction ids are ignored (never create a row),
// unknown statuses are logged not thrown (the vendor's catalogue is partial by admission),
// and status only ever moves FORWARD.
const RCS_RANK = { queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 9, failed: 9, suppressed: 9, skipped: 9 };
const rcsUpgrade = (from, to) => (RCS_RANK[to] ?? 0) >= (RCS_RANK[from] ?? 0) || (RCS_RANK[to] ?? 0) >= 9;

async function handleTrustsignalRcs(env, body) {
  const events = require('./adapters/rcs.js').parseStatusWebhook(body);
  for (const ev of events) {
    if (!ev.provider_message_id) continue;
    const cur = await A.sbComms(
      `/rest/v1/messages?provider_message_id=eq.${A.enc(ev.provider_message_id)}` +
      `&select=id,status,to_address,profile_id,channel,fallback_from&limit=1`, env);
    const row = cur.ok && cur.data?.[0];
    if (!row) continue;

    // F4 — the channel flip, rcs → sms, ONE-WAY and IDEMPOTENT. Both the `Fallback` event and
    // a Delivery_status of `nonrcs` mean the same thing and can both arrive in either order,
    // so idempotency lives in the PATCH predicate: `fallback_from IS NULL` makes the second
    // flip a no-op (0 rows matched), and nothing anywhere sets channel back to 'rcs'. Cost is
    // overwritten ONLY here, with the SMS leg's credit — the RCS leg's charge describes a leg
    // that did not deliver.
    if (ev.fallback_flip) {
      const patch = { channel: 'sms', fallback_from: 'rcs' };
      if (ev.cost != null) patch.pricing = { provider_credit: ev.cost, provider: 'trustsignal', leg: 'sms_fallback' };
      A.checkWrite('rcs_fallback_flip_failed',
        await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(row.id)}&fallback_from=is.null`, env,
          { method: 'PATCH', body: JSON.stringify(patch) }),
        { message_id: row.id });
      continue;
    }

    // F4 last rule — an RCS-leg event (delivered/read carrying route 'rcs') that arrives AFTER
    // the flip describes a leg that did not deliver: discard, never apply. Events off the SMS
    // leg (route 'sms'/'nonrcs', or no route at all) still apply — that is how F8's terminal
    // state lands when the fallback also fails.
    if (row.fallback_from && ev.route === 'rcs') continue;

    // F12 — clicks emit the EXISTING link_clicked event, channel-agnostic by design (S189).
    // Idempotency includes url + timestamp so distinct clicks record while webhook retries
    // dedupe — same key shape as the Resend click path above.
    if (ev.click) {
      if (row.profile_id && ev.clicked_url) {
        A.checkWrite('rcs_click_event_failed', await A.sbComms('/rest/v1/events', env, {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify({
            profile_id: row.profile_id, name: 'link_clicked',
            occurred_at: ev.at, source: 'trustsignal_webhook',
            properties: { url: ev.clicked_url, channel: row.channel,
                          provider_message_id: ev.provider_message_id, message_id: row.id },
            idempotency_key: `trustsignal:rcs:clicked:${ev.provider_message_id}:${ev.clicked_url}:${ev.at}`,
          }),
        }), { message_id: row.id });
      }
      // clicked is also a status upgrade on the row itself
      if (rcsUpgrade(row.status, 'clicked')) {
        await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(row.id)}`, env,
          { method: 'PATCH', body: JSON.stringify({ status: 'clicked' }) });
      }
      continue;
    }

    // User_response (suggested-reply postback) → journey branching is build step 10. Log the
    // real payload shape until then — the field names in the parser are inferred, and these
    // lines are how they get verified before any branching logic depends on them.
    if (ev.user_response) {
      console.log('rcs_user_response', JSON.stringify({ message_id: row.id, postback: ev.postback, at: ev.at }));
      continue;
    }

    if (!ev.canonical_status) {
      console.log('rcs_unknown_status', JSON.stringify({ raw: ev.raw_status, message_id: row.id }));
      continue;
    }
    if (!rcsUpgrade(row.status, ev.canonical_status)) continue;   // forward-only
    A.checkWrite('rcs_dlr_patch_failed',
      await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(row.id)}`, env, {
        method: 'PATCH',
        body: JSON.stringify({
          status: ev.canonical_status,
          provider_status: ev.raw_status || ev.canonical_status,
          ...(ev.reason ? { reason: ev.reason } : {}),
          ...(ev.canonical_status === 'delivered' && ev.at ? { delivered_at: ev.at } : {}),
          ...(ev.canonical_status === 'opened' && ev.at ? { read_at: ev.at } : {}),
        }),
      }),
      { message_id: row.id, to: ev.canonical_status });
  }
}

module.exports = { handleResendWebhook, handleUnsubscribe, handleTrustsignalSms, handleTrustsignalRcs };
