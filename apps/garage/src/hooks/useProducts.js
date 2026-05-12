// apps/garage/src/hooks/useProducts.js
// TD-021 resolution: product catalogue driven from bom_current + product_master.
// Replaces hardcoded PRODUCT_VARIANTS / PRODUCT_SUBVARIANTS constants.
'use client';
import { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';

export function useProducts() {
  const { session } = useAuth();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    garageFetch('getProductCatalogue', {}, session)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [session]);

  const PRODUCTS         = data?.products || [];
  const PRODUCT_VARIANTS = data?.variants  || {};
  const PRODUCT_COLORS   = data?.colors    || {}; // { product: { model: [color, ...] } }
  const HAS_REMOTE       = new Set(
    Object.entries(data?.has_remote || {})
      .filter(([, v]) => v)
      .map(([k]) => k),
  );

  return { PRODUCTS, PRODUCT_VARIANTS, HAS_REMOTE, PRODUCT_COLORS, loading };
}
