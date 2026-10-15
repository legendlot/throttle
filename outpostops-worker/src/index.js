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
const pub  = (path, opts) => sbReq(path, 'public', opts);
const q    = s => encodeURIComponent(s);
const rpc  = (fn, args) => op(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
// A raised `outpost: …` exception from an outpost.* function → its message for the caller (these are
// our own validation messages); anything else stays generic.
// A value inside a PostgREST in.(…) list: double-quoted, with \ and " escaped (URL-encode the whole list after).
const pgrstQuote = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const sqlMsg = r => {
  const m = String(r?.data?.message || '');
  return m.startsWith('outpost: ') ? m.slice(9) : null;
};
// A refused outpost.* RPC → the caller's response. Only a genuine concurrency loser is a 409 the app retries with the
// SAME idempotency key: two first-packs racing to open a bench's carton (that unique index ONLY — any other unique
// violation would fail the same way every time), a deadlock / serialization failure, or a lock wait that timed out
// (authenticator lock_timeout 8 s). A consignment whose cartons changed between dispatch's read and its locks raises
// 40001 too. Anything unexpected stays generic.
const FORBIDDEN_MSGS = new Set(['paused', 'vendor not active', 'operator not active',
  'not an active bench of this vendor', 'supervisor approval required', 'not an active print agent of this vendor']);
const rpcFail = r => {
  const code = r?.data?.code;
  if ((code === '23505' && String(r?.data?.message || '').includes('cartons_one_open_per_bench_order'))
      || code === '40P01' || code === '40001' || code === '55P03') return fail('try_again', 409);
  const m = sqlMsg(r);
  if (!m) return fail('outpost_unavailable', 503);
  return fail(m, FORBIDDEN_MSGS.has(m) ? 403 : 400);
};
const idemKey = body => (typeof body.idempotency_key === 'string' ? body.idempotency_key : null);
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

  // A print agent has no operator: its device key is its whole credential (agent/* routes only).
  const isAgentRoute = route.startsWith('agent/');
  const needSession = !['login', 'me'].includes(route) && !isAgentRoute;
  const a = await authDevice(request, url, rawBody, { needSession });
  if (a.res) return a.res;
  const ctx = a.ctx;
  if (isAgentRoute) return agentRoute(request, route, body, ctx);

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

  if (route === 'products' && request.method === 'GET') {
    const list = await vendorProducts(ctx.vendorId);
    return list ? ok(list) : fail('outpost_unavailable', 503);
  }

  if (route === 'orders' && request.method === 'GET') {
    // Only orders whose product the vendor still packs: a deactivated / built_only product's open order is
    // not workable (the owner closes it in Depot).
    const r = await op(`/rest/v1/work_orders?vendor_id=eq.${ctx.vendorId}&status=eq.open` +
      `&vendor_products.active=is.true&vendor_products.mode=eq.packed` +
      `&select=id,wo_no,sku,channel,target_qty,created_at,vendor_products!inner(product)&order=id`);
    if (!r.ok) return fail('outpost_unavailable', 503);
    return ok(r.data);
  }

  if (route === 'mint' && request.method === 'POST') {
    if (ctx.operator.role !== 'supervisor') return fail('supervisor_only', 403);
    const qty = body.quantity;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 10000) return fail('quantity 1–10000');
    if (typeof body.product_code !== 'string' || !body.product_code.trim()) return fail('product_code required');
    const r = await rpc('vendor_mint', { p_vendor_id: ctx.vendorId, p_device_id: ctx.deviceId,
      // The key travels INSIDE the signed body, so it is covered by the device signature. The request
      // hash is over the body minus the key: a retry with the same key + same order replays.
      p_idem_key: idemKey(body),
      p_request_hash: await sha256Hex(JSON.stringify({ product_code: body.product_code, quantity: qty,
        operator_id: ctx.operator.id })),
      p_product_code: body.product_code, p_quantity: qty, p_operator_id: ctx.operator.id,
      p_generated_by: `Outpost ${ctx.operator.op_code} ${ctx.operator.name}`.slice(0, 120) });
    return r.ok ? ok(r.data) : rpcFail(r);
  }

  // ── Pair & Pack (O3) ── every write is one outpost.* transaction; the idempotency key rides inside the
  // signed body and the request hash covers the fields that define the action. Not the operator: keys are per
  // device, and a retry after an operator change must replay the committed pack, not be refused.
  if (route === 'pack' && request.method === 'POST') {
    if (ctx.deviceKind !== 'bench') return fail('not_a_bench', 403);
    const woId = wholeNumber(body.work_order_id);
    if (!(woId > 0)) return fail('work_order_id required');
    if (typeof body.car_upc !== 'string' || typeof body.remote_upc !== 'string') return fail('car_upc and remote_upc required');
    const r = await rpc('pack_unit', { p_vendor_id: ctx.vendorId, p_device_id: ctx.deviceId, p_operator_id: ctx.operator.id,
      p_idem_key: idemKey(body), p_request_hash: await sha256Hex(JSON.stringify({ work_order_id: woId,
        car_upc: body.car_upc, remote_upc: body.remote_upc })),
      p_work_order_id: woId, p_car_upc: body.car_upc, p_remote_upc: body.remote_upc });
    return r.ok ? ok(r.data) : rpcFail(r);
  }

  if (route === 'unpack' && request.method === 'POST') {
    if (ctx.deviceKind !== 'bench') return fail('not_a_bench', 403);
    if (typeof body.upc !== 'string' || typeof body.reason !== 'string') return fail('upc and reason required');
    if (typeof body.stepup !== 'string' || !body.stepup) return fail('supervisor approval required', 403);
    // The step-up token is consumed INSIDE outpost.unpack_unit, so a refused unpack never burns it.
    const r = await rpc('unpack_unit', { p_vendor_id: ctx.vendorId, p_device_id: ctx.deviceId, p_operator_id: ctx.operator.id,
      p_idem_key: idemKey(body), p_request_hash: await sha256Hex(JSON.stringify({ upc: body.upc, reason: body.reason })),
      p_stepup_hash: await tokenHash(body.stepup), p_upc: body.upc, p_reason: body.reason.slice(0, 300) });
    return r.ok ? ok(r.data) : rpcFail(r);
  }

  if (route === 'close_carton' && request.method === 'POST') {
    if (ctx.deviceKind !== 'bench') return fail('not_a_bench', 403);
    if (typeof body.ctn_no !== 'string') return fail('ctn_no required');
    const r = await rpc('close_carton', { p_vendor_id: ctx.vendorId, p_device_id: ctx.deviceId, p_operator_id: ctx.operator.id,
      p_idem_key: idemKey(body), p_request_hash: await sha256Hex(JSON.stringify({ ctn_no: body.ctn_no })),
      p_ctn_no: body.ctn_no });
    return r.ok ? ok(r.data) : rpcFail(r);
  }

  // Cartons still at the vendor (open = filling at a bench, closed = ready for a consignment).
  if (route === 'cartons' && request.method === 'GET') {
    // Empty ones (emptied by unpack) are hidden: an open one is refilled by the bench's next pack for that order.
    const r = await op(`/rest/v1/cartons?vendor_id=eq.${ctx.vendorId}&status=in.(open,closed)&unit_count=gt.0` +
      `&select=id,ctn_no,sku,channel,capacity,unit_count,status,manifest_version,bench_no,opened_at,closed_at,` +
      `work_orders(wo_no),consignment:consignments(csg_no,status),device_id&order=id.desc&limit=200`);
    return r.ok ? ok(r.data.map(withMine(ctx))) : fail('outpost_unavailable', 503);
  }

  if (route === 'carton' && request.method === 'GET') {
    const ctn = String(url.searchParams.get('ctn_no') || '').trim().toUpperCase();
    if (!/^CTN-\d{7}$/.test(ctn)) return fail('ctn_no required');
    const c = await op(`/rest/v1/cartons?vendor_id=eq.${ctx.vendorId}&ctn_no=eq.${ctn}` +
      `&select=id,ctn_no,sku,channel,capacity,unit_count,status,manifest_version,bench_no,opened_at,closed_at,` +
      `work_orders(wo_no),carton_units(car_upc,remote_upc,batch_label,added_at),device_id`);
    if (!c.ok) return fail('outpost_unavailable', 503);
    return c.data[0] ? ok(withMine(ctx)(c.data[0])) : fail('not_found', 404);
  }

  // ── Consignments (O4) ── supervisor only. A draft collects CLOSED cartons; dispatch records the vendor's own
  // delivery challan + vehicle (+ e-way bill) and moves every member unit to vendor_in_transit in one transaction.
  const CSG_WRITES = {
    consignment_create:   { fn: 'create_consignment',        fields: ['notes'] },
    consignment_add:      { fn: 'consignment_add_carton',    fields: ['csg_no', 'ctn_no'] },
    consignment_remove:   { fn: 'consignment_remove_carton', fields: ['csg_no', 'ctn_no'] },
    consignment_cancel:   { fn: 'cancel_consignment',        fields: ['csg_no'] },
    consignment_dispatch: { fn: 'dispatch_consignment',
      fields: ['csg_no', 'challan_no', 'challan_date', 'vehicle_no', 'eway_bill_no', 'transporter'] },
  };
  if (CSG_WRITES[route] && request.method === 'POST') {
    if (ctx.deviceKind !== 'bench') return fail('not_a_bench', 403);
    if (ctx.operator.role !== 'supervisor') return fail('supervisor_only', 403);
    const spec = CSG_WRITES[route];
    const vals = {};
    for (const f of spec.fields) {
      const v = body[f];
      if (v !== undefined && v !== null && typeof v !== 'string') return fail(`${f} must be text`);
      vals[f] = v ?? null;
    }
    if (spec.fields.includes('csg_no') && !vals.csg_no) return fail('csg_no required');
    if (spec.fields.includes('ctn_no') && !vals.ctn_no) return fail('ctn_no required');
    if (route === 'consignment_dispatch') {
      const d = vals.challan_date || '';
      const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : null;
      if (!t || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) return fail('challan_date YYYY-MM-DD required');
    }
    const args = { p_vendor_id: ctx.vendorId, p_device_id: ctx.deviceId, p_operator_id: ctx.operator.id,
      p_idem_key: idemKey(body), p_request_hash: await sha256Hex(JSON.stringify({ route, ...vals })) };
    for (const f of spec.fields) args[`p_${f}`] = vals[f];
    const r = await rpc(spec.fn, args);
    return r.ok ? ok(r.data) : rpcFail(r);
  }

  if (route === 'consignments' && request.method === 'GET') {
    // Dispatched rows carry frozen totals; only drafts (a handful) get live counts from their cartons.
    const r = await op(`/rest/v1/consignments?vendor_id=eq.${ctx.vendorId}` +
      `&select=id,csg_no,status,challan_no,challan_date,vehicle_no,eway_bill_no,transporter,carton_count,unit_count,` +
      `notes,created_at,dispatched_at&order=id.desc&limit=100`);
    if (!r.ok) return fail('outpost_unavailable', 503);
    const drafts = r.data.filter(c => c.status === 'draft').map(c => c.id);
    if (drafts.length) {
      const ct = await op(`/rest/v1/cartons?vendor_id=eq.${ctx.vendorId}&consignment_id=in.(${drafts.join(',')})` +
        `&select=consignment_id,unit_count`);
      if (!ct.ok) return fail('outpost_unavailable', 503);
      for (const c of r.data.filter(x => x.status === 'draft')) {
        const mine = ct.data.filter(x => Number(x.consignment_id) === Number(c.id));
        c.carton_count = mine.length;
        c.unit_count = mine.reduce((s, x) => s + Number(x.unit_count), 0);
      }
    }
    return ok(r.data.map(({ id, ...rest }) => rest));
  }

  // One consignment with everything its packing note needs: cartons, per-SKU lines (frozen at dispatch, live for a
  // draft), product names + EAN + HSN, and the consignor (the vendor). The GST delivery challan is the vendor's own
  // document — Outpost records its number; this is the packing note that travels with it.
  if (route === 'consignment' && request.method === 'GET') {
    const csg = String(url.searchParams.get('csg_no') || '').trim().toUpperCase();
    if (!/^CSG-\d{5,}$/.test(csg)) return fail('csg_no required');
    const c = await op(`/rest/v1/consignments?vendor_id=eq.${ctx.vendorId}&csg_no=eq.${csg}` +
      `&select=csg_no,status,challan_no,challan_date,vehicle_no,eway_bill_no,transporter,carton_count,unit_count,summary,` +
      `notes,created_at,dispatched_at,cartons(ctn_no,sku,channel,unit_count,status,manifest_version)`);
    if (!c.ok) return fail('outpost_unavailable', 503);
    const row = c.data[0];
    if (!row) return fail('not_found', 404);
    row.cartons.sort((a, b) => a.ctn_no.localeCompare(b.ctn_no));
    let lines = row.summary?.lines;
    if (!lines) {
      const by = new Map();
      for (const ct of row.cartons) {
        const k = `${ct.sku}\u0000${ct.channel}`;
        const l = by.get(k) || { sku: ct.sku, channel: ct.channel, cartons: 0, units: 0 };
        l.cartons += 1; l.units += Number(ct.unit_count);
        by.set(k, l);
      }
      lines = [...by.values()].sort((a, b) => a.sku.localeCompare(b.sku) || a.channel.localeCompare(b.channel));
    }
    const skus = [...new Set(lines.map(l => l.sku))];
    const [pm, v] = await Promise.all([
      skus.length ? pub(`/rest/v1/product_master?product_code=in.(${q(skus.map(pgrstQuote).join(','))})` +
        `&component_type=eq.car&select=product_code,product,model,color,ean,hsn_code`) : Promise.resolve({ ok: true, data: [] }),
      st(`/rest/v1/vendors?id=eq.${ctx.vendorId}&select=vendor_name,address,gstin`),
    ]);
    if (!pm.ok || !v.ok) return fail('outpost_unavailable', 503);
    const prod = new Map(pm.data.map(p => [String(p.product_code).toUpperCase(), p]));
    const { summary, ...rest } = row;
    return ok({ ...rest, lines: lines.map(l => ({ ...l, ...(prod.get(l.sku) ? {
      product: prod.get(l.sku).product, model: prod.get(l.sku).model, color: prod.get(l.sku).color,
      ean: prod.get(l.sku).ean, hsn_code: prod.get(l.sku).hsn_code } : {}) })),
      total_cartons: row.summary ? row.carton_count : row.cartons.length,
      total_units: row.summary ? row.unit_count : lines.reduce((s, l) => s + l.units, 0),
      consignor: v.data[0] || null });
  }

  // ── Printing (O5) ── what the floor sees of the print queue, and the supervisor's fix for a job the agent could
  // not finish: reprint (same job id; refused when the label is no longer current), printed (it did come out), cancel,
  // dismiss (a label printed after it was superseded — thrown away).
  if (route === 'print_jobs' && request.method === 'GET') {
    const view = url.searchParams.get('view') === 'recent' ? 'recent' : 'attention';
    const filter = view === 'attention' ? '&or=(status.in.(outcome_unknown,failed),and(late_print.is.true,resolved_at.is.null))' : '';
    const r = await op(`/rest/v1/print_jobs?vendor_id=eq.${ctx.vendorId}${filter}` +
      `&select=id,kind,ref,status,attempts,reprints,error,late_print,resolved_at,created_at,printed_at,outcome_at,` +
      `batch_label:payload->>batch_label,part:payload->part,parts:payload->parts,device:devices!print_jobs_device_id_fkey(bench_no)` +
      `&order=id.desc&limit=${view === 'attention' ? 200 : 100}`);
    if (!r.ok) return fail('outpost_unavailable', 503);
    return ok(r.data);
  }

  if (route === 'print_status' && request.method === 'GET') {
    const [ag, counts] = await Promise.all([
      op(`/rest/v1/devices?vendor_id=eq.${ctx.vendorId}&kind=eq.agent&status=eq.active` +
        `&select=id,label,bench_no,last_seen_at,agent_status,agent_status_at&order=id`),
      rpc('print_counts', { p_vendor_id: ctx.vendorId })]);
    if (!ag.ok || !counts.ok) return fail('outpost_unavailable', 503);
    const now = Date.now();
    return ok({ counts: counts.data, agents: ag.data.map(a => ({ ...a,
      online: !!a.agent_status_at && now - Date.parse(a.agent_status_at) < AGENT_ONLINE_MS })) });
  }

  if (route === 'print_resolve' && request.method === 'POST') {
    if (ctx.deviceKind !== 'bench') return fail('not_a_bench', 403);
    if (ctx.operator.role !== 'supervisor') return fail('supervisor_only', 403);
    const jobId = wholeNumber(body.job_id);
    if (!(jobId > 0)) return fail('job_id required');
    if (!['reprint', 'printed', 'cancel', 'dismiss'].includes(body.action)) return fail('action is reprint, printed, cancel or dismiss');
    // The status the supervisor was looking at: a job that changed meanwhile (e.g. its late report landed) is refused,
    // so a stale screen can never reprint a label that did come out.
    if (typeof body.expected_status !== 'string' || !body.expected_status) return fail('expected_status required');
    const r = await rpc('print_resolve', { p_vendor_id: ctx.vendorId, p_device_id: ctx.deviceId, p_operator_id: ctx.operator.id,
      p_idem_key: idemKey(body), p_request_hash: await sha256Hex(JSON.stringify({ route, job_id: jobId, action: body.action,
        expected_status: body.expected_status })),
      p_job_id: jobId, p_action: body.action, p_expected_status: body.expected_status });
    return r.ok ? ok(r.data) : rpcFail(r);
  }

  // The supervisor's floor board (O6): today's packs per bench (IST day), open orders with packed vs target, cartons by
  // stage, minted stickers not yet on a unit.
  if (route === 'floor_summary' && request.method === 'GET') {
    if (ctx.operator.role !== 'supervisor') return fail('supervisor_only', 403);
    const r = await rpc('floor_summary', { p_vendor_id: ctx.vendorId });
    return r.ok ? ok(r.data) : fail('outpost_unavailable', 503);
  }

  if (route === 'batches' && request.method === 'GET') {
    const r = await pub(`/rest/v1/upc_batches?vendor_id=eq.${ctx.vendorId}` +
      `&select=batch_id,product,product_code,quantity,upc_from,upc_to,status,generated_by,generated_at&order=generated_at.desc&limit=50`);
    if (!r.ok) return fail('outpost_unavailable', 503);
    return ok(r.data);
  }

  return fail('not_found', 404);
}

// ── print agent (/v/agent/*) ── an enrolled `agent` device, no operator. Claims lease jobs for its own bench (the
// device's bench_no) and, when it drives a sticker printer, the site's sticker sheets; it reports each one exactly once.
// A lost report is never a silent reprint: the lease runs out to outcome_unknown and a supervisor decides.
const AGENT_ONLINE_MS = 90_000;
async function agentRoute(request, route, body, ctx) {
  if (ctx.deviceKind !== 'agent') return fail('not_an_agent', 403);
  if (request.method !== 'POST') return fail('not_found', 404);

  if (route === 'agent/claim') {
    const limit = wholeNumber(body.limit);
    const r = await rpc('agent_claim', { p_vendor_id: ctx.vendorId, p_device_id: ctx.deviceId,
      p_stickers: body.stickers === true, p_labels: body.labels !== false, p_limit: limit > 0 ? Math.min(limit, 20) : 5 });
    return r.ok ? ok(r.data) : rpcFail(r);
  }

  if (route === 'agent/report') {
    const jobId = wholeNumber(body.job_id), attempt = wholeNumber(body.attempt);
    if (!(jobId > 0) || !(attempt > 0)) return fail('job_id and attempt required');
    if (!['printed', 'not_printed', 'unknown'].includes(body.outcome)) return fail('outcome is printed, not_printed or unknown');
    if (body.error != null && typeof body.error !== 'string') return fail('error must be text');
    const r = await rpc('agent_report', { p_vendor_id: ctx.vendorId, p_device_id: ctx.deviceId, p_job_id: jobId,
      p_attempt: attempt, p_outcome: body.outcome, p_error: body.error ?? null });
    return r.ok ? ok(r.data) : rpcFail(r);
  }

  if (route === 'agent/heartbeat') {
    // Shape kept small and flat: what the floor's printer tile shows. Anything else is dropped.
    const printers = Array.isArray(body.printers) ? body.printers.slice(0, 6).map(p => ({
      role: p?.role === 'stickers' ? 'stickers' : 'labels',
      name: String(p?.name ?? '').slice(0, 60),
      ok: p?.ok === true,
      detail: p?.detail == null ? null : String(p.detail).slice(0, 120),
    })) : [];
    const status = { version: String(body.version ?? '').slice(0, 20), printers,
      queue: wholeNumber(body.queue) >= 0 ? wholeNumber(body.queue) : null };
    const r = await patch('devices', `id=eq.${ctx.deviceId}`, { agent_status: status, agent_status_at: new Date().toISOString() });
    if (!r.ok) return fail('outpost_unavailable', 503);
    return ok({ server_time: Date.now() });
  }

  return fail('not_found', 404);
}

// The vendor's active PACKED products with each car code (colour + EAN) and the shared remote code.
// An open carton belongs to the DEVICE that opened it (close_carton matches device_id, not bench_no — two laptops can
// share a bench number while one replaces the other). Say whether it is this device's; never send device ids out.
const withMine = ctx => ({ device_id, ...c }) => ({ ...c, mine: Number(device_id) === Number(ctx.deviceId) });

async function vendorProducts(vendorId) {
  const vp = await op(`/rest/v1/vendor_products?vendor_id=eq.${vendorId}&active=is.true&mode=eq.packed` +
    `&select=id,product,remote_code,carton_qty&order=product`);
  if (!vp.ok) return null;                                   // unreadable ≠ "no products"
  if (!vp.data.length) return [];
  const fams = vp.data.map(v => pgrstQuote(v.product)).join(',');
  const pm = await pub(`/rest/v1/product_master?product=in.(${q(fams)})&component_type=eq.car&is_active=is.true` +
    `&select=product,product_code,model,color,ean&order=product_code`);
  if (!pm.ok) return null;
  const cars = pm.data;
  return vp.data.map(v => ({ ...v, cars: cars.filter(c => c.product === v.product)
    .map(c => ({ code: c.product_code, model: c.model, color: c.color, ean: c.ean })) }));
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

// A whole number from a JSON number or a digit string; anything else (true, [5], 1.5, '') → NaN.
const wholeNumber = v => (typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^\d{1,15}$/.test(v))
  ? Number(v) : NaN;

// Units per shipping carton by product family (Afshaan 2026-10-14) — a default, editable per vendor.
const CARTON_DEFAULTS = { Gator: 18, Shadow: 24 };

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
        op(`/rest/v1/devices?vendor_id=eq.${vendorId}&select=id,kind,bench_no,label,status,enrolled_at,last_seen_at,pin_locked_until,revoked_at,agent_status,agent_status_at&order=id`),
        op(`/rest/v1/device_enrolments?vendor_id=eq.${vendorId}&used_at=is.null&revoked_at=is.null&expires_at=gt.${q(new Date().toISOString())}&select=id,kind,bench_no,label,expires_at,created_at&order=id`)]);
      if (!d.ok || !e.ok) return fail('read_failed', 502);
      return ok({ devices: d.data, pending_enrolments: e.data });
    }
    case 'POST createEnrolment': {
      if (!needVendor()) return fail('vendor_id required');
      const kind = P.kind === 'agent' ? 'agent' : 'bench';
      const bench = P.bench_no == null || P.bench_no === '' ? null : Number(P.bench_no);
      if (kind === 'bench' && !(Number.isInteger(bench) && bench >= 1 && bench <= 99)) return fail('bench_no 1–99 required');
      // An agent's bench_no = the bench whose label printer it drives; none = a sticker-printer-only agent.
      if (kind === 'agent' && bench !== null && !(Number.isInteger(bench) && bench >= 1 && bench <= 99)) return fail('bench_no 1–99 or empty');
      const label = String(P.label || '').trim().slice(0, 60) || (kind === 'agent' ? 'Print agent' : `Bench ${bench}`);
      const cfg = await vendorCfg(vendorId);
      if (!cfg) return fail('set up the vendor first', 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = mintDigits(CODE_DIGITS);
        const r = await ins('device_enrolments', { vendor_id: vendorId, kind, bench_no: bench,
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
      // One transaction (outpost.revoke_device): device revoked, its sessions revoked, and every non-empty carton it
      // had open closed short + labelled — an open carton is keyed on the device, so it would otherwise be stranded.
      const id = wholeNumber(P.id);
      if (!(id >= 1)) return fail('id required');
      const r = await rpc('revoke_device', { p_device_id: id, p_by: me.userId });
      if (!r.ok) { const m = sqlMsg(r); return fail(m || 'write_failed', m ? 404 : 502); }
      cache.device.delete(id);
      await lot(r.data.vendor_id, 'device_revoked', { device_id: id, label: r.data.label,
        sessions_revoked: r.data.sessions_revoked, closed_cartons: r.data.closed_cartons.map(c => c.ctn_no) });
      return ok({ revoked: true, closed_cartons: r.data.closed_cartons });
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
      // The PIN has ALREADY changed: a failed session revoke must still hand back the new PIN (else the old one is dead
      // and the new one was never seen). The caller is told the live sessions may still be running.
      const ended = await revokeSessions(`operator_id=eq.${id}`, 'pin_reset');
      await lot(r.data[0].vendor_id, 'pin_reset', { operator_id: id, sessions_ended: ended });
      return ok({ id, op_code: r.data[0].op_code, pin, sessions_not_ended: !ended });
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
    case 'GET getVendorProducts': {
      if (!needVendor()) return fail('vendor_id required');
      const r = await op(`/rest/v1/vendor_products?vendor_id=eq.${vendorId}&select=*&order=product`);
      if (!r.ok) return fail('read_failed', 502);
      return ok(r.data);
    }
    case 'POST setVendorProduct': {
      if (!needVendor()) return fail('vendor_id required');
      const product = String(P.product || '').trim();
      if (!product) return fail('product required');
      if ('mode' in P && !['packed', 'built_only'].includes(P.mode)) return fail('mode must be packed or built_only');
      if ('active' in P && typeof P.active !== 'boolean') return fail('active must be true or false');
      // An update keeps every field it does not name — a carton-qty edit must never silently re-enable a
      // product or flip it back to packed (Codex S421).
      const ex = await op(`/rest/v1/vendor_products?vendor_id=eq.${vendorId}&product=eq.${q(product)}&select=*`);
      if (!ex.ok) return fail('read_failed', 502);
      const cur = ex.data[0] || null;
      // Switching a product OFF is always allowed — the family/remote checks only guard a row that will mint.
      const willBeActive = 'active' in P ? P.active : cur ? cur.active : true;
      const fam = await pub(`/rest/v1/product_master?product=eq.${q(product)}&is_active=is.true&select=product_code,component_type`);
      if (!fam.ok) return fail('read_failed', 502);
      if (willBeActive && !fam.data.some(r => r.component_type === 'car')) return fail(`no active car codes for '${product}'`, 404);
      const remotes = fam.data.filter(r => r.component_type === 'remote').map(r => r.product_code.toUpperCase());
      let remote = 'remote_code' in P ? (P.remote_code ? String(P.remote_code).toUpperCase() : null) : (cur ? cur.remote_code : null);
      if (!remote && !cur && remotes.length === 1) remote = remotes[0];                 // new row: the family's sole remote
      if (willBeActive && remote && !remotes.includes(remote)) return fail(`${remote} is not an active remote of ${product}`);
      const nextMode = 'mode' in P ? P.mode : cur ? cur.mode : 'packed';
      if (willBeActive && nextMode === 'packed' && !remote) return fail(`packed mode needs a remote code (${product} has ${remotes.length} active remotes)`);
      const qty = 'carton_qty' in P && P.carton_qty !== '' && P.carton_qty != null ? wholeNumber(P.carton_qty)
        : cur ? cur.carton_qty : CARTON_DEFAULTS[product];
      if (!Number.isInteger(qty) || qty < 1 || qty > 500) return fail('carton_qty 1–500 required');
      const row = { vendor_id: vendorId, product, remote_code: remote, carton_qty: qty, updated_at: new Date().toISOString(),
        mode: nextMode,
        active: willBeActive,
        box_type_id: 'box_type_id' in P ? (P.box_type_id || null) : cur ? cur.box_type_id : null,
        created_by: cur ? cur.created_by : me.userId };
      const r = await op('/rest/v1/vendor_products?on_conflict=vendor_id,product', { method: 'POST',
        body: JSON.stringify(row), prefer: 'resolution=merge-duplicates,return=representation' });
      if (!r.ok) return fail(r.data?.message || 'write_failed', 400);
      await lot(vendorId, 'vendor_product', { product, mode: row.mode, remote_code: remote, carton_qty: qty, active: row.active });
      return ok(r.data[0]);
    }
    case 'GET getWorkOrders': {
      if (!needVendor()) return fail('vendor_id required');
      const r = await rpc('owner_work_orders', { p_vendor_id: vendorId,
        p_status: ['open', 'closed', 'cancelled'].includes(P.status) ? P.status : null });
      if (!r.ok) return fail('read_failed', 502);
      return ok(r.data);
    }
    case 'GET getOrderOptions': {
      // The new-order form: the vendor's active packed car codes + its live PO lines that match one.
      if (!needVendor()) return fail('vendor_id required');
      const r = await rpc('owner_order_options', { p_vendor_id: vendorId });
      if (!r.ok) return fail('read_failed', 502);
      return ok(r.data);
    }
    case 'GET getStoreVendors': {
      // The "add a vendor to Outpost" picker: active store.vendors (Snorkel's vendor master).
      const r = await st('/rest/v1/vendors?active=is.true&select=id,vendor_code,vendor_name,location,process_type&order=vendor_name');
      if (!r.ok) return fail('read_failed', 502);
      return ok(r.data);
    }
    case 'POST createWorkOrder': {
      if (!needVendor()) return fail('vendor_id required');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(P.channel_id || ''))) return fail('channel_id required');
      const tq = wholeNumber(P.target_qty);
      if (!(tq >= 1 && tq <= 1_000_000)) return fail('target_qty must be a whole number 1–1,000,000');
      if (P.po_line_id != null && P.po_line_id !== '' && !(wholeNumber(P.po_line_id) >= 1)) {
        return fail('po_line_id must be a PO line id');
      }
      const r = await rpc('create_work_order', { p_vendor_id: vendorId, p_sku: String(P.sku || ''),
        p_channel_id: P.channel_id || null, p_target_qty: wholeNumber(P.target_qty),
        p_po_line_id: P.po_line_id ? Number(P.po_line_id) : null, p_created_by: me.userId, p_notes: P.notes || null });
      if (!r.ok) { const m = sqlMsg(r); return fail(m || 'write_failed', m ? 400 : 502); }
      return ok(r.data);
    }
    case 'POST setWorkOrderStatus': {
      if (!['closed', 'cancelled'].includes(P.status)) return fail('status must be closed or cancelled');
      const r = await patch('work_orders', `id=eq.${Number(P.id)}&status=eq.open`,
        { status: P.status, closed_at: new Date().toISOString() });
      if (!r.ok || !r.data[0]) return fail('not found or not open', 404);
      await lot(r.data[0].vendor_id, 'work_order_' + P.status, { work_order_id: r.data[0].id, wo_no: r.data[0].wo_no });
      return ok(r.data[0]);
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
    const p = await rpc('print_housekeeping', {});
    if (!p.ok) console.error('print_housekeeping failed', p.status, p.data);
  },
};
