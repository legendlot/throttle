// Voice adapter — LimeChat connector (S400, 2026-09-25). THE ONLY vendor-specific outbound code
// in the voice channel: everything else (who is called, when, the gate, the ledger, what an
// outcome does) is Relay's and lives in ../voice.js. A second voice vendor = a second adapter.
//
// LimeChat's Custom Events API starts one of their flows; the flow places the call on their
// telephony (Vobiz — LC Q&A 2026-09-24 Q3; NOT Exotel as Pruthvi said on 09-03). The event NAME
// selects the flow on their side, so it is one name per purpose: `relay_<purpose>_call`.
// `data.call_ref` is the id of our comms.voice_calls row — LimeChat must echo it back on the
// call-started and call-ended webhooks. That echo is how an outcome is allowed to act.
//
// INERT until LIMECHAT_UAT + LIMECHAT_ACCOUNT_ID are set (wrangler secrets): returns
// `limechat_not_configured` and the caller records request_failed — nothing is dialled.
const CVF_URL = 'https://flow-builder.limechat.ai/api/v1/cvf-events';
const TIMEOUT_MS = 10_000;

function isConfigured(env) { return !!(env.LIMECHAT_UAT && env.LIMECHAT_ACCOUNT_ID); }

function eventName(purpose) { return `relay_${purpose}_call`; }

// Build the request body. Pure — exported for tests so the wire shape is pinned.
function buildRequest({ callRef, phone, profileId, purpose, flow, context }) {
  return {
    distinct_id: profileId || phone,
    phone,
    event: eventName(purpose),
    data: { ...(context || {}), call_ref: callRef, purpose, flow: flow || null },
  };
}

async function requestCall(env, args, fetchImpl = fetch) {
  if (!isConfigured(env)) return { ok: false, error: 'limechat_not_configured' };
  let res;
  try {
    res = await fetchImpl(CVF_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-limechat-uat': env.LIMECHAT_UAT,
        'x-fb-account-id': env.LIMECHAT_ACCOUNT_ID,
      },
      body: JSON.stringify(buildRequest(args)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `limechat_unreachable:${e?.name || 'error'}` };
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _text: text.slice(0, 500) }; }
  if (!res.ok) return { ok: false, error: `limechat_http_${res.status}`, data };
  return { ok: true, data };
}

module.exports = { requestCall, buildRequest, eventName, isConfigured, CVF_URL };
