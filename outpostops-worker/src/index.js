// ============================================================
// OUTPOSTOPS — Outpost vendor production system worker
// ------------------------------------------------------------
// The ONLY client of the `outpost` schema. Two kinds of caller, never mixed:
//   • Vendor benches / print agents / the supervisor dashboard → /v/* and /d/*, authenticated by
//     Outpost's own credentials (device key + operator PIN session, or a dashboard session). They
//     never hold a Supabase key and have no Supabase Auth identity (OUTPOST_PLAN §3.1).
//   • LOT owners from Depot → /?action=…, Supabase JWT + `outpost_owner` permission
//     (store.roles), the same gate shape as manifestops/lotopsproxy verifyJWT.
// Vendor identity always comes from the verified credential, never from the request body.
// Every guard FAILS CLOSED: an unreadable kill switch, config or session refuses the request.
// ============================================================

import {
  canonicalString, clockOk, codeHash, CODE_DIGITS, CODE_TTL_HOURS, corsHeaders, FLOOR_IDLE_MINS,
  FLOOR_MAX_HOURS, hashPin, importVerifyKey, isDigits, jwkThumbprint, killVerdict, mintDigits,
  mintToken, nextOpCode, nonceOk, normaliseJwk, PIN_DIGITS, sessionLive, sha256Hex, STEPUP_PURPOSES,
  STEPUP_SECONDS, tokenHash, verifyPin, verifySignature, ipBucket,
} from './auth.js';

const SUPABASE_URL = 'https://jkxcnjabmrkteanzoofj.supabase.co';
const SUPABASE_PUBLISHABLE = 'sb_publishable_1Dd-r3h9Mou2Wqgn6t24Dw_lmWdBtLh'; // auth verify only
const MAX_BODY_BYTES = 65_536;
const CACHE_MS = 30_000;                 // kill switches + device rows: revocation lands within 30 s

let ENV = {};

// ── DB ──────────────────────────────────────────────────────────────────────
async function sbReq(path, profile, opts = {}) {
  const key = ENV.SUPABASE_SERVICE_KEY;
  const headers = {
    'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}`,
    'Accept-Profile': profile, 'Content-Profile': profile,
    ...(opts.prefer ? { Prefer: opts.prefer } : {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { method: opts.method || 'GET', headers, body: opts.body });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data, range: res.headers.get('content-range') };
}
const op   = (path, opts) => sbReq(path, 'outpost', opts);
const st   = (path, opts) => sbReq(path, 'store', opts);
const q    = s => encodeURIComponent(s);
const rpc  = (fn, args) => op(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const ins  = (table, row, prefer = 'return=representation') =>
  op(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(row), prefer });
const patch = (table, filter, body) =>
  op(`/rest/v1/${table}?${filter}`, { method: 'PATCH', body: JSON.stringify(body), prefer: 'return=representation' });

async function logEvent(vendorId, actorKind, actorId, action, detail) {
  const r = await ins('events', { vendor_id: vendorId ?? null, actor_kind: actorKind,
    actor_id: actorId == null ? null : String(actorId), action, detail: detail || null }, 'return=minimal');
  if (!r.ok) console.warn('outpost event log failed', action, r.status);
}

// ── responses ───────────────────────────────────────────────────────────────
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});
const ok   = data => json({ ok: true, data });
const fail = (error, status = 400, extra = {}) => json({ ok: false, error, ...extra }, status);

// ── caches (per isolate) ────────────────────────────────────────────────────
const cache = { kill: null, vendor: new Map(), device: new Map() };

async function killAllValue() {
  if (cache.kill && Date.now() - cache.kill.at < CACHE_MS) return cache.kill.value;
  const r = await op(`/rest/v1/settings?key=eq.kill_all&select=value`);
  const value = r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0].value : null;   // null → refuses
  if (value !== null) cache.kill = { value, at: Date.now() };
  return value;
}

async function vendorCfg(vendorId) {
  const hit = cache.vendor.get(vendorId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cfg;
  const r = await op(`/rest/v1/vendor_config?vendor_id=eq.${Number(vendorId)}&select=vendor_id,active,killed`);
  if (!r.ok || !Array.isArray(r.data)) return undefined;
  const cfg = r.data[0];
  cache.vendor.set(vendorId, { cfg, at: Date.now() });
  return cfg;
}

async function deviceRow(deviceId) {
  const hit = cache.device.get(deviceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const r = await op(`/rest/v1/devices?id=eq.${deviceId}&select=id,vendor_id,kind,bench_no,label,public_key_jwk,status,last_seen_at`);
  if (!r.ok || !Array.isArray(r.data)) return null;
  const row = r.data[0];
  if (!row) {                                  // cached too: random ids must not each cost a read
    const miss = { row: null, at: Date.now() };
    cache.device.set(deviceId, miss);
    return miss;
  }
  const key = await importVerifyKey(row.public_key_jwk);
  const entry = { row, key, at: Date.now() };
  cache.device.set(deviceId, entry);
  return entry;
}

async function killCheck(vendorId) {
  const [killAll, cfg] = await Promise.all([killAllValue(), vendorCfg(vendorId)]);
  return killVerdict({ killAll, cfg });
}

// ── unauthenticated code redemption: attempt limiter ────────────────────────
// outpost.code_attempt writes the attempt row FIRST and then counts (one transaction), so a parallel
// burst cannot all slip under the limit: 20 per IP bucket (IPv6 per /64) and 200 across all callers,
// per 15 min. A successful redemption deletes its own row, so only failures accumulate.
// Returns { attemptId } when allowed, { res } when refused. Unreadable → refused.
async function codeAttempt(kind, ip) {
  const r = await rpc('code_attempt', { p_kind: kind, p_bucket: ipBucket(ip) });
  if (!r.ok || !r.data) return { res: fail('outpost_unavailable', 503) };
  if (!r.data.ok) return { res: fail('too_many_attempts', 429) };
  return { attemptId: r.data.attempt_id };
}
const clearAttempt = id => op(`/rest/v1/auth_failures?id=eq.${Number(id)}`, { method: 'DELETE' });

// ── vendor request authentication ───────────────────────────────────────────
// Returns { ctx } or { res } (a refusal). `needSession` = an operator floor session is required.
async function authDevice(request, url, rawBody, { needSession }) {
  const deviceId = Number(request.headers.get('X-Outpost-Device'));
  const ts = request.headers.get('X-Outpost-Ts');
  const nonce = request.headers.get('X-Outpost-Nonce');
  const sig = request.headers.get('X-Outpost-Sig');
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0 || !ts || !nonceOk(nonce) || !sig) {
    return { res: fail('unsigned', 401) };
  }
  if (!clockOk(ts)) return { res: fail('clock', 401, { server_time: Date.now() }) };

  const dev = await deviceRow(deviceId);
  if (!dev) return { res: fail('outpost_unavailable', 503) };
  if (!dev.row || dev.row.status !== 'active') return { res: fail('device_not_enrolled', 401) };

  const canonical = canonicalString({ method: request.method, path: url.pathname + url.search, ts, nonce,
    bodyHash: await sha256Hex(rawBody) });          // the raw bytes, not a decoded string
  if (!(await verifySignature(dev.key, sig, canonical))) return { res: fail('bad_signature', 401) };

  // Replay: the nonce is recorded only AFTER the signature verifies, so a stranger cannot fill the
  // table. A duplicate (device, nonce) is a 409 from the primary key.
  const n = await ins('used_nonces', { device_id: deviceId, nonce }, 'return=minimal');
  if (!n.ok) return { res: n.status === 409 ? fail('replay', 401) : fail('outpost_unavailable', 503) };

  const vendorId = Number(dev.row.vendor_id);
  const killed = await killCheck(vendorId);
  if (killed) return { res: fail(killed, 403) };

  if (!dev.row.last_seen_at || Date.now() - Date.parse(dev.row.last_seen_at) > 60_000) {
    dev.row.last_seen_at = new Date().toISOString();
    await patch('devices', `id=eq.${deviceId}`, { last_seen_at: dev.row.last_seen_at });   // best effort
  }

  const ctx = { vendorId, deviceId, deviceKind: dev.row.kind, benchNo: dev.row.bench_no,
                deviceLabel: dev.row.label, operator: null, sessionId: null };
  const token = request.headers.get('X-Outpost-Session');
  if (token) {
    const s = await loadSession(token, 'floor');
    if (s === undefined) return { res: fail('outpost_unavailable', 503) };
    if (s && Number(s.device_id) === deviceId && Number(s.vendor_id) === vendorId) {
      ctx.operator = s.operators; ctx.sessionId = s.id;
    }
  }
  if (needSession && !ctx.operator) return { res: fail('login_required', 401) };
  return { ctx };
}

// undefined = could not read (caller refuses); null = no live session.
async function loadSession(token, kind) {
  const th = await tokenHash(token);
  const r = await op(`/rest/v1/sessions?token_hash=eq.${th}&kind=eq.${kind}` +
    `&select=id,kind,vendor_id,operator_id,device_id,expires_at,last_seen_at,idle_mins,used_at,revoked_at,` +
    `operators(id,op_code,name,role,active)`);
  if (!r.ok || !Array.isArray(r.data)) return undefined;
  const s = r.data[0];
  if (!s || !sessionLive(s) || !s.operators || !s.operators.active) return null;
  if (Date.now() - Date.parse(s.last_seen_at) > 60_000) {
    await patch('sessions', `id=eq.${s.id}`, { last_seen_at: new Date().toISOString() });
  }
  return s;
}

// Returns true when the revoke landed. Callers refuse (502) when it did not — "PIN reset" or "logged
// out" must never be reported while the old session is still live.
async function revokeSessions(filter, reason) {
  const r = await patch('sessions', `${filter}&revoked_at=is.null`, { revoked_at: new Date().toISOString(), revoke_reason: reason });
  if (!r.ok) console.error('outpost revokeSessions failed', reason, r.status);
  return r.ok;
}

// ── operator PIN check (shared by floor login + step-up) ────────────────────
const DUMMY_PIN_HASH = 'pbkdf2_sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
async function checkPin(ctx, opCode, pin) {
  if (!isDigits(opCode, 3) || !isDigits(pin, PIN_DIGITS)) return { err: fail('bad_credentials', 401) };
  const o = await op(`/rest/v1/operators?vendor_id=eq.${ctx.vendorId}&op_code=eq.${opCode}` +
    `&select=id,op_code,name,role,active,pin_hash`);
  if (!o.ok) return { err: fail('outpost_unavailable', 503) };
  const row = o.data[0] || null;
  const begin = await rpc('pin_attempt_begin', { p_device_id: ctx.deviceId, p_operator_id: row ? row.id : null });
  if (!begin.ok) return { err: fail('outpost_unavailable', 503) };
  const b = begin.data || {};
  if (!b.ok) {
    if (b.reason === 'operator_locked' || b.reason === 'device_locked') {
      return { err: fail('locked', 423, { until: b.until, scope: b.reason === 'device_locked' ? 'device' : 'operator' }) };
    }
    return { err: fail('bad_credentials', 401) };
  }
  // pin_attempt_begin already refuses a missing / inactive / other-vendor operator; checked again here
  // so the worker never relies on that alone.
  if (!row || row.active !== true) {
    await verifyPin(pin, ENV.OUTPOST_PEPPER, DUMMY_PIN_HASH);    // same cost as a real check: no op-code oracle
    return { err: fail('bad_credentials', 401) };
  }
  if (!(await verifyPin(pin, ENV.OUTPOST_PEPPER, row.pin_hash))) return { err: fail('bad_credentials', 401) };
  const s = await rpc('pin_attempt_success', { p_device_id: ctx.deviceId, p_operator_id: row.id });
  if (!s.ok) console.warn('pin_attempt_success failed', s.status);
  return { operator: row };
}

// ── vendor routes (/v/*) ────────────────────────────────────────────────────
async function vendorRoute(request, url, rawBody, ip) {
  const route = url.pathname.slice(3);       // after '/v/'
  const body = parseBody(rawBody);
  if (body === undefined) return fail('bad_json');

  if (route === 'enrol' && request.method === 'POST') return enrol(body, ip);

  const needSession = !['login', 'me'].includes(route);
  const a = await authDevice(request, url, rawBody, { needSession });
  if (a.res) return a.res;
  const ctx = a.ctx;

  if (route === 'me' && request.method === 'GET') {
    const v = await st(`/rest/v1/vendors?id=eq.${ctx.vendorId}&select=vendor_name`);
    return ok({ vendor_id: ctx.vendorId, vendor_name: v.ok && v.data[0] ? v.data[0].vendor_name : null,
      device: { id: ctx.deviceId, kind: ctx.deviceKind, bench_no: ctx.benchNo, label: ctx.deviceLabel },
      operator: ctx.operator ? { id: ctx.operator.id, op_code: ctx.operator.op_code, name: ctx.operator.name,
        role: ctx.operator.role } : null });
  }

  if (route === 'login' && request.method === 'POST') {
    if (ctx.deviceKind !== 'bench') return fail('not_a_bench', 403);
    const c = await checkPin(ctx, body.op_code, body.pin);
    if (c.err) return c.err;
    // One operator per bench: a new login ends whatever floor session AND unspent step-up the bench had
    // (a unique index backs this: two simultaneous logins → the second insert 409s).
    if (!(await revokeSessions(`device_id=eq.${ctx.deviceId}&kind=in.(floor,stepup)`, 'replaced'))) return fail('revoke_failed', 502);
    const token = mintToken();
    const s = await ins('sessions', { token_hash: await tokenHash(token), kind: 'floor', vendor_id: ctx.vendorId,
      operator_id: c.operator.id, device_id: ctx.deviceId, idle_mins: FLOOR_IDLE_MINS,
      expires_at: new Date(Date.now() + FLOOR_MAX_HOURS * 3_600_000).toISOString() });
    if (!s.ok) return s.status === 409 ? fail('try_again', 409) : fail('outpost_unavailable', 503);
    await logEvent(ctx.vendorId, 'operator', c.operator.id, 'floor_login', { device_id: ctx.deviceId });
    return ok({ session: token, idle_mins: FLOOR_IDLE_MINS, expires_at: s.data[0].expires_at,
      operator: { id: c.operator.id, op_code: c.operator.op_code, name: c.operator.name, role: c.operator.role } });
  }

  if (route === 'logout' && request.method === 'POST') {
    if (!(await revokeSessions(`device_id=eq.${ctx.deviceId}&kind=in.(floor,stepup)`, 'logout'))) return fail('revoke_failed', 502);
    return ok({ logged_out: true });
  }

  if (route === 'stepup' && request.method === 'POST') {
    if (!STEPUP_PURPOSES.includes(body.purpose)) return fail('bad_purpose');
    const c = await checkPin(ctx, body.op_code, body.pin);
    if (c.err) return c.err;
    if (c.operator.role !== 'supervisor') return fail('supervisor_only', 403);
    const token = mintToken();
    const s = await ins('sessions', { token_hash: await tokenHash(token), kind: 'stepup', vendor_id: ctx.vendorId,
      operator_id: c.operator.id, device_id: ctx.deviceId, purpose: body.purpose, idle_mins: 2,
      expires_at: new Date(Date.now() + STEPUP_SECONDS * 1000).toISOString() }, 'return=minimal');
    if (!s.ok) return fail('outpost_unavailable', 503);
    await logEvent(ctx.vendorId, 'operator', c.operator.id, 'stepup',
      { purpose: body.purpose, device_id: ctx.deviceId, floor_operator_id: ctx.operator.id });
    return ok({ stepup: token, purpose: body.purpose, seconds: STEPUP_SECONDS });
  }

  return fail('not_found', 404);
}

async function enrol(body, ip) {
  const lim = await codeAttempt('enrol', ip);
  if (lim.res) return lim.res;
  const code = String(body.code || '');
  const jwk = normaliseJwk(body.public_key_jwk);
  if (!isDigits(code, CODE_DIGITS) || !jwk) return fail('bad_code', 401);
  try { await importVerifyKey(jwk); } catch { return fail('bad_key'); }
  const r = await rpc('enrol_device', { p_code_hash: await codeHash(ENV.OUTPOST_PEPPER, 'enrol', code),
    p_jwk: jwk, p_thumbprint: await jwkThumbprint(jwk) });
  if (!r.ok) {
    const msg = String(r.data?.message || '');
    if (msg.includes('already enrolled')) return fail('key_already_enrolled', 409);
    if (msg.includes('not active')) return fail('vendor_inactive', 403);
    return fail('outpost_unavailable', 503);
  }
  if (r.data?.reason === 'paused') return fail('outpost_paused', 403);
  if (!r.data?.ok) return fail('bad_code', 401);
  await clearAttempt(lim.attemptId);
  return ok(r.data);
}

// ── supervisor dashboard (/d/*) ─────────────────────────────────────────────
async function dashboardRoute(request, url, rawBody, ip) {
  const route = url.pathname.slice(3);
  const body = parseBody(rawBody);
  if (body === undefined) return fail('bad_json');

  if (route === 'login' && request.method === 'POST') {
    const lim = await codeAttempt('login_code', ip);
    if (lim.res) return lim.res;
    const code = String(body.code || '');
    if (!isDigits(code, CODE_DIGITS)) return fail('bad_code', 401);
    const token = mintToken();
    const r = await rpc('redeem_login_code', { p_code_hash: await codeHash(ENV.OUTPOST_PEPPER, 'login', code),
      p_token_hash: await tokenHash(token) });
    if (!r.ok) return fail('outpost_unavailable', 503);
    if (r.data?.reason === 'paused') return fail('outpost_paused', 403);
    if (!r.data?.ok) return fail(r.data?.reason === 'inactive' ? 'not_allowed' : 'bad_code', 401);
    await clearAttempt(lim.attemptId);
    const killed = await killCheck(Number(r.data.vendor_id));
    if (killed) return fail(killed, 403);
    return ok({ session: token, expires_at: r.data.expires_at });
  }

  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return fail('login_required', 401);
  const s = await loadSession(auth.slice(7), 'dashboard');
  if (s === undefined) return fail('outpost_unavailable', 503);
  if (!s || s.operators.role !== 'supervisor') return fail('login_required', 401);
  const killed = await killCheck(Number(s.vendor_id));
  if (killed) return fail(killed, 403);

  if (route === 'me' && request.method === 'GET') {
    const v = await st(`/rest/v1/vendors?id=eq.${Number(s.vendor_id)}&select=vendor_name`);
    return ok({ vendor_id: Number(s.vendor_id), vendor_name: v.ok && v.data[0] ? v.data[0].vendor_name : null,
      operator: { id: s.operators.id, op_code: s.operators.op_code, name: s.operators.name }, expires_at: s.expires_at });
  }
  if (route === 'logout' && request.method === 'POST') {
    if (!(await revokeSessions(`id=eq.${s.id}`, 'logout'))) return fail('revoke_failed', 502);
    return ok({ logged_out: true });
  }
  return fail('not_found', 404);
}

// ── LOT owner (Depot, Supabase JWT + outpost_owner) ─────────────────────────
async function verifyOwner(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE, Authorization: authHeader },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  const p = await st(`/rest/v1/users_profile?id=eq.${q(user.id)}&select=role,full_name,active`);
  if (!p.ok || !p.data[0] || !p.data[0].active) return null;
  const r = await st(`/rest/v1/roles?role_id=eq.${q(p.data[0].role)}&select=permissions`);
  const perms = r.ok && r.data[0] ? r.data[0].permissions || {} : {};
  if (perms.outpost_owner !== true) return null;
  return { userId: user.id, email: user.email, fullName: p.data[0].full_name };
}

const VENDOR_CFG_FIELDS = ['active', 'killed', 'defect_tolerance_pct', 'pickup_address',
  'leak_unused_sticker_days', 'leak_packed_undispatched_days', 'leak_over_po_pct'];

async function ownerRoute(request, url, rawBody) {
  const me = await verifyOwner(request.headers.get('Authorization'));
  if (!me) return fail('forbidden', 403);
  const body = request.method === 'POST' ? parseBody(rawBody) : {};
  if (body === undefined) return fail('bad_json');
  const action = request.method === 'POST' ? body.action : url.searchParams.get('action');
  const P = request.method === 'POST' ? body : Object.fromEntries(url.searchParams);
  const vendorId = P.vendor_id == null ? null : Number(P.vendor_id);
  const needVendor = () => Number.isSafeInteger(vendorId) && vendorId > 0;
  const lot = (vid, act, detail) => logEvent(vid, 'lot', me.userId, act, { by: me.fullName, ...detail });

  switch (`${request.method} ${action}`) {
    case 'GET getVendors': {
      const [cfg, kill] = await Promise.all([op('/rest/v1/vendor_config?select=*&order=vendor_id'),
        op('/rest/v1/settings?key=eq.kill_all&select=value')]);
      if (!cfg.ok) return fail('read_failed', 502);
      const ids = cfg.data.map(c => c.vendor_id);
      const names = ids.length ? await st(`/rest/v1/vendors?id=in.(${ids.join(',')})&select=id,vendor_name,vendor_code`) : { ok: true, data: [] };
      const byId = new Map((names.data || []).map(v => [v.id, v]));
      return ok({ kill_all: kill.ok && kill.data[0] ? kill.data[0].value : null,
        vendors: cfg.data.map(c => ({ ...c, vendor_name: byId.get(c.vendor_id)?.vendor_name || null,
          vendor_code: byId.get(c.vendor_id)?.vendor_code || null })) });
    }
    case 'POST setVendorConfig': {
      if (!needVendor()) return fail('vendor_id required');
      const v = await st(`/rest/v1/vendors?id=eq.${vendorId}&select=id`);
      if (!v.ok || !v.data[0]) return fail('unknown vendor', 404);
      const row = { vendor_id: vendorId, updated_at: new Date().toISOString() };
      for (const f of VENDOR_CFG_FIELDS) if (f in P) row[f] = P[f];
      const r = await op('/rest/v1/vendor_config?on_conflict=vendor_id', { method: 'POST',
        body: JSON.stringify(row), prefer: 'resolution=merge-duplicates,return=representation' });
      if (!r.ok) return fail(r.data?.message || 'write_failed', 400);
      cache.vendor.delete(vendorId);
      await lot(vendorId, 'vendor_config', row);
      return ok(r.data[0]);
    }
    case 'POST setKillAll': {
      const value = P.on === true ? 'on' : P.on === false ? 'off' : null;
      if (!value) return fail('on must be true or false');
      const r = await patch('settings', 'key=eq.kill_all', { value, updated_at: new Date().toISOString(), updated_by: me.userId });
      if (!r.ok || !r.data[0]) return fail('write_failed', 502);
      cache.kill = null;
      await lot(null, 'kill_all', { value });
      return ok({ kill_all: value });
    }
    case 'GET getDevices': {
      if (!needVendor()) return fail('vendor_id required');
      const [d, e] = await Promise.all([
        op(`/rest/v1/devices?vendor_id=eq.${vendorId}&select=id,kind,bench_no,label,status,enrolled_at,last_seen_at,pin_locked_until,revoked_at&order=id`),
        op(`/rest/v1/device_enrolments?vendor_id=eq.${vendorId}&used_at=is.null&revoked_at=is.null&expires_at=gt.${q(new Date().toISOString())}&select=id,kind,bench_no,label,expires_at,created_at&order=id`)]);
      if (!d.ok || !e.ok) return fail('read_failed', 502);
      return ok({ devices: d.data, pending_enrolments: e.data });
    }
    case 'POST createEnrolment': {
      if (!needVendor()) return fail('vendor_id required');
      const kind = P.kind === 'agent' ? 'agent' : 'bench';
      const bench = P.bench_no == null || P.bench_no === '' ? null : Number(P.bench_no);
      if (kind === 'bench' && !(Number.isInteger(bench) && bench >= 1 && bench <= 99)) return fail('bench_no 1–99 required');
      const label = String(P.label || '').trim().slice(0, 60) || (kind === 'agent' ? 'Print agent' : `Bench ${bench}`);
      const cfg = await vendorCfg(vendorId);
      if (!cfg) return fail('set up the vendor first', 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = mintDigits(CODE_DIGITS);
        const r = await ins('device_enrolments', { vendor_id: vendorId, kind, bench_no: kind === 'bench' ? bench : null,
          label, code_hash: await codeHash(ENV.OUTPOST_PEPPER, 'enrol', code), created_by: me.userId,
          expires_at: new Date(Date.now() + CODE_TTL_HOURS * 3_600_000).toISOString() });
        if (r.ok) {
          await lot(vendorId, 'enrolment_code', { enrolment_id: r.data[0].id, kind, bench_no: bench, label });
          return ok({ id: r.data[0].id, code, expires_at: r.data[0].expires_at, label });
        }
        if (r.status !== 409) return fail('write_failed', 502);
      }
      return fail('try again', 503);
    }
    case 'POST revokeEnrolment': {
      const r = await patch('device_enrolments', `id=eq.${Number(P.id)}&used_at=is.null&revoked_at=is.null`,
        { revoked_at: new Date().toISOString() });
      if (!r.ok || !r.data[0]) return fail('not found or already used', 404);
      await lot(r.data[0].vendor_id, 'enrolment_revoked', { enrolment_id: r.data[0].id });
      return ok({ revoked: true });
    }
    case 'POST revokeDevice': {
      const id = Number(P.id);
      const r = await patch('devices', `id=eq.${id}&status=eq.active`,
        { status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: me.userId });
      if (!r.ok || !r.data[0]) return fail('not found or already revoked', 404);
      if (!(await revokeSessions(`device_id=eq.${id}`, 'device_revoked'))) return fail('revoke_failed', 502);
      cache.device.delete(id);
      await lot(r.data[0].vendor_id, 'device_revoked', { device_id: id, label: r.data[0].label });
      return ok({ revoked: true });
    }
    case 'POST unlockDevice': {
      const r = await patch('devices', `id=eq.${Number(P.id)}`, { pin_failures: 0, pin_locked_until: null });
      if (!r.ok || !r.data[0]) return fail('not found', 404);
      await lot(r.data[0].vendor_id, 'device_unlocked', { device_id: Number(P.id) });
      return ok({ unlocked: true });
    }
    case 'POST unlockOperator': {
      const r = await patch('operators', `id=eq.${Number(P.id)}`, { pin_failures: 0, pin_last_failure_at: null,
        pin_locked_until: null, updated_at: new Date().toISOString() });
      if (!r.ok || !r.data[0]) return fail('not found', 404);
      await lot(r.data[0].vendor_id, 'operator_unlocked', { operator_id: Number(P.id) });
      return ok({ unlocked: true });
    }
    case 'GET getOperators': {
      if (!needVendor()) return fail('vendor_id required');
      const r = await op(`/rest/v1/operators?vendor_id=eq.${vendorId}&select=id,op_code,name,role,active,pin_locked_until,created_at&order=op_code`);
      if (!r.ok) return fail('read_failed', 502);
      return ok(r.data);
    }
    case 'POST createOperator': {
      if (!needVendor()) return fail('vendor_id required');
      const name = String(P.name || '').trim().slice(0, 80);
      const role = P.role === 'supervisor' ? 'supervisor' : 'operator';
      if (!name) return fail('name required');
      if (!(await vendorCfg(vendorId))) return fail('set up the vendor first', 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const ex = await op(`/rest/v1/operators?vendor_id=eq.${vendorId}&select=op_code`);
        if (!ex.ok) return fail('read_failed', 502);
        const opCode = nextOpCode(ex.data.map(r => r.op_code));
        if (!opCode) return fail('operator codes exhausted', 409);
        const pin = mintDigits(PIN_DIGITS);
        const r = await ins('operators', { vendor_id: vendorId, op_code: opCode, name, role,
          pin_hash: await hashPin(pin, ENV.OUTPOST_PEPPER), created_by: me.userId });
        if (r.ok) {
          await lot(vendorId, 'operator_created', { operator_id: r.data[0].id, op_code: opCode, name, role });
          return ok({ id: r.data[0].id, op_code: opCode, name, role, pin });
        }
        if (r.status !== 409) return fail('write_failed', 502);
      }
      return fail('try again', 503);
    }
    case 'POST updateOperator': {
      const id = Number(P.id);
      const upd = { updated_at: new Date().toISOString() };
      if (typeof P.name === 'string' && P.name.trim()) upd.name = P.name.trim().slice(0, 80);
      if (P.role === 'operator' || P.role === 'supervisor') upd.role = P.role;
      if (typeof P.active === 'boolean') upd.active = P.active;
      const r = await patch('operators', `id=eq.${id}`, upd);
      if (!r.ok || !r.data[0]) return fail('not found', 404);
      if ((upd.active === false || 'role' in upd) && !(await revokeSessions(`operator_id=eq.${id}`, 'operator_changed'))) {
        return fail('revoke_failed', 502);
      }
      await lot(r.data[0].vendor_id, 'operator_updated', { operator_id: id, ...upd });
      return ok({ id, name: r.data[0].name, role: r.data[0].role, active: r.data[0].active });
    }
    case 'POST resetPin': {
      const id = Number(P.id);
      const pin = mintDigits(PIN_DIGITS);
      const r = await patch('operators', `id=eq.${id}`, { pin_hash: await hashPin(pin, ENV.OUTPOST_PEPPER),
        pin_failures: 0, pin_locked_until: null, updated_at: new Date().toISOString() });
      if (!r.ok || !r.data[0]) return fail('not found', 404);
      if (!(await revokeSessions(`operator_id=eq.${id}`, 'pin_reset'))) return fail('revoke_failed', 502);
      await lot(r.data[0].vendor_id, 'pin_reset', { operator_id: id });
      return ok({ id, op_code: r.data[0].op_code, pin });
    }
    case 'POST createLoginCode': {
      const id = Number(P.operator_id);
      const o = await op(`/rest/v1/operators?id=eq.${id}&select=id,vendor_id,role,active,name`);
      if (!o.ok || !o.data[0]) return fail('not found', 404);
      if (o.data[0].role !== 'supervisor' || !o.data[0].active) return fail('active supervisors only', 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = mintDigits(CODE_DIGITS);
        const r = await ins('login_codes', { vendor_id: o.data[0].vendor_id, operator_id: id,
          code_hash: await codeHash(ENV.OUTPOST_PEPPER, 'login', code), created_by: me.userId,
          expires_at: new Date(Date.now() + CODE_TTL_HOURS * 3_600_000).toISOString() });
        if (r.ok) {
          await lot(o.data[0].vendor_id, 'login_code', { operator_id: id, login_code_id: r.data[0].id });
          return ok({ code, expires_at: r.data[0].expires_at, operator: o.data[0].name });
        }
        if (r.status !== 409) return fail('write_failed', 502);
      }
      return fail('try again', 503);
    }
    case 'GET getEvents': {
      if (!needVendor()) return fail('vendor_id required');
      const before = Number(P.before_id);
      const r = await op(`/rest/v1/events?vendor_id=eq.${vendorId}${Number.isSafeInteger(before) && before > 0 ? `&id=lt.${before}` : ''}` +
        `&select=id,actor_kind,actor_id,action,detail,at&order=id.desc&limit=200`);
      if (!r.ok) return fail('read_failed', 502);
      return ok(r.data);
    }
    default:
      return fail('unknown action', 404);
  }
}

// ── plumbing ────────────────────────────────────────────────────────────────
async function handle(request, env) {
  ENV = env;
  const url = new URL(request.url);
  if (url.pathname === '/health') {
    return ok({ service: 'outpostops', configured: !!(env.SUPABASE_SERVICE_KEY && env.OUTPOST_PEPPER) });
  }
  if (!env.SUPABASE_SERVICE_KEY || !env.OUTPOST_PEPPER) return fail('not_configured', 503);
  if (!['GET', 'POST'].includes(request.method)) return fail('method', 405);
  try {
    const rawBody = await readBody(request);
    if (rawBody === null) return fail('too_large', 413);
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (url.pathname.startsWith('/v/')) return await vendorRoute(request, url, rawBody, ip);
    if (url.pathname.startsWith('/d/')) return await dashboardRoute(request, url, rawBody, ip);
    if (url.pathname === '/') return await ownerRoute(request, url, rawBody);
    return fail('not_found', 404);
  } catch (e) {
    console.error('outpostops', e?.stack || e);
    return fail('internal', 500);
  }
}

function parseBody(raw) {
  if (!raw || !raw.length) return {};
  try {
    const b = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    return b && typeof b === 'object' && !Array.isArray(b) ? b : undefined;
  } catch { return undefined; }
}

// The raw bytes: the signature hashes exactly what was sent. parseBody decodes strictly (invalid
// UTF-8 is bad_json, never silently replaced).
async function readBody(request) {
  if (request.method !== 'POST') return new Uint8Array(0);
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return null;   // before buffering
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) return null;
  return new Uint8Array(buf);
}

export default {
  // CORS is computed per request and stamped on the way out — never held in module state, which a
  // concurrent request in the same isolate would overwrite.
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const res = await handle(request, env);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  async scheduled(_event, env) {
    ENV = env;
    if (!env.SUPABASE_SERVICE_KEY) return;
    const r = await rpc('auth_housekeeping', {});
    if (!r.ok) console.error('auth_housekeeping failed', r.status, r.data);
  },
};
