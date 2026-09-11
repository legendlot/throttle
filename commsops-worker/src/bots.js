// Bot CRUD (JWT side). Publish freezes the draft into an immutable bot_versions row —
// the same discipline as journeys: sessions pin the version they started on.
const A = require('./auth.js');
const E = require('./bot-engine.js');

async function listBots(env) {
  const r = await A.sbComms('/rest/v1/bots?select=id,name,status,channel,active_version,config,updated_at&order=updated_at.desc', env);
  return r.ok ? { ok: true, bots: r.data } : { ok: false, error: 'list_failed' };
}

async function getBot(env, id) {
  const r = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  const bot = r.ok && r.data?.[0];
  return bot ? { ok: true, bot } : { ok: false, error: 'not_found' };
}

// The pilot switch is Afshaan's flip (spec §5.1.3): builders may edit anything in config EXCEPT
// mode/pilot_numbers, which only setBotMode (activate tier) writes. Existing values are kept.
function sanitizeBuilderConfig(incoming, existing) {
  const out = { ...(incoming || {}) };
  out.mode = (existing && existing.mode) || 'pilot';
  out.pilot_numbers = Array.isArray(existing?.pilot_numbers) ? existing.pilot_numbers : [];
  return out;
}

function normalizeMode(body) {
  const mode = body?.mode;
  if (mode !== 'pilot' && mode !== 'public') return null;
  const nums = (Array.isArray(body.pilot_numbers) ? body.pilot_numbers : [])
    .map((n) => String(n).replace(/\D/g, '')).filter((d) => d.length >= 10 && d.length <= 15);
  return { mode, pilot_numbers: [...new Set(nums)] };
}

async function setBotMode(env, id, body, userId) {
  const m = normalizeMode(body);
  if (!m) return { ok: false, error: 'invalid_mode' };
  const cur = await getBot(env, id);
  if (!cur.ok) return cur;
  const config = { ...(cur.bot.config || {}), ...m };
  const u = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}`, env, { method: 'PATCH',
    body: JSON.stringify({ config, updated_at: new Date().toISOString() }) });
  if (!u.ok || !u.data?.[0]) return { ok: false, error: 'update_failed' };
  // The pilot->public flip is the single highest-blast-radius change in this system (every
  // WhatsApp inbound starts meeting a bot) and nothing else records WHO made it or when.
  console.log('bot_mode_changed', JSON.stringify({ id, mode: m.mode, count: m.pilot_numbers.length, by: userId || null }));
  return { ok: true, bot: u.data[0] };
}

// Same instant, whatever the string form — PostgREST echoes `+00:00`, a JS client may send `Z`.
function sameInstant(a, b) {
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}

// Saves are compare-and-swap on updated_at (S377). Last-write-wins let a stale tab's Publish —
// which saves the canvas first — silently overwrite a colleague's newer draft (S372 hostile
// review). The builder echoes the updated_at it loaded; a mismatch is refused as `stale_draft`
// unless the author confirmed the overwrite (`force`). The PATCH also filters on the updated_at
// we just read, so a save landing between our read and our write is caught too.
// ⚠️ An update with NO expected_updated_at is REFUSED (`reload_required`), not waved through:
// that is a tab still running the pre-S377 bundle — exactly the stale tab this guards against
// (S377 hostile review). Only a new bot (no id) or a confirmed `force` skips the check.
async function saveBot(env, { id, name, draft_definition, config, channel, expected_updated_at, force }, userId) {
  const existing = id ? await getBot(env, id) : null;
  if (id && !existing?.ok) return existing;
  if (id && !expected_updated_at && !force) return { ok: false, error: 'reload_required' };
  const guarded = !!(id && expected_updated_at && !force);
  if (guarded && !sameInstant(existing.bot.updated_at, expected_updated_at)) {
    return { ok: false, error: 'stale_draft', current_updated_at: existing.bot.updated_at };
  }
  const prevCfg = existing?.ok ? (existing.bot.config || {}) : {};
  const body = { name, draft_definition: draft_definition || {}, config: sanitizeBuilderConfig(config, prevCfg), updated_at: new Date().toISOString() };
  const ch = ['web', 'whatsapp', 'shared'].includes(channel) ? channel : null;
  if (ch && (!existing?.ok || !existing.bot.active_version)) body.channel = ch;   // channel is fixed at first publish
  const cas = guarded ? `&updated_at=eq.${A.enc(existing.bot.updated_at)}` : '';
  const r = id
    ? await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}${cas}`, env, { method: 'PATCH', body: JSON.stringify(body) })
    : await A.sbComms('/rest/v1/bots', env, { method: 'POST', body: JSON.stringify({ ...body, channel: ch || 'web', created_by: userId || null }) });
  const bot = r.ok && (Array.isArray(r.data) ? r.data[0] : r.data);
  if (!bot && guarded && r.ok) return { ok: false, error: 'stale_draft' };   // the CAS matched no row
  return bot ? { ok: true, bot } : { ok: false, error: 'save_failed', detail: r.data };
}

// `expected_updated_at` (S377 hostile review): Publish freezes whatever draft is CURRENT, so a
// colleague's save landing between the author's save and this call would ship as the author's
// version — a draft they never saw or tested. The builder passes the updated_at its own save
// returned; a mismatch is refused before anything is frozen.
async function publishBot(env, id, userId, expected_updated_at) {
  const cur = await getBot(env, id);
  if (!cur.ok) return cur;
  if (expected_updated_at && !sameInstant(cur.bot.updated_at, expected_updated_at)) {
    return { ok: false, error: 'stale_draft', current_updated_at: cur.bot.updated_at };
  }
  const sh = await A.sbComms('/rest/v1/bots?channel=eq.shared&status=eq.active&active_version=not.is.null&select=id', env);
  if (!sh.ok) return { ok: false, error: 'shared_lookup_failed' };
  const sharedIds = new Set(sh.data.map((b) => b.id));
  const errs = E.validateBotDef(cur.bot.draft_definition, { channel: cur.bot.channel, isShared: cur.bot.channel === 'shared', sharedIds });
  if (errs.length) return { ok: false, error: 'invalid_definition', errors: errs };
  const version = (cur.bot.active_version || 0) + 1;
  const v = await A.sbComms('/rest/v1/bot_versions', env, { method: 'POST',
    body: JSON.stringify({ bot_id: id, version, definition: cur.bot.draft_definition, created_by: userId || null }) });
  if (!v.ok) return { ok: false, error: 'version_write_failed', detail: v.data };
  const u = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}`, env, { method: 'PATCH',
    body: JSON.stringify({ active_version: version, status: 'active', updated_at: new Date().toISOString() }) });
  return u.ok ? { ok: true, bot: u.data?.[0], version } : { ok: false, error: 'publish_failed' };
}

async function setBotStatus(env, id, status) {
  const u = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}`, env, { method: 'PATCH',
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }) });
  return u.ok && u.data?.[0] ? { ok: true, bot: u.data[0] } : { ok: false, error: 'update_failed' };
}

module.exports = { listBots, getBot, saveBot, publishBot, setBotStatus, setBotMode, sanitizeBuilderConfig, normalizeMode };
