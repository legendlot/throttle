import { supabase } from './supabase.js';

export async function workerFetch(action, body = {}, _sessionOrToken, workerUrl) {
  // Always fetch the current session from supabase directly — guarantees
  // a fresh token regardless of React state, and avoids re-render cascades
  // from passing session as a prop. _sessionOrToken is kept for call-site
  // compatibility but ignored.
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

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
