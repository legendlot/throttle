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

module.exports = { renderEmail, resolveVar, applyTokens };
