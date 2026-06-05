'use client';
import { Suspense, useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox, useEscapeClose } from '@throttle/ui';
import { useProducts } from '../../../../hooks/useProducts.js';
import { Package, Wrench, AlertTriangle, Ban } from 'lucide-react';

const RETURN_CATEGORIES = [
  { value: 'UDR', label: 'UDR · Undamaged Return',    tone: 'green'  },
  { value: 'CXR', label: 'CXR · Customer Return',      tone: 'yellow' },
  { value: 'BRV', label: 'BRV · Bulk Return / Vendor', tone: 'blue'   },
];

const DISPOSITIONS = [
  { value: 'udr',            Icon: Package,        title: 'UDR (Undamaged Return)', sub: 'Sealed, intact. Re-enters dispatch stock via PKG_OUT.',       loss: false },
  { value: 'wks_repair',     Icon: Wrench,         title: 'Send to Workshop',       sub: 'Product present, needs inspection or repair.',                loss: false },
  { value: 'loss_damage',    Icon: AlertTriangle,  title: 'Loss · Damage',          sub: 'Beyond repair or destroyed. Raise damage note.',              loss: true  },
  { value: 'loss_rejection', Icon: Ban,            title: 'Loss · Rejection',       sub: 'Switcheroo, empty box, wrong product. Raise rejection note.', loss: true  },
];

const BOX_CONDITIONS = ['sealed', 'open', 'damaged', 'destroyed'];
const PRODUCT_CONDITIONS = ['good', 'functional_issues', 'physical_damage', 'missing_parts', 'wrong_product'];

const SHIPMENT_STATUS_COLORS = {
  open:                'var(--yellow)',
  partially_processed: '#7b93ff',
  fully_processed:     '#4ade80',
  handed_over:         '#4ade80',
  closed:              'var(--t3)',
};

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  orange: { bg: 'rgba(255,140,0,.15)',  fg: '#ffaa33', border: 'rgba(255,140,0,.25)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
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

function categoryTone(cat) {
  return RETURN_CATEGORIES.find((c) => c.value === cat)?.tone || 'gray';
}

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusLabel(s) {
  return (s || '').replace(/_/g, ' ').toUpperCase();
}

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
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);

  // Unit form
  const [category, setCategory] = useState('UDR');
  const [product, setProduct] = useState('');
  const [batchLabel, setBatchLabel] = useState('');
  const [platformId, setPlatformId] = useState('');
  const [unitNotes, setUnitNotes] = useState('');
  const [statusMsg, setStatusMsg] = useState(null);
  const [submittingUnit, setSubmittingUnit] = useState(false);

  // Handover
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverLoading, setHandoverLoading] = useState(false);
  const [handoverErr, setHandoverErr] = useState('');

  // Inspection modal
  const [inspecting, setInspecting] = useState(null);
  const [boxCondition, setBoxCondition] = useState('open');
  const [productPresent, setProductPresent] = useState(true);
  const [productCondition, setProductCondition] = useState('good');
  const [upcFound, setUpcFound] = useState('');
  const [whatFound, setWhatFound] = useState('');
  const [selectedDisp, setSelectedDisp] = useState(null);
  const [lossDesc, setLossDesc] = useState('');
  const [inspNotes, setInspNotes] = useState('');
  const [inspErr, setInspErr] = useState('');
  const [inspSubmitting, setInspSubmitting] = useState(false);

  const loadChannels = useCallback(async () => {
    if (!session) return;
    try {
      const data = await garageFetch('getChannels', {}, session);
      setChannels(Array.isArray(data) ? data : []);
    } catch {
      setChannels([]);
    }
  }, [session]);

  const loadShipment = useCallback(async () => {
    if (!session || !shipmentId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await garageFetch('getReturnShipment', { id: shipmentId }, session);
      setShipmentData(data);
    } catch (e) {
      showToast(e.message || 'Failed to load shipment', 'error');
      setShipmentData(null);
    } finally {
      setLoading(false);
    }
  }, [session, shipmentId, showToast]);

  useEffect(() => { loadChannels(); }, [loadChannels]);
  useEffect(() => { loadShipment(); }, [loadShipment]);

  const channelMap = useMemo(() => {
    const m = {};
    channels.forEach((c) => { m[c.channel_id] = c; });
    return m;
  }, [channels]);

  // Handover summary — group inspected non-loss units by product+disposition.
  // Must run unconditionally on every render (Rules of Hooks), so it sits
  // alongside the other hooks. Self-contained on shipmentData.
  const handoverGroups = useMemo(() => {
    const u = Array.isArray(shipmentData?.units) ? shipmentData.units : [];
    const groups = {};
    u.forEach((row) => {
      if (row.status !== 'inspected') return;
      if (!['udr', 'wks_repair'].includes(row.disposition)) return;
      const key = `${row.product || '—'}|${row.disposition}`;
      if (!groups[key]) groups[key] = { product: row.product || '—', disposition: row.disposition, count: 0 };
      groups[key].count += 1;
    });
    return Object.values(groups);
  }, [shipmentData]);

  function openInspection(unit) {
    setInspecting(unit);
    setInspErr('');
    setInspNotes('');
    setLossDesc('');
    setUpcFound(unit.car_upc || '');
    setWhatFound('');
    if (unit.return_category === 'UDR') {
      setBoxCondition('sealed');
      setProductPresent(true);
      setProductCondition('good');
      setSelectedDisp('udr');
    } else {
      setBoxCondition('open');
      setProductPresent(true);
      setProductCondition('good');
      setSelectedDisp(null);
    }
  }

  function clearUnitForm() {
    setProduct('');
    setBatchLabel('');
    setPlatformId('');
    setUnitNotes('');
  }

  async function submitUnit() {
    if (!shipmentId) return;
    if (!product) { setStatusMsg({ text: 'Select a product', ok: false }); return; }
    setSubmittingUnit(true);
    setStatusMsg(null);
    try {
      const res = await workerFetch('postReturnUnit', {
        data: {
          shipment_id:        shipmentId,
          return_category:    category,
          product,
          batch_label:        batchLabel || null,
          platform_return_id: platformId || null,
          notes:              unitNotes || null,
        },
      }, session);
      const result = res.data || res;
      let msg = `✓ ${result.return_unit_id} logged`;
      if (result.car_upc) msg += ` — Car: ${result.car_upc}`;
      setStatusMsg({ text: msg, ok: true });
      // Keep category + product selected for rapid multi-unit logging of the
      // same product; only clear the per-unit fields. (Piyush, 06-05.)
      setBatchLabel('');
      setPlatformId('');
      setUnitNotes('');
      loadShipment();
    } catch (e) {
      setStatusMsg({ text: e.message || 'Submit failed', ok: false });
    } finally {
      setSubmittingUnit(false);
    }
  }

  async function submitInspection() {
    if (!inspecting) return;
    if (!selectedDisp) { setInspErr('Select a disposition'); return; }
    const dispDef = DISPOSITIONS.find((d) => d.value === selectedDisp);
    const isLoss = !!dispDef?.loss;
    if (isLoss && !lossDesc.trim()) { setInspErr('Loss description required'); return; }
    setInspSubmitting(true);
    setInspErr('');
    try {
      await workerFetch('postReturnInspection', {
        data: {
          return_unit_id:    inspecting.return_unit_id,
          box_condition:     boxCondition,
          product_present:   productPresent,
          product_condition: productPresent ? productCondition : null,
          upc_found:         upcFound || null,
          what_found:        whatFound || null,
          disposition:       selectedDisp,
          loss_description:  isLoss ? lossDesc.trim() : null,
          notes:             inspNotes || null,
        },
      }, session);
      showToast(`Inspection logged — ${selectedDisp.replace(/_/g, ' ')}`, 'success');
      setInspecting(null);
      loadShipment();
    } catch (e) {
      setInspErr(e.message || 'Submit failed');
    } finally {
      setInspSubmitting(false);
    }
  }

  async function confirmHandover() {
    setHandoverLoading(true);
    setHandoverErr('');
    try {
      const res = await workerFetch('postReturnHandover', { data: { shipment_id: shipmentId } }, session);
      const result = res.data || res;
      showToast(`✓ Handed over ${result.units_handed_over || ''} units — ${shipmentId}`, 'success');
      setHandoverOpen(false);
      loadShipment();
    } catch (e) {
      setHandoverErr(e.message || 'Handover failed');
    } finally {
      setHandoverLoading(false);
    }
  }

  if (perms && !perms.returns) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  // No shipment selected
  if (!shipmentId) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
        Select a shipment from the Shipments tab to start processing units.
        <div style={{ marginTop: 12 }}>
          <button style={btnPrimary} onClick={() => router.push('/returns/shipments')}>Go to Shipments →</button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  }

  const shipment = shipmentData?.shipment;
  const units = Array.isArray(shipmentData?.units) ? shipmentData.units : [];

  if (!shipment) {
    return (
      <div style={{ padding: 24, color: 'var(--t3)' }}>
        Shipment not found.
        <button style={{ ...btnSecondary, marginLeft: 8 }} onClick={() => router.push('/returns/shipments')}>← Back</button>
      </div>
    );
  }

  const channelName = channelMap[shipment.channel]?.channel_name || shipment.channel || '—';
  const status = shipment.status || 'open';
  const statusColor = SHIPMENT_STATUS_COLORS[status] || 'var(--t3)';
  const handedOver = ['handed_over', 'closed'].includes(status);
  const canHandover = status === 'fully_processed' && !handedOver;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <button style={btnSecondary} onClick={() => router.push('/returns/shipments')}>← Back to Shipments</button>
      </div>

      {/* Active shipment header */}
      <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '14px 18px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ ...labelStyle, marginBottom: 2 }}>Active Shipment</div>
            <div style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, color: 'var(--yellow)' }}>{shipment.shipment_id}</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--t2)' }}>
            <div>{channelName}</div>
            <div style={{ color: 'var(--t3)', fontSize: 11 }}>{formatDate(shipment.received_date)}</div>
          </div>
          <div>
            <div style={{ ...labelStyle, marginBottom: 2 }}>Units</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700 }}>{units.length}</div>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: statusColor, fontWeight: 700 }}>
            {statusLabel(status)}
          </div>
        </div>
        <div>
          {handedOver ? (
            <StatusBadge label="✓ Handed Over" tone="green" />
          ) : canHandover ? (
            <button style={btnGreen} onClick={() => setHandoverOpen(true)}>Hand Over to Production →</button>
          ) : null}
        </div>
      </div>

      {/* Handover panel */}
      {handoverOpen && !handedOver && (
        <div style={{ ...panelStyle, border: '1px solid #22c55e' }}>
          <div style={{ ...panelHeaderStyle, color: '#4ade80' }}>
            <span>Confirm Handover to Production</span>
            <button style={btnSecondary} onClick={() => setHandoverOpen(false)} disabled={handoverLoading}>Cancel</button>
          </div>
          <div style={panelBodyStyle}>
            <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 10 }}>
              These units will be routed to production and removed from the returns queue.
            </div>
            {handoverGroups.length === 0 ? (
              <div style={{ color: 'var(--t3)', fontSize: 12, fontStyle: 'italic' }}>No non-loss units to hand over.</div>
            ) : (
              <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
                {handoverGroups.map((g) => (
                  <div key={`${g.product}-${g.disposition}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 10px' }}>
                    <div>
                      <strong style={{ fontFamily: 'var(--cond)', fontSize: 13 }}>{g.product}</strong>
                      <span style={{ marginLeft: 8, fontSize: 11, color: g.disposition === 'udr' ? '#4ade80' : '#ffaa33' }}>
                        {g.disposition === 'udr' ? 'UDR' : 'Workshop Repair'}
                      </span>
                    </div>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700 }}>×{g.count}</span>
                  </div>
                ))}
              </div>
            )}
            {handoverErr && <div style={{ color: '#ff7070', fontSize: 11, marginBottom: 8, fontFamily: 'var(--mono)' }}>{handoverErr}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button style={btnSecondary} onClick={() => setHandoverOpen(false)} disabled={handoverLoading}>Cancel</button>
              <button style={btnGreen} onClick={confirmHandover} disabled={handoverLoading}>
                {handoverLoading ? 'Handing over…' : 'Confirm Handover'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)', gap: 16, alignItems: 'start' }}>
        {/* Log unit form */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Log Return Unit</span></div>
          <div style={panelBodyStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <span style={labelStyle}>Return Category *</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submittingUnit}>
                  {RETURN_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <span style={labelStyle}>Product *</span>
                <Combobox
                  value={product}
                  options={PRODUCTS.map((p) => ({ value: p, label: p }))}
                  onChange={(v) => setProduct(v)}
                  placeholder="Search products…"
                  loading={productsLoading}
                  disabled={submittingUnit}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={labelStyle}>Batch Label (optional)</span>
                <input type="text" value={batchLabel} onChange={(e) => setBatchLabel(e.target.value)} placeholder="LOT-XXXXXXXX" style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={submittingUnit} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={labelStyle}>Platform Return ID (optional)</span>
                <input type="text" value={platformId} onChange={(e) => setPlatformId(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submittingUnit} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={labelStyle}>Notes</span>
                <input type="text" value={unitNotes} onChange={(e) => setUnitNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submittingUnit} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
              <button style={btnSecondary} onClick={clearUnitForm} disabled={submittingUnit}>Clear</button>
              <button
                style={{ ...btnPrimary, opacity: submittingUnit ? 0.6 : 1, cursor: submittingUnit ? 'wait' : 'pointer' }}
                onClick={submitUnit}
                disabled={submittingUnit || handedOver}
              >
                {submittingUnit ? 'Adding…' : 'Add Unit'}
              </button>
            </div>
            {statusMsg && (
              <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: statusMsg.ok ? '#4ade80' : '#ff7070' }}>
                {statusMsg.text}
              </div>
            )}
          </div>
        </div>

        {/* Units list */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Units in This Shipment {units.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({units.length})</span>}</span>
            <button style={btnSecondary} onClick={loadShipment}>↻ Refresh</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {units.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No units logged yet</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>ID</th>
                  <th style={tableThStyle}>Category</th>
                  <th style={tableThStyle}>Product</th>
                  <th style={tableThStyle}>Status</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {units.map((u) => {
                    const inspected = u.status === 'inspected';
                    return (
                      <tr key={u.return_unit_id}>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{u.return_unit_id}</td>
                        <td style={tableTdStyle}><StatusBadge label={u.return_category || '—'} tone={categoryTone(u.return_category)} /></td>
                        <td style={tableTdStyle}>{u.product || '—'}</td>
                        <td style={tableTdStyle}>
                          {inspected ? (
                            <span style={{ color: 'var(--t3)', fontSize: 11 }}>Done · {(u.disposition || '').replace(/_/g, ' ')}</span>
                          ) : (
                            <StatusBadge label="Pending" tone="yellow" />
                          )}
                        </td>
                        <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                          {!inspected && !handedOver && (
                            <button style={btnPrimary} onClick={() => openInspection(u)}>Inspect</button>
                          )}
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

      {/* Inspection modal — TOP LEVEL of return */}
      {inspecting && (
        <InspectionModal
          unit={inspecting}
          boxCondition={boxCondition} setBoxCondition={setBoxCondition}
          productPresent={productPresent} setProductPresent={setProductPresent}
          productCondition={productCondition} setProductCondition={setProductCondition}
          upcFound={upcFound} setUpcFound={setUpcFound}
          whatFound={whatFound} setWhatFound={setWhatFound}
          selectedDisp={selectedDisp} setSelectedDisp={setSelectedDisp}
          lossDesc={lossDesc} setLossDesc={setLossDesc}
          inspNotes={inspNotes} setInspNotes={setInspNotes}
          err={inspErr}
          onClose={() => !inspSubmitting && setInspecting(null)}
          onSubmit={submitInspection}
          submitting={inspSubmitting}
        />
      )}
    </div>
  );
}

function InspectionModal(props) {
  const {
    unit, boxCondition, setBoxCondition, productPresent, setProductPresent,
    productCondition, setProductCondition, upcFound, setUpcFound, whatFound, setWhatFound,
    selectedDisp, setSelectedDisp, lossDesc, setLossDesc, inspNotes, setInspNotes,
    err, onClose, onSubmit, submitting,
  } = props;

  useEscapeClose(true, () => { if (!submitting) onClose(); });

  function pickPresent(v) {
    setProductPresent(v);
    if (!v) setSelectedDisp('loss_rejection');
  }

  function dispCardStyle(d) {
    const isSelected = selectedDisp === d.value;
    if (!isSelected) {
      return {
        background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4,
        padding: 12, cursor: 'pointer', textAlign: 'center', transition: 'all .12s',
      };
    }
    if (d.loss) {
      return {
        background: 'rgba(222,42,42,.12)', border: '2px solid #ff7070', borderRadius: 4,
        padding: 11, cursor: 'pointer', textAlign: 'center',
      };
    }
    return {
      background: 'rgba(242,205,26,.12)', border: '2px solid var(--yellow)', borderRadius: 4,
      padding: 11, cursor: 'pointer', textAlign: 'center',
    };
  }

  const dispDef = DISPOSITIONS.find((d) => d.value === selectedDisp);
  const isLoss = !!dispDef?.loss;

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9000, padding: 24, overflowY: 'auto' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 640, maxWidth: 760, width: '100%', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: 'var(--cond)', fontSize: 16, color: 'var(--yellow)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Inspect Return Unit
            </h3>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' }}>
              {unit.return_unit_id} · {unit.product || '—'} · {unit.return_category || '—'}
            </div>
          </div>
          <button style={btnSecondary} onClick={onClose} disabled={submitting}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <span style={labelStyle}>Box Condition</span>
            <select value={boxCondition} onChange={(e) => setBoxCondition(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
              {BOX_CONDITIONS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <span style={labelStyle}>Product Present</span>
            <select
              value={productPresent ? 'yes' : 'no'}
              onChange={(e) => pickPresent(e.target.value === 'yes')}
              style={{ ...selectStyle, width: '100%' }}
              disabled={submitting}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
        </div>

        {productPresent && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <div>
              <span style={labelStyle}>Product Condition</span>
              <select value={productCondition} onChange={(e) => setProductCondition(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                {PRODUCT_CONDITIONS.map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <span style={labelStyle}>UPC Found (optional)</span>
              <input type="text" value={upcFound} onChange={(e) => setUpcFound(e.target.value)} placeholder="LOT-XXXXXXXX" style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={submitting} />
            </div>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <span style={labelStyle}>What Was Found</span>
          <textarea value={whatFound} onChange={(e) => setWhatFound(e.target.value)} rows={2} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} disabled={submitting} />
        </div>

        <div style={{ ...labelStyle, marginBottom: 6 }}>Disposition *</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
          {DISPOSITIONS.map((d) => (
            <div key={d.value} style={dispCardStyle(d)} onClick={() => !submitting && setSelectedDisp(d.value)}>
              <div style={{ color: d.loss && selectedDisp === d.value ? 'var(--state-error-fg)' : selectedDisp === d.value ? 'var(--yellow)' : 'var(--t2)' }}>
                <d.Icon size={24} strokeWidth={1.75} />
              </div>
              <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13, marginTop: 8, letterSpacing: '0.04em', textTransform: 'uppercase', color: d.loss && selectedDisp === d.value ? 'var(--state-error-fg)' : selectedDisp === d.value ? 'var(--yellow)' : 'var(--t1)' }}>
                {d.title}
              </div>
              <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, lineHeight: 1.4 }}>{d.sub}</div>
            </div>
          ))}
        </div>

        {isLoss && (
          <div style={{ marginBottom: 12 }}>
            <span style={labelStyle}>Loss Description *</span>
            <textarea
              value={lossDesc}
              onChange={(e) => setLossDesc(e.target.value)}
              rows={3}
              style={{ ...inputStyle, width: '100%', resize: 'vertical' }}
              placeholder="What exactly is the loss? Photos / serials / condition…"
              disabled={submitting}
            />
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <span style={labelStyle}>Notes</span>
          <input type="text" value={inspNotes} onChange={(e) => setInspNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
        </div>

        <div style={{ minHeight: 16, color: '#ff7070', fontSize: 11, marginBottom: 8, fontFamily: 'var(--mono)' }}>{err || ''}</div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button style={btnSecondary} onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
            onClick={onSubmit}
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : 'Submit Inspection'}
          </button>
        </div>
      </div>
    </div>
  );
}
