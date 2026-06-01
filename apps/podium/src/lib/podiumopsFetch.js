/**
 * podiumopsFetch — thin client for the podiumops Cloudflare Worker.
 * Mirrors ignitionopsFetch; pointed at NEXT_PUBLIC_PODIUMOPS_URL.
 *
 * GET reads:  podiumopsGet(action, params, session)  → unwrapped data
 * POST writes: podiumopsPost(action, body, session)  → unwrapped data
 */

function token(session) {
  return typeof session === 'string' ? session : session?.access_token;
}

const PD_URL = process.env.NEXT_PUBLIC_PODIUMOPS_URL || 'https://podiumops.afshaan.workers.dev';

export async function podiumopsGet(action, params = {}, session) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') clean[k] = v;
  const qs = new URLSearchParams({ action, ...clean }).toString();
  const res = await fetch(`${PD_URL}/?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token(session)}` },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `podiumopsGet ${action} failed (${res.status})`);
  return data.data;
}

export async function podiumopsPost(action, body = {}, session) {
  const res = await fetch(`${PD_URL}/?action=${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token(session)}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `podiumopsPost ${action} failed (${res.status})`);
  return data.data;
}
