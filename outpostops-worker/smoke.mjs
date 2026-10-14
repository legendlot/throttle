// Live smoke for outpostops vendor auth — plays a bench laptop end to end.
//   node smoke.mjs <enrolment code> <op_code> <pin> [base url]
// The enrolment code and the operator PIN come from the owner endpoints (createEnrolment /
// createOperator) for a TEST vendor. Prints PASS/FAIL per step; exits 1 on any failure.
import { b64urlEncode, canonicalString, sha256Hex } from './src/auth.js';

const [code, opCode, pin, base = 'https://outpostops.afshaan.workers.dev'] = process.argv.slice(2);
if (!code || !opCode || !pin) { console.error('usage: node smoke.mjs <code> <op_code> <pin> [base]'); process.exit(2); }

const enc = new TextEncoder();
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
let deviceId = null, session = null, failures = 0;

const nonce = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
async function signed(method, path, body, { session: s = session, reuse } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = Date.now(), n = reuse?.nonce || nonce();
  const sig = reuse?.sig || b64urlEncode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey,
    enc.encode(canonicalString({ method, path, ts: reuse?.ts || ts, nonce: n, bodyHash: await sha256Hex(raw) }))));
  const headers = { 'Content-Type': 'application/json', 'X-Outpost-Device': String(deviceId),
    'X-Outpost-Ts': String(reuse?.ts || ts), 'X-Outpost-Nonce': n, 'X-Outpost-Sig': sig };
  if (s) headers['X-Outpost-Session'] = s;
  const res = await fetch(base + path, { method, headers, body: raw || undefined });
  return { status: res.status, body: await res.json().catch(() => null), sent: { ts: reuse?.ts || ts, nonce: n, sig } };
}
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
  if (!cond) failures++;
}

const e = await fetch(`${base}/v/enrol`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, public_key_jwk: jwk }) }).then(r => r.json());
check('enrol', e.ok && e.data.device_id, e);
deviceId = e.data?.device_id;

const again = await fetch(`${base}/v/enrol`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, public_key_jwk: jwk }) });
check('enrolment code is single-use', again.status === 401, again.status);

const me0 = await signed('GET', '/v/me');
check('signed /v/me without a session', me0.status === 200 && me0.body.data.operator === null, me0);

const replay = await signed('GET', '/v/me', null, { reuse: me0.sent });
check('replayed request refused', replay.status === 401 && replay.body.error === 'replay', replay);

const wrong = await signed('POST', '/v/login', { op_code: opCode, pin: pin === '000000' ? '111111' : '000000' });
check('wrong PIN refused', wrong.status === 401, wrong);

const login = await signed('POST', '/v/login', { op_code: opCode, pin });
check('operator login', login.status === 200 && login.body.data.session, login);
session = login.body?.data?.session;

const me1 = await signed('GET', '/v/me');
check('/v/me shows the operator', me1.body?.data?.operator?.op_code === opCode, me1);

const noSig = await fetch(`${base}/v/logout`, { method: 'POST', headers: { 'X-Outpost-Session': session || '' } });
check('session token alone (unsigned) refused', noSig.status === 401, noSig.status);

const tampered = await (async () => {
  const r = await signed('POST', '/v/logout', { x: 1 });
  return r;
})();
check('signed logout', tampered.status === 200, tampered);

const after = await signed('GET', '/v/me');
check('session dead after logout', after.body?.data?.operator === null, after);

const owner = await fetch(`${base}/?action=getVendors`);
check('owner route refuses without a JWT', owner.status === 403, owner.status);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
