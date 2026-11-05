/**
 * ignitionopsFetch — thin client for the ignitionops Cloudflare Worker.
 * Mirrors csopsFetch in pattern; pointed at NEXT_PUBLIC_IGNITIONOPS_URL.
 *
 * GET reads:  ignitionopsGet(action, params, session)  → unwrapped data
 * POST writes: ignitionopsPost(action, body, session)  → unwrapped data
 */

function token(session) {
  return typeof session === 'string' ? session : session?.access_token;
}

const IGN_URL = process.env.NEXT_PUBLIC_IGNITIONOPS_URL || 'https://ignitionops.afshaan.workers.dev';

// opts.signal: an AbortSignal (typeahead aborts the previous keystroke's call).
export async function ignitionopsGet(action, params = {}, session, opts = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${IGN_URL}/?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token(session)}` },
    signal: opts.signal,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `ignitionopsGet ${action} failed (${res.status})`);
  return data.data;
}

export async function ignitionopsPost(action, body = {}, session) {
  const res = await fetch(`${IGN_URL}/?action=${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token(session)}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `ignitionopsPost ${action} failed (${res.status})`);
  return data.data;
}

// The creator's accept link (app/deal): no login, so no Authorization header. The token is the
// credential. `sub` is '' for the read, or accept | bank | invoice-url | invoice-done (POST only).
export async function contractPublic(sub, token, body) {
  const res = body === undefined
    ? await fetch(`${IGN_URL}/public/contract?t=${encodeURIComponent(token)}`)
    : await fetch(`${IGN_URL}/public/contract/${sub}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, t: token }),
    });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const e = new Error(data.error || 'Something went wrong. Please try again.');
    e.status = res.status;
    e.fieldErrors = data.errors || null;
    throw e;
  }
  return data.data;
}
