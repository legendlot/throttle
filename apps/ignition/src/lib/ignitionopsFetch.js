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

export async function ignitionopsGet(action, params = {}, session) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${IGN_URL}/?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token(session)}` },
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
