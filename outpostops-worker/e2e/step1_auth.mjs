// Step 1 — enrol every test device, log the operators in, and attack the auth layer.
import { CREDS, state, save, check, done, enrol, call, login, BASE } from './lib.mjs';

const A = CREDS.A.enrol, B = CREDS.B.enrol;
for (const [name, code, v] of [['A1', A.b1, 'A'], ['A2', A.b2, 'A'], ['A3', A.b3, 'A'], ['A4', A.b4, 'A'],
                               ['Aag', A.agent, 'A'], ['B1', B.b1, 'B']]) {
  if (state.devices[name]) { console.log(`skip enrol ${name} (device ${state.devices[name].id})`); continue; }
  const r = await enrol(name, code, v);
  check(`enrol ${name}`, r.body?.ok && r.body.data.device_id, r);
}
// The code is single-use: a second enrolment with the same code is refused.
const again = await fetch(`${BASE}/v/enrol`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: A.b1, public_key_jwk: state.devices.A1.pub }) });
check('enrolment code is single-use', again.status === 401 || again.status === 409, again.status);

// Logins: A1 = supervisor 001, A2 = 002, A3 = 003, B1 = B's supervisor 001.
for (const [dev, op] of [['A1', '001'], ['A2', '002'], ['A3', '003'], ['B1', '001']]) {
  const r = await login(dev, op);
  check(`login ${dev} as ${op}`, r.ok && r.data.session, r);
}
const me = await call('A2', 'GET', '/v/me');
check('/v/me shows vendor A + operator 002', me.ok && me.data.vendor_id === 198 && me.data.operator?.op_code === '002', me);
const meB = await call('B1', 'GET', '/v/me');
check('/v/me on B1 shows vendor B', meB.ok && meB.data.vendor_id === 199, meB);

// Replay: the exact same signed request again.
const first = await call('A2', 'GET', '/v/products');
check('signed GET /v/products', first.ok && first.data.some(p => p.product === 'Gator'), first);
const replay = await call('A2', 'GET', '/v/products', null, { reuse: first.sent });
check('replayed signed request refused', replay.status === 401 && replay.error === 'replay', replay);

// Tamper: signature over one body, a different body sent.
const tam = await call('A2', 'POST', '/v/pack', { work_order_id: 25, car_upc: 'LOT-00000001', remote_upc: 'LOT-00000002' },
  { signRaw: JSON.stringify({ work_order_id: 25 }) });
check('tampered body refused (bad_signature)', tam.status === 401 && tam.error === 'bad_signature', tam);

// Another device's key: A3 signs, claims to be A2.
const forged = await (async () => {
  const s = state.devices.A2.id; const real = state.devices.A3.id;
  state.devices.A3.id = s; const r = await call('A3', 'GET', '/v/me'); state.devices.A3.id = real; return r;
})();
check("another device's key refused", forged.status === 401 && forged.error === 'bad_signature', forged);

// Clock: a request signed 10 minutes ago.
const stale = await call('A2', 'GET', '/v/me', null, { tsOverride: Date.now() - 600_000 });
check('stale timestamp refused (clock)', stale.status === 401 && stale.error === 'clock', stale);

// A session token on its own (no signature) is refused; a session from another device does not carry over.
const bare = await fetch(`${BASE}/v/orders`, { headers: { 'X-Outpost-Session': state.devices.A2.session } });
check('session token alone (unsigned) refused', bare.status === 401, bare.status);
const stolenMe = await call('A3', 'GET', '/v/me', null, { session: state.devices.A2.session });
check("A2's session on A3: /v/me is NOT operator 002", stolenMe.data?.operator?.op_code !== '002', stolenMe);

// Session-required route without a session.
const noS = await call('A4', 'GET', '/v/orders', null, { noSession: true });
check('no session → login_required', noS.status === 401 && noS.error === 'login_required', noS);

// Operator role: an operator cannot mint (supervisor only).
const opMint = await call('A2', 'POST', '/v/mint', { product_code: 'GOBR', quantity: 1, idempotency_key: 'o11-x-' + Date.now() });
check('operator mint refused (supervisor_only)', opMint.status === 403 && opMint.error === 'supervisor_only', opMint);

// Agent device cannot log in an operator; a bench cannot use agent routes.
const agLogin = await call('Aag', 'POST', '/v/login', { op_code: '002', pin: CREDS.A.ops['002'].pin }, { noSession: true });
check('agent device cannot log an operator in', agLogin.status === 403 && agLogin.error === 'not_a_bench', agLogin);
const benchAgent = await call('A2', 'POST', '/v/agent/claim', { limit: 1 });
check('bench cannot claim print jobs', benchAgent.status === 403 && benchAgent.error === 'not_an_agent', benchAgent);

// Cross-vendor operator: B's 001 code on an A bench logs in A's 001 (different person) only with A's PIN — B's PIN fails.
const crossPin = await call('A4', 'POST', '/v/login', { op_code: '001', pin: CREDS.B.ops['001'].pin }, { noSession: true });
check("vendor B's PIN does not open vendor A's 001", crossPin.status === 401, crossPin);

// PIN lockout on bench A4 with operator 004: 5 wrong PINs lock the operator; then the RIGHT PIN is refused too.
const right = CREDS.A.ops['004'].pin;
const wrongPin = right === '000000' ? '111111' : '000000';
const codes = [];
for (let i = 0; i < 5; i++) {
  const w = await call('A4', 'POST', '/v/login', { op_code: '004', pin: wrongPin }, { noSession: true });
  codes.push(`${w.status}:${w.error}`);
}
check('5 wrong PINs each refused', codes.every(c => c.startsWith('401')), codes);
const locked = await call('A4', 'POST', '/v/login', { op_code: '004', pin: right }, { noSession: true });
check('correct PIN refused while the operator is locked', locked.status === 401 || locked.status === 423, locked);
state.notes.lockout = { codes, locked: `${locked.status}:${locked.error}`, at: new Date().toISOString() };
save();
done();
