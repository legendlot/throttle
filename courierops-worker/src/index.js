import { trackBulk } from './adapters/delhivery.js';
import { TERMINAL_STAGES } from './normalize.js';

const SUPABASE_URL = 'https://jkxcnjabmrkteanzoofj.supabase.co';
const MAX_AWBS = 600;   // ≤20 bulk pulls + 1 RPC write per run — well under the 50-subrequest limit

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

// UTC ISO timestamp → IST calendar date (delivery_date is a date col; a 23:30 IST delivery is the IST day).
function istDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function sweep(env) {
  const key = env.SUPABASE_SERVICE_KEY;
  const token = env.DELHIVERY_API_TOKEN;
  if (!key || !token) { console.error('courierops: missing SUPABASE_SERVICE_KEY or DELHIVERY_API_TOKEN'); return; }

  // Delhivery shipments that carry an AWB, < 30 days old; terminal stages filtered JS-side below.
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  const q = `?select=id,tracking_number,tracking_status&courier_partner=eq.Delhivery&tracking_number=not.is.null`
    + `&created_at=gte.${cutoff}&order=tracking_synced_at.asc.nullsfirst&limit=${MAX_AWBS}`;
  const r = await sbPublic(key, `/rest/v1/dispatch_shipments${q}`);
  if (!r.ok) { console.error('courierops: shipment query failed', r.status, r.data); return; }

  const rows = Array.isArray(r.data) ? r.data : [];
  // Terminal filter in JS — deterministic, vs the fragile PostgREST or/not.in grammar.
  // A null tracking_status is not in TERMINAL_STAGES, so new shipments are correctly included.
  const open = rows.filter(s => !TERMINAL_STAGES.includes(s.tracking_status));
  if (!open.length) { console.log('courierops: no open Delhivery shipments'); return; }

  // AWB → shipment id (last one wins if an AWB somehow repeats; realistically 1:1).
  const byAwb = {};
  for (const row of open) byAwb[String(row.tracking_number).trim()] = row.id;
  const awbs = Object.keys(byAwb);

  const results = await trackBulk(awbs, token);
  const updates = results.map(res => {
    const id = byAwb[String(res.awb).trim()];
    if (!id) return null;
    return {
      id,
      tracking_status: res.stage,
      tracking_stage_label: res.stage_label,
      tracking_checkpoints: res.checkpoints,
      expected_delivery_date: res.expected_delivery_date,
      delivery_date: istDate(res.delivered_at),   // null unless terminal-delivered; RPC COALESCEs so manual stays
    };
  }).filter(Boolean);

  if (!updates.length) { console.log('courierops: nothing to update'); return; }
  const w = await sbPublic(key, '/rest/v1/rpc/apply_courier_tracking',
    { method: 'POST', body: JSON.stringify({ updates }) });
  if (!w.ok) console.error('courierops: apply RPC failed', w.status, w.data);
  else console.log(`courierops: updated ${w.data} of ${updates.length} (${open.length} open)`);
}

export default {
  async scheduled(event, env, ctx) {
    try { await sweep(env); }
    catch (e) { console.error('courierops cron failed:', e?.message || e); }
  },
};
