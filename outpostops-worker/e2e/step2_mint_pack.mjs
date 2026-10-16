// Step 2 — mint, then pack 10 across 3 benches concurrently: same-remote race, dropped ack, idempotency, cross-vendor.
import { state, save, check, done, call, pack, idem } from './lib.mjs';

const WO_A = 25, WO_B = 26;

async function mint(dev, code, qty) {
  const key = idem();
  const r = await call(dev, 'POST', '/v/mint', { product_code: code, quantity: qty, idempotency_key: key });
  check(`mint ${qty} ${code} on ${dev}`, r.ok && r.data.batch_id, r);
  const again = await call(dev, 'POST', '/v/mint', { product_code: code, quantity: qty, idempotency_key: key });
  check(`mint retry with the same key replays (no 2nd batch) ${code}`, again.ok && again.data.replayed === true && again.data.batch_id === r.data.batch_id, again);
  const sheet = await call(dev, 'GET', `/v/batch_sheet?batch_id=${r.data.batch_id}`);
  check(`batch_sheet ${r.data.batch_id} has ${qty} unused stickers`, sheet.ok && sheet.data.rows?.length === qty, sheet);
  return { batch: r.data.batch_id, upcs: (sheet.data?.rows || []).map(x => x.upc_id) };
}

if (!state.mint) {
  const cars = await mint('A1', 'GOBR', 12), rems = await mint('A1', 'GOXXR', 12);
  const bc = await mint('B1', 'GOBK', 2), br = await mint('B1', 'GOXXR', 2);
  state.mint = { A: { cars: cars.upcs, rems: rems.upcs, batches: [cars.batch, rems.batch] },
                 B: { cars: bc.upcs, rems: br.upcs, batches: [bc.batch, br.batch] } };
  save();
}
const { cars: C, rems: R } = state.mint.A;
const { cars: BC, rems: BR } = state.mint.B;
check('vendor A has 12 car + 12 remote stickers', C.length === 12 && R.length === 12, state.mint.A);

// Cross-vendor reads: A cannot see B's batch sheet.
const xSheet = await call('A1', 'GET', `/v/batch_sheet?batch_id=${state.mint.B.batches[0]}`);
check("A reading B's batch sheet → 404", xSheet.status === 404, xSheet);
const xMint = await call('A1', 'POST', '/v/mint', { product_code: 'GOBRX', quantity: 1, idempotency_key: idem() });
check('mint of a code the vendor does not pack refused', !xMint.ok, xMint);

// ── the same-remote race: A2 and A3 pack different cars with the SAME remote at the same instant ──
const [r2, r3] = await Promise.all([pack('A2', WO_A, C[3], R[3]), pack('A3', WO_A, C[4], R[3])]);
const winners = [r2, r3].filter(x => x.ok).length;
check('same remote on two benches at once: exactly one wins', winners === 1, { r2: r2.body, r3: r3.body });
const loser = r2.ok ? 'A3' : 'A2', loserCar = r2.ok ? C[4] : C[3];
state.notes.race = { winner: r2.ok ? 'A2' : 'A3', loserError: (r2.ok ? r3 : r2).error };
const fix = await pack(loser, WO_A, loserCar, R[4]);
check(`race loser (${loser}) packs with its own remote`, fix.ok, fix);

// ── concurrent packing across 3 benches ──
const plan = { A1: [[0, 0], [1, 1], [2, 2]], A2: [[5, 5], [6, 6]], A3: [[7, 7], [8, 8]] };
const lanes = await Promise.all(Object.entries(plan).map(async ([dev, pairs]) => {
  const out = [];
  for (const [c, r] of pairs) out.push(await pack(dev, WO_A, C[c], R[r]));
  return [dev, out];
}));
for (const [dev, out] of lanes) for (const o of out) check(`pack on ${dev} ${o.data?.car_upc || ''}`, o.ok, o);
const a1Third = lanes.find(([d]) => d === 'A1')[1][2];

// ── dropped acknowledgement: A1 sends pack #4 (fills its carton), "loses" the reply, retries with the SAME key ──
const key = idem();
const lost = pack('A1', WO_A, C[9], R[9], key);          // reply never read before the retry is sent
const retry = await pack('A1', WO_A, C[9], R[9], key);
const firstReply = await lost;
check('dropped ack: original pack committed', firstReply.ok, firstReply);
check('dropped ack: retry with the same key replays (no double pack)',
  retry.ok && (retry.data.replayed === true || firstReply.data?.replayed === true) &&
  retry.data.carton.ctn_no === firstReply.data.carton.ctn_no, { retry: retry.body, first: firstReply.body });
check('A1 carton closed at capacity 4', firstReply.data?.carton?.closed === true || retry.data?.carton?.closed === true, firstReply.data?.carton);
const sameKeyOtherBody = await pack('A1', WO_A, C[10], R[10], key);
check('same idempotency key with a different body refused', !sameKeyOtherBody.ok, sameKeyOtherBody);
const doublePack = await pack('A2', WO_A, C[9], R[10]);
check('packing an already-packed car (new key) refused', !doublePack.ok, doublePack);
const usedRemote = await pack('A2', WO_A, C[10], R[9]);
check('packing with an already-paired remote refused', !usedRemote.ok, usedRemote);
const swapped = await pack('A2', WO_A, R[10], C[10]);
check('remote scanned as the car refused', !swapped.ok && /remote sticker/.test(swapped.error || ''), swapped);

// ── cross-vendor ids ──
const xCar = await pack('A2', WO_A, BC[0], R[10]);
check("A packing B's car sticker refused", !xCar.ok && /not one of your stickers/.test(xCar.error || ''), xCar);
const xWo = await pack('A2', WO_B, C[10], R[10]);
check("A packing into B's work order refused", !xWo.ok && /work order not found/.test(xWo.error || ''), xWo);
const xRem = await pack('B1', WO_B, BC[0], R[10]);
check("B packing with A's remote sticker refused", !xRem.ok && /not one of your stickers/.test(xRem.error || ''), xRem);
// B packs one legit unit (its carton is the cross-vendor target later)
const bPack = await pack('B1', WO_B, BC[0], BR[0]);
check('B packs its own unit', bPack.ok, bPack);

state.packs = { a1Ctn: firstReply.data?.carton?.ctn_no, bCtn: bPack.data?.carton?.ctn_no,
  ctnByDev: Object.fromEntries(lanes.map(([d, o]) => [d, o.at(-1)?.data?.carton?.ctn_no])) };
state.packs.ctnByDev.A1 = firstReply.data?.carton?.ctn_no;
const floor = await call('A1', 'GET', '/v/floor_summary');
check('floor summary readable by supervisor', floor.ok, floor);
state.notes.floor = floor.data;
save();
console.log(JSON.stringify(state.packs));
done();
