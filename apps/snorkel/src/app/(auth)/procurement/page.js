'use client';
// Instant load (2026-11-14, Garage/Depot/Redline's pattern): one useCachedQuery per call —
// each section paints its last-known result from this tab's sessionStorage and fills in as
// its own call lands; a failure with nothing to show is an error + Retry, never zeros. Only
// what the page renders is held or cached (lib/overview.mjs says what is dropped and why).
// Not polled: refreshed on mount and when the tab returns after more than a minute hidden.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, getValidSession, useCachedQuery } from '@throttle/db';
import { Spinner, Skeleton } from '@throttle/ui';
import { ArrowRight, RefreshCw, Plus } from 'lucide-react';
import { PageHead, Kpi, Panel, Badge, Btn, Pipeline, EmptyState } from '@/components/ui.js';
import { fmtDateShort, money, inrCompact, PO_TONES, TONES, sourceTone, urgencyTone } from '@/components/format.js';
import { NAV_GROUPS, filterNavByPerms } from '../../../lib/nav.js';
import {
  slimReorders, slimPOs, arrivingCount, freshness, shouldRefreshOnReturn, poOverviewKey, rowsAreFresh,
} from '../../../lib/overview.mjs';

export default function ProcurementOverviewPage() {
  const { session, userId, perms } = useAuth();
  const router = useRouter();

  // One cached query per call, each the call + normalisation the page made before, slimmed to
  // what it renders. A failure THROWS (garageFetch, and the slimmers on a bad reply shape) —
  // it is never cached, and never shown as 0.
  // Nothing seeds or fetches until perms are known AND grant procurement_view: the cached-
  // identity auth path paints with perms still null, and a cached total must not show to a
  // viewer whose rights have since narrowed. The PO key also carries the price tier
  // (poOverviewKey). The token is read at call time — after a long hidden spell the session
  // this render closed over may have expired.
  const live = !!session && !!perms?.procurement_view;
  const qUser = perms?.procurement_view ? userId : null; // null = no identity → no seed
  const rrQ = useCachedQuery({ key: 'snorkel:overview:reorders', userId: qUser, enabled: live,
    fetcher: async () => slimReorders(await garageFetch('getReorderRequests', { status: 'Pending' }, await getValidSession())) });
  const poQ = useCachedQuery({ key: poOverviewKey(perms), userId: qUser, enabled: live,
    fetcher: async () => slimPOs(await garageFetch('getPOs', {}, await getValidSession())) });

  const refreshAll = () => { rrQ.refresh(); poQ.refresh(); };
  useEffect(() => { if (live) refreshAll(); }, [session, perms, live]); // eslint-disable-line

  // Convert acts on a reorder row, so it is offered only on rows from a successful fetch made
  // since this page mounted — never on cached rows, nor while they are being refreshed.
  const [mountedAt] = useState(() => Date.now());
  const rrActionable = rowsAreFresh(rrQ, mountedAt);

  // Back on the tab after more than a minute away → one refresh (shouldRefreshOnReturn).
  // Not attached at all for a viewer without access (live is false).
  const hiddenAt = useRef(null);
  useEffect(() => {
    if (!live) return undefined;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt.current = Date.now(); return; }
      const wasHiddenAt = hiddenAt.current;
      hiddenAt.current = null;
      if (shouldRefreshOnReturn(wasHiddenAt)) refreshAll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [live]); // eslint-disable-line

  const fresh = freshness([rrQ, poQ]);
  const has = (q) => q.data !== undefined;
  const failedEmpty = (q) => !!q.error && q.data === undefined;

  const rr = rrQ.data;
  const po = poQ.data;
  const poTruncated = !!po?.truncated;
  // "Arriving · 14d" is counted against the clock now, from the dates the PO query holds.
  const arriving = useMemo(() => arrivingCount(po?.arrivingDates), [po]);

  // This page is the app's DEFAULT LANDING (src/app/page.js hard-redirects here), so a user
  // whose role has no procurement permission used to get "Access restricted." as their very
  // first screen after signing in — Adnan, sales-only role, #bugs 2026-08-17 — and read it as
  // having no Snorkel access at all. Bounce them to the first section their permissions
  // actually show (nav order: Requests is everyone's front door). The restricted text stays
  // for direct navigation by someone with genuinely nothing else.
  const firstAllowed = useMemo(() => {
    if (!perms || perms.procurement_view) return null;
    const groups = filterNavByPerms(NAV_GROUPS, perms);
    return groups[0]?.items?.[0]?.route || null;
  }, [perms]);
  useEffect(() => {
    if (firstAllowed && firstAllowed !== '/procurement') router.replace(firstAllowed);
  }, [firstAllowed, router]);

  if (perms && !perms.procurement_view) {
    if (firstAllowed && firstAllowed !== '/procurement') return <Spinner />;
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  const rrLabel = (r) => r.request_type === 'part'
    ? `${r.part_code || ''} ${r.part_name || ''}`.trim() || '—'
    : [r.product, r.variant, r.color].filter(Boolean).join(' · ') || '—';

  return (
    <div className="pg">
      <PageHead title="Procurement" sub="What needs you now. Pending requests, open orders, and what's arriving."
        actions={<>
          <Btn onClick={() => router.push('/procurement/reorders')}><RefreshCw size={14} /> Reorders</Btn>
          {perms?.po_create && <Btn kind="primary" onClick={() => router.push('/procurement/pos/new')}><Plus size={14} /> New PO</Btn>}
        </>} />
      <div aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, minHeight: 16, marginTop: -12, marginBottom: 14, color: fresh.warn ? 'var(--orange-fg)' : 'var(--text-3)' }}>
        <span>{fresh.text}</span>
        {fresh.warn && <button type="button" onClick={refreshAll} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontSize: 12, textDecoration: 'underline' }}>Retry</button>}
      </div>

      <div className="kpi-row">
        {has(rrQ) ? <Kpi label="Open Requests" value={rr.count} sub="reorder queue" tone="yellow" onClick={() => router.push('/procurement/reorders')} />
          : failedEmpty(rrQ) ? <KpiError label="Open Requests" tone="yellow" onRetry={rrQ.refresh} />
          : <KpiSkeleton tone="yellow" />}
        {/* These three are counted from the loaded PO page. When that read is truncated the
            counts are floors, not totals — say so in `sub` rather than showing a bare number
            that reads as complete (S334). */}
        {has(poQ) ? <>
          <Kpi label="Open POs" value={po.openPO} sub={poTruncated ? 'in flight · partial' : 'in flight'} tone="blue" onClick={() => router.push('/procurement/pos')} />
          <Kpi label="To Approve" value={po.pendingApproval} sub={poTruncated ? 'awaiting sign-off · partial' : 'awaiting sign-off'} tone="orange" onClick={() => router.push('/procurement/pos')} />
          <Kpi label="Arriving · 14d" value={arriving} sub={poTruncated ? 'next 14 days · partial' : 'next 14 days'} tone="green" onClick={() => router.push('/procurement/pos')} />
        </> : failedEmpty(poQ) ? <>
          <KpiError label="Open POs" tone="blue" onRetry={poQ.refresh} />
          <KpiError label="To Approve" tone="orange" onRetry={poQ.refresh} />
          <KpiError label="Arriving · 14d" tone="green" onRetry={poQ.refresh} />
        </> : <>
          <KpiSkeleton tone="blue" /><KpiSkeleton tone="orange" /><KpiSkeleton tone="green" />
        </>}
      </div>

      <div className="ov-2col">
        <div className="ov-col">
          <Panel title="Pending Reorder Requests" count={rr?.count}
            action={<Btn onClick={() => router.push('/procurement/reorders')}>View all <ArrowRight size={14} /></Btn>}>
            {!has(rrQ) ? (failedEmpty(rrQ)
                ? <PanelError message="Could not load pending reorder requests." onRetry={rrQ.refresh} />
                : <TableSkeleton cols={5} />)
              : rr.top.length === 0 ? <EmptyState icon="check-check" title="Queue is clear" hint="New reorder requests will appear here." />
              : (
                <table className="dt">
                  <thead><tr><th>ID</th><th>Part / Product</th><th className="num">Qty</th><th>Urgency</th><th className="num"></th></tr></thead>
                  <tbody>
                    {rr.top.map((r) => (
                      <tr key={r.request_id}>
                        <td className="mono accent">{r.request_id}</td>
                        <td>{rrLabel(r)}</td>
                        <td className="num mono">{r.requested_qty} {r.unit || ''}</td>
                        <td><Badge label={r.urgency || 'Normal'} tone={urgencyTone(r.urgency)} dot /></td>
                        <td className="num">
                          {perms?.po_create && (rrActionable
                            ? <Btn kind="primary" onClick={() => router.push(`/procurement/pos/new?rr=${encodeURIComponent(r.request_id)}`)}>Convert</Btn>
                            : <span title="Updating the queue — Convert is available once it has refreshed"><Btn kind="primary" disabled>Convert</Btn></span>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Panel>

          <Panel title="Open Purchase Orders" count={po?.openList.length}
            action={<Btn onClick={() => router.push('/procurement/pos')}>View all <ArrowRight size={14} /></Btn>}>
            {!has(poQ) ? (failedEmpty(poQ)
                ? <PanelError message="Could not load open purchase orders." onRetry={poQ.refresh} />
                : <TableSkeleton cols={6} />)
              : po.openList.length === 0 ? <EmptyState icon="file-search" title="No open purchase orders" hint="Open POs will show up here." />
              : (
                <table className="dt">
                  <thead><tr><th>PO</th><th>Vendor</th><th>Source</th><th className="num">Value</th><th>Expected</th><th>Status</th></tr></thead>
                  <tbody>
                    {po.openList.map((p) => (
                      <tr key={p.po_number} className="row-click" onClick={() => router.push(`/procurement/pos/detail?po_number=${encodeURIComponent(p.po_number)}`)}>
                        <td className="mono accent">{p.po_number}</td>
                        <td>{p.vendor_name || '—'}</td>
                        <td><Badge label={p.source || '—'} tone={sourceTone(p.source)} soft={false} /></td>
                        <td className="num mono">{p.source === 'China' && !(perms?.po_china || perms?.po_china_view) ? <span className="dim">Restricted</span> : money(p.currency, p.po_value)}</td>
                        <td className="mono">{fmtDateShort(p.expected_delivery)}</td>
                        <td><Badge label={p.status || '—'} tone={PO_TONES[p.status] || 'gray'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Panel>
        </div>

        <div className="ov-col ov-side">
          <Panel title="Open PO Value" pad>
            <div className="ov-stat-row" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
              {has(poQ) ? <div><div className="ov-stat-v">{inrCompact(po.openValueInr)}</div><div className="ov-stat-l">≈ INR, all open</div></div>
                : failedEmpty(poQ) ? <PanelError message="Could not load open PO value." onRetry={poQ.refresh} />
                : <div aria-busy="true"><Skeleton width={110} height={26} /><Skeleton width={90} height={11} style={{ marginTop: 6 }} /></div>}
            </div>
          </Panel>
          <Panel title="PO Pipeline" pad>
            {has(poQ) ? <Pipeline stages={po.pipeline} />
              : failedEmpty(poQ) ? <PanelError message="Could not load the PO pipeline." onRetry={poQ.refresh} />
              : <PipelineSkeleton />}
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ── Loading / error states ────────────────────────────────────
// A failed section with nothing to fall back on says so — never zeros, never an empty state.
// A call that fails shows this; a call that hangs keeps its skeleton until the next refresh
// (Retry, or the tab returning) abandons it after 2 minutes (useCachedQuery's JOIN_MAX_MS).
function PanelError({ message, onRetry }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13, color: 'var(--text-3)', padding: 16 }}>
      <span>{message}</span>
      <Btn onClick={onRetry}>Retry</Btn>
    </div>
  );
}

// Same frame as <Kpi> (class, accent bar) so the row does not jump when it fills.
function KpiError({ label, tone, onRetry }) {
  return (
    <div className="kpi" style={{ '--kpi-accent': (TONES[tone] || TONES.gray).solid }}>
      <div className="kpi-top"><span className="kpi-label">{label}</span></div>
      <div style={{ fontSize: 13, color: 'var(--text-3)', margin: '12px 0 8px' }}>Couldn't load</div>
      <Btn onClick={onRetry}>Retry</Btn>
    </div>
  );
}

// Skeletons, each laid out like the content it stands in for.
function KpiSkeleton({ tone }) {
  return (
    <div className="kpi" aria-busy="true" style={{ '--kpi-accent': (TONES[tone] || TONES.gray).solid }}>
      <Skeleton width="55%" height={10} />
      <Skeleton width="40%" height={33} style={{ margin: '9px 0 4px' }} />
      <Skeleton width="60%" height={10} />
    </div>
  );
}

function TableSkeleton({ cols }) {
  return (
    <div aria-busy="true" style={{ padding: '10px 14px', display: 'grid', gap: 12 }}>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
          {Array.from({ length: cols }, (_, k) => <Skeleton key={k} width={k === 1 ? '90%' : '60%'} height={13} />)}
        </div>
      ))}
    </div>
  );
}

function PipelineSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'grid', gap: 12 }}>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 28px', gap: 10, alignItems: 'center' }}>
          <Skeleton width="80%" height={11} /><Skeleton height={8} /><Skeleton width="100%" height={11} />
        </div>
      ))}
    </div>
  );
}
