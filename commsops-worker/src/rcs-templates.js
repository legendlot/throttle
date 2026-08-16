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

module.exports = { tsListRcsTemplates, orderedParams };
