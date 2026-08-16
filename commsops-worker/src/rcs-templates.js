// TrustSignal RCS template registry — READ side only (S290, mirrors sms-templates.js).
//
// RCS templates are authored in the Sigmo UI and approved by the vi hub; Relay's row is a
// BINDING (provider_template_id + param slots + the mandatory SMS fallback reference), so this
// pull exists to surface the registry — ids, approval status, and the authoritative param
// order — not to copy content in.
//
// Endpoint discovered live 2026-08-17 (absent from the vendor collection): GET /api/v1/template
// on the rcs host, same {limit, page, templates[], totalrecords} envelope as SMS.
//
// The two fields that matter:
//  · `csparams` — {custom_param0: '<name>', custom_param1: '<name>', …}. This is the
//    AUTHORITATIVE param order: the vendor represents send-time variables positionally
//    (custom_paramN / the pr1..prN echoed on delivery webhooks), so a binding row's
//    var_params must be written in csparams INDEX order, never alphabetical.
//  · `status` — case-INCONSISTENT live ('approved' vs 'Submitted'); normalize lowercase.
//    Never send on a template whose status is not approved.
const TS = require('./trustsignal-client.js');

// csparams object → param names ordered by their custom_paramN index.
function orderedParams(csparams) {
  if (!csparams || typeof csparams !== 'object') return [];
  return Object.keys(csparams)
    .map((k) => ({ i: Number((k.match(/(\d+)$/) || [])[1]), name: csparams[k] }))
    .filter((x) => Number.isFinite(x.i) && x.name)
    .sort((a, b) => a.i - b.i)
    .map((x) => String(x.name));
}

// GET /api/v1/template — paginated. Read-only.
async function tsListRcsTemplates(env, opts = {}) {
  const limit = Math.min(Number(opts.limit) || 50, 100);
  const out = [];
  let page = Number(opts.page) || 1;
  let total = null;
  for (let i = 0; i < 20; i++) {                       // bounded, same as the SMS pull
    const qs = `?limit=${limit}&page=${page}`;
    const r = await TS.tsFetch(env, 'rcs', `/api/v1/template${qs}`);
    if (!r.ok) return { ok: false, error: TS.redact(`${r.error.codeMsg || 'error'}:${r.error.message}`), page };
    const batch = Array.isArray(r.data?.templates) ? r.data.templates : [];
    total = r.data?.totalrecords ?? total;
    out.push(...batch);
    if (batch.length < limit || (total != null && out.length >= total)) break;
    page += 1;
  }
  return {
    ok: true,
    total_records: total,
    count: out.length,
    templates: out.map((t) => {
      let tjson = null;
      try { tjson = t.tjson ? JSON.parse(t.tjson) : null; } catch { /* keep raw absent */ }
      return {
        id: t.id,
        name: t.name,
        rcs_type: t.ttype,
        bot_id: t.bot_id,
        status_raw: t.status,
        status: String(t.status || '').toLowerCase(),   // 'approved' | 'submitted' | …
        approved: String(t.status || '').toLowerCase() === 'approved',
        var_params: orderedParams(t.csparams),
        // turl-tracked button destinations arrive as their own positional params — surfaced
        // so an author can see the full slot picture, never sent by us (server-side fixed).
        desturl: t.desturl || null,
        error: (t.error || '').trim() || null,
        errcode: (t.errcode || '').trim() || null,
        tjson,
        created_at: t.created_at,
        modified_at: t.modified_at,
      };
    }),
  };
}

// ── Write side (S290 part 3 — Relay-native authoring) ────────────────────────
// Both endpoints PROVEN live 2026-08-17 (~02:40) with a created-then-deleted probe:
//   create  POST /api/v1/template          (flat tjson fields; returns {template:{id,status}})
//   delete  POST /api/v1/template/delete/:id
// The vendor derives csparams AUTOMATICALLY from the [bracketed] params in the content, in
// order of first appearance — so var_params on the Relay row must be derived the same way.

const NAME_RE = /^[A-Za-z0-9_]{1,20}$/;
const RCS_TYPES = new Set(['text_message', 'text_message_with_media', 'rich_card', 'carousel']);

// Ordered unique [param] names by first appearance — mirrors how the vendor builds csparams.
function bracketParams(...texts) {
  const seen = [];
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/\[([a-zA-Z0-9_]+)\]/g)) {
      if (!seen.includes(m[1])) seen.push(m[1]);
    }
  }
  return seen;
}

async function tsCreateRcsTemplate(env, spec = {}) {
  const name = String(spec.name || '').trim();
  if (!NAME_RE.test(name)) return { ok: false, error: 'invalid_name:1-20 chars, alphanumeric + underscore' };
  if (!RCS_TYPES.has(spec.type)) return { ok: false, error: `invalid_type:${spec.type}` };
  if (!spec.botId) return { ok: false, error: 'bot_required' };

  const body = { name, type: spec.type, botId: spec.botId };
  if (spec.type === 'text_message') {
    if (!String(spec.textMessageContent || '').trim()) return { ok: false, error: 'content_required' };
    body.textMessageContent = spec.textMessageContent;
    body.suggestions = Array.isArray(spec.suggestions) ? spec.suggestions : [];
  } else if (spec.type === 'rich_card') {
    const sa = spec.standAlone || {};
    if (!String(sa.cardTitle || '').trim() || !String(sa.cardDescription || '').trim())
      return { ok: false, error: 'card_title_and_description_required' };
    if (!String(sa.mediaUrl || '').trim()) return { ok: false, error: 'media_url_required' };
    body.orientation = spec.orientation || 'HORIZONTAL';
    body.alignment = spec.alignment || 'LEFT';
    if (body.orientation === 'VERTICAL') body.height = spec.height || 'MEDIUM_HEIGHT';
    body.standAlone = {
      cardTitle: sa.cardTitle, cardDescription: sa.cardDescription, mediaUrl: sa.mediaUrl,
      ...(sa.thumbnailUrl ? { thumbnailUrl: sa.thumbnailUrl } : {}),
      suggestions: Array.isArray(sa.suggestions) ? sa.suggestions : [],
    };
  } else {
    // text_with_media / carousel authoring is UI-scoped later; the API accepts the same flat
    // shape, but nothing composes it yet — refuse loudly rather than half-support.
    return { ok: false, error: `type_not_yet_composable:${spec.type}` };
  }
  // Every suggestion needs a non-empty postback — the vendor rejects the whole template
  // otherwise (learned live on Freedom_Sale_Card: "Within suggestion, postback must not be
  // empty"). Enforced here so the author hears it at submit, not from the ERROR column.
  const allSugs = (body.suggestions || []).concat(body.standAlone?.suggestions || []);
  for (const s of allSugs) {
    if (!String(s?.postback || '').trim()) return { ok: false, error: 'suggestion_postback_required' };
    if (!String(s?.displayText || '').trim()) return { ok: false, error: 'suggestion_text_required' };
  }

  const r = await TS.tsFetch(env, 'rcs', '/api/v1/template', { method: 'POST', body });
  if (!r.ok) return { ok: false, error: TS.redact(`${r.error.codeMsg || 'error'}:${r.error.message}`) };
  const t = r.data?.template || {};
  return {
    ok: true,
    id: t.id || null,
    status: String(t.status || 'pending').toLowerCase(),
    var_params: bracketParams(
      body.textMessageContent, body.standAlone?.cardTitle, body.standAlone?.cardDescription),
  };
}

async function tsDeleteRcsTemplate(env, id) {
  if (!id) return { ok: false, error: 'id_required' };
  const r = await TS.tsFetch(env, 'rcs', `/api/v1/template/delete/${encodeURIComponent(id)}`, { method: 'POST' });
  if (!r.ok) return { ok: false, error: TS.redact(`${r.error.codeMsg || 'error'}:${r.error.message}`) };
  return { ok: true };
}

module.exports = { tsListRcsTemplates, orderedParams, tsCreateRcsTemplate, tsDeleteRcsTemplate, bracketParams };
