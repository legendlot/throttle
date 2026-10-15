'use client';
// Consignments (supervisor): a draft collects CLOSED cartons; dispatch records the vendor's own GST delivery challan, the
// vehicle and the e-way bill, and moves every unit to in-transit in one go. The packing note prints from here.
import { useRef, useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { printWindow } from '@throttle/ui/printWindow.js';
import { act, get, say } from './api.js';
import { buildPackingNote } from './packingNote.mjs';
import { Badge, clean, Confirm, CTN_RE, Field, fmtTime, Modal, todayIST, useLoad, useScanCapture } from './ui.js';

export async function printNote(csgNo) {
  const r = await get(`/v/consignment?csg_no=${encodeURIComponent(csgNo)}`);
  if (!r.ok) return say(r);
  if (!printWindow(buildPackingNote(r.data))) return 'The print window was blocked. Allow pop-ups for Outpost.';
  return null;
}

export default function Consignments() {
  const { showToast } = useToast();
  const list = useLoad('/v/consignments');
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Consignments</h2>
        <div className="row">
          <button className="btn sm" onClick={list.reload}>Refresh</button>
          <button className="btn primary" onClick={() => setCreating(true)}>New consignment</button>
        </div>
      </div>
      {list.error && <div className="err">{list.error}</div>}
      {list.loading ? <div className="empty">Loading…</div> : !(list.data || []).length ? <div className="empty">No consignments yet.</div> : (
        <table className="t">
          <thead><tr><th>Consignment</th><th>Status</th><th className="n">Cartons</th><th className="n">Units</th><th>Challan</th><th>Vehicle</th><th>Dispatched</th></tr></thead>
          <tbody>
            {list.data.map(c => (
              <tr key={c.csg_no} className="click" onClick={() => setSel(c.csg_no)}>
                <td className="mono">{c.csg_no}</td><td><Badge s={c.status} /></td>
                <td className="n">{c.carton_count}</td><td className="n">{c.unit_count}</td>
                <td className="mono">{c.challan_no || '—'}</td><td className="mono">{c.vehicle_no || '—'}</td>
                <td className="dim">{fmtTime(c.dispatched_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <NewCsg onClose={() => setCreating(false)} onDone={csg => { setCreating(false); list.reload(); setSel(csg); showToast(`${csg} created`, 'success'); }} />}
      {sel && <Detail csg={sel} onClose={() => { setSel(null); list.reload(); }} />}
    </div>
  );
}

function NewCsg({ onClose, onDone }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <Modal title="New consignment" onClose={busy ? undefined : onClose}>
      <Field label="Notes (optional)"><input className="in" maxLength={200} value={notes} onChange={e => setNotes(e.target.value)} autoFocus /></Field>
      {err && <div className="err">{err}</div>}
      <div className="row end" style={{ marginTop: 16 }}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await act('consignment_create', { notes: notes.trim() || null });
          setBusy(false);
          if (!r.ok) { setErr(say(r)); return; }
          onDone(r.data.csg_no);
        }}>{busy ? 'Creating…' : 'Create draft'}</button>
      </div>
    </Modal>
  );
}

function Detail({ csg, onClose }) {
  const { showToast } = useToast();
  const d = useLoad(`/v/consignment?csg_no=${encodeURIComponent(csg)}`);
  const cartons = useLoad('/v/cartons');
  const [scan, setScan] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [modal, setModal] = useState(null);
  const scanRef = useRef(null);
  const c = d.data;
  const draft = c?.status === 'draft';
  useScanCapture(scanRef, draft, 1);              // this detail is itself a dialog (layer 1)
  const ready = (cartons.data || []).filter(x => x.status === 'closed' && !x.consignment);

  const run = async (route, body, okMsg) => {
    setBusy(true); setErr(null);
    const r = await act(route, body);
    setBusy(false);
    if (!r.ok) { setErr(say(r)); return false; }
    if (okMsg) showToast(okMsg, 'success');
    d.reload(); cartons.reload();
    setTimeout(() => scanRef.current?.focus(), 0);           // a removed row took focus with it: back to the scanner
    return true;
  };
  const add = async raw => {
    const v = clean(raw);
    setScan('');
    if (busy) { setErr(`Still working — ${v || 'that scan'} was not added. Scan it again.`); return; }
    if (!CTN_RE.test(v)) { setErr('Scan a carton label (CTN-…).'); return; }
    await run('consignment_add', { csg_no: csg, ctn_no: v }, `${v} added`);
    setTimeout(() => scanRef.current?.focus(), 0);
  };
  const addAll = async () => {
    for (const x of ready) {
      // One at a time, each its own action: a refusal names the carton and stops there.
      if (!(await run('consignment_add', { csg_no: csg, ctn_no: x.ctn_no }))) return;
    }
    showToast(`${ready.length} cartons added`, 'success');
  };

  return (
    <Modal title={csg} onClose={busy || modal ? undefined : onClose} wide>
      {d.loading ? <div className="empty">Loading…</div> : d.error ? <div className="err">{d.error}</div> : (
        <div className="stack">
          <div className="row">
            <Badge s={c.status} />
            <span className="mono">{c.total_cartons} cartons · {c.total_units} units</span>
            {c.challan_no && <span className="muted">Challan <span className="mono">{c.challan_no}</span></span>}
            {c.vehicle_no && <span className="muted">Vehicle <span className="mono">{c.vehicle_no}</span></span>}
            {c.dispatched_at && <span className="dim">dispatched {fmtTime(c.dispatched_at)}</span>}
          </div>
          {c.lines?.length > 0 && (
            <table className="t">
              <thead><tr><th>SKU</th><th>Product</th><th>Channel</th><th className="n">Cartons</th><th className="n">Units</th></tr></thead>
              <tbody>{c.lines.map(l => <tr key={l.sku + l.channel}><td className="mono">{l.sku}</td><td>{[l.product, l.model, l.color].filter(Boolean).join(' · ')}</td><td>{l.channel}</td><td className="n">{l.cartons}</td><td className="n">{l.units}</td></tr>)}</tbody>
            </table>
          )}
          <div>
            <h3 style={{ fontSize: 13, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Cartons</h3>
            {!c.cartons.length ? <div className="dim">No cartons yet.</div> : (
              <table className="t"><tbody>
                {c.cartons.map(x => (
                  <tr key={x.ctn_no}>
                    <td className="mono">{x.ctn_no} <span className="dim">v{x.manifest_version}</span></td><td className="mono">{x.sku}</td><td>{x.channel}</td><td className="n">{x.unit_count}</td>
                    <td style={{ textAlign: 'right' }}>{draft && <button className="btn sm" disabled={busy} onClick={() => run('consignment_remove', { csg_no: csg, ctn_no: x.ctn_no }, `${x.ctn_no} removed`)}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
          {c.receipt && <Receipt r={c.receipt} status={c.status} />}
          {draft && (
            <div className="card" style={{ background: 'var(--surface2)' }}>
              <div className="spread">
                <form className="row" onSubmit={e => { e.preventDefault(); add(scan); }}>
                  <input ref={scanRef} className="in mono" style={{ width: 240 }} placeholder="scan a carton label" value={scan} onChange={e => setScan(e.target.value)} autoFocus />
                  <button className="btn" disabled={!scan}>Add</button>
                </form>
                <button className="btn sm" disabled={busy || !ready.length} onClick={addAll}>Add all ready ({ready.length})</button>
              </div>
              {ready.length > 0 && <div className="dim" style={{ marginTop: 8, fontSize: 13 }}>Ready: {ready.map(x => x.ctn_no).join(', ')}</div>}
            </div>
          )}
          {err && <div className="err">{err}</div>}
          <div className="row end">
            <button className="btn" disabled={busy || !c.cartons.length} onClick={async () => { const m = await printNote(csg); if (m) setErr(m); }}>Print packing note</button>
            {draft && <button className="btn danger" disabled={busy} onClick={() => setModal('cancel')}>Cancel consignment</button>}
            {draft && <button className="btn primary" disabled={busy || !c.cartons.length} onClick={() => setModal('dispatch')}>Dispatch…</button>}
          </div>
        </div>
      )}
      {modal === 'cancel' && (
        <Confirm title={`Cancel ${csg}?`} danger yes="Cancel consignment" onClose={() => setModal(null)}
          body="Its cartons go back to ready-to-ship." onYes={async () => {
            const r = await act('consignment_cancel', { csg_no: csg });
            if (!r.ok) return say(r);
            setModal(null); showToast(`${csg} cancelled`, 'success'); onClose();
            return null;
          }} />
      )}
      {modal === 'dispatch' && c && <Dispatch c={c} onClose={() => setModal(null)} onDone={() => {
        setModal(null); d.reload(); showToast(`${csg} dispatched`, 'success');
      }} />}
    </Modal>
  );
}

function Dispatch({ c, onClose, onDone }) {
  const [f, setF] = useState({ challan_no: '', challan_date: todayIST(), vehicle_no: '', eway_bill_no: '', transporter: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  const go = async e => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await act('consignment_dispatch', { csg_no: c.csg_no, challan_no: f.challan_no.trim(), challan_date: f.challan_date,
      vehicle_no: f.vehicle_no.trim(), eway_bill_no: f.eway_bill_no.trim() || null, transporter: f.transporter.trim() || null });
    setBusy(false);
    if (!r.ok) { setErr(say(r)); return; }
    onDone();
  };
  return (
    <Modal title={`Dispatch ${c.csg_no}`} onClose={busy ? undefined : onClose}>
      <form onSubmit={go} className="stack">
        <p className="muted">{c.total_cartons} cartons, {c.total_units} units. After dispatch nothing in it can be un-packed or changed here.</p>
        <Field label="Delivery challan no. (your GST challan)"><input className="in mono" maxLength={40} value={f.challan_no} onChange={set('challan_no')} autoFocus /></Field>
        <Field label="Challan date"><input className="in" type="date" value={f.challan_date} max={todayIST()} onChange={set('challan_date')} /></Field>
        <Field label="Vehicle no."><input className="in mono" placeholder="MH15AB1234" value={f.vehicle_no} onChange={set('vehicle_no')} /></Field>
        <Field label="E-way bill no. (12 digits, if any)"><input className="in mono" inputMode="numeric" maxLength={12} value={f.eway_bill_no} onChange={e => setF(x => ({ ...x, eway_bill_no: e.target.value.replace(/\D/g, '') }))} /></Field>
        <Field label="Transporter (optional)"><input className="in" maxLength={80} value={f.transporter} onChange={set('transporter')} /></Field>
        {err && <div className="err">{err}</div>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Back</button>
          <button className="btn primary" disabled={busy || !f.challan_no.trim() || !f.vehicle_no.trim() || !f.challan_date}>{busy ? 'Dispatching…' : 'Dispatch'}</button>
        </div>
      </form>
    </Modal>
  );
}

// LOT's receipt of this consignment (O8): what was counted at LOT, what was missing, and — once LOT has accepted it —
// the units its QC rejected with the reason. Rejects marked "return" come back to this site unpacked: fix them and
// pack the same stickers again.
function Receipt({ r, status }) {
  const n = v => (v == null ? '—' : v);
  return (
    <div className="card" style={{ background: 'var(--surface2)' }}>
      <h3 style={{ fontSize: 13, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '0 0 8px' }}>Received at LOT</h3>
      <div className="row">
        <span>Sent <b className="mono">{n(r.expected)}</b></span>
        <span>Received <b className="mono">{r.finished_at ? n(r.received) : 'counting…'}</b></span>
        {r.short > 0 && <span className="err" style={{ padding: '2px 8px' }}>Short <b className="mono">{r.short}</b></span>}
        {status === 'accepted' && <span>Accepted <b className="mono">{n(r.accepted)}</b></span>}
        {status === 'accepted' && r.rejected > 0 && <span>Rejected <b className="mono">{r.rejected}</b></span>}
        {(status === 'audit' || status === 'hold') && <span className="dim">quality check in progress</span>}
      </div>
      {r.short_units?.length > 0 && (
        <div className="dim" style={{ marginTop: 8, fontSize: 13 }}>Not found at LOT: {r.short_units.map(u => `${u.car_upc} (${u.ctn_no})`).join(', ')}</div>
      )}
      {r.rejections?.length > 0 && (
        <table className="t" style={{ marginTop: 8 }}>
          <thead><tr><th>Unit</th><th>Carton</th><th>Reason</th><th>What happens</th></tr></thead>
          <tbody>{r.rejections.map(j => (
            <tr key={j.car_upc}><td className="mono">{j.batch_label || j.car_upc}</td><td className="mono">{j.ctn_no}</td><td>{j.reason}</td>
              <td>{j.disposition === 'return_vendor' ? 'Coming back to you — fix and re-pack' : j.disposition === 'rework_lot' ? 'Reworked at LOT' : 'LOT to decide'}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
