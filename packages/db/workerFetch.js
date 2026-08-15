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
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!res.ok) {
    // Carry the FULL error body on the Error, not just its message. Some refusals are only
    // actionable with their numbers — `audience_exceeds_budget` has to tell the sender how many
    // recipients it wanted against how much budget is left, and a bare message string throws that
    // away, leaving the caller to either guess or re-request it. Purely additive: `e.message` is
    // unchanged, so every existing `catch (e) { showToast(e.message) }` behaves exactly as before.
    const e = new Error(data.error || 'Worker request failed');
    e.detail = data;
    e.status = res.status;
    throw e;
  }
  return data;
}
