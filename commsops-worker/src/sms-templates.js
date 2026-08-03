// TrustSignal SMS template registry — READ side only.
//
// We author DLT templates on the operator's DLT portal and mirror them here; TrustSignal is the
// registry and carrier route, not the author (spec §6c). This module pulls that registry so Relay
// template rows can carry the EXACT registered body text — DLT matches delivered content against
// the registration, so body text that we invented would be rejected by the carrier.
//
// ⚠️ Deliberately no write path. Authoring (`POST /v1/accounts/templates` + the two-call
// template_type update) is out of scope; a single-call create leaves template_type empty, which
// adapters/sms.js `assertBindable` rejects as `template_type_unset`.
const TS = require('./trustsignal-client.js');

// TrustSignal returns DLT consent types as display strings ("Service-Explicit"), while the send
// path and assertBindable use the Sigmo form's value tokens ("explicit"). The vendor's own docs
// spell these inconsistently across endpoints, so normalise on the way in and keep the raw value
// alongside it — an unrecognised type must stay VISIBLE rather than be coerced into a sendable one.
function normalizeTemplateType(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (s === 'service-explicit' || s === 'explicit') return 'explicit';
  if (s === 'service-implicit' || s === 'implicit') return 'implicit';
  if (s === 'promotional') return 'promotional';
  return '';                        // unknown → empty, which assertBindable refuses
}

// Count the positional {#var#} placeholders in DLT content. The NAMES are not recoverable from
// TrustSignal (DLT placeholders are positional), so var_order still has to be authored by hand —
// this only tells us how many slots a template has, and whether it exceeds the pr1..pr5 ceiling.
function countDltVars(content) {
  const m = String(content || '').match(/\{#var#\}/g);
  return m ? m.length : 0;
}

// GET /v1/api/templates — paginated. Read-only.
async function tsListTemplates(env, opts = {}) {
  const limit = Math.min(Number(opts.limit) || 50, 100);
  const out = [];
  let page = Number(opts.page) || 1;
  let total = null;
  // Bounded loop — never `while (true)` against a vendor with no documented rate limit.
  for (let i = 0; i < 20; i++) {
    const qs = `?limit=${limit}&page=${page}` + (opts.status ? `&status=${encodeURIComponent(opts.status)}` : '');
    const r = await TS.tsFetch(env, 'sms', `/v1/api/templates${qs}`);
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
    templates: out.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      headers: t.headers || [],
      content: t.content,
      dlt_entity_id: t.dlt_entity_id,
      template_type_raw: t.template_type,
      template_type: normalizeTemplateType(t.template_type),
      var_count: countDltVars(t.content),
      isunicode: t.isunicode,
      var: t.var || null,
      created_at: t.created_at,
    })),
  };
}

module.exports = { tsListTemplates, normalizeTemplateType, countDltVars };
