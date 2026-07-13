// Uniware (Unicommerce) client. Auth lifted verbatim from odoops-worker getUniwareToken:
// OAuth password grant → access_token (~12h), cached in-module; API calls use `Authorization: bearer <t>`.
let _tok = null, _tokExp = 0;

export async function getUniwareToken(env, { fetchImpl = globalThis.fetch } = {}) {
  if (!env.UNIWARE_TENANT || !env.UNIWARE_USERNAME || !env.UNIWARE_PASSWORD)
    throw new Error('Uniware not configured (UNIWARE_TENANT/USERNAME/PASSWORD)');
  const now = Date.now();
  if (_tok && now < _tokExp - 60_000) return _tok;
  const qs = new URLSearchParams({
    grant_type: 'password', client_id: 'my-trusted-client',
    username: env.UNIWARE_USERNAME, password: env.UNIWARE_PASSWORD,
  });
  const res = await fetchImpl(`https://${env.UNIWARE_TENANT}.unicommerce.com/oauth/token?${qs}`,
    { headers: { 'Content-Type': 'application/json' } });
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) throw new Error('Uniware token failed: ' + JSON.stringify(t).slice(0, 160));
  _tok = t.access_token; _tokExp = now + (Number(t.expires_in) || 40000) * 1000;
  return _tok;
}

export async function checkServiceability(env, { pincode, cod = false }, deps = {}) {
  const { fetchImpl = globalThis.fetch } = deps;
  const token = await getUniwareToken(env, deps);
  const base = `https://${env.UNIWARE_TENANT}.unicommerce.com`;
  const res = await fetchImpl(`${base}/services/rest/v1/oms/saleOrder/getServiceability`, {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pincode, cashOnDelivery: !!cod }),
  });
  const body = await res.json().catch(() => ({}));
  const facilityCodes = Array.isArray(body.facilityCodes) ? body.facilityCodes : [];
  const serviceable = body.successful === true && facilityCodes.length > 0;
  return { serviceable, codAvailable: serviceable && !!cod, facilityCodes, raw: body };
}
