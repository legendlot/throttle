export async function workerFetch(action, body = {}, sessionOrToken, workerUrl) {
  const token = typeof sessionOrToken === 'string'
    ? sessionOrToken
    : sessionOrToken?.access_token;
  const url = workerUrl || process.env.NEXT_PUBLIC_WORKER_URL;
  const res = await fetch(`${url}/?action=${action}`, {
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
