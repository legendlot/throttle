// ── Exotel REST client ───────────────────────────────────────────────────────
//
// Thin, dependency-free client for Exotel Voice v1. Everything that talks to Exotel
// goes through here so auth, the .json trap, the IST trap and the rate budget are
// solved once.
//
// Auth is HTTP Basic with the dashboard key/token pair:
//   https://<key>:<token>@api.in.exotel.com/v1/Accounts/<sid>/...
// Both are worker secrets (EXOTEL_API_KEY / EXOTEL_API_TOKEN). The account SID and
// subdomain are NOT secret and default in code, overridable by env.

export const EXOTEL_DEFAULTS = {
  accountSid: 'legendoftoys1m',
  subdomain:  'api.in.exotel.com',   // Mumbai region — see the account's API Credentials page
};

// Exotel publishes 200 requests/minute per account. Ours is a shared budget across
// the poller, click-to-call and any admin action, so we stay well under it and back
// off rather than retrying blind on a 429.
const RATE_LIMIT_PER_MIN = 200;

export function exotelConfigured(env) {
  return Boolean(env.EXOTEL_API_KEY && env.EXOTEL_API_TOKEN);
}

/**
 * ⚠️ IST, not UTC. Exotel's DateCreated filter takes a NAIVE datetime
 * ('2026-08-20 14:30:00') which an Indian account interprets in IST. Building the
 * window in UTC would silently query a 5h30m-displaced slice of the day — the poller
 * would look like it was working and quietly miss every call.
 * India has no DST, so a fixed +05:30 is correct and needs no timezone database.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function toIstNaive(date) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse a naive Exotel timestamp (IST wall clock) into a real instant.
 * Returns null rather than an Invalid Date so a bad value cannot poison a DB write.
 */
export function fromIstNaive(s) {
  if (!s) return null;
  const str = String(s).trim();
  // Already carries an offset or Z — trust it.
  if (/[+-]\d{2}:?\d{2}$/.test(str) || /Z$/.test(str)) {
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(str.replace(' ', 'T') + '+05:30');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function makeExotelClient(env) {
  const key   = env.EXOTEL_API_KEY;
  const token = env.EXOTEL_API_TOKEN;
  const sid   = env.EXOTEL_ACCOUNT_SID || EXOTEL_DEFAULTS.accountSid;
  const host  = env.EXOTEL_SUBDOMAIN   || EXOTEL_DEFAULTS.subdomain;

  let spent = 0;   // requests made by this client instance (one cron tick / one request)

  /**
   * ⚠️ The `.json` suffix is REQUIRED. Exotel v1 returns **XML** without it, so the
   * JSON parse fails and the poller silently records nothing. This is not a style
   * choice — it is the difference between working and appearing to work.
   */
  async function call(path, { method = 'GET', query = {}, body = null } = {}) {
    if (spent >= RATE_LIMIT_PER_MIN) {
      return { ok: false, status: 429, data: null, error: 'local rate budget exhausted' };
    }
    spent++;

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const url = `https://${host}/v1/Accounts/${encodeURIComponent(sid)}/${path}.json`
      + (qs.toString() ? `?${qs}` : '');

    // Basic auth in the header rather than the URL: credentials in a URL leak into
    // any log line that records the request.
    const headers = { Authorization: 'Basic ' + btoa(`${key}:${token}`) };
    let init = { method, headers };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      // ⚠️ Array values must be REPEATED keys, not stringified. StatusCallbackEvents
      // is an array, and `new URLSearchParams({k:[a,b]})` yields `k=a%2Cb` — a single
      // comma-joined value Exotel does not recognise, so we would subscribe to nothing
      // and silently never receive a status callback.
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach(item => form.append(k, String(item)));
        else form.append(k, String(v));
      }
      init.body = form.toString();
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      console.error('[exotel] network error', path, e?.message || String(e));
      return { ok: false, status: 0, data: null, error: 'network' };
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch {
      // Almost always the missing `.json` or an HTML error page. Log the opening
      // bytes — enough to identify it, short enough not to dump a credential-bearing
      // body into the tail.
      console.error(`[exotel] non-JSON response ${res.status} ${path}: ${text.slice(0, 120)}`);
      return { ok: false, status: res.status, data: null, error: 'non-json' };
    }

    if (!res.ok) {
      // Exotel wraps errors as { RestException: { Status, Message } }.
      const rex = data?.RestException;
      console.error(`[exotel] ${res.status} ${path} ${rex ? `${rex.Status}: ${rex.Message}` : JSON.stringify(data).slice(0, 200)}`);
      return { ok: false, status: res.status, data, error: rex?.Message || `http ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  }

  /**
   * List calls. Returns { ok, calls, nextCursor }.
   *
   * ⚠️ Paging is cursor-based (`After` from Metadata.NextPageUri) and sorted ASC on
   * DateCreated. Do not page by offset: a non-unique sort silently drops and repeats
   * rows across page boundaries (CORE.md), and new calls arriving mid-walk shift an
   * offset window under us.
   */
  async function listCalls({ fromDate, toDate, pageSize = 100, after = null, sortAsc = true, details = false } = {}) {
    const query = { PageSize: Math.min(pageSize, 100) };
    if (fromDate && toDate) {
      query.DateCreated = `gte:${toIstNaive(fromDate)};lte:${toIstNaive(toDate)}`;
    }
    if (sortAsc) query.SortBy = 'DateCreated:asc';
    if (after) query.After = after;
    if (details) query.details = 'true';

    const r = await call('Calls', { query });
    if (!r.ok) return { ok: false, calls: [], nextCursor: null, error: r.error, status: r.status };
    return { ok: true, calls: unwrapCalls(r.data), nextCursor: nextCursorOf(r.data) };
  }

  /**
   * Fetch specific calls by SID — up to 100 per request, comma separated.
   * This is the settlement path: Exotel finalises Duration, Price, EndTime and the
   * recording ~2 minutes AFTER a call ends, so rows land incomplete and are topped up
   * here. Batched, never a per-row loop (CORE.md global invariant).
   *
   * `RecordingUrlValidity` asks for a pre-signed recording URL. We request the max so
   * a URL captured now is usable for a while — but it still EXPIRES, so the player
   * must re-resolve on demand and must never treat a stored URL as permanent.
   */
  async function getCallsBySid(sids, { recordingValidityMinutes = 60 } = {}) {
    const list = [...new Set((sids || []).filter(Boolean))].slice(0, 100);
    if (!list.length) return { ok: true, calls: [] };
    const r = await call('Calls', {
      query: {
        Sid: list.join(','),
        PageSize: 100,
        details: 'true',
        RecordingUrlValidity: recordingValidityMinutes,
      },
    });
    if (!r.ok) return { ok: false, calls: [], error: r.error, status: r.status };
    return { ok: true, calls: unwrapCalls(r.data) };
  }

  /**
   * Click-to-call. Rings `from` (the agent — an E.164 number OR a SIP URI) first, then
   * dials `to` (the customer) and bridges them, presenting the ExoPhone as caller ID.
   *
   * ⚠️ CustomField is capped at 128 characters by Exotel. It is what makes outbound
   * attribution exact BY CONSTRUCTION rather than inferred from a leg, so it must
   * never be silently truncated into garbage — the caller enforces the limit.
   */
  async function connect({ from, to, callerId, customField, statusCallback, timeLimit, timeout }) {
    return call('Calls/connect', {
      method: 'POST',
      body: {
        From: from,
        To: to,
        CallerId: callerId,
        CallType: 'trans',
        Record: 'true',
        CustomField: customField,
        StatusCallback: statusCallback,
        StatusCallbackEvents: statusCallback ? ['terminal', 'answered'] : undefined,
        StatusCallbackContentType: statusCallback ? 'application/json' : undefined,
        TimeLimit: timeLimit,
        TimeOut: timeout,
      },
    });
  }

  return { call, connect, listCalls, getCallsBySid, spent: () => spent, accountSid: sid, host };
}

// Exotel returns a single call as { Call: {...} } and a list as { Calls: [...] }.
// Tolerate both plus a bare array, because getting this wrong yields "0 calls" rather
// than an error — the quietest possible failure.
export function unwrapCalls(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.Calls)) return data.Calls;
  if (data.Call) return [data.Call];
  return [];
}

export function nextCursorOf(data) {
  const uri = data?.Metadata?.NextPageUri || data?.Metadata?.next_page_uri || null;
  if (!uri) return null;
  try {
    const q = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : uri;
    return new URLSearchParams(q).get('After');
  } catch { return null; }
}
