// Pure security checks for the LOT MCP gateway. No I/O here, so every rule is unit-tested
// (test/checks.test.mjs). Design + threat model: reference/decisions.md §Team MCP gateway.

export const LOT_DOMAIN = 'legendoftoys.com';

// ---- IPv4 CIDR allowlist (Anthropic's published OUTBOUND ranges; extra layer, never sign-in) ----
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
export function parseCidrs(list) {
  return String(list || '').split(',').map(s => s.trim()).filter(Boolean).map(c => {
    const [ip, bitsRaw] = c.split('/');
    const base = ipv4ToInt(ip);
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`bad CIDR ${c}`);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { base: (base & mask) >>> 0, mask };
  });
}
// IPv6 and anything unparsable is refused: Anthropic publishes no IPv6 outbound range.
export function ipAllowed(ip, cidrs) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return cidrs.some(c => ((n & c.mask) >>> 0) === c.base);
}

// ---- Redirect allowlist: exact string match, no prefix/host matching ----
export function parseList(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}
export function redirectAllowed(uri, allowed) {
  return typeof uri === 'string' && allowed.includes(uri);
}
// DCR: every redirect the client registers must be on the list, so no client can ever hold an
// off-list redirect even if a later code path forgot to check.
export function registrationAllowed(metadata, allowed) {
  const uris = metadata && metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return false;
  return uris.every(u => redirectAllowed(u, allowed));
}

// ---- Google ID token claims (token came straight from Google's token endpoint over TLS,
// OIDC Core 3.1.3.7; the claims are still checked in full) ----
export function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('id_token is not a JWT');
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(pad));
}
// Returns { ok:true, email } or { ok:false, reason }. `hd` in the sign-in URL is only a hint;
// THIS is the domain check (plus the Internal consent screen at Google).
export function checkGoogleClaims(c, { clientId, nonce, nowSec }) {
  if (!c || typeof c !== 'object') return { ok: false, reason: 'no claims' };
  if (!clientId || clientId === 'PENDING') return { ok: false, reason: 'gateway not configured' };
  if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') return { ok: false, reason: 'wrong issuer' };
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) return { ok: false, reason: 'wrong audience' };
  if (Array.isArray(c.aud) && c.aud.length > 1 && c.azp !== clientId) return { ok: false, reason: 'wrong azp' };
  if (typeof c.exp !== 'number' || c.exp <= nowSec) return { ok: false, reason: 'expired' };
  if (typeof c.iat !== 'number' || c.iat > nowSec + 300 || c.iat < nowSec - 600) return { ok: false, reason: 'stale iat' };
  if (!nonce || c.nonce !== nonce) return { ok: false, reason: 'nonce mismatch' };
  if (c.email_verified !== true) return { ok: false, reason: 'email not verified' };
  if (c.hd !== LOT_DOMAIN) return { ok: false, reason: 'not a LOT Workspace account' };
  const email = String(c.email || '').toLowerCase();
  if (!email.endsWith('@' + LOT_DOMAIN) || email.split('@').length !== 2) return { ok: false, reason: 'not a LOT email' };
  return { ok: true, email };
}

// ---- The per-call gate (store.mcp_gate result). Fails closed on anything missing. ----
export function gateDecision(g) {
  if (!g || typeof g !== 'object') return { ok: false, status: 403, reason: 'unknown user' };
  if (g.enabled !== true) return { ok: false, status: 503, reason: 'gateway switched off' };
  if (g.lot_domain !== true) return { ok: false, status: 403, reason: 'not a LOT account' };
  if (g.active !== true) return { ok: false, status: 403, reason: 'account deactivated' };
  if (!Array.isArray(g.systems) || g.systems.length === 0) return { ok: false, status: 403, reason: 'no gateway grant' };
  const cap = Number(g.calls_per_hour), used = Number(g.calls_last_hour);
  if (!Number.isFinite(cap) || !Number.isFinite(used)) return { ok: false, status: 403, reason: 'gate unreadable' };
  return { ok: true, overLimit: used >= cap };
}

// ---- Origin (DNS-rebinding guard, MCP spec): absent is fine (server-to-server), else must match ----
export function originAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

// ---- HMAC for the revoke link ----
export async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---- What a refused person (and their Claude) is told. Plain words, says whose move it is, and
// tells Claude not to retry: an HTTP error made Claude report "the LOT server is broken" (live test 2026-11-09).
const REFUSALS = {
  'gateway switched off': 'LOT data access for AI apps is switched off for everyone right now. Nothing is wrong with your account. Ask Afshaan when it will be back.',
  'no gateway grant': 'Your LOT account has not been given access to LOT data in AI apps, or that access was removed. Ask Afshaan if you need it.',
  'account deactivated': 'Your LOT account is deactivated, so your AI app cannot reach LOT data for you. Ask Afshaan if this is a mistake.',
  'not a LOT account': 'This connection is not signed in with a LOT Google account, so it cannot reach LOT data.',
  'unknown user': 'This connection is not linked to a LOT account. Disconnect the LOT connector and connect again with your @legendoftoys.com Google account.',
  'no odo grant': 'Your LOT access in AI apps does not include Odo. Ask Afshaan if you need it.',
  'odo denied': 'Odo says your account does not have sales access (no Odo role, or it was removed). Ask Afshaan if you need it.',
  'odo pnl denied': 'Odo P&L and product costs are only for Odo super admins.',
  'no docket grant': 'Your LOT access in AI apps does not include Docket. Ask Afshaan if you need it.',
  'no snorkel grant': 'Your LOT access in AI apps does not include Snorkel. Ask Afshaan if you need it.',
  'snorkel denied': 'Your Snorkel role does not include this area (procurement, sales orders or assets). Ask Afshaan if you need it.',
  'no garage grant': 'Your LOT access in AI apps does not include Garage. Ask Afshaan if you need it.',
  'no redline grant': 'Your LOT access in AI apps does not include Redline. Ask Afshaan if you need it.',
  'no depot grant': 'Your LOT access in AI apps does not include Depot. Ask Afshaan if you need it.',
  'ops denied': 'Your LOT role does not include this screen (the same rule as in the app). Ask Afshaan if you need it.',
  'no podium grant': 'Your LOT access in AI apps does not include Podium. Ask Afshaan if you need it.',
  'podium denied': 'Podium does not let your account do this: hiring tools cover openings where you are on the hiring team, or are the opening’s hiring owner or reporting manager. This is Podium’s own rule, not your LOT access.',
  'docket denied': 'Docket does not let your account change this task: only its owner, creator, collaborators or their department can (Docket admins can change any). This is a rule on that one task, not your LOT access.',
  'worker denied': 'That LOT app says your account does not have permission for this. Ask Afshaan if you need it.',
  'session expired': 'LOT could not confirm your LOT login just now. Try once more in a minute; if it says this again, refresh the connection: in your AI app’s connector settings (Claude: Settings, then Connectors; ChatGPT: Settings, then Apps & Connectors), open LOT, disconnect it, then connect again.',
};
const UNREACHABLE = 'LOT systems could not be reached just now. Try again in a few minutes; if it keeps happening, tell Afshaan.';
const FOOT_REFUSED = '(For the AI assistant: this is a deliberate refusal, not a server fault. Tell the user this message as it is and do not retry.)';
const FOOT_FAULT = '(For the AI assistant: a temporary fault on the LOT side. Tell the user this message as it is and do not retry in this turn.)';
// Returns { text, fault }. fault=true means a real outage (alert, distinct error code), never "deliberate".
export function refusalText(reason, { callsPerHour } = {}) {
  if (reason === 'rate limited') {
    const n = Number(callsPerHour);
    return { fault: false, text: `You have used all ${n > 0 ? n : 'your'} LOT data calls for this hour. Calls free up as the hour rolls on; try again a little later. Nothing is broken.\n\n${FOOT_REFUSED}` };
  }
  // A write whose outcome is unknown: never "try again" (createTask is not idempotent; hostile review 2026-11-09).
  if (reason === 'write unconfirmed') return { fault: true, text: `LOT could not confirm whether that Docket change was saved. Check the task with docket_tasks before trying again, so nothing is done twice. If this keeps happening, tell Afshaan.\n\n${FOOT_FAULT}` };
  if (reason === 'podium write unconfirmed') return { fault: true, text: `LOT could not confirm whether that Podium change was saved. Check the batch with podium_hiring report=import (or the openings list) before trying again, so nothing is done twice. If this keeps happening, tell Afshaan.\n\n${FOOT_FAULT}` };
  if (REFUSALS[reason]) return { fault: false, text: `${REFUSALS[reason]}\n\n${FOOT_REFUSED}` };
  return { fault: true, text: `${UNREACHABLE}\n\n${FOOT_FAULT}` }; // unreachable, gate unreadable, anything unmapped
}

// JSON-RPC error codes in the server range, clear of the MCP SDK's own (-32001 = RequestTimeout).
export const RPC_REFUSED = -32010, RPC_FAULT = -32011;
// How a refusal goes back over /mcp. Always HTTP 200: a 4xx/5xx made Claude call the server broken.
// Notification (no id) → 202, no body. tools/call → tool result with isError (Claude reads it out).
// Any other method → JSON-RPC error. The audit row (where one is written) keeps the real status.
export function refusalResponse(msg, { text, fault }) {
  if (!msg || msg.id === undefined) return { status: 202, body: null };
  if (msg.method === 'tools/call') return { status: 200, body: { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text }] } } };
  return { status: 200, body: { jsonrpc: '2.0', id: msg.id, error: { code: fault ? RPC_FAULT : RPC_REFUSED, message: text } } };
}

// ---- What a tool call actually returned, written onto its `call` audit row afterwards (2026-11-11:
// the row is written BEFORE the call as the rate counter, so without this the log could not tell a
// call that returned data from one the app rejected or one that came back empty).
// row_count = items in the result's top-level lists (null when the result is a single summary object).
const NOT_ROWS = new Set(['notes', 'truncated', 'params', 'errors']);
export function rowCount(data) {
  if (data && typeof data === 'object' && 'done' in data) return null; // a Docket write: one task, not rows
  const t = data && typeof data === 'object' && !Array.isArray(data) && 'result' in data ? data.result : data;
  if (Array.isArray(t)) return t.length;
  if (!t || typeof t !== 'object') return null;
  const lists = Object.entries(t).filter(([k, v]) => Array.isArray(v) && !NOT_ROWS.has(k)).map(([, v]) => v);
  return lists.length ? lists.reduce((n, a) => n + a.length, 0) : null;
}
const clip = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
// r = a tool's run() result. Returns the fields patched onto the call row: { status, row_count, detail }.
export function callOutcome(r) {
  if (r && r.ok) {
    const n = rowCount(r.data);
    const cut = r.data && Array.isArray(r.data.truncated) && r.data.truncated.length;
    return { status: 200, row_count: n, detail: cut ? `ok: truncated (${clip(r.data.truncated.join('; '))})` : n === 0 ? 'ok: no rows' : 'ok' };
  }
  // byGateway: the gateway's own pre-check refused it (Docket guardTask); nothing reached the app.
  if (r && r.userError) return { status: 422, row_count: null, detail: `${r.byGateway ? 'refused by gateway' : 'rejected by app'}: ${clip(r.userError)}` };
  const reason = (r && r.reason) || 'unreachable';
  const fault = refusalText(reason).fault;
  return { status: fault ? 503 : 403, row_count: null, detail: `${fault ? 'fault' : 'refused'}: ${clip(reason, 80)}` };
}
// Tool arguments as stored on a call row: whole when under 4,000 UTF-8 bytes; otherwise every key is kept
// (a Docket write's task id must survive) and long strings are clipped to 300 characters.
const AUDIT_MAX_BYTES = 4000;
const utf8Len = s => new TextEncoder().encode(s).length;
export function auditParams(args) {
  let s;
  try { s = JSON.stringify(args ?? {}); } catch { return { unserialisable: true }; }
  const bytes = utf8Len(s);
  if (bytes <= AUDIT_MAX_BYTES) return args ?? {};
  const cut = v => (typeof v === 'string' ? (v.length > 300 ? `${v.slice(0, 300)}…` : v) : Array.isArray(v) ? v.slice(0, 20).map(cut) : v && typeof v === 'object' ? '[object]' : v);
  const o = { _clipped_from_bytes: bytes };
  if (args && typeof args === 'object' && !Array.isArray(args)) for (const k of Object.keys(args).slice(0, 30)) o[k] = cut(args[k]);
  return utf8Len(JSON.stringify(o)) <= AUDIT_MAX_BYTES * 3 ? o : { _clipped_from_bytes: bytes, keys: Object.keys(args || {}).slice(0, 30) };
}
// A call refused for bad arguments: its arguments are unvalidated, so only their names and size are kept.
export function rejectedParams(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  let bytes = null;
  try { bytes = utf8Len(JSON.stringify(args ?? {})); } catch { /* unserialisable */ }
  return { keys: Object.keys(a).slice(0, 30).map(k => k.slice(0, 60)), bytes };
}

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The gateway token must die before the LOT session it carries (2 min margin), never after.
// null = too little life left: refresh the session first (never floor the TTL past the JWT).
export const ttlFor = (expSec, nowSec = Math.floor(Date.now() / 1000)) => {
  const t = Math.min(3600, Number(expSec) - nowSec - 120);
  return Number.isFinite(t) && t >= 60 ? t : null;
};
