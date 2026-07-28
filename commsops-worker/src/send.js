// The send() spine — the single outbound gateway. Render → gate → adapter → log.
// Idempotent via dedup_key. On gate-fail writes a skipped/suppressed messages row
// (never a silent drop). Exposed to internal callers; Pitstop re-points here at WA cutover.
const A = require('./auth.js');
const { renderEmail, renderWhatsapp } = require('./render.js');
const { tagLinks } = require('./tracking.js');
const { runGate } = require('./gate.js');
const emailAdapter = require('./adapters/email.js');
const whatsappAdapter = require('./adapters/whatsapp.js');

const ADAPTERS = { email: emailAdapter, whatsapp: whatsappAdapter };

// Is the WA customer-service window open for this recipient ON THIS SENDING NUMBER?
// (review H5 part 3) — Meta's 24h window is per (business number ↔ customer): a window opened
// by messaging SUPPORT must NOT open free-text sends from MARKETING/TXN. No phone_number_id
// context (e.g. template branch, or a sender with no metadata) → fail closed, no DB call.
async function waWindowOpen(env, to, phoneNumberId) {
  const id = whatsappAdapter.toWaId(to);
  if (!id || !phoneNumberId) return false;
  const r = await A.sbComms(
    `/rest/v1/wa_windows?identifier_value=eq.${A.enc(id)}` +
    `&phone_number_id=eq.${A.enc(phoneNumberId)}&select=last_inbound_at&limit=1`, env);
  const row = r.ok ? r.data?.[0] : null;
  if (!row?.last_inbound_at) return false;
  return (Date.now() - new Date(row.last_inbound_at).getTime()) < 24 * 3600 * 1000;
}
const nowIso = () => new Date().toISOString();
const rand = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.round(Math.random() * 1e9)}`);

// Pure sender selection over the channel's active senders (passed oldest-first).
// Priority: WABA scope → explicit senderId pin (within that scope) → exact purpose match →
// 'all'/wildcard sender → single-sender fallback → null. Returning null (no_active_sender) is
// deliberate when there are MULTIPLE active senders and none matches: refuse rather than
// silently pick the oldest (the pre-fix bug that would route txn/support sends out the wrong
// number). 'all' is the wildcard purpose the live email sender uses; null/'' treated the same.
function pickSender(rows, { purpose, senderId, wabaId } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const channelCount = rows.length;              // pre-filter count — fallback is judged on THIS

  // WhatsApp templates are WABA-SCOPED: a template approved on WABA A simply does not exist
  // on WABA B, so sending it from a number on B is rejected by Meta as an unknown template.
  // This outranks EVERYTHING including an explicit senderId pin (review H5 part 1) — a stale
  // pin naming a sender on the wrong WABA would otherwise POST a template Meta doesn't have
  // there. Compare as strings (review H5 part 4): the waba_id lives in two independently
  // authored jsonb blobs (sender_identities.metadata, templates.content) and a number-vs-string
  // mismatch in either must not zero out the sender set via strict ===.
  if (wabaId) {
    const key = String(wabaId);
    const onWaba = rows.filter((s) => String(s.metadata?.waba_id ?? '') === key);
    if (!onWaba.length) return null;
    rows = onWaba;
  }

  if (senderId) return rows.find((s) => s.id === senderId) || null;   // pin, WITHIN the WABA scope

  const isWild = (p) => p == null || p === '' || p === 'all';
  if (purpose) {
    const exact = rows.find((s) => s.purpose === purpose);
    if (exact) return exact;                                          // oldest exact-purpose sender
  }
  const wild = rows.find((s) => isWild(s.purpose));
  if (wild) return wild;                                              // oldest wildcard sender

  // Genuinely single sender on the whole channel — unchanged (review H5 part 2 kept this
  // judged on the PRE-filter count, not the WABA-narrowed one).
  if (channelCount === 1) return rows[0];

  // WABA-narrowed to EXACTLY ONE active sender → route it, with one carve-out below.
  //
  // WHY (2026-07-28): the old rule refused here, and that refusal fired on essentially every
  // WABA-pinned template ever tested from the UI — `no_sender_on_waba` on a sender that was
  // active, correctly pinned, and the ONLY number Meta would accept. The purpose vocabularies
  // simply don't line up: templates + journey send-steps carry Meta's category (`utility`),
  // while sender rows carry a routing label (`transactional`), so the exact-match and wildcard
  // branches both miss and the pre-filter count is >1 whenever more than one number exists.
  //
  // A WABA-scoped set of one is unambiguous BY CONSTRUCTION: WhatsApp templates are WABA-scoped,
  // so that sender is the only number that can possibly send this template. There is no second
  // candidate to mis-route to — refusing doesn't prevent a wrong send, it prevents ALL sends.
  //
  // THE CARVE-OUT — the MARKETING BOUNDARY, refused in BOTH directions (H5 part 2 protected
  // both and still does). Marketing must not leave a number designated for order updates
  // (someone who opted into transactional must not be marketed to from it), and transactional
  // must not leave the marketing number (it reads as marketing to the recipient and muddies
  // that number's quality rating). So: if exactly ONE side is 'marketing', refuse.
  //
  // Everything else — `utility` vs `transactional` — is a VOCABULARY artifact, not a real
  // distinction: both are non-marketing, Meta bills both as utility, and our own templates and
  // sender rows just happen to label them differently. That mismatch is what was breaking every
  // send, and it is now allowed through.
  if (wabaId && rows.length === 1) {
    const only = rows[0];
    const sendIsMkt = purpose === 'marketing';
    const senderIsMkt = only.purpose === 'marketing';
    if (!isWild(only.purpose) && sendIsMkt !== senderIsMkt) return null;   // crosses the marketing boundary
    return only;
  }
  return null;
}

// Route to the right sender for (channel, purpose), honoring an explicit opts.senderId.
// Fetches ALL active senders for the channel (tiny set) ordered oldest-first, then picks.
async function getActiveSender(env, channel, purpose, senderId, wabaId) {
  const r = await A.sbComms(
    `/rest/v1/sender_identities?channel=eq.${A.enc(channel)}&status=eq.active&select=*&order=created_at.asc`, env);
  const rows = (r.ok && r.data) || [];
  return pickSender(rows, { purpose, senderId, wabaId });
}

async function getTemplate(env, templateId) {
  const r = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(templateId)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}

async function getProfile(env, profileId) {
  if (!profileId) return null;
  const r = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}

// Mint/reuse an unsubscribe token on the latest marketing-consent row for the profile.
async function unsubscribeUrl(env, profileId, channel) {
  if (!profileId) return null;
  const r = await A.sbComms(
    `/rest/v1/consent?profile_id=eq.${A.enc(profileId)}&channel=eq.${A.enc(channel)}` +
    `&purpose=eq.marketing&select=id,unsubscribe_token&order=captured_at.desc&limit=1`, env);
  let row = r.ok ? r.data?.[0] : null;
  let token = row?.unsubscribe_token;
  // review H6: the PATCH result used to be unchecked, so a failed persist still embedded the
  // (unsaved) token in the email — a dead one-click unsubscribe link. Now: PATCH is conditional
  // on the token still being null (`unsubscribe_token=is.null`) so two concurrent sends minting
  // at once can't clobber each other; a PATCH failure fails closed (no dead links in live mail);
  // and losing the mint race (0 rows updated) adopts the winner's token so THIS email's link
  // still resolves, rather than silently going out linkless.
  if (row && !token) {
    token = rand();
    const w = await A.sbComms(
      `/rest/v1/consent?id=eq.${A.enc(row.id)}&unsubscribe_token=is.null`, env,
      { method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ unsubscribe_token: token }) });
    if (!w.ok) return null;                                   // fail closed: no dead links in live mail
    if (!Array.isArray(w.data) || w.data.length === 0) {
      // lost a mint race — adopt the winner's token so THIS email's link resolves
      const re = await A.sbComms(`/rest/v1/consent?id=eq.${A.enc(row.id)}&select=unsubscribe_token&limit=1`, env);
      token = (re.ok && re.data?.[0]?.unsubscribe_token) || null;
      if (!token) return null;
    }
  }
  // No row at all (profile has never captured marketing consent on this channel) — unchanged
  // posture: return null and let the caller degrade gracefully (send.js:189-190 only sets
  // sys.unsubscribe_url when truthy; it never crashes on null). This function's job is to make
  // the MINTING step race-safe/fail-closed, not to change what happens when there's no row.
  if (!token) return null;
  const base = (env.SUPABASE_URL && 'https://commsops.afshaan.workers.dev') || 'https://commsops.afshaan.workers.dev';
  return `${base}/unsubscribe?token=${token}`;
}

async function logMessage(env, row) {
  const r = await A.sbComms('/rest/v1/messages', env, {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
  });
  return (r.ok && r.data?.[0]) || null;
}

// send(env, opts) — opts: {channel, purpose, profileId?, to, templateId, constants?, recipient?, eventContext?, source, dedupKey?}
async function send(env, opts) {
  const channel = opts.channel || 'email';
  const purpose = opts.purpose || 'marketing';
  const adapter = ADAPTERS[channel];
  if (!adapter) return { status: 'failed', reason: 'no_adapter' };

  // dedup reserve — dedup on SUCCESS, not on attempt. A prior sent-like row (or a fresh
  // in-flight queued row) dedups; a prior skipped/failed/suppressed/stale-queued row is
  // ADOPTED so the retry can run. Review 2026-07-21 finding C1: burning the key on any
  // outcome turned every transient failure into a silent permanent loss.
  const SENT_LIKE = new Set(['sent', 'delivered', 'opened', 'clicked', 'bounced']);
  const IN_FLIGHT_MS = 10 * 60 * 1000;
  if (opts.dedupKey) {
    const reserve = await A.sbComms('/rest/v1/messages?on_conflict=dedup_key', env, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        profile_id: opts.profileId || null, channel, purpose, status: 'queued',
        source: opts.source || null, dedup_key: opts.dedupKey, to_address: opts.to || null,
      }),
    });
    if (reserve.ok && Array.isArray(reserve.data) && reserve.data.length === 0) {
      const ex = await A.sbComms(
        `/rest/v1/messages?dedup_key=eq.${A.enc(opts.dedupKey)}&select=id,status,queued_at&limit=1`, env);
      const row = ex.ok ? ex.data?.[0] : null;
      const inFlight = row && row.status === 'queued'
        && (Date.now() - new Date(row.queued_at).getTime()) < IN_FLIGHT_MS;
      // Unknown state (lookup failed / row vanished) → dedup: fail-safe against double-send.
      if (!row || SENT_LIKE.has(row.status) || inFlight) return { status: 'deduped', deduped: true };
      opts._reservedId = row.id;   // adopt the failed/skipped/stale row — this attempt owns it now
    } else {
      opts._reservedId = reserve.data?.[0]?.id || null;
    }
  }

  // Template BEFORE sender: on WhatsApp the template's WABA constrains which senders are even
  // valid (pickSender), so we cannot choose a number until we know which WABA the template is on.
  const template = opts.template || await getTemplate(env, opts.templateId);
  if (!template) return await finalize(env, opts, { status: 'failed', reason: 'template_not_found' }, null, channel, purpose);

  const wabaId = channel === 'whatsapp' ? ((template.content && template.content.waba_id) || null) : null;
  const sender = await getActiveSender(env, channel, purpose, opts.senderId, wabaId);
  if (!sender) return await finalize(env, opts,
    // Name the WABA in the reason — "no active sender" would send someone hunting the wrong problem.
    { status: 'failed', reason: wabaId ? `no_sender_on_waba:${wabaId}` : 'no_active_sender' },
    null, channel, purpose);

  const profile = await getProfile(env, opts.profileId);
  const to = opts.to || null;

  // TEST SENDS ONLY — accept a variable's TOKEN as an alias for its source FIELD.
  //
  // An event-sourced variable resolves on `field` (render.js resolveVar), but the Test-values
  // box shows the author the TOKEN, and the failure names the TOKEN too. Where the two differ
  // — e.g. token `order_total` reading field `total` — the error points at a key that does not
  // work, so you retype the name it just gave you and it fails again. That misdirection has
  // cost two people a round each (2026-07-28), which is two more than it should.
  //
  // Test-only on purpose: a real send's event is the true wire payload and must keep failing
  // loudly when a field is genuinely absent. This only widens what a human may type by hand.
  if (opts.isTest && opts.eventContext && typeof opts.eventContext === 'object') {
    const ev = { ...opts.eventContext };
    for (const v of (Array.isArray(template.variables) ? template.variables : [])) {
      const field = v.field || v.token;
      if (field !== v.token && ev[field] === undefined && ev[v.token] !== undefined) {
        ev[field] = ev[v.token];
      }
    }
    opts = { ...opts, eventContext: ev };
  }

  // render — channel-branched. Both share the variable engine + unresolved-token discipline.
  let rendered;
  let waMeta = null;   // {mode, window_open, hasTemplate} — WA-only gate inputs
  try {
    if (channel === 'whatsapp') {
      const isTemplate = !!(template.content && template.content.meta_name);
      // Window is scoped to the SENDING sender's phone_number_id (review H5 part 3) —
      // a window opened on SUPPORT's number must not leak into a MARKETING/TXN free-text
      // send just because it's the same customer. Template sends never need the lookup.
      const senderPhoneId = sender.metadata?.phone_number_id || null;
      const windowOpen = isTemplate ? false : await waWindowOpen(env, to, senderPhoneId);
      const body = renderWhatsapp(template, {
        profile, event: opts.eventContext, constants: opts.constants,
        recipient: opts.recipient, system: {},
      });
      rendered = {
        ...body, to,
        phone_number_id: senderPhoneId,
        window_open: windowOpen,
      };
      waMeta = { mode: body.mode, window_open: windowOpen, hasTemplate: isTemplate };
    } else {
      const sys = {};
      if (purpose === 'marketing') {
        const u = await unsubscribeUrl(env, opts.profileId, channel);
        if (u) sys.unsubscribe_url = u;
      }
      const body = renderEmail(template, {
        profile, event: opts.eventContext, constants: opts.constants,
        recipient: opts.recipient, system: sys,
      });
      // UTM-tag LOT-owned links on MARKETING sends → GA4 attributes the landing session
      // → Odo /funnel by-source. Transactional/utility left untouched (keeps attribution clean).
      if (purpose === 'marketing') {
        const utm = {
          utm_source: 'relay', utm_medium: channel,
          utm_campaign: opts.tracking?.campaign,
          utm_content: opts.tracking?.content ?? template.name,
        };
        const skip = sys.unsubscribe_url ? [sys.unsubscribe_url] : [];
        body.html = tagLinks(body.html, { params: utm, skip, mode: 'html' });
        body.text = tagLinks(body.text, { params: utm, skip, mode: 'text' });
      }
      const fromName = sender.metadata?.from_name || 'Legend of Toys';
      rendered = { ...body, to, from: `${fromName} <${sender.address}>`, unsubscribe_url: sys.unsubscribe_url };
    }
  } catch (e) {
    // FAILED, not skipped. 'skipped' means the gate deliberately withheld the message
    // (suppression / consent / quiet hours / freq cap / test mode) — the system working as
    // intended. Reaching here means rendering broke: an unresolved variable, a bad template, a
    // transient lookup. That is a defect, and filing it under 'skipped' both understates the
    // failure rate in campaign analytics (where skipped and failed are deliberately separate
    // columns) and sends the reader hunting consent settings for a missing constant.
    return await finalize(env, opts, { status: 'failed', reason: e.message }, sender, channel, purpose, template);
  }

  // gate
  const g = await runGate(env, { profileId: opts.profileId, channel, purpose, to, wa: waMeta, isTest: opts.isTest === true });
  if (!g.pass) {
    const st = g.reason === 'suppressed' ? 'suppressed' : 'skipped';
    return await finalize(env, opts, { status: st, reason: g.reason }, sender, channel, purpose, template);
  }

  // adapter send
  const res = await adapter.send(rendered, env);
  return await finalize(env, opts, res, sender, channel, purpose, template, true);
}

// write/update the messages row and return a compact result
async function finalize(env, opts, res, sender, channel, purpose, template, sent) {
  const row = {
    profile_id: opts.profileId || null, channel, purpose,
    sender_identity_id: sender?.id || null,
    template_id: template?.id || null, template_version: template?.version || null,
    source: opts.source || null, provider: sender?.provider || 'resend',
    provider_message_id: res.provider_message_id || null,
    status: res.status, provider_status: res.status, reason: res.reason || null,
    // Non-sent outcomes FREE the key (dedup-on-success). 'sent' keeps it so redeliveries dedup.
    dedup_key: res.status === 'sent' ? (opts.dedupKey || null) : null,
    to_address: opts.to || null,
    sent_at: sent && res.status === 'sent' ? nowIso() : null,
  };
  let msg;
  if (opts._reservedId) {
    const r = await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(opts._reservedId)}`, env,
      { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    msg = (r.ok && r.data?.[0]) || null;
  } else {
    msg = await logMessage(env, row);
  }
  return { status: res.status, reason: res.reason || null, message_id: msg?.id || null,
           provider_message_id: res.provider_message_id || null };
}

module.exports = { send, getActiveSender, pickSender, waWindowOpen };
