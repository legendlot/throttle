'use client';
// The bench's only line to LOT: signed requests to outpostops. No Supabase key, no LOT login, ever.
//   device key  → IndexedDB (a non-extractable CryptoKey; survives reloads, never readable as bytes)
//   floor login → localStorage token, useless without this device's key (the worker binds it to the device)
import { newDeviceKey, signedHeaders } from './sign.mjs';

export const WORKER = process.env.NEXT_PUBLIC_OUTPOSTOPS_URL || 'https://outpostops.afshaan.workers.dev';
const SESSION_KEY = 'outpost.session';

// ── IndexedDB (one store, one record) ───────────────────────────────────────
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('outpost', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export const loadDevice = () => kv('readonly', s => s.get('device'));
const saveDevice = d => kv('readwrite', s => s.put(d, 'device'));
export const forgetDevice = () => kv('readwrite', s => s.delete('device'));

// ── floor session token ─────────────────────────────────────────────────────
// Held in memory for this tab; localStorage only carries it across a reload. A login or logout in ANOTHER tab of this
// bench never changes who this tab acts as: it reloads this tab (see watchSession), so the screen and the operator agree.
const store = {
  get: () => { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } },
  set: v => { try { v ? localStorage.setItem(SESSION_KEY, v) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } },
};
let token = typeof window === 'undefined' ? null : store.get();
export const setSession = t => { token = t || null; store.set(token); };
export function watchSession() {
  const h = e => { if (e.key === SESSION_KEY && (e.newValue || null) !== token) window.location.reload(); };
  window.addEventListener('storage', h);
  return () => window.removeEventListener('storage', h);
}

// ── calls ───────────────────────────────────────────────────────────────────
let device = null;              // { device_id, key }
let skew = 0;                   // server − local ms, learned from a `clock` refusal
const listeners = new Set();    // auth events: 'logged_out' | 'device_revoked'
export const onAuthEvent = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = e => listeners.forEach(fn => fn(e));

export async function initDevice() {
  device = (await loadDevice()) || null;
  return device;
}

export async function enrolDevice(code) {
  const { privateKey, publicJwk } = await newDeviceKey();
  const res = await fetch(`${WORKER}/v/enrol`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim(), public_key_jwk: publicJwk }) });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out?.ok) return { ok: false, error: out?.error || `http_${res.status}` };
  device = { device_id: out.data.device_id, key: privateKey, enrolled_at: new Date().toISOString() };
  await saveDevice(device);
  return { ok: true, data: out.data };
}

// One signed request. Returns { ok, status, data, error, extra } — never throws for HTTP refusals.
// Throws only when the request may not have reached the worker (network), so callers can retry with the SAME key.
export async function call(method, path, body, { retryClock = true } = {}) {
  if (!device) throw new Error('not enrolled');
  const raw = body === undefined ? '' : JSON.stringify(body);
  // Sign the path exactly as the worker will read it back (URL-normalised), never the string we were handed.
  const u = new URL(WORKER + path);
  const headers = await signedHeaders({ deviceId: device.device_id, key: device.key, method, path: u.pathname + u.search, raw,
    ts: Date.now() + skew });
  const sent = token;
  if (sent) headers['X-Outpost-Session'] = sent;
  if (raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(u, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(15_000) });
  const out = await res.json().catch(() => null);
  // Headers arrived but the body did not: the action may have committed. Same as a lost reply — the caller retries
  // with the same idempotency key.
  if (!out) throw new Error('unreadable reply');
  if (out?.error === 'clock' && out.server_time && retryClock) {
    skew = out.server_time - Date.now();
    return call(method, path, body, { retryClock: false });
  }
  const r = { ok: res.ok && out?.ok === true, status: res.status, data: out?.data, error: out?.error || (res.ok ? null : `http_${res.status}`),
    extra: out || {} };
  // Only the session this request carried is dead: a slow reply from before a re-login must not erase the new one.
  if (r.error === 'login_required' && sent && sent === token) { setSession(null); emit('logged_out'); }
  else if (r.error === 'login_required' && !sent) emit('logged_out');
  if (r.error === 'device_not_enrolled') emit('device_revoked');
  return r;
}

export const get = path => call('GET', path).catch(() => ({ ok: false, status: 0, error: 'offline' }));

// A business action: one idempotency key for every try, so a retry after a lost reply replays the committed result
// instead of doing it twice. Retries only an unsure outcome (UNSURE), never a refusal. When all tries end
// without an answer the key is KEPT for that exact action: pressing the button again (same route + same fields) reuses
// it, so a mint or pack that did commit is replayed, never repeated. Any definite answer forgets it.
const unsettled = new Map();     // route + body → idempotency key
// No answer we can trust: the action may or may not have committed (lost reply, 409 race, worker 500, gateway 502/504).
const UNSURE = new Set([0, 409, 500, 502, 503, 504]);
export async function act(route, body = {}) {
  const sig = route + JSON.stringify(body);
  const key = unsettled.get(sig) || crypto.randomUUID();
  unsettled.set(sig, key);
  const payload = { ...body, idempotency_key: key };
  let last = { ok: false, status: 0, error: 'offline' };
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise(r => setTimeout(r, 400 * i));
    try { last = await call('POST', `/v/${route}`, payload); }
    catch { last = { ok: false, status: 0, error: 'offline' }; continue; }
    if (last.ok || !UNSURE.has(last.status)) break;
  }
  if (last.ok || !UNSURE.has(last.status)) unsettled.delete(sig);
  return last;
}

// Login / step-up / logout are not idempotent actions (no key): one try, the operator retries.
export async function post(route, body) {
  try { return await call('POST', `/v/${route}`, body); }
  catch { return { ok: false, status: 0, error: 'offline' }; }
}

// ── words for the floor ─────────────────────────────────────────────────────
const MESSAGES = {
  offline: 'No connection to Outpost. Check the internet and try again.',
  outpost_unavailable: 'Outpost is not responding. Try again in a minute.',
  try_again: 'Busy, please try again.',
  bad_credentials: 'Wrong operator code or PIN.',
  login_required: 'Your session ended. Please log in again.',
  supervisor_only: 'Only a supervisor can do this.',
  'supervisor approval required': 'Supervisor approval required.',
  not_a_bench: 'This device is not a bench.',
  paused: 'Outpost is paused by LOT.',
  outpost_paused: 'Outpost is paused by LOT.',
  'vendor not active': 'This vendor is not active in Outpost.',
  device_not_enrolled: 'This device is no longer enrolled.',
  bad_code: 'That code is wrong or has expired.',
  too_many_attempts: 'Too many tries. Wait 15 minutes.',
  key_already_enrolled: 'This device is already enrolled.',
  vendor_inactive: 'This vendor is not active in Outpost.',
  revoke_failed: 'Could not end the session. Try again.',
  replay: 'Request repeated. Try again.',
  bad_signature: 'This device’s key was refused. Enrol it again.',
  not_found: 'Not found.',
};
export function say(r) {
  if (!r) return 'Something went wrong.';
  if (r.error === 'locked') {
    const until = r.extra?.until ? new Date(r.extra.until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : null;
    return `${r.extra?.scope === 'device' ? 'This bench is' : 'This operator is'} locked after too many wrong PINs${until ? ` until ${until}` : ''}.`;
  }
  return MESSAGES[r.error] || r.error || 'Something went wrong.';
}
