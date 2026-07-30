// Template rendering + variable binding. A template declares variables, each bound
// to a source; the engine resolves all and refuses to ship an unresolved {token}.
// Variable shape: { token, source, field?, fallback? }
//   source: 'profile' | 'event' | 'constant' | 'recipient' | 'system'
//   field:  dotted path within the source (defaults to token)

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function resolveVar(v, ctx) {
  const field = v.field || v.token;
  let val;
  switch (v.source) {
    case 'profile':   val = getPath(ctx.profile?.attributes, field) ?? getPath(ctx.profile, field); break;
    case 'event':     val = getPath(ctx.event, field); break;
    case 'constant':  val = v.value ?? ctx.constants?.[v.token]; break;
    case 'recipient': val = ctx.recipient?.[v.token]; break;
    case 'system':    val = ctx.system?.[field]; break;
    default:          val = undefined;
  }
  if (val === undefined || val === null || val === '') {
    if (v.fallback !== undefined && v.fallback !== null) return String(v.fallback);
    return undefined; // unresolved
  }
  return String(val);
}

function applyTokens(str, values) {
  if (!str) return str;
  return str.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, tok) =>
    Object.prototype.hasOwnProperty.call(values, tok) ? values[tok] : m);
}

// renderEmail(template, ctx) → {subject, html, text}. Throws on any unresolved declared var.
function renderEmail(template, ctx) {
  const content = template.content || {};
  const declared = Array.isArray(template.variables) ? template.variables : [];
  const values = {};
  const unresolved = [];
  for (const v of declared) {
    const r = resolveVar(v, ctx);
    if (r === undefined) unresolved.push(v.token);
    else values[v.token] = r;
  }
  // system vars always available even if not declared (e.g. unsubscribe_url)
  if (ctx.system) for (const [k, val] of Object.entries(ctx.system)) {
    if (!(k in values) && val != null) values[k] = String(val);
  }
  if (unresolved.length) {
    const err = new Error(`unresolved_variables:${unresolved.join(',')}`);
    err.unresolved = unresolved;
    throw err;
  }
  return {
    subject: applyTokens(content.subject || '', values),
    html: applyTokens(content.html_body || content.html || '', values),
    text: applyTokens(content.text_body || content.text || '', values),
  };
}

// resolve every declared variable in `ctx` → {values} or throw on any unresolved token.
// Shared by renderEmail-style callers; kept internal but reused by renderWhatsapp.
function resolveDeclared(template, ctx) {
  const declared = Array.isArray(template.variables) ? template.variables : [];
  const values = {};
  const unresolved = [];
  for (const v of declared) {
    const r = resolveVar(v, ctx);
    if (r === undefined) unresolved.push(v.token);
    else values[v.token] = r;
  }
  if (ctx.system) for (const [k, val] of Object.entries(ctx.system)) {
    if (!(k in values) && val != null) values[k] = String(val);
  }
  if (unresolved.length) {
    const err = new Error(`unresolved_variables:${unresolved.join(',')}`);
    err.unresolved = unresolved;
    throw err;
  }
  return values;
}

// renderWhatsapp(template, ctx) → a rendered object the WA adapter consumes.
//   TEMPLATE mode — template.content has `meta_name`: builds the Graph `components` array
//     from `content.mapping` (an ordered list of {component:'body'|'header'|'button', sub_type?,
//     index?, token}). Each slot's value is resolved via the same variable engine as email;
//     an unresolved slot throws (same discipline). Output = {mode:'template', template:{name,language,components}}.
//   TEXT mode — no `meta_name`: free-form agent/utility reply. Body = content.text_body|text|body,
//     tokens applied. Output = {mode:'text', text}. Valid only inside the 24h window (enforced by
//     the gate + adapter, not here).
function renderWhatsapp(template, ctx) {
  const content = template.content || {};
  const values = resolveDeclared(template, ctx);

  if (content.meta_name) {
    // Meta binds {{1}},{{2}}… by ARRAY POSITION of `parameters`, so slot order is load-bearing.
    // Sort by `pos` — the same key wa-templates.js buildComponents() uses for the submitted
    // example values — so what Meta approved and what we send can never disagree.
    const mapping = (Array.isArray(content.mapping) ? content.mapping : [])
      .slice().sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    const byComp = {};
    for (const slot of mapping) {
      const comp = slot.component || 'body';
      const raw = Object.prototype.hasOwnProperty.call(values, slot.token) ? values[slot.token] : undefined;
      if (raw === undefined) {
        const err = new Error(`unresolved_variables:${slot.token}`);
        err.unresolved = [slot.token];
        throw err;
      }
      (byComp[comp] = byComp[comp] || []).push({ ...slot, value: raw });
    }
    const components = [];
    // Header. A MEDIA header (IMAGE/VIDEO/DOCUMENT) carries no {{n}} text slot — Meta wants the
    // asset itself at send time. Source it from a mapped header slot when the journey supplies a
    // per-message asset, else the template's own static `header_media_url`. Emitting no header
    // component at all for a media-header template makes Meta reject the SEND (132000).
    const headerFormat = String(content.header_format || 'TEXT').toUpperCase();
    if (headerFormat === 'IMAGE' || headerFormat === 'VIDEO' || headerFormat === 'DOCUMENT') {
      const kind = headerFormat.toLowerCase();
      const link = byComp.header?.[0]?.value || content.header_media_url || null;
      // Fail CLOSED, not silent-omit. A media-header template with no asset link would
      // otherwise ship with the header component simply missing — Meta then rejects the
      // send with an opaque 132000, and the customer sees nothing, with no readable reason
      // anywhere in our logs. Throwing here routes it through the same 'failed' + reason
      // path as an unresolved variable (see send.js's render try/catch).
      if (!link) throw Object.assign(new Error('media_header_missing_url'), { reason: 'media_header_missing_url' });
      components.push({ type: 'header', parameters: [{ type: kind, [kind]: { link } }] });
    } else if (byComp.header?.length) {
      components.push({ type: 'header', parameters: byComp.header.map((s) => ({ type: 'text', text: s.value })) });
    }
    if (byComp.body?.length) {
      components.push({ type: 'body', parameters: byComp.body.map((s) => ({ type: 'text', text: s.value })) });
    }
    // button URL/quick-reply parameters, one component per button index
    for (const s of byComp.button || []) {
      components.push({
        type: 'button', sub_type: s.sub_type || 'url', index: String(s.index ?? 0),
        parameters: [{ type: s.param_type || 'text', text: s.value }],
      });
    }
    return {
      mode: 'template',
      template: { name: content.meta_name, language: content.language || template.language || 'en', components },
    };
  }

  const body = applyTokens(content.text_body || content.text || content.body || '', values);

  // MEDIA mode — free-form image/document with an optional caption (a Pitstop agent attachment,
  // S245). Like text and interactive this is a SESSION message, valid only inside the 24h window;
  // it is listed explicitly in gate.js for exactly that reason. The asset arrives as a URL the
  // caller already hosts, and the adapter uploads it to Meta and sends by media ID rather than by
  // link — a link makes Meta re-fetch on every send, which is the async 131053 failure class.
  // Checked BEFORE interactive: buttons and an attachment are not combinable on one message.
  if (content.media && (content.media.url || content.media.link)) {
    return {
      mode: 'media',
      text: body,
      media: {
        url: content.media.url || content.media.link,
        mime_type: content.media.mime_type || content.media.mime || null,
        filename: content.media.filename || null,
      },
    };
  }

  // INTERACTIVE mode — free-form body + reply buttons, no template. Declared on the journey
  // SEND STEP (`interactive` + `buttons[]`), not on a stored template, because these confirms
  // are flow-shaped rather than reusable content ("Are you sure?" belongs to one branch of one
  // journey). Tokens are applied to button labels too, so a button can carry an order number.
  // Falls back to plain text when no buttons were supplied — a misconfigured node still says
  // something rather than failing closed.
  if (Array.isArray(ctx?.interactiveButtons) && ctx.interactiveButtons.length) {
    return {
      mode: 'interactive',
      text: body,
      buttons: ctx.interactiveButtons.slice(0, 3).map((b, i) => ({
        id: String(b.id || b.key || b.text || `btn_${i}`),
        text: applyTokens(String(b.text || b.label || b.id || ''), values),
      })),
    };
  }
  return { mode: 'text', text: body };
}

module.exports = { renderEmail, renderWhatsapp, resolveVar, applyTokens, resolveDeclared };
