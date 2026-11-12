// Calls a LOT worker AS THE PERSON (their own Supabase JWT) over a service binding.
// Workers.dev blocks worker→worker fetch (1042), so every target is a [[services]] binding.
// Every call carries X-LOT-Source: connector — docketops stamps task_history.source from it (Docket F9 §8.3:
// a connector update counts as a qualifying update but is shown as such); other workers ignore it.
// Result: { ok:true, data } | { ok:false, reason } (a refusalText key) | { ok:false, userError } (the
// worker rejected the request itself, e.g. a bad parameter: shown to Claude, not a refusal).

const MAX_ERR = 300;
const SERVER_FAIL = /^(db_error|server_error|update_failed|create_failed|comment_failed|insert_failed|delete_failed)\b/i;

export async function getAs(binding, sbAccess, action, params = {}) {
  const u = new URL('https://worker/');
  const q = new URLSearchParams({ action });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  u.search = q.toString();
  return callAs(binding, u.toString(), { headers: { Authorization: `Bearer ${sbAccess}`, 'X-LOT-Source': 'connector' } });
}

// A write, as the person: POST { action, data } (LOT workers route POSTs by body.action and read
// body.data || body). Only Docket write tools call this, each with one fixed action.
export async function postAs(binding, sbAccess, action, data = {}) {
  return callAs(binding, 'https://worker/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sbAccess}`, 'Content-Type': 'application/json', 'X-LOT-Source': 'connector' },
    body: JSON.stringify({ action, data }),
  });
}

async function callAs(binding, url, init) {
  if (!binding || typeof binding.fetch !== 'function') return { ok: false, reason: 'unreachable' };
  let res;
  try { res = await binding.fetch(url, init); }
  catch { return { ok: false, reason: 'unreachable' }; }
  // 401: dead session OR a transient identity lookup in the worker; 403: the worker's own permission check.
  if (res.status === 401) return { ok: false, reason: 'session expired' };
  if (res.status === 403) return { ok: false, reason: 'worker denied' };
  const j = await res.json().catch(() => null);
  if (res.status >= 400 && res.status < 500 && j && typeof j.error === 'string') {
    // Worker-side failures that come back as 4xx (docketops: `update_failed: {db json}`) are faults, and their
    // DB diagnostics never reach Claude (Codex 2026-11-09). Only plain request errors are shown.
    if (SERVER_FAIL.test(j.error) || /[{}]/.test(j.error)) return { ok: false, reason: 'unreachable', serverFail: true };
    // Docket F7: done on a task still waiting on open tasks. Name the blockers (docketops already masked any
    // the person can't open) and say how to override.
    if (j.error === 'waiting_on') {
      const list = (Array.isArray(j.blockers) ? j.blockers : []).slice(0, 5)
        .map(b => `${b.task_no} ${String(b.title || '').slice(0, 60)}`).join('; ');
      const more = Number(j.hidden_open) > 0 ? ` (+${Number(j.hidden_open)} you can't see)` : '';
      return { ok: false, userError: `waiting_on: still waiting on ${list || 'open tasks'}${more}. Call again with force: true to mark it done anyway.`.slice(0, MAX_ERR) };
    }
    return { ok: false, userError: j.error.slice(0, MAX_ERR) };
  }
  if (!res.ok || !j || j.ok !== true || j.data === undefined || j.data === null) return { ok: false, reason: 'unreachable' };
  return { ok: true, data: j.data };
}

// Keep tool output readable and bounded: long arrays are cut (with a note), then cut harder until the
// whole payload fits. Never silently: `truncated` lists what was cut.
export function capPayload(data, { maxBytes = 90_000 } = {}) {
  for (const maxRows of [300, 100, 40, 15]) {
    const cut = [];
    const walk = (v, path) => {
      if (Array.isArray(v)) {
        const keep = v.length > maxRows ? v.slice(0, maxRows) : v;
        if (v.length > maxRows) cut.push(`${path || 'rows'}: showing ${maxRows} of ${v.length}`);
        return keep.map((x, i) => walk(x, `${path}[${i}]`));
      }
      if (v && typeof v === 'object') {
        const o = {};
        for (const [k, x] of Object.entries(v)) o[k] = walk(x, path ? `${path}.${k}` : k);
        return o;
      }
      return v;
    };
    const out = walk(data, '');
    const text = JSON.stringify(out);
    if (new TextEncoder().encode(text).length <= maxBytes) return { data: out, truncated: cut.map(s => s.replace(/\[\d+\]/g, '[]')).filter((s, i, a) => a.indexOf(s) === i) };
  }
  return { data: null, truncated: ['the result was too large to return; narrow the date range or add filters'] };
}

// Strips credentials and personal addresses out of tool output before Claude sees it.
//  - signed links (Supabase storage /object/sign/, any URL with token=/signature params): a signed URL
//    is a bearer credential to a private file (Codex 2026-11-09: Dyno boards carry 1h creative links);
//  - email addresses, when `emails` (Odo: connector errors can carry a mailbox address).
const SIGNED = /https?:\/\/[^\s"'<>]*(?:\/object\/sign\/|[?&](?:token|sig|signature|X-Amz-Signature|X-Goog-Signature|Signature)=)[^\s"'<>]*/gi;
const UUIDV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// dropKeys: fields removed wherever they appear (raw third-party payloads: prompt-injection surface).
export function scrub(v, opts = {}) {
  const { emails = false, dropKeys = [], dropMatch = null, dropIds = false } = opts;
  if (typeof v === 'string') {
    let t = v.replace(SIGNED, '[signed link removed]');
    if (emails) t = t.replace(EMAIL, '[email removed]');
    return t;
  }
  if (Array.isArray(v)) return v.map(x => scrub(x, opts));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (dropKeys.includes(k) || (dropMatch && dropMatch.test(k))) continue;
      // dropIds: a `*_by` / `*_user_id` field holding a uuid is a LOT user id (the *_name beside it stays).
      if (dropIds && /(_by|_user_id)$/i.test(k) && typeof x === 'string' && UUIDV.test(x)) continue;
      o[k] = scrub(x, opts);
    }
    return o;
  }
  return v;
}
