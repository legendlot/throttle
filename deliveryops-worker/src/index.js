import { verifyAppProxySignature } from './proxy-auth.js';
import { checkServiceability } from './uniware.js';
import { delhiveryTransitDays } from './delhivery.js';
import { cacheGet, cachePut } from './cache.js';
import { handleDeliveryCheck } from './handler.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return json({ ok: true });
    if (url.pathname.endsWith('/delivery-check')) {
      return handleDeliveryCheck(request, env, {
        verify: (u) => verifyAppProxySignature(env.SHOPIFY_APP_PROXY_SECRET, u),
        cacheGet, cachePut, checkServiceability, delhiveryTransitDays,
        now: new Date(),
      });
    }
    return json({ error: 'not_found' }, 404);
  },
};
