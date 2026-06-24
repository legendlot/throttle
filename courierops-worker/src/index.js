import { loginB2B, trackLrn } from './adapters/delhivery.js';
import { TERMINAL_STAGES, mergeCheckpoint } from './normalize.js';

const SUPABASE_URL = 'https://jkxcnjabmrkteanzoofj.supabase.co';
// Each LRN is its OWN subrequest now (B2B has no bulk track). Budget per run: 1 select + 1 login +
// N tracks + 1 RPC ≤ 50. Cap N at 45; overflow rolls to the next 30-min cron (ordered oldest-synced-first).
const MAX_LRNS = 45;
const FETCH_LIMIT = 400;   // pull a wider window (1 subrequest), filter terminal JS-side, then track the oldest 45

// service-role: sb_secret key sent as BOTH apikey and Authorization (not a JWT). public schema = no profile.
async function sbPublic(key, path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: opts.prefer || '',
    ...opts.headers,
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// UTC ISO → IST calendar date (delivery_date is a date col; a 23:30 IST delivery is the IST day).
function istDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function sweep(env) {
  const key = env.SUPABASE_SERVICE_KEY;
  const username = env.DELHIVERY_B2B_USERNAME;
  const password = env.DELHIVERY_B2B_PASSWORD;
  if (!key || !username || !password) {
    console.error('courierops: missing SUPABASE_SERVICE_KEY / DELHIVERY_B2B_USERNAME / DELHIVERY_B2B_PASSWORD');
    return;
  }

  // Delhivery shipments carrying an LRN (stored in tracking_number), < 30 days old. tracking_checkpoints
  // is fetched so we can ACCUMULATE the timeline (B2B track returns only the latest status). Oldest-synced
  // first so coverage rotates fairly across runs.
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  const q = `?select=id,tracking_number,tracking_status,tracking_checkpoints`
    + `&courier_partner=eq.Delhivery&tracking_number=not.is.null`
    + `&created_at=gte.${cutoff}&order=tracking_synced_at.asc.nullsfirst&limit=${FETCH_LIMIT}`;
  const r = await sbPublic(key, `/rest/v1/dispatch_shipments${q}`);
  if (!r.ok) { console.error('courierops: shipment query failed', r.status, r.data); return; }

  // Terminal filter in JS — a null tracking_status is not terminal, so new shipments are included.
  const open = (Array.isArray(r.data) ? r.data : [])
    .filter(s => !TERMINAL_STAGES.includes(s.tracking_status))
    .slice(0, MAX_LRNS);
  if (!open.length) { console.log('courierops: no open Delhivery shipments'); return; }

  let jwt;
  try { jwt = await loginB2B(username, password); }
  catch (e) { console.error('courierops: B2B login failed —', e?.message || e); return; }

  const observedIso = new Date().toISOString();   // one sync timestamp for every checkpoint added this run
  const updates = [];
  for (const s of open) {
    const lrn = String(s.tracking_number).trim();
    const res = await trackLrn(lrn, jwt);
    if (!res) continue;                            // fetch/parse error already logged; skip, others proceed
    updates.push({
      id: s.id,
      tracking_status: res.stage,
      tracking_stage_label: res.stage_label,
      tracking_checkpoints: mergeCheckpoint(s.tracking_checkpoints, res, observedIso),
      expected_delivery_date: res.expected_delivery_date,   // RPC COALESCEs — never nulls a manual entry
      delivery_date: istDate(res.delivered_at),             // null unless delivered; RPC COALESCEs
    });
  }

  if (!updates.length) { console.log('courierops: nothing to update'); return; }
  const w = await sbPublic(key, '/rest/v1/rpc/apply_courier_tracking',
    { method: 'POST', body: JSON.stringify({ updates }) });
  if (!w.ok) console.error('courierops: apply RPC failed', w.status, w.data);
  else console.log(`courierops: updated ${w.data} of ${updates.length} (${open.length} open this run)`);
}

export default {
  async scheduled(event, env, ctx) {
    try { await sweep(env); }
    catch (e) { console.error('courierops cron failed:', e?.message || e); }
  },
};
