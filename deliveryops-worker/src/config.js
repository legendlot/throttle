// Central config. Defaults are the locked spec values; env vars override without a redeploy of logic.
export function loadConfig(env = {}) {
  const [h, m] = String(env.CUTOFF_HHMM || '14:00').split(':');
  const nwd = String(env.NON_WORKING_DAYS ?? '0')
    .split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return {
    originPin: env.ORIGIN_PINCODE || null,
    cutoffHour: Number(h),
    cutoffMin: Number(m || 0),
    nonWorkingDays: nwd.length ? nwd : [0],
    ttlMs: (Number(env.CACHE_TTL_HOURS) || 12) * 3600 * 1000,
    mode: env.SHIP_MODE === 'express' ? 'express' : 'surface',
    copy: {
      fallback: "Delivery in 5–7 days",
      unserviceable: "We don’t deliver to this pincode yet",
    },
  };
}
