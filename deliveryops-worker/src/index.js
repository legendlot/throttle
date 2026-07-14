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
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/healthz') return json({ ok: true });
    // Shopify App Proxy forwards the base subpath (/apps/delivery-check) to the worker
    // as "/", and any deeper path as "/…/delivery-check"; accept both.
    if (path === '/' || path.endsWith('/delivery-check')) {
      return handleDeliveryCheck(request, env, {
        verify: (u) => verifyAppProxySignature(env.SHOPIFY_APP_PROXY_SECRET, u),
        cacheGet, cachePut, checkServiceability, delhiveryTransitDays,
        now: new Date(),
      });
    }
    return json({ error: 'not_found' }, 404);
  },
};
