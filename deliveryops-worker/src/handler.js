import { loadConfig } from './config.js';
import { dispatchDate, addTransit, formatEdd } from './edd.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
// Build a state payload from a (serviceable, transit_days) pair + config + now.
function render(serviceable, transitDays, codAvailable, cfg, now) {
  if (!serviceable) return { state: 'unserviceable', message: cfg.copy.unserviceable };
  if (transitDays == null) return { state: 'fallback', message: cfg.copy.fallback };
  const day = addTransit(dispatchDate(now, cfg), transitDays);
  return { state: 'date', message: `Get it by ${formatEdd(day)}`, edd: formatEdd(day), transit_days: transitDays, cod_available: !!codAvailable };
}

export async function handleDeliveryCheck(request, env, deps) {
  const { verify, cacheGet, cachePut, checkServiceability, tatDays, now = new Date() } = deps;
  const cfg = loadConfig(env);
  const url = new URL(request.url);

  if (!(await verify(url))) return json({ error: 'bad_signature' }, 401);

  const pincode = (url.searchParams.get('pincode') || '').trim();
  if (!/^\d{6}$/.test(pincode)) return json({ error: 'bad_pincode' }, 400);
  const cod = url.searchParams.get('cod') === '1';

  const cached = await cacheGet(env, { pincode, cod }, { now, ttlMs: cfg.ttlMs });
  if (cached) return json(render(cached.serviceable, cached.transit_days, cached.cod_available, cfg, now));

  // Uniware: can we deliver + COD?
  let svc;
  try { svc = await checkServiceability(env, { pincode, cod }); }
  catch { return json(render(true, null, false, cfg, now)); } // OMS blip → optimistic fallback, don't block PDP
  if (!svc.serviceable) {
    await cachePut(env, { pincode, cod, serviceable: false, cod_available: false, source: 'unserviceable', transit_days: null });
    return json(render(false, null, false, cfg, now));
  }

  // Delhivery: the date.
  const transitDays = tatDays(pincode, cfg.mode);
  await cachePut(env, {
    pincode, cod, serviceable: true, cod_available: svc.codAvailable,
    source: transitDays == null ? 'fallback' : 'delhivery', transit_days: transitDays,
  });
  return json(render(true, transitDays, svc.codAvailable, cfg, now));
}
