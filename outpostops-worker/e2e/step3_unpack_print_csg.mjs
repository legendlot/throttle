// Step 3 — close cartons, un-pack after close (manifest bump + label reprint), re-pack, print agent, consignments, cross-vendor.
import { state, save, check, done, call, pack, idem, stepup } from './lib.mjs';

const WO_A = 25;
const { cars: C, rems: R } = state.mint.A;
const { a1Ctn, bCtn, ctnByDev } = state.packs;

// Close A2 / A3 cartons by hand (3 of 4).
for (const dev of ['A2', 'A3']) {
  const r = await call(dev, 'POST', '/v/close_carton', { ctn_no: ctnByDev[dev], idempotency_key: idem() });
  check(`close ${ctnByDev[dev]} on ${dev}`, r.ok, r);
}
const xClose = await call('A2', 'POST', '/v/close_carton', { ctn_no: bCtn, idempotency_key: idem() });
check("A closing B's carton refused", !xClose.ok, xClose);
const xRead = await call('A2', 'GET', `/v/carton?ctn_no=${bCtn}`);
check("A reading B's carton → 404", xRead.status === 404, xRead);

// ── un-pack after the carton closed ──
const before = await call('A1', 'GET', `/v/carton?ctn_no=${a1Ctn}`);
check(`read ${a1Ctn}: closed, 4 units`, before.ok && before.data.status === 'closed' && before.data.unit_count === 4, before);
const v0 = before.data?.manifest_version;
const noStep = await call('A1', 'POST', '/v/unpack', { upc: C[0], reason: 'O11 test', idempotency_key: idem() });
check('unpack without supervisor approval refused', noStep.status === 403, noStep);
const opStep = await stepup('A2', '002', 'unpack');
check('an operator cannot approve (step-up supervisor_only)', opStep.status === 403, opStep);
const st = await stepup('A1', '001', 'unpack');
check('supervisor step-up', st.ok && st.data.stepup, st);
const xUnpack = await call('A1', 'POST', '/v/unpack', { upc: state.mint.B.cars[0], reason: 'O11 cross', stepup: st.data.stepup, idempotency_key: idem() });
check("A un-packing B's unit refused (step-up not burnt)", !xUnpack.ok, xUnpack);
const up = await call('A1', 'POST', '/v/unpack', { upc: C[0], reason: 'O11 test: unpack after close', stepup: st.data.stepup, idempotency_key: idem() });
check('unpack after close', up.ok, up);
const reuse = await call('A1', 'POST', '/v/unpack', { upc: C[1], reason: 'reuse', stepup: st.data.stepup, idempotency_key: idem() });
check('step-up token is single-use', !reuse.ok, reuse);
const after = await call('A1', 'GET', `/v/carton?ctn_no=${a1Ctn}`);
check(`${a1Ctn}: manifest version bumped, 3 units`, after.ok && after.data.manifest_version === v0 + 1 && after.data.unit_count === 3, { v0, after: after.data });
state.notes.unpack = { result: up.data, v0, v1: after.data?.manifest_version };
// Re-pack the same stickers: goes into a new open carton on bench 1.
const re = await pack('A1', WO_A, C[0], R[0]);
check('re-pack the unpacked unit (same stickers)', re.ok && re.data.carton.ctn_no !== a1Ctn, re);
const close4 = await call('A1', 'POST', '/v/close_carton', { ctn_no: re.data?.carton?.ctn_no, idempotency_key: idem() });
check(`close ${re.data?.carton?.ctn_no} (1 unit)`, close4.ok, close4);
state.packs.a1Ctn2 = re.data?.carton?.ctn_no;
save();

// ── print agent: claim bench-1 jobs, report; one outcome unknown → supervisor resolves ──
const claimed = [];
for (let i = 0; i < 6; i++) {
  const c = await call('Aag', 'POST', '/v/agent/claim', { limit: 20, labels: true });
  if (!c.ok) { check('agent claim', false, c); break; }
  if (!c.data.length) break;
  claimed.push(...c.data);
  for (const j of c.data) {
    const outcome = claimed.length === 1 && j === c.data[0] ? 'unknown' : 'printed';
    const r = await call('Aag', 'POST', '/v/agent/report', { job_id: j.id, attempt: j.attempt, outcome });
    if (!r.ok) check(`agent report ${j.id}`, false, r);
  }
}
const kinds = claimed.reduce((m, j) => (m[j.kind] = (m[j.kind] || 0) + 1, m), {});
check('agent claimed bench-1 labels only (batch + EAN + CTN)', claimed.length > 0 && claimed.every(j => ['batch_label', 'ean_label', 'ctn_label'].includes(j.kind)), kinds);
state.notes.agentKinds = kinds;
const unknownJob = claimed[0];
const dupReport = await call('Aag', 'POST', '/v/agent/report', { job_id: claimed[1].id, attempt: claimed[1].attempt, outcome: 'printed' });
state.notes.dupReport = { status: dupReport.status, body: dupReport.body };
const att = await call('A1', 'GET', '/v/print_jobs');
check('the unknown job shows in the supervisor attention list', att.ok && att.data.some(j => j.id === unknownJob.id && j.status === 'outcome_unknown'), att.data?.slice?.(0, 3));
const xRes = await call('B1', 'POST', '/v/print_resolve', { job_id: unknownJob.id, action: 'printed', expected_status: 'outcome_unknown', idempotency_key: idem() });
check("B resolving A's print job refused", !xRes.ok, xRes);
const stale = await call('A1', 'POST', '/v/print_resolve', { job_id: unknownJob.id, action: 'reprint', expected_status: 'failed', idempotency_key: idem() });
check('resolve against a stale status refused', !stale.ok, stale);
const res = await call('A1', 'POST', '/v/print_resolve', { job_id: unknownJob.id, action: 'printed', expected_status: 'outcome_unknown', idempotency_key: idem() });
check('supervisor marks the unknown job printed', res.ok, res);
const hb = await call('Aag', 'POST', '/v/agent/heartbeat', { version: 'o11', queue: 0, printers: [{ role: 'labels', name: 'file:test', ok: true }] });
check('agent heartbeat', hb.ok, hb);
const ps = await call('A1', 'GET', '/v/print_status');
check('print status shows the agent online', ps.ok && ps.data.agents.some(a => a.online), ps.data);

// ── consignments: CSG1 = A1's two cartons + A2's; CSG2 = A3's (dispatched later, for the adverse audit) ──
const csg1 = await call('A1', 'POST', '/v/consignment_create', { notes: 'O11 test CSG1', idempotency_key: idem() });
check('create CSG1', csg1.ok && csg1.data.csg_no, csg1);
const csg2 = await call('A1', 'POST', '/v/consignment_create', { notes: 'O11 test CSG2', idempotency_key: idem() });
check('create CSG2', csg2.ok && csg2.data.csg_no, csg2);
const C1 = csg1.data.csg_no, C2 = csg2.data.csg_no;
const opCsg = await call('A2', 'POST', '/v/consignment_create', { notes: 'x', idempotency_key: idem() });
check('operator cannot create a consignment', opCsg.status === 403, opCsg);
for (const ctn of [a1Ctn, state.packs.a1Ctn2, ctnByDev.A2]) {
  const r = await call('A1', 'POST', '/v/consignment_add', { csg_no: C1, ctn_no: ctn, idempotency_key: idem() });
  check(`add ${ctn} to ${C1}`, r.ok, r);
}
const add3 = await call('A1', 'POST', '/v/consignment_add', { csg_no: C2, ctn_no: ctnByDev.A3, idempotency_key: idem() });
check(`add ${ctnByDev.A3} to ${C2}`, add3.ok, add3);
const dupAdd = await call('A1', 'POST', '/v/consignment_add', { csg_no: C2, ctn_no: a1Ctn, idempotency_key: idem() });
check('a carton already on CSG1 cannot join CSG2', !dupAdd.ok, dupAdd);
const xAdd = await call('A1', 'POST', '/v/consignment_add', { csg_no: C1, ctn_no: bCtn, idempotency_key: idem() });
check("A adding B's carton to its consignment refused", !xAdd.ok, xAdd);
const bCsg = await call('B1', 'POST', '/v/consignment_create', { notes: 'O11 B', idempotency_key: idem() });
const xAdd2 = await call('B1', 'POST', '/v/consignment_add', { csg_no: C1, ctn_no: bCtn, idempotency_key: idem() });
check("B adding to A's consignment refused", !xAdd2.ok, xAdd2);
const xRead2 = await call('B1', 'GET', `/v/consignment?csg_no=${C1}`);
check("B reading A's consignment → 404", xRead2.status === 404, xRead2);
const xDisp = await call('B1', 'POST', '/v/consignment_dispatch', { csg_no: C1, challan_no: 'X', challan_date: '2026-10-16', vehicle_no: 'X', idempotency_key: idem() });
check("B dispatching A's consignment refused", !xDisp.ok, xDisp);
const openAdd = await call('B1', 'POST', '/v/consignment_add', { csg_no: bCsg.data?.csg_no, ctn_no: bCtn, idempotency_key: idem() });
check('an OPEN carton cannot join a consignment', !openAdd.ok, openAdd);

const disp = await call('A1', 'POST', '/v/consignment_dispatch', { csg_no: C1, challan_no: 'O11-DC-1', challan_date: '2026-10-16',
  vehicle_no: 'MH15TEST1', transporter: 'O11 test', idempotency_key: idem() });
check(`dispatch ${C1}`, disp.ok, disp);
const note = await call('A1', 'GET', `/v/consignment?csg_no=${C1}`);
check(`${C1} packing note: 3 cartons, 7 units, dispatched`, note.ok && note.data.status === 'dispatched' && note.data.total_cartons === 3 && note.data.total_units === 7, note.data);
const lateUnpack = await stepup('A1', '001', 'unpack');
const lu = await call('A1', 'POST', '/v/unpack', { upc: C[1], reason: 'after dispatch', stepup: lateUnpack.data?.stepup, idempotency_key: idem() });
check('unpack after dispatch refused', !lu.ok, lu);
state.csg = { C1, C2, B: bCsg.data?.csg_no };
save();
console.log(JSON.stringify({ csg: state.csg, packs: state.packs }));
done();
