'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import EvidencePanel from '../../../../lib/EvidencePanel.js';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, tableThStyle, tableTdStyle,
  inputStyle, selectStyle, labelStyle, btnPrimary, btnSecondary, StatusBadge,
  SHIPMENT_STATUS_TONE, SHIPMENT_STATUSES, fmtDate, titleCase,
} from '../../../../lib/manifestui.js';

const MILESTONES = [
  ['etd', 'ETD'], ['eta', 'ETA'], ['loading_date', 'Loading'], ['unloading_date', 'Unloading'],
  ['port_arrival_date', 'Port arrival'], ['customs_entry_date', 'Customs entry'], ['clearance_date', 'Cleared'],
  ['local_dispatch_date', 'Local dispatch'], ['warehouse_delivery_date', 'Warehouse delivery'],
];

function ShipmentDetail() {
  const sp = useSearchParams();
  const id = sp.get('id');
  const { session, perms } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [lines, setLines] = useState([]);
  const [orders, setOrders] = useState([]);
  const [pickOrder, setPickOrder] = useState('');
  const [pickLines, setPickLines] = useState([]);
  const canManage = perms?.shipment_manage || perms?.sf_order_update;

  async function load() {
    const d = await garageFetch('getShipment', { id }, session);
    setData(d); setForm(d.shipment || {});
    setLines((d.lines || []).map(l => ({
      order_line_id: l.order_line_id, qty_in_shipment: l.qty_in_shipment,
      label: `${l.order_lines?.orders?.order_no || ''} · ${l.order_lines?.product || l.order_lines?.part_code || 'line'} ${l.order_lines?.variant || ''}`.trim(),
    })));
  }
  useEffect(() => { if (session && id) load(); }, [session, id]);
  useEffect(() => { if (session) garageFetch('getOrders', {}, session).then(d => setOrders(d || [])).catch(() => {}); }, [session]);

  const setF = (k, v) => setForm(s => ({ ...s, [k]: v }));

  async function saveHeader() {
    const r = await workerFetch('updateShipment', { data: { id, ...form } }, session);
    if (r.ok) { toast.success('Saved'); load(); } else toast.error(r.error);
  }
  async function loadPick(orderId) {
    setPickOrder(orderId); setPickLines([]);
    if (!orderId) return;
    const d = await garageFetch('getOrder', { id: orderId }, session);
    setPickLines((d.lines || []).map(l => ({ ...l, _add: 0 })));
  }
  function addPicked() {
    const adds = pickLines.filter(l => Number(l._add) > 0).map(l => ({
      order_line_id: l.id, qty_in_shipment: Number(l._add),
      label: `${orders.find(o => String(o.id) === String(pickOrder))?.order_no || ''} · ${l.product || l.part_code || 'line'} ${l.variant || ''}`.trim(),
    }));
    if (!adds.length) { toast.error('Set a qty on at least one line'); return; }
    setLines(ls => [...ls.filter(x => !adds.some(a => a.order_line_id === x.order_line_id)), ...adds]);
    setPickOrder(''); setPickLines([]);
  }
  async function saveLines() {
    const r = await workerFetch('setShipmentLines', { data: { shipment_id: id, lines: lines.map(l => ({ order_line_id: l.order_line_id, qty_in_shipment: l.qty_in_shipment })) } }, session);
    if (r.ok) { toast.success('Lines saved'); load(); } else toast.error(r.error);
  }

  if (!data?.shipment) return <div style={{ color: 'var(--t3)' }}>Loading…</div>;
  const s = data.shipment;

  return (
    <div style={{ maxWidth: 1100 }}>
      <button style={{ ...btnSecondary, marginBottom: 12 }} onClick={() => router.push('/shipments')}>← Shipments</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div><h1 style={pageH1}>{s.shipment_no}</h1><div style={pageSub}>{titleCase(s.mode || 'mode tbd')} · {s.bl_awb_no || 'no BL/AWB'}</div></div>
        <StatusBadge label={titleCase(s.status)} tone={SHIPMENT_STATUS_TONE[s.status] || 'gray'} />
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Tracking</span>{canManage && <button style={btnPrimary} onClick={saveHeader}>Save</button>}</div>
        <div style={{ ...panelBodyStyle, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <div><label style={labelStyle}>Status</label><select style={{ ...selectStyle, width: '100%' }} disabled={!canManage} value={form.status || ''} onChange={e => setF('status', e.target.value)}>{SHIPMENT_STATUSES.map(x => <option key={x} value={x}>{titleCase(x)}</option>)}</select></div>
          <div><label style={labelStyle}>Mode</label><select style={{ ...selectStyle, width: '100%' }} disabled={!canManage} value={form.mode || ''} onChange={e => setF('mode', e.target.value)}><option value="">—</option><option value="sea">Sea</option><option value="air">Air</option><option value="land">Land</option></select></div>
          <div><label style={labelStyle}>Container type</label><input style={{ ...inputStyle, width: '100%' }} disabled={!canManage} value={form.container_type || ''} onChange={e => setF('container_type', e.target.value)} placeholder="FCL / LCL" /></div>
          <div><label style={labelStyle}>Container no.</label><input style={{ ...inputStyle, width: '100%' }} disabled={!canManage} value={form.container_no || ''} onChange={e => setF('container_no', e.target.value)} /></div>
          <div><label style={labelStyle}>BL / AWB</label><input style={{ ...inputStyle, width: '100%' }} disabled={!canManage} value={form.bl_awb_no || ''} onChange={e => setF('bl_awb_no', e.target.value)} /></div>
          <div><label style={labelStyle}>Forwarder code</label><input style={{ ...inputStyle, width: '100%' }} disabled={!canManage} value={form.forwarder_code || ''} onChange={e => setF('forwarder_code', e.target.value)} /></div>
          {MILESTONES.map(([k, lbl]) => (
            <div key={k}><label style={labelStyle}>{lbl}</label><input type="date" style={{ ...inputStyle, width: '100%' }} disabled={!canManage} value={(form[k] || '').slice(0, 10)} onChange={e => setF(k, e.target.value || null)} /></div>
          ))}
          <div style={{ gridColumn: '1 / 5' }}><label style={labelStyle}>Notes</label><textarea style={{ ...inputStyle, width: '100%', minHeight: 44 }} disabled={!canManage} value={form.notes || ''} onChange={e => setF('notes', e.target.value)} /></div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Consolidated order lines ({lines.length})</span>{canManage && <button style={btnPrimary} onClick={saveLines}>Save lines</button>}</div>
        <div style={panelBodyStyle}>
          {lines.length === 0 && <div style={{ color: 'var(--t3)', fontSize: 12, marginBottom: 10 }}>No lines attached yet.</div>}
          {lines.map((l, i) => (
            <div key={l.order_line_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)' }}>
              <span style={{ flex: 1 }}>{l.label}</span>
              <span style={{ color: 'var(--t3)' }}>qty {Number(l.qty_in_shipment)}</span>
              {canManage && <button style={{ background: 'none', border: 'none', color: '#ff7070', cursor: 'pointer' }} onClick={() => setLines(ls => ls.filter((_, idx) => idx !== i))}>×</button>}
            </div>
          ))}

          {canManage && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <label style={labelStyle}>Add lines from an order</label>
              <select style={{ ...selectStyle, minWidth: 280 }} value={pickOrder} onChange={e => loadPick(e.target.value)}>
                <option value="">— select order —</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.order_no} · {o.title || o.vendor_name || ''}</option>)}
              </select>
              {pickLines.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {pickLines.map((l, i) => (
                    <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', fontSize: 12 }}>
                      <span style={{ flex: 1 }}>{l.product || l.part_code || 'line'} {l.variant || ''} {l.color || ''} <span style={{ color: 'var(--t3)' }}>(ordered {Number(l.qty)})</span></span>
                      <input type="number" style={{ ...inputStyle, width: 80 }} placeholder="qty" value={l._add || ''} onChange={e => setPickLines(ps => ps.map((x, idx) => idx === i ? { ...x, _add: e.target.value } : x))} />
                    </div>
                  ))}
                  <button style={{ ...btnSecondary, marginTop: 8 }} onClick={addPicked}>Add selected to shipment</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <EvidencePanel scope="shipment" refId={Number(id)} refField="shipment_id" docs={data.documents || []} session={session} perms={perms} onChange={load} />
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div style={{ color: 'var(--t3)' }}>Loading…</div>}><ShipmentDetail /></Suspense>;
}
