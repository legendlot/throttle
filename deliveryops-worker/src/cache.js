// Supabase PostgREST cache. service-role key sent as BOTH apikey and Authorization (repo convention).
function headers(env, extra = {}) {
  return { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

export async function cacheGet(env, { pincode, cod }, { fetchImpl = globalThis.fetch, now = new Date(), ttlMs }) {
  const q = `?pincode=eq.${encodeURIComponent(pincode)}&cod=eq.${cod ? 'true' : 'false'}&limit=1`;
  let rows;
  try {
    const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/delivery_edd_cache${q}`, { headers: headers(env) });
    if (!res.ok) return null;
    rows = await res.json();
  } catch { return null; }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  if (now.getTime() - Date.parse(row.fetched_at) > ttlMs) return null;
  return row;
}

export async function cachePut(env, row, { fetchImpl = globalThis.fetch } = {}) {
  const body = { ...row, fetched_at: new Date().toISOString() };
  try {
    await fetchImpl(`${env.SUPABASE_URL}/rest/v1/delivery_edd_cache`, {
      method: 'POST',
      headers: headers(env, { Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify(body),
    });
  } catch { /* cache write is best-effort; never block the response */ }
}
