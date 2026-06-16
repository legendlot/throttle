// Manifest "Pit Wall" — typed mock data layer.
// Mirrors design_handoff_manifest/README.md "Data" section exactly.
// Swap these arrays for real LOT⇄Solve Factory API responses later;
// all totals are DERIVED from the ledger (see derive()), never hard-coded.

// ── number formatting ────────────────────────────────────────────
const MINUS = '−'; // U+2212 true minus
export const inr = (n) => (n < 0 ? MINUS : '') + '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
export const rmb = (n) => '¥' + Math.abs(Math.round(n)).toLocaleString('en-US');
export const signedInr = (n) => (n < 0 ? MINUS : '+') + '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
export const label = (s) => (s || '').replace(/_/g, ' ');

// ── constants ────────────────────────────────────────────────────
export const FX = 11.82;                 // CNY/INR applied to open draw-downs
export const FX_SPARK = [11.60, 11.75, 11.80, 11.80, 11.82];
export const PENDING_COSTS = 1420000;    // not yet finalised
export const OPEN_DRAW = 294000;         // open draw-downs awaiting payment

// ── Ledger (newest values appended; running balance is the cumulative sum) ──
export const LEDGER = [
  { date: '2025-09-02', kind: 'payment', ref: 'WIRE-0901',   desc: 'Advance wire — HSBC Bengaluru',        amt:  4000000 },
  { date: '2025-09-15', kind: 'goods',   ref: 'CN-2509-003', desc: 'Plush wave 12 SKUs — goods (¥189,000)', amt: -2240000 },
  { date: '2025-09-18', kind: 'charge',  ref: 'SF-COM-09',   desc: 'Solve Factory commission · 5%',    amt:  -186000 },
  { date: '2025-09-28', kind: 'charge',  ref: 'FRT-2240',    desc: 'Intl freight — sea FCL',                amt:  -340000 },
  { date: '2025-10-05', kind: 'payment', ref: 'WIRE-1003',   desc: 'Advance wire — HSBC',                   amt:  2500000 },
  { date: '2025-10-12', kind: 'goods',   ref: 'CN-2510-007', desc: 'Mega Blocks 500pc — goods (¥159,500)', amt: -1890000 },
  { date: '2025-10-20', kind: 'charge',  ref: 'DUTY-1019',   desc: 'Customs duty + clearing',               amt:  -210000 },
  { date: '2025-11-01', kind: 'charge',  ref: 'INS-1101',    desc: 'Insurance + local freight',             amt:   -99500 },
  { date: '2025-11-08', kind: 'goods',   ref: 'CN-2511-011', desc: 'Injection mould — chassis (¥81,000)', amt:  -960000 },
  { date: '2025-11-15', kind: 'payment', ref: 'WIRE-1114',   desc: 'Advance wire — HSBC',                   amt:  3000000 },
  { date: '2025-11-22', kind: 'goods',   ref: 'CN-2511-014', desc: 'Drift Racer RC — goods (¥171,500)', amt: -2030000 },
  { date: '2025-12-01', kind: 'charge',  ref: 'SF-COM-11',   desc: 'SF commission + freight balance',       amt:  -261500 },
];

// ── Orders ───────────────────────────────────────────────────────
export const ORDERS = [
  { no: 'CN-2511-014', title: 'Drift Racer RC — full build', category: 'product',  valueRmb: 171500, po: 'CN-1042', status: 'in_production', created: '22 Nov' },
  { no: 'CN-2511-011', title: 'Injection mould — chassis',   category: 'mould',    valueRmb: 81000,  po: null,      status: 'shipped',       created: '08 Nov' },
  { no: 'CN-2510-007', title: 'Mega Blocks 500pc',           category: 'product',  valueRmb: 159500, po: 'CN-1031', status: 'in_transit',    created: '12 Oct' },
  { no: 'CN-2509-003', title: 'Plush wave 12 SKUs',          category: 'product',  valueRmb: 189000, po: 'CN-1018', status: 'delivered',     created: '02 Sep' },
  { no: 'CN-2512-016', title: 'Spare wheels + axles',        category: 'part',     valueRmb: 44200,  po: null,      status: 'placed',        created: '03 Dec' },
  { no: 'CN-2512-019', title: 'RC controller PCBA',          category: 'sub_part', valueRmb: 96800,  po: null,      status: 'quoted',        created: '06 Dec' },
  { no: 'CN-2511-012', title: 'Packaging — printed boxes',   category: 'other',    valueRmb: 38500,  po: null,      status: 'ready',         created: '10 Nov' },
  { no: 'CN-2510-009', title: 'QA sample set',               category: 'sample',   valueRmb: 6400,   po: null,      status: 'closed',        created: '04 Oct' },
];

export const ORDER_LINES = [ // CN-2511-014
  { n: 1, product: 'Drift Racer RC',  variant: 'Pro', colour: 'Red',   type: 'product',  qty: 800,  unit: 142, format: 'Assembled' },
  { n: 2, product: 'Drift Racer RC',  variant: 'Pro', colour: 'Blue',  type: 'product',  qty: 600,  unit: 142, format: 'Assembled' },
  { n: 3, product: 'Wheel set',       variant: '—',   colour: 'Black', type: 'part',     qty: 1400, unit: 6.5, format: 'Bulk' },
  { n: 4, product: 'Controller 2.4G', variant: '—',   colour: '—',     type: 'sub_part', qty: 1400, unit: 18,  format: 'Bulk' },
];

export const SHIPMENTS = [
  { no: 'SHP-2510-04', mode: 'Sea FCL', blAwb: 'MAEU-4471188', eta: '18 Jun', status: 'in_transit', order: 'CN-2510-007' },
  { no: 'SHP-2511-02', mode: 'Air',     blAwb: '176-55012244', eta: '09 Jun', status: 'customs',    order: 'CN-2511-011' },
  { no: 'SHP-2509-01', mode: 'Sea FCL', blAwb: 'OOLU-2210045', eta: '—',      status: 'delivered',  order: 'CN-2509-003' },
];

export const DRAWDOWNS = [
  { no: 'DD-2512-03', phase: 'shipping_customs', order: 'CN-2510-007', estInr: 210000, rate: 11.82, by: 'Wei Chen', date: '14 Dec', status: 'requested' },
  { no: 'DD-2511-05', phase: 'local',            order: null,          estInr: 84000,  rate: 11.80, by: 'Wei Chen', date: '28 Nov', status: 'partially_paid' },
  { no: 'DD-2511-08', phase: 'goods_advance',    order: 'CN-2511-014', estInr: 600000, rate: 11.78, by: 'Wei Chen', date: '15 Nov', status: 'paid' },
];

export const PAYMENTS = [
  { ref: 'WIRE-1114', date: '15 Nov', inr: 3000000, rmb: 254237, rate: 11.80, method: 'HSBC Wire', against: 'DD-2511-08', status: 'cleared' },
  { ref: 'WIRE-1003', date: '05 Oct', inr: 2500000, rmb: 212766, rate: 11.75, method: 'HSBC Wire', against: 'Advance',    status: 'cleared' },
  { ref: 'WIRE-0901', date: '02 Sep', inr: 4000000, rmb: 344828, rate: 11.60, method: 'HSBC Wire', against: 'Advance',    status: 'cleared' },
];

export const FX_HISTORY = [
  { date: '14 Dec', rate: 11.82, delta: 0.02, by: 'Arjun Mehta', applied: '1 draw-down' },
  { date: '28 Nov', rate: 11.80, delta: 0.00, by: 'Arjun Mehta', applied: '1 draw-down' },
  { date: '15 Nov', rate: 11.80, delta: 0.05, by: 'Arjun Mehta', applied: '1 payment' },
  { date: '05 Oct', rate: 11.75, delta: 0.15, by: 'Arjun Mehta', applied: '1 payment' },
  { date: '02 Sep', rate: 11.60, delta: null, by: 'Arjun Mehta', applied: '1 payment' },
];

export const DOCUMENTS = [
  { filename: 'PI-CN-2511-014.pdf',    type: 'PI',                 ref: 'CN-2511-014', date: '22 Nov', size: '412 KB' },
  { filename: 'PL-SHP-2510-04.pdf',    type: 'Packing List',       ref: 'SHP-2510-04', date: '16 Jun', size: '198 KB' },
  { filename: 'BL-MAEU-4471188.pdf',   type: 'Bill of Lading',     ref: 'SHP-2510-04', date: '14 Jun', size: '256 KB' },
  { filename: 'CI-CN-2510-007.pdf',    type: 'Commercial Invoice', ref: 'CN-2510-007', date: '12 Oct', size: '320 KB' },
  { filename: 'QC-CN-2509-003.pdf',    type: 'QC Report',          ref: 'CN-2509-003', date: '30 Aug', size: '1.2 MB' },
  { filename: 'WIRE-1114-receipt.pdf', type: 'Wire Receipt',       ref: 'DD-2511-08',  date: '15 Nov', size: '88 KB' },
];

export const ORG_GROUPS = [
  { org: 'Legend of Toys', tag: 'L', tagTone: 'yellow', members: [
    { name: 'Arjun Mehta', email: 'arjun@legendoftoys.com', role: 'Finance Admin', last: '2h ago', status: 'active' },
    { name: 'Priya Nair',  email: 'priya@legendoftoys.com', role: 'Operations',    last: '1d ago', status: 'active' },
    { name: 'Rohan Das',   email: 'rohan@legendoftoys.com', role: 'Viewer',        last: '5d ago', status: 'active' },
  ] },
  { org: 'Solve Factory', tag: 'S', tagTone: 'blue', members: [
    { name: 'Wei Chen', email: 'wei@solvefactory.cn',  role: 'Vendor Lead', last: '30m ago', status: 'active' },
    { name: 'Li Jing',  email: 'li@solvefactory.cn',   role: 'Logistics',   last: '3h ago',  status: 'active' },
    { name: 'Ming Zhao', email: 'ming@solvefactory.cn', role: 'Vendor',      last: '—',       status: 'invited' },
  ] },
];

export const ACTIVITY = [
  { event: 'Draw-down raised',    detail: 'DD-2512-03 · ₹2,10,000', who: 'Wei Chen (SF)',     when: '2h ago', tone: 'yellow' },
  { event: 'Payment recorded',    detail: 'WIRE-1114 · ₹30,00,000', who: 'Arjun Mehta (LOT)', when: '1d ago', tone: 'green' },
  { event: 'Order → In transit', detail: 'CN-2510-007',                  who: 'Wei Chen (SF)',     when: '2d ago', tone: 'blue' },
  { event: 'PI received',         detail: 'CN-2511-014',                      who: 'Wei Chen (SF)',     when: '3d ago', tone: 'blue' },
  { event: 'FX rate set',         detail: 'CNY/INR 11.82',                    who: 'Arjun Mehta (LOT)', when: '3d ago', tone: 'gray' },
  { event: 'Order placed',        detail: 'CN-2512-016',                      who: 'Arjun Mehta (LOT)', when: '4d ago', tone: 'gray' },
];

// CN-2511-014 cost breakdown (Order Detail)
export const ORDER_DETAIL = {
  no: 'CN-2511-014',
  subtitle: 'Drift Racer RC — full build · Solve Factory · via SF',
  status: 'in_production',
  po: 'CN-1042',
  projected: '22 Nov',
  costRows: [
    { label: 'Goods value',          amt: 2030000 },
    { label: 'SF commission · 5%', amt: 101500 },
    { label: 'Intl freight (est.)',   amt: 280000 },
    { label: 'Customs duty (est.)',   amt: 340000 },
    { label: 'Clearing (est.)',       amt: 62000 },
  ],
  landed: 2833500,
  drawdown: { no: 'DD-2511-08', amt: 600000, status: 'paid' },
};

// ── status → semantic tone ───────────────────────────────────────
export function orderTone(s) {
  if (['placed', 'shipped', 'in_transit'].includes(s)) return 'blue';
  if (['in_production', 'ready'].includes(s)) return 'yellow';
  if (['delivered', 'closed'].includes(s)) return 'green';
  if (s === 'cancelled') return 'red';
  return 'gray'; // quoted / intent
}
export function shipTone(s) {
  if (s === 'in_transit') return 'blue';
  if (s === 'customs') return 'yellow';
  if (['cleared', 'delivered'].includes(s)) return 'green';
  return 'gray';
}
export function ddTone(s) {
  if (s === 'requested') return 'yellow';
  if (s === 'partially_paid') return 'blue';
  if (['paid', 'settled'].includes(s)) return 'green';
  return 'gray';
}
export function ledgerTone(kind) { return kind === 'payment' ? 'green' : 'red'; }
export function docTone(type) {
  if (['PI', 'QC Report'].includes(type)) return 'blue';
  if (type === 'Packing List') return 'gray';
  if (type === 'Bill of Lading') return 'yellow';
  if (['Commercial Invoice', 'Wire Receipt'].includes(type)) return 'green';
  return 'gray';
}
export function roleTone(role) {
  if (['Finance Admin', 'Vendor Lead'].includes(role)) return 'yellow';
  if (['Operations', 'Logistics'].includes(role)) return 'blue';
  return 'gray'; // Viewer / Vendor
}
export function userStatusTone(s) { return s === 'active' ? 'green' : 'yellow'; }

// ── derived ledger math (never hard-code the totals) ─────────────
export function derive() {
  let running = 0;
  const rows = LEDGER.map((e) => { running += e.amt; return { ...e, balance: running }; });
  const balance = running;
  const credits = LEDGER.filter((e) => e.amt > 0).reduce((s, e) => s + e.amt, 0);
  const debits = LEDGER.filter((e) => e.amt < 0).reduce((s, e) => s + Math.abs(e.amt), 0);
  const provisional = balance - PENDING_COSTS;
  const bufferPct = Math.round((debits / credits) * 100);
  const owes = balance < 0;
  const peak = rows.reduce((m, r) => Math.max(m, r.balance), rows[0].balance);
  return { rows, balance, credits, debits, provisional, bufferPct, owes, peak };
}

export const openOrders = () => ORDERS.filter((o) => !['closed', 'delivered'].includes(o.status));
