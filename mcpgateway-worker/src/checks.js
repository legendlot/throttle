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
