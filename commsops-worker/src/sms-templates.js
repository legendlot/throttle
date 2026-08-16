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

// ── Write side (S290 part 3 — Relay-native authoring) ────────────────────────
// The header comment above says "deliberately no write path" — that predates 2026-08-17, when
// the three calls were PROVEN live with a created-then-deleted probe:
//   create  POST /v1/accounts/templates       {name, content, headers:[…]} → {template:{id}}
//           — template_type and the DLT id CANNOT be set at create (arrive empty)
//   update  POST /v1/templates/:id            {"template_type":"Service-Explicit"|"Service-Implicit"}
//           and {"dlt_entity_id":"<19-digit>"} — ⚠️ the key is dlt_entity_id (the vendor field
//           that actually holds the DLT TEMPLATE id, per the S259 finding). ⚠️ NEVER send
//           `dlt_template_id` on this call: probed live, it CLEARS the stored id.
//   delete  — NO API. Web-app session route only (/sms/template/delete/:id); archive in Relay.
// This creates the VENDOR MIRROR only. The DLT-portal registration stays external and stays
// first — creating a mirror for an unregistered body reproduces the exact unsendable state
// this file's read side exists to prevent.
const TYPE_TO_VENDOR = { explicit: 'Service-Explicit', implicit: 'Service-Implicit' };

async function tsCreateSmsTemplate(env, { name, content, header, template_type, dlt_template_id } = {}) {
  if (!String(name || '').trim()) return { ok: false, error: 'name_required' };
  if (!String(content || '').trim()) return { ok: false, error: 'content_required' };
  if (!String(header || '').trim()) return { ok: false, error: 'header_required' };
  const vendorType = TYPE_TO_VENDOR[template_type];
  if (!vendorType) return { ok: false, error: `invalid_template_type:${template_type}` };
  if (!/^\d{19}$/.test(String(dlt_template_id || '')))
    return { ok: false, error: 'dlt_template_id_required:19-digit id from the DLT portal' };

  const c = await TS.tsFetch(env, 'sms', '/v1/accounts/templates', {
    method: 'POST', body: { name: String(name).trim(), content, headers: [String(header).trim()] },
  });
  if (!c.ok) return { ok: false, error: TS.redact(`${c.error.codeMsg || 'error'}:${c.error.message}`) };
  const id = c.data?.template?.id;
  if (!id) return { ok: false, error: 'create_returned_no_id' };

  // The two follow-up updates. A failure here leaves a half-configured vendor row — surface
  // the id so the caller can retry the update rather than duplicating the create.
  const t = await TS.tsFetch(env, 'sms', `/v1/templates/${encodeURIComponent(id)}`, {
    method: 'POST', body: { template_type: vendorType },
  });
  if (!t.ok) return { ok: false, id, error: `created_but_type_failed:${TS.redact(t.error.message || '')}` };
  const d = await TS.tsFetch(env, 'sms', `/v1/templates/${encodeURIComponent(id)}`, {
    method: 'POST', body: { dlt_entity_id: String(dlt_template_id) },
  });
  if (!d.ok) return { ok: false, id, error: `created_but_dlt_id_failed:${TS.redact(d.error.message || '')}` };

  return { ok: true, id, template_type, dlt_template_id: String(dlt_template_id) };
}

module.exports = { tsListTemplates, normalizeTemplateType, countDltVars, tsCreateSmsTemplate };
