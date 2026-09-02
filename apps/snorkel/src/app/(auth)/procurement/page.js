'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowRight, RefreshCw, Plus } from 'lucide-react';
import { PageHead, Kpi, Panel, Badge, Btn, Pipeline, EmptyState } from '@/components/ui.js';
import { fmtDateShort, money, inrCompact, PO_TONES, sourceTone, urgencyTone } from '@/components/format.js';
import { NAV_GROUPS, filterNavByPerms } from '../../../lib/nav.js';

const FX = { INR: 1, USD: 84, RMB: 11.6, CNY: 11.6 };
const toInr = (v, cur) => (Number(v) || 0) * (FX[cur] || 1);

export default function ProcurementOverviewPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [rrRows, setRrRows] = useState([]);
  const [poRows, setPoRows] = useState([]);
  const [poTruncated, setPoTruncated] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [rrs, pos] = await Promise.all([
        garageFetch('getReorderRequests', { status: 'Pending' }, session),
        garageFetch('getPOs', {}, session),
      ]);
      setRrRows(Array.isArray(rrs) ? rrs : []);
      // ⚠️ getPOs returns { rows, … } as of S334. Without the `.rows` fallback this reads
      // as "not an array" and every PO KPI on this page silently renders 0 — the exact
      // failure mode the truncation work exists to prevent, one level up.
      setPoRows(Array.isArray(pos) ? pos : (pos?.rows ?? []));
      setPoTruncated(Array.isArray(pos) ? false : !!pos?.truncated);
    } catch (e) {
      showToast(e.message || 'Failed to load procurement overview', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const kpis = useMemo(() => {
    const pendingRR = rrRows.length;
    const openPO = poRows.filter((p) => ['Draft', 'Approved', 'Sent'].includes(p.status)).length;
    const pendingApproval = poRows.filter((p) => p.status === 'Pending Approval').length;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 14);
    const arriving = poRows.filter((p) => {
      if (!['Approved', 'Sent', 'Confirmed & Payment Done'].includes(p.status)) return false;
      if (!p.expected_delivery) return false;
      const d = new Date(p.expected_delivery);
      return !isNaN(d) && d <= cutoff && d >= new Date();
    }).length;
    return { pendingRR, openPO, pendingApproval, arriving };
  }, [rrRows, poRows]);

  const topRR = useMemo(() => rrRows.slice(0, 6), [rrRows]);
  const openPOList = useMemo(
    () => poRows.filter((p) => ['Approved', 'Sent', 'Pending Approval'].includes(p.status)).slice(0, 6),
    [poRows]
  );

  const pipeline = useMemo(() => {
    const c = (s) => poRows.filter((p) => s.includes(p.status)).length;
    return [
      { stage: 'To Approve', count: c(['Pending Approval']), tone: 'orange' },
      { stage: 'Approved', count: c(['Approved']), tone: 'blue' },
      { stage: 'Sent', count: c(['Sent']), tone: 'yellow' },
      { stage: 'Confirmed', count: c(['Confirmed & Payment Done']), tone: 'green' },
      { stage: 'Receiving', count: c(['Partially Received']), tone: 'yellow' },
    ];
  }, [poRows]);

  const spend = useMemo(() => {
    const open = poRows.filter((p) => ['Draft', 'Approved', 'Sent', 'Pending Approval', 'Confirmed & Payment Done'].includes(p.status));
    const total = open.reduce((s, p) => s + toInr(p.po_value, p.currency), 0);
    const china = open.filter((p) => p.source === 'China').reduce((s, p) => s + toInr(p.po_value, p.currency), 0);
    return { total, chinaPct: total ? Math.round((china / total) * 100) : 0 };
  }, [poRows]);

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

      <div className="kpi-row">
        <Kpi label="Open Requests" value={kpis.pendingRR} sub="reorder queue" tone="yellow" onClick={() => router.push('/procurement/reorders')} />
        {/* These three are counted from the loaded PO page. When that read is truncated the
            counts are floors, not totals — say so in `sub` rather than showing a bare number
            that reads as complete (S334). */}
        <Kpi label="Open POs" value={kpis.openPO} sub={poTruncated ? 'in flight · partial' : 'in flight'} tone="blue" onClick={() => router.push('/procurement/pos')} />
        <Kpi label="To Approve" value={kpis.pendingApproval} sub={poTruncated ? 'awaiting sign-off · partial' : 'awaiting sign-off'} tone="orange" onClick={() => router.push('/procurement/pos')} />
        <Kpi label="Arriving · 14d" value={kpis.arriving} sub={poTruncated ? 'next 14 days · partial' : 'next 14 days'} tone="green" onClick={() => router.push('/procurement/pos')} />
      </div>

      <div className="ov-2col">
        <div className="ov-col">
          <Panel title="Pending Reorder Requests" count={rrRows.length}
            action={<Btn onClick={() => router.push('/procurement/reorders')}>View all <ArrowRight size={14} /></Btn>}>
            {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
              : topRR.length === 0 ? <EmptyState icon="check-check" title="Queue is clear" hint="New reorder requests will appear here." />
              : (
                <table className="dt">
                  <thead><tr><th>ID</th><th>Part / Product</th><th className="num">Qty</th><th>Urgency</th><th className="num"></th></tr></thead>
                  <tbody>
                    {topRR.map((r) => (
                      <tr key={r.request_id}>
                        <td className="mono accent">{r.request_id}</td>
                        <td>{rrLabel(r)}</td>
                        <td className="num mono">{r.requested_qty} {r.unit || ''}</td>
                        <td><Badge label={r.urgency || 'Normal'} tone={urgencyTone(r.urgency)} dot /></td>
                        <td className="num">
                          {perms?.po_create && <Btn kind="primary" onClick={() => router.push(`/procurement/pos/new?rr=${encodeURIComponent(r.request_id)}`)}>Convert</Btn>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Panel>

          <Panel title="Open Purchase Orders" count={openPOList.length}
            action={<Btn onClick={() => router.push('/procurement/pos')}>View all <ArrowRight size={14} /></Btn>}>
            {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
              : openPOList.length === 0 ? <EmptyState icon="file-search" title="No open purchase orders" hint="Open POs will show up here." />
              : (
                <table className="dt">
                  <thead><tr><th>PO</th><th>Vendor</th><th>Source</th><th className="num">Value</th><th>Expected</th><th>Status</th></tr></thead>
                  <tbody>
                    {openPOList.map((p) => (
                      <tr key={p.po_number} className="row-click" onClick={() => router.push(`/procurement/pos/detail?po_number=${encodeURIComponent(p.po_number)}`)}>
                        <td className="mono accent">{p.po_number}</td>
                        <td>{p.vendor_name || '—'}</td>
                        <td><Badge label={p.source || '—'} tone={sourceTone(p.source)} soft={false} /></td>
                        <td className="num mono">{p.source === 'China' && !perms?.po_china ? <span className="dim">Restricted</span> : money(p.currency, p.po_value)}</td>
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
              <div><div className="ov-stat-v">{inrCompact(spend.total)}</div><div className="ov-stat-l">≈ INR, all open</div></div>
              <div><div className="ov-stat-v" style={{ color: 'var(--blue-fg)' }}>{spend.chinaPct}<span>%</span></div><div className="ov-stat-l">sourced China</div></div>
            </div>
          </Panel>
          <Panel title="PO Pipeline" pad>
            <Pipeline stages={pipeline} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
