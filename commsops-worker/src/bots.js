// Bot CRUD (JWT side). Publish freezes the draft into an immutable bot_versions row —
// the same discipline as journeys: sessions pin the version they started on.
const A = require('./auth.js');
const E = require('./bot-engine.js');

async function listBots(env) {
  const r = await A.sbComms('/rest/v1/bots?select=id,name,status,channel,active_version,updated_at&order=updated_at.desc', env);
  return r.ok ? { ok: true, bots: r.data } : { ok: false, error: 'list_failed' };
}

async function getBot(env, id) {
  const r = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  const bot = r.ok && r.data?.[0];
  return bot ? { ok: true, bot } : { ok: false, error: 'not_found' };
}

async function saveBot(env, { id, name, draft_definition, config }, userId) {
  const body = { name, draft_definition: draft_definition || {}, config: config || {}, updated_at: new Date().toISOString() };
  const r = id
    ? await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}`, env, { method: 'PATCH', body: JSON.stringify(body) })
    : await A.sbComms('/rest/v1/bots', env, { method: 'POST', body: JSON.stringify({ ...body, created_by: userId || null }) });
  const bot = r.ok && (Array.isArray(r.data) ? r.data[0] : r.data);
  return bot ? { ok: true, bot } : { ok: false, error: 'save_failed', detail: r.data };
}

async function publishBot(env, id, userId) {
  const cur = await getBot(env, id);
  if (!cur.ok) return cur;
  const errs = E.validateBotDef(cur.bot.draft_definition);
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

module.exports = { listBots, getBot, saveBot, publishBot, setBotStatus };
