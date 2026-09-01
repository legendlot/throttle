'use client';
import { Suspense, useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox, useEscapeClose } from '@throttle/ui';
import { LINES } from '@throttle/domain';
import { useProducts } from '../../../../hooks/useProducts.js';
import QRCode from 'qrcode';

// Scannable QR of the RS-NNN so the floor can scan it at the PWA Return Intake
// station (decodes to the literal "RS-NNN", which the scanner's RET_IN handler
// binds on). Falls back silently if QR generation fails — the dropdown still works.
function RsQr({ value }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(String(value), { margin: 1, width: 200, errorCorrectionLevel: 'M' })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => {});
    return () => { alive = false; };
  }, [value]);
  if (!src) return null;
  return (
    <div style={{ textAlign: 'center' }}>
      <img src={src} alt={value} width={92} height={92} style={{ display: 'block', background: '#fff', borderRadius: 6, padding: 4 }} />
      <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', marginTop: 3, letterSpacing: '.05em' }}>SCAN AT INTAKE</div>
    </div>
  );
}

// ── Returns v2 dispositions (Store free-choice; see returns process manual) ──
const DISPOSITIONS = [
  { value: 'UDR',  label: 'UDR',  full: 'Undamaged Return',  tone: 'green',  hint: 're-dispatch as-is, box never opened' },
  { value: 'CXR',  label: 'CXR',  full: 'Customer Return',   tone: 'yellow', hint: 'goes to a repair run' },
  { value: 'BRV',  label: 'BRV',  full: 'Bulk/Vendor Return', tone: 'blue',  hint: 'goes to a repair run' },
  { value: 'Loss', label: 'Loss', full: 'Loss / Write-off',  tone: 'red',    hint: 'record what arrived' },
];
const dispDef = (v) => DISPOSITIONS.find((d) => d.value === v) || null;
const BOX_CONDITIONS = ['sealed', 'open', 'damaged', 'destroyed'];
const PRODUCT_CONDITIONS = ['good', 'functional_issues', 'physical_damage', 'missing_parts', 'wrong_product'];

const SHIPMENT_STATUS_COLORS = {
  open: 'var(--yellow)', processing: '#7b93ff', fully_processed: '#4ade80', closed: 'var(--t3)',
};
const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.25)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};
function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{ display: 'inline-block', padding: '2px 6px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}>{label}</span>
  );
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnGreen         = { background: '#22c55e', border: '1px solid #22c55e', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const chipBtn = (tone, active) => {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return { background: active ? s.bg : 'transparent', border: `1px solid ${active ? s.fg : 'var(--border)'}`, color: active ? s.fg : 'var(--t2)', borderRadius: 3, padding: '4px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '.04em' };
};

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
const statusLabel = (s) => (s || '').replace(/_/g, ' ').toUpperCase();
// Normalise legacy lowercase dispositions to the v2 set for display
function normDisp(d) {
  if (!d) return null;
  const up = String(d).toUpperCase();
  if (up === 'UDR') return 'UDR';
  if (up === 'CXR') return 'CXR';
  if (up === 'BRV') return 'BRV';
  if (up === 'LOSS' || up === 'LOSS_DAMAGE' || up === 'LOSS_REJECTION') return 'Loss';
  if (up === 'WKS_REPAIR') return 'CXR';
  return d;
}
const isLegacyPending = (u) => !u.car_upc && (u.intake_source === 'scanner' || /legacy/i.test(u.notes || ''));

export default function ProcessPageWrapper() {
  return (
    <Suspense fallback={<div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}>
      <ProcessPage />
    </Suspense>
  );
}

function ProcessPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { PRODUCTS, loading: productsLoading } = useProducts();

  const shipmentId = searchParams?.get('id') || null;

  const [shipmentData, setShipmentData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Manual log form
  const [mlProduct, setMlProduct] = useState('');
  const [mlBatch, setMlBatch] = useState('');
  const [mlNotes, setMlNotes] = useState('');
  const [mlMsg, setMlMsg] = useState(null);

  // Modals
  const [dispUnit, setDispUnit] = useState(null);   // unit being dispositioned (full modal)
  const [relabelUnit, setRelabelUnit] = useState(null);

  const pollRef = useRef(null);

  const loadShipment = useCallback(async (silent) => {
    if (!session || !shipmentId) { setLoading(false); return; }
    if (!silent) setLoading(true);
    try {
      const data = await garageFetch('getReturnShipment', { id: shipmentId }, session);
      setShipmentData(data && typeof data === 'object' ? data : null);
    } catch (e) {
      if (!silent) showToast(e.message || 'Failed to load shipment', 'error');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [session, shipmentId, showToast]);

  useEffect(() => { loadShipment(false); }, [loadShipment]);

  // Live polling (~4s) — Garage reflects scanner intake without a manual reload.
  const status = shipmentData?.shipment?.status || 'open';
  useEffect(() => {
    if (!shipmentId) return;
    if (status === 'fully_processed' || status === 'closed') return;
    pollRef.current = setInterval(() => loadShipment(true), 4000);
    return () => clearInterval(pollRef.current);
  }, [shipmentId, status, loadShipment]);

  const units = useMemo(() => (Array.isArray(shipmentData?.units) ? shipmentData.units : []), [shipmentData]);
  const counts = useMemo(() => {
    const c = { total: units.length, pending: 0, UDR: 0, CXR: 0, BRV: 0, Loss: 0 };
    units.forEach((u) => {
      const d = normDisp(u.disposition);
      if (!d || u.status === 'pending_inspection') { if (!d) c.pending += 1; }
      if (d && c[d] !== undefined) c[d] += 1;
    });
    return c;
  }, [units]);

  async function setDisposition(unit, disposition, extra = {}) {
    setBusy(true);
    try {
      await workerFetch('setReturnDisposition', {
        data: { return_unit_id: unit.return_unit_id, disposition, ...extra },
      }, session);
      showToast(`${unit.return_unit_id} → ${disposition}`, 'success');
      setDispUnit(null);
      loadShipment(true);
    } catch (e) {
      showToast(e.message || 'Failed to set disposition', 'error');
    } finally {
      setBusy(false);
    }
  }

  function quickDisposition(unit, disposition) {
    if (disposition === 'Loss' || isLegacyPending(unit) || !unit.product) {
      // Loss needs a note; legacy/unresolved needs identity — open the full modal.
      setDispUnit({ ...unit, _preset: disposition });
      return;
    }
    setDisposition(unit, disposition, { box_condition: disposition === 'UDR' ? 'sealed' : 'open' });
  }

  async function submitManual() {
    if (!shipmentId) return;
    if (!mlProduct) { setMlMsg({ ok: false, text: 'Select a product' }); return; }
    setBusy(true); setMlMsg(null);
    try {
      const res = await workerFetch('postReturnUnit', {
        data: { shipment_id: shipmentId, return_category: 'PENDING', product: mlProduct, batch_label: mlBatch || null, notes: mlNotes || null },
      }, session);
      const r = res.data || res;
      setMlMsg({ ok: true, text: `✓ ${r.return_unit_id} logged${r.car_upc ? ' — ' + r.car_upc : ''}` });
      setMlBatch(''); setMlNotes('');
      loadShipment(true);
    } catch (e) {
      setMlMsg({ ok: false, text: e.message || 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  async function closeShipment() {
    setBusy(true);
    try {
      await workerFetch('closeReturnShipment', { data: { shipment_id: shipmentId } }, session);
      showToast(`${shipmentId} closed`, 'success');
      loadShipment(false);
    } catch (e) { showToast(e.message || 'Close failed', 'error'); }
    finally { setBusy(false); }
  }
  async function reopenShipment() {
    setBusy(true);
    try {
      await workerFetch('reopenReturnShipment', { data: { shipment_id: shipmentId } }, session);
      showToast(`${shipmentId} reopened`, 'success');
      loadShipment(false);
    } catch (e) { showToast(e.message || 'Reopen failed', 'error'); }
    finally { setBusy(false); }
  }

  if (perms && !perms.returns) return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;

  if (!shipmentId) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
        Select a shipment from the Shipments tab to start processing units.
        <div style={{ marginTop: 12 }}><button style={btnPrimary} onClick={() => router.push('/returns/shipments')}>Go to Shipments →</button></div>
      </div>
    );
  }
  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const shipment = shipmentData?.shipment;
  if (!shipment) {
    return (
      <div style={{ padding: 24, color: 'var(--t3)' }}>Shipment not found.
        <button style={{ ...btnSecondary, marginLeft: 8 }} onClick={() => router.push('/returns/shipments')}>← Back</button>
      </div>
    );
  }
  const statusColor = SHIPMENT_STATUS_COLORS[status] || 'var(--t3)';
  const closed = status === 'fully_processed' || status === 'closed';

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <button style={btnSecondary} onClick={() => router.push('/returns/shipments')}>← Back to Shipments</button>
        <div style={{ display: 'flex', gap: 6 }}>
          {closed
            ? <button style={btnSecondary} onClick={reopenShipment} disabled={busy}>Reopen</button>
            : <button style={btnGreen} onClick={closeShipment} disabled={busy}>Close Shipment</button>}
        </div>
      </div>

      {/* Header — RS-NNN is the scanner-binding code */}
      <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '14px 18px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
          <div>
            <div style={{ ...labelStyle, marginBottom: 2 }}>Return Shipment</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 800, color: 'var(--yellow)', letterSpacing: '.04em' }}>{shipment.shipment_id}</div>
            <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', marginTop: 2 }}>↳ select / scan this code on the PWA Return Intake station</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--t2)' }}>
            <div>{shipment.courier || shipment.channel_id || '—'}</div>
            <div style={{ color: 'var(--t3)', fontSize: 11 }}>{formatDate(shipment.received_date)}</div>
          </div>
          <div>
            <div style={{ ...labelStyle, marginBottom: 2 }}>Units</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 700 }}>{counts.total}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {counts.pending > 0 && <StatusBadge label={`${counts.pending} pending`} tone="yellow" />}
            {counts.UDR > 0 && <StatusBadge label={`${counts.UDR} UDR`} tone="green" />}
            {counts.CXR > 0 && <StatusBadge label={`${counts.CXR} CXR`} tone="yellow" />}
            {counts.BRV > 0 && <StatusBadge label={`${counts.BRV} BRV`} tone="blue" />}
            {counts.Loss > 0 && <StatusBadge label={`${counts.Loss} Loss`} tone="red" />}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: statusColor, fontWeight: 700 }}>{statusLabel(status)}</div>
          {!closed && <RsQr value={shipment.shipment_id} />}
        </div>
        <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{closed ? 'closed' : 'live · auto-refreshing'}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.85fr) minmax(0, 1.6fr)', gap: 16, alignItems: 'start' }}>
        {/* Manual log (no-scan fallback) */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Log Unit Manually</span></div>
          <div style={panelBodyStyle}>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>Use when nothing is scannable. Scanned units appear automatically below — set their disposition there.</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <span style={labelStyle}>Product *</span>
                <Combobox value={mlProduct} options={PRODUCTS.map((p) => ({ value: p, label: p }))} onChange={setMlProduct} placeholder="Search products…" loading={productsLoading} disabled={busy} />
              </div>
              <div>
                <span style={labelStyle}>Batch / Box Label (optional)</span>
                <input type="text" value={mlBatch} onChange={(e) => setMlBatch(e.target.value)} placeholder="LOT-XXXXXXXX" style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={busy} />
              </div>
              <div>
                <span style={labelStyle}>Notes</span>
                <input type="text" value={mlNotes} onChange={(e) => setMlNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={busy} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
              <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} onClick={submitManual} disabled={busy || closed}>Add Unit</button>
            </div>
            {mlMsg && <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: mlMsg.ok ? '#4ade80' : '#ff7070' }}>{mlMsg.text}</div>}
          </div>
        </div>

        {/* Units list */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Units {counts.total > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({counts.total})</span>}</span>
            <button style={btnSecondary} onClick={() => loadShipment(false)}>↻ Refresh</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {counts.total === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No units yet — scan units on the PWA bound to {shipment.shipment_id}, or log one manually.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>ID</th>
                  <th style={tableThStyle}>Product</th>
                  <th style={tableThStyle}>Identity</th>
                  <th style={tableThStyle}>Disposition</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {units.map((u) => {
                    const d = normDisp(u.disposition);
                    const legacy = isLegacyPending(u);
                    const def = dispDef(d);
                    return (
                      <tr key={u.return_unit_id}>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{u.return_unit_id}</td>
                        <td style={tableTdStyle}>{[u.product, u.model, u.color].filter(Boolean).join(' ') || <span style={{ color: 'var(--t3)' }}>—</span>}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>
                          {u.car_upc ? u.car_upc : legacy ? <span style={{ color: '#ffaa33' }}>legacy — relabel</span> : <span style={{ color: 'var(--t3)' }}>—</span>}
                          {u.remote_upc && <span style={{ color: 'var(--t3)' }}> +R</span>}
                          {u.is_switcheroo && <span style={{ color: '#ff7070' }}> · switch</span>}
                        </td>
                        <td style={tableTdStyle}>
                          {def ? (
                            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                              <StatusBadge label={def.label} tone={def.tone} />
                              {u.issued_at && <span style={{ color: 'var(--t3)', fontSize: 10 }}>issued</span>}
                            </span>
                          ) : (
                            <div style={{ display: 'flex', gap: 4 }}>
                              {DISPOSITIONS.map((dd) => (
                                <button key={dd.value} style={chipBtn(dd.tone, false)} disabled={busy || closed} onClick={() => quickDisposition(u, dd.value)}>{dd.label}</button>
                              ))}
                            </div>
                          )}
                        </td>
                        <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                          {legacy && !u.car_upc && <button style={{ ...btnSecondary, marginRight: 4 }} disabled={busy || closed} onClick={() => setRelabelUnit(u)}>Relabel</button>}
                          {!closed && <button style={btnSecondary} disabled={busy} onClick={() => setDispUnit(u)}>{def ? 'Edit' : 'Details'}</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {dispUnit && (
        <DispositionModal
          unit={dispUnit}
          products={PRODUCTS}
          productsLoading={productsLoading}
          busy={busy}
          onClose={() => !busy && setDispUnit(null)}
          onSubmit={(disposition, extra) => setDisposition(dispUnit, disposition, extra)}
        />
      )}
      {relabelUnit && (
        <RelabelModal
          unit={relabelUnit}
          session={session}
          busy={busy}
          setBusy={setBusy}
          showToast={showToast}
          onDone={() => { setRelabelUnit(null); loadShipment(true); }}
          onClose={() => !busy && setRelabelUnit(null)}
        />
      )}
    </div>
  );
}

function DispositionModal({ unit, products, productsLoading, busy, onClose, onSubmit }) {
  useEscapeClose(true, () => { if (!busy) onClose(); });
  const [disp, setDisp] = useState(normDisp(unit.disposition) || unit._preset || null);
  const [boxCondition, setBoxCondition] = useState(unit.box_condition || (normDisp(unit.disposition) === 'UDR' ? 'sealed' : 'open'));
  const [productCondition, setProductCondition] = useState(unit.product_condition || 'good');
  const [isSwitch, setIsSwitch] = useState(!!unit.is_switcheroo);
  const [receivedNote, setReceivedNote] = useState(unit.received_item_note || '');
  const [lossDesc, setLossDesc] = useState(unit.loss_description || '');
  const [product, setProduct] = useState(unit.product || '');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');

  const needsProduct = !unit.product && !unit.car_upc;
  const isLoss = disp === 'Loss';

  function submit() {
    if (!disp) { setErr('Pick a disposition'); return; }
    if (needsProduct && !product) { setErr('Enter the product'); return; }
    if (isLoss && !(lossDesc.trim() || receivedNote.trim())) { setErr('Record what arrived'); return; }
    const extra = {
      box_condition: boxCondition,
      product_condition: productCondition,
      is_switcheroo: isSwitch,
      received_item_note: receivedNote || null,
      loss_description: isLoss ? (lossDesc || receivedNote) : null,
      notes: notes || null,
    };
    if (needsProduct && product) extra.product = product;
    onSubmit(disp, extra);
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9000, padding: 24, overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 560, maxWidth: 640, width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: 'var(--cond)', fontSize: 16, color: 'var(--yellow)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Set Disposition</h3>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' }}>
              {unit.return_unit_id} · {[unit.product, unit.model, unit.color].filter(Boolean).join(' ') || 'unresolved'} {unit.car_upc ? '· ' + unit.car_upc : ''}
            </div>
          </div>
          <button style={btnSecondary} onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div style={{ ...labelStyle, marginBottom: 6 }}>Disposition *</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
          {DISPOSITIONS.map((d) => {
            const active = disp === d.value;
            const s = TONE_STYLES[d.tone];
            return (
              <div key={d.value} onClick={() => !busy && setDisp(d.value)} style={{ cursor: 'pointer', textAlign: 'center', padding: 10, borderRadius: 4, background: active ? s.bg : 'var(--surface2)', border: `${active ? 2 : 1}px solid ${active ? s.fg : 'var(--border)'}` }}>
                <div style={{ fontFamily: 'var(--cond)', fontWeight: 800, fontSize: 16, color: active ? s.fg : 'var(--t1)' }}>{d.label}</div>
                <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 4, lineHeight: 1.3 }}>{d.full}</div>
              </div>
            );
          })}
        </div>

        {needsProduct && (
          <div style={{ marginBottom: 12 }}>
            <span style={labelStyle}>Product (manual entry) *</span>
            <Combobox value={product} options={products.map((p) => ({ value: p, label: p }))} onChange={setProduct} placeholder="Search products…" loading={productsLoading} disabled={busy} />
          </div>
        )}

        {disp && disp !== 'Loss' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <div>
              <span style={labelStyle}>Box Condition</span>
              <select value={boxCondition} onChange={(e) => setBoxCondition(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={busy}>
                {BOX_CONDITIONS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <span style={labelStyle}>Product Condition</span>
              <select value={productCondition} onChange={(e) => setProductCondition(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={busy}>
                {PRODUCT_CONDITIONS.map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: 'var(--t2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={isSwitch} onChange={(e) => setIsSwitch(e.target.checked)} disabled={busy} />
          Switcheroo / wrong item received
        </label>

        {(isSwitch || isLoss) && (
          <div style={{ marginBottom: 12 }}>
            <span style={labelStyle}>{isLoss ? 'What physically arrived *' : 'What was actually in the box'}</span>
            <textarea value={isLoss ? (lossDesc || receivedNote) : receivedNote} onChange={(e) => { isLoss ? setLossDesc(e.target.value) : setReceivedNote(e.target.value); }} rows={2} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} placeholder="e.g. empty box, a brick, wrong product…" disabled={busy} />
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <span style={labelStyle}>Notes</span>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={busy} />
        </div>

        {disp && disp !== 'Loss' && unit.remote_upc && (
          <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 10, fontFamily: 'var(--mono)' }}>
            {disp === 'UDR' ? 'UDR keeps its car↔remote pairing (sealed box).' : 'Car↔remote pairing will be broken (kept as history) and re-made at repair QC PASS.'}
          </div>
        )}

        <div style={{ minHeight: 16, color: '#ff7070', fontSize: 11, marginBottom: 8, fontFamily: 'var(--mono)' }}>{err || ''}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button style={btnSecondary} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save Disposition'}</button>
        </div>
      </div>
    </div>
  );
}

function RelabelModal({ unit, session, busy, setBusy, showToast, onDone, onClose }) {
  useEscapeClose(true, () => { if (!busy) onClose(); });
  const [channel, setChannel] = useState('E');
  const [printLine, setPrintLine] = useState('D1');
  const [ean, setEan] = useState('');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true); setErr('');
    try {
      const res = await workerFetch('relabelLegacyReturn', {
        data: { return_unit_id: unit.return_unit_id, channel_type: channel, print_line: printLine, ean: ean || null },
      }, session);
      const r = res.data || res;
      setResult(r);
      showToast(`Label printed — ${r.batch_label}`, 'success');
    } catch (e) {
      setErr(e.message || 'Relabel failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9000, padding: 24, overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 460, maxWidth: 520, width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: 'var(--cond)', fontSize: 16, color: 'var(--yellow)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Relabel Legacy Unit</h3>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' }}>{unit.return_unit_id} · {[unit.product, unit.model, unit.color].filter(Boolean).join(' ') || 'unknown product'}</div>
          </div>
          <button style={btnSecondary} onClick={onClose} disabled={busy}>✕</button>
        </div>

        {result ? (
          <div>
            <div style={{ background: 'rgba(34,197,94,.1)', border: '1px solid #4ade80', borderRadius: 4, padding: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>NOTIONAL BOX LABEL (printed to {result.print_line})</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 800, color: '#4ade80', marginTop: 4 }}>{result.batch_label}</div>
              <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 6 }}>Car: {result.car_upc}{result.remote_upc ? ` · Remote: ${result.remote_upc}` : ''}</div>
              <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 6 }}>The box is not opened — apply this label to the sealed box. UPC blocked from future batch printing.</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btnPrimary} onClick={onDone}>Done</button></div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 12 }}>Mints a real LOT label for this sealed legacy box (box stays closed) and queues the print. The minted UPC is blocked from future batch printing.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <span style={labelStyle}>Channel</span>
                <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={busy}>
                  <option value="E">Ecom (E)</option>
                  <option value="R">Retail (R)</option>
                </select>
              </div>
              <div>
                <span style={labelStyle}>Printer Line</span>
                <select value={printLine} onChange={(e) => setPrintLine(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={busy}>
                  {/* S326: was ['D1','D2','L1','L2','L3'] — the L4/L5 printers are live
                      (27,536 print jobs in 90 days) but could not be selected here. */}
                  {['D1', 'D2', ...LINES].map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>
            {!unit.product && (
              <div style={{ marginBottom: 12 }}>
                <span style={labelStyle}>EAN (13-digit, if product unknown)</span>
                <input type="text" value={ean} onChange={(e) => setEan(e.target.value)} placeholder="7435…" style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={busy} />
              </div>
            )}
            <div style={{ minHeight: 16, color: '#ff7070', fontSize: 11, marginBottom: 8, fontFamily: 'var(--mono)' }}>{err || ''}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button style={btnSecondary} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>{busy ? 'Printing…' : 'Mint & Print Label'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
