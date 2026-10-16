'use client';
// Stickers (supervisor): mint a block of LOT UPC stickers for one car colour or the product's remote, then print the A3
// sticker sheet from the browser, the same sheet the factory prints. Stickers are bound to this vendor + that code.
import { useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { act, get, say } from './api.js';
import { buildStickerSheet } from './stickerSheet.mjs';
import { Badge, Confirm, Field, fmtTime, useLoad } from './ui.js';

// The sheet prints itself once its QR codes are drawn, so the window is opened without printWindow's own print() call
// (that would raise a second dialog). Reprints carry only stickers not yet on a unit.
export async function printSheet(batchId) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return 'The print window was blocked. Allow pop-ups for Outpost.';
  const r = await get(`/v/batch_sheet?batch_id=${encodeURIComponent(batchId)}`);
  if (!r.ok) { if (!w.closed) w.close(); return say(r); }
  if (w.closed) return null;                     // the supervisor closed it while the batch loaded
  if (!r.data.rows.length) { w.close(); return `Every sticker in ${batchId} is already on a unit or voided.`; }
  try {
    w.document.write(buildStickerSheet(r.data));
    w.document.close();
    w.focus();
  } catch {
    try { w.close(); } catch { /* already gone */ }
    return 'The print window closed before the sheet loaded. Try again.';
  }
  return null;
}

export default function Mint() {
  const { showToast } = useToast();
  const products = useLoad('/v/products');
  const batches = useLoad('/v/batches');
  const [code, setCode] = useState('');
  const [qty, setQty] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [last, setLast] = useState(null);
  const sheet = async id => { const e = await printSheet(id); if (e) showToast(e, 'error'); };

  const options = [];
  for (const p of products.data || []) {
    for (const c of p.cars) options.push({ code: c.code, label: `${p.product} · ${[c.model, c.color].filter(Boolean).join(' ')} (car)`, ean: c.ean });
    if (p.remote_code && !options.some(o => o.code === p.remote_code)) options.push({ code: p.remote_code, label: `${p.product} remote`, ean: null });
  }
  const pick = options.find(o => o.code === code);
  const n = Number(qty);
  const valid = pick && Number.isInteger(n) && n >= 1 && n <= 10000;

  return (
    <div className="grid2">
      <div className="card">
        <h2>Mint stickers</h2>
        {products.error && <div className="err">{products.error}</div>}
        <div className="stack">
          <Field label="For">
            <select className="in" value={code} onChange={e => setCode(e.target.value)}>
              <option value="">— pick the car colour or remote —</option>
              {options.map(o => <option key={o.code} value={o.code}>{o.code} · {o.label}</option>)}
            </select>
          </Field>
          {pick?.ean && <div className="dim mono" style={{ fontSize: 13 }}>EAN {pick.ean}</div>}
          <Field label="How many (1 – 10,000)">
            <input className="in mono" inputMode="numeric" value={qty} onChange={e => setQty(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <button className="btn primary wide" disabled={!valid} onClick={() => setConfirm(true)}>Mint</button>
        </div>
        {last && (
          <div className="result ok">
            <div className="big">{last.quantity} stickers · {last.batch_id}</div>
            <div className="mono" style={{ marginTop: 4 }}>{last.upc_from} → {last.upc_to}</div>
            <div style={{ marginTop: 4 }}>
              <button className="btn primary sm" onClick={() => sheet(last.batch_id)}>Print sticker sheet</button></div>
          </div>
        )}
        <p className="dim" style={{ fontSize: 13, marginTop: 14 }}>
          Mint only what the floor will use soon. Every sticker is counted: applied, voided or still on the roll.
        </p>
      </div>
      <div className="card">
        <div className="spread" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Recent batches</h2><button className="btn sm" onClick={batches.reload}>Refresh</button></div>
        {batches.error && <div className="err">{batches.error}</div>}
        {!(batches.data || []).length ? <div className="empty">No batches yet.</div> : (
          <table className="t">
            <thead><tr><th>Batch</th><th>Code</th><th className="n">Qty</th><th>Range</th><th>Status</th><th>When</th><th></th></tr></thead>
            <tbody>{batches.data.map(b => (
              <tr key={b.batch_id}><td className="mono">{b.batch_id}</td><td className="mono">{b.product_code}</td><td className="n">{b.quantity}</td>
                <td className="mono dim" style={{ fontSize: 12 }}>{b.upc_from} → {b.upc_to}</td><td><Badge s={b.status} /></td><td className="dim">{fmtTime(b.generated_at)}</td>
                <td><button className="btn sm" onClick={() => sheet(b.batch_id)}>Print sheet</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {confirm && pick && (
        <Confirm title={`Mint ${n.toLocaleString('en-IN')} stickers?`} yes="Mint" onClose={() => setConfirm(false)}
          body={`${pick.code} · ${pick.label}. You print them as an A3 sheet next, and they can only be used for ${pick.code}.`}
          onYes={async () => {
            const r = await act('mint', { product_code: pick.code, quantity: n });
            if (!r.ok) return say(r);
            setConfirm(false); setLast(r.data); setQty(''); batches.reload();
            // Not opened here: after an await the browser blocks the pop-up. The result card's button opens it.
            showToast(`${r.data.batch_id}: ${r.data.quantity} stickers minted. Print the sheet next.`, 'success');
            return null;
          }} />
      )}
    </div>
  );
}
