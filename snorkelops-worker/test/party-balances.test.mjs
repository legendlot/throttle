// aggregatePartyBalances is a pure aggregator inside the single-file worker (no named exports),
// so — like plan-hsn-sync.test.mjs — the test lifts its source text, plus decorateSalesOrder and
// its two helpers, straight out of index.js. Only the worker aggregates; the app just renders,
// so there is ONE copy and nothing to port.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  'const todayISO = () => "2026-09-11";',
  lift('function addDays(', '\n// Attach payment'),
  lift('function decorateSalesOrder(', '\n// Party balances'),
  lift('function aggregatePartyBalances(', '\n// ── Fulfilment'),
  'return { decorateSalesOrder, aggregatePartyBalances };',
].join('\n');
const { decorateSalesOrder, aggregatePartyBalances } = new Function(code)();

// PostgREST hands numerics back as strings — the fixtures do too.
const order = (partner, id, grand, credit, received, extra = {}) => ({
  id, partner_id: partner, partner_name: `P ${partner}`, partner_code: `SP-${partner}`,
  grand_total: String(grand), credit_total: credit == null ? null : String(credit),
  amount_received: String(received), credit_days: 30, order_date: '2026-07-01', ...extra,
});
const dec = (o, anchorDate = '2026-07-10') => decorateSalesOrder(o, { dispatch_date: anchorDate, delivery_date: null, anchor_date: anchorDate });
const byCode = rows => Object.fromEntries(rows.map(r => [r.partner_code, r]));

test('an overpaid invoice NETS against an owing one (the Sigma Toys shape: true balance 0)', () => {
  const rows = aggregatePartyBalances([
    dec(order('A', 1, 350400, 0, 0)),          // what Collections shows: owes 3,50,400
    dec(order('A', 2, 100000, 0, 450400)),     // overpaid by 3,50,400 — dropped by Collections
  ]);
  const a = byCode(rows)['SP-A'];
  assert.equal(a.balance, 0);
  assert.equal(a.billed, 450400);
  assert.equal(a.received, 450400);
  assert.equal(a.open_balance, 350400, 'the Collections-visible subset is still reported');
  assert.equal(a.open_count, 1);
  assert.equal(a.orders, 2);
});

test('credit notes push a partner NEGATIVE — signed, not clamped (the Swastik shape)', () => {
  const rows = aggregatePartyBalances([
    dec(order('B', 1, 93317, 0, 0)),
    dec(order('B', 2, 200000, 125603, 200000)), // fully paid AND credited → −1,25,603
  ]);
  const b = byCode(rows)['SP-B'];
  assert.equal(b.balance, -32286);
  assert.equal(b.credits, 125603);
  assert.equal(b.open_balance, 93317);
  assert.ok(b.balance === +(b.billed - b.credits - b.received).toFixed(2), 'balance = billed − credits − received');
});

test('open_balance ties to the Collections filter to the paisa, over messy 2-dp values', () => {
  // Collections = decorate → filter(balance > 0.005). Build 300 orders of awkward paise values.
  const orders = [];
  for (let i = 0; i < 300; i++) {
    const g = (i * 1234.57 + 0.01) % 99999.99;
    const r = i % 3 === 0 ? g + 10.03 : i % 3 === 1 ? g / 3 : 0;
    orders.push(dec(order(i % 7 === 0 ? 'X' : 'Y', i, g.toFixed(2), i % 5 === 0 ? '0.10' : null, r.toFixed(2))));
  }
  const coll = orders.filter(o => o.balance > 0.005);
  const rows = aggregatePartyBalances(orders);
  for (const p of ['X', 'Y']) {
    const expectPaise = coll.filter(o => o.partner_id === p).reduce((s, o) => s + Math.round(o.balance * 100), 0);
    const got = byCode(rows)[`SP-${p}`];
    assert.equal(Math.round(got.open_balance * 100), expectPaise, `partner ${p} open_balance`);
    assert.equal(got.open_count, coll.filter(o => o.partner_id === p).length);
    // And the signed total is exactly billed − credits − received in paise.
    assert.equal(Math.round(got.balance * 100),
      Math.round(got.billed * 100) - Math.round(got.credits * 100) - Math.round(got.received * 100));
  }
});

test('oldest due is the earliest OPEN invoice only; last order is the latest of all', () => {
  const rows = aggregatePartyBalances([
    dec(order('C', 1, 1000, 0, 1000, { order_date: '2026-01-01' }), '2026-01-05'), // settled — its due must not count
    dec(order('C', 2, 1000, 0, 0,    { order_date: '2026-03-01' }), '2026-03-05'),
    dec(order('C', 3, 1000, 0, 0,    { order_date: '2026-08-20' }), '2026-08-25'),
    dec(order('C', 4, 500,  0, 900,  { order_date: '2026-09-01' }), '2026-09-02'), // overpaid — not open
  ]);
  const c = byCode(rows)['SP-C'];
  assert.equal(c.oldest_due, '2026-04-04'); // 2026-03-05 + 30 credit days
  assert.equal(c.last_order_date, '2026-09-01');
  assert.equal(c.open_count, 2);
  assert.equal(c.balance, 1600);
});

test('a sub-paisa balance is settled, not open (same 0.005 threshold as Collections)', () => {
  const rows = aggregatePartyBalances([dec(order('D', 1, '100.00', null, '100.00'))]);
  assert.equal(rows[0].open_count, 0);
  assert.equal(rows[0].oldest_due, null);
  assert.equal(rows[0].balance, 0);
});

test('one row per partner, sorted by balance desc; partner fields carried; empty input is []', () => {
  const rows = aggregatePartyBalances([
    dec(order('E', 1, 10, 0, 50, { partner_channel_key: 'GT', partner_type: 'distributor' })),
    dec(order('F', 2, 90, 0, 0)),
    dec(order('F', 3, 10, 0, 0)),
  ]);
  assert.deepEqual(rows.map(r => r.partner_code), ['SP-F', 'SP-E']);
  assert.deepEqual(rows.map(r => r.balance), [100, -40]);
  assert.equal(rows[1].channel_key, 'GT');
  assert.equal(rows[1].partner_type, 'distributor');
  assert.deepEqual(aggregatePartyBalances([]), []);
  assert.deepEqual(aggregatePartyBalances(null), []);
});
