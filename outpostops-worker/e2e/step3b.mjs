// Step 3b — re-run of step 3's harness-bug failures: outcome-unknown print job, dispatch, unpack after dispatch.
import { state, save, check, done, call, pack, idem, stepup } from './lib.mjs';

const WO_A = 25;
const { cars: C, rems: R } = state.mint.A;
const { C1 } = state.csg;

// C[1] was un-packed (carton in a DRAFT consignment — allowed). Re-pack it, close, add to CSG1.
const re = await pack('A1', WO_A, C[1], R[1]);
check('re-pack C[1]', re.ok, re);
const ctn6 = re.data?.carton?.ctn_no;
check(`close ${ctn6}`, (await call('A1', 'POST', '/v/close_carton', { ctn_no: ctn6, idempotency_key: idem() })).ok);
check(`add ${ctn6} to ${C1}`, (await call('A1', 'POST', '/v/consignment_add', { csg_no: C1, ctn_no: ctn6, idempotency_key: idem() })).ok);
state.packs.a1Ctn3 = ctn6; save();

// Print agent: the FIRST job of this claim → outcome unknown, the rest printed.
const c = await call('Aag', 'POST', '/v/agent/claim', { limit: 20, labels: true });
check('agent claims the new jobs', c.ok && c.data.length > 0, c);
const [u, ...rest] = c.data;
check('report unknown', (await call('Aag', 'POST', '/v/agent/report', { job_id: u.id, attempt: u.attempt, outcome: 'unknown' })).ok);
for (const j of rest) await call('Aag', 'POST', '/v/agent/report', { job_id: j.id, attempt: j.attempt, outcome: 'printed' });
check('the claim had printed jobs to contradict', rest.length > 0, c.data);
await call('Aag', 'POST', '/v/agent/report', { job_id: rest[0]?.id, attempt: rest[0]?.attempt, outcome: 'not_printed' });
const recent = await call('A1', 'GET', '/v/print_jobs?view=recent');
check('a late contradicting report for a printed job does not flip it', recent.ok && recent.data.find(j => j.id === rest[0]?.id)?.status === 'printed', recent.data?.find?.(j => j.id === rest[0]?.id));
const att = await call('A1', 'GET', '/v/print_jobs');
check('the unknown job is in the supervisor attention list', att.ok && att.data.some(j => j.id === u.id && j.status === 'outcome_unknown'), att.data);
const relabel = await call('A1', 'POST', '/v/print_resolve', { job_id: u.id, action: 'reprint', expected_status: 'outcome_unknown', idempotency_key: idem() });
check('supervisor reprints the unknown job (same job id)', relabel.ok, relabel);
const c2 = await call('Aag', 'POST', '/v/agent/claim', { limit: 20, labels: true });
check('the reprint comes back to the agent with the SAME id, flagged reprint', c2.ok && c2.data.some(j => j.id === u.id && j.reprint === true), c2.data);
for (const j of c2.data || []) await call('Aag', 'POST', '/v/agent/report', { job_id: j.id, attempt: j.attempt, outcome: 'printed' });

// Dispatch CSG1 (valid vehicle number this time).
const disp = await call('A1', 'POST', '/v/consignment_dispatch', { csg_no: C1, challan_no: 'O11-DC-1', challan_date: '2026-10-16',
  vehicle_no: 'MH15AB1234', transporter: 'O11 test', idempotency_key: idem() });
check(`dispatch ${C1}`, disp.ok, disp);
const note = await call('A1', 'GET', `/v/consignment?csg_no=${C1}`);
check(`${C1} packing note: 4 cartons, 7 units, dispatched`, note.ok && note.data.status === 'dispatched' && note.data.total_cartons === 4 && note.data.total_units === 7, note.data);
state.notes.csg1 = note.data;
const st = await stepup('A1', '001', 'unpack');
const lu = await call('A1', 'POST', '/v/unpack', { upc: C[2], reason: 'after dispatch', stepup: st.data?.stepup, idempotency_key: idem() });
check('unpack after dispatch refused', !lu.ok, lu);
const addLate = await call('A1', 'POST', '/v/consignment_add', { csg_no: C1, ctn_no: state.packs.ctnByDev.A3, idempotency_key: idem() });
check('adding a carton to a dispatched consignment refused', !addLate.ok, addLate);
save();
done();
