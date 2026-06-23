import { normalizeDelhivery } from '../normalize.js';

const HOST = 'https://track.delhivery.com';     // production (staging host = staging-express.delhivery.com, V2)
const BATCH = 30;                                // Delhivery bulk cap = 30 AWBs/call

// Pull tracking for many AWBs. token → `Authorization: Token <token>` (NOT Bearer). verbose=2 required
// for the full scan timeline. Returns TrackResult[]; a failed batch is logged and skipped (others proceed).
export async function trackBulk(awbs, token) {
  const out = [];
  for (let i = 0; i < awbs.length; i += BATCH) {
    const batch = awbs.slice(i, i + BATCH);
    const url = `${HOST}/api/v1/packages/json/?verbose=2&waybill=${batch.map(encodeURIComponent).join(',')}`;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } });
    } catch (e) { console.error('delhivery fetch failed:', e?.message || e); continue; }
    if (!res.ok) { console.error(`delhivery ${res.status} for batch ${i}..${i + BATCH}`); continue; }
    let data;
    try { data = await res.json(); } catch { console.error('delhivery: non-JSON body'); continue; }
    for (const sd of (data.ShipmentData || [])) {
      const r = normalizeDelhivery(sd.Shipment);
      if (r && r.awb) out.push(r);
    }
  }
  return out;
}
