import { extractB2BTrack } from '../normalize.js';

// Delhivery B2B / LTL API. Auth = UMS login → JWT (valid 24h), used as `Authorization: Bearer <jwt>`.
// Tracking = GET /lrn/track?lrnum=<LRN> (master shipment status only; NO scan history in the response).
// Prod host confirmed from the developer portal (`/forgot-password` doc uses it, no `-dev`).
const HOST = 'https://ltl-clients-api.delhivery.com';   // staging = ltl-clients-api-dev.delhivery.com (V2)

// POST /ums/login {username,password} → JWT. Throws on failure (login is the gate for the whole sweep).
// ⚠️ Don't call per-shipment — rate-limited + a wrong password locks the account for 10 min. courierops
//    logs in ONCE per cron run and reuses the JWT for every LRN that run.
export async function loginB2B(username, password) {
  const res = await fetch(`${HOST}/ums/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`delhivery /ums/login ${res.status}: ${text.slice(0, 300)}`);
  let body; try { body = JSON.parse(text); } catch { throw new Error('delhivery /ums/login: non-JSON body'); }
  // The token field name isn't documented publicly; accept the common candidates (confirm on live smoke).
  const jwt = body.jwt || body.token || body.access_token || body.accessToken
    || (body.data && (body.data.jwt || body.data.token || body.data.access_token));
  if (!jwt) throw new Error(`delhivery /ums/login: no token in response (${text.slice(0, 200)})`);
  return jwt;
}

// Track one LRN. Returns a TrackResult, or null on error/empty (caller skips it — others proceed).
export async function trackLrn(lrn, jwt) {
  const url = `${HOST}/lrn/track?lrnum=${encodeURIComponent(lrn)}`;   // master-only (omit all_wbns)
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' } });
  } catch (e) { console.error(`delhivery track ${lrn} fetch failed:`, e?.message || e); return null; }
  if (!res.ok) { console.error(`delhivery track ${lrn}: ${res.status}`); return null; }
  let data; try { data = await res.json(); } catch { console.error(`delhivery track ${lrn}: non-JSON body`); return null; }
  return extractB2BTrack(data, lrn);
}
