/**
 * docketopsFetch — thin client for the docketops Cloudflare Worker.
 * Mirrors podiumopsFetch; pointed at NEXT_PUBLIC_DOCKETOPS_URL.
 *
 * GET reads:  docketopsGet(action, params, session)  → unwrapped data
 * POST writes: docketopsPost(action, body, session)  → unwrapped data
 */

function token(session) {
  return typeof session === 'string' ? session : session?.access_token;
}

const DK_URL = process.env.NEXT_PUBLIC_DOCKETOPS_URL || 'https://docketops.afshaan.workers.dev';

export async function docketopsGet(action, params = {}, session) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') clean[k] = v;
  const qs = new URLSearchParams({ action, ...clean }).toString();
  const res = await fetch(`${DK_URL}/?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token(session)}` },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `docketopsGet ${action} failed (${res.status})`);
  return data.data;
}

export async function docketopsPost(action, body = {}, session) {
  const res = await fetch(`${DK_URL}/?action=${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token(session)}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `docketopsPost ${action} failed (${res.status})`);
  return data.data;
}
