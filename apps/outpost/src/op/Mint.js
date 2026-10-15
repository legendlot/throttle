'use client';
// Stickers (supervisor): mint a block of LOT UPC stickers for one car colour or the product's remote. The sheets print
// on the site's sticker printer by themselves (one print job per 500). Stickers are bound to this vendor + that code.
import { useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { act, say } from './api.js';
import { Badge, Confirm, Field, fmtTime, useLoad } from './ui.js';

export default function Mint({ goto }) {
  const { showToast } = useToast();
  const products = useLoad('/v/products');
  const batches = useLoad('/v/batches');
  const [code, setCode] = useState('');
  const [qty, setQty] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [last, setLast] = useState(null);

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
            <div style={{ marginTop: 4 }}>{last.print_jobs} sheet job{last.print_jobs === 1 ? '' : 's'} sent to the sticker printer.
              {' '}<button className="btn sm" onClick={() => goto('printing')}>Watch printing</button></div>
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
            <thead><tr><th>Batch</th><th>Code</th><th className="n">Qty</th><th>Range</th><th>Status</th><th>When</th></tr></thead>
            <tbody>{batches.data.map(b => (
              <tr key={b.batch_id}><td className="mono">{b.batch_id}</td><td className="mono">{b.product_code}</td><td className="n">{b.quantity}</td>
                <td className="mono dim" style={{ fontSize: 12 }}>{b.upc_from} → {b.upc_to}</td><td><Badge s={b.status} /></td><td className="dim">{fmtTime(b.generated_at)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {confirm && pick && (
        <Confirm title={`Mint ${n.toLocaleString('en-IN')} stickers?`} yes="Mint" onClose={() => setConfirm(false)}
          body={`${pick.code} · ${pick.label}. They print on the sticker printer and can only be used for ${pick.code}.`}
          onYes={async () => {
            const r = await act('mint', { product_code: pick.code, quantity: n });
            if (!r.ok) return say(r);
            setConfirm(false); setLast(r.data); setQty(''); batches.reload();
            showToast(`${r.data.batch_id}: ${r.data.quantity} stickers minted`, 'success');
            return null;
          }} />
      )}
    </div>
  );
}
