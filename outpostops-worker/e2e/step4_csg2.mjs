import { state, check, done, call, idem } from './lib.mjs';
const { C2 } = state.csg;
const d = await call('A1', 'POST', '/v/consignment_dispatch', { csg_no: C2, challan_no: 'O11-DC-2', challan_date: '2026-10-16',
  vehicle_no: 'MH15AB1235', transporter: 'O11 test', idempotency_key: idem() });
check(`dispatch ${C2}`, d.ok, d);
const r1 = await call('A1', 'GET', `/v/consignment?csg_no=${state.csg.C1}`);
const rc = r1.data?.receipt;
check('vendor sees CSG1 receipt: 6 accepted, 1 short, no GRN number (LOT-internal)', r1.ok && rc?.accepted === 6 && rc?.short === 1 && !JSON.stringify(rc).includes('GRN-'), rc);
console.log(JSON.stringify(r1.data?.receipt));
done();
