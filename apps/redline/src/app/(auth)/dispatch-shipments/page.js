'use client';
import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { ConfirmModal, Spinner, EmptyState, useToast, Panel, Chip, StatusBadge } from '@throttle/ui';
import { useDispatchChannels } from '../../../hooks/useDispatchChannels.js';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${date} ${time}`;
}

const STATUS_VARIANT = {
  draft:     'info',
  packing:   'brand',
  ready:     'warning',
  shipped:   'success',
  cancelled: 'error',
};
const STATUS_ICON = {
  shipped:   '✓',
  cancelled: '✗',
};

function ShipmentStatusBadge({ status }) {
  if (!status) return <StatusBadge variant="neutral">—</StatusBadge>;
  const variant = STATUS_VARIANT[status] || 'neutral';
  const icon = STATUS_ICON[status];
  return <StatusBadge variant={variant} icon={icon}>{status}</StatusBadge>;
}

// Box statuses (open / packed / closed) use the same family but mapped distinctly.
const BOX_STATUS_VARIANT = {
  open:   'warning',
  packed: 'success',
  closed: 'success',
};
function BoxStatusBadge({ status }) {
  if (!status) return <StatusBadge variant="neutral">—</StatusBadge>;
  const variant = BOX_STATUS_VARIANT[status] || 'neutral';
  const icon = (status === 'packed' || status === 'closed') ? '✓' : undefined;
  return <StatusBadge variant={variant} icon={icon}>{status}</StatusBadge>;
}

const CHANNEL_TYPE_STYLE = {
  ecom:   { color: 'var(--blue)',   bg: 'rgba(33,60,226,.15)'  },
  retail: { color: 'var(--yellow)', bg: 'rgba(242,205,26,.1)'  },
  other:  { color: 'var(--t2)',     bg: 'rgba(255,255,255,.06)' },
};

function ChannelTypeBadge({ type }) {
  const t = (type || 'other').toLowerCase();
  const st = CHANNEL_TYPE_STYLE[t] || CHANNEL_TYPE_STYLE.other;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 3,
      letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
      fontFamily: 'var(--mono)', color: st.color, background: st.bg,
    }}>{type || '—'}</span>
  );
}

// ── Common styles ────────────────────────────────────────────
// Secondary / utility button (modal close, +Add row, Cancel) — per design system.
const btnStyle = { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '0.04em', outline: 'none' };
// Primary CTA — yellow, uppercase Tomorrow.
const primaryBtnStyle = { padding: '8px 14px', background: 'var(--yellow)', color: '#0a0a0a', border: '1px solid var(--yellow)', borderRadius: 3, fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const inputStyle = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' };
const selectStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t1)', fontSize: 13, fontFamily: 'var(--mono)', padding: '8px 12px', borderRadius: 3, outline: 'none' };
const labelStyle = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6 };

// ── Shipments Page ────────────────────────────────────────────
export default function DispatchShipmentsPage() {
  const { session, user } = useAuth();
  const { showToast } = useToast();
  const { channels } = useDispatchChannels(session);

  const [shipments,    setShipments]    = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [statusFilter, setStatusFilter] = useState('');

  // Detail panel
  const [detailShipment, setDetailShipment] = useState(null);
  const [detailBoxes,    setDetailBoxes]    = useState([]);
  const [detailLines,    setDetailLines]    = useState([]);
  const [detailLoading,  setDetailLoading]  = useState(false);
  const [expandedBoxes,  setExpandedBoxes]  = useState(new Set());
  const [boxUnitsCache,  setBoxUnitsCache]  = useState({});
  const [addBoxCount,    setAddBoxCount]    = useState(1);

  // Product codes cache
  const [productCodes, setProductCodes] = useState({});
  const [codesLoaded,  setCodesLoaded]  = useState(false);

  // Confirm modal
  const [confirmModal, setConfirmModal] = useState(null);

  // Create form
  const [createOpen,      setCreateOpen]      = useState(false);
  const [createChannelId, setCreateChannelId] = useState('');
  const [createTitle,     setCreateTitle]     = useState('');
  const [createDate,      setCreateDate]      = useState('');
  const [createNotes,     setCreateNotes]     = useState('');
  const [createWarehouse, setCreateWarehouse] = useState('');
  const [createLines,     setCreateLines]     = useState([]);
  const [createProduct,   setCreateProduct]   = useState('');
  const [createLoading,   setCreateLoading]   = useState(false);
  const [createError,     setCreateError]     = useState('');

  // Edit form
  const [editOpen,     setEditOpen]     = useState(false);
  const [editShipment, setEditShipment] = useState(null);
  const [editTitle,    setEditTitle]    = useState('');
  const [editDate,     setEditDate]     = useState('');
  const [editNotes,    setEditNotes]    = useState('');
  const [editLines,    setEditLines]    = useState([]);
  const [editLoading,  setEditLoading]  = useState(false);
  const [editError,    setEditError]    = useState('');
  const [editProduct,  setEditProduct]  = useState('');

  // ── Loaders ───────────────────────────────────────────────
  const loadShipments = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = statusFilter ? { status: statusFilter } : {};
      const data = await garageFetch('getDispatchShipments', params, session);
      setShipments(Array.isArray(data) ? data : []);
    } catch (_) {
      setShipments([]);
    } finally {
      setLoading(false);
    }
  }, [session, statusFilter]);

  useEffect(() => { loadShipments(); }, [loadShipments]);

  async function ensureProductCodes() {
    if (codesLoaded) return;
    try {
      const data = await garageFetch('getProductCodes', {}, session);
      const grouped = {};
      for (const row of (data || [])) {
        if (!grouped[row.product]) grouped[row.product] = [];
        grouped[row.product].push({
          model: row.model || null,
          color: row.color || null,
          label: [row.model, row.color].filter(Boolean).join(' ') || row.product,
        });
      }
      setProductCodes(grouped);
      setCodesLoaded(true);
    } catch (_) {}
  }

  // ── Detail panel ──────────────────────────────────────────
  async function openDetail(shipment) {
    setDetailShipment(shipment);
    setExpandedBoxes(new Set());
    setBoxUnitsCache({});
    setDetailLoading(true);
    try {
      const [boxes, lines] = await Promise.all([
        garageFetch('getShipmentBoxes', { shipment_id: shipment.id }, session),
        garageFetch('getShipmentLines', { shipment_id: shipment.id }, session),
      ]);
      setDetailBoxes(Array.isArray(boxes) ? boxes : []);
      setDetailLines(Array.isArray(lines) ? lines : []);
    } catch (_) {
      setDetailBoxes([]); setDetailLines([]);
    } finally {
      setDetailLoading(false);
    }
  }

  async function refreshDetail() {
    if (!detailShipment) return;
    setDetailLoading(true);
    try {
      const [shpData, boxes, lines] = await Promise.all([
        garageFetch('getDispatchShipments', {}, session),
        garageFetch('getShipmentBoxes', { shipment_id: detailShipment.id }, session),
        garageFetch('getShipmentLines', { shipment_id: detailShipment.id }, session),
      ]);
      const updated = Array.isArray(shpData) ? shpData.find(s => s.id === detailShipment.id) : null;
      if (updated) setDetailShipment(updated);
      setDetailBoxes(Array.isArray(boxes) ? boxes : []);
      setDetailLines(Array.isArray(lines) ? lines : []);
    } catch (_) {} finally {
      setDetailLoading(false);
    }
  }

  async function toggleBoxUnits(boxId) {
    if (expandedBoxes.has(boxId)) {
      setExpandedBoxes(prev => { const n = new Set(prev); n.delete(boxId); return n; });
      return;
    }
    setExpandedBoxes(prev => new Set([...prev, boxId]));
    if (boxUnitsCache[boxId]) return;
    try {
      const data = await garageFetch('getBoxDetail', { box_id: boxId }, session);
      setBoxUnitsCache(prev => ({ ...prev, [boxId]: (data?.units || []).filter(u => u.is_active) }));
    } catch (_) {
      setBoxUnitsCache(prev => ({ ...prev, [boxId]: [] }));
    }
  }

  // ── Mutations ─────────────────────────────────────────────
  function confirmMarkShipped(s) {
    setConfirmModal({
      title: `Mark ${s.shipment_no} as shipped?`,
      message: 'This will update all units in this shipment to Shipped.',
      confirmLabel: 'Mark Shipped',
      confirmColor: 'var(--green)',
      onConfirm: async () => {
        try {
          await workerFetch('markShipmentShipped', { shipment_id: s.id }, session);
          showToast(`${s.shipment_no} marked as shipped`, 'success');
          setDetailShipment(null);
          loadShipments();
        } catch (e) { showToast(e.message || 'Failed', 'error'); }
      },
    });
  }

  function confirmCancel(s) {
    setConfirmModal({
      title: `Cancel ${s.shipment_no}?`,
      message: 'Allocated units will return to the dispatch pool. This cannot be undone.',
      confirmLabel: 'Cancel Shipment',
      confirmColor: 'red',
      onConfirm: async () => {
        try {
          await workerFetch('cancelShipment', { shipment_id: s.id }, session);
          showToast(`${s.shipment_no} cancelled`, 'success');
          setDetailShipment(null);
          loadShipments();
        } catch (e) { showToast(e.message || 'Failed', 'error'); }
      },
    });
  }

  function confirmDelete(s) {
    setConfirmModal({
      title: `Delete ${s.shipment_no}?`,
      message: 'Draft shipments can be deleted permanently. This cannot be undone.',
      confirmLabel: 'Delete',
      confirmColor: 'red',
      onConfirm: async () => {
        try {
          await workerFetch('deleteShipment', { shipment_id: s.id }, session);
          showToast(`${s.shipment_no} deleted`, 'success');
          setDetailShipment(null);
          loadShipments();
        } catch (e) { showToast(e.message || 'Failed', 'error'); }
      },
    });
  }

  async function addBoxes(shipmentId, count) {
    const n = Math.max(1, parseInt(count, 10) || 1);
    try {
      const res = await workerFetch('createBoxes', { shipment_id: shipmentId, count: n }, session);
      const r = res?.data || res;
      const created = r?.created ?? n;
      showToast(`${created} box${created !== 1 ? 'es' : ''} added`, 'success');
      setAddBoxCount(1);
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  function confirmDeleteBox(box) {
    setConfirmModal({
      title: `Delete ${box.box_ref || 'box'}?`,
      message: 'Empty open boxes can be removed.',
      confirmLabel: 'Delete Box',
      confirmColor: 'red',
      onConfirm: async () => {
        try {
          await workerFetch('deleteBox', { box_id: box.id }, session);
          showToast('Box deleted', 'success');
          await refreshDetail();
        } catch (e) { showToast(e.message || 'Failed', 'error'); }
      },
    });
  }

  async function reopenBox(boxId) {
    try {
      await workerFetch('reopenBox', { box_id: boxId }, session);
      showToast('Box reopened', 'success');
      setBoxUnitsCache(prev => { const n = { ...prev }; delete n[boxId]; return n; });
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  async function reprintBox(boxId) {
    try {
      await workerFetch('reprintBoxLabel', { box_id: boxId }, session);
      showToast('Label sent to printer', 'success');
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  function confirmRemoveUnit(boxUnitId, boxId, label) {
    setConfirmModal({
      title: `Remove unit ${label || ''}?`,
      message: 'The unit returns to the dispatch pool.',
      confirmLabel: 'Remove',
      confirmColor: 'red',
      onConfirm: async () => {
        try {
          await workerFetch('removeBoxUnit', { box_unit_id: boxUnitId, removed_by: user?.email || null }, session);
          showToast('Unit removed', 'success');
          setBoxUnitsCache(prev => { const n = { ...prev }; delete n[boxId]; return n; });
          await refreshDetail();
        } catch (e) { showToast(e.message || 'Failed', 'error'); }
      },
    });
  }

  // ── Create form helpers ───────────────────────────────────
  function resetCreateForm() {
    setCreateChannelId(''); setCreateTitle(''); setCreateDate(''); setCreateNotes('');
    setCreateWarehouse(''); setCreateLines([]); setCreateProduct(''); setCreateError('');
  }

  function openCreate() {
    resetCreateForm();
    setCreateOpen(true);
    ensureProductCodes();
  }

  function addCreateLine(product) {
    if (!product || !productCodes[product]) return;
    if (createLines.find(l => l.product === product)) return;
    const variants = productCodes[product];
    setCreateLines(prev => [
      ...prev,
      ...variants.map(v => ({ product, model: v.model, color: v.color, label: v.label, qty: 0 })),
    ]);
    setCreateProduct('');
  }

  function updateCreateLineQty(idx, qty) {
    setCreateLines(prev => prev.map((l, i) => i === idx ? { ...l, qty: Math.max(0, parseInt(qty, 10) || 0) } : l));
  }

  function removeCreateProduct(product) {
    setCreateLines(prev => prev.filter(l => l.product !== product));
  }

  async function submitCreate() {
    if (!createChannelId) { setCreateError('Select a channel'); return; }
    const lines = createLines.filter(l => l.qty > 0).map(l => ({
      product: l.product, model: l.model, color: l.color, target_qty: l.qty,
    }));
    if (!lines.length) { setCreateError('Enter at least one quantity'); return; }
    setCreateLoading(true); setCreateError('');
    try {
      const res = await workerFetch('createShipment', {
        channel_id:            createChannelId,
        title:                 createTitle     || null,
        destination_warehouse: createWarehouse || null,
        scheduled_date:        createDate      || null,
        notes:                 createNotes     || null,
        lines,
      }, session);
      const r = res?.data || res;
      showToast(`${r?.shipment_no || 'Shipment'} created`, 'success');
      setCreateOpen(false);
      resetCreateForm();
      loadShipments();
    } catch (e) {
      setCreateError(e.message || 'Failed to create');
    } finally {
      setCreateLoading(false);
    }
  }

  // ── Edit form helpers ─────────────────────────────────────
  function openEdit(s) {
    setEditShipment(s);
    setEditTitle(s.title || '');
    setEditDate(s.scheduled_date || '');
    setEditNotes(s.notes || '');
    setEditError('');
    setEditOpen(true);
    setEditProduct('');
    ensureProductCodes();
    // Load existing manifest lines
    (async () => {
      try {
        const lines = await garageFetch('getShipmentLines', { shipment_id: s.id }, session);
        const arr = (Array.isArray(lines) ? lines : []).map(l => ({
          product: l.product, model: l.model, color: l.color,
          label: [l.model, l.color].filter(Boolean).join(' ') || l.product,
          target_qty: l.target_qty || 0,
          packed_qty: l.packed_qty || 0,
        }));
        setEditLines(arr);
      } catch (_) {
        setEditLines([]);
      }
    })();
  }

  function addEditLine(product) {
    if (!product || !productCodes[product]) return;
    const existingProducts = new Set(editLines.map(l => l.product));
    if (existingProducts.has(product)) return;
    const variants = productCodes[product];
    setEditLines(prev => [
      ...prev,
      ...variants.map(v => ({ product, model: v.model, color: v.color, label: v.label, target_qty: 0, packed_qty: 0 })),
    ]);
    setEditProduct('');
  }

  function updateEditLineQty(idx, qty) {
    setEditLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const min = l.packed_qty || 0;
      const v = Math.max(min, parseInt(qty, 10) || 0);
      return { ...l, target_qty: v };
    }));
  }

  function removeEditProduct(product) {
    setEditLines(prev => prev.filter(l => l.product !== product || (l.packed_qty || 0) > 0));
  }

  async function submitEdit() {
    if (!editShipment) return;
    setEditLoading(true); setEditError('');
    try {
      const lines = editLines.map(l => ({
        product: l.product, model: l.model, color: l.color,
        target_qty: l.target_qty,
        packed_qty: l.packed_qty,
      }));
      await Promise.all([
        workerFetch('updateShipment', {
          shipment_id: editShipment.id,
          title: editTitle || null,
          scheduled_date: editDate || null,
          notes: editNotes || null,
        }, session),
        workerFetch('updateShipmentLines', { shipment_id: editShipment.id, lines }, session),
      ]);
      showToast(`${editShipment.shipment_no} updated`, 'success');
      setEditOpen(false);
      setEditShipment(null);
      loadShipments();
      if (detailShipment?.id === editShipment.id) refreshDetail();
    } catch (e) {
      setEditError(e.message || 'Failed to update');
    } finally {
      setEditLoading(false);
    }
  }

  // ── Style helpers ─────────────────────────────────────────
  const sectionLabel = { margin: 0, fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 12 };
  const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };
  const actionBtn = (color) => ({
    padding: '4px 10px',
    background: 'transparent',
    border: `1px solid ${color}`,
    borderRadius: 3,
    color,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    marginRight: 4,
  });

  // Manifest line groups (by product) for create form
  const createGroups = {};
  for (const l of createLines) {
    if (!createGroups[l.product]) createGroups[l.product] = [];
    createGroups[l.product].push(l);
  }
  const createTotal = createLines.reduce((s, l) => s + (l.qty || 0), 0);

  const editGroups = {};
  for (const l of editLines) {
    if (!editGroups[l.product]) editGroups[l.product] = [];
    editGroups[l.product].push(l);
  }
  const editTargetTotal = editLines.reduce((s, l) => s + (l.target_qty || 0), 0);
  const editPackedTotal = editLines.reduce((s, l) => s + (l.packed_qty || 0), 0);

  const productOptions = Object.keys(productCodes).sort();

  // For create — compute selected channel
  const selectedChannel = channels.find(c => c.id === createChannelId);
  const isBulk = selectedChannel?.fulfillment_model === 'bulk';

  return (
    <>
      {/* Confirm Modal */}
      <ConfirmModal
        open={!!confirmModal}
        onClose={() => setConfirmModal(null)}
        title={confirmModal?.title}
        confirmLabel={confirmModal?.confirmLabel || 'Confirm'}
        confirmColor={confirmModal?.confirmColor}
        onConfirm={() => {
          const m = confirmModal;
          setConfirmModal(null);
          m?.onConfirm?.();
        }}
        message={confirmModal?.message}
      />

      {/* Create panel */}
      {createOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={(e) => { if (e.target === e.currentTarget) setCreateOpen(false); }}
        >
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, width: 640, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontFamily: 'var(--cond)', fontSize: 14, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--yellow)' }}>
                New Shipment
              </div>
              <div style={{ flex: 1 }} />
              <button onClick={() => setCreateOpen(false)} style={btnStyle}>× Close</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>Title (optional)</label>
                <input style={{ ...inputStyle, width: '100%' }} value={createTitle} onChange={e => setCreateTitle(e.target.value)} placeholder="e.g. Amazon Mar wk-3" />
              </div>
              <div>
                <label style={labelStyle}>Channel <span style={{ color: 'var(--red)' }}>*</span></label>
                <select style={{ ...selectStyle, width: '100%' }} value={createChannelId} onChange={e => setCreateChannelId(e.target.value)}>
                  <option value="">Select channel…</option>
                  {channels.filter(c => c.is_active !== false).map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                  ))}
                </select>
              </div>
            </div>

            {isBulk && (
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Destination Warehouse</label>
                <input style={{ ...inputStyle, width: '100%' }} value={createWarehouse} onChange={e => setCreateWarehouse(e.target.value)} placeholder="e.g. BOM Bulk" />
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>Scheduled Date</label>
                <input type="date" style={{ ...inputStyle, width: '100%' }} value={createDate} onChange={e => setCreateDate(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Notes</label>
                <input style={{ ...inputStyle, width: '100%' }} value={createNotes} onChange={e => setCreateNotes(e.target.value)} placeholder="Internal notes" />
              </div>
            </div>

            {/* Manifest */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ ...sectionLabel, marginBottom: 0 }}>Manifest</div>
                <div style={{ flex: 1 }} />
                <select style={selectStyle} value={createProduct} onChange={e => setCreateProduct(e.target.value)}>
                  <option value="">{productOptions.length ? 'Select product…' : 'Loading products…'}</option>
                  {productOptions.filter(p => !createGroups[p]).map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <button style={btnStyle} onClick={() => addCreateLine(createProduct)} disabled={!createProduct}>+ Add</button>
              </div>

              {Object.keys(createGroups).length === 0 ? (
                <div style={{ padding: '14px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  No products yet — add one above
                </div>
              ) : (
                Object.entries(createGroups).map(([product, group]) => (
                  <div key={product} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 10, marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)' }}>{product}</span>
                      <div style={{ flex: 1 }} />
                      <button onClick={() => removeCreateProduct(product)} style={{ ...btnStyle, color: 'var(--red)', borderColor: 'var(--red)' }}>× Remove</button>
                    </div>
                    {group.map((l) => {
                      const idx = createLines.findIndex(x => x.product === l.product && x.model === l.model && x.color === l.color);
                      return (
                        <div key={`${l.product}-${l.model}-${l.color}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: 'var(--t2)', flex: 1 }}>{l.label}</span>
                          <input
                            type="number" min={0}
                            value={l.qty}
                            onChange={e => updateCreateLineQty(idx, e.target.value)}
                            style={{ ...inputStyle, width: 80, textAlign: 'right' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))
              )}

              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)' }}>
                Total: <span style={{ color: 'var(--yellow)', fontWeight: 700 }}>{fmt(createTotal)}</span> units
              </div>
            </div>

            {createError && (
              <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 12, fontFamily: 'var(--mono)' }}>{createError}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setCreateOpen(false)} style={btnStyle} disabled={createLoading}>Cancel</button>
              <button
                onClick={submitCreate}
                disabled={createLoading}
                style={{ ...primaryBtnStyle, opacity: createLoading ? 0.5 : 1 }}
              >
                {createLoading ? 'Creating…' : 'Create Shipment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit panel */}
      {editOpen && editShipment && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditOpen(false); }}
        >
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, width: 640, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontFamily: 'var(--cond)', fontSize: 14, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--yellow)' }}>
                Edit {editShipment.shipment_no}
              </div>
              <div style={{ flex: 1 }} />
              <button onClick={() => setEditOpen(false)} style={btnStyle}>× Close</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>Title</label>
                <input style={{ ...inputStyle, width: '100%' }} value={editTitle} onChange={e => setEditTitle(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Scheduled Date</label>
                <input type="date" style={{ ...inputStyle, width: '100%' }} value={editDate} onChange={e => setEditDate(e.target.value)} />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Notes</label>
              <input style={{ ...inputStyle, width: '100%' }} value={editNotes} onChange={e => setEditNotes(e.target.value)} />
            </div>

            {/* Manifest */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ ...sectionLabel, marginBottom: 0 }}>Manifest</div>
                <div style={{ flex: 1 }} />
                <select style={selectStyle} value={editProduct} onChange={e => setEditProduct(e.target.value)}>
                  <option value="">{productOptions.length ? 'Add product…' : 'Loading…'}</option>
                  {productOptions.filter(p => !editGroups[p]).map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <button style={btnStyle} onClick={() => addEditLine(editProduct)} disabled={!editProduct}>+ Add</button>
              </div>

              {Object.entries(editGroups).map(([product, group]) => {
                const groupPacked = group.reduce((s, l) => s + (l.packed_qty || 0), 0);
                return (
                  <div key={product} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 10, marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)' }}>{product}</span>
                      <div style={{ flex: 1 }} />
                      {groupPacked === 0 && (
                        <button onClick={() => removeEditProduct(product)} style={{ ...btnStyle, color: 'var(--red)', borderColor: 'var(--red)' }}>× Remove</button>
                      )}
                    </div>
                    {group.map((l) => {
                      const idx = editLines.findIndex(x => x.product === l.product && x.model === l.model && x.color === l.color);
                      return (
                        <div key={`${l.product}-${l.model}-${l.color}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: 'var(--t2)', flex: 1 }}>{l.label}</span>
                          <span style={{ fontSize: 10, color: 'var(--t3)', minWidth: 80, textAlign: 'right' }}>packed {fmt(l.packed_qty)}</span>
                          <input
                            type="number" min={l.packed_qty || 0}
                            value={l.target_qty}
                            onChange={e => updateEditLineQty(idx, e.target.value)}
                            style={{ ...inputStyle, width: 80, textAlign: 'right' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)' }}>
                Target: <span style={{ color: 'var(--yellow)', fontWeight: 700 }}>{fmt(editTargetTotal)}</span>
                {' · '}
                Packed: <span style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(editPackedTotal)}</span>
              </div>
            </div>

            {editError && (
              <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 12, fontFamily: 'var(--mono)' }}>{editError}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setEditOpen(false)} style={btnStyle} disabled={editLoading}>Cancel</button>
              <button
                onClick={submitEdit}
                disabled={editLoading}
                style={{ ...primaryBtnStyle, opacity: editLoading ? 0.5 : 1 }}
              >
                {editLoading ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page content */}
      <div>
        {/* Filter bar + Create */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <Chip active={statusFilter === ''}          onClick={() => setStatusFilter('')}>All</Chip>
          <Chip active={statusFilter === 'draft'}     onClick={() => setStatusFilter('draft')}>Draft</Chip>
          <Chip active={statusFilter === 'packing'}   onClick={() => setStatusFilter('packing')}>Packing</Chip>
          <Chip active={statusFilter === 'ready'}     onClick={() => setStatusFilter('ready')}>Ready</Chip>
          <Chip active={statusFilter === 'shipped'}   onClick={() => setStatusFilter('shipped')}>Shipped</Chip>
          <Chip active={statusFilter === 'cancelled'} onClick={() => setStatusFilter('cancelled')}>Cancelled</Chip>
          <div style={{ flex: 1 }} />
          <button style={primaryBtnStyle} onClick={openCreate}>
            + New Shipment
          </button>
        </div>

        {/* Shipments table */}
        <Panel padding={0}>
          {loading ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : shipments.length === 0 ? (
            <EmptyState icon="📤" message="No shipments" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Ref','Title','Channel','Pool / Target','Packed','Scheduled','Status','Actions'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shipments.map(s => {
                    const isOpen = detailShipment?.id === s.id;
                    const ch = s.dispatch_channels;
                    const ready = s.is_ready && s.status !== 'shipped';
                    return (
                      <tr
                        key={s.id}
                        onClick={() => isOpen ? setDetailShipment(null) : openDetail(s)}
                        style={{ cursor: 'pointer', background: isOpen ? 'var(--surface2)' : undefined }}
                      >
                        <td style={{ ...tdStyle, color: 'var(--yellow)' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {s.shipment_no}
                            {ready && <StatusBadge variant="success" icon="✓">Ready</StatusBadge>}
                          </span>
                        </td>
                        <td style={tdStyle}>{s.title || '—'}</td>
                        <td style={tdStyle}>
                          {ch ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <span>{ch.name}</span>
                              <ChannelTypeBadge type={ch.type} />
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--t2)' }}>
                          {fmt(s.pool_count)} / {fmt(s.expected_units)}
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--green)' }}>{fmt(s.packed_count)}</td>
                        <td style={{ ...tdStyle, color: 'var(--t3)' }}>{formatDate(s.scheduled_date)}</td>
                        <td style={tdStyle}><ShipmentStatusBadge status={s.status} /></td>
                        <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                          {!['shipped','cancelled'].includes(s.status) && (
                            <button onClick={(e) => { e.stopPropagation(); confirmMarkShipped(s); }} style={actionBtn('var(--green)')}>Shipped</button>
                          )}
                          {['draft','packing'].includes(s.status) && (
                            <button onClick={(e) => { e.stopPropagation(); openEdit(s); }} style={actionBtn('var(--yellow)')}>Edit</button>
                          )}
                          {['draft','packing'].includes(s.status) && (
                            <button onClick={(e) => { e.stopPropagation(); confirmCancel(s); }} style={actionBtn('var(--orange)')}>Cancel</button>
                          )}
                          {s.status === 'draft' && (
                            <button onClick={(e) => { e.stopPropagation(); confirmDelete(s); }} style={actionBtn('var(--red)')}>Delete</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Detail Panel — modal overlay */}
        {detailShipment && (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
            onClick={(e) => { if (e.target === e.currentTarget) setDetailShipment(null); }}
          >
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 16, width: 800, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 14, fontWeight: 700 }}>{detailShipment.shipment_no}</span>
              <ShipmentStatusBadge status={detailShipment.status} />
              {detailShipment.title && <span style={{ color: 'var(--t2)', fontSize: 12 }}>· {detailShipment.title}</span>}
              <div style={{ flex: 1 }} />
              {detailLoading && <Spinner size="sm" />}
              <button onClick={() => setDetailShipment(null)} style={btnStyle}>× Close</button>
            </div>

            {/* Meta cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 18 }}>
              <MetaCard label="Channel"   value={detailShipment.dispatch_channels?.name || '—'}   sub={detailShipment.dispatch_channels?.type} />
              <MetaCard label="Pool / Target" value={`${fmt(detailShipment.pool_count)} / ${fmt(detailShipment.expected_units)}`} />
              <MetaCard label="Packed"    value={fmt(detailShipment.packed_count)} sub={`of ${fmt(detailShipment.expected_units)}`} />
              <MetaCard label="Scheduled" value={formatDate(detailShipment.scheduled_date)} />
            </div>

            {/* Manifest */}
            <div style={{ marginBottom: 18 }}>
              <div style={sectionLabel}>Manifest</div>
              {detailLines.length === 0 ? (
                <div style={{ padding: '14px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 11 }}>No lines</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Product','Target','Packed','Progress'].map(h => <th key={h} style={thStyle}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {detailLines.map((l, i) => {
                      const pct = l.target_qty > 0 ? Math.min(100, Math.round((l.packed_qty || 0) * 100 / l.target_qty)) : 0;
                      return (
                        <tr key={`${l.product}-${l.model}-${l.color}-${i}`}>
                          <td style={{ ...tdStyle, color: 'var(--t1)' }}>
                            {l.product}
                            {(l.model || l.color) && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>{[l.model, l.color].filter(Boolean).join(' ')}</span>}
                          </td>
                          <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(l.target_qty)}</td>
                          <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: pct === 100 ? 'var(--green)' : 'var(--yellow)' }}>{fmt(l.packed_qty)}</td>
                          <td style={tdStyle}>
                            <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', minWidth: 120 }}>
                              <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--green)' : 'var(--yellow)', transition: 'width .3s' }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Boxes */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <div style={{ ...sectionLabel, marginBottom: 0 }}>Boxes ({detailBoxes.length})</div>
                <div style={{ flex: 1 }} />
                {!['shipped','cancelled'].includes(detailShipment.status) && (
                  <>
                    <input
                      type="number" min={1}
                      value={addBoxCount}
                      onChange={e => setAddBoxCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      style={{ ...inputStyle, width: 60, textAlign: 'right', padding: '4px 6px' }}
                    />
                    <button onClick={() => addBoxes(detailShipment.id, addBoxCount)} style={btnStyle}>+ Add Boxes</button>
                  </>
                )}
              </div>
              {detailBoxes.length === 0 ? (
                <div style={{ padding: '14px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 11 }}>No boxes yet</div>
              ) : (
                detailBoxes.map(box => {
                  const expanded = expandedBoxes.has(box.id);
                  const units = boxUnitsCache[box.id];
                  const isPacked = box.status === 'packed' || box.status === 'closed';
                  return (
                    <div key={box.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 8 }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer' }}
                        onClick={() => toggleBoxUnits(box.id)}
                      >
                        <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{expanded ? '▼' : '▶'}</span>
                        <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 12, fontWeight: 700 }}>{box.box_ref || `Box ${box.id}`}</span>
                        <span style={{ fontSize: 11, color: 'var(--t2)' }}>{fmt(box.unit_count)} units</span>
                        <BoxStatusBadge status={box.status} />
                        <div style={{ flex: 1 }} />
                        {isPacked && (
                          <>
                            <button onClick={(e) => { e.stopPropagation(); reprintBox(box.id); }} style={actionBtn('var(--blue)')}>Reprint</button>
                            <button onClick={(e) => { e.stopPropagation(); reopenBox(box.id); }} style={actionBtn('var(--orange)')}>Reopen</button>
                          </>
                        )}
                        {!isPacked && (box.unit_count || 0) === 0 && (
                          <button onClick={(e) => { e.stopPropagation(); confirmDeleteBox(box); }} style={actionBtn('var(--red)')}>× Remove</button>
                        )}
                      </div>
                      {expanded && (
                        <div style={{ borderTop: '1px solid var(--border)', padding: 8 }}>
                          {units == null ? (
                            <div style={{ padding: 8, color: 'var(--t3)', fontSize: 11 }}>Loading units…</div>
                          ) : units.length === 0 ? (
                            <div style={{ padding: 8, color: 'var(--t3)', fontSize: 11 }}>No active units</div>
                          ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                              <thead>
                                <tr>
                                  {['Batch','Product','Added',''].map(h => <th key={h} style={{ ...thStyle, padding: '6px 10px' }}>{h}</th>)}
                                </tr>
                              </thead>
                              <tbody>
                                {units.map(u => (
                                  <tr key={u.id}>
                                    <td style={{ ...tdStyle, padding: '6px 10px', fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{u.batch_label || '—'}</td>
                                    <td style={{ ...tdStyle, padding: '6px 10px' }}>{u.product || '—'}{(u.model || u.color) && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>{[u.model, u.color].filter(Boolean).join(' ')}</span>}</td>
                                    <td style={{ ...tdStyle, padding: '6px 10px', fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatDateTime(u.added_at)}</td>
                                    <td style={{ ...tdStyle, padding: '6px 10px' }}>
                                      {!isPacked && (
                                        <button onClick={() => confirmRemoveUnit(u.id, box.id, u.batch_label)} style={actionBtn('var(--red)')}>× Remove</button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          </div>
        )}
      </div>
    </>
  );
}

function MetaCard({ label, value, sub }) {
  return (
    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: 10 }}>
      <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--t1)', fontFamily: 'var(--mono)', fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
