// Garage, Redline and Depot tools: READ-ONLY, as the person (own Supabase JWT) over the LOTOPS binding
// (lotopsproxy, the one worker all three apps share). Afshaan 2026-11-09 asked for all three.
//
// ⚠️ The GATEWAY is the gate. lotopsproxy's GET switch only requires a users_profile role; ~108 of its
// ~140 reads check no permission at all, because the apps' MENUS hide the screens. So every report here
// carries the permission key of the app screen that shows it (garage/src/lib/nav.js, redline/src/lib/nav.js;
// Depot's nav has no gates, so its baseline is `dashboard`), read from store.mcp_gate ops_perms (the
// global role's store.roles.permissions, exactly as lotopsproxy verifyJWT reads them), with the apps'
// own hasPermission truthiness ('view' and 'write' both pass).
// Not served: users/roles/devices/activity log, exports and downloads, print data, signed document URLs,
// company addresses, vendors, POs (Snorkel serves POs with its China strip; getUpcomingShipments is PO data
// and was removed on review), and any cost, price or money field (dropped by key).
// Gates are the app screen's or STRICTER (violations/qc/plan_vs_actual are reachable on looser screens in the
// app; screen-less reports got the nearest sensible key) — never looser.
import { T, reportTool } from './build.js';

const op = g => (g && g.ops_perms && typeof g.ops_perms === 'object') ? g.ops_perms : {};
// @throttle/auth hasPermission, verbatim: level keys pass unless 'none'; flag keys must be exactly true.
const LEVEL_KEYS = new Set(['stock', 'grn', 'receiving', 'work_order', 'stock_issue', 'returns']); // packages/auth/permissions.js
const hasPermission = (p, k) => (LEVEL_KEYS.has(k) ? !!p[k] && p[k] !== 'none' : p[k] === true);
const has = (...keys) => g => keys.some(k => hasPermission(op(g), k));

// Contact details, addresses, phones, bank fields and ALL free text (notes, remarks, reasons,
// references) are dropped at any depth; uuid `*_by` ids too (dropIds). Same rationale as Snorkel.
// Also money (costs, prices, rates, amounts, PO/invoice values: the gateway serves no cost data outside
// Odo P&L), vendors, warehouse/ship-to text (addresses get typed there), item descriptions, operator ids.
const OPS_DROP = /address|phone|mobile|email|contact|pincode|bank|ifsc|account_n|upi|swift|iban|warehouse|^so_ship_|city$|cost|price|^rate$|_rate$|amount|subtotal|_value$|invoice|payment|vendor|description|^(notes?|remarks|details|reference|reference_no|tracking_url|snapshot|comment|comments|assigned_to|operator_id)$|_(note|notes|reason|remarks|comment)$|_user_id$/i;
const COMMON = { binding: 'LOTOPS', scrubEmails: true, dropMatch: OPS_DROP, dropIds: true, reportDenied: 'ops denied' };
const range = { from: T.date, to: T.date };
// lotopsproxy names some ranges date_from/date_to or from_date/to_date: keep the gateway's from/to
// (defaults + bounds) and rename after.
const renameRange = (a, b) => p => { const { from, to, ...rest } = p; return { ...rest, [a]: from, [b]: to }; };
const textFilter = keys => (d, p) => {
  const rows = Array.isArray(d) ? d : [];
  const q = (p.q || '').trim().toLowerCase();
  const pc = (p.part_code || '').trim().toLowerCase();
  const out = rows.filter(r => (!pc || String(r.part_code || '').trim().toLowerCase() === pc)
    && (!q || keys.map(k => r[k] || '').join(' ').toLowerCase().includes(q)));
  return { rows: out, count: out.length };
};
const anyOf = reports => g => Object.values(reports).some(r => !r.allow || r.allow(g));
function opsTool(spec) {
  const t = reportTool({ ...COMMON, ...spec, visible: anyOf(spec.reports), deny: g => (anyOf(spec.reports)(g) ? null : 'ops denied') });
  return t;
}

const garageReports = {
  stock: { action: 'getStock', allow: has('stock'), about: 'part stock ledger (closing stock, reorder); give q or part_code', params: { q: T.text, part_code: T.code }, check: p => (p.q || p.part_code ? null : 'give `q` or `part_code` (about 3,000 parts: the full ledger is too long to return)'), shape: textFilter(['part_code', 'part_name', 'category']) },
  grns: { action: 'getGRNSummary', allow: has('grn'), about: 'goods receipt notes in a date range', params: { ...range, search: T.text, limit: T.int(1, 500) }, defaultDays: 7, maxDays: 92 },
  grn: { action: 'getGRNDetail', allow: has('grn'), about: 'one GRN with its lines', params: { grn_no: T.code }, required: ['grn_no'] },
  issues: { action: 'getIssues', allow: has('stock_issue'), about: 'store issues to runs (one row per part line) in a date range', params: { ...range, product: T.code, issue_type: T.text, q: T.text }, defaultDays: 7, maxDays: 31 },
  issue_lines: { action: 'getIssueLines', allow: has('stock_issue'), about: 'the part lines of one issue', params: { issue_no: T.code }, required: ['issue_no'] },
  return_shipments: { action: 'getReturnShipments', allow: has('returns'), about: 'inbound return shipments in a date range', params: { ...range }, defaultDays: 30, maxDays: 92 },
  returns_summary: { action: 'getReturnsSummary', allow: has('returns'), about: 'returned units by product/channel in a date range', params: { ...range }, defaultDays: 30, maxDays: 366 },
  return_pools: { action: 'getReturnPools', allow: has('returns'), about: 'return pools (repairable, UDR …) with unit counts', params: {} },
  gate_passes: { action: 'getGatePasses', allow: has('gate_pass'), about: 'gate passes (no phone numbers or remarks)', params: { ...range, direction: T.oneOf('inbound', 'outbound'), status: T.oneOf('active', 'void'), purpose: T.code, q: T.code }, defaultDays: 30, maxDays: 366, prep: renameRange('date_from', 'date_to') },
  producibility: { action: 'getProducibility', allow: has('dashboard'), about: 'how many units of each product can be built from stock, and the bottleneck parts', params: {} },
  alerts: { action: 'getGarageAlerts', allow: has('dashboard'), about: 'Garage alerts (low stock, pending work)', params: {} },
  bom: { action: 'getBOM', allow: has('dashboard'), about: 'bill of materials for one product (no prices)', params: { product: T.code }, required: ['product'] },
};
const redlineReports = {
  dashboard: { action: 'getProductionDashboard', allow: has('dashboard'), about: 'production overview for one day', params: { date: T.date } },
  hourly: { action: 'getHourlyProduction', allow: has('run_request'), about: 'hour-by-hour output for one day', params: { date: T.date } },
  daily: { action: 'getDailyProduction', allow: has('reports'), about: 'daily output per line in a date range', params: { ...range, line: T.text }, defaultDays: 7, maxDays: 92 },
  plan_vs_actual: { action: 'getPlanVsActual', allow: has('run_request'), about: 'planned vs actual output per line', params: { ...range, line: T.text }, maxDays: 31 },
  history: { action: 'getProductionHistory', allow: has('reports'), about: 'production history in a date range', params: { ...range }, defaultDays: 7, maxDays: 92 },
  output_by_format: { action: 'getOutputByFormat', allow: has('reports'), about: 'output split by pack format (ecomm/retail/export)', params: { ...range, line: T.text }, defaultDays: 7, maxDays: 92 },
  qc: { action: 'getQCView', allow: has('deviation_propose'), about: 'QC results and defects', params: { ...range, line: T.text }, maxDays: 31 },
  violations: { action: 'getViolationSummary', allow: has('deviation_propose'), about: 'process-violation summary', params: { ...range }, defaultDays: 7, maxDays: 92 },
  cycle_time: { action: 'getCycleTimeSummary', allow: has('reports'), about: 'cycle-time summary per station', params: { ...range }, defaultDays: 7, maxDays: 92 },
  runs: { action: 'getProductionRuns', allow: has('run_request'), about: 'production runs in a date range', params: { ...range, product: T.code, status: T.text, run_type: T.text, limit: T.int(1, 300) }, defaultDays: 14, maxDays: 92, prep: renameRange('date_from', 'date_to') },
  run: { action: 'getProductionRun', allow: has('run_request'), about: 'one production run in full', params: { run_no: T.code }, required: ['run_no'] },
  repair_queue: { action: 'getRepairQueue', allow: has('dashboard'), about: 'units waiting for repair', params: {} },
  unit_trace: { action: 'getScansByUpc', allow: has('dashboard'), about: 'every scan of one unit (by UPC), end to end', params: { upc: T.code }, required: ['upc'] },
};
const depotReports = {
  dashboard: { action: 'getDispatchDashboard', allow: has('dashboard'), about: 'dispatch overview in a date range', params: { ...range, channel_id: T.code, status: T.text }, maxDays: 92, prep: renameRange('date_from', 'date_to') },
  pipeline: { action: 'getDispatchPipeline', allow: has('dashboard'), about: 'the dispatch pipeline (requests → picked → packed → shipped)', params: {} },
  shipments: { action: 'getDispatchShipments', allow: has('dashboard'), about: 'outbound shipments', params: { channel_id: T.code, status: T.text } },
  shipped_by_channel: { action: 'getShippedByChannel', allow: has('dashboard'), about: 'units shipped per channel in a date range', params: { ...range }, defaultDays: 7, maxDays: 366, prep: renameRange('date_from', 'date_to') },
  allocated_by_channel: { action: 'getAllocatedByChannel', allow: has('dashboard'), about: 'units allocated per channel', params: {} },
  dispatch_stock: { action: 'getDispatchStock', allow: has('dashboard'), about: 'finished-goods stock available to dispatch', params: {} },
  fulfilment_requests: { action: 'getFulfilmentRequests', allow: has('dashboard'), about: 'fulfilment requests', params: { status: T.text } },
  fulfilment_request: { action: 'getFulfilmentRequest', allow: has('dashboard'), about: 'one fulfilment request', params: { id: T.code }, required: ['id'] },
  challans: { action: 'getDeliveryChallans', allow: has('dashboard'), about: 'delivery challans (no addresses or notes)', params: { ...range, status: T.code, q: T.code }, defaultDays: 30, maxDays: 366, prep: renameRange('from_date', 'to_date') },
  challan: { action: 'getDeliveryChallan', allow: has('dashboard'), about: 'one delivery challan with its lines', params: { challan_no: T.code }, required: ['challan_no'] },
  channels: { action: 'getDispatchChannels', allow: has('dashboard'), about: 'dispatch channels with ids', params: {} },
  stock_audits: { action: 'getDispatchAudits', allow: has('dashboard'), about: 'dispatch stock audits', params: { status: T.text } },
};

const opsTools = [
  opsTool({ system: 'garage', name: 'garage_store', title: 'Garage (store)', reports: garageReports,
    description: 'Read Garage, the store: part stock, GRNs, issues to runs, return shipments, returns, gate passes, producibility, alerts and BOMs. Each report needs the permission of the Garage screen that shows it (or a stricter one). No costs, prices, vendors, contacts, addresses or notes.',
    paramAbout: { q: 'Search text.', part_code: 'Part code (exact).', grn_no: 'GRN number.', issue_no: 'Issue number.', product: 'Product code.', search: 'Search text.' } }),
  opsTool({ system: 'redline', name: 'redline_production', title: 'Redline (production)', reports: redlineReports,
    description: 'Read Redline, the production floor: daily and hourly output, plan vs actual, QC, violations, cycle time, production runs, the repair queue and a unit\'s full scan trace. Each report needs the permission of the Redline screen that shows it (or a stricter one). Dates are IST.',
    paramAbout: { date: 'One day, YYYY-MM-DD (default today).', line: 'Line name/number.', run_no: 'Run number.', upc: 'The unit\'s UPC.', product: 'Product code.' } }),
  opsTool({ system: 'depot', name: 'depot_dispatch', title: 'Depot (dispatch)', reports: depotReports,
    description: 'Read Depot, dispatch: the dispatch dashboard and pipeline, outbound shipments, shipped and allocated per channel, dispatchable stock, fulfilment requests, delivery challans and stock audits. No money values, addresses, warehouse text or notes.',
    paramAbout: { channel_id: 'Dispatch channel id (from report=channels).', challan_no: 'Challan number.', id: 'The record id.' } }),
];
export default opsTools;
