'use client';
/* ════════════════════════════════════════════════════════════
   OUTPOST › WORK ORDERS — what a vendor may pack (O7, S422).

   An order (OWO-NNNNN) locks ONE car colourway + ONE channel; its
   quantity is a TARGET, not a cap (the floor keeps packing past it —
   the over-PO leakage flag watches that). Linking a PO line is
   optional; the line must be the same product / model / colour on
   a live PO of that vendor. The vendor's benches choose an open
   order at pack time. Close an order when it is done; cancel one
   raised by mistake. Packed = car units packed against the order.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Modal, Spinner, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import { Icon, Panel, FilterChip, ToneBadge, btnPrimary } from '../../../components/kit/index.js';
import { opGet, opPost, fmtIST } from '../../../lib/outpost.js';
import {
  Confirm, ErrorPanel, Field, Input, OwnerGate, Select, dangerBtn, label, mono, smallBtn, text, useOutpostVendors,
} from '../../../components/outpost/OutpostKit.js';

const STATUSES = [['open', 'Open'], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['', 'All']];

export default function OutpostOrdersPage() {
  return <OwnerGate><OrdersInner /></OwnerGate>;
}

function OrdersInner() {
  const { session, userId } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const V = useOutpostVendors(session, userId);
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [ask, setAsk] = useState(null);

  const load = async () => {
    if (!V.vendorId) return;
    setRefreshing(true);
    try { setRows(await opGet('getWorkOrders', { vendor_id: V.vendorId, status }, session)); setErr(null); }
    catch (e) { setErr(e.message); } finally { setRefreshing(false); setLastRefreshed(new Date()); }
  };
  useEffect(() => { setRows(null); load(); /* eslint-disable-next-line */ }, [V.vendorId, status]);

  const finish = (w, to) => setAsk({
    title: `${to === 'closed' ? 'Close' : 'Cancel'} ${w.wo_no}?`, danger: to === 'cancelled', yes: to === 'closed' ? 'Close order' : 'Cancel order',
    body: <>Benches can no longer pack against it. {w.packed > 0 && <>The {w.packed} unit{w.packed > 1 ? 's' : ''} already packed stay packed and shippable.</>}
      {to === 'cancelled' && ' Cancel is for an order raised by mistake; a finished order is closed.'}</>,
    onYes: async () => { await opPost('setWorkOrderStatus', { id: w.id, status: to }, session); showToast(`${w.wo_no} ${to}`, 'success'); await load(); },
  });

  if (V.loading) return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (V.error) return <ErrorPanel error={V.error} onRetry={V.reload} />;
  if (!V.vendors.length) return <Panel pad={24}><div style={text}>No vendor is set up in Outpost yet — add one under Outpost › Vendors &amp; Devices.</div></Panel>;
  const vendor = V.vendors.find(v => v.vendor_id === V.vendorId);

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ width: 260 }}>
          <Select value={V.vendorId || ''} onChange={e => V.setVendorId(Number(e.target.value))}>
            {V.vendors.map(v => <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name || `Vendor ${v.vendor_id}`}</option>)}
          </Select>
        </div>
        {STATUSES.map(([k, n]) => <FilterChip key={k || 'all'} active={status === k} onClick={() => setStatus(k)}>{n}</FilterChip>)}
        <div style={{ flex: 1 }} />
        <button style={btnPrimary} onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New work order</button>
      </div>
      {vendor && (!vendor.active || vendor.killed) && (
        <Panel pad={12} style={{ marginBottom: 14, borderColor: 'var(--warn-fg)' }}>
          <div style={text}>{vendor.vendor_name} is {vendor.killed ? 'stopped (kill switch)' : 'not live'} — its benches cannot pack until that changes.</div>
        </Panel>
      )}

      {err ? <ErrorPanel error={err} onRetry={load} /> : !rows ? <Spinner /> : (
        <Panel pad={8}>
          {!rows.length ? <div style={{ ...text, padding: 24, textAlign: 'center' }}>No {status || ''} work orders.</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
                <thead><tr>{['Order', 'Car code', 'Channel', 'Packed / target', 'PO', 'Raised', 'Status', ''].map(h =>
                  <th key={h} style={{ ...label, textAlign: 'left', padding: '6px 8px' }}>{h}</th>)}</tr></thead>
                <tbody>{rows.map(w => {
                  const pct = Math.min(100, (100 * Number(w.packed)) / Math.max(1, w.target_qty));
                  return (
                    <tr key={w.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...mono, padding: 8, color: 'var(--t1)', fontWeight: 600 }} title={w.notes || ''}>{w.wo_no}</td>
                      <td style={{ padding: 8 }}><span style={mono}>{w.sku}</span> <span style={{ ...text, fontSize: 12 }}>{w.product}</span></td>
                      <td style={{ ...text, padding: 8 }}>{w.channel}</td>
                      <td style={{ padding: 8, minWidth: 160 }}>
                        <div className="num" style={{ fontSize: 12.5, color: Number(w.packed) > w.target_qty ? 'var(--warn-fg)' : 'var(--t1)' }}>
                          {Number(w.packed).toLocaleString('en-IN')} / {w.target_qty.toLocaleString('en-IN')}</div>
                        <div style={{ height: 4, background: 'var(--surface-3)', borderRadius: 2, marginTop: 4 }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--yellow)', borderRadius: 2 }} /></div>
                      </td>
                      <td style={{ ...mono, padding: 8 }}>{w.po_number || '—'}</td>
                      <td style={{ ...text, padding: 8 }}>{fmtIST(w.created_at)}</td>
                      <td style={{ padding: 8 }}><ToneBadge tone={w.status === 'open' ? 'ok' : w.status === 'cancelled' ? 'bad' : 'mute'}>{w.status}</ToneBadge></td>
                      <td style={{ padding: 8, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {w.status === 'open' && <>
                          <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => finish(w, 'closed')}>Close</button>
                          <button style={dangerBtn} onClick={() => finish(w, 'cancelled')}>Cancel</button>
                        </>}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
      {creating && <NewOrder vendorId={V.vendorId} onClose={() => setCreating(false)}
        onCreated={async r => { setCreating(false); showToast(`${r.wo_no} raised`, 'success'); if (status === 'open' || !status) await load(); else setStatus('open'); }} />}
      <Confirm ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function NewOrder({ vendorId, onClose, onCreated }) {
  const { session } = useAuth();
  const [opts, setOpts] = useState(null);
  const [f, setF] = useState({ sku: '', channel_id: '', target_qty: '', po_line_id: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { opGet('getOrderOptions', { vendor_id: vendorId }, session).then(setOpts).catch(e => setErr(e.message)); /* eslint-disable-next-line */ }, [vendorId]);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value, ...(k === 'sku' ? { po_line_id: '' } : {}) }));
  const lines = useMemo(() => (opts?.po_lines || []).filter(l => l.sku === f.sku), [opts, f.sku]);
  // Only channels a bench can pack (ecom / retail / export) — the server's list; create_work_order refuses the rest.
  const live = opts?.channels || [];
  const qty = Number(f.target_qty);
  const ok = f.sku && f.channel_id && Number.isInteger(qty) && qty >= 1 && qty <= 1_000_000;

  return (
    <Modal open onClose={onClose} title="New work order" confirmLabel="Raise order" loading={busy} error={err} dismissOnBackdrop={false}
      confirmDisabled={!ok} size="lg" onConfirm={async () => {
        setBusy(true); setErr(null);
        try {
          onCreated(await opPost('createWorkOrder', { vendor_id: vendorId, sku: f.sku, channel_id: f.channel_id, target_qty: qty,
            po_line_id: f.po_line_id || null, notes: f.notes.trim() || null }, session));
        } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      {!opts ? (err ? null : <Spinner />) : !opts.cars.length ? (
        <div style={text}>This vendor has no active product it <strong>packs</strong>. Add one on its Setup tab first.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field name="Car colourway"><Select value={f.sku} onChange={set('sku')}>
            <option value="">Choose…</option>
            {opts.cars.map(c => <option key={c.code} value={c.code}>{c.code} — {c.product} {c.model} {c.color}{c.ean_ok ? '' : ' (NO VALID EAN — packing will be refused)'}</option>)}
          </Select></Field>
          <Field name="Channel"><Select value={f.channel_id} onChange={set('channel_id')}>
            <option value="">Choose…</option>{live.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select></Field>
          <Field name="Target quantity" hint="A target, not a cap: benches can pack past it."><Input inputMode="numeric" value={f.target_qty}
            onChange={e => setF(p => ({ ...p, target_qty: e.target.value.replace(/\D/g, '').slice(0, 7) }))} /></Field>
          <Field name="PO line (optional)" hint={f.sku && !lines.length ? 'No live PO line of this vendor matches this colourway.' : 'Feeds the GRN at LOT receiving.'}>
            <Select value={f.po_line_id} onChange={set('po_line_id')} disabled={!lines.length}>
              <option value="">None</option>
              {lines.map(l => <option key={l.id} value={l.id}>{l.po_number} · line {l.line_no} · {Number(l.qty_received || 0)}/{Number(l.qty_ordered || 0)} received · {l.status}</option>)}
            </Select></Field>
          <Field name="Notes (optional)" style={{ gridColumn: '1 / -1' }}><Input value={f.notes} maxLength={300} onChange={set('notes')} /></Field>
        </div>
      )}
    </Modal>
  );
}
