'use client';
import { useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, useCachedQuery } from '@throttle/db';
import { Panel, KpiCard, ProductTag, ProgressBar, StatusBadge, EmptyState, Skeleton } from '@throttle/ui';
import { countPresent } from '@throttle/domain';
import {
  ListChecks, Inbox, Send, Undo2, AlertTriangle, Users,
  Zap, Target, Activity as ActivityIcon, ArrowRight, Route, TrendingUp,
} from 'lucide-react';

// Today's date in IST (YYYY-MM-DD) — the store attendance day.
function istToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';
import { useProducts } from '../../../hooks/useProducts.js';

// ════════════════════════════════════════════════════════════════════
// OVERVIEW (redesign S128) — the triage screen. "What needs me now."
// KPI rail (each tile links to its screen) + a prioritized "Needs Attention
// Now" feed that FOLDS the old standalone Alerts page (reorder flags +
// submitted runs awaiting issue) + Producibility + Recent Activity +
// Returns-by-channel. All wired to the EXISTING Garage endpoints
// (getDashboard, getReturnsSummary, getProductionRuns, getActivityLog,
// getOperatorAttendance) plus getKitAvailability (one call for the
// Producibility panel — was one calcKit per product until 2026-11-13).
// ════════════════════════════════════════════════════════════════════

// IST stamp for the freshness line: "21:04" today, "12 Nov 21:04" otherwise.
function istStamp(ms) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (day === istToday()) return hhmm;
  return `${d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${hhmm}`;
}

const fmt = (n) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-IN');

// Local-date string N days back, for a server-side date window. Built from the local
// calendar date rather than an ISO slice of a UTC timestamp: the floor works in IST, and
// toISOString() would roll the boundary back a day for anything before 05:30.
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The dashboard bar list is narrow, so the codes stay short here — the Reports tab spells
// them out in full. 'Not yet set' is kept verbatim: it is a real state (units awaiting a
// Store decision), not an unknown, and shortening it would read like a data gap.
const DISPO_SHORT = {
  UDR: 'UDR — re-dispatch',
  CXR: 'CXR — to repair',
  BRV: 'BRV — to repair',
  Loss: 'Loss — write-off',
};

function formatActivityTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

const ACT_TONE = {
  GRN: 'ok', WO: 'info', Issue: 'brand', Return: 'bad', Shipment: 'info',
  Flush: 'ok', PO: 'gray', Run: 'gray',
};
const SEV_FG = { bad: 'var(--bad-fg)', warn: 'var(--warn-fg)', info: 'var(--info-fg)', ok: 'var(--ok-fg)' };
const SEV_BADGE = { bad: 'error', warn: 'warning', info: 'info', ok: 'success' };

export default function OverviewPage() {
  const { session, userId } = useAuth();
  const router = useRouter();
  const { setRefreshing } = useRefreshState();
  const { PRODUCTS, loading: productsLoading } = useProducts();

  // One cached query per data source (instant-load pilot): each panel paints the
  // last-known result from this tab's sessionStorage straight away and fills in as its
  // own call returns, instead of the whole page waiting on the slowest of six. Each
  // fetcher is exactly the call + normalisation the page made before.
  const live = !!session;
  // total_stock_value is dropped before it is held or cached: nothing here reads it, and
  // a stock valuation has no business sitting in sessionStorage.
  // kpis + store-ops carry "today" figures, so their cache key carries the IST date: a tab
  // reopened after midnight must not seed yesterday's numbers under today's labels.
  const kpisQ = useCachedQuery({ key: `garage:dashboard:kpis:${istToday()}`, userId, enabled: live,
    fetcher: () => garageFetch('getDashboard', {}, session).then(d => {
      if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
      const rest = { ...d };
      delete rest.total_stock_value;
      return rest;
    }) });
  // ⚠️ Was getReturns → store.returns_log, the v1 table with ZERO rows. Returns v2
  // (RULE-RET-001, S104) moved to return_units and this panel was never repointed, so
  // it read "No returns in the last 30 days" against 6,517 real returns — for months,
  // and silently, because an empty panel looks like a quiet week rather than a fault.
  // Same 30-day window as before, now applied SERVER-side (it used to slice client-side
  // over whatever the 100-row cap returned).
  const returnsQ = useCachedQuery({ key: 'garage:dashboard:returns', userId, enabled: live,
    fetcher: () => garageFetch('getReturnsSummary', { from: daysAgoStr(30) }, session) });
  // A failure is an ERROR now, not an empty list: "0 awaiting issue" / "All clear" must
  // never stand on a call that did not answer.
  const runsQ = useCachedQuery({ key: 'garage:dashboard:submitted-runs', userId, enabled: live,
    fetcher: () => garageFetch('getProductionRuns', { status: 'Submitted' }, session).then(d => Array.isArray(d) ? d : []) });

  // ONE request for every product. This used to be one `calcKit` call per product — 64
  // requests every 60 s (measured 2026-11-13). The rules moved to the worker unchanged
  // (01_worker/lib/kitavail.js: bottleneck = the minimum, RULE-LUMP-001, platform rows,
  // format, split packaging); this only orders the answer for display. The RAW worker
  // rows are cached; the PRODUCTS ordering is derived below, so a late catalogue never
  // blanks the panel.
  const kitQ = useCachedQuery({ key: 'garage:dashboard:kit', userId, enabled: live,
    fetcher: () => garageFetch('getKitAvailability', {}, session) });

  const activityQ = useCachedQuery({ key: 'garage:dashboard:activity', userId, enabled: live,
    fetcher: async () => {
      try {
        const data = await garageFetch('getActivityLog', { limit: 8 }, session);
        return Array.isArray(data) ? data : [];
      } catch (e) {
        // By design the worker 403s `err('forbidden', 403)` for a user with neither
        // audit-log nor dashboard permission — that card stays the plain empty state, as
        // before. Any OTHER failure is an error the panel shows.
        if (e?.message === 'forbidden') return [];
        throw e;
      }
    } });

  // Distinct store-team operators with an attendance row today. Gated by
  // canManageFloor in the worker — degrade to null (shows "—") on no-access.
  const storeOpsQ = useCachedQuery({ key: `garage:dashboard:store-ops:${istToday()}`, userId, enabled: live,
    fetcher: async () => {
      try {
        const today = istToday();
        const res = await workerFetch('getOperatorAttendance', { data: { date_from: today, date_to: today, team: 'store' } }, session);
        if (!res.ok) return null;
        const rows = Array.isArray(res.data) ? res.data : [];
        // An attendance row is NOT the same as being present — see countPresent() in
        // @throttle/domain for the full rule and the five surfaces this was wrong on.
        return countPresent(rows);
      } catch { return null; }
    } });

  const mainQs = [kpisQ, returnsQ, runsQ];
  const allQs = [...mainQs, kitQ, activityQ, storeOpsQ];

  function loadAll() {
    if (!session) return;
    allQs.forEach(q => q.refresh());
  }

  useAutoRefresh(loadAll, 60000, !session);

  // Manual refresh from the topbar refresh button.
  useEffect(() => {
    const h = () => loadAll();
    window.addEventListener('garage:refresh', h);
    return () => window.removeEventListener('garage:refresh', h);
  }); // eslint-disable-line

  // The topbar spinner tracks the main calls, as it did when they were one Promise.all.
  const mainInFlight = mainQs.some(q => q.loading || q.refreshing);
  useEffect(() => { setRefreshing(mainInFlight); }, [mainInFlight]); // eslint-disable-line
  useEffect(() => () => setRefreshing(false), []); // eslint-disable-line

  // Same banner + message as before: any of the main calls failing.
  const mainError = mainQs.find(q => q.error)?.error?.message || null;

  const kpis = kpisQ.data ?? null;
  const submittedRuns = useMemo(() => runsQ.data ?? [], [runsQ.data]);
  const storeOps = storeOpsQ.data ?? null; // distinct store operators present today (null = unknown/no access)
  const activity = activityQ.data ?? [];
  const returnsRows = returnsQ.data;

  // PRODUCTS decides WHICH products show and breaks ties in the sort, as before.
  const producible = useMemo(() => {
    const data = kitQ.data;
    const byProduct = new Map((Array.isArray(data) ? data : []).map(r => [r.product, r]));
    return PRODUCTS.map(p => byProduct.get(p)).filter(Boolean).sort((a, b) => a.max - b.max);
  }, [kitQ.data, PRODUCTS]);
  // One call carries every product, so a failure must SAY so. Keep the last good rows on
  // a failed refresh; with none to keep, the panel shows the message below instead of
  // "Calculating…" forever.
  const producibleError = !!kitQ.error;

  // Per-panel readiness: no data yet → skeleton; a failure with no data → inline retry.
  const has = (q) => q.data !== undefined;
  const failedEmpty = (q) => !!q.error && q.data === undefined;
  const kpisReady = has(kpisQ) || failedEmpty(kpisQ);
  const runsReady = has(runsQ) || failedEmpty(runsQ);
  const attentionReady = kpisReady && runsReady;
  const attentionFailed = failedEmpty(kpisQ) || failedEmpty(runsQ);
  const returnsReady = has(returnsQ) || failedEmpty(returnsQ);
  const kitReady = (has(kitQ) && !productsLoading) || failedEmpty(kitQ);

  // Freshness: always the OLDEST data on the page. "Updating…" while anything is in
  // flight; "Couldn't refresh" when any call failed — with stale data showing OR with
  // none (a failed empty panel must not sit under a grey "Updated").
  const anyInFlight = allQs.some(q => q.loading || q.refreshing);
  const stamps = allQs.map(q => q.updatedAt).filter(Boolean);
  const oldest = stamps.length ? istStamp(Math.min(...stamps)) : null;
  const anyFailed = allQs.some(q => q.error);
  const freshness = anyInFlight ? (oldest ? `Updating… (showing ${oldest})` : 'Updating…')
    : anyFailed ? (oldest ? `Couldn't refresh — showing ${oldest}` : "Couldn't refresh")
    : oldest ? `Updated ${oldest}` : '';

  const reorderFlags = Array.isArray(kpis?.reorder_flags) ? kpis.reorder_flags : [];
  const reorderCount = kpis?.reorder_count ?? reorderFlags.length;

  // ── Needs Attention Now — folds the old Alerts page ──────────────────
  const attention = useMemo(() => {
    const out = [];
    reorderFlags.forEach((r, i) => out.push({
      id: 'ro-' + i, sev: 'bad', kind: 'Reorder',
      title: `${r.part_name || r.part_code} below reorder`,
      meta: `${fmt(r.closing_stock ?? 0)} on hand · reorder at ${fmt(r.reorder_level ?? 0)}${r.product ? ' · ' + r.product : ''}`,
      action: 'Review', route: '/stock',
    }));
    submittedRuns.forEach((r, i) => out.push({
      id: 'sr-' + i, sev: 'warn', kind: 'Issue',
      title: `${r.run_no} awaiting issue — ${fmt(r.units)} units`,
      meta: `${r.product || '—'}${r.run_date ? ' · ' + r.run_date : ''}`,
      action: 'Start pick', route: '/issue-queue',
    }));
    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    return out.sort((a, b) => order[a.sev] - order[b.sev]);
  }, [reorderFlags, submittedRuns]);

  const urgentCount = attention.filter(a => a.sev === 'bad').length;
  const visibleAttention = attention.slice(0, 8);

  // ── Returns by disposition (last 30d) ────────────────────────────────
  // Disposition, not channel: v2 records where a returned unit is GOING (UDR back out,
  // CXR/BRV to repair, Loss written off), and has no channel at all. The worker already
  // aggregates and applies the window, so this only shapes it for the bar list.
  const returnsByDisposition = useMemo(() => (returnsRows || [])
    .map((r) => [DISPO_SHORT[r.disposition] || r.disposition, Number(r.units) || 0])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6), [returnsRows]);
  const returnsMax = returnsByDisposition.length ? Math.max(...returnsByDisposition.map(([, q]) => q)) : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 5 }}>Garage · Triage</div>
          <h1 className="title" style={{ fontSize: 27, lineHeight: 1, margin: 0 }}>Overview</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span aria-live="polite" style={{ fontSize: 12, color: anyFailed && !anyInFlight ? 'var(--warn-fg)' : 'var(--t3)' }}>{freshness}</span>
          <span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>{kpis?.as_of || ''}</span>
        </div>
      </div>

      {mainError && (
        <Panel style={{ marginBottom: 16 }}>
          <EmptyState message={mainError} />
          <div style={{ textAlign: 'center', paddingTop: 12 }}>
            <button onClick={loadAll} style={{ background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 14px', borderRadius: 'var(--r-sm)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Retry</button>
          </div>
        </Panel>
      )}

          {/* KPI rail */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 12, marginBottom: 18 }}>
            {kpisReady && runsReady ? <KpiCard eyebrow="Open Work Orders" value={kpis?.open_work_orders ?? '—'} tone="brand" icon={ListChecks} sub={`${failedEmpty(runsQ) ? '—' : fmt(submittedRuns.length)} awaiting issue`} onClick={() => router.push('/issue-queue')} /> : <KpiSkeleton />}
            {kpisReady ? <KpiCard eyebrow="Today's GRNs" value={kpis?.today_grn_count ?? '—'} tone="info" icon={Inbox} sub="received today" onClick={() => router.push('/grn')} /> : <KpiSkeleton />}
            {kpisReady ? <KpiCard eyebrow="WOs Issued Today" value={kpis?.today_wo_count ?? '—'} tone="ok" icon={Send} sub="store issues" onClick={() => router.push('/store-history')} /> : <KpiSkeleton />}
            {kpisReady ? <KpiCard eyebrow="Pending Returns" value={kpis?.pending_returns ?? '—'} tone="warn" icon={Undo2} sub="to process" onClick={() => router.push('/returns/shipments')} /> : <KpiSkeleton />}
            {/* With no KPI data at all (failed load) the count is unknown — '—', never a false 0. */}
            {kpisReady ? <KpiCard eyebrow="Reorder Flags" value={failedEmpty(kpisQ) ? '—' : (reorderCount ?? '—')} tone={failedEmpty(kpisQ) ? undefined : (reorderCount > 0 ? 'bad' : 'ok')} icon={AlertTriangle} sub="parts at reorder" onClick={() => router.push('/stock')} /> : <KpiSkeleton />}
            {has(storeOpsQ) ? <KpiCard eyebrow="Store Present" value={storeOps ?? '—'} tone="info" icon={Users} sub="operators today" onClick={() => router.push('/manpower')} /> : <KpiSkeleton />}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
            {/* LEFT — attention + producibility */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Panel title="Needs Attention Now" icon={Zap} padding={0}
                action={!attentionReady || attentionFailed ? null : urgentCount > 0 ? <StatusBadge variant="error">{urgentCount} urgent</StatusBadge> : <StatusBadge variant="success">All clear</StatusBadge>}>
                {!attentionReady ? <RowsSkeleton rows={3} /> : attentionFailed ? (
                  <PanelError message={failedEmpty(kpisQ) ? 'Could not load reorder flags.' : 'Could not load the issue queue.'} onRetry={() => { kpisQ.refresh(); runsQ.refresh(); }} pad="20px 14px" />
                ) : <>
                {visibleAttention.length === 0 ? (
                  <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--t3)', fontSize: 13.5 }}>Nothing needs you right now — reorder levels and the issue queue are clear.</div>
                ) : visibleAttention.map((a, i) => (
                  <button key={a.id} onClick={() => router.push(a.route)} style={{
                    width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13,
                    padding: '12px 14px', cursor: 'pointer', background: 'transparent', border: 'none',
                    borderBottom: i < visibleAttention.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: SEV_FG[a.sev] }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                        <StatusBadge variant={SEV_BADGE[a.sev]}>{a.kind}</StatusBadge>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>
                      </div>
                      <div className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{a.meta}</div>
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t2)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {a.action}<ArrowRight size={13} strokeWidth={1.75} />
                    </span>
                  </button>
                ))}
                {attention.length > visibleAttention.length && (
                  <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--t3)', borderTop: '1px solid var(--border)' }}>+ {attention.length - visibleAttention.length} more need attention</div>
                )}
                </>}
              </Panel>

              <Panel title="Producibility" icon={Target}
                action={<button onClick={() => router.push('/producibility')} style={linkBtn}>View all<ArrowRight size={12} strokeWidth={1.75} /></button>}>
                {!kitReady ? <TilesSkeleton /> : producible.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--t3)', padding: '6px 2px' }}>
                    {producibleError ? 'Could not load producible units. It will retry on the next refresh.' : 'Calculating producible units…'}
                    {producibleError && <button onClick={kitQ.refresh} style={{ ...retryBtn, marginLeft: 12 }}>Retry</button>}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: 10 }}>
                    {producible.slice(0, 6).map(p => {
                      const tone = p.max <= 50 ? 'bad' : p.max <= 150 ? 'warn' : 'ok';
                      return (
                        <div key={p.product} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '11px 12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                            <ProductTag name={p.product} />
                            <span className="num" style={{ fontSize: 17, fontWeight: 600, color: SEV_FG[tone] }}>{fmt(p.max)}</span>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>Limited by <span style={{ color: 'var(--t2)' }}>{p.bottleneck}</span></div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Panel>
            </div>

            {/* RIGHT — returns mini + recent activity */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Panel title="Returns by Disposition" icon={TrendingUp}
                action={<button onClick={() => router.push('/returns/shipments')} style={linkBtn}>Open<ArrowRight size={12} strokeWidth={1.75} /></button>}>
                {!returnsReady ? <BarsSkeleton /> : failedEmpty(returnsQ) ? (
                  <PanelError message="Could not load returns." onRetry={returnsQ.refresh} />
                ) : returnsByDisposition.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--t3)' }}>No returns in the last 30 days.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                    {returnsByDisposition.map(([ch, qty]) => (
                      <div key={ch}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
                          <Route size={14} strokeWidth={1.75} style={{ color: 'var(--info-fg)' }} />
                          <span style={{ flex: 1, fontSize: 13, color: 'var(--t2)' }}>{ch}</span>
                          <span className="num" style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>{fmt(qty)}</span>
                        </div>
                        <ProgressBar value={qty} target={returnsMax} tone="bad" height={6} />
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Recent Activity" icon={ActivityIcon} padding={0}
                action={<button onClick={() => router.push('/activity')} style={linkBtn}>All<ArrowRight size={12} strokeWidth={1.75} /></button>}>
                {failedEmpty(activityQ) ? (
                  <PanelError message="Could not load recent activity." onRetry={activityQ.refresh} pad="20px 14px" />
                ) : !has(activityQ) ? <RowsSkeleton rows={4} /> : activity.length === 0 ? (
                  <div style={{ padding: '20px 14px', fontSize: 13, color: 'var(--t3)' }}>No recent activity.</div>
                ) : activity.map((e, i) => {
                  const tone = ACT_TONE[e.entity_type] || 'gray';
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '11px 14px', borderBottom: i < activity.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 6, flexShrink: 0, background: SEV_FG[tone] || 'var(--t4)' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.summary || e.message || '—'}</div>
                        <div className="num" style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{e.actor || 'System'} · {formatActivityTime(e.logged_at || e.created_at)}</div>
                      </div>
                    </div>
                  );
                })}
              </Panel>
            </div>
          </div>
    </div>
  );
}

const retryBtn = { background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 14px', borderRadius: 'var(--r-sm)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' };

// A failed panel with nothing to fall back on says so — never zeros, never a skeleton
// that spins forever.
function PanelError({ message, onRetry, pad }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13, color: 'var(--t3)', padding: pad }}>
      <span>{message}</span>
      <button onClick={onRetry} style={retryBtn}>Retry</button>
    </div>
  );
}

// Skeletons, each laid out like the content it stands in for.
function KpiSkeleton() {
  return (
    <div aria-busy="true" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, boxShadow: 'var(--shadow-card)' }}>
      <Skeleton width="60%" height={11} />
      <Skeleton width="40%" height={26} />
      <Skeleton width="70%" height={12} />
    </div>
  );
}

function RowsSkeleton({ rows }) {
  return (
    <div aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 14px', borderBottom: i < rows - 1 ? '1px solid var(--border)' : 'none' }}>
          <Skeleton width={8} height={8} radius="50%" />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton width="65%" height={13} />
            <Skeleton width="40%" height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

function TilesSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: 10 }}>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Skeleton width="45%" height={16} />
            <Skeleton width={36} height={17} />
          </div>
          <Skeleton width="70%" height={11} />
        </div>
      ))}
    </div>
  );
}

function BarsSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
            <Skeleton width="50%" height={13} />
            <span style={{ flex: 1 }} />
            <Skeleton width={28} height={14} />
          </div>
          <Skeleton height={6} radius={9999} />
        </div>
      ))}
    </div>
  );
}

const linkBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)' };
