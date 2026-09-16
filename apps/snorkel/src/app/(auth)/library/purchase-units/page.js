'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Btn, EmptyState } from '@/components/ui.js';

const inputStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '5px 8px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', width: '100%' };

// The page's copy of the worker's factor rules (normPurchaseUnit / piecesFactor /
// perPiecePreview in snorkelops-worker/src/index.js), so the preview moves as the buyer
// types instead of only after a save. ⚠️ Three copies of these rules now exist — SQL
// (store.derive_unit_costs, the one that WRITES), worker (the listed preview) and this
// one. Change all three together; the worker test is what catches the first two drifting.
function normUnit(u) { return String(u ?? '').trim().toLowerCase(); }
const RESERVED_UOM = ['pcs', 'kg'];
function factorFor(unit, part) {
  const u = normUnit(unit);
  if (!u) return null;
  if (u === 'pcs') return 1;
  if (u === 'kg') {
    const grams = Number(part?.weight_per_unit_grams);
    return grams > 0 ? 1000 / grams : null;
  }
  const uom = normUnit(part?.purchase_uom);
  const pieces = Number(part?.pieces_per_purchase_uom);
  // pcs/kg are never a stored conversion — the SQL function refuses both (RULE-014 for kg).
  if (!uom || RESERVED_UOM.includes(uom)) return null;
  if (u === uom && Number.isFinite(pieces) && pieces > 0) return pieces;
  return null;
}
// The newest line that is convertible under the DRAFT conversion — the one the derivation
// will price from. Not the newest line: a newer kg line on a part with no weight is a dead
// end, and the older Roll line is what gets priced.
function pickLine(units, part) {
  for (const l of units || []) {
    const factor = factorFor(l?.unit, part);
    if (factor !== null) return { line: l, factor };
  }
  return null;
}
function perPiece(unitPrice, factor) {
  const price = Number(unitPrice), f = Number(factor);
  if (!(price > 0) || !(f > 0)) return null;
  return Math.round((price / f) * 10000) / 10000;
}
// The preview is 4 dp for the eye; the WRITTEN value is 2 dp (unit_cost is numeric(10,2)).
const money2 = v => (v === null || v === undefined || v === '' ? '—' : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const money = v => (v === null || v === undefined || v === '' ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 4 })}`);

export default function PurchaseUnitsPage() {
  const { userId, perms } = useAuth();
  const { showToast } = useToast();
  const canManage = hasPermission(perms, 'po_create');

  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits]     = useState({});    // part_code → { purchase_uom, pieces_per_purchase_uom }
  const [busy, setBusy]       = useState(null);  // part_code being saved, or 'all'
  const firstLoadDone = useRef(false);

  const load = useCallback(async () => {
    if (!userId || !canManage) { setLoading(false); return; }
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('listPurchaseUnits', {}, s);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, canManage, showToast]);
  useEffect(() => { load(); }, [load]);

  const editing = Object.keys(edits).length > 0;
  const draft = r => ({
    purchase_uom: edits[r.part_code]?.purchase_uom ?? (r.purchase_uom || ''),
    pieces_per_purchase_uom: edits[r.part_code]?.pieces_per_purchase_uom
      ?? (r.pieces_per_purchase_uom == null ? '' : String(r.pieces_per_purchase_uom)),
  });
  const setDraft = (code, field, value) =>
    setEdits(prev => ({ ...prev, [code]: { ...draft(rows.find(r => r.part_code === code)), ...prev[code], [field]: value } }));

  async function save(r) {
    const d = draft(r);
    const uom = d.purchase_uom.trim();
    const pieces = d.pieces_per_purchase_uom === '' ? null : Number(d.pieces_per_purchase_uom);
    if ((uom ? 1 : 0) !== (pieces !== null ? 1 : 0)) { showToast('Set both the unit and the pieces per unit, or clear both', 'error'); return; }
    // Number.isFinite, not `> 0`: '1e999' is Infinity, which would post as null and half-set the row.
    if (pieces !== null && !(Number.isFinite(pieces) && pieces > 0 && pieces <= 99999999.9999)) {
      showToast('Pieces per unit must be a number greater than 0 and at most 99,999,999.9999', 'error'); return; }
    if (uom && RESERVED_UOM.includes(normUnit(uom))) {
      showToast('pcs and kg cannot be a purchase unit — kg converts through the part weight', 'error'); return; }
    setBusy(r.part_code);
    try {
      const s = await getValidSession();
      const res = await workerFetch('setPurchaseUnit', { data: { part_code: r.part_code, purchase_uom: uom || null, pieces_per_purchase_uom: pieces } }, s);
      if (!res.ok) { showToast(res.data?.error || 'Save failed', 'error'); return; }
      const dv = res.data?.derivation;
      // No row back = the part has no priced PO line to derive from (v4 returns nothing for those).
      showToast(dv?.applied ? `Saved — ${r.part_code} now ${money2(dv.new_cost)}/pc`
        : dv ? `Saved — cost unchanged (${dv.reason})`
             : 'Saved — no priced PO line to derive from yet', dv?.applied ? 'success' : 'info');
      setEdits(prev => { const n = { ...prev }; delete n[r.part_code]; return n; });
      firstLoadDone.current = true;      // never flash the spinner over the other rows' edits
      await load();
    } finally { setBusy(null); }
  }

  async function rederiveAll() {
    setBusy('all');
    try {
      const s = await getValidSession();
      const res = await workerFetch('rederiveUnitCosts', { data: {} }, s);
      if (!res.ok) { showToast(res.data?.error || 'Re-derivation failed', 'error'); return; }
      // `evaluated` is the number of parts that HAD a priced PO line, not the number asked for —
      // v4 returns no row at all for a part with nothing to derive from.
      const { applied = 0, rejected = 0, unchanged = 0, evaluated = 0 } = res.data || {};
      showToast(`${applied} applied · ${rejected} rejected · ${unchanged} unchanged (${evaluated} parts priced)`, 'success');
      await load();
    } finally { setBusy(null); }
  }

  if (!canManage) {
    return <EmptyState icon="shield" title="Buyer access required" hint="You need the Raise PO permission to set purchase-unit conversions." />;
  }
  // ⛔ Never let a background reload (a real token refresh re-keys `load`) swap a half-typed
  // conversion for the spinner — CORE.md's useAuth rule, gate 2.
  if (loading && !editing) return <Spinner />;

  return (
    <>
      <PageHead title="Purchase Units" sub="Parts bought by the Roll / Packet / kg. State how many pieces one purchase unit holds and the per-piece cost derives itself from PO history."
        actions={<Btn kind="primary" onClick={rederiveAll} disabled={busy === 'all'}>{busy === 'all' ? 'Re-deriving…' : 'Re-derive all costs'}</Btn>} />

      <div className="info-bar">
        <span>These parts have at least one India PO line priced in a unit that is not <b>pcs</b>, so their per-piece cost cannot derive until the conversion is stated. <b>kg needs no entry</b> — it converts through the part&apos;s weight. Costs are <b>derived, not verified</b>: a value that looks wrong is rejected by the detectors rather than written.</span>
      </div>

      <Panel title="Parts bought in bulk units" count={rows.length}>
        {rows.length === 0 ? (
          <EmptyState icon="package" title="Nothing to convert" hint="Every India PO line is priced in pcs." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="dt">
              <thead><tr>
                <th>Part</th><th>Name</th><th>Category</th><th>Units seen</th><th className="num">Weight (g)</th>
                <th>Bought as</th><th className="num">Pieces per unit</th><th className="num">Per piece</th>
                <th className="num">Current cost</th><th className="num">Save</th>
              </tr></thead>
              <tbody>
                {rows.map(r => {
                  const d = draft(r);
                  const live = { ...r, purchase_uom: d.purchase_uom, pieces_per_purchase_uom: d.pieces_per_purchase_uom };
                  // Placeholder = the newest unit that COULD be a conversion, i.e. not pcs/kg.
                  const hint = (r.units_seen || []).find(u => !RESERVED_UOM.includes(normUnit(u.unit)));
                  const pick = pickLine(r.units_seen, live);
                  const preview = pick ? perPiece(pick.line.unit_price, pick.factor) : null;
                  const dirty = !!edits[r.part_code];
                  return (
                    <tr key={r.part_code}>
                      <td className="mono"><b>{r.part_code}</b></td>
                      <td>{r.part_name || '—'}</td>
                      <td className="dim">{r.part_category || '—'}</td>
                      <td className="dim" style={{ fontSize: 11 }}>
                        {(r.units_seen || []).map(u => (
                          <div key={u.unit + u.po_number}>{u.unit} @ {money(u.unit_price)} <span className="dim">({u.po_number})</span></div>
                        ))}
                      </td>
                      <td className="num dim">{r.weight_per_unit_grams ?? '—'}</td>
                      <td><input value={d.purchase_uom} maxLength={20} placeholder={hint ? hint.unit : 'e.g. Roll'}
                        onChange={e => setDraft(r.part_code, 'purchase_uom', e.target.value)} style={inputStyle} /></td>
                      <td className="num"><input type="number" min="0" step="any" value={d.pieces_per_purchase_uom}
                        onChange={e => setDraft(r.part_code, 'pieces_per_purchase_uom', e.target.value)} style={{ ...inputStyle, textAlign: 'right' }} /></td>
                      <td className="num" title={pick ? `from the ${pick.line.unit} line on ${pick.line.po_number} — written at 2 dp` : ''}>
                        {preview == null ? <span className="dim">—</span> : money(preview)}
                        {preview != null && <div className="dim" style={{ fontSize: 10 }}>writes {money2(preview)}</div>}
                      </td>
                      <td className="num dim">{money2(r.unit_cost)}</td>
                      <td className="num"><Btn onClick={() => save(r)} disabled={!dirty || busy === r.part_code}>{busy === r.part_code ? '…' : 'Save'}</Btn></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
