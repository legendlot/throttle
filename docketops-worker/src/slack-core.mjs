// F9 R7 prep — the Docket Slack app's Events endpoint, so the app can be created WITH its event subscriptions
// (Slack verifies this URL at creation, before the signing secret exists). Until R7 it only answers the
// url_verification handshake and acknowledges events; it reads, stores and acts on nothing. Once
// SLACK_DOCKET_SIGNING_SECRET is set, every non-handshake request must carry a valid v0 signature within
// the 5-minute window, else 401.
export async function slackEvents(request, env) {
  const raw = await request.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { return new Response('bad_request', { status: 400 }); }
  if (body && body.type === 'url_verification' && typeof body.challenge === 'string' && body.challenge.length <= 200) {
    return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } });
  }
  const secret = env.SLACK_DOCKET_SIGNING_SECRET;
  if (secret && !(await slackSignatureOk(request, raw, secret))) return new Response('bad_signature', { status: 401 });
  return new Response('', { status: 200 });   // acknowledged; handled from R7
}
export async function slackSignatureOk(request, raw, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const ts = request.headers.get('x-slack-request-timestamp') || '';
  const sig = request.headers.get('x-slack-signature') || '';
  if (!/^\d+$/.test(ts) || Math.abs(nowSec - Number(ts)) > 300 || !sig.startsWith('v0=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${raw}`)));
  const want = 'v0=' + [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
