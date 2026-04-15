const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL;

export async function workerFetch(action, body = {}, sessionOrToken) {
  // Accept either a Supabase session object or a raw access_token string.
  const token = typeof sessionOrToken === 'string'
    ? sessionOrToken
    : sessionOrToken?.access_token;
  const res = await fetch(`${WORKER_URL}/?action=${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Worker request failed');
  return data;
}
