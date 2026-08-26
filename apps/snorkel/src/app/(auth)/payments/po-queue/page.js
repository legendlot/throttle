'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, money, inrCompact } from '@/components/format.js';

const PAY_TONE = { none: 'gray', requested: 'yellow', paid: 'green' };
const PAY_LABEL = { none: 'To route', requested: 'Requested', paid: 'Paid' };
const FX = { INR: 1, USD: 84, RMB: 11.6, CNY: 11.6 };
const toInr = (v, cur) => (Number(v) || 0) * (FX[cur] || 1);

export default function PaymentsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('to_route');
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getPaymentQueue', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load payment queue', 'error');
    } finally { setLoading(false); }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  async function route(po, to) {
    setBusy(po);
    try {
      await workerFetch('routePayment', { data: { po_number: po, route_to: to } }, session);
      showToast(`Payment requested from ${to}`, 'success'); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(null); }
  }
  async function markPaid(po) {
    setBusy(po);
    try {
      await workerFetch('markPaid', { data: { po_number: po } }, session);
      showToast(`${po} marked paid`, 'success'); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(null); }
  }

  const canPay = !!perms?.payment_route;
  const count = (s) => rows.filter((r) => (r.payment_status || 'none') === s).length;
  const filtered = rows.filter((r) => {
    const ps = r.payment_status || 'none';
    if (tab === 'to_route') return ps === 'none';
    if (tab === 'requested') return ps === 'requested';
    if (tab === 'paid') return ps === 'paid';
    return true;
  });

  const kpi = useMemo(() => ({
    toRoute: rows.filter((r) => (r.payment_status || 'none') === 'none').reduce((s, r) => s + toInr(r.invoice_value, r.currency), 0),
    requested: count('requested'),
    paid: rows.filter((r) => r.payment_status === 'paid').reduce((s, r) => s + toInr(r.invoice_value, r.currency), 0),
  }), [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = [['to_route', 'To Route', count('none')], ['requested', 'Requested', count('requested')], ['paid', 'Paid', count('paid')], ['all', 'All', rows.length]];

  return (
    <div className="pg">
      <PageHead title="Payment Queue" sub="Approved POs. Route to Finance or the requester, then mark paid." />

      <div className="kpi-row kpi-3">
        <Kpi label="To route" value={kpi.toRoute} sub={`${count('none')} POs waiting`} tone="yellow" format={(v) => inrCompact(v)} />
        <Kpi label="Requested" value={kpi.requested} sub="awaiting payment" tone="blue" />
        <Kpi label="Paid · cycle" value={kpi.paid} sub={`${count('paid')} POs settled`} tone="green" format={(v) => inrCompact(v)} />
      </div>

      <div className="seg">
        {tabs.map(([id, lbl, n]) => (
          <button key={id} className={`seg-btn ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>{lbl} <span className="seg-n">{n}</span></button>
        ))}
      </div>

      <Panel title="Approved POs" count={filtered.length}
        action={<Btn onClick={load} disabled={loading}>Refresh</Btn>}>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="check-check" title="Nothing in this queue" hint="Routed and paid POs move out of here automatically." />
          : (
            <table className="dt">
              <thead><tr><th>PO</th><th>Vendor</th><th className="num">Value</th><th>Approved</th><th>Payment</th><th className="num">Actions</th></tr></thead>
              <tbody>
                {filtered.map((r) => {
                  const ps = r.payment_status || 'none';
                  return (
                    <tr key={r.po_number}>
                      <td className="mono accent row-click" onClick={() => router.push(`/procurement/pos/detail?po_number=${encodeURIComponent(r.po_number)}`)}>{r.po_number}</td>
                      <td>{r.vendor_name}</td>
                      <td className="num mono">{r.invoice_value != null ? money(r.currency, r.invoice_value) : '—'}</td>
                      <td className="mono">{fmtDateShort(r.approved_at)}</td>
                      <td><Badge label={PAY_LABEL[ps]} tone={PAY_TONE[ps]} dot />{r.payment_routed_to && <span className="pay-to"> · {r.payment_routed_to}</span>}</td>
                      <td className="num">
                        {canPay && ps === 'none' && <span className="act-grp"><Btn onClick={() => route(r.po_number, 'finance')} disabled={busy === r.po_number}>→ Finance</Btn><Btn onClick={() => route(r.po_number, 'requester')} disabled={busy === r.po_number}>→ Requester</Btn></span>}
                        {canPay && ps === 'requested' && <Btn kind="primary" onClick={() => markPaid(r.po_number)} disabled={busy === r.po_number}>Mark paid</Btn>}
                        {ps === 'paid' && <span className="dim pay-done mono">{r.paid_by || ''} · {fmtDateShort(r.paid_at)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </Panel>
    </div>
  );
}
