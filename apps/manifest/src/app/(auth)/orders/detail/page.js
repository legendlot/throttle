'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import EvidencePanel from '../../../../lib/EvidencePanel.js';
import {
  panelStyle, panelHeaderStyle, pageH1, pageSub, tableThStyle, tableTdStyle,
  selectStyle, btnPrimary, btnSecondary, StatusBadge, ORDER_STATUS_TONE, ORDER_STATUSES,
  fmtDate, fmtRMB, titleCase,
} from '../../../../lib/manifestui.js';

function OrderDetail() {
  const sp = useSearchParams();
  const id = sp.get('id');
  const { session, perms } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await garageFetch('getOrder', { id }, session);
    setData(d); setLoading(false);
  }
  useEffect(() => { if (session && id) load(); }, [session, id]);

  async function setStatus(status) {
    const r = await workerFetch('setOrderStatus', { data: { id, status } }, session);
    if (r.ok) { toast.success('Status updated'); load(); } else toast.error(r.error);
  }
  async function project() {
    if (!confirm('Project this order to Snorkel as a China PO?')) return;
    setBusy(true);
    try {
      const r = await workerFetch('projectToSnorkel', { data: { order_id: id } }, session);
      if (!r.ok) throw new Error(r.error);
      toast.success(`Projected → ${r.data.po_number}`); load();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }

  if (loading) return <div style={{ color: 'var(--t3)' }}>Loading…</div>;
  if (!data?.order) return <div style={{ color: 'var(--t3)' }}>Order not found</div>;
  const o = data.order;

  return (
    <div style={{ maxWidth: 1100 }}>
      <button style={{ ...btnSecondary, marginBottom: 12 }} onClick={() => router.push('/orders')}>← Orders</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>{o.order_no}</h1>
          <div style={pageSub}>{o.title || titleCase(o.category)} · {o.vendor_name || '—'} · {o.placed_via === 'SF' ? 'via Solve Factory' : 'direct'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <StatusBadge label={titleCase(o.status)} tone={ORDER_STATUS_TONE[o.status] || 'gray'} />
          {(perms?.order_manage || perms?.sf_order_update) && (
            <select style={selectStyle} value={o.status} onChange={e => setStatus(e.target.value)}>
              {ORDER_STATUSES.map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
          )}
          {perms?.china_po_sync && (
            <button style={btnPrimary} disabled={busy} onClick={project}>
              {o.linked_po_number ? `Re-sync ${o.linked_po_number}` : 'Project to Snorkel'}
            </button>
          )}
        </div>
      </div>

      {o.linked_po_number && (
        <div style={{ ...panelStyle, padding: '10px 14px', fontSize: 12, color: 'var(--green)' }}>
          Linked Snorkel China PO: <strong>{o.linked_po_number}</strong> (projected {fmtDate(o.linked_at)})
        </div>
      )}

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Line items ({data.lines.length})</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>#</th><th style={tableThStyle}>Product</th><th style={tableThStyle}>Variant</th><th style={tableThStyle}>Colour</th>
              <th style={tableThStyle}>Type</th><th style={tableThStyle}>Part</th><th style={tableThStyle}>Qty</th>
              {!perms?.cost_view ? null : <th style={tableThStyle}>Unit ¥</th>}<th style={tableThStyle}>Format</th><th style={tableThStyle}>HSN</th>
            </tr></thead>
            <tbody>
              {data.lines.map(l => (
                <tr key={l.id}>
                  <td style={tableTdStyle}>{l.line_no}</td>
                  <td style={tableTdStyle}>{l.product || '—'}</td>
                  <td style={tableTdStyle}>{l.variant || '—'}</td>
                  <td style={tableTdStyle}>{l.color || '—'}</td>
                  <td style={tableTdStyle}>{l.item_type}</td>
                  <td style={tableTdStyle}>{l.part_code || '—'}</td>
                  <td style={tableTdStyle}>{Number(l.qty)}</td>
                  {!perms?.cost_view ? null : <td style={tableTdStyle}>{l.unit_price_rmb != null ? fmtRMB(l.unit_price_rmb) : '—'}</td>}
                  <td style={tableTdStyle}>{l.receive_format || (l.component_type ? titleCase(l.component_type) : '—')}</td>
                  <td style={tableTdStyle}>{l.hsn_code || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <EvidencePanel scope="order" refId={Number(id)} refField="order_id" docs={data.documents || []} session={session} perms={perms} onChange={load} />
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div style={{ color: 'var(--t3)' }}>Loading…</div>}><OrderDetail /></Suspense>;
}
