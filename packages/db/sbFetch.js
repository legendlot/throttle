export async function sbFetch(action, params, token, method = 'GET') {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${token || anonKey}`,
    'Content-Type': 'application/json',
  };

  if (action.startsWith('store/') || action.startsWith('rpc/store_')) {
    headers['Accept-Profile']  = 'store';
    headers['Content-Profile'] = 'store';
  }

  let url = `${supabaseUrl}/rest/v1/${action}`;
  let init = { method, headers };

  if (method === 'GET' && params && Object.keys(params).length) {
    const qs = new URLSearchParams(params).toString();
    url += `?${qs}`;
  } else if (method !== 'GET' && params) {
    init.body = JSON.stringify(params);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sbFetch ${action} failed: ${res.status} ${text}`);
  }
  return res.json();
}
