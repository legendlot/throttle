'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { EmptyState, Panel, Combobox, useToast } from '@throttle/ui';
import { RecentRuns } from '../../../components/production-runs/RecentRuns.js';

// Unified run-request surface (run-request consolidation, 2026-06-07).
// One place for production to request ANY run: Fresh · Outsourced · Repair · Repack.
// Gated by the `run_request` permission. Each tab routes to its existing worker
// create handler (backends stay separate — RULE consolidation framing #2).

export function canRequestRun(perms) {
  return hasPermission(perms, 'run_request')
      || hasPermission(perms, 'users_manage'); // super_admin convenience
}

const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', outline: 'none', width: '100%' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, display: 'block' };
const btnP  = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '10px 18px', fontFamily: 'var(--cond)', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', cursor: 'pointer' };
const tabBtn = (active) => ({ background: active ? 'var(--yellow)' : 'transparent', border: `1px solid ${active ? 'var(--yellow)' : 'var(--border)'}`, borderRadius: 3, padding: '8px 16px', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: active ? '#0a0a0a' : 'var(--t2)', cursor: 'pointer' });
const th = { padding: '7px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--t3)', textAlign: 'left', borderBottom: '1px solid var(--border)' };
const td = { padding: '5px 8px', borderBottom: '1px solid rgba(64,64,64,.4)' };

const LINES_INHOUSE = ['L1', 'L2', 'L3'];
const LINES_REPAIR  = ['L1', 'L2', 'L3', 'L4', 'L5'];
const TABS = [
  { id: 'fresh',      label: 'Fresh' },
  { id: 'outsourced', label: 'Outsourced' },
  { id: 'repair',     label: 'Repair' },
  { id: 'repack',     label: 'Repack' },
];

export default function NewRunPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const allowed = canRequestRun(perms);

  const [tab, setTab]   = useState('fresh');
  const [cat, setCat]   = useState(null);     // getProductCatalogue
  const [vendors, setVendors] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    garageFetch('getProductCatalogue', {}, session).then(setCat).catch(() => {});
    garageFetch('getVendors', {}, session).then(v => setVendors(Array.isArray(v) ? v : [])).catch(() => {});
  }, [allowed, session]);

  const products = cat?.products || [];
  // Ad Hoc Parts is a PRODUCTION-only request (store_head excluded) — gated on ad_hoc_request.
  const showAdhoc = hasPermission(perms, 'ad_hoc_request');
  const tabs = showAdhoc ? [...TABS, { id: 'adhoc', label: 'Ad Hoc Parts' }] : TABS;

  if (!allowed) {
    return <div style={{ padding: 16 }}><EmptyState icon="🔒" message="Access denied — you need the run_request permission to request runs." /></div>;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ maxWidth: 760 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {tabs.map(t => <button key={t.id} style={tabBtn(tab === t.id)} onClick={() => setTab(t.id)}>{t.label}</button>)}
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
        variants: variantsPayload, run_type: runType, vendor_id: outsourced ? Number(vendorId) : null, force,
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
    <Panel header={outsourced ? 'Request Outsourced Run · EXT' : 'Request Fresh Run'}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div><label style={lbl}>Product *</label>
          <Combobox value={product} onChange={v => { setProduct(v); setRows([{ variant: '', colour: '', qty_ecomm: '', qty_retail: '' }]); }} options={products.map(p => ({ value: p, label: p }))} placeholder="Select product" /></div>
        {outsourced
          ? <div><label style={lbl}>Vendor *</label>
              <Combobox value={vendorId} onChange={setVendorId} options={vendors.map(v => ({ value: String(v.id), label: v.vendor_name || v.vendor_code || `#${v.id}` }))} placeholder="Select vendor" /></div>
          : <div><label style={lbl}>Line</label>
              <select value={line} onChange={e => setLine(e.target.value)} style={input}>{LINES_INHOUSE.map(l => <option key={l}>{l}</option>)}</select></div>}
        <div><label style={lbl}>Run date</label><input type="date" value={runDate} onChange={e => setRunDate(e.target.value)} style={input} /></div>
        <div><label style={lbl}>Shift</label><select value={shift} onChange={e => setShift(e.target.value)} style={input}><option>Morning</option><option>Evening</option><option>Night</option></select></div>
      </div>

      <label style={lbl}>Variants</label>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <thead><tr><th style={th}>Variant</th><th style={th}>Colour</th><th style={{ ...th, textAlign: 'right' }}>Ecom</th><th style={{ ...th, textAlign: 'right' }}>Retail</th><th style={th}></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ ...td, minWidth: 150 }}><Combobox value={r.variant} onChange={v => { setRow(i, 'variant', v); setRow(i, 'colour', ''); }} options={variants.map(v => ({ value: v, label: v }))} placeholder="—" /></td>
              <td style={{ ...td, minWidth: 150 }}><Combobox value={r.colour} onChange={v => setRow(i, 'colour', v)} options={colorsFor(r.variant).map(c => ({ value: c, label: c }))} placeholder="—" /></td>
              <td style={td}><input type="number" min="0" value={r.qty_ecomm} onChange={e => setRow(i, 'qty_ecomm', e.target.value)} style={{ ...input, width: 80, textAlign: 'right' }} /></td>
              <td style={td}><input type="number" min="0" value={r.qty_retail} onChange={e => setRow(i, 'qty_retail', e.target.value)} style={{ ...input, width: 80, textAlign: 'right' }} /></td>
              <td style={td}><button onClick={() => delRow(i)} style={{ ...btnS, padding: '4px 8px' }}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={addRow} style={{ ...btnS, marginBottom: 16 }}>+ Add variant</button>

      <div><label style={lbl}>Notes · optional</label><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...input, resize: 'vertical' }} /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={() => submit(false)} disabled={busy} style={{ ...btnP, opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create Run'}</button>
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
      const r = await workerFetch('createRepairRun', { data: { line, run_date: runDate, notes: notes.trim() || 'Repair run (Redline)', lines } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      toast(`${r.data?.run_no || 'Repair run'} created`, 'success');
      router.push('/returns');
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Panel header="Request Repair Run · target-less recovery (optional target lines below)">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 14, lineHeight: 1.5 }}>
        A repair run is open-ended — leave the target lines blank to start a pure recovery run, or add expected products/quantities. Parts are requested ad-hoc off-line and linked to the run.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div><label style={lbl}>Line</label><select value={line} onChange={e => setLine(e.target.value)} style={input}>{LINES_REPAIR.map(l => <option key={l}>{l}</option>)}</select></div>
        <div><label style={lbl}>Run date</label><input type="date" value={runDate} onChange={e => setRunDate(e.target.value)} style={input} /></div>
      </div>
      <label style={lbl}>Target lines · optional</label>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <thead><tr><th style={th}>Product</th><th style={th}>Model</th><th style={th}>Colour</th><th style={{ ...th, textAlign: 'right' }}>Cars</th><th style={{ ...th, textAlign: 'right' }}>Remotes</th><th style={th}></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ ...td, minWidth: 140 }}><Combobox value={r.product} onChange={v => { setRow(i, 'product', v); setRow(i, 'model', ''); setRow(i, 'color', ''); }} options={products.map(p => ({ value: p, label: p }))} placeholder="—" /></td>
              <td style={{ ...td, minWidth: 130 }}><Combobox value={r.model} onChange={v => { setRow(i, 'model', v); setRow(i, 'color', ''); }} options={variantsFor(r.product).map(v => ({ value: v, label: v }))} placeholder="—" /></td>
              <td style={{ ...td, minWidth: 130 }}><Combobox value={r.color} onChange={v => setRow(i, 'color', v)} options={colorsFor(r.product, r.model).map(c => ({ value: c, label: c }))} placeholder="—" /></td>
              <td style={td}><input type="number" min="0" value={r.target_car_qty} onChange={e => setRow(i, 'target_car_qty', e.target.value)} style={{ ...input, width: 72, textAlign: 'right' }} /></td>
              <td style={td}><input type="number" min="0" value={r.target_remote_qty} onChange={e => setRow(i, 'target_remote_qty', e.target.value)} style={{ ...input, width: 72, textAlign: 'right' }} /></td>
              <td style={td}><button onClick={() => delRow(i)} style={{ ...btnS, padding: '4px 8px' }}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={addRow} style={{ ...btnS, marginBottom: 16 }}>+ Add line</button>
      <div><label style={lbl}>Notes · optional</label><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...input, resize: 'vertical' }} /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={submit} disabled={busy} style={{ ...btnP, opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create Repair Run'}</button>
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
    <select value={val} onChange={e => set(e.target.value)} style={input}><option value="retail">Retail</option><option value="ecom">Ecom</option></select>
  );

  return (
    <Panel header="Request Repack Run · channel swap">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 14, lineHeight: 1.5 }}>
        Repack swaps a unit's channel packaging. This raises a store request for the To-channel primary packaging and a dispatch release of the units.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div><label style={lbl}>Product</label><Combobox value={product} onChange={v => { setProduct(v); setModel(''); setColour(''); }} options={products.map(p => ({ value: p, label: p }))} placeholder="Select product" /></div>
        <div><label style={lbl}>Model</label><Combobox value={model} onChange={v => { setModel(v); setColour(''); }} options={variants.map(v => ({ value: v, label: v }))} placeholder="—" /></div>
        <div><label style={lbl}>Colour</label><Combobox value={colour} onChange={setColour} options={colorsFor(model).map(c => ({ value: c, label: c }))} placeholder="—" /></div>
        <div><label style={lbl}>From channel *</label>{chSel(fromCh, setFromCh)}</div>
        <div><label style={lbl}>To channel *</label>{chSel(toCh, setToCh)}</div>
        <div><label style={lbl}>Target qty *</label><input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} style={input} placeholder="units" /></div>
      </div>
      <div><label style={lbl}>Notes · optional</label><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...input, resize: 'vertical' }} /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={submit} disabled={busy} style={{ ...btnP, opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create Repack Run'}</button>
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
  function codeBlur(id, val) {
    const c = (val || '').trim().toUpperCase();
    setL(id, { code: c, name: mat?.[c]?.part_name || '' });
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
    <Panel header="Request Ad Hoc Parts">
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 14, lineHeight: 1.5 }}>
        A one-off parts request to the store (not a run). Build it from a product&rsquo;s BOM category or type part codes by hand; optionally link it to a repair run.
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <button style={tabBtn(mode === 'bom')} onClick={() => { setMode('bom'); setLines([]); }}>BOM-based</button>
        <button style={tabBtn(mode === 'manual')} onClick={() => { setMode('manual'); setLines([]); }}>Manual</button>
      </div>
      {mode === 'bom' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end', marginBottom: 12 }}>
          <div><label style={lbl}>Product</label><Combobox value={product} onChange={v => { setProduct(v); setCategory(''); }} options={products.map(p => ({ value: p, label: p }))} placeholder="Select product" /></div>
          <div><label style={lbl}>Category</label><select value={category} onChange={e => setCategory(e.target.value)} style={input} disabled={!product}><option value="">{product ? 'Select…' : 'Pick a product'}</option>{categories.map(c => <option key={c}>{c}</option>)}</select></div>
          <button style={btnS} onClick={addCategory} disabled={!product || !category}>+ Add category</button>
        </div>
      )}
      {mode === 'manual' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}><button style={btnS} onClick={addManual}>+ Add part</button></div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <thead><tr><th style={th}>Part</th><th style={th}>Name</th><th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={th}></th></tr></thead>
        <tbody>
          {lines.length === 0 && <tr><td colSpan={4} style={{ ...td, color: 'var(--t3)', textAlign: 'center', padding: 16 }}>{mode === 'bom' ? 'Pick a product + category, then Add category.' : 'Click + Add part.'}</td></tr>}
          {lines.map(l => l.type === 'header'
            ? <tr key={l.id}><td colSpan={4} style={{ ...td, background: 'var(--surface2)', fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t2)' }}>{l.label}</td></tr>
            : <tr key={l.id}>
                <td style={{ ...td, minWidth: 120 }}>{mode === 'bom'
                  ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--yellow)' }}>{l.code}</span>
                  : <input value={l.code} onChange={e => setL(l.id, { code: e.target.value.toUpperCase() })} onBlur={e => codeBlur(l.id, e.target.value)} placeholder="Part code" style={{ ...input, fontSize: 11 }} />}</td>
                <td style={td}>{l.name || (mode === 'manual' ? <span style={{ color: 'var(--t3)', fontSize: 11 }}>auto-fills</span> : '')}</td>
                <td style={td}><input type="number" min="0" value={l.qty} onChange={e => setL(l.id, { qty: e.target.value })} style={{ ...input, width: 72, textAlign: 'right' }} /></td>
                <td style={td}><button onClick={() => delL(l.id)} style={{ ...btnS, padding: '4px 8px' }}>✕</button></td>
              </tr>)}
        </tbody>
      </table>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div><label style={lbl}>Line</label><select value={line} onChange={e => setLineNo(e.target.value)} style={input}>{['L1', 'L2', 'L3', 'L4', 'L5'].map(l => <option key={l}>{l}</option>)}</select></div>
        <div><label style={lbl}>Shift</label><select value={shift} onChange={e => setShift(e.target.value)} style={input}><option>Morning</option><option>Evening</option><option>Night</option></select></div>
        <div><label style={lbl}>Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} style={input} /></div>
      </div>
      <div style={{ marginBottom: 12 }}><label style={lbl}>Repair run · optional</label><Combobox value={repairRunId} onChange={setRepairRunId} options={repairRuns.map(r => ({ value: r.id, label: `${r.run_no} · ${r.line || '—'}` }))} placeholder="Link to a repair run (for parts tracking)…" /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={submit} disabled={busy} style={{ ...btnP, opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create Request'}</button></div>
    </Panel>
  );
}
