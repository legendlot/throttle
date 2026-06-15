'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, pageH1, pageSub, tableThStyle, tableTdStyle, selectStyle, inputStyle, StatusBadge, fmtDate, titleCase,
} from '../../../lib/manifestui.js';

const DOC_TYPES = ['pi','po','bank_receipt','loading_photo','unloading_photo','packing_list','bl_awb','customs_doc','sf_invoice','other'];

export default function DocumentsPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!session) return;
    garageFetch('getDocuments', {}, session).then(d => setRows(d || [])).finally(() => setLoading(false));
  }, [session]);

  async function open(path) {
    try { const r = await garageFetch('getDocumentDownloadUrl', { storage_path: path }, session); if (r?.url) window.open(r.url, '_blank'); }
    catch (e) { toast.error(e.message); }
  }

  const filtered = useMemo(() => rows.filter(d => {
    if (type && d.doc_type !== type) return false;
    if (q && !`${d.file_name || ''} ${d.scope || ''}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, type, q]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}><h1 style={pageH1}>Evidence Vault</h1><div style={pageSub}>{rows.length} documents · PI/PO, bank receipts, loading photos, packing lists, BL/AWB, customs</div></div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, minWidth: 220 }} placeholder="Search file / scope…" value={q} onChange={e => setQ(e.target.value)} />
        <select style={selectStyle} value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>{DOC_TYPES.map(t => <option key={t} value={t}>{titleCase(t)}</option>)}
        </select>
      </div>

      <div style={panelStyle}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Type</th><th style={tableThStyle}>File</th><th style={tableThStyle}>Scope</th>
              <th style={tableThStyle}>Uploaded by</th><th style={tableThStyle}>Party</th><th style={tableThStyle}>Date</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={6}>Loading…</td></tr>}
              {!loading && filtered.length === 0 && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={6}>No documents</td></tr>}
              {filtered.map(d => (
                <tr key={d.id}>
                  <td style={tableTdStyle}><StatusBadge label={titleCase(d.doc_type)} tone="blue" /></td>
                  <td style={{ ...tableTdStyle, color: 'var(--yellow)', cursor: 'pointer' }} onClick={() => open(d.storage_path)}>{d.file_name || d.storage_path.split('/').pop()}</td>
                  <td style={tableTdStyle}>{titleCase(d.scope || '—')}{d.order_id ? ` #${d.order_id}` : d.shipment_id ? ` ship#${d.shipment_id}` : ''}</td>
                  <td style={tableTdStyle}>{d.uploaded_by_name || '—'}</td>
                  <td style={tableTdStyle}>{d.uploaded_party || '—'}</td>
                  <td style={tableTdStyle}>{fmtDate(d.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
