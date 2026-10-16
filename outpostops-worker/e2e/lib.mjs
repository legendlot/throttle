// O11 harness library — plays Outpost benches / agents against the LIVE outpostops worker with real signed requests.
// State (device keys, sessions, UPCs) persists in state.json next to this file so steps can run separately.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { b64urlEncode, canonicalString, sha256Hex } from '../src/auth.js';

export const BASE = process.env.OUTPOST_BASE || 'https://outpostops.afshaan.workers.dev';
const DIR = new URL('.', import.meta.url).pathname;
export const CREDS = JSON.parse(readFileSync(DIR + 'creds.json', 'utf8'));
const STATE_FILE = DIR + 'state.json';
export const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { devices: {}, notes: {} };
export const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), { mode: 0o600 });

const enc = new TextEncoder();
let failures = 0;
export const results = [];
export function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)?.slice(0, 600)}`);
  if (!cond) failures++;
  return !!cond;
}
export const done = () => { console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0); };
export const nonce = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
export const idem = () => 'o11-' + b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));

const keys = new Map();
async function privKey(name) {
  if (keys.has(name)) return keys.get(name);
  const k = await crypto.subtle.importKey('jwk', state.devices[name].priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  keys.set(name, k);
  return k;
}

export async function enrol(name, code, vendor) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const res = await fetch(`${BASE}/v/enrol`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, public_key_jwk: pub }) });
  const body = await res.json().catch(() => null);
  if (body?.ok) { state.devices[name] = { id: body.data.device_id, vendor, priv, pub, session: null }; save(); }
  return { status: res.status, body };
}

// A signed request from device `name`. opts: { session, reuse:{ts,nonce,sig}, bodyRaw, tsOverride, noSession }
export async function call(name, method, path, body, opts = {}) {
  const d = state.devices[name];
  const raw = opts.bodyRaw ?? (body ? JSON.stringify(body) : '');
  const signedRaw = opts.signRaw ?? raw;                 // sign one body, send another (tamper test)
  const ts = opts.reuse?.ts || opts.tsOverride || Date.now();
  const n = opts.reuse?.nonce || nonce();
  const sig = opts.reuse?.sig || b64urlEncode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await privKey(name),
    enc.encode(canonicalString({ method, path, ts, nonce: n, bodyHash: await sha256Hex(signedRaw) }))));
  const headers = { 'Content-Type': 'application/json', 'X-Outpost-Device': String(d.id),
    'X-Outpost-Ts': String(ts), 'X-Outpost-Nonce': n, 'X-Outpost-Sig': sig };
  const s = opts.noSession ? null : (opts.session ?? d.session);
  if (s) headers['X-Outpost-Session'] = s;
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method, headers, body: raw || undefined });
  const out = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok && out?.ok, data: out?.data, error: out?.error, body: out, ms: Date.now() - t0,
    sent: { ts, nonce: n, sig } };
}

export async function login(name, opCode) {
  const pin = CREDS[state.devices[name].vendor].ops[opCode].pin;
  const r = await call(name, 'POST', '/v/login', { op_code: opCode, pin }, { noSession: true });
  if (r.ok) { state.devices[name].session = r.data.session; state.devices[name].op = opCode; save(); }
  return r;
}

export async function stepup(name, opCode, purpose) {
  const pin = CREDS[state.devices[name].vendor].ops[opCode].pin;
  return call(name, 'POST', '/v/stepup', { op_code: opCode, pin, purpose });
}

export const pack = (name, wo, car, remote, key = idem()) =>
  call(name, 'POST', '/v/pack', { work_order_id: wo, car_upc: car, remote_upc: remote, idempotency_key: key });
