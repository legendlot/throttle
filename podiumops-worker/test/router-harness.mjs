// Shared harness: drive a request through the REAL worker router (verifyJWT → canonicalisation → handler) with a
// mocked fetch. Auth lookups are answered from `who`; every other Supabase call goes to `route(path, opts)` and is
// recorded. route may return { status, body }, a Promise of one, or { reject: 'message', delay } for a network error.
import worker from '../src/index.js';

export const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
// Alphabetic-heavy synthetic uuids, so a case change really changes the string.
export const ME = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
export const OTHER = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
export const UID = 'cafebabe-dead-4bee-8fee-facefacefeed';
export const who = {
  view: { uid: UID, role: 'user', perms: { podium_view: true } },
  self: { uid: UID, role: 'user', perms: {} },
  hr: { uid: UID, role: 'user', perms: { podium_view: true, podium_hr: true } },
  cal: { uid: UID, role: 'super_admin', perms: { podium_view: true } },
  comp: { uid: UID, role: 'user', perms: { podium_view: true }, comp: true },
};
export const EDGE_ME = { id: ME, manager_id: null, auth_user_id: UID };
export const isEdges = (p) => p.startsWith('/rest/v1/employees?select=id,manager_id,auth_user_id');

const J = (b, status = 200) => new Response(JSON.stringify(b), { status });
const AUTH_PATHS = ['/rest/v1/users_profile', '/rest/v1/podium_user_roles', '/rest/v1/podium_roles', '/rest/v1/comp_access'];

export async function call(method, action, { query = {}, body = {}, as = who.view, route = () => ({ body: [] }) } = {}) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (u, o = {}) => {
    const path = String(u).replace(ENV.SUPABASE_URL, '');
    if (path.startsWith('/auth/v1/user')) return J({ id: as.uid, email: 'test@example.com' });
    if (path.startsWith(AUTH_PATHS[0])) return J([{ role: as.role, full_name: 'Test', active: true }]);
    if (path.startsWith(AUTH_PATHS[1])) return J(Object.keys(as.perms).length ? [{ role_key: 'r' }] : []);
    if (path.startsWith(AUTH_PATHS[2])) return J([{ permissions: as.perms }]);
    if (path.startsWith(AUTH_PATHS[3])) return J(as.comp ? [{ auth_user_id: as.uid }] : []);
    calls.push({ path, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : null });
    const r = await route(path, o);
    if (r && r.reject) {
      if (r.delay) await new Promise(res => setTimeout(res, r.delay));
      throw new Error(r.reject);
    }
    return J(r?.body ?? [], r?.status ?? 200);
  };
  try {
    let req;
    if (method === 'GET') {
      const url = new URL('https://w/');
      url.searchParams.set('action', action);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      req = new Request(url, { headers: { Authorization: 'Bearer t' } });
    } else {
      req = new Request('https://w/', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body }) });
    }
    const res = await worker.fetch(req, ENV, { waitUntil() {} });
    return { res, body: await res.json(), calls };
  } finally { globalThis.fetch = real; }
}

// Barrier: a request matching `a` and one matching `b` each hold their response until the OTHER has started (or
// `ms` passes). overlap = one started while the other was still pending. Serial code (await a, THEN start b) can only
// get through via the timeout, and never overlaps.
export function barrier(a, b, base = () => ({ body: [] }), ms = 60) {
  const st = { overlap: false, pending: { a: 0, b: 0 } };
  const rel = {}; const go = { a: new Promise(r => { rel.a = r; }), b: new Promise(r => { rel.b = r; }) };
  st.route = async (p, o) => {
    const k = a(p) ? 'a' : b(p) ? 'b' : null;
    if (k) {
      const other = k === 'a' ? 'b' : 'a';
      if (st.pending[other] > 0) st.overlap = true;
      st.pending[k]++; rel[k]();
      await Promise.race([go[other], new Promise(r => setTimeout(r, ms))]);
      st.pending[k]--;
    }
    return base(p, o);
  };
  return st;
}
