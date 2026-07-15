// WhatsApp template manager (M14 / WS-A.2). Submit a local comms.templates row to Meta for
// approval, and sync its approval status back. A WA template must be Meta-approved before it can
// be used for a template-mode send (business-initiated / outside the 24h window).
//
// Local WA template `content` shape:
//   { meta_name, language, category?, header?, body, footer?, buttons?, mapping? }
//   - body uses positional {{1}}, {{2}} … placeholders (Meta's format).
//   - `mapping` (used at SEND time by renderWhatsapp) lists the {token→slot} bindings;
//     `example` values for submission come from each mapping slot's `example` field.

const A = require('./auth.js');

function graphBase(env) {
  return `https://graph.facebook.com/${env.WA_GRAPH_VERSION || 'v21.0'}`;
}

async function getTemplate(env, id) {
  const r = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}

// Build Meta's message-template `components` array from our content shape.
function buildComponents(content) {
  const components = [];
  const mapping = Array.isArray(content.mapping) ? content.mapping : [];
  const examplesFor = (comp) => mapping.filter((m) => (m.component || 'body') === comp)
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)).map((m) => m.example ?? 'sample');

  if (content.header) {
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
    components.push({ type: 'BUTTONS', buttons: content.buttons });
  }
  return components;
}

function categoryFor(template) {
  const c = (template.content?.category || '').toUpperCase();
  if (c) return c;
  return template.purpose === 'marketing' ? 'MARKETING' : 'UTILITY';
}

// waSubmitTemplate({templateId}) — submit to Meta, mark local approval_status PENDING.
async function waSubmitTemplate(env, body) {
  if (!env.WA_TOKEN || !env.WA_WABA_ID) return { ok: false, error: 'wa_not_configured' };
  const tpl = await getTemplate(env, body.templateId);
  if (!tpl) return { ok: false, error: 'template_not_found' };
  if (tpl.channel !== 'whatsapp') return { ok: false, error: 'not_a_whatsapp_template' };
  const content = tpl.content || {};
  if (!content.meta_name || !content.body) return { ok: false, error: 'meta_name_and_body_required' };

  const graphBody = {
    name: content.meta_name,
    language: content.language || tpl.language || 'en',
    category: categoryFor(tpl),
    components: buildComponents(content),
  };
  let res, data;
  try {
    res = await fetch(`${graphBase(env)}/${env.WA_WABA_ID}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(graphBody),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) { return { ok: false, error: `wa_fetch_error:${e?.message || e}` }; }

  if (!res.ok) return { ok: false, error: data?.error?.message || `wa_http_${res.status}`, raw: data };

  await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(tpl.id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      provider_template_id: data?.id || null,
      approval_status: (data?.status || 'PENDING'),
      updated_at: new Date().toISOString(),
    }),
  });
  return { ok: true, provider_template_id: data?.id || null, status: data?.status || 'PENDING' };
}

// waSyncTemplateStatus({templateId?}) — poll Meta for status; PATCH local approval_status.
// With no templateId, syncs every local whatsapp template that has a meta_name.
async function waSyncTemplateStatus(env, body) {
  if (!env.WA_TOKEN || !env.WA_WABA_ID) return { ok: false, error: 'wa_not_configured' };
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
    let data;
    try {
      const res = await fetch(
        `${graphBase(env)}/${env.WA_WABA_ID}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,category`,
        { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
      data = await res.json().catch(() => ({}));
      if (!res.ok) continue;
    } catch { continue; }
    const status = data?.data?.[0]?.status || null;
    if (status && status !== t.approval_status) {
      await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(t.id)}`, env, {
        method: 'PATCH', body: JSON.stringify({ approval_status: status, updated_at: new Date().toISOString() }) });
    }
    synced.push({ id: t.id, meta_name: name, status });
  }
  return { ok: true, synced };
}

// waListTemplates(env, wabaIds[]) — READ-ONLY catalog pull across WABAs (grant
// verification + template inventory). GET only; no sends, no writes. A WABA that
// 403s = the system user isn't granted it. Returns {wabas:{<id>:{ok,count,templates[]|error}}}.
async function waListTemplates(env, wabaIds) {
  if (!env.WA_TOKEN) return { ok: false, error: 'wa_not_configured' };
  const out = {};
  for (const id of (Array.isArray(wabaIds) ? wabaIds : [])) {
    try {
      const res = await fetch(
        `${graphBase(env)}/${encodeURIComponent(id)}/message_templates?fields=name,language,status,category&limit=200`,
        { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { out[id] = { ok: false, status: res.status, error: data?.error?.message || `http_${res.status}` }; continue; }
      const templates = (data?.data || []).map((t) => ({ name: t.name, language: t.language, status: t.status, category: t.category }));
      out[id] = { ok: true, count: templates.length, templates };
    } catch (e) { out[id] = { ok: false, error: String(e?.message || e) }; }
  }
  return { ok: true, wabas: out };
}

module.exports = { waSubmitTemplate, waSyncTemplateStatus, waListTemplates, buildComponents, categoryFor };
