// Signed outpostops client for an enrolled print agent. The device key is the agent's ONLY credential: no Supabase
// key, no operator. Signed string = the worker's canonicalString (outpostops-worker/src/auth.js — kept identical, a
// test checks it against the worker's own verifier).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const SIG_VERSION = 'OUTPOST-V1';
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export const b64url = bytes => Buffer.from(bytes).toString('base64url');
export const sha256Hex = async s => Buffer.from(await subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s)).toString('hex');
export const canonicalString = ({ method, path, ts, nonce, bodyHash }) =>
  [SIG_VERSION, String(method).toUpperCase(), path, String(ts), nonce, bodyHash].join('\n');

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };

// Enrol: a fresh P-256 key, the public half + the one-time code to /v/enrol, the private half saved to keyFile.
export async function enrol(baseUrl, code, keyFile) {
  if (existsSync(keyFile)) throw new Error(`${keyFile} exists — this agent is already enrolled (delete it to re-enrol)`);
  const kp = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const pub = await subtle.exportKey('jwk', kp.publicKey);
  const res = await fetch(`${baseUrl}/v/enrol`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim(), public_key_jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } }) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(`enrol refused: ${res.status} ${body?.error || ''}`);
  const priv = await subtle.exportKey('jwk', kp.privateKey);
  writeFileSync(keyFile, JSON.stringify({ device_id: body.data.device_id, base_url: baseUrl, private_jwk: priv,
    enrolled_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return body.data;
}

export async function loadClient(keyFile, { fetchImpl = fetch } = {}) {
  const saved = JSON.parse(readFileSync(keyFile, 'utf8'));
  const key = await subtle.importKey('jwk', saved.private_jwk, ALG, false, ['sign']);
  return makeClient({ deviceId: saved.device_id, baseUrl: saved.base_url, key, fetchImpl });
}

export function makeClient({ deviceId, baseUrl, key, fetchImpl = fetch }) {
  let skew = 0;                                  // server − local ms, learned from heartbeats and `clock` refusals
  async function call(method, path, body) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now() + skew;
    const nonce = b64url(globalThis.crypto.getRandomValues(new Uint8Array(18)));
    const sig = b64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
      enc.encode(canonicalString({ method, path, ts, nonce, bodyHash: await sha256Hex(raw) }))));
    const res = await fetchImpl(baseUrl + path, { method, body: raw || undefined, signal: AbortSignal.timeout(15_000), headers: {
      'Content-Type': 'application/json', 'X-Outpost-Device': String(deviceId), 'X-Outpost-Ts': String(ts),
      'X-Outpost-Nonce': nonce, 'X-Outpost-Sig': sig } });
    const out = await res.json().catch(() => null);
    if (out?.error === 'clock' && out.server_time) skew = out.server_time - Date.now();
    if (out?.data?.server_time) skew = out.data.server_time - Date.now();
    return { status: res.status, ok: res.ok && out?.ok === true, data: out?.data, error: out?.error };
  }
  return { deviceId, call, now: () => Date.now() + skew };
}
