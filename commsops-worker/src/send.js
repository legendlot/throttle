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

// Is the WA customer-service window open for this recipient? (last inbound < 24h ago)
async function waWindowOpen(env, to) {
  const id = whatsappAdapter.toWaId(to);
  if (!id) return false;
  const r = await A.sbComms(
    `/rest/v1/wa_windows?identifier_value=eq.${A.enc(id)}&select=last_inbound_at&limit=1`, env);
  const row = r.ok ? r.data?.[0] : null;
  if (!row?.last_inbound_at) return false;
  return (Date.now() - new Date(row.last_inbound_at).getTime()) < 24 * 3600 * 1000;
}
const nowIso = () => new Date().toISOString();
const rand = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.round(Math.random() * 1e9)}`);

// Pure sender selection over the channel's active senders (passed oldest-first).
// Priority: explicit senderId pin → exact purpose match → 'all'/wildcard sender →
// single-sender fallback → null. Returning null (no_active_sender) is deliberate when
// there are MULTIPLE active senders and none matches: refuse rather than silently pick
// the oldest (the pre-fix bug that would route txn/support sends out the wrong number).
// 'all' is the wildcard purpose the live email sender uses; null/'' treated the same.
function pickSender(rows, { purpose, senderId, wabaId } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (senderId) return rows.find((s) => s.id === senderId) || null;   // explicit pin (null if not active on channel)

  // WhatsApp templates are WABA-SCOPED: a template approved on WABA A simply does not exist
  // on WABA B, so sending it from a number on B is rejected by Meta as an unknown template.
  // When the template names its WABA, that constraint outranks purpose — and if no sender sits
  // on that WABA we return null rather than silently sending from the wrong number, because a
  // clear 'no sender for this template's WABA' beats a confusing rejection from Meta.
  // (Harmless while one WA sender exists; load-bearing the moment there are three.)
  if (wabaId) {
    const onWaba = rows.filter((s) => s.metadata && s.metadata.waba_id === wabaId);
    if (!onWaba.length) return null;
    rows = onWaba;
  }

  const isWild = (p) => p == null || p === '' || p === 'all';
  if (purpose) {
    const exact = rows.find((s) => s.purpose === purpose);
    if (exact) return exact;                                          // oldest exact-purpose sender
  }
  const wild = rows.find((s) => isWild(s.purpose));
  if (wild) return wild;                                              // oldest wildcard sender
  return rows.length === 1 ? rows[0] : null;                          // unambiguous single sender, else refuse
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
  if (row && !token) {
    token = rand();
    await A.sbComms(`/rest/v1/consent?id=eq.${A.enc(row.id)}`, env,
      { method: 'PATCH', body: JSON.stringify({ unsubscribe_token: token }) });
  }
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

  // dedup reserve — if a row with this dedup_key exists, never re-send
  if (opts.dedupKey) {
    const reserve = await A.sbComms('/rest/v1/messages?on_conflict=dedup_key', env, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        profile_id: opts.profileId || null, channel, purpose, status: 'queued',
        source: opts.source || null, dedup_key: opts.dedupKey, to_address: opts.to || null,
      }),
    });
    if (reserve.ok && Array.isArray(reserve.data) && reserve.data.length === 0)
      return { status: 'deduped', deduped: true };
    opts._reservedId = reserve.data?.[0]?.id || null;
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

  // render — channel-branched. Both share the variable engine + unresolved-token discipline.
  let rendered;
  let waMeta = null;   // {mode, window_open, hasTemplate} — WA-only gate inputs
  try {
    if (channel === 'whatsapp') {
      const isTemplate = !!(template.content && template.content.meta_name);
      const windowOpen = isTemplate ? false : await waWindowOpen(env, to);
      const body = renderWhatsapp(template, {
        profile, event: opts.eventContext, constants: opts.constants,
        recipient: opts.recipient, system: {},
      });
      rendered = {
        ...body, to,
        phone_number_id: sender.metadata?.phone_number_id || null,
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
    return await finalize(env, opts, { status: 'skipped', reason: e.message }, sender, channel, purpose, template);
  }

  // gate
  const g = await runGate(env, { profileId: opts.profileId, channel, purpose, to, wa: waMeta });
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
    dedup_key: opts.dedupKey || null, to_address: opts.to || null,
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

module.exports = { send, getActiveSender, pickSender };
