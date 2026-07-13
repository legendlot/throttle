// Delhivery Express EDD/TAT client. Sole job: destination transit days for the date.
// Host + auth are the repo convention (Authorization: Token <t>, NOT Bearer).
// ⚠ ENDPOINT + FIELDS: set from docs/delhivery-edd.md (Task 6). Defaults below are the best-known
//    shape; Task 10's live smoke corrects them if the portal shows different names.
const HOST = 'https://track.delhivery.com';
const EDD_INT_FIELDS = ['tat', 'expected_tat', 'estimated_delivery_days', 'transit_time', 'edd_days'];
const EDD_DATE_FIELDS = ['expected_delivery_date', 'edd', 'estimated_delivery_date'];

function firstRecord(body) {
  if (Array.isArray(body)) return body[0] || {};
  if (body && Array.isArray(body.data)) return body.data[0] || {};
  return body || {};
}
function istMidnight(now) {
  const ist = new Date(now.getTime() + 330 * 60000);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
}

export async function delhiveryTransitDays(env, { originPin, destPin, cod = false }, deps = {}) {
  const { fetchImpl = globalThis.fetch, now = new Date() } = deps;
  const qs = new URLSearchParams({ origin_pin: String(originPin), destination_pin: String(destPin), payment_type: cod ? 'COD' : 'Pre-paid' });
  const url = `${HOST}/api/dc/expected_tat?${qs}`;   // confirm/replace per docs/delhivery-edd.md
  let body;
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Token ${env.DELHIVERY_API_TOKEN}`, Accept: 'application/json' } });
    if (!res.ok) return null;
    body = await res.json();
  } catch { return null; }

  const rec = firstRecord(body);
  for (const f of EDD_INT_FIELDS) {
    const v = Number(rec[f]);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  for (const f of EDD_DATE_FIELDS) {
    if (rec[f]) {
      const t = Date.parse(rec[f]);
      if (!Number.isNaN(t)) {
        const eddMid = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
        const days = Math.ceil((eddMid - istMidnight(now)) / 86400000);
        if (days > 0) return days;
      }
    }
  }
  return null;
}
