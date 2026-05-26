/**
 * csopsFetch — thin client for the csops Cloudflare Worker.
 * Mirrors @throttle/db workerFetch but pointed at NEXT_PUBLIC_CSOPS_URL.
 *
 * GET reads:  csopsGet(action, params, session)  → { ok, data }
 * POST writes: csopsPost(action, body, session)  → { ok, data, error? }
 */

function token(session) {
  return typeof session === 'string' ? session : session?.access_token;
}

const CSOPS_URL = process.env.NEXT_PUBLIC_CSOPS_URL || 'https://csops.afshaan.workers.dev';

export async function csopsGet(action, params = {}, session) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${CSOPS_URL}/?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token(session)}` },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `csopsGet ${action} failed (${res.status})`);
  return data.data;
}

export async function csopsPost(action, body = {}, session) {
  const res = await fetch(`${CSOPS_URL}/?action=${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token(session)}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `csopsPost ${action} failed (${res.status})`);
  return data.data;
}
