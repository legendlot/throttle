'use client';
// Cross-entity search backed by the REAL read endpoints (not mock arrays).
// Lazy-loads each list once (perm-gated, each guarded) the first time the user
// searches, caches it, and filters client-side. Mirrors the prototype's
// grouped-dropdown UX; results navigate to the existing routes.
import { useRef, useState, useCallback } from 'react';
import { garageFetch } from '@throttle/db';

const enc = (v) => encodeURIComponent(v ?? '');

// Each entity: which perm gates it, which action loads it, how to match/label/route.
const ENTITIES = [
  { key: 'pos', label: 'Purchase Orders', icon: 'file-text', perm: 'procurement_view', action: 'getPOs',
    fields: p => [p.po_number, p.vendor_name, p.order_type, p.source, p.status],
    primary: p => p.po_number, secondary: p => p.vendor_name,
    route: p => `/procurement/pos/detail?po_number=${enc(p.po_number)}` },
  { key: 'sales', label: 'Sales Orders', icon: 'clipboard-list', perm: 'sales_view', action: 'getSalesOrders',
    fields: o => [o.order_no, o.partner_name, o.invoice_no, o.channel_key],
    primary: o => o.order_no, secondary: o => o.partner_name,
    route: o => `/sales/orders/detail?id=${enc(o.id)}` },
  { key: 'vendors', label: 'Vendors', icon: 'building-2', perm: 'vendor_manage', action: 'getVendors',
    fields: v => [v.vendor_code, v.vendor_name, v.category, v.source_country],
    primary: v => v.vendor_code, secondary: v => v.vendor_name,
    route: () => '/procurement/vendors' },
  { key: 'partners', label: 'Partners', icon: 'store', perm: 'sales_view', action: 'getSalesPartners',
    fields: p => [p.partner_code, p.name, p.channel_key, p.city, p.gstin],
    primary: p => p.partner_code, secondary: p => p.name,
    route: p => `/sales/partners/detail?id=${enc(p.id)}` },
  { key: 'requests', label: 'Requests', icon: 'inbox', perm: null, action: 'getRequests',
    fields: r => [r.request_no, r.title, r.category, r.requested_by_name],
    primary: r => r.request_no, secondary: r => r.title,
    route: r => `/requests/detail?request_no=${enc(r.request_no)}` },
  { key: 'reorders', label: 'Reorders', icon: 'refresh-cw', perm: 'procurement_view', action: 'getReorderRequests',
    fields: r => [r.request_id, r.part_code, r.part_name, r.product, r.requested_by],
    primary: r => r.request_id, secondary: r => (r.part_name || r.product || r.part_code || ''),
    route: () => '/procurement/reorders' },
  { key: 'assets', label: 'Assets', icon: 'boxes', perm: 'asset_view', action: 'getAssets',
    fields: a => [a.asset_code, a.name, a.category_name, a.location_name, a.custodian_name],
    primary: a => a.asset_code, secondary: a => a.name,
    route: a => `/assets/detail?id=${enc(a.id)}` },
  { key: 'forwarders', label: 'Forwarders', icon: 'truck', perm: 'vendor_manage', action: 'getForwarders',
    fields: f => [f.forwarder_code, f.company_name, f.country],
    primary: f => f.forwarder_code, secondary: f => f.company_name,
    route: () => '/procurement/forwarders' },
];

export function useGlobalSearch(session, perms) {
  const cache = useRef(null);       // { [key]: rows[] }
  const [ready, setReady] = useState(false);
  const loadingRef = useRef(false);

  const ensureLoaded = useCallback(async () => {
    if (cache.current || loadingRef.current || !session) return;
    loadingRef.current = true;
    const out = {};
    await Promise.all(ENTITIES.map(async (e) => {
      if (e.perm && perms && !perms[e.perm]) { out[e.key] = []; return; }
      try {
        const rows = await garageFetch(e.action, {}, session);
        out[e.key] = Array.isArray(rows) ? rows : [];
      } catch { out[e.key] = []; }
    }));
    cache.current = out;
    setReady(true);
  }, [session, perms]);

  // Returns grouped results for a query (≤5 per group). Empty until loaded.
  const runSearch = useCallback((query) => {
    const q = (query || '').trim().toLowerCase();
    if (!q || !cache.current) return [];
    const toks = q.split(/\s+/).filter(Boolean);
    const match = (fields) => {
      const hay = fields.map(f => (f == null ? '' : '' + f).toLowerCase());
      return toks.every(t => hay.some(h => h.includes(t)));
    };
    return ENTITIES.map(e => {
      const rows = cache.current[e.key] || [];
      const items = rows.filter(r => match(e.fields(r))).slice(0, 5).map(r => ({
        icon: e.icon, primary: e.primary(r), secondary: e.secondary(r), route: e.route(r),
      }));
      return { label: e.label, items };
    }).filter(g => g.items.length);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ensureLoaded, runSearch, ready };
}
