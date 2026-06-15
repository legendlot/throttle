'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, btnDanger, tableThStyle, tableTdStyle, ORDER_CATEGORIES, titleCase,
} from '../../../../lib/manifestui.js';

const emptyLine = () => ({
  product: '', variant: '', color: '', item_type: 'CKD Unit', part_code: '', qty: '', unit: 'pcs',
  unit_price_rmb: '', component_type: '', receive_format: 'CKD', remote_qty: '', hsn_code: '', gst_percent: '',
});

export default function NewOrderPage() {
  const { session } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [vendors, setVendors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [hdr, setHdr] = useState({
    title: '', category: 'product', vendor_code: '', placed_via: 'SF', currency: 'CNY',
    incoterms: '', est_value_rmb: '', notes: '',
  });
  const [lines, setLines] = useState([emptyLine()]);

  useEffect(() => {
    if (!session) return;
    garageFetch('getVendors', {}, session).then(d => setVendors(d || [])).catch(() => {});
  }, [session]);

  const setH = (k, v) => setHdr(s => ({ ...s, [k]: v }));
  const setL = (i, k, v) => setLines(ls => ls.map((l, idx) => idx === i ? { ...l, [k]: v } : l));
  const addLine = () => setLines(ls => [...ls, emptyLine()]);
  const rmLine = (i) => setLines(ls => ls.filter((_, idx) => idx !== i));

  async function submit() {
    if (!hdr.category) { toast.error('Category required'); return; }
    setBusy(true);
    try {
      const vendor = vendors.find(v => v.vendor_code === hdr.vendor_code);
      const payload = {
        ...hdr,
        vendor_name: vendor?.vendor_name || null,
        est_value_rmb: hdr.est_value_rmb === '' ? null : Number(hdr.est_value_rmb),
        lines: lines
          .filter(l => l.product || l.part_code || l.description || l.qty)
          .map((l, i) => ({
            ...l, line_no: i + 1,
            qty: l.qty === '' ? 0 : Number(l.qty),
            unit_price_rmb: l.unit_price_rmb === '' ? null : Number(l.unit_price_rmb),
            remote_qty: l.remote_qty === '' ? 0 : Number(l.remote_qty),
            gst_percent: l.gst_percent === '' ? null : Number(l.gst_percent),
            part_code: l.part_code || null, variant: l.variant || null, color: l.color || null,
            component_type: l.component_type || null, receive_format: l.receive_format || null,
          })),
      };
      const res = await workerFetch('createOrder', { data: payload }, session);
      if (!res.ok) throw new Error(res.error || 'Create failed');
      toast.success(`Order ${res.data.order_no} created`);
      router.push(`/orders/detail?id=${res.data.id}`);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }

  const colLabel = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' };
  const cell = { ...inputStyle, width: '100%' };

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ marginBottom: 16 }}><h1 style={pageH1}>New China Order</h1><div style={pageSub}>Capture the order at intent / verbal stage — project to Snorkel once firmed</div></div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Order</span></div>
        <div style={{ ...panelBodyStyle, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div style={{ gridColumn: '1 / 3' }}><label style={labelStyle}>Title</label><input style={{ ...inputStyle, width: '100%' }} value={hdr.title} onChange={e => setH('title', e.target.value)} placeholder="e.g. Flare 4000 — June restock" /></div>
          <div><label style={labelStyle}>Category</label><select style={{ ...selectStyle, width: '100%' }} value={hdr.category} onChange={e => setH('category', e.target.value)}>{ORDER_CATEGORIES.map(c => <option key={c} value={c}>{titleCase(c)}</option>)}</select></div>
          <div><label style={labelStyle}>Vendor (China)</label><select style={{ ...selectStyle, width: '100%' }} value={hdr.vendor_code} onChange={e => setH('vendor_code', e.target.value)}><option value="">— select —</option>{vendors.map(v => <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_name}</option>)}</select></div>
          <div><label style={labelStyle}>Placed via</label><select style={{ ...selectStyle, width: '100%' }} value={hdr.placed_via} onChange={e => setH('placed_via', e.target.value)}><option value="SF">Solve Factory</option><option value="direct">Direct to vendor</option></select></div>
          <div><label style={labelStyle}>Currency</label><input style={{ ...inputStyle, width: '100%' }} value={hdr.currency} onChange={e => setH('currency', e.target.value)} /></div>
          <div><label style={labelStyle}>Incoterms</label><input style={{ ...inputStyle, width: '100%' }} value={hdr.incoterms} onChange={e => setH('incoterms', e.target.value)} placeholder="FOB / CIF" /></div>
          <div><label style={labelStyle}>Est. value (RMB)</label><input type="number" style={{ ...inputStyle, width: '100%' }} value={hdr.est_value_rmb} onChange={e => setH('est_value_rmb', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / 4' }}><label style={labelStyle}>Notes</label><textarea style={{ ...inputStyle, width: '100%', minHeight: 50 }} value={hdr.notes} onChange={e => setH('notes', e.target.value)} /></div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Line items</span><button style={btnSecondary} onClick={addLine}>+ Add line</button></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
            <thead><tr>
              {['Product','Variant','Colour','Type','Part code','Qty','Unit ¥','Comp','Format','Rmt qty','HSN','GST%',''].map((h, i) => <th key={i} style={{ ...tableThStyle, color: 'var(--t3)' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td style={tableTdStyle}><input style={cell} value={l.product} onChange={e => setL(i, 'product', e.target.value)} /></td>
                  <td style={tableTdStyle}><input style={cell} value={l.variant} onChange={e => setL(i, 'variant', e.target.value)} /></td>
                  <td style={tableTdStyle}><input style={cell} value={l.color} onChange={e => setL(i, 'color', e.target.value)} /></td>
                  <td style={tableTdStyle}><select style={{ ...cell, cursor: 'pointer' }} value={l.item_type} onChange={e => setL(i, 'item_type', e.target.value)}>{['CKD Unit','SKD','FBU Unit','Part','Other'].map(t => <option key={t}>{t}</option>)}</select></td>
                  <td style={tableTdStyle}><input style={cell} value={l.part_code} onChange={e => setL(i, 'part_code', e.target.value)} placeholder="parts only" /></td>
                  <td style={tableTdStyle}><input type="number" style={{ ...cell, width: 70 }} value={l.qty} onChange={e => setL(i, 'qty', e.target.value)} /></td>
                  <td style={tableTdStyle}><input type="number" style={{ ...cell, width: 70 }} value={l.unit_price_rmb} onChange={e => setL(i, 'unit_price_rmb', e.target.value)} /></td>
                  <td style={tableTdStyle}><select style={{ ...cell, cursor: 'pointer' }} value={l.component_type} onChange={e => setL(i, 'component_type', e.target.value)}><option value="">—</option><option value="car">car</option><option value="remote">remote</option></select></td>
                  <td style={tableTdStyle}><select style={{ ...cell, cursor: 'pointer' }} value={l.receive_format} onChange={e => setL(i, 'receive_format', e.target.value)}><option value="">—</option><option value="CKD">CKD</option><option value="SKD">SKD</option><option value="FBU">FBU</option></select></td>
                  <td style={tableTdStyle}><input type="number" style={{ ...cell, width: 60 }} value={l.remote_qty} onChange={e => setL(i, 'remote_qty', e.target.value)} /></td>
                  <td style={tableTdStyle}><input style={{ ...cell, width: 70 }} value={l.hsn_code} onChange={e => setL(i, 'hsn_code', e.target.value)} /></td>
                  <td style={tableTdStyle}><input type="number" style={{ ...cell, width: 55 }} value={l.gst_percent} onChange={e => setL(i, 'gst_percent', e.target.value)} /></td>
                  <td style={tableTdStyle}>{lines.length > 1 && <button style={{ ...btnDanger, padding: '3px 8px' }} onClick={() => rmLine(i)}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button style={btnPrimary} disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create Order'}</button>
        <button style={btnSecondary} onClick={() => router.push('/orders')}>Cancel</button>
      </div>
    </div>
  );
}
