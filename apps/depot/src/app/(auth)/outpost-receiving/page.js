'use client';
/* ════════════════════════════════════════════════════════════
   OUTPOST › RECEIVING — LOT takes in a vendor consignment (O8, S422; reworked O12, S428).

   A consignment (CSG-NNNNN) arrives on a challan. CHECK IN at the gate:
   scan each carton label (CTN-…) — that checks in every unit in the
   sealed carton; open a carton and scan its boxes only when it looks
   wrong (a box not on the manifest is an alert to set aside). Finish:
   a carton never scanned is SHORT and the system draws a random
   spot-check sample. Packed units then go through DTK at dispatch like
   factory output — DTK hands them over AND books the GRN, so the vendor
   is paid for what reaches dispatch (decisions §S428-DTK). The spot check
   holds nothing up: a failed unit is quarantined at once (DTK refuses
   it); at the hold threshold the consignment goes into full QC. Close QC
   is bookkeeping. Rejects are disposed any time: rework at LOT or
   return to the vendor.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Modal, Spinner, useToast } from '@throttle/ui';
import CameraScan from '@throttle/ui/CameraScan.js';
import { ALL_FORMATS } from '@throttle/ui/camera.mjs';
import { useRefreshState } from '../layout.js';
import { Panel, FilterChip, ToneBadge, btnGhost, btnPrimary, inputStyle } from '../../../components/kit/index.js';
import { opGet, opPost, fmtIST } from '../../../lib/outpost.js';
import {
  Confirm, ErrorPanel, Field, Input, OwnerGate, Select, dangerBtn, label, mono, smallBtn, text, useOutpostVendors,
} from '../../../components/outpost/OutpostKit.js';

const STATUSES = [['incoming', 'Incoming'], ['accepted', 'QC closed'], ['', 'All']];
const TONE = { dispatched: 'mute', receiving: 'warn', audit: 'warn', hold: 'bad', accepted: 'ok' };
const WORD = { dispatched: 'on the road', receiving: 'checking in', audit: 'spot check', hold: 'full QC', accepted: 'QC closed' };
const DISPO = { rework_lot: 'Rework at LOT', return_vendor: 'Return to vendor' };
const PHASE = { audit: 'sample', full_qc: 'full QC', late: 'late find' };
const RESOLVED = { late_received: 'found late', released: 'released' };
const num = v => Number(v || 0).toLocaleString('en-IN');
const td = { padding: 8 };
const th = { ...label, textAlign: 'left', padding: '6px 8px' };
const scanInput = { ...mono, fontSize: 20, padding: '14px 14px', letterSpacing: '0.04em' };

export default function OutpostReceivingPage() {
  return <OwnerGate><ReceivingInner /></OwnerGate>;
}

function ReceivingInner() {
  const { session, userId } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const V = useOutpostVendors(session, userId);
  const [status, setStatus] = useState('incoming');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [csg, setCsg] = useState(null);

  const load = async () => {
    if (!V.vendorId) return;
    setRefreshing(true);
    try { setRows(await opGet('getConsignments', { vendor_id: V.vendorId, status }, session)); setErr(null); }
    catch (e) { setErr(e.message); } finally { setRefreshing(false); setLastRefreshed(new Date()); }
  };
  useEffect(() => { setRows(null); load(); /* eslint-disable-next-line */ }, [V.vendorId, status]);

  if (V.loading) return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (V.error) return <ErrorPanel error={V.error} onRetry={V.reload} />;
  if (!V.vendors.length) return <Panel pad={24}><div style={text}>No vendor is set up in Outpost yet — add one under Outpost › Vendors &amp; Devices.</div></Panel>;
  if (csg) return <Receipt csgNo={csg} onBack={() => { setCsg(null); load(); }} />;

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ width: 260, maxWidth: '100%' }}>
          <Select value={V.vendorId || ''} onChange={e => V.setVendorId(Number(e.target.value))}>
            {V.vendors.map(v => <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name || `Vendor ${v.vendor_id}`}</option>)}
          </Select>
        </div>
        {STATUSES.map(([k, n]) => <FilterChip key={k || 'all'} active={status === k} onClick={() => setStatus(k)}>{n}</FilterChip>)}
      </div>

      {err ? <ErrorPanel error={err} onRetry={load} /> : !rows ? <Spinner /> : (
        <Panel pad={8}>
          {!rows.length ? <div style={{ ...text, padding: 24, textAlign: 'center' }}>No {status || ''} consignments.</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
                <thead><tr>{['Consignment', 'Challan', 'Vehicle', 'Cartons', 'Units', 'Dispatched', 'Status', 'Outcome'].map(h =>
                  <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>{rows.map(c => (
                  <tr key={c.csg_no} onClick={() => setCsg(c.csg_no)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                    <td style={{ ...mono, ...td, color: 'var(--t1)', fontWeight: 600 }}>{c.csg_no}</td>
                    <td style={{ ...text, ...td }}>{c.challan_no || '—'}{c.challan_date && <span style={{ color: 'var(--t3)' }}> · {c.challan_date}</span>}</td>
                    <td style={{ ...mono, ...td }}>{c.vehicle_no || '—'}</td>
                    <td className="num" style={td}>{num(c.carton_count)}</td>
                    <td className="num" style={td}>{num(c.unit_count)}</td>
                    <td style={{ ...text, ...td }}>{fmtIST(c.dispatched_at)}</td>
                    <td style={td}><ToneBadge tone={TONE[c.status]}>{WORD[c.status] || c.status}</ToneBadge></td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {['audit', 'hold', 'accepted'].includes(c.status) && <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)', marginRight: 8 }}>
                        {num(c.dtk_units)} / {num(c.received_units)} through DTK{Number(c.short_units) > 0 ? ` · ${num(c.short_units)} short` : ''}</span>}
                      {Number(c.undisposed) > 0 && <ToneBadge tone="warn">{c.undisposed} reject{c.undisposed > 1 ? 's' : ''} to dispose</ToneBadge>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

// One consignment: the header, then the step its status is on, then what went wrong so far.
function Receipt({ csgNo, onBack }) {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);

  const load = async () => {
    setRefreshing(true);
    try { setD(await opGet('getReceipt', { csg_no: csgNo }, session)); setErr(null); }
    catch (e) { setErr(e.message); } finally { setRefreshing(false); setLastRefreshed(new Date()); }
  };
  useEffect(() => { setD(null); load(); /* eslint-disable-next-line */ }, [csgNo]);

  const st = d?.consignment?.status;
  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      <button style={{ ...smallBtn, marginBottom: 14 }} onClick={onBack}>← All consignments</button>
      {err && !d ? <ErrorPanel error={err} onRetry={load} /> : !d ? <Spinner /> : <>
        <Header c={d.consignment} />
        <div style={{ marginTop: 14 }}>
          {st === 'dispatched' && <StartStep csgNo={csgNo} reload={load} />}
          {st === 'receiving' && <ReceiveStep d={d} setD={setD} csgNo={csgNo} reload={load} />}
          {st === 'audit' && <AuditStep d={d} csgNo={csgNo} reload={load} />}
          {st === 'hold' && <HoldStep d={d} csgNo={csgNo} reload={load} />}
          {st === 'accepted' && <AcceptedStep d={d} reload={load} />}
        </div>
        {['audit', 'hold', 'accepted'].includes(st) && <DtkPanel d={d} />}
        {['audit', 'hold'].includes(st) && !!(d.rejections || []).length && <Rejects d={d} reload={load} />}
        {['audit', 'hold', 'accepted'].includes(st) && <ShortUnits d={d} csgNo={csgNo} reload={load} />}
        {d.receipt && <Discrepancies list={d.discrepancies || []} />}
      </>}
    </div>
  );
}

function Fact({ k, children }) {
  return <div><div style={label}>{k}</div><div style={{ ...text, color: 'var(--t1)' }}>{children ?? '—'}</div></div>;
}

function Header({ c }) {
  return (
    <Panel title={c.csg_no} action={<ToneBadge tone={TONE[c.status]}>{WORD[c.status] || c.status}</ToneBadge>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 14 }}>
        <Fact k="Vendor">{c.vendor_name || `Vendor ${c.vendor_id}`}</Fact>
        <Fact k="Challan">{c.challan_no || '—'}{c.challan_date && <span style={{ color: 'var(--t3)' }}> · {c.challan_date}</span>}</Fact>
        <Fact k="Vehicle"><span style={mono}>{c.vehicle_no || '—'}</span></Fact>
        <Fact k="Transporter">{c.transporter || '—'}</Fact>
        <Fact k="E-way bill"><span style={mono}>{c.eway_bill_no || '—'}</span></Fact>
        <Fact k="Cartons / units"><span className="num">{num(c.carton_count)} / {num(c.unit_count)}</span></Fact>
        <Fact k="Dispatched">{fmtIST(c.dispatched_at)}</Fact>
      </div>
      {!!c.lines?.length && (
        <div style={{ overflowX: 'auto', marginTop: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
            <thead><tr>{['Car code', 'Channel', 'Cartons', 'Units'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{c.lines.map(l => (
              <tr key={`${l.sku}|${l.channel}`} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...mono, ...td }}>{l.sku}</td>
                <td style={{ ...text, ...td }}>{l.channel}</td>
                <td className="num" style={td}>{num(l.cartons)}</td>
                <td className="num" style={td}>{num(l.units)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function StartStep({ csgNo, reload }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Panel pad={18}>
      <div style={{ ...text, marginBottom: 12 }}>This consignment is on the road. When the vehicle is at the gate, start the check-in and scan every carton label.</div>
      <button style={btnPrimary} disabled={busy} onClick={async () => {
        if (busy) return;
        setBusy(true);
        try { await opPost('startReceipt', { csg_no: csgNo }, session); showToast(`${csgNo} — check-in started`, 'success'); await reload(); }
        catch (e) { showToast(e.message, 'error'); } finally { setBusy(false); }
      }}>{busy ? 'Starting…' : 'Start check-in'}</button>
    </Panel>
  );
}

// A scan field for a USB scanner (keystrokes ending in Enter). Clears on every scan; the caller refocuses it.
function ScanBox({ inputRef, onScan, placeholder, disabled }) {
  const [v, setV] = useState('');
  return (
    // A native input: the kit's Input is not a forwardRef, and the scan field must be refocused by ref.
    <input ref={inputRef} autoFocus value={v} disabled={disabled} placeholder={placeholder} autoComplete="off" autoCapitalize="characters"
      spellCheck={false} style={{ ...inputStyle, ...scanInput }} onChange={e => setV(e.target.value)}
      onKeyDown={e => { if (e.key !== 'Enter') return; e.preventDefault(); const code = v.trim().toUpperCase(); setV(''); if (code) onScan(code); }} />
  );
}

// Gate check-in input: the phone camera or a USB scanner. Default camera on a touch screen; the choice is remembered.
const INPUT_KEY = 'depot.receiving.input';
// The camera passes every code in view: take a carton label, a unit sticker or a batch label (what receive_scan
// understands — the same shapes as Outpost's scan.mjs); the box's EAN and anything else in the frame stay unread.
const CODE_RE = /^(CTN-\d{7}|LOT-\d{8}(-[ERX])?)$/;
const pickCode = vals => vals.map(v => String(v).trim().toUpperCase()).find(v => CODE_RE.test(v));

const ALERT_TONE = { extra: 'warn', wrong_vendor: 'bad', already: 'mute', wrong_carton: 'warn', refused: 'bad' };
const ALERT_WORD = { extra: 'extra', wrong_vendor: 'wrong vendor', already: 'already', wrong_carton: 'wrong carton', refused: 'refused' };

function ReceiveStep({ d, setD, csgNo, reload }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const inp = useRef(null);
  const cur = useRef(null);          // the carton being opened — read inside the scan queue, so a ref
  const queue = useRef(Promise.resolve());
  const [ctn, setCtn] = useState(null);
  const [pending, setPending] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [ask, setAsk] = useState(null);
  const [input, setInput] = useState(null);      // 'camera' | 'scanner' — read after mount (static export: no window in render)
  const camOn = useRef(false);
  camOn.current = input === 'camera';

  useEffect(() => {
    let v = null;
    try { v = localStorage.getItem(INPUT_KEY); } catch { /* none */ }
    if (v !== 'camera' && v !== 'scanner') v = window.matchMedia?.('(pointer: coarse)').matches ? 'camera' : 'scanner';
    setInput(v);
  }, []);
  const flipInput = () => {
    const v = input === 'camera' ? 'scanner' : 'camera';
    setInput(v);
    try { localStorage.setItem(INPUT_KEY, v); } catch { /* none */ }
  };

  const expected = Number(d.receipt?.expected_units ?? d.consignment.unit_count);
  const received = useMemo(() => d.cartons.reduce((a, c) => a + c.units.filter(u => u.scanned).length, 0), [d.cartons]);
  const alert = (kind, msg) => setAlerts(a => [{ id: Date.now() + Math.random(), kind, msg, at: new Date() }, ...a].slice(0, 60));

  const scanOne = async code => {
    try {
      const r = await opPost('receiveScan', { csg_no: csgNo, ctn_no: cur.current, code }, session);
      if (r.kind === 'carton') {
        cur.current = r.ctn_no; setCtn(r);
        if (Number(r.checked_in) > 0) showToast(`${r.ctn_no} checked in — ${r.checked_in} unit${r.checked_in > 1 ? 's' : ''}`, 'success');
        else alert('already', `${r.ctn_no} was already checked in`);
        await reload(); return;
      }
      if (r.result === 'ok' || r.result === 'already') {
        // Tick it locally on its home carton; the full receipt is re-read on the next carton scan only.
        if (r.result === 'ok') setD(p => ({ ...p, cartons: p.cartons.map(c => c.ctn_no !== r.ctn_no ? c
          : { ...c, units: c.units.map(u => u.car_upc === r.car_upc ? { ...u, scanned: true, scanned_ctn: cur.current } : u) }) }));
        if (r.result === 'already') alert('already', `${r.car_upc} was already scanned`);
        if (r.wrong_carton) alert('wrong_carton', `${r.car_upc} belongs in ${r.ctn_no}, found in ${cur.current}`);
      } else if (r.result === 'extra') alert('extra', `${r.car_upc} is this vendor's unit but NOT on ${csgNo} — set it aside`);
      else if (r.result === 'wrong_vendor') alert('wrong_vendor', `${r.car_upc} is NOT this vendor's unit — set it aside`);
    } catch (e) { alert('refused', `${code}: ${e.message}`); showToast(e.message, 'error'); }
  };
  // Scans run one at a time in arrival order (a scanner can fire faster than the round trip) — none dropped, none doubled.
  const onScan = code => {
    setPending(p => p + 1);
    queue.current = queue.current.then(() => scanOne(code)).finally(() => { setPending(p => p - 1); if (!camOn.current) inp.current?.focus(); });
  };

  const open = ctn && d.cartons.find(c => c.ctn_no === ctn.ctn_no);
  const units = open ? open.units : ctn?.units || [];
  const finish = () => setAsk({
    title: `Finish the check-in of ${csgNo}?`, yes: 'Finish check-in',
    body: <>Expected <strong className="num">{num(expected)}</strong>, checked in <strong className="num">{num(received)}</strong>.{' '}
      {expected > received && <><strong className="num">{num(expected - received)}</strong> unit{expected - received > 1 ? 's' : ''} not checked in will be recorded SHORT (a short unit that turns up later is received at DTK). </>}
      Cartons not checked in whole can't be moved as a whole carton later. The spot-check sample is drawn next; the units can go to DTK straight away.</>,
    onYes: async () => {
      const r = await opPost('finishReceipt', { csg_no: csgNo }, session);
      showToast(`${csgNo} checked in — ${r.received} in, ${r.short} short; spot check ${r.sample} unit(s)`, 'success', 6000);
      await reload();
    },
  });

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Panel pad={16}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          <div className="num" style={{ fontSize: 28, fontWeight: 700, color: 'var(--t1)' }}>{num(received)} <span style={{ color: 'var(--t3)', fontSize: 18 }}>/ {num(expected)}</span></div>
          <div style={text}>units checked in{pending > 0 && <> · <span className="num">{pending}</span> scan{pending > 1 ? 's' : ''} in flight</>}</div>
          <div style={{ flex: 1 }} />
          <button style={btnPrimary} disabled={pending > 0 || !!ask} onClick={finish}>Finish check-in</button>
        </div>
        <div style={{ ...text, marginBottom: 10 }}>Scan each carton label: that checks in every unit in the sealed carton. Open a carton and scan its boxes only when it looks wrong.</div>
        {input && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button type="button" style={btnGhost} onClick={flipInput}>{input === 'camera' ? 'Use scanner' : 'Use camera'}</button>
          </div>
        )}
        {input === 'camera' && (
          <div style={{ marginBottom: 10 }}>
            <CameraScan formats={ALL_FORMATS} onCodes={vals => { const c = pickCode(vals); if (c) { onScan(c); return true; } return false; }} />
          </div>
        )}
        <ScanBox inputRef={inp} onScan={onScan} placeholder={ctn ? `Scan the next carton label, or a box in ${ctn.ctn_no}` : 'Scan a carton label (CTN-…)'} />
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <Panel title={ctn ? `${ctn.ctn_no} · ${ctn.sku} · ${ctn.channel}` : 'Current carton'} pad={10}>
          {!ctn ? <div style={{ ...text, padding: 8 }}>Scan a carton label to check it in and see its manifest.</div> : (
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {units.map(u => (
                <div key={u.car_upc} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 6px', borderTop: '1px solid var(--border)' }}>
                  <span style={{ width: 18, color: u.scanned ? 'var(--ok-fg)' : 'var(--t3)', fontWeight: 700 }}>{u.scanned ? '✓' : '·'}</span>
                  <span style={{ ...mono, color: 'var(--t1)' }}>{u.car_upc}</span>
                  <span style={{ ...mono, color: 'var(--t3)', fontSize: 11.5 }}>{u.batch_label}</span>
                  {u.scanned && u.scanned_ctn && u.scanned_ctn !== ctn.ctn_no && <ToneBadge tone="warn">found in {u.scanned_ctn}</ToneBadge>}
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Alerts this session" pad={10}>
          {!alerts.length ? <div style={{ ...text, padding: 8 }}>Nothing out of place yet.</div> : (
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {alerts.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 6px', borderTop: '1px solid var(--border)' }}>
                  <ToneBadge tone={ALERT_TONE[a.kind]}>{ALERT_WORD[a.kind]}</ToneBadge>
                  <span style={{ ...text, fontSize: 12.5, color: a.kind === 'already' ? 'var(--t3)' : 'var(--t1)', flex: 1 }}>{a.msg}</span>
                  <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{a.at.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Cartons" pad={10}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
          {d.cartons.map(c => {
            const s = c.units.filter(u => u.scanned).length;
            const full = s >= c.unit_count;
            return (
              <div key={c.ctn_no} style={{ border: `1px solid ${c.ctn_no === ctn?.ctn_no ? 'var(--yellow)' : full ? 'var(--ok-bd)' : 'var(--border)'}`,
                borderRadius: 'var(--r-sm)', padding: '7px 9px', background: full ? 'var(--ok-bg)' : 'var(--surface-2)' }}>
                <div style={{ ...mono, color: 'var(--t1)' }}>{c.ctn_no}</div>
                <div className="num" style={{ fontSize: 12, color: full ? 'var(--ok-fg)' : 'var(--t2)' }}>{s} / {c.unit_count}</div>
              </div>
            );
          })}
        </div>
      </Panel>
      <Confirm ask={ask} onClose={() => { setAsk(null); setTimeout(() => inp.current?.focus(), 0); }} />
    </div>
  );
}

// A reject reason — required, 3–300 characters (the SQL refuses under 3 and keeps 300).
function ReasonModal({ title, onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const r = reason.trim();
  return (
    <Modal open onClose={busy ? undefined : onClose} title={title} confirmLabel="Reject unit" confirmColor="var(--bad-fg)" loading={busy} error={err}
      dismissOnBackdrop={false} confirmDisabled={r.length < 3 || r.length > 300} onConfirm={async () => {
        if (busy) return;
        setBusy(true); setErr(null);
        try { await onSubmit(r); onClose(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      <Field name="What is wrong?" hint="3–300 characters. The vendor sees this."><Input autoFocus value={reason} maxLength={300}
        onChange={e => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

// Every way a scanned label names a car: the car UPC, its remote UPC, or a batch label (LOT-NNNNNNNN-E|R|X).
function carIndex(cartons) {
  const m = new Map();
  for (const c of cartons) for (const u of c.units) for (const k of [u.car_upc, u.remote_upc, u.batch_label]) if (k) m.set(k, u.car_upc);
  return code => m.get(code) || m.get(code.slice(0, 12)) || null;
}

function AuditStep({ d, csgNo, reload }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const inp = useRef(null);
  const [hl, setHl] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [failFor, setFailFor] = useState(null);
  const [ask, setAsk] = useState(null);
  const find = useMemo(() => carIndex(d.cartons), [d.cartons]);
  const reasons = useMemo(() => new Map((d.rejections || []).map(x => [x.car_upc, x.reason])), [d.rejections]);

  const samples = d.samples || [];
  const size = Number(d.receipt.sample_size ?? samples.length);
  const holdAt = Number(d.receipt.hold_at);
  const checked = samples.filter(s => s.result).length;
  const fails = samples.filter(s => s.result === 'fail').length;
  const canAccept = samples.length > 0 && checked === samples.length && fails < holdAt;

  const mark = async (s, result, reason) => {
    const r = await opPost('auditMark', { csg_no: csgNo, code: s.car_upc, result, ...(reason ? { reason } : {}) }, session);
    if (result === 'fail' && r.already_handed_over) showToast(`${s.car_upc} counted as a sample fail — it was already through DTK, so pull it out through the in-house QC flow`, 'warning', 8000);
    if (r.status === 'hold') showToast(`${csgNo} is ON HOLD — ${r.sample_fails} of ${r.sample_size} sample units failed. Inspect every unit.`, 'warning', 8000);
    await reload();
  };
  const pass = async s => {
    if (busyKey) return;
    setBusyKey(s.car_upc);
    try { await mark(s, 'pass'); } catch (e) { showToast(e.message, 'error'); } finally { setBusyKey(null); inp.current?.focus(); }
  };
  const onScan = code => {
    const car = find(code);
    const s = car && samples.find(x => x.car_upc === car);
    if (!s) { showToast(`${code} is not in the audit sample — check the sample list`, 'error'); return; }
    setHl(s.car_upc);
    document.getElementById(`smp-${s.car_upc}`)?.scrollIntoView({ block: 'nearest' });
  };
  const accept = () => setAsk({
    title: `Close QC on ${csgNo}?`, yes: 'Close QC',
    body: <>Closes the spot check. Nothing moves and no GRN is written here — DTK hands the units over and books the GRN.
      {fails > 0 && <> <strong className="num">{fails}</strong> failed sample unit{fails > 1 ? 's stay' : ' stays'} quarantined until disposed of.</>}</>,
    onYes: async () => {
      const r = await opPost('acceptConsignment', { csg_no: csgNo }, session);
      showToast(`${csgNo} QC closed — ${r.dtk} through DTK so far, ${r.rejected} rejected`, 'success', 8000);
      await reload();
    },
  });

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Panel pad={16}>
        <div style={{ ...text, marginBottom: 10 }}>Spot check — nothing waits on it: the units can go to DTK now. Open these <strong className="num">{size}</strong> units
          (picked at random by the system) before they reach DTK and check each one; a failed unit is quarantined at once and DTK refuses it.
          At <strong className="num">{holdAt}</strong> failure{holdAt > 1 ? 's' : ''} the consignment goes into full QC.</div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <div style={text}>Checked <strong className="num" style={{ color: 'var(--t1)' }}>{checked} / {samples.length}</strong></div>
          <div style={text}>Fails <strong className="num" style={{ color: fails ? 'var(--bad-fg)' : 'var(--t1)' }}>{fails} / {holdAt}</strong></div>
          <div style={{ flex: 1 }} />
          <button style={{ ...btnPrimary, opacity: canAccept ? 1 : 0.5 }} disabled={!canAccept || !!ask} onClick={accept}>Close QC</button>
        </div>
        <ScanBox inputRef={inp} onScan={onScan} placeholder="Scan a sample unit's label to find it in the list" />
      </Panel>
      <Panel pad={8}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead><tr>{['Carton', 'Batch label', 'Car UPC', 'Result', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{samples.map(s => (
              <tr key={s.car_upc} id={`smp-${s.car_upc}`} style={{ borderTop: '1px solid var(--border)', background: hl === s.car_upc ? 'var(--surface-3)' : undefined,
                outline: hl === s.car_upc ? '2px solid var(--yellow)' : undefined }}>
                <td style={{ ...mono, ...td }}>{s.ctn_no}</td>
                <td style={{ ...mono, ...td }}>{s.batch_label || '—'}</td>
                <td style={{ ...mono, ...td, color: 'var(--t1)' }}>{s.car_upc}</td>
                <td style={td}>{!s.result ? <span style={{ ...text, color: 'var(--t3)' }}>to check</span>
                  : <><ToneBadge tone={s.result === 'pass' ? 'ok' : 'bad'}>{s.result}</ToneBadge>
                    {s.result === 'fail' && reasons.get(s.car_upc) && <span style={{ ...text, fontSize: 12, marginLeft: 8 }}>{reasons.get(s.car_upc)}</span>}</>}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button style={{ ...smallBtn, marginRight: 6 }} disabled={!!busyKey || s.result === 'pass'} onClick={() => pass(s)}>
                    {busyKey === s.car_upc ? '…' : 'Pass'}</button>
                  <button style={dangerBtn} disabled={!!busyKey || s.result === 'fail'} onClick={() => setFailFor(s)}>Fail</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>
      {failFor && <ReasonModal title={`Fail ${failFor.car_upc}`} onClose={() => { setFailFor(null); setTimeout(() => inp.current?.focus(), 0); }}
        onSubmit={async reason => {
          setBusyKey(failFor.car_upc);
          try { await mark(failFor, 'fail', reason); } finally { setBusyKey(null); }
        }} />}
      <Confirm ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function HoldStep({ d, csgNo, reload }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const inp = useRef(null);
  const [failCode, setFailCode] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [qc, setQc] = useState(false);

  const samples = d.samples || [];
  const sFails = samples.filter(s => s.result === 'fail').length;
  const rej = d.rejections || [];
  const received = Number(d.receipt.received_units);
  const refocus = () => setTimeout(() => inp.current?.focus(), 0);

  const undo = async x => {
    if (busyKey) return;
    setBusyKey(x.car_upc);
    try { await opPost('auditMark', { csg_no: csgNo, code: x.car_upc, result: 'pass' }, session); showToast(`${x.car_upc} no longer rejected`, 'success'); await reload(); }
    catch (e) { showToast(e.message, 'error'); } finally { setBusyKey(null); refocus(); }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Panel pad={16} style={{ borderColor: 'var(--bad-fg)' }}>
        <div style={{ ...text, color: 'var(--bad-fg)', fontWeight: 600, marginBottom: 6 }}>
          Full QC — the spot check failed (<span className="num">{sFails}</span> of <span className="num">{samples.length}</span> sampled failed, full QC at <span className="num">{d.receipt.hold_at}</span>).</div>
        <div style={{ ...text, marginBottom: 12 }}>Inspect every received unit not yet through DTK (<span className="num">{num(received)}</span> received). Scan or type only the rejects — each is quarantined at once. DTK is not blocked; a unit already handed over is pulled out through the in-house QC flow instead.</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: '1 1 280px' }}><ScanBox inputRef={inp} disabled={!!failCode} onScan={setFailCode} placeholder="Scan a rejected unit's label" /></div>
          <button style={btnPrimary} disabled={qc || !!busyKey} onClick={() => setQc(true)}>Finish full QC and close</button>
        </div>
      </Panel>
      {!rej.length && <Panel pad={12}><div style={text}>No rejects yet.</div></Panel>}
      {!!rej.length && <div style={{ ...text, fontSize: 12.5 }}>Undo a reject that is not yet disposed of from the list below.</div>}
      <UndoList rej={rej} busyKey={busyKey} undo={undo} />
      {failCode && <ReasonModal title={`Reject ${failCode}`} onClose={() => { setFailCode(null); refocus(); }}
        onSubmit={async reason => {
          await opPost('auditMark', { csg_no: csgNo, code: failCode, result: 'fail', reason }, session);
          showToast(`${failCode} rejected`, 'success');
          await reload();
        }} />}
      {qc && <FullQcModal csgNo={csgNo} rejected={rej.length} onClose={() => { setQc(false); refocus(); }} reload={reload} />}
    </div>
  );
}

// Closing a consignment in full QC needs the person to say every unit was inspected (the SQL refuses without it).
function FullQcModal({ csgNo, rejected, onClose, reload }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <Modal open onClose={busy ? undefined : onClose} title={`Close QC on ${csgNo}?`} confirmLabel={busy ? 'Working…' : 'Close QC'}
      loading={busy} error={err} dismissOnBackdrop={false} confirmDisabled={!done} onConfirm={async () => {
        if (busy || !done) return;
        setBusy(true); setErr(null);
        try {
          const r = await opPost('acceptConsignment', { csg_no: csgNo, full_qc_done: true }, session);
          showToast(`${csgNo} QC closed — ${r.dtk} through DTK so far, ${r.rejected} rejected`, 'success', 8000);
          onClose(); await reload();
        } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      <div style={{ ...text, marginBottom: 14 }}>Nothing moves and no GRN is written here — DTK hands the units over and books the GRN.{' '}
        <strong className="num">{num(rejected)}</strong> unit{rejected === 1 ? ' is' : 's are'} rejected and stay{rejected === 1 ? 's' : ''} quarantined until disposed of.</div>
      <label style={{ ...text, display: 'flex', gap: 10, alignItems: 'center', color: 'var(--t1)', cursor: 'pointer' }}>
        <input type="checkbox" checked={done} onChange={e => setDone(e.target.checked)} style={{ width: 18, height: 18 }} />
        Every received unit has been inspected
      </label>
    </Modal>
  );
}

function AcceptedStep({ d, reload }) {
  const r = d.receipt || {};
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Panel pad={16}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 14 }}>
          <Fact k="Checked in"><span className="num">{num(r.received_units)}</span></Fact>
          <Fact k="Short"><span className="num" style={{ color: Number(r.short_units) ? 'var(--warn-fg)' : undefined }}>{num(r.short_units)}</span></Fact>
          <Fact k="Rejected"><span className="num" style={{ color: Number(r.rejected_units) ? 'var(--bad-fg)' : undefined }}>{num(r.rejected_units)}</span></Fact>
          <Fact k="QC closed">{fmtIST(r.decided_at)}</Fact>
        </div>
      </Panel>
      <LateReject d={d} reload={reload} />
      <Rejects d={d} reload={reload} />
    </div>
  );
}

// After Close QC a unit found faulty BEFORE it reaches DTK is still quarantined here (DTK would hand it over and pay for it).
function LateReject({ d, reload }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const inp = useRef(null);
  const [code, setCode] = useState(null);
  const csgNo = d.consignment.csg_no;
  return (
    <Panel title="Reject a faulty unit" pad={14}>
      <div style={{ ...text, marginBottom: 10 }}>A unit of this consignment found faulty before DTK: scan it to quarantine it (DTK will refuse it). A unit already through DTK goes through the in-house QC flow.</div>
      <ScanBox inputRef={inp} disabled={!!code} onScan={setCode} placeholder="Scan the faulty unit's label" />
      {code && <ReasonModal title={`Reject ${code}`} onClose={() => { setCode(null); setTimeout(() => inp.current?.focus(), 0); }}
        onSubmit={async reason => {
          await opPost('auditMark', { csg_no: csgNo, code, result: 'fail', reason }, session);
          showToast(`${code} quarantined`, 'success');
          await reload();
        }} />}
    </Panel>
  );
}

// What DTK has handed over and paid on this consignment (the GRN is written at DTK, one per IST day).
function DtkPanel({ d }) {
  const k = d.dtk || {};
  const rcv = Number(d.receipt?.received_units || 0);
  return (
    <Panel title="Through DTK (paid)" pad={14} style={{ marginTop: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
        <Fact k="Handed over"><span className="num" style={{ color: 'var(--ok-fg)' }}>{num(k.units)}</span><span className="num" style={{ color: 'var(--t3)' }}> / {num(rcv)}</span></Fact>
        <Fact k="Payable">{k.payable != null ? <span className="num">₹{Number(k.payable).toLocaleString('en-IN')}</span> : '—'}
          {Number(k.unpriced) > 0 && <span style={{ color: 'var(--warn-fg)' }}> · {k.unpriced} unpriced</span>}</Fact>
        <Fact k="GRNs">{(k.grns || []).length ? k.grns.map(g => <div key={g.grn_no}><span style={mono}>{g.grn_no}</span>
          <span style={{ color: 'var(--t3)' }}> · {g.grn_date} · {num(g.units)}</span></div>) : '—'}</Fact>
        {Number(k.no_po) > 0 && <Fact k="No open PO line"><span className="num" style={{ color: 'var(--warn-fg)' }}>{num(k.no_po)}</span>
          <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>booked on the GRN with no PO — raise or extend the PO</div></Fact>}
      </div>
      <div style={{ ...text, fontSize: 12.5, marginTop: 10 }}>Scan the carton label (or a unit's batch label) at the Scanner's DTK station. The PO line is the vendor's oldest live line for the colour that still has open qty.</div>
    </Panel>
  );
}

function UndoList({ rej, busyKey, undo }) {
  const open = rej.filter(x => !x.disposition);
  if (!open.length) return null;
  return (
    <Panel title={`Undo a reject (${open.length})`} pad={8}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 4 }}>
        {open.map(x => (
          <button key={x.id} style={smallBtn} disabled={!!busyKey} onClick={() => undo(x)}>
            {busyKey === x.car_upc ? '…' : <>Undo <span style={mono}>{x.car_upc}</span></>}</button>
        ))}
      </div>
    </Panel>
  );
}

// Rejections and their disposition — any time after the reject (QC no longer waits for an accept).
function Rejects({ d, reload }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [sel, setSel] = useState(() => new Set());
  const [ask, setAsk] = useState(null);
  const rej = d.rejections || [];
  const open = rej.filter(x => !x.disposition);
  const toggle = id => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const all = open.length > 0 && open.every(x => sel.has(x.id));

  const dispose = disposition => {
    const ids = open.filter(x => sel.has(x.id)).map(x => x.id);
    if (!ids.length) return;
    setAsk({
      title: `${DISPO[disposition]} — ${ids.length} unit${ids.length > 1 ? 's' : ''}?`, yes: DISPO[disposition],
      body: disposition === 'rework_lot'
        ? <>The car and remote go to the LOT workshop as a QC fail and come back through the normal line.</>
        : <>The car and remote go back to the vendor as unpacked units; they fix them and re-pack them with the same stickers.</>,
      onYes: async () => {
        const out = await opPost('setDisposition', { ids, disposition }, session);
        showToast(`${out.count} unit${out.count === 1 ? '' : 's'} → ${DISPO[out.disposition] || out.disposition}`, 'success');
        setSel(new Set()); await reload();
      },
    });
  };

  return (
    <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
      <Panel title={`Rejections (${rej.length})`} pad={8} action={!!open.length && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button style={smallBtn} disabled={!sel.size || !!ask} onClick={() => dispose('rework_lot')}>Rework at LOT</button>
          <button style={smallBtn} disabled={!sel.size || !!ask} onClick={() => dispose('return_vendor')}>Return to vendor</button>
        </div>
      )}>
        {!rej.length ? <div style={{ ...text, padding: 12 }}>Nothing was rejected.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead><tr>
                <th style={{ ...th, width: 30 }}>{!!open.length && <input type="checkbox" checked={all} aria-label="Select all"
                  onChange={() => setSel(all ? new Set() : new Set(open.map(x => x.id)))} />}</th>
                {['Carton', 'Car UPC', 'Remote', 'Phase', 'Reason', 'Disposition'].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>{rej.map(x => (
                <tr key={x.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{!x.disposition && <input type="checkbox" checked={sel.has(x.id)} onChange={() => toggle(x.id)} aria-label={`Select ${x.car_upc}`} />}</td>
                  <td style={{ ...mono, ...td }}>{x.ctn_no}</td>
                  <td style={{ ...mono, ...td, color: 'var(--t1)' }}>{x.car_upc}</td>
                  <td style={{ ...mono, ...td }}>{x.remote_upc || '—'}</td>
                  <td style={td}><ToneBadge tone={x.phase === 'audit' ? 'warn' : 'mute'}>{PHASE[x.phase] || x.phase}</ToneBadge></td>
                  <td style={{ ...text, ...td }}>{x.reason}</td>
                  <td style={td}>{x.disposition
                    ? <span style={text}><ToneBadge tone="ok">{DISPO[x.disposition] || x.disposition}</ToneBadge> <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>{fmtIST(x.disposed_at)}</span></span>
                    : <ToneBadge tone="warn">to dispose</ToneBadge>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>
      <Confirm ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

const DISC = [['short', 'Short — not received, not credited', 'warn'], ['extra', 'Extra — this vendor, not on the consignment', 'warn'],
  ['wrong_vendor', 'Wrong vendor', 'bad'], ['wrong_carton', 'Found in the wrong carton', 'mute']];

function Discrepancies({ list }) {
  return (
    <Panel title={`Discrepancies (${list.length})`} pad={12} style={{ marginTop: 14 }}>
      {!list.length ? <div style={text}>None recorded.</div> : DISC.map(([k, name, tone]) => {
        const xs = list.filter(x => x.kind === k);
        if (!xs.length) return null;
        return (
          <div key={k} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <ToneBadge tone={tone}>{xs.length}</ToneBadge><span style={{ ...text, color: 'var(--t1)' }}>{name}</span></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {xs.map(x => (
                <span key={`${x.upc}|${x.ctn_no}`} title={[x.detail, fmtIST(x.at)].filter(Boolean).join(' · ')}
                  style={{ ...mono, fontSize: 11.5, padding: '2px 7px', borderRadius: 3, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                  {x.upc}{x.ctn_no && <span style={{ color: 'var(--t3)' }}> · {x.ctn_no}</span>}
                  {x.resolution && <span style={{ color: 'var(--ok-fg)' }}> · {RESOLVED[x.resolution] || x.resolution}</span>}</span>
              ))}
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

/* Short units (O10): a manifest unit not found at Finish stays "in transit" and is never credited until it is resolved.
   Found late → received here (or simply scanned at DTK, which receives and pays it there); a failed one is quarantined
   as a reject. Released → it is lost or never left the vendor: the package is undone and the vendor can re-pack the
   same stickers. (O12 S428: no GRN here any more — DTK books it.) */
function ShortUnits({ d, csgNo, reload }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [sel, setSel] = useState(() => new Set());
  const [modal, setModal] = useState(null);
  const st = d.consignment.status;
  const shorts = (d.discrepancies || []).filter(x => x.kind === 'short');
  if (!shorts.length) return null;
  const open = shorts.filter(x => !x.resolution);
  const picked = open.filter(x => sel.has(x.upc));
  const toggle = u => setSel(p => { const n = new Set(p); n.has(u) ? n.delete(u) : n.add(u); return n; });
  const done = async msg => { showToast(msg, 'success', 6000); setSel(new Set()); setModal(null); await reload(); };
  return (
    <Panel title={`Short units (${open.length} open of ${shorts.length})`} pad={12} style={{ marginTop: 14 }} action={!!open.length && (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button style={smallBtn} disabled={!picked.length || !!modal} onClick={() => setModal('receive')}>Found — receive</button>
        <button style={smallBtn} disabled={!picked.length || !!modal} onClick={() => setModal('release')}>Release to vendor</button>
      </div>
    )}>
      <div style={{ ...text, marginBottom: 8 }}>On the manifest but not checked in — not credited. A unit found now: receive it here, or just scan it at DTK
        (it is received and paid there).{st === 'audit' ? ' Received here, it joins the spot-check sample.' : ''}
        {' '}"found on CSG-…" = it was scanned as extra on another consignment, so it is at LOT: receive it, don't release it.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {shorts.map(x => (
          <label key={x.upc} style={{ ...mono, fontSize: 12, padding: '3px 8px', borderRadius: 3, display: 'inline-flex', gap: 6, alignItems: 'center',
            background: 'var(--surface-2)', border: '1px solid var(--border)', cursor: x.resolution ? 'default' : 'pointer' }}>
            {!x.resolution && <input type="checkbox" checked={sel.has(x.upc)} onChange={() => toggle(x.upc)} aria-label={`Select ${x.upc}`} />}
            {x.upc}<span style={{ color: 'var(--t3)' }}>{x.ctn_no}</span>
            {!x.resolution && x.seen_on && <ToneBadge tone="warn">found on {x.seen_on}</ToneBadge>}
            {x.resolution && <ToneBadge tone={x.resolution === 'released' ? 'mute' : 'ok'}>{RESOLVED[x.resolution] || x.resolution}{x.resolution === 'late_received' && x.resolved_note ? ` · ${x.resolved_note}` : ''}</ToneBadge>}
          </label>
        ))}
      </div>
      {modal === 'receive' && <LateReceiveModal csgNo={csgNo} units={picked} onClose={() => setModal(null)}
        onSubmit={async fails => {
          const r = await opPost('resolveShort', { csg_no: csgNo, codes: picked.map(x => x.upc), how: 'receive', fails, expect_status: st }, session);
          await done(r.already ? `${r.count} already received`
            : `${r.count} found late — ${r.passed} received${r.failed ? `, ${r.failed} rejected` : ''}${r.added_to_sample ? ' (added to the spot check)' : ''}; DTK books the GRN`);
        }} />}
      {modal === 'release' && <ReleaseModal count={picked.length} onClose={() => setModal(null)}
        onSubmit={async reason => {
          const r = await opPost('resolveShort', { csg_no: csgNo, codes: picked.map(x => x.upc), how: 'release', reason, expect_status: st }, session);
          await done(r.already ? `${r.count} already released` : `${r.count} released — the vendor can re-pack the stickers`);
        }} />}
    </Panel>
  );
}

function LateReceiveModal({ csgNo, units, onClose, onSubmit }) {
  const [fails, setFails] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const bad = Object.values(fails).some(v => v.trim().length < 3 || v.trim().length > 300);
  const nFail = Object.keys(fails).length;
  return (
    <Modal open onClose={busy ? undefined : onClose} title={`Found ${units.length} short unit${units.length > 1 ? 's' : ''} on ${csgNo}`}
      confirmLabel={busy ? 'Working…' : nFail ? `Receive ${units.length - nFail} · reject ${nFail}` : `Receive ${units.length}`} loading={busy} error={err}
      dismissOnBackdrop={false} confirmDisabled={bad} onConfirm={async () => {
        if (busy) return;
        setBusy(true); setErr(null);
        try { await onSubmit(Object.fromEntries(Object.entries(fails).map(([k, v]) => [k, v.trim()]))); }
        catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      <div style={{ ...text, marginBottom: 10 }}>The units are received and go to DTK like the rest (DTK books the GRN). Tick any that are faulty: they are quarantined as rejects.</div>
      {units.map(x => (
        <div key={x.upc} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ ...mono, minWidth: 120 }}>{x.upc}</span>
          <label style={{ ...text, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={x.upc in fails} onChange={() => setFails(p => {
              const n = { ...p }; if (x.upc in n) delete n[x.upc]; else n[x.upc] = ''; return n; })} />fail</label>
          {x.upc in fails && <Input style={{ flex: 1, minWidth: 180 }} value={fails[x.upc]} maxLength={300} placeholder="What is wrong? (3+ characters)"
            onChange={e => setFails(p => ({ ...p, [x.upc]: e.target.value }))} />}
        </div>
      ))}
    </Modal>
  );
}

function ReleaseModal({ count, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const r = reason.trim();
  return (
    <Modal open onClose={busy ? undefined : onClose} title={`Release ${count} short unit${count > 1 ? 's' : ''}?`} confirmLabel={busy ? 'Working…' : 'Release'}
      confirmColor="var(--bad-fg)" loading={busy} error={err} dismissOnBackdrop={false} confirmDisabled={r.length < 3 || r.length > 300}
      onConfirm={async () => {
        if (busy) return;
        setBusy(true); setErr(null);
        try { await onSubmit(r); } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      <div style={{ ...text, marginBottom: 10 }}>The units are never credited. Their package is undone (car and remote back to the vendor as unpacked
        stickers), so if the vendor still has them they can re-pack them onto a new consignment.</div>
      <Field name="Why?" hint="3–300 characters, e.g. lost in transit, never loaded."><Input autoFocus value={reason} maxLength={300}
        onChange={e => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
