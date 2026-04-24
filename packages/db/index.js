export { supabase, supabaseBrand } from './supabase.js';
export { workerFetch } from './workerFetch.js';
export { sbFetch } from './sbFetch.js';

export async function garageFetch(action, params = {}, sessionOrToken) {
  const token = typeof sessionOrToken === 'string'
    ? sessionOrToken
    : sessionOrToken?.access_token;
  const base = process.env.NEXT_PUBLIC_WORKER_URL;
  const url  = new URL(base);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  });
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Worker ${res.status}`);
  }
  const body = await res.json();
  return body.data !== undefined ? body.data : body;
}
