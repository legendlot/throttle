'use client';
import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Panel, KpiCard, ProductTag, ProgressBar, StatusBadge, EmptyState, Spinner } from '@throttle/ui';
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
// (getDashboard, getGRNSummary, getIssues, getReturns, getShipments,
// getProductionRuns, calcKit, getActivityLog) — no new backend.
// ════════════════════════════════════════════════════════════════════

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
  const { session } = useAuth();
  const router = useRouter();
  const { setRefreshing } = useRefreshState();
  const { PRODUCTS, loading: productsLoading } = useProducts();

  const [kpis, setKpis] = useState(null);
  const [sections, setSections] = useState({ grns: [], issues: [], returns: [], shipments: [] });
  const [submittedRuns, setSubmittedRuns] = useState([]);
  const [producible, setProducible] = useState([]);
  const [activity, setActivity] = useState([]);
  const [storeOps, setStoreOps] = useState(null); // distinct store operators present today (null = unknown/no access)
  const [mainLoading, setMainLoading] = useState(true);
  const [mainError, setMainError] = useState(null);

  async function loadMain() {
    setRefreshing(true); setMainError(null);
    try {
      const [kpisRes, grnsRes, issuesRes, returnsRes, shipRes, subRuns] = await Promise.all([
        garageFetch('getDashboard',  {}, session),
        garageFetch('getGRNSummary', {}, session),
        garageFetch('getIssues',     {}, session),
        // ⚠️ Was getReturns → store.returns_log, the v1 table with ZERO rows. Returns v2
        // (RULE-RET-001, S104) moved to return_units and this panel was never repointed, so
        // it read "No returns in the last 30 days" against 6,517 real returns — for months,
        // and silently, because an empty panel looks like a quiet week rather than a fault.
        // Same 30-day window as before, now applied SERVER-side (it used to slice client-side
        // over whatever the 100-row cap returned).
        garageFetch('getReturnsSummary', { from: daysAgoStr(30) }, session),
        garageFetch('getShipments',  {}, session),
        garageFetch('getProductionRuns', { status: 'Submitted' }, session).then(d => Array.isArray(d) ? d : []).catch(() => []),
      ]);
      setKpis(kpisRes);
      setSections({ grns: grnsRes, issues: issuesRes, returns: returnsRes, shipments: shipRes });
      setSubmittedRuns(subRuns);
    } catch (e) {
      setMainError(e.message);
    } finally {
      setMainLoading(false); setRefreshing(false);
    }
  }

  async function loadProducible() {
    try {
      const results = await Promise.all(
        PRODUCTS.map(product =>
          garageFetch('calcKit', { product, variant: '', colour: '', qty: 1 }, session)
            .then(data => ({ product, kit: data.kit || [] }))
            .catch(() => ({ product, kit: [] }))
        )
      );
      const rows = results.filter(r => r.kit.length > 0).map(({ product, kit }) => {
        // RULE-LUMP-001: a lump-sum consumable (the elastic band) is issued flat per picklist,
        // so its stock can never cap how many units are buildable. Dropped here for the same
        // reason getProducibility scores it `possible: 999999` — leaving it in let one low bag
        // of elastic read as the bottleneck for every product at once.
        const items = kit.filter(r => !r.is_lump_sum).map(r => ({
          part_name: r.part_name,
          max_units: r.bom_qty > 0 ? Math.floor((r.available || 0) / r.bom_qty) : 0,
        }));
        // Producible = the BOTTLENECK part's count (the minimum). A unit can only be
        // built up to its most-constrained part. (Was Math.max — that showed the
        // most-plentiful part's stock, wildly overstating producibility, e.g. 40,550
        // "Bumble" while a 0-stock part actually allowed 0.)
        const bottleneck = items.reduce((m, r) => r.max_units < m.max_units ? r : m, items[0]);
        const max = Math.max(0, bottleneck?.max_units ?? 0);
        return { product, max, bottleneck: bottleneck?.part_name || '—' };
      }).sort((a, b) => a.max - b.max);
      setProducible(rows);
    } catch { setProducible([]); }
  }

  async function loadActivity() {
    try {
      const data = await garageFetch('getActivityLog', { limit: 8 }, session);
      setActivity(Array.isArray(data) ? data : []);
    } catch { setActivity([]); }
  }

  async function loadStoreOps() {
    // Distinct store-team operators with an attendance row today. Gated by
    // canManageFloor in the worker — degrade to null (shows "—") on no-access.
    try {
      const today = istToday();
      const res = await workerFetch('getOperatorAttendance', { data: { date_from: today, date_to: today, team: 'store' } }, session);
      if (!res.ok) { setStoreOps(null); return; }
      const rows = Array.isArray(res.data) ? res.data : [];
      // ⚠️ An attendance row is NOT the same as being present: a supervisor can mark the day
      // `absent` or `leave` and the row stays (that is how day_status works — RULE-ATT-001).
      // Counting the raw rows therefore reported people known to be away as "Present"
      // (22 `absent` rows in the 30 days to 2026-08-28). Fixed S322.
      // ⚠️ Values are lowercase snake_case — `absent`, not `Absent`; a filter written against
      // the manual's display labels would match nothing and look like it worked.
      // `half_day`/`full_day`/`holiday`/null all still count as present.
      const AWAY = new Set(['absent', 'leave']);
      setStoreOps(new Set(rows.filter(r => !AWAY.has(r.day_status)).map(r => r.operator_id)).size);
    } catch { setStoreOps(null); }
  }

  function loadAll() {
    if (!session || productsLoading) return;
    loadMain(); loadProducible(); loadActivity(); loadStoreOps();
  }

  useAutoRefresh(loadAll, 60000, !session || productsLoading);

  // Manual refresh from the topbar refresh button.
  useEffect(() => {
    const h = () => loadAll();
    window.addEventListener('garage:refresh', h);
    return () => window.removeEventListener('garage:refresh', h);
  }); // eslint-disable-line

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
  const returnsByDisposition = useMemo(() => (sections.returns || [])
    .map((r) => [DISPO_SHORT[r.disposition] || r.disposition, Number(r.units) || 0])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6), [sections.returns]);
  const returnsMax = returnsByDisposition.length ? Math.max(...returnsByDisposition.map(([, q]) => q)) : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 5 }}>Garage · Triage</div>
          <h1 className="title" style={{ fontSize: 27, lineHeight: 1, margin: 0 }}>Overview</h1>
        </div>
        <span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>{kpis?.as_of || ''}</span>
      </div>

      {mainError && (
        <Panel style={{ marginBottom: 16 }}>
          <EmptyState message={mainError} />
          <div style={{ textAlign: 'center', paddingTop: 12 }}>
            <button onClick={loadAll} style={{ background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 14px', borderRadius: 'var(--r-sm)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Retry</button>
          </div>
        </Panel>
      )}

      {mainLoading && !kpis && !mainError ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spinner /></div>
      ) : (
        <>
          {/* KPI rail */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 12, marginBottom: 18 }}>
            <KpiCard eyebrow="Open Work Orders" value={kpis?.open_work_orders ?? '—'} tone="brand" icon={ListChecks} sub={`${fmt(submittedRuns.length)} awaiting issue`} onClick={() => router.push('/issue-queue')} />
            <KpiCard eyebrow="Today's GRNs" value={kpis?.today_grn_count ?? '—'} tone="info" icon={Inbox} sub="received today" onClick={() => router.push('/grn')} />
            <KpiCard eyebrow="WOs Issued Today" value={kpis?.today_wo_count ?? '—'} tone="ok" icon={Send} sub="store issues" onClick={() => router.push('/store-history')} />
            <KpiCard eyebrow="Pending Returns" value={kpis?.pending_returns ?? '—'} tone="warn" icon={Undo2} sub="to process" onClick={() => router.push('/returns/shipments')} />
            <KpiCard eyebrow="Reorder Flags" value={reorderCount ?? '—'} tone={reorderCount > 0 ? 'bad' : 'ok'} icon={AlertTriangle} sub="parts at reorder" onClick={() => router.push('/stock')} />
            <KpiCard eyebrow="Store Present" value={storeOps ?? '—'} tone="info" icon={Users} sub="operators today" onClick={() => router.push('/manpower')} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
            {/* LEFT — attention + producibility */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Panel title="Needs Attention Now" icon={Zap} padding={0}
                action={urgentCount > 0 ? <StatusBadge variant="error">{urgentCount} urgent</StatusBadge> : <StatusBadge variant="success">All clear</StatusBadge>}>
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
              </Panel>

              <Panel title="Producibility" icon={Target}
                action={<button onClick={() => router.push('/producibility')} style={linkBtn}>View all<ArrowRight size={12} strokeWidth={1.75} /></button>}>
                {producible.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--t3)', padding: '6px 2px' }}>Calculating producible units…</div>
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
                {returnsByDisposition.length === 0 ? (
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
                {activity.length === 0 ? (
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
        </>
      )}
    </div>
  );
}

const linkBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)' };
