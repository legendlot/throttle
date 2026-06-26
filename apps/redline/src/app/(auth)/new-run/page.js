'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Combobox, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, lineColor, lineRgb, btnPrimary, btnGhost, inputStyle,
} from '../../../components/kit/index.js';
import { RecentRuns } from '../../../components/production-runs/RecentRuns.js';
import { CoveragePanel } from '../../../components/production-runs/CoveragePanel.js';

// Unified run-request surface (run-request consolidation, 2026-06-07).
// One place for production to request ANY run: Fresh · Outsourced · Repair · Repack.
// Gated by the `run_request` permission. Each tab routes to its existing worker
// create handler (backends stay separate — RULE consolidation framing #2).
// Pit Wall v2 reskin — logic, calls and payloads unchanged.

export function canRequestRun(perms) {
  return hasPermission(perms, 'run_request')
      || hasPermission(perms, 'users_manage'); // super_admin convenience
}

/* ── v2 style vocabulary (NewRunModal pattern from the prototype) ── */
const inp = { ...inputStyle, fontSize: 13.5 };
const numInp = { ...inp, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' };
const lblStyle = { display: 'block', marginBottom: 7 };
const th = { padding: '9px 12px', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', textAlign: 'left', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td = { padding: '7px 10px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)' };
const tabBtn = (active) => ({
  display: 'inline-flex', alignItems: 'center', gap: 7,
  background: active ? 'var(--yellow)' : 'var(--surface)',
  border: `1px solid ${active ? 'var(--yellow)' : 'var(--border-2)'}`,
  borderRadius: 'var(--r-sm)', padding: '8px 15px',
  fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase',
  color: active ? '#1a1a1a' : 'var(--t2)', cursor: 'pointer',
  transition: 'all var(--fast) var(--ease)',
});
const lineBtn = (active, id) => ({
  flex: 1, padding: '9px 0', borderRadius: 'var(--r-sm)', cursor: 'pointer',
  border: `1px solid ${active ? lineColor(id) : 'var(--border-2)'}`,
  background: active ? `rgba(${lineRgb(id)},0.12)` : 'var(--surface-2)',
  color: active ? lineColor(id) : 'var(--t2)',
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, letterSpacing: '0.05em',
  transition: 'all var(--fast) var(--ease)',
});
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 26, background: 'transparent', border: '1px solid var(--border-2)',
  borderRadius: 'var(--r-xs)', color: 'var(--t3)', cursor: 'pointer',
};
const helpText = { fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginBottom: 16, lineHeight: 1.5 };

function LinePicker({ value, onChange, lines }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {lines.map(l => (
        <button key={l} type="button" onClick={() => onChange(l)} style={lineBtn(value === l, l)}>{l}</button>
      ))}
    </div>
  );
}

const LINES_INHOUSE = ['L1', 'L2', 'L3', 'L4', 'L5'];
const LINES_REPAIR  = ['L1', 'L2', 'L3', 'L4', 'L5'];
const TABS = [
  { id: 'fresh',      label: 'Fresh',      icon: 'factory' },
  { id: 'outsourced', label: 'Outsourced', icon: 'truck' },
  { id: 'repair',     label: 'Repair',     icon: 'wrench' },
  { id: 'repack',     label: 'Repack',     icon: 'swap' },
];

export default function NewRunPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const allowed = canRequestRun(perms);

  const [tab, setTab]   = useState('fresh');
  const [cat, setCat]   = useState(null);     // getProductCatalogue
  const [vendors, setVendors] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    setRefreshing(true);
    Promise.allSettled([
      garageFetch('getProductCatalogue', {}, session).then(setCat).catch(() => {}),
      garageFetch('getVendors', {}, session).then(v => setVendors(Array.isArray(v) ? v : [])).catch(() => {}),
    ]).finally(() => { setRefreshing(false); setLastRefreshed(new Date()); });
  }, [allowed, session, setRefreshing, setLastRefreshed]);

  const products = cat?.products || [];
  // Ad Hoc Parts is a PRODUCTION-only request (store_head excluded) — gated on ad_hoc_request.
  const showAdhoc = hasPermission(perms, 'ad_hoc_request');
  const tabs = showAdhoc ? [...TABS, { id: 'adhoc', label: 'Ad Hoc Parts', icon: 'filePlus' }] : TABS;

  if (!allowed) {
    return (
      <Panel title="Access denied" icon="shield" style={{ maxWidth: 520 }}>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>
          You need the <span className="num" style={{ color: 'var(--t1)' }}>run_request</span> permission to request runs.
        </div>
      </Panel>
    );
  }

  return (
    <div>
      <div style={{ maxWidth: 780 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          {tabs.map(t => (
            <button key={t.id} style={tabBtn(tab === t.id)} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={14} />{t.label}
            </button>
          ))}
        </div>
        {tab === 'fresh'      && <ProductionForm key="fresh" runType="in-house" cat={cat} products={products} session={session} toast={toast} busy={busy} setBusy={setBusy} router={router} />}
        {tab === 'outsourced' && <ProductionForm key="ext" runType="outsourced" cat={cat} products={products} vendors={vendors} session={session} toast={toast} busy={busy} setBusy={setBusy} router={router} />}
        {tab === 'repair'     && <RepairForm cat={cat} products={products} session={session} toast={toast} busy={busy} setBusy={setBusy} router={router} />}
        {tab === 'repack'     && <RepackForm cat={cat} products={products} session={session} toast={toast} busy={busy} setBusy={setBusy} router={router} />}
        {tab === 'adhoc' && showAdhoc && <AdHocPartsForm products={products} session={session} toast={toast} busy={busy} setBusy={setBusy} />}
      </div>
      <RecentRuns session={session} perms={perms} />
    </div>
  );
}

// ── Fresh / Outsourced ────────────────────────────────────────
function ProductionForm({ runType, cat, products, vendors = [], session, toast, busy, setBusy, router }) {
  const outsourced = runType === 'outsourced';
  const [product, setProduct] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [line, setLine] = useState('L1');
  const [shift, setShift] = useState('Morning');
  const [runDate, setRunDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState([{ variant: '', colour: '', qty_ecomm: '', qty_retail: '' }]);
  // FBU run-model refinement (S180): production declares the run format; FBU surfaced +
  // defaulted when built units are in stock ("finish these first").
  const [format, setFormat] = useState('CKD');
  const [builtStock, setBuiltStock] = useState(null); // { total, by_combo }

  useEffect(() => {
    if (!product || outsourced) { setBuiltStock(null); return; }
    let live = true;
    garageFetch('getBuiltUnitStock', { product }, session)
      .then(d => { if (!live) return; setBuiltStock(d || null); setFormat((d?.total || 0) > 0 ? 'FBU' : 'CKD'); })
      .catch(() => { if (live) setBuiltStock(null); });
    return () => { live = false; };
  }, [product, outsourced, session]);

  const variants = (cat?.variants?.[product]) || [];
  const colorsFor = (v) => (cat?.colors?.[product]?.[v]) || [];

  const setRow = (i, k, val) => setRows(rs => rs.map((r, j) => j === i ? { ...r, [k]: val } : r));
  const addRow = () => setRows(rs => [...rs, { variant: '', colour: '', qty_ecomm: '', qty_retail: '' }]);
  const delRow = (i) => setRows(rs => rs.length > 1 ? rs.filter((_, j) => j !== i) : rs);

  async function submit(force = false) {
    if (!product) { toast('Pick a product', 'error'); return; }
    if (outsourced && !vendorId) { toast('Pick a vendor', 'error'); return; }
    const variantsPayload = rows
      .map(r => ({ variant: r.variant || null, colour: r.colour || null, qty_ecomm: parseInt(r.qty_ecomm) || 0, qty_retail: parseInt(r.qty_retail) || 0 }))
      .filter(r => (r.qty_ecomm + r.qty_retail) > 0);
    if (!variantsPayload.length) { toast('Add at least one variant with a quantity', 'error'); return; }
    setBusy(true);
    try {
      const r = await workerFetch('createProductionRun', { data: {
        product, run_date: runDate, line_no: outsourced ? null : line, shift, notes: notes.trim() || null,
        variants: variantsPayload, run_type: runType, vendor_id: outsourced ? Number(vendorId) : null,
        format: outsourced ? null : format, force,
      } }, session);
      if (r?.warning && !force) {
        if (confirm(r.message || 'An open run already exists. Create another anyway?')) return submit(true);
        return;
      }
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      toast(`${r.data.run_no} created — issue it in Garage`, 'success');
      setProduct(''); setVendorId(''); setNotes('');
      setRows([{ variant: '', colour: '', qty_ecomm: '', qty_retail: '' }]);
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Panel title={outsourced ? 'Request Outsourced Run · EXT' : 'Request Fresh Run'} icon={outsourced ? 'truck' : 'factory'} pad={20}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div><span className="eyebrow" style={lblStyle}>Product *</span>
          <Combobox value={product} onChange={v => { setProduct(v); setRows([{ variant: '', colour: '', qty_ecomm: '', qty_retail: '' }]); }} options={products.map(p => ({ value: p, label: p }))} placeholder="Select product" /></div>
        {outsourced
          ? <div><span className="eyebrow" style={lblStyle}>Vendor *</span>
              <Combobox value={vendorId} onChange={setVendorId} options={vendors.map(v => ({ value: String(v.id), label: v.vendor_name || v.vendor_code || `#${v.id}` }))} placeholder="Select vendor" /></div>
          : <div><span className="eyebrow" style={lblStyle}>Line</span>
              <LinePicker value={line} onChange={setLine} lines={LINES_INHOUSE} /></div>}
        <div><span className="eyebrow" style={lblStyle}>Run date</span><input type="date" value={runDate} onChange={e => setRunDate(e.target.value)} style={numInp} /></div>
        <div><span className="eyebrow" style={lblStyle}>Shift</span><select value={shift} onChange={e => setShift(e.target.value)} style={inp}><option>Morning</option><option>Evening</option><option>Night</option></select></div>
      </div>

      {!outsourced && (
        <div style={{ marginBottom: 16 }}>
          <span className="eyebrow" style={lblStyle}>Format *</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {['FBU', 'CKD', 'SKD'].map(f => (
              <button key={f} type="button" onClick={() => setFormat(f)}
                style={format === f ? { ...btnPrimary, padding: '6px 18px' } : { ...btnGhost, padding: '6px 18px' }}>{f}</button>
            ))}
          </div>
          {builtStock && builtStock.total > 0 && (
            <div style={{ ...helpText, marginTop: 6, color: 'var(--accent)' }}>
              {builtStock.total} built unit{builtStock.total === 1 ? '' : 's'} in stock — finish these first (FBU).
            </div>
          )}
        </div>
      )}

      <span className="eyebrow" style={lblStyle}>Variants</span>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <thead><tr><th style={th}>Variant</th><th style={th}>Colour</th><th style={{ ...th, textAlign: 'right' }}>Ecom</th><th style={{ ...th, textAlign: 'right' }}>Retail</th><th style={th}></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ ...td, minWidth: 150 }}><Combobox value={r.variant} onChange={v => { setRow(i, 'variant', v); setRow(i, 'colour', ''); }} options={variants.map(v => ({ value: v, label: v }))} placeholder="—" portal /></td>
              <td style={{ ...td, minWidth: 150 }}><Combobox value={r.colour} onChange={v => setRow(i, 'colour', v)} options={colorsFor(r.variant).map(c => ({ value: c, label: c }))} placeholder="—" portal /></td>
              <td style={td}><input type="number" min="0" value={r.qty_ecomm} onChange={e => setRow(i, 'qty_ecomm', e.target.value)} style={{ ...numInp, width: 80, textAlign: 'right' }} /></td>
              <td style={td}><input type="number" min="0" value={r.qty_retail} onChange={e => setRow(i, 'qty_retail', e.target.value)} style={{ ...numInp, width: 80, textAlign: 'right' }} /></td>
              <td style={{ ...td, textAlign: 'right' }}><button onClick={() => delRow(i)} style={iconBtn} title="Remove row"><Icon name="x" size={13} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={addRow} style={{ ...btnGhost, marginBottom: 18 }}><Icon name="plus" size={14} />Add variant</button>

      <CoveragePanel product={product}
        qty={rows.reduce((s, r) => s + (parseInt(r.qty_ecomm) || 0) + (parseInt(r.qty_retail) || 0), 0)}
        session={session} />

      <div><span className="eyebrow" style={lblStyle}>Notes · optional</span><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...inp, resize: 'vertical' }} /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={() => submit(false)} disabled={busy} style={{ ...btnPrimary, padding: '10px 20px', opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create Run'}</button>
      </div>
    </Panel>
  );
}

// ── Repair ────────────────────────────────────────────────────
function RepairForm({ cat, products, session, toast, busy, setBusy, router }) {
  const [line, setLine] = useState('L1');
  const [runDate, setRunDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState([{ product: '', model: '', color: '', target_car_qty: '', target_remote_qty: '' }]);
  // FBU run-model refinement (S180): repair format is a CLASSIFICATION — FBU = repair-by-
  // built-unit-swap vs CKD = repair-from-parts (repair parts are requested ad-hoc; no 1:1 pick list).
  const [format, setFormat] = useState('CKD');

  const variantsFor = (p) => (cat?.variants?.[p]) || [];
  const colorsFor = (p, m) => (cat?.colors?.[p]?.[m]) || [];
  const setRow = (i, k, val) => setRows(rs => rs.map((r, j) => j === i ? { ...r, [k]: val } : r));
  const addRow = () => setRows(rs => [...rs, { product: '', model: '', color: '', target_car_qty: '', target_remote_qty: '' }]);
  const delRow = (i) => setRows(rs => rs.length > 1 ? rs.filter((_, j) => j !== i) : rs);

  async function submit() {
    const lines = rows
      .filter(r => r.product)
      .map(r => ({ product: r.product, model: r.model || null, color: r.color || null, target_car_qty: parseInt(r.target_car_qty) || 0, target_remote_qty: parseInt(r.target_remote_qty) || 0 }));
    setBusy(true);
    try {
      const r = await workerFetch('createRepairRun', { data: { line, run_date: runDate, notes: notes.trim() || 'Repair run (Redline)', lines, format } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      toast(`${r.data?.run_no || 'Repair run'} created`, 'success');
      router.push('/returns');
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Request Repair Run" icon="wrench" pad={20}>
      <div style={helpText}>
        A repair run is open-ended — leave the target lines blank to start a pure recovery run, or add expected products and quantities. Parts are requested ad-hoc off-line and linked to the run.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div><span className="eyebrow" style={lblStyle}>Line</span><LinePicker value={line} onChange={setLine} lines={LINES_REPAIR} /></div>
        <div><span className="eyebrow" style={lblStyle}>Run date</span><input type="date" value={runDate} onChange={e => setRunDate(e.target.value)} style={numInp} /></div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <span className="eyebrow" style={lblStyle}>Format *</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {['FBU', 'CKD', 'SKD'].map(f => (
            <button key={f} type="button" onClick={() => setFormat(f)}
              style={format === f ? { ...btnPrimary, padding: '6px 18px' } : { ...btnGhost, padding: '6px 18px' }}>{f}</button>
          ))}
        </div>
        <div style={{ ...helpText, marginTop: 6 }}>FBU = repair by swapping in a built unit · CKD = repair from parts.</div>
      </div>
      <span className="eyebrow" style={lblStyle}>Target lines · optional</span>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <thead><tr><th style={th}>Product</th><th style={th}>Model</th><th style={th}>Colour</th><th style={{ ...th, textAlign: 'right' }}>Cars</th><th style={{ ...th, textAlign: 'right' }}>Remotes</th><th style={th}></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ ...td, minWidth: 140 }}><Combobox value={r.product} onChange={v => { setRow(i, 'product', v); setRow(i, 'model', ''); setRow(i, 'color', ''); }} options={products.map(p => ({ value: p, label: p }))} placeholder="—" portal /></td>
              <td style={{ ...td, minWidth: 130 }}><Combobox value={r.model} onChange={v => { setRow(i, 'model', v); setRow(i, 'color', ''); }} options={variantsFor(r.product).map(v => ({ value: v, label: v }))} placeholder="—" portal /></td>
              <td style={{ ...td, minWidth: 130 }}><Combobox value={r.color} onChange={v => setRow(i, 'color', v)} options={colorsFor(r.product, r.model).map(c => ({ value: c, label: c }))} placeholder="—" portal /></td>
              <td style={td}><input type="number" min="0" value={r.target_car_qty} onChange={e => setRow(i, 'target_car_qty', e.target.value)} style={{ ...numInp, width: 72, textAlign: 'right' }} /></td>
              <td style={td}><input type="number" min="0" value={r.target_remote_qty} onChange={e => setRow(i, 'target_remote_qty', e.target.value)} style={{ ...numInp, width: 72, textAlign: 'right' }} /></td>
              <td style={{ ...td, textAlign: 'right' }}><button onClick={() => delRow(i)} style={iconBtn} title="Remove row"><Icon name="x" size={13} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={addRow} style={{ ...btnGhost, marginBottom: 18 }}><Icon name="plus" size={14} />Add line</button>
      <div><span className="eyebrow" style={lblStyle}>Notes · optional</span><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...inp, resize: 'vertical' }} /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={submit} disabled={busy} style={{ ...btnPrimary, padding: '10px 20px', opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create Repair Run'}</button>
      </div>
    </Panel>
  );
}

// ── Repack ────────────────────────────────────────────────────
function RepackForm({ cat, products, session, toast, busy, setBusy, router }) {
  const [product, setProduct] = useState('');
  const [model, setModel] = useState('');
  const [colour, setColour] = useState('');
  const [fromCh, setFromCh] = useState('retail');
  const [toCh, setToCh] = useState('ecom');
  const [qty, setQty] = useState('');
  const [notes, setNotes] = useState('');

  const variants = (cat?.variants?.[product]) || [];
  const colorsFor = (m) => (cat?.colors?.[product]?.[m]) || [];

  async function submit() {
    const n = parseInt(qty, 10);
    if (!n || n < 1) { toast('Target quantity must be a positive number', 'error'); return; }
    if (fromCh === toCh) { toast('From and To channels must differ', 'error'); return; }
    setBusy(true);
    try {
      const r = await workerFetch('createRepackRun', { data: {
        target_qty: n, product: product || null, variant_model: model || null, colour: colour || null,
        from_channel: fromCh, to_channel: toCh, notes: notes.trim() || null,
      } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      toast(`${r.data.run_no} created`, 'success');
      router.push(`/repack-runs/detail?id=${r.data.id}`);
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  const chSel = (val, set) => (
    <select value={val} onChange={e => set(e.target.value)} style={inp}><option value="retail">Retail</option><option value="ecom">Ecom</option></select>
  );

  return (
    <Panel title="Request Repack Run · Channel Swap" icon="swap" pad={20}>
      <div style={helpText}>
        Repack swaps a unit&rsquo;s channel packaging. This raises a store request for the To-channel primary packaging and a dispatch release of the units.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div><span className="eyebrow" style={lblStyle}>Product</span><Combobox value={product} onChange={v => { setProduct(v); setModel(''); setColour(''); }} options={products.map(p => ({ value: p, label: p }))} placeholder="Select product" /></div>
        <div><span className="eyebrow" style={lblStyle}>Model</span><Combobox value={model} onChange={v => { setModel(v); setColour(''); }} options={variants.map(v => ({ value: v, label: v }))} placeholder="—" /></div>
        <div><span className="eyebrow" style={lblStyle}>Colour</span><Combobox value={colour} onChange={setColour} options={colorsFor(model).map(c => ({ value: c, label: c }))} placeholder="—" /></div>
        <div><span className="eyebrow" style={lblStyle}>From channel *</span>{chSel(fromCh, setFromCh)}</div>
        <div><span className="eyebrow" style={lblStyle}>To channel *</span>{chSel(toCh, setToCh)}</div>
        <div><span className="eyebrow" style={lblStyle}>Target qty *</span><input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} style={numInp} placeholder="units" /></div>
      </div>
      <div><span className="eyebrow" style={lblStyle}>Notes · optional</span><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...inp, resize: 'vertical' }} /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={submit} disabled={busy} style={{ ...btnPrimary, padding: '10px 20px', opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create Repack Run'}</button>
      </div>
    </Panel>
  );
}

// ── Ad Hoc Parts (production-only parts request) ──────────────
function AdHocPartsForm({ products, session, toast, busy, setBusy }) {
  const [mode, setMode] = useState('bom');
  const [product, setProduct] = useState('');
  const [category, setCategory] = useState('');
  const [bom, setBom] = useState([]);
  const [lines, setLines] = useState([]);
  const [line, setLineNo] = useState('L1');
  const [shift, setShift] = useState('Morning');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [repairRuns, setRepairRuns] = useState([]);
  const [repairRunId, setRepairRunId] = useState('');
  const [mat, setMat] = useState(null);

  useEffect(() => {
    garageFetch('getRepairRunsDash', { status: 'planned,active' }, session)
      .then(r => setRepairRuns(Array.isArray(r) ? r : [])).catch(() => {});
  }, [session]);
  useEffect(() => {
    if (mode !== 'bom' || !product) return;
    garageFetch('getBOM', { product }, session).then(d => setBom(Array.isArray(d) ? d : [])).catch(() => setBom([]));
  }, [mode, product, session]);

  const categories = [...new Set(bom.map(r => r.part_category).filter(Boolean))].sort();
  const nid = () => Math.random().toString(36).slice(2, 9);
  const setL = (id, patch) => setLines(ls => ls.map(l => l.id === id ? { ...l, ...patch } : l));
  const delL = (id) => setLines(ls => ls.filter(l => l.id !== id));

  function addCategory() {
    if (!product || !category) return;
    const have = new Set(lines.filter(l => l.type === 'part').map(l => l.code));
    const fresh = bom.filter(r => r.part_category === category && !have.has(r.part_code));
    if (!fresh.length) { toast('All parts in that category are already added', 'info'); return; }
    setLines(ls => [...ls, { id: nid(), type: 'header', label: category },
      ...fresh.map(r => ({ id: nid(), type: 'part', code: r.part_code, name: r.part_name, qty: '' }))]);
  }
  async function addManual() {
    if (!mat) {
      const d = await garageFetch('getMaterials', {}, session).catch(() => []);
      const cache = {}; (d || []).forEach(m => { if (m.part_code) cache[m.part_code.toUpperCase()] = m; });
      setMat(cache);
    }
    setLines(ls => [...ls, { id: nid(), type: 'part', code: '', name: '', qty: '' }]);
  }
  async function submit() {
    const parts = lines.filter(l => l.type === 'part' && (parseInt(l.qty) || 0) > 0)
      .map(l => ({ part_code: (l.code || '').toUpperCase(), part_name: l.name || '', qty_requested: parseInt(l.qty) || 0 }));
    if (!parts.length) { toast('Add at least one part with a quantity', 'error'); return; }
    setBusy(true);
    try {
      const r = await workerFetch('postWorkOrder', { data: {
        wo_type: 'Parts Request', line_no: line, shift, date, parts,
        repair_run_id: repairRunId || null, product: mode === 'bom' ? (product || null) : null,
      } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      toast(`${r.data?.wo_no || 'Request'} created — store will issue from the Issue Queue`, 'success');
      setLines([]); setProduct(''); setCategory(''); setRepairRunId('');
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Request Ad Hoc Parts" icon="filePlus" pad={20}>
      <div style={helpText}>
        A one-off parts request to the store (not a run). Build it from a product&rsquo;s BOM category or type part codes by hand; optionally link it to a repair run.
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button style={tabBtn(mode === 'bom')} onClick={() => { setMode('bom'); setLines([]); }}>BOM-based</button>
        <button style={tabBtn(mode === 'manual')} onClick={() => { setMode('manual'); setLines([]); }}>Manual</button>
      </div>
      {mode === 'bom' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end', marginBottom: 14 }}>
          <div><span className="eyebrow" style={lblStyle}>Product</span><Combobox value={product} onChange={v => { setProduct(v); setCategory(''); }} options={products.map(p => ({ value: p, label: p }))} placeholder="Select product" /></div>
          <div><span className="eyebrow" style={lblStyle}>Category</span><select value={category} onChange={e => setCategory(e.target.value)} style={inp} disabled={!product}><option value="">{product ? 'Select…' : 'Pick a product'}</option>{categories.map(c => <option key={c}>{c}</option>)}</select></div>
          <button style={{ ...btnGhost, opacity: (!product || !category) ? 0.5 : 1 }} onClick={addCategory} disabled={!product || !category}><Icon name="plus" size={14} />Add category</button>
        </div>
      )}
      {mode === 'manual' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}><button style={btnGhost} onClick={addManual}><Icon name="plus" size={14} />Add part</button></div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
        <thead><tr><th style={th}>Part</th><th style={th}>Name</th><th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={th}></th></tr></thead>
        <tbody>
          {lines.length === 0 && <tr><td colSpan={4} style={{ ...td, color: 'var(--t3)', textAlign: 'center', padding: 18 }}>{mode === 'bom' ? 'Pick a product + category, then Add category.' : 'Click Add part to start.'}</td></tr>}
          {lines.map(l => l.type === 'header'
            ? <tr key={l.id}><td colSpan={4} style={{ ...td, background: 'var(--surface-2)', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--t2)' }}>{l.label}</td></tr>
            : <tr key={l.id}>
                <td style={{ ...td, minWidth: 160 }}>{mode === 'bom'
                  ? <span className="num" style={{ fontSize: 12, color: 'var(--yellow)' }}>{l.code}</span>
                  : <Combobox
                      value={l.code}
                      options={Object.values(mat || {}).map(m => ({
                        value: m.part_code,
                        label: `${m.part_code}${m.part_name ? ' — ' + m.part_name : ''}`,
                        hint: [m.product, m.part_category].filter(Boolean).join(' · '),
                        part_name: m.part_name,
                      }))}
                      onChange={(v, opt) => setL(l.id, { code: v, name: opt?.part_name || '' })}
                      placeholder="Search part code / name…"
                      inputStyle={{ fontSize: 12, fontFamily: 'var(--mono)' }}
                      portal
                    />}</td>
                <td style={td}>{l.name || (mode === 'manual' ? <span style={{ color: 'var(--t3)', fontSize: 12 }}>auto-fills</span> : '')}</td>
                <td style={{ ...td, textAlign: 'right' }}><input type="number" min="0" value={l.qty} onChange={e => setL(l.id, { qty: e.target.value })} style={{ ...numInp, width: 72, textAlign: 'right' }} /></td>
                <td style={{ ...td, textAlign: 'right' }}><button onClick={() => delL(l.id)} style={iconBtn} title="Remove part"><Icon name="x" size={13} /></button></td>
              </tr>)}
        </tbody>
      </table>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
        <div><span className="eyebrow" style={lblStyle}>Line</span><LinePicker value={line} onChange={setLineNo} lines={['L1', 'L2', 'L3', 'L4', 'L5']} /></div>
        <div><span className="eyebrow" style={lblStyle}>Shift</span><select value={shift} onChange={e => setShift(e.target.value)} style={inp}><option>Morning</option><option>Evening</option><option>Night</option></select></div>
        <div><span className="eyebrow" style={lblStyle}>Date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} style={numInp} /></div>
      </div>
      <div style={{ marginBottom: 14 }}><span className="eyebrow" style={lblStyle}>Repair run · optional</span><Combobox value={repairRunId} onChange={setRepairRunId} options={repairRuns.map(r => ({ value: r.id, label: `${r.run_no} · ${r.line || '—'}` }))} placeholder="Link to a repair run (for parts tracking)…" /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={submit} disabled={busy} style={{ ...btnPrimary, padding: '10px 20px', opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create Request'}</button></div>
    </Panel>
  );
}
