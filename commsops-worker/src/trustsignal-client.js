// TrustSignal vendor boundary. Hosts, auth, error shapes, phone rendering.
// NO channel logic and NO database access lives here — SMS and RCS both import it.

// ── Phone rendering (F1) ─────────────────────────────────────────────────────
// Relay stores canonical E.164. `/v1/sms` wants BARE 10 DIGITS, which makes the naive
// implementation "take the last 10" — and that sends +14155550123 to Indian mobile
// 4155550123, a real unrelated person, with nothing erroring anywhere.
//
// So: only a well-formed +91 is dialable. Everything else is a typed refusal, never a
// best-effort repair. The DLT header and template registry are India-only, so an
// international SMS could not be compliant even if it were deliverable.
function renderPhoneForSms(e164) {
  const s = typeof e164 === 'string' ? e164.trim() : '';
  if (!/^\+\d+$/.test(s)) return { ok: false, value: null, reason: 'invalid_phone' };
  if (!s.startsWith('+91')) return { ok: false, value: null, reason: 'unsupported_country' };
  if (s.length !== 13) return { ok: false, value: null, reason: 'invalid_phone' };
  return { ok: true, value: s.slice(3) };
}

// ── Credential redaction ─────────────────────────────────────────────────────
// TrustSignal authenticates with ?api_key= in the URL, so the key reaches every log line,
// span and exception that echoes a request. One console.error(url) leaks the account key
// into Cloudflare logs. EVERY log/error path in this integration goes through redact().
function redact(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/(api_key=)[^&\s'"]+/gi, '$1[redacted]');
}

// ── Error normalisation ──────────────────────────────────────────────────────
// Three incompatible failure shapes ship in the vendor collection:
//   A  { errors: [{ code, codeMsg, message }] }   most SMS/RCS/WhatsApp endpoints
//   B  { message }                                 Otify verify, WA typing indicator
//   C  { error }                                   WA Get Webhook
// The published code catalogue is explicitly partial, so an unrecognised body must still
// produce a usable message rather than throwing inside a send path.
function normalizeError(body) {
  const b = body || {};
  const first = Array.isArray(b.errors) ? b.errors[0] : null;
  if (first) {
    return {
      code: first.code != null ? String(first.code) : null,
      codeMsg: first.codeMsg || null,
      message: first.message || first.codeMsg || 'trustsignal_error',
    };
  }
  const msg = (typeof b.message === 'string' && b.message)
    || (typeof b.error === 'string' && b.error)
    || 'trustsignal_error';
  return { code: null, codeMsg: null, message: msg };
}

// ── Hosts ────────────────────────────────────────────────────────────────────
// One host per service, and the path prefixes DISAGREE (sms `/v1`, rcs `/api/v1`).
// Hard-code per call site; never derive a path from a base.
const HOSTS = {
  auth: 'https://auth.trustsignal.io',
  sms:  'https://sms.trustsignal.io',
  rcs:  'https://rcsapi.trustsignal.io',
};

// tsFetch(env, service, path, {method, body}) → {ok, status, data, error}
// `error` is a normalized {code, codeMsg, message} on any non-2xx OR success:false body —
// the vendor returns HTTP 400 for conditions that are logically 404 (codes 109/114), so
// NEVER branch on HTTP status alone.
async function tsFetch(env, service, path, opts = {}) {
  const base = HOSTS[service];
  if (!base) throw new Error(`unknown_trustsignal_service:${service}`);
  const key = env.TRUSTSIGNAL_API_KEY;
  if (!key) return { ok: false, status: 0, data: null, error: { code: null, codeMsg: 'API_KEY_MISSING', message: 'TRUSTSIGNAL_API_KEY not set' } };

  const sep = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${sep}api_key=${encodeURIComponent(key)}`;

  let res, data;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  } catch (e) {
    // A network failure must be a RESULT, not a throw — a throw escapes the send path and
    // leaves no messages row (the same failure mode adapters/email.js guards against).
    return { ok: false, status: 0, data: null,
             error: { code: null, codeMsg: 'NETWORK', message: redact(String(e?.message || e)).slice(0, 140) } };
  }

  const okBody = data && typeof data === 'object' ? data.success !== false : true;
  if (!res.ok || !okBody) {
    return { ok: false, status: res.status, data, error: normalizeError(data) };
  }
  return { ok: true, status: res.status, data, error: null };
}

module.exports = { renderPhoneForSms, redact, normalizeError, tsFetch, HOSTS };
