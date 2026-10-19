'use client';
// Pair & Pack: pick an order — or NO ORDER (S428 O12: the car sticker says what is being packed; the bench picks only the
// packaging, ecom / retail / export) — scan the CAR sticker, then the REMOTE sticker → one /v/pack. The batch label + EAN label
// print on this bench's printer; the unit goes into this bench's carton (per order, or per SKU × packaging with no order),
// which closes (and prints its CTN label) at capacity.
// Two ways to scan, chosen per device: a USB scanner (types the code + Enter) or the phone's camera (Camera.js, the
// factory Scanner's engine). The camera runs only while an order is picked and no dialog is open.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { act, say } from './api.js';
import { beep, Confirm, Field, fmtTime, StepUp, useLoad, useScanCapture } from './ui.js';
import { BATCH_RE, classify, clean, UPC_RE } from './scan.mjs';
import CameraView from './Camera.js';

const WO_KEY = 'outpost.wo';
const PT_KEY = 'outpost.pack_type';           // the packaging used with no order (per device)
const NONE = 'none';                          // the "no order" choice in the order picker
const NO_ORDER = { id: NONE, none: true };
const PACK_TYPES = [['ecom', 'Ecom'], ['retail', 'Retail'], ['export', 'Export']];
const INPUT_KEY = 'outpost.input';            // 'camera' | 'scanner'; unset = camera on a touch screen, scanner otherwise
const QR = ['qr_code'];                       // the LOT sticker; the box's EAN barcode is never read here
// Default input for this device: what it chose before, else camera on a phone (touch screen), else the USB scanner.
export function useInputMode() {
  const [mode, setMode] = useState(null);
  useEffect(() => {
    let m = null;
    try { m = localStorage.getItem(INPUT_KEY); } catch { /* none */ }
    if (m !== 'camera' && m !== 'scanner') m = window.matchMedia?.('(pointer: coarse)').matches ? 'camera' : 'scanner';
    setMode(m);
  }, []);
  const choose = m => { setMode(m); try { localStorage.setItem(INPUT_KEY, m); } catch { /* none */ } };
  return [mode, choose];
}
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
  const [carton, setCarton] = useState(undefined);  // this bench's open carton for the order (undefined = from the list; always so with no order)
  const [modal, setModal] = useState(null);
  const [mode, setMode] = useInputMode();
  const [packType, setPackType] = useState('ecom');
  const [timing, setTiming] = useState(null);       // camera: { beepMs (read → beep), serverMs (the /v/pack part) } of the last scan
  const input = useRef(null);
  const cam = useRef(null);
  const busyRef = useRef(false);
  // Read synchronously: a camera read can land after a pack returns but before React re-renders, and must see the
  // car / order as they are NOW, not as the last render saw them (else it pairs the packed car with the next sticker).
  const carRef = useRef(null);
  const woRef = useRef(null);
  const lastPacked = useRef(new Set());             // the unit just packed: its stickers, still in view, are not re-read
  const lastTwo = useRef(0);
  const camera = mode === 'camera';
  const putCar = v => { carRef.current = v; setCar(v); };

  useEffect(() => {
    try {
      const w = localStorage.getItem(WO_KEY);
      if (w === NONE) setWoId(NONE); else if (Number(w)) setWoId(Number(w));
      const t = localStorage.getItem(PT_KEY);
      if (PACK_TYPES.some(([k]) => k === t)) setPackType(t);
    } catch { /* none */ }
  }, []);
  const list = orders.data || [];
  const wo = woId === NONE ? NO_ORDER : list.find(o => Number(o.id) === Number(woId)) || null;
  woRef.current = wo;
  const ptRef = useRef(packType);
  ptRef.current = packType;
  const pickType = t => {
    setPackType(t); setCarton(undefined); setResult(null);
    try { localStorage.setItem(PT_KEY, t); } catch { /* none */ }
    setTimeout(() => input.current?.focus(), 0);
  };
  const pickWo = id => {
    setWoId(id); putCar(null); setResult(null); setCarton(undefined);
    try { localStorage.setItem(WO_KEY, String(id || '')); } catch { /* none */ }
    setTimeout(() => input.current?.focus(), 0);
  };

  // This device's open carton(s) (pack_unit keys them on the device, not the bench number): one for an order; with no
  // order, one per SKU at this packaging — the card lists them all, the last one packed into first.
  const mineOpen = (cartons.data || []).filter(c => c.status === 'open' && c.mine === true && c.unit_count > 0
    && (wo?.none ? !c.work_orders && c.pack_type === packType : wo && c.work_orders?.wo_no === wo.wo_no))
    .map(c => ({ ctn_no: c.ctn_no, sku: c.sku, unit_count: c.unit_count, capacity: c.capacity }));
  const openList = carton === undefined ? mineOpen : carton ? [carton] : [];
  const [closing, setClosing] = useState(null);

  useScanCapture(input, !camera);

  // A USB scanner plugged into a camera-mode device still works: an Enter-ended burst of keys is a scan.
  useEffect(() => {
    if (!camera || modal) return undefined;
    let buf = '', last = 0;
    const k = e => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
      const now = performance.now();
      if (now - last > 100) buf = '';
      last = now;
      if (e.key === 'Enter') { if (buf.length >= 6) { e.preventDefault(); onScanRef.current(buf); } buf = ''; return; }
      if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [camera, modal]);

  const fail = useCallback((title, why) => { beep(false); cam.current?.flash(false); setResult({ ok: false, title, lines: why ? [why] : [] }); }, []);

  // `at` = when the camera read the code (performance.now()); absent for the USB scanner.
  const onScan = async (raw, at) => {
    const v = clean(raw);
    setScan('');
    if (!v) return;
    if (busyRef.current) { fail('Still packing the last unit', `${v} was not read — scan it again.`); return; }
    const wo = woRef.current, car = carRef.current;
    if (!wo) { fail('Pick the order first'); return; }
    const kind = classify(v);
    if (kind !== 'upc') { fail(NOT_A_STICKER[kind], v); return; }
    if (!car) {
      putCar(v); setResult(null); beep(true); cam.current?.flash(true);
      if (at) setTiming({ beepMs: performance.now() - at, serverMs: null });
      return;
    }
    if (v === car) { fail('Same sticker scanned twice', 'Scan the REMOTE sticker now.'); return; }
    busyRef.current = true; setBusy(true);
    const sent = performance.now();
    const r = await act('pack', wo.none ? { work_order_id: null, pack_type: ptRef.current, car_upc: car, remote_upc: v }
                                        : { work_order_id: Number(wo.id), car_upc: car, remote_upc: v });
    busyRef.current = false; setBusy(false);
    putCar(null);
    if (!r.ok) { fail('Not packed', say(r)); return; }
    const d = r.data;
    lastPacked.current = new Set([d.car_upc, d.remote_upc]);
    beep(true); cam.current?.flash(true);
    if (at) setTiming({ beepMs: performance.now() - at, serverMs: performance.now() - sent });
    if (d.work_order) setProgress(p => ({ ...p, [wo.id]: { packed: d.work_order.packed, target_qty: d.work_order.target_qty } }));
    if (wo.none) cartons.reload();   // several open cartons (one per SKU): re-read rather than guess which one changed
    setCarton(wo.none ? undefined
      : d.carton.closed ? null : { ctn_no: d.carton.ctn_no, sku: d.sku, unit_count: d.carton.unit_count, capacity: d.carton.capacity });
    setResult({ ok: true, title: d.replayed ? `Already packed · ${d.batch_label}` : `Packed · ${d.batch_label}`,
      lines: [`${d.sku}${d.color ? ` · ${d.color}` : ''} · ${d.pack_type || ''} — car ${d.car_upc} + remote ${d.remote_upc}`,
        d.carton.closed ? `Carton ${d.carton.ctn_no} is FULL (${d.carton.unit_count}) — its CTN label is printing. Seal it.`
          : `Carton ${d.carton.ctn_no}: ${d.carton.unit_count} of ${d.carton.capacity}`] });
    setRecent(x => [{ at: new Date().toISOString(), label: d.batch_label, car: d.car_upc, remote: d.remote_upc, ctn: d.carton.ctn_no }, ...x].slice(0, 12));
    if (d.carton.closed) cartons.reload();
  };

  // Camera codes: one LOT sticker at a time. While a pack is saving, a new sticker is left unread (false) and read again
  // as soon as it lands, instead of being refused like a USB scan (the camera cannot be asked to "scan it again").
  // Ignored without a sound: any QR that is not a LOT sticker (a QR on the packaging passing the lens), the car already
  // taken, and the unit just packed. Two new stickers at once are left unread and refused at most every 1.5 s, so the
  // one that stays is read the moment the other leaves.
  const onCodes = (values, at) => {
    if (busyRef.current) return false;
    const stickers = values.map(clean).filter(v => classify(v) === 'upc' && v !== carRef.current && !lastPacked.current.has(v));
    if (!stickers.length) return true;
    if (stickers.length > 1) {
      if (performance.now() - lastTwo.current > 1500) { lastTwo.current = performance.now(); fail('Two stickers in view', 'Show the camera one sticker at a time.'); }
      return false;
    }
    onScan(stickers[0], at);
    return true;
  };
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const prog = wo && progress[wo.id];
  return (
    <div className="packgrid">
      <div>
        <div className="card">
          <Field label="Order on this bench">
            <select className="in" value={wo ? wo.id : ''} disabled={busy}
              onChange={e => pickWo(e.target.value === NONE ? NONE : Number(e.target.value) || null)}>
              <option value="">— pick —</option>
              <option value={NONE}>No order — pack for LOT (the sticker says what it is)</option>
              {list.map(o => <option key={o.id} value={o.id}>{o.wo_no} · {o.sku} · {o.vendor_products?.product} · {o.channel} · target {o.target_qty}</option>)}
            </select>
          </Field>
          {wo?.none && (
            <Field label="Packaging">
              <div className="row">
                {PACK_TYPES.map(([k, l]) => (
                  <button key={k} type="button" className={`btn sm ${packType === k ? 'primary' : ''}`} disabled={busy}
                    onClick={() => pickType(k)}>{l}</button>
                ))}
              </div>
            </Field>
          )}
          {orders.error && <div className="err">{orders.error}</div>}
          {prog && <div className="muted" style={{ marginTop: 10 }}>Packed on this order: <b className="mono">{prog.packed}</b> of {prog.target_qty}</div>}
        </div>

        <div className="card">
          <div className={`scanbox ${wo && !busy ? 'live' : ''} ${camera ? 'withcam' : ''}`}>
            <div className="prompt">{busy ? 'Packing…' : !wo ? 'Pick the order' : car ? 'Scan the REMOTE sticker' : 'Scan the CAR sticker'}</div>
            {camera && wo && (
              <div style={{ marginTop: 12 }}>
                <CameraView ref={cam} on={!modal} formats={QR} onCodes={onCodes} showStats />
                {timing && (
                  <div className="dim camstats">Read → beep {Math.round(timing.beepMs)} ms{timing.serverMs != null ? ` (packing on the server: ${Math.round(timing.serverMs)} ms)` : ''}</div>
                )}
              </div>
            )}
            {mode === 'scanner' && (
              <input ref={input} className="in" value={scan} autoFocus disabled={!wo} placeholder="scan…" autoComplete="off" spellCheck={false}
                onChange={e => setScan(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); onScan(scan); }
                  if (e.key === 'Escape') { putCar(null); setScan(''); setResult(null); }
                }} />
            )}
            <div className="steps">
              <div className={`step ${car ? 'done' : ''}`}><div className="k">1 · Car</div><div className="v">{car || ''}</div></div>
              <div className="step"><div className="k">2 · Remote</div><div className="v">{busy ? '…' : ''}</div></div>
            </div>
            <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
              {car && !busy && <button className="btn sm" onClick={() => { putCar(null); setResult(null); }}>Start again{camera ? '' : ' (Esc)'}</button>}
              {mode && <button className="btn sm" disabled={busy} onClick={() => { setMode(camera ? 'scanner' : 'camera'); putCar(null); setResult(null); setTiming(null); }}>
                {camera ? 'Use a USB scanner' : 'Use the camera'}</button>}
            </div>
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
          <h3>{wo?.none ? `This bench’s ${packType} cartons` : 'This bench’s carton'}</h3>
          {openList.length ? openList.map(o => (
            <div key={o.ctn_no} style={{ marginBottom: 14 }}>
              <div className="spread"><span className="mono" style={{ fontSize: 20 }}>{o.ctn_no}{wo?.none && o.sku ? ` · ${o.sku}` : ''}</span><span className="mono">{o.unit_count} / {o.capacity}</span></div>
              <div className="bar" style={{ marginTop: 8 }}><i style={{ width: `${Math.min(100, (100 * o.unit_count) / o.capacity)}%` }} /></div>
              <button className="btn sm" style={{ marginTop: 12 }} onClick={() => { setClosing(o); setModal('close'); }}>Close carton short</button>
            </div>
          )) : <div className="muted">{wo ? 'The next pack opens a new carton.' : '—'}</div>}
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

      {modal === 'close' && closing && (
        <Confirm title={`Close ${closing.ctn_no}?`} yes="Close carton" onClose={() => { setModal(null); setClosing(null); }}
          body={`It has ${closing.unit_count} of ${closing.capacity} units. Its CTN label prints now and the next pack opens a new carton.`}
          onYes={async () => {
            const r = await act('close_carton', { ctn_no: closing.ctn_no });
            if (!r.ok) return say(r);
            setModal(null); setCarton(undefined); setClosing(null); cartons.reload();
            showToast(`${closing.ctn_no} closed with ${r.data.unit_count} units — CTN label printing`, 'success');
            return null;
          }} />
      )}
      {modal === 'unpack' && <Unpack camera={camera} onClose={() => setModal(null)} onDone={d => {
        setModal(null); setCarton(undefined); setResult(null); cartons.reload();
        showToast(`Un-packed ${d.batch_label}. Both stickers can be packed again.`, 'success');
      }} />}
    </div>
  );
}

const UNPACK_FORMATS = ['qr_code', 'code_128'];   // the stickers, and the batch label in either symbology
const REASONS = ['Damaged after packing', 'Wrong pairing', 'Wrong order / channel', 'Failed check', 'Other'];

function Unpack({ camera, onClose, onDone }) {
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
      {/* The camera stops at the first good read, so nothing passing the lens afterwards can change which unit is un-packed. */}
      {camera && !valid && <CameraView formats={UNPACK_FORMATS} onCodes={vals => { const c = vals.map(clean).find(x => UPC_RE.test(x) || BATCH_RE.test(x)); if (c) { setUpc(c); beep(true); } return true; }} />}
      {camera && valid && <button type="button" className="btn sm" onClick={() => setUpc('')}>Scan a different unit</button>}
      <Field label="Car sticker, remote sticker or batch label">
        <input className="in mono" autoFocus={!camera} value={upc} onChange={e => setUpc(e.target.value)} placeholder="scan…" autoComplete="off"
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
