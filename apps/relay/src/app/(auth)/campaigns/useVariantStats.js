'use client';
// A/B results data hook (S272 UI). Wraps getVariantStats behind {stats, loading, error, reload}
// for VariantProgress.js and VariantResults.js.
//
// Keyed on userId, NOT the session object — copied from apps/relay/src/app/(auth)/links/page.js,
// which documents the same fix: onAuthStateChange re-fires on every tab switch and a real token
// refresh lands ~hourly, so an effect keyed on `session` reloads (and can blow away in-progress
// input) that often. userId only changes on an actual sign-in/sign-out. A fresh session is read
// inside the load call via getValidSession() instead of being closed over.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, getValidSession } from '@throttle/db';

export function useVariantStats(campaignId) {
  const { userId } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!campaignId) { setStats(null); setLoading(false); return; }
    try {
      const session = await getValidSession();
      if (!session) return;
      const r = await garageFetch('getVariantStats', { id: campaignId }, session);
      setStats(r || null);
      setError(null);
    } catch (e) {
      setError(e.message || 'Could not load A/B results');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    if (!userId || !campaignId) { setLoading(false); return; }
    setLoading(true);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, campaignId]);

  return { stats, loading, error, reload };
}

// Zips the RPC's raw per-arm row (assigned/sent/delivered/... — numerics arrive as STRINGS from
// PostgREST) with ab-stats.verdict()'s already-coerced computed arm (readRate etc.) into one
// object, so VariantProgress and VariantResults don't each re-derive the same Number() coercions.
export function mergeVariantArms(stats) {
  const raw = Array.isArray(stats?.arms) ? stats.arms : [];
  const computed = Array.isArray(stats?.verdict?.arms) ? stats.verdict.arms : [];
  return raw.map((r, i) => {
    const v = computed.find((c) => c.label === r.label) || computed[i] || {};
    return {
      variantId: r.variant_id,
      label: r.label,
      templateId: r.template_id,
      weight: Number(r.weight) || 0,
      assigned: Number(r.assigned) || 0,
      sent: Number(r.sent) || 0,
      delivered: Number(r.delivered) || 0,
      read: Number(r.read_count) || 0,
      preSendFailed: v.preSendFailed ?? (Number(r.pre_send_failed) || 0),
      providerFailed: v.providerFailed ?? (Number(r.provider_failed) || 0),
      skipped: Number(r.skipped) || 0,
      cost: Number(r.cost) || 0,
      lastSentAt: r.last_sent_at || null,
      failReasons: (r.fail_reasons && typeof r.fail_reasons === 'object') ? r.fail_reasons : {},
      readRate: v.readRate ?? null,                     // PRIMARY — read ÷ sent (ITT)
      readRateOfDelivered: v.readRateOfDelivered ?? null, // diagnostic only
      preSendFailRate: v.preSendFailRate ?? null,
    };
  });
}
