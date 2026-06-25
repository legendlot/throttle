// The send() spine — the single outbound gateway. Render → gate → adapter → log.
// Idempotent via dedup_key. On gate-fail writes a skipped/suppressed messages row
// (never a silent drop). Exposed to internal callers; Pitstop re-points here at WA cutover.
const A = require('./auth.js');
const { renderEmail } = require('./render.js');
const { runGate } = require('./gate.js');
const emailAdapter = require('./adapters/email.js');

const ADAPTERS = { email: emailAdapter };
const nowIso = () => new Date().toISOString();
const rand = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.round(Math.random() * 1e9)}`);

async function getActiveSender(env, channel) {
  const r = await A.sbComms(
    `/rest/v1/sender_identities?channel=eq.${A.enc(channel)}&status=eq.active&select=*&order=created_at.asc&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
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

  const sender = await getActiveSender(env, channel);
  if (!sender) return await finalize(env, opts, { status: 'failed', reason: 'no_active_sender' }, null, channel, purpose);

  const template = opts.template || await getTemplate(env, opts.templateId);
  if (!template) return await finalize(env, opts, { status: 'failed', reason: 'template_not_found' }, sender, channel, purpose);

  const profile = await getProfile(env, opts.profileId);
  const to = opts.to || null;

  // render
  let rendered;
  try {
    const sys = {};
    if (purpose === 'marketing') {
      const u = await unsubscribeUrl(env, opts.profileId, channel);
      if (u) sys.unsubscribe_url = u;
    }
    const body = renderEmail(template, {
      profile, event: opts.eventContext, constants: opts.constants,
      recipient: opts.recipient, system: sys,
    });
    const fromName = sender.metadata?.from_name || 'Legend of Toys';
    rendered = { ...body, to, from: `${fromName} <${sender.address}>`, unsubscribe_url: sys.unsubscribe_url };
  } catch (e) {
    return await finalize(env, opts, { status: 'skipped', reason: e.message }, sender, channel, purpose, template);
  }

  // gate
  const g = await runGate(env, { profileId: opts.profileId, channel, purpose, to });
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

module.exports = { send, getActiveSender };
