'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Download } from 'lucide-react';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, inrCompact } from '@/components/format.js';
import { inr, csvCell, creditReasonLabel, CN_STATUS_TONES, cnStatusLabel } from '@/lib/sales';

export default function CreditNotesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const canManage = !!perms?.sales_credit_note;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getCreditNotes', status ? { status } : {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load credit notes', 'error');
    } finally { setLoading(false); }
  }, [session, status, showToast]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.sales_view && !perms.sales_credit_note) {
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  let filtered = rows;
  if (search.trim()) {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = filtered.filter(r => {
      const fields = [r.cn_no, r.partner_name, r.invoice_no].map(v => (v || '').toString().toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
  }

  const issued = rows.filter(r => r.status === 'issued');
  const kpi = {
    issued: issued.length,
    value: issued.reduce((s, r) => s + Number(r.grand_total || 0), 0),
    gst: issued.reduce((s, r) => s + Number(r.tax_total || 0), 0),
  };

  function exportCsv() {
    const cols = ['CN No', 'Status', 'Partner', 'Invoice', 'CN Date', 'Reason', 'Taxable', 'GST', 'Total'];
    const lines = [cols.join(',')];
    for (const c of filtered) lines.push([c.cn_no || '(draft)', c.status, c.partner_name, c.invoice_no,
      c.cn_date, creditReasonLabel(c.reason), c.subtotal, c.tax_total, c.grand_total].map(csvCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-credit-notes-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pg">
      <PageHead title="Credit Notes" sub="GST credit notes against sales invoices — reduce net receivable + output GST."
        actions={<>
          <Btn onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export</Btn>
          {canManage && <Btn kind="primary" onClick={() => router.push('/sales/credit-notes/new')}><Plus size={14} /> New credit note</Btn>}
        </>} />

      <div className="kpi-row">
        <Kpi label="Issued credit notes" value={kpi.issued} tone="blue" />
        <Kpi label="Total credited" value={kpi.value} sub="issued only" tone="red" format={(v) => inrCompact(v)} />
        <Kpi label="GST credited" value={kpi.gst} sub="output tax reduced" tone="yellow" format={(v) => inrCompact(v)} />
      </div>

      <Panel title="Credit notes" count={search.trim() ? `${filtered.length} of ${rows.length}` : rows.length}
        action={
          <div className="filters">
            <input className="sel" type="text" placeholder="Search CN / partner / invoice" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 200 }} />
            <select value={status} onChange={e => setStatus(e.target.value)} className="sel">
              <option value="">All statuses</option><option value="draft">Draft</option><option value="issued">Issued</option><option value="cancelled">Cancelled</option>
            </select>
          </div>
        }>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="file-minus" title="No credit notes yet" hint="Raise one from an invoiced sales order." />
          : (
            <table className="dt">
              <thead><tr>
                <th>CN No</th><th>Status</th><th>Partner</th><th>Invoice</th><th>Date</th><th>Reason</th>
                <th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th>
              </tr></thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id} className="row-click" onClick={() => router.push(`/sales/credit-notes/detail?id=${encodeURIComponent(c.id)}`)}>
                    <td className="mono accent">{c.cn_no || '(draft)'}</td>
                    <td><Badge label={cnStatusLabel(c.status)} tone={CN_STATUS_TONES[c.status] || 'gray'} /></td>
                    <td>{c.partner_name || '—'}</td>
                    <td className="mono">{c.invoice_no}</td>
                    <td className="mono">{fmtDateShort(c.cn_date)}</td>
                    <td>{creditReasonLabel(c.reason)}</td>
                    <td className="num mono">{inr(c.subtotal)}</td>
                    <td className="num mono">{inr(c.tax_total)}</td>
                    <td className="num mono">{inr(c.grand_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Panel>
    </div>
  );
}
