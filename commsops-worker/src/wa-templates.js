// WhatsApp template manager (M14 / WS-A.2). Submit a local comms.templates row to Meta for
// approval, and sync its approval status back. A WA template must be Meta-approved before it can
// be used for a template-mode send (business-initiated / outside the 24h window).
//
// Local WA template `content` shape:
//   { meta_name, language, category?, header?, header_format?, header_handle?,
//     body, footer?, buttons?, mapping?, waba_id? }
//   - body uses positional {{1}}, {{2}} … placeholders (Meta's format).
//   - `mapping` (used at SEND time by renderWhatsapp) lists the {token→slot} bindings;
//     `example` values for submission come from each mapping slot's `example` field.
//   - `header_format` TEXT (default) | IMAGE | VIDEO | DOCUMENT. A media header carries NO
//     text; Meta wants a `header_handle` from the Resumable Upload API instead (see waUploadHeaderMedia).
//   - `waba_id` pins the template to ONE WhatsApp Business Account. Templates are WABA-scoped
//     and NON-transferable, and LOT's three live numbers sit on three separate WABAs, so a
//     single global env.WA_WABA_ID cannot serve marketing + transactional + support. Falls
//     back to env.WA_WABA_ID when unset (pre-existing templates keep working unchanged).

const A = require('./auth.js');

const MEDIA_HEADERS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);

function graphBase(env) {
  return `https://graph.facebook.com/${env.WA_GRAPH_VERSION || 'v21.0'}`;
}

// Which WABA does this template belong to? Explicit pin wins; env is the legacy default.
function wabaFor(env, template) {
  return template?.content?.waba_id || env.WA_WABA_ID || null;
}

async function getTemplate(env, id) {
  const r = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}

// Build Meta's message-template `components` array from our content shape.
function buildComponents(content) {
  const components = [];
  const mapping = Array.isArray(content.mapping) ? content.mapping : [];
  const slotsFor = (comp) => mapping.filter((m) => (m.component || 'body') === comp)
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  const examplesFor = (comp) => slotsFor(comp).map((m) => m.example ?? 'sample');

  const headerFormat = String(content.header_format || 'TEXT').toUpperCase();
  if (MEDIA_HEADERS.has(headerFormat)) {
    // Media header: no text, no positional slot. Meta approves the template against a sample
    // asset referenced by an upload handle (`h:…`) from the Resumable Upload API. At SEND time
    // the real per-message media is supplied in the header component's parameters.
    const c = { type: 'HEADER', format: headerFormat };
    if (content.header_handle) c.example = { header_handle: [content.header_handle] };
    components.push(c);
  } else if (content.header) {
    const headerEx = examplesFor('header');
    const c = { type: 'HEADER', format: 'TEXT', text: content.header };
    if (headerEx.length) c.example = { header_text: headerEx };
    components.push(c);
  }
  if (content.body) {
    const bodyEx = examplesFor('body');
    const c = { type: 'BODY', text: content.body };
    if (bodyEx.length) c.example = { body_text: [bodyEx] };
    components.push(c);
  }
  if (content.footer) components.push({ type: 'FOOTER', text: content.footer });
  if (Array.isArray(content.buttons) && content.buttons.length) {
    // A URL button may carry ONE trailing {{1}} (Meta's rule: static base + one variable).
    // Meta REJECTS such a button unless the fully-substituted sample URL is supplied as
    // `example: [url]` — so derive it from the button's own `example_suffix`, else from the
    // matching mapping slot. Buttons key on `index` (0-based), the SAME key renderWhatsapp
    // uses to address a button component at send time — never `pos`, which addresses {{n}}.
    const btnSlots = slotsFor('button');
    const buttons = content.buttons.map((b, i) => {
      const btn = { ...b };
      delete btn.example_suffix;
      if (btn.type === 'URL' && /\{\{\d+\}\}/.test(btn.url || '')) {
        const suffix = b.example_suffix
          ?? btnSlots.find((s) => Number(s.index ?? 0) === i)?.example
          ?? 'sample';
        btn.example = [String(btn.url).replace(/\{\{\d+\}\}/, String(suffix))];
      }
      return btn;
    });
    components.push({ type: 'BUTTONS', buttons });
  }
  return components;
}

// waUploadHeaderMedia({templateId?, url, mimeType?}) — obtain the `h:…` handle a media-header
// template needs for approval, via Meta's two-step Resumable Upload API on the APP (not the WABA):
//   1. POST /{app_id}/uploads?file_length&file_type  → an upload session id
//   2. POST /{session_id} with the bytes + `file_offset: 0` → { h: "<handle>" }
// The handle identifies the SAMPLE asset Meta reviews; it is not the media sent at runtime.
async function waUploadHeaderMedia(env, body) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  const appId = env.WA_APP_ID;
  if (!appId) return { ok: false, error: 'wa_app_id_not_configured' };
  if (!body?.url) return { ok: false, error: 'url_required' };

  let bytes, mime;
  try {
    const src = await fetch(body.url);
    if (!src.ok) return { ok: false, error: `asset_fetch_http_${src.status}` };
    mime = body.mimeType || src.headers.get('content-type') || 'image/jpeg';
    bytes = new Uint8Array(await src.arrayBuffer());
  } catch (e) { return { ok: false, error: `asset_fetch_error:${e?.message || e}` }; }
  if (!bytes.length) return { ok: false, error: 'asset_empty' };

  let sessionId;
  try {
    const res = await fetch(
      `${graphBase(env)}/${encodeURIComponent(appId)}/uploads`
      + `?file_length=${bytes.length}&file_type=${encodeURIComponent(mime)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) return { ok: false, error: data?.error?.message || `upload_session_http_${res.status}`, raw: data };
    sessionId = data.id;   // already of the form "upload:…"
  } catch (e) { return { ok: false, error: `upload_session_error:${e?.message || e}` }; }

  try {
    const res = await fetch(`${graphBase(env)}/${sessionId}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${env.WA_TOKEN}`, file_offset: '0', 'Content-Type': mime },
      body: bytes,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.h) return { ok: false, error: data?.error?.message || `upload_http_${res.status}`, raw: data };

    if (body.templateId) {   // persist the handle onto the template so submit picks it up
      const tpl = await getTemplate(env, body.templateId);
      if (tpl) {
        await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(tpl.id)}`, env, {
          method: 'PATCH',
          body: JSON.stringify({
            content: { ...(tpl.content || {}), header_handle: data.h },
            updated_at: new Date().toISOString(),
          }),
        });
      }
    }
    return { ok: true, handle: data.h, bytes: bytes.length, mime };
  } catch (e) { return { ok: false, error: `upload_error:${e?.message || e}` }; }
}

function categoryFor(template) {
  const c = (template.content?.category || '').toUpperCase();
  if (c) return c;
  return template.purpose === 'marketing' ? 'MARKETING' : 'UTILITY';
}

// waSubmitTemplate({templateId}) — submit to Meta, mark local approval_status PENDING.
// waSubmitTemplate({templateId, stageWabaId}) — PRE-STAGE mode (BiteSpeed-exit migration prep):
//   create the SAME template on a DIFFERENT WABA (a migration destination) with ZERO local
//   mutation — no re-pin, no provider_template_id overwrite, no approval_status change. The
//   local row keeps tracking the LIVE copy until migration day flips `content.waba_id`
//   (a data-only change). Without this mode, submitting would re-pin the row to a WABA that
//   does not hold the number yet, breaking WABA-scoped sender routing. Check a staged copy's
//   approval via the /internal/wa-templates catalog pull on the destination WABA (sync only
//   follows the pin).
async function waSubmitTemplate(env, body) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  const tpl = await getTemplate(env, body.templateId);
  if (!tpl) return { ok: false, error: 'template_not_found' };
  if (tpl.channel !== 'whatsapp') return { ok: false, error: 'not_a_whatsapp_template' };
  let content = tpl.content || {};
  if (!content.meta_name || !content.body) return { ok: false, error: 'meta_name_and_body_required' };

  // Self-serve image headers: the author uploads an asset + saves, but the Meta-side upload
  // handle (`h:…`) is only minted here, at submit time — so a marketer never has to touch a
  // separate "upload" step. Do NOT submit a media template with no handle: Meta rejects it with
  // an opaque error that gives the author nothing to act on (same discipline as the render-time
  // guard in render.js). The handle is APP-scoped (see waUploadHeaderMedia), not WABA-scoped, so
  // this runs identically for a live submit and a pre-stage submit.
  const headerFormat = String(content.header_format || 'TEXT').toUpperCase();
  if (MEDIA_HEADERS.has(headerFormat) && content.header_media_url && !content.header_handle) {
    const up = await waUploadHeaderMedia(env, { templateId: tpl.id, url: content.header_media_url });
    if (!up.ok) return { ok: false, error: `header_upload_failed:${up.error}` };
    content = { ...content, header_handle: up.handle };
  }

  const stageWabaId = body.stageWabaId ? String(body.stageWabaId) : null;
  if (stageWabaId && stageWabaId === (content.waba_id || null)) {
    return { ok: false, error: 'stage_waba_is_pinned_waba' };   // staging onto the live pin is a mistake, not a no-op
  }
  const wabaId = stageWabaId || wabaFor(env, tpl);
  if (!wabaId) return { ok: false, error: 'wa_waba_not_configured' };

  const graphBody = {
    name: content.meta_name,
    language: content.language || tpl.language || 'en',
    category: categoryFor(tpl),
    components: buildComponents(content),
  };
  let res, data;
  try {
    res = await fetch(`${graphBase(env)}/${encodeURIComponent(wabaId)}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(graphBody),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) { return { ok: false, error: `wa_fetch_error:${e?.message || e}` }; }

  if (!res.ok) return { ok: false, error: data?.error?.message || `wa_http_${res.status}`, raw: data };

  if (stageWabaId) {
    // Pre-stage: Meta-side create only. The local row is deliberately untouched (see header).
    return { ok: true, staged: true, provider_template_id: data?.id || null,
             status: data?.status || 'PENDING', waba_id: wabaId };
  }

  await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(tpl.id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      provider_template_id: data?.id || null,
      approval_status: (data?.status || 'PENDING'),
      // Pin the WABA the template was actually created on, so a later env change can never
      // make sync/send look it up on the wrong account.
      content: { ...content, waba_id: wabaId },
      updated_at: new Date().toISOString(),
    }),
  });
  return { ok: true, provider_template_id: data?.id || null, status: data?.status || 'PENDING', waba_id: wabaId };
}

// waSyncTemplateStatus({templateId?}) — poll Meta for status; PATCH local approval_status.
// With no templateId, syncs every local whatsapp template that has a meta_name.
async function waSyncTemplateStatus(env, body) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  let locals;
  if (body.templateId) {
    const t = await getTemplate(env, body.templateId);
    locals = t ? [t] : [];
  } else {
    const r = await A.sbComms(
      `/rest/v1/templates?channel=eq.whatsapp&content->>meta_name=not.is.null&select=id,content,approval_status`, env);
    locals = r.ok ? (r.data || []) : [];
  }
  const synced = [];
  for (const t of locals) {
    const name = t.content?.meta_name;
    if (!name) continue;
    // Look the template up on ITS OWN WABA — a name is only unique within one account, and
    // querying the wrong WABA silently returns nothing (which would read as "no change").
    const wabaId = wabaFor(env, t);
    if (!wabaId) { synced.push({ id: t.id, meta_name: name, status: null, error: 'wa_waba_not_configured' }); continue; }
    let data;
    try {
      const res = await fetch(
        `${graphBase(env)}/${encodeURIComponent(wabaId)}/message_templates`
        + `?name=${encodeURIComponent(name)}&fields=name,language,status,category,rejected_reason`,
        { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
      data = await res.json().catch(() => ({}));
      if (!res.ok) { synced.push({ id: t.id, meta_name: name, status: null, waba_id: wabaId, error: data?.error?.message || `http_${res.status}` }); continue; }
    } catch (e) { synced.push({ id: t.id, meta_name: name, status: null, waba_id: wabaId, error: String(e?.message || e) }); continue; }
    // Exact name + language match ONLY (review M10) — the `|| data?.data?.[0]` fallback used to
    // adopt an UNRELATED template's status when the name lookup came up empty (e.g. a stale
    // meta_name, or a template not yet propagated), silently corrupting approval_status.
    const hit = (data?.data || []).find((x) => x.name === name
      && (!t.content?.language || x.language === (t.content.language || t.language || 'en'))) || null;
    const status = hit?.status || null;
    if (status && status !== t.approval_status) {
      await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(t.id)}`, env, {
        method: 'PATCH', body: JSON.stringify({ approval_status: status, updated_at: new Date().toISOString() }) });
    }
    // Surface WHY Meta rejected — otherwise a REJECTED row gives the author nothing to act on.
    synced.push({ id: t.id, meta_name: name, status, waba_id: wabaId, rejected_reason: hit?.rejected_reason || null });
  }
  return { ok: true, synced };
}

// waListTemplates(env, wabaIds[], opts) — READ-ONLY catalog pull across WABAs (grant
// verification + template inventory). GET only; no sends, no writes. A WABA that
// 403s = the system user isn't granted it. Returns {wabas:{<id>:{ok,count,templates[]|error}}}.
//
// opts.search         — Meta-side `name_or_content` filter. USE THIS to find a template:
//                       the bare list is capped at `limit` and does NOT paginate, and the
//                       live marketing/support WABAs hold 200+ each, so local filtering
//                       silently misses anything past the cap. Server-side search escapes it.
// opts.withComponents — include each template's `components` (header/body/footer/buttons),
//                       i.e. the actual message text. Off by default: 200 templates' bodies
//                       is a large payload and most callers only want the inventory.
async function waListTemplates(env, wabaIds, opts = {}) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  const fields = `name,language,status,category${opts.withComponents ? ',components' : ''}`;
  const limit = Math.min(Number(opts.limit) || 200, 200);
  const search = opts.search ? `&name_or_content=${encodeURIComponent(opts.search)}` : '';
  const out = {};
  for (const id of (Array.isArray(wabaIds) ? wabaIds : [])) {
    try {
      const res = await fetch(
        `${graphBase(env)}/${encodeURIComponent(id)}/message_templates?fields=${fields}&limit=${limit}${search}`,
        { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { out[id] = { ok: false, status: res.status, error: data?.error?.message || `http_${res.status}` }; continue; }
      const templates = (data?.data || []).map((t) => {
        const row = { name: t.name, language: t.language, status: t.status, category: t.category };
        if (opts.withComponents) row.components = t.components || [];
        return row;
      });
      // `capped` = the page filled exactly, so there are probably more we can't see.
      out[id] = { ok: true, count: templates.length, capped: templates.length >= limit, templates };
    } catch (e) { out[id] = { ok: false, error: String(e?.message || e) }; }
  }
  return { ok: true, wabas: out };
}

// Read-only WABA account facts — WHO PAYS, and is the account in a state that can send.
//
// Lives here because this module already owns graphBase() + the WA_TOKEN system-user token;
// it is not template-specific. Strictly a Graph GET: no sends, no writes, no customer data.
//
// The field that matters is `primary_funding_id` — the funding source Meta bills. On a WABA
// that rides a BSP's credit line this is the BSP's funding entity, NOT ours (support WABA
// 2257035788468620 read SMARTPING AI LIMITED in Business Settings on 2026-07-17). Meta bills
// whoever owns that id, so it is the single fact that decides whether we can send on our own
// account after leaving a BSP — and the cleanest way to CONFIRM a newly-added payment method
// actually took, rather than trusting the settings screen.
//
// Deliberately reports the raw id: mapping an id to a company name needs a permission on the
// funding entity we do not have, and inventing a label we cannot verify is how the "TS =
// TrustSignal" error happened. Compare the id before/after attaching a card — a CHANGE is the
// proof, and it needs no name.
async function waAccountInfo(env, wabaIds) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  // MEASURED 2026-07-21: `primary_funding_id` / `owner_business_info` /
  // `on_behalf_of_business_info` are **BSP-ONLY** — Graph answers
  //   "(#10) ... requires that the Business that owns this App is a Business Solution Provider"
  // LOT is a direct business, not a BSP, so these are permanently unreadable for us; no grant
  // fixes it. Verifying who funds a WABA therefore has to be done in Business Settings ("How
  // you'll pay"), NOT here. Kept as a best-effort first attempt only, because Graph rejects the
  // WHOLE request if any single requested field is forbidden — which is what dragged the
  // harmless fields down with it on the first run.
  const BSP_FIELDS = 'id,name,currency,timezone_id,country,ownership_type,primary_funding_id,'
    + 'account_review_status,business_verification_status,health_status,'
    + 'owner_business_info,on_behalf_of_business_info';
  // Everything here is readable by an ordinary business token.
  const SAFE_FIELDS = 'id,name,currency,timezone_id,account_review_status,business_verification_status';
  // Phone numbers are fetched alongside because `platform_type` answers the question that
  // actually decides the cutover shape: is the number ALREADY on Cloud API? If it is, and our
  // token can see its id, Relay can send using the existing phone_number_id — no re-registration
  // (the "one genuinely disruptive act"), no partner removal, no billing change. `id` here IS the
  // phone_number_id that `sender_identities` needs.
  const numFields = 'id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status,status';
  const getFields = async (id, f) => {
    const res = await fetch(`${graphBase(env)}/${encodeURIComponent(id)}?fields=${f}`,
      { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
    return { res, data: await res.json().catch(() => ({})) };
  };

  const out = {};
  for (const id of (Array.isArray(wabaIds) ? wabaIds : [])) {
    try {
      let { res, data } = await getFields(id, BSP_FIELDS);
      let bspRestricted = false;
      // Fall back to the safe set rather than losing everything to one forbidden field.
      if (!res.ok) {
        const retry = await getFields(id, SAFE_FIELDS);
        if (retry.res.ok) { bspRestricted = true; res = retry.res; data = retry.data; }
      }
      // Still failing on the SAFE set means the token genuinely cannot see this WABA —
      // a different problem from the BSP gate, and one a system-user grant DOES fix.
      if (!res.ok) {
        out[id] = { ok: false, status: res.status, error: data?.error?.message || `http_${res.status}`,
                    hint: 'token cannot see this WABA — assign the relay wa bot system user to it' };
        continue;
      }
      if (bspRestricted) data.funding_note = 'primary_funding_id is BSP-only — check "How you\'ll pay" in Business Settings';
      // WHICH APPS MAY ACT ON THIS WABA. Reading a WABA needs only asset access +
      // whatsapp_business_management; SENDING additionally requires the token's app to be
      // SUBSCRIBED to that WABA. A WABA onboarded by a BSP has the BSP's app subscribed and not
      // ours — which produces exactly "(#200) You do not have the necessary permissions to send
      // messages on behalf of this WhatsApp Business Account" while every read keeps working.
      let subscribedApps = null;
      try {
        const sr = await fetch(`${graphBase(env)}/${encodeURIComponent(id)}/subscribed_apps`,
          { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
        const sd = await sr.json().catch(() => ({}));
        subscribedApps = sr.ok ? (sd?.data || [])
                               : { error: sd?.error?.message || `http_${sr.status}`, status: sr.status };
      } catch (e) { subscribedApps = { error: String(e?.message || e) }; }

      let numbers = null;
      try {
        const nr = await fetch(`${graphBase(env)}/${encodeURIComponent(id)}/phone_numbers?fields=${numFields}`,
          { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
        const nd = await nr.json().catch(() => ({}));
        // Non-fatal: the WABA facts are still worth returning if the number read is denied.
        numbers = nr.ok ? (nd?.data || [])
                        : { error: nd?.error?.message || `http_${nr.status}`, status: nr.status };
      } catch (e) { numbers = { error: String(e?.message || e) }; }
      out[id] = { ok: true, ...data, phone_numbers: numbers, subscribed_apps: subscribedApps };
    } catch (e) { out[id] = { ok: false, error: String(e?.message || e) }; }
  }
  return { ok: true, wabas: out };
}

// What can WA_TOKEN actually do? Rules out the other reading of a (#200): that the token simply
// lacks `whatsapp_business_messaging` (reads only need `whatsapp_business_management`, so a
// management-only token reads happily and fails every send). Returns SCOPES ONLY — never the
// token, and never anything that could reconstruct it.
async function waTokenScopes(env) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  const r = await fetch(
    `${graphBase(env)}/debug_token?input_token=${encodeURIComponent(env.WA_TOKEN)}`,
    { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j?.error?.message || `http_${r.status}` };
  const d = j?.data || {};
  return {
    ok: true,
    app_id: d.app_id || null,
    application: d.application || null,
    type: d.type || null,
    is_valid: d.is_valid ?? null,
    expires_at: d.expires_at ?? null,          // 0 = never, which is what a system-user token should read
    scopes: d.scopes || [],
    can_send: Array.isArray(d.scopes) && d.scopes.includes('whatsapp_business_messaging'),
  };
}

// Subscribe THIS app to a WABA — the missing step that lets it send, not just read.
//
// NOT read-only, and not free of consequence: subscribing also starts webhook delivery for that
// WABA to commsops. On a number that receives customer messages (the support line) that means
// inbound arrives here ALONGSIDE the incumbent BSP, so two systems could answer the same
// customer. Takes an explicit wabaId — never a loop over every WABA — so the blast radius is
// always a deliberate choice.
async function waSubscribeApp(env, wabaId) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  if (!wabaId) return { ok: false, error: 'waba_id_required' };
  const r = await fetch(`${graphBase(env)}/${encodeURIComponent(wabaId)}/subscribed_apps`,
    { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, waba_id: wabaId, result: j }
              : { ok: false, waba_id: wabaId, status: r.status, error: j?.error?.message || `http_${r.status}` };
}

// waMigrateNumber(env, {op, ...}) — the 4-call BSP→own-WABA number migration (Meta's documented
// flow, cutover runbook). Each op is a thin wrapper over ONE Graph call. State-changing and
// IRREVERSIBLE past `start` (Meta detaches the number from its current BSP the moment the
// migrate-in call succeeds) — this is why it is a separate token-gated internal route, called
// deliberately step by step during the live migration, never looped or automated.
//
//   start        {destWabaId, cc, phoneNumber} → POST /{destWabaId}/phone_numbers
//                  {cc, phone_number, migrate_phone_number:true}
//                  Returns the NEW phone_number_id (Meta's `id`) — the id every later op needs.
//   request_code {phoneNumberId, method}        → POST /{phoneNumberId}/request_code
//                  {code_method: SMS|VOICE, language:'en_US'}
//   verify       {phoneNumberId, code}          → POST /{phoneNumberId}/verify_code {code}
//   register     {phoneNumberId, pin}           → POST /{phoneNumberId}/register
//                  {messaging_product:'whatsapp', pin} — Meta REQUIRES a 6-digit pin to
//                  (re)enable two-step verification on registration. This pin becomes the
//                  number's NEW two-step PIN going forward — record whatever is actually sent
//                  (real callers should supply one; '000000' is only a same-day placeholder
//                  default, matching the Scanner Attendance throwaway-PIN convention).
//
// Every op returns the raw Graph response spread onto {ok:true, ...} on success, or
// {ok:false, error, code, details} on a non-2xx / network failure — never throws, and never
// swallows Meta's error surface, because a live migration's failure modes (error 133xxx class:
// already-migrating, two-step-enabled-on-source, wrong-cc, etc.) are diagnosed from that detail.
async function waMigrateNumber(env, body) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  const op = body?.op;
  const post = async (path, graphBody) => {
    let res, data;
    try {
      res = await fetch(`${graphBase(env)}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(graphBody),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) { return { ok: false, error: `graph_network:${e?.message || e}` }; }
    if (!res.ok) {
      return { ok: false, error: data?.error?.message || `http_${res.status}`,
               code: data?.error?.code, details: data?.error };
    }
    return { ok: true, ...data };
  };

  switch (op) {
    case 'start': {
      const { destWabaId, cc, phoneNumber } = body;
      if (!destWabaId || !cc || !phoneNumber) return { ok: false, error: 'missing_params' };
      return post(`/${encodeURIComponent(destWabaId)}/phone_numbers`,
        { cc, phone_number: phoneNumber, migrate_phone_number: true });
    }
    case 'request_code': {
      const { phoneNumberId, method } = body;
      if (!phoneNumberId) return { ok: false, error: 'missing_params' };
      return post(`/${encodeURIComponent(phoneNumberId)}/request_code`,
        { code_method: method === 'voice' ? 'VOICE' : 'SMS', language: 'en_US' });
    }
    case 'verify': {
      const { phoneNumberId, code } = body;
      if (!phoneNumberId || code == null) return { ok: false, error: 'missing_params' };
      return post(`/${encodeURIComponent(phoneNumberId)}/verify_code`, { code: String(code) });
    }
    case 'register': {
      const { phoneNumberId, pin } = body;
      if (!phoneNumberId) return { ok: false, error: 'missing_params' };
      return post(`/${encodeURIComponent(phoneNumberId)}/register`,
        { messaging_product: 'whatsapp', pin: String(pin ?? '000000') });
    }
    // Meta v21+ refuses to register a MIGRATED number until its data-localization region is
    // configured (error 100: "Expected data localization region: 'IN'"). One-time, pre-register.
    case 'settings': {
      const { phoneNumberId, dataLocalizationRegion } = body;
      if (!phoneNumberId || !dataLocalizationRegion) return { ok: false, error: 'missing_params' };
      return post(`/${encodeURIComponent(phoneNumberId)}/settings`,
        { storage_configuration: { status: 'IN_COUNTRY_STORAGE_ENABLED',
            data_localization_region: String(dataLocalizationRegion) } });
    }
    default:
      return { ok: false, error: 'unknown_op' };
  }
}

module.exports = {
  waSubmitTemplate, waSyncTemplateStatus, waListTemplates, waUploadHeaderMedia, waAccountInfo,
  waTokenScopes, waSubscribeApp, waMigrateNumber,
  buildComponents, categoryFor, wabaFor,
};
