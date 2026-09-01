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

// renderSms(template, ctx) → the object adapters/sms.js consumes.
// SMS is neither email nor WhatsApp: the vendor takes a DLT template id plus POSITIONAL
// pr1..pr5 params, so this returns the resolved values as a NAMED map plus the template's
// `var_order`, and lets the adapter own the positional binding (one place, unit-tested there).
// `body` is still rendered in full because /v1/sms wants the message text alongside the id.
const URL_RE = /https?:\/\//i;

// DLT positional placeholders. ⚠️ IT IS NOT ONLY `{#var#}` — DLT also issues `{#urg#}` for a URL
// slot, and one live template uses it: `harry potter` (`srYE8B8vR`), which is the SMS fallback leg
// of the HP Crest campaign. Found 2026-09-01 by pulling the vendor registry: 59 `{#var#}` and
// 1 `{#urg#}` across the 26 registered templates.
// Matching only `{#var#}` breaks in two directions, so both readers use THIS one pattern:
//   • it UNDERCOUNTS slots — `countDltVars` returned 0 for a 1-slot template, and a bind writing
//     that into `dlt_var_count` would make renderSms throw `var_order_arity_mismatch` forever;
//   • it MISSES an unsubstituted marker — the `unfilled_dlt_placeholders` guard below would let a
//     literal `{#urg#}` through to a customer, which is exactly what that guard exists to stop.
// Returned as a factory: a /g regex carries `lastIndex` between calls, so a shared instance would
// make `.test()` alternate true/false on identical input.
const dltVarRe = () => /\{#\w+#\}/g;
function renderSms(template, ctx) {
  const content = template.content || {};
  const order = Array.isArray(content.var_order) ? content.var_order : [];
  // F9 — the pr1..pr5 ceiling is checked HERE as well as in the adapter. The spec asks for it at
  // bind time so it fails in authoring rather than in front of a customer; render is the earliest
  // point this code path sees the template.
  if (order.length > 5) throw new Error(`too_many_variables:${order.length}`);

  const staticBody = content.body || content.text_body || content.text || '';
  if (!staticBody) throw new Error('empty_sms_body');
  // F6 — `isdesturl` rewrites urls in the outgoing body, and DLT matches delivered content
  // against the registered template, so a url baked into approved content stops matching once
  // shortened and the carrier rejects it. A url must always sit inside a {#var#} variable.
  // Checked against the STATIC body (pre-token), so a url arriving via a variable is fine.
  if (URL_RE.test(staticBody)) throw new Error('static_url_in_template');

  // Positional binding means an arity mismatch shifts every value by one — a grammatical message
  // carrying the wrong words, with nothing erroring. `dlt_var_count` is recorded by the catalog
  // pull from the REGISTERED content, so this is checkable rather than a matter of care.
  // Absent (hand-authored rows) → skipped, never assumed to be zero.
  if (typeof content.dlt_var_count === 'number' && order.length !== content.dlt_var_count)
    throw new Error(`var_order_arity_mismatch:want=${content.dlt_var_count},got=${order.length}`);

  const values = resolveDeclared(template, ctx);
  const body = applyTokens(staticBody, values);

  // A catalogue-seeded row carries the DLT body verbatim, still holding positional {#var#}
  // markers, and send.js fetches templates with NO status gate — so `draft` does not stop a
  // send. This is what actually makes an un-authored template fail closed instead of shipping
  // "{#var#}" to a customer.
  if (dltVarRe().test(body)) throw new Error('unfilled_dlt_placeholders');

  return {
    provider_template_id: template.provider_template_id || null,
    template_type: content.template_type || '',
    dlt_template_id: content.dlt_template_id || null,
    var_order: order,
    vars: values,
    body,
    has_link: URL_RE.test(body),
  };
}

// renderRcs — RCS templates live at TrustSignal (registered against the bot, vendor-approved),
// so Relay's row carries only the binding: which vendor template, which [param] slots it takes,
// and which SMS template is the mandatory fallback leg. Content shape (channel='rcs'):
//   content = { rcs_type, var_params: ['name','link',…], sms_fallback_template_id, ttl? }
// with provider_template_id holding the vendor's RCS template id (same column as SMS/WA).
//
// Variable convention: TrustSignal RCS templates use bracketed NAMED params ([name], [link]) —
// unlike SMS's positional {#var#}. Declare each Relay variable with token === the registered
// param name, and the resolved values map straight onto `rcs_variables` with no positional
// bridge. `var_params` is the registered slot list; every slot must resolve or the send fails
// closed here (unresolved_variables), exactly as SMS does — a template with no params (a fully
// literal body, e.g. a sale blast) renders with an empty map, which is valid.
function renderRcs(template, ctx) {
  const content = template.content || {};
  if (!template.provider_template_id) throw new Error('rcs_template_not_registered');
  const params = Array.isArray(content.var_params) ? content.var_params.map((x) => String(x).trim()).filter(Boolean) : [];
  const values = resolveDeclared(template, ctx);
  const vars = {};
  const missing = [];
  for (const p of params) {
    const v = values[p];
    if (v === undefined || v === null || v === '') { missing.push(p); continue; }
    vars[p] = String(v);
  }
  if (missing.length) throw new Error(`unresolved_variables:${missing.join(',')}`);
  return {
    provider_template_id: template.provider_template_id,
    rcs_type: content.rcs_type || 'text_message',
    vars,
    // The registered slot ORDER (csparams index order from the catalogue pull) — the vendor
    // represents send-time variables positionally (custom_paramN / pr1..prN), so the adapter
    // needs the order, not just the name→value map.
    var_order: params,
    ttl: content.ttl || null,
    sms_fallback_template_id: content.sms_fallback_template_id || null,
  };
}

// ── The RCS→SMS fallback link contract ────────────────────────────────────────────────────
// The fallback leg is rendered from the SAME ctx as the RCS body, so the per-recipient tracked
// link minted by send.js `mintLinkVariable` reaches it ONLY through a variable that resolves
// from the RCS template's `content.link_param`. When it does not, `resolveVar` falls through to
// that variable's own static `fallback` — which does NOT throw, so the leg ships a hardcoded URL
// and looks healthy right up to the carrier.
//
// Measured 2026-09-01 on the 2026-08-21 HP Crest campaign: the RCS row carried `link_param: ""`,
// so `mintLinkVariable` returned at its first guard and minted nothing. The fallback's {link}
// resolved to its static 57-char product URL, and ALL 5,199 fallback sends failed at the carrier
// — 41.4% `Template variable exceed max legnth`, 19.7% `TEMPLATE_FAILED_ON_DYNAMIC_PART`, 11.6%
// `URL not whitelisted`. Zero reached a customer, and nothing surfaced it but the receipts.
//
// ⚠️ This is the STRUCTURAL half — it checks the wiring, which is all that is knowable at save
// time. The runtime half lives in send.js and asserts the rendered body actually carries the
// tracked link (it also catches a mint that failed at runtime, which no static check can see).
// BOTH call this one function so the two can never drift apart — the same lockstep discipline
// RULE-GP-001 §5 records for GP_PURPOSES.
//
// Returns { ok: true } or { ok: false, error, detail } — never throws, so callers choose whether
// a violation is a 400 (authoring) or a failed send.
function checkRcsFallbackLink(rcsTemplate, fbTemplate) {
  const c = (rcsTemplate && rcsTemplate.content) || {};
  const linkParam = String(c.link_param || '').trim();
  const linkBase = String(c.link_target_base || '').trim();
  const declared = Array.isArray(fbTemplate && fbTemplate.variables) ? fbTemplate.variables : [];

  // A variable can only ship a static URL if it HAS one as its fallback/value. A variable with
  // neither cannot silently degrade — it either resolves from the event or fails closed as
  // `unresolved_variables`, which is the behaviour we want and must not flag.
  const urlVars = declared.filter((v) => v
    && (URL_RE.test(String(v.fallback ?? '')) || URL_RE.test(String(v.value ?? ''))));
  if (!urlVars.length) return { ok: true };

  if (!linkParam || !linkBase) {
    return {
      ok: false,
      error: 'rcs_link_param_required',
      detail: `SMS fallback "${fbTemplate?.name || fbTemplate?.id || '?'}" carries a URL variable `
        + `(${urlVars.map((v) => v.token).join(', ')}), so the RCS template must set both `
        + `link_param and link_target_base — otherwise no tracked link is minted and the leg `
        + `ships the static URL, which the carrier rejects on length and on whitelisting.`,
    };
  }

  // Which of those URL variables actually RECEIVE the minted link. mintLinkVariable writes the
  // url to ctx.constants[link_param] AND ctx.event[link_param], so:
  //   • event-sourced   → resolves iff (field || token) === link_param
  //   • constant-sourced→ resolves iff token === link_param AND it has no own `value`, because
  //     resolveVar reads `v.value ?? ctx.constants[v.token]` and an own value always wins.
  // Every other source can never see the mint.
  const receives = (v) => (v.source === 'event' && String(v.field || v.token) === linkParam)
    || (v.source === 'constant' && String(v.token) === linkParam
        && (v.value === undefined || v.value === null || v.value === ''));

  const orphans = urlVars.filter((v) => !receives(v));
  if (orphans.length) {
    return {
      ok: false,
      error: 'fallback_link_var_unwired',
      detail: `SMS fallback "${fbTemplate?.name || fbTemplate?.id || '?'}" variable(s) `
        + `${orphans.map((v) => `{${v.token}}`).join(', ')} will never receive the minted link `
        + `(link_param="${linkParam}"). Name the token — or its event field — exactly `
        + `"${linkParam}", and clear any static value, so both legs share one tracked link.`,
    };
  }
  return { ok: true };
}

module.exports = {
  renderEmail, renderWhatsapp, renderSms, renderRcs, resolveVar, applyTokens, resolveDeclared,
  checkRcsFallbackLink, URL_RE, dltVarRe,
};
