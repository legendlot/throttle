'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, pageH1, pageSub, tableThStyle, tableTdStyle, btnPrimary,
  StatusBadge, SHIPMENT_STATUS_TONE, fmtDate, titleCase,
} from '../../../lib/manifestui.js';

export default function ShipmentsPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() { const d = await garageFetch('getShipments', {}, session); setRows(d || []); setLoading(false); }
  useEffect(() => { if (session) load(); }, [session]);

  async function create() {
    const r = await workerFetch('createShipment', { data: { mode: 'sea', status: 'planned' } }, session);
    if (r.ok) { toast.success(`${r.data.shipment_no} created`); router.push(`/shipments/detail?id=${r.data.id}`); }
    else toast.error(r.error);
  }

  const canManage = perms?.shipment_manage || perms?.sf_order_update;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div><h1 style={pageH1}>Shipments</h1><div style={pageSub}>{rows.length} shipments · consolidated order lines, port-to-warehouse tracking</div></div>
        {canManage && <button style={btnPrimary} onClick={create}>+ New Shipment</button>}
      </div>
      <div style={panelStyle}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Shipment</th><th style={tableThStyle}>Mode</th><th style={tableThStyle}>Container</th>
              <th style={tableThStyle}>BL / AWB</th><th style={tableThStyle}>ETD</th><th style={tableThStyle}>ETA</th>
              <th style={tableThStyle}>Cleared</th><th style={tableThStyle}>Delivered</th><th style={tableThStyle}>Status</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={9}>Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={9}>No shipments</td></tr>}
              {rows.map(s => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/shipments/detail?id=${s.id}`)}>
                  <td style={{ ...tableTdStyle, color: 'var(--yellow)' }}>{s.shipment_no}</td>
                  <td style={tableTdStyle}>{titleCase(s.mode || '—')}</td>
                  <td style={tableTdStyle}>{s.container_type || '—'} {s.container_no || ''}</td>
                  <td style={tableTdStyle}>{s.bl_awb_no || '—'}</td>
                  <td style={tableTdStyle}>{fmtDate(s.etd)}</td>
                  <td style={tableTdStyle}>{fmtDate(s.eta)}</td>
                  <td style={tableTdStyle}>{fmtDate(s.clearance_date)}</td>
                  <td style={tableTdStyle}>{fmtDate(s.warehouse_delivery_date)}</td>
                  <td style={tableTdStyle}><StatusBadge label={titleCase(s.status)} tone={SHIPMENT_STATUS_TONE[s.status] || 'gray'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
