'use client';
// Pair & Pack: pick the order, scan the CAR sticker, then the REMOTE sticker → one /v/pack. The batch label + EAN label
// print on this bench's printer; the unit goes into this bench's carton, which closes (and prints its CTN label) at capacity.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { act, say } from './api.js';
import { beep, Confirm, Field, fmtTime, StepUp, useLoad, useScanCapture } from './ui.js';
import { BATCH_RE, classify, clean, UPC_RE } from './scan.mjs';

const WO_KEY = 'outpost.wo';
const NOT_A_STICKER = {
  batch: 'That is a batch label. Scan the LOT sticker.',
  ctn: 'That is a carton label. Scan the LOT sticker.',
  ean: 'That is the EAN barcode. Scan the LOT sticker.',
  other: 'Not a LOT sticker.',
};

export default function Pack({ me }) {
  const { showToast } = useToast();
  const orders = useLoad('/v/orders');
  const cartons = useLoad('/v/cartons');
  const [woId, setWoId] = useState(null);
  const [car, setCar] = useState(null);
  const [scan, setScan] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);       // { ok, title, lines[] }
  const [recent, setRecent] = useState([]);
  const [progress, setProgress] = useState({});     // wo id → { packed, target_qty }
  const [carton, setCarton] = useState(undefined);  // this bench's open carton for the order (undefined = from the list)
  const [modal, setModal] = useState(null);
  const input = useRef(null);

  useEffect(() => { try { const v = Number(localStorage.getItem(WO_KEY)); if (v) setWoId(v); } catch { /* none */ } }, []);
  const list = orders.data || [];
  const wo = list.find(o => Number(o.id) === Number(woId)) || null;
  const pickWo = id => {
    setWoId(id); setCar(null); setResult(null); setCarton(undefined);
    try { localStorage.setItem(WO_KEY, String(id || '')); } catch { /* none */ }
    setTimeout(() => input.current?.focus(), 0);
  };

  // This device's open carton for the order (pack_unit keys it on the device, not the bench number).
  const listCarton = wo && (cartons.data || []).find(c => c.status === 'open' && c.mine === true && c.work_orders?.wo_no === wo.wo_no);
  const open = carton === undefined ? (listCarton ? { ctn_no: listCarton.ctn_no, unit_count: listCarton.unit_count, capacity: listCarton.capacity } : null) : carton;

  useScanCapture(input);

  const fail = useCallback((title, why) => { beep(false); setResult({ ok: false, title, lines: why ? [why] : [] }); }, []);

  const onScan = async raw => {
    const v = clean(raw);
    setScan('');
    if (!v) return;
    if (busy) { fail('Still packing the last unit', `${v} was not read — scan it again.`); return; }
    if (!wo) { fail('Pick the order first'); return; }
    const kind = classify(v);
    if (kind !== 'upc') { fail(NOT_A_STICKER[kind], v); return; }
    if (!car) { setCar(v); setResult(null); beep(true); return; }
    if (v === car) { fail('Same sticker scanned twice', 'Scan the REMOTE sticker now.'); return; }
    setBusy(true);
    const r = await act('pack', { work_order_id: Number(wo.id), car_upc: car, remote_upc: v });
    setBusy(false);
    setCar(null);
    if (!r.ok) { fail('Not packed', say(r)); return; }
    const d = r.data;
    beep(true);
    setProgress(p => ({ ...p, [wo.id]: { packed: d.work_order.packed, target_qty: d.work_order.target_qty } }));
    setCarton(d.carton.closed ? null : { ctn_no: d.carton.ctn_no, unit_count: d.carton.unit_count, capacity: d.carton.capacity });
    setResult({ ok: true, title: d.replayed ? `Already packed · ${d.batch_label}` : `Packed · ${d.batch_label}`,
      lines: [`Car ${d.car_upc} + remote ${d.remote_upc}`,
        d.carton.closed ? `Carton ${d.carton.ctn_no} is FULL (${d.carton.unit_count}) — its CTN label is printing. Seal it.`
          : `Carton ${d.carton.ctn_no}: ${d.carton.unit_count} of ${d.carton.capacity}`] });
    setRecent(x => [{ at: new Date().toISOString(), label: d.batch_label, car: d.car_upc, remote: d.remote_upc, ctn: d.carton.ctn_no }, ...x].slice(0, 12));
    if (d.carton.closed) cartons.reload();
  };

  const prog = wo && progress[wo.id];
  return (
    <div className="packgrid">
      <div>
        <div className="card">
          <Field label="Order on this bench">
            <select className="in" value={wo ? wo.id : ''} disabled={busy} onChange={e => pickWo(Number(e.target.value) || null)}>
              <option value="">— pick the order —</option>
              {list.map(o => <option key={o.id} value={o.id}>{o.wo_no} · {o.sku} · {o.vendor_products?.product} · {o.channel} · target {o.target_qty}</option>)}
            </select>
          </Field>
          {orders.error && <div className="err">{orders.error}</div>}
          {!orders.loading && !list.length && !orders.error && <div className="muted" style={{ marginTop: 10 }}>No open orders. LOT opens orders in Depot.</div>}
          {prog && <div className="muted" style={{ marginTop: 10 }}>Packed on this order: <b className="mono">{prog.packed}</b> of {prog.target_qty}</div>}
        </div>

        <div className="card">
          <div className={`scanbox ${wo && !busy ? 'live' : ''}`}>
            <div className="prompt">{busy ? 'Packing…' : !wo ? 'Pick the order' : car ? 'Scan the REMOTE sticker' : 'Scan the CAR sticker'}</div>
            <input ref={input} className="in" value={scan} autoFocus disabled={!wo} placeholder="scan…" autoComplete="off" spellCheck={false}
              onChange={e => setScan(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); onScan(scan); }
                if (e.key === 'Escape') { setCar(null); setScan(''); setResult(null); }
              }} />
            <div className="steps">
              <div className={`step ${car ? 'done' : ''}`}><div className="k">1 · Car</div><div className="v">{car || ''}</div></div>
              <div className="step"><div className="k">2 · Remote</div><div className="v">{busy ? '…' : ''}</div></div>
            </div>
            {car && !busy && <button className="btn sm" style={{ marginTop: 12 }} onClick={() => { setCar(null); setResult(null); }}>Start again (Esc)</button>}
          </div>
          {result && (
            <div className={`result ${result.ok ? 'ok' : 'bad'}`}>
              <div className="big">{result.title}</div>
              {result.lines.map((l, i) => <div key={i} style={{ marginTop: 4 }}>{l}</div>)}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="card">
          <h3>This bench’s carton</h3>
          {open && open.unit_count > 0 ? (
            <>
              <div className="spread"><span className="mono" style={{ fontSize: 20 }}>{open.ctn_no}</span><span className="mono">{open.unit_count} / {open.capacity}</span></div>
              <div className="bar" style={{ marginTop: 8 }}><i style={{ width: `${Math.min(100, (100 * open.unit_count) / open.capacity)}%` }} /></div>
              <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setModal('close')}>Close carton short</button>
            </>
          ) : <div className="muted">{wo ? 'The next pack opens a new carton.' : '—'}</div>}
        </div>
        <div className="card">
          <h3>Fix a mistake</h3>
          <p className="muted" style={{ fontSize: 14, marginBottom: 10 }}>Un-pack a unit that is still at the vendor. Needs a supervisor.</p>
          <button className="btn" onClick={() => setModal('unpack')}>Un-pack a unit</button>
        </div>
        <div className="card">
          <h3>Packed on this bench</h3>
          {!recent.length ? <div className="dim">Nothing yet this session.</div> : (
            <table className="t" style={{ fontSize: 13 }}><tbody>
              {recent.map(r => <tr key={r.at + r.label}><td className="mono" style={{ whiteSpace: 'nowrap' }}>{r.label}<div className="dim">{r.ctn}</div></td><td className="dim" style={{ textAlign: 'right' }}>{fmtTime(r.at)}</td></tr>)}
            </tbody></table>
          )}
        </div>
      </div>

      {modal === 'close' && open && (
        <Confirm title={`Close ${open.ctn_no}?`} yes="Close carton" onClose={() => setModal(null)}
          body={`It has ${open.unit_count} of ${open.capacity} units. Its CTN label prints now and the next pack opens a new carton.`}
          onYes={async () => {
            const r = await act('close_carton', { ctn_no: open.ctn_no });
            if (!r.ok) return say(r);
            setModal(null); setCarton(null); cartons.reload();
            showToast(`${open.ctn_no} closed with ${r.data.unit_count} units — CTN label printing`, 'success');
            return null;
          }} />
      )}
      {modal === 'unpack' && <Unpack onClose={() => setModal(null)} onDone={d => {
        setModal(null); setCarton(undefined); setResult(null); cartons.reload();
        showToast(`Un-packed ${d.batch_label}. Both stickers can be packed again.`, 'success');
      }} />}
    </div>
  );
}

const REASONS = ['Damaged after packing', 'Wrong pairing', 'Wrong order / channel', 'Failed check', 'Other'];

function Unpack({ onClose, onDone }) {
  const [upc, setUpc] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  const [detail, setDetail] = useState('');
  const v = clean(upc);
  const valid = UPC_RE.test(v) || BATCH_RE.test(v);
  const why = reason === 'Other' ? detail.trim() : detail.trim() ? `${reason}: ${detail.trim()}` : reason;
  return (
    <StepUp purpose="unpack" title="Un-pack a unit" onClose={onClose} ready={valid && !!why}
      then={async token => {
        const r = await act('unpack', { upc: v, reason: why, stepup: token });
        if (!r.ok) return say(r);
        onDone(r.data);
        return null;
      }}>
      <Field label="Car sticker, remote sticker or batch label">
        <input className="in mono" autoFocus value={upc} onChange={e => setUpc(e.target.value)} placeholder="scan…" autoComplete="off"
          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} />
      </Field>
      {upc && !valid && <div className="err">Scan a LOT sticker or a batch label.</div>}
      <Field label="Reason">
        <select className="in" value={reason} onChange={e => setReason(e.target.value)}>{REASONS.map(r => <option key={r}>{r}</option>)}</select>
      </Field>
      <Field label={reason === 'Other' ? 'What happened (required)' : 'Detail (optional)'}>
        <input className="in" value={detail} maxLength={200} onChange={e => setDetail(e.target.value)} />
      </Field>
      <p className="dim" style={{ fontSize: 13 }}>The unit’s labels are cancelled. If its carton was closed, the carton gets a new CTN label: throw the old one away.</p>
    </StepUp>
  );
}
