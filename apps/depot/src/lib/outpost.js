// Depot → outpostops (the Outpost worker). The LOT owner side: the Supabase session JWT goes as the Bearer token and the
// worker requires `outpost_owner` on the caller's role. GET carries ?action=, POST carries { action } in the body.
export const OUTPOSTOPS_URL = process.env.NEXT_PUBLIC_OUTPOSTOPS_URL || 'https://outpostops.afshaan.workers.dev';

const WORDS = {
  forbidden: 'You need the Outpost owner permission for this.',
  not_configured: 'The Outpost worker is not configured yet (its database key is missing).',
  read_failed: 'Outpost could not read that. Try again.',
  write_failed: 'Outpost could not save that. Try again.',
  revoke_failed: 'Saved, but the live sessions could not be ended. Try again.',
  try_again: 'Someone else was saving this consignment at the same moment. Try again.',
};

async function send(method, action, params, session) {
  const token = typeof session === 'string' ? session : session?.access_token;
  const url = new URL(OUTPOSTOPS_URL);
  let body;
  if (method === 'GET') {
    url.searchParams.set('action', action);
    for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  } else {
    body = JSON.stringify({ ...params, action });
  }
  let res;
  try {
    res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) } });
  } catch {
    throw Object.assign(new Error('Could not reach Outpost. Check the connection and try again.'), { code: 'offline' });
  }
  const out = await res.json().catch(() => null);
  if (!res.ok || !out?.ok) {
    const code = out?.error || `http_${res.status}`;
    throw Object.assign(new Error(WORDS[code] || code), { code, status: res.status });
  }
  return out.data;
}

export const opGet = (action, params, session) => send('GET', action, params, session);
export const opPost = (action, body, session) => send('POST', action, body, session);

// The vendor the Outpost pages are looking at, remembered per browser.
const VKEY = 'depot.outpost.vendor';
export const rememberVendor = id => { try { localStorage.setItem(VKEY, String(id)); } catch { /* private mode */ } };
export const rememberedVendor = () => { try { return Number(localStorage.getItem(VKEY)) || null; } catch { return null; } };

export const fmtIST = ts => (ts ? new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit' }) : '—');
