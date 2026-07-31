'use client';
/* ════════════════════════════════════════════════════════════
   DISPATCH › SHIPMENTS — Pit Wall v2 reskin (prototype:
   redesign-reference/app/shipments.jsx). Same APIs + mutations:
   getDispatchShipments / getShipmentBoxes / getShipmentLines /
   getBoxDetail reads; createShipment / updateShipment /
   updateShipmentLines / markShipmentShipped / cancelShipment /
   deleteShipment / createBoxes / deleteBox / reopenBox /
   reprintBoxLabel / removeBoxUnit mutations — all unchanged.
   Detail moved from a centered overlay to the kit Drawer.
   Tracking & delivery (courier / AWB / link / expected + actual
   delivery) editable in the drawer via updateShipmentTracking —
   surfaced to Snorkel on the sales order (Snorkel↔Depot fulfilment).
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { ConfirmModal, Modal, Spinner, useToast, useEscapeClose } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import { useDispatchChannels } from '../../../hooks/useDispatchChannels.js';
import {
  Icon, Panel, FilterChip, ToneBadge, Drawer,
  btnPrimary, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

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

// Status → kit tone (draft → info, packing → brand, ready → warn,
// shipped → ok, cancelled → bad) per prototype SHIP.STATUS.
const STATUS_TONE = {
  draft:     'info',
  packing:   'brand',
  ready:     'warn',
  shipped:   'ok',
  cancelled: 'bad',
};
const STATUS_DOT = {
  '':          'var(--t3)',
  draft:       'var(--info-fg)',
  packing:     'var(--yellow)',
  ready:       'var(--warn-fg)',
  shipped:     'var(--ok-fg)',
  cancelled:   'var(--bad-fg)',
};

// Normalized courier stage → kit tone + human label (courierops tracking_status).
const STAGE_TONE = {
  manifested: 'info', picked_up: 'brand', in_transit: 'brand', out_for_delivery: 'warn',
  part_delivered: 'warn', delivered: 'ok', undelivered: 'bad', not_picked: 'bad',
  rto_in_transit: 'warn', rto_delivered: 'mute', cancelled: 'bad', lost: 'bad', unknown: 'mute',
};
const STAGE_LABEL = {
  manifested: 'Manifested', picked_up: 'Picked up', in_transit: 'In transit', out_for_delivery: 'Out for delivery',
  part_delivered: 'Partially delivered', delivered: 'Delivered', undelivered: 'Undelivered', not_picked: 'Not picked',
  rto_in_transit: 'RTO in transit', rto_delivered: 'RTO delivered', cancelled: 'Cancelled', lost: 'Lost', unknown: 'Unknown',
};
function relTime(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function ShipmentStatusBadge({ status }) {
  if (!status) return <ToneBadge tone="mute">—</ToneBadge>;
  return <ToneBadge tone={STATUS_TONE[status] || 'mute'}>{status}</ToneBadge>;
}

// Box statuses (open / packed / closed).
const BOX_TONE = { open: 'warn', packed: 'ok', closed: 'ok' };
function BoxStatusBadge({ status }) {
  if (!status) return <ToneBadge tone="mute">—</ToneBadge>;
  return <ToneBadge tone={BOX_TONE[status] || 'mute'}>{status}</ToneBadge>;
}

// Tiny channel-type tag (prototype CType).
function CType({ t }) {
  if (!t) return null;
  const tt = String(t).toLowerCase();
  const ecom = tt === 'ecom';
  const retail = tt === 'retail';
  return (
    <span className="num" style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
      color: ecom ? 'var(--blue-bright)' : retail ? 'var(--yellow)' : 'var(--t3)',
      background: ecom ? 'var(--info-bg)' : retail ? 'var(--brand-bg)' : 'var(--surface-2)',
      borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap' }}>{t}</span>
  );
}

// ── Common styles ────────────────────────────────────────────
const selectStyle = {
  background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
  color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, padding: '8px 11px',
  outline: 'none', cursor: 'pointer',
};
const eyebrowLbl = { marginBottom: 6, display: 'block' };
// Small per-row action button — colored ghost.
const actionBtn = (color) => ({
  padding: '4px 9px', background: 'transparent', border: `1px solid ${color}`,
  borderRadius: 'var(--r-xs)', color, fontFamily: 'var(--font-display)', fontSize: 10,
  fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
  whiteSpace: 'nowrap',
});
// Tracking-panel input — full-width, compact.
const trkInput = { background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
  color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 12.5, padding: '7px 9px', outline: 'none', width: '100%' };

// Known couriers for the dropdown (decision #6) — canonical values the poller matches on
// (courierops polls courier_partner = 'Delhivery'). "Other" reveals a free-text field.
const COURIERS = ['Delhivery', 'Shiprocket', 'Other'];

// ── Shipments Page ────────────────────────────────────────────
export default function DispatchShipmentsPage() {
  const { session, user } = useAuth();
  const { showToast } = useToast();
  const { channels } = useDispatchChannels(session);
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [shipments,    setShipments]    = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [query,        setQuery]        = useState('');

  // Detail panel
  const [detailShipment, setDetailShipment] = useState(null);
  const [detailBoxes,    setDetailBoxes]    = useState([]);
  const [detailLines,    setDetailLines]    = useState([]);
  const [detailRemovals, setDetailRemovals] = useState([]);
  const [detailLoading,  setDetailLoading]  = useState(false);
  const [expandedBoxes,  setExpandedBoxes]  = useState(new Set());
  const [boxUnitsCache,  setBoxUnitsCache]  = useState({});
  const [addBoxCount,    setAddBoxCount]    = useState(1);
  const [addBoxCapacity, setAddBoxCapacity] = useState(''); // max units/carton; '' = unlimited

  // Tracking & delivery editor (Snorkel↔Depot fulfilment). Seeded per shipment;
  // committed together via updateShipmentTracking.
  const [trk,       setTrk]       = useState(null);
  const [trkSaving, setTrkSaving] = useState(false);
  const [courierOther, setCourierOther] = useState(false);

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

  // Create + Edit modals use shared <Modal/> (handles ESC internally). Detail drawer handled here.
  useEscapeClose(!!detailShipment,  () => setDetailShipment(null));

  // Seed the tracking editor when a different shipment opens (not on every
  // refresh — keeps in-progress edits across a post-save reload).
  useEffect(() => {
    if (!detailShipment) { setTrk(null); return; }
    setTrk({
      courier_partner:        detailShipment.courier_partner || '',
      tracking_number:        detailShipment.tracking_number || '',
      tracking_link:          detailShipment.tracking_link || '',
      expected_delivery_date: detailShipment.expected_delivery_date || '',
      delivery_date:          detailShipment.delivery_date || '',
    });
    const cp = detailShipment.courier_partner || '';
    setCourierOther(!!cp && !['Delhivery', 'Shiprocket'].includes(cp));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailShipment?.id]);

  // ── Loaders ───────────────────────────────────────────────
  const loadShipments = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setRefreshing(true);
    try {
      const params = statusFilter ? { status: statusFilter } : {};
      const data = await garageFetch('getDispatchShipments', params, session);
      setShipments(Array.isArray(data) ? data : []);
    } catch (_) {
      setShipments([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, statusFilter, setRefreshing, setLastRefreshed]);

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
      const [boxes, lines, rem] = await Promise.all([
        garageFetch('getShipmentBoxes', { shipment_id: shipment.id }, session),
        garageFetch('getShipmentLines', { shipment_id: shipment.id }, session),
        garageFetch('getShipmentRemovals', { shipment_id: shipment.id }, session),
      ]);
      setDetailBoxes(Array.isArray(boxes) ? boxes : []);
      setDetailLines(Array.isArray(lines) ? lines : []);
      setDetailRemovals(Array.isArray(rem?.removals) ? rem.removals : []);
    } catch (_) {
      setDetailBoxes([]); setDetailLines([]); setDetailRemovals([]);
    } finally {
      setDetailLoading(false);
    }
  }

  async function refreshDetail() {
    if (!detailShipment) return;
    setDetailLoading(true);
    try {
      const [shpData, boxes, lines, rem] = await Promise.all([
        garageFetch('getDispatchShipments', {}, session),
        garageFetch('getShipmentBoxes', { shipment_id: detailShipment.id }, session),
        garageFetch('getShipmentLines', { shipment_id: detailShipment.id }, session),
        garageFetch('getShipmentRemovals', { shipment_id: detailShipment.id }, session),
      ]);
      const updated = Array.isArray(shpData) ? shpData.find(s => s.id === detailShipment.id) : null;
      if (updated) setDetailShipment(updated);
      setDetailBoxes(Array.isArray(boxes) ? boxes : []);
      setDetailLines(Array.isArray(lines) ? lines : []);
      setDetailRemovals(Array.isArray(rem?.removals) ? rem.removals : []);
    } catch (_) {} finally {
      setDetailLoading(false);
    }
  }

  // Tracking + delivery for a shipment. Snorkel surfaces these on the sales order
  // (read-side) and the actual delivery_date starts the partner's payment-due clock.
  async function saveTracking() {
    if (!detailShipment || !trk) return;
    setTrkSaving(true);
    try {
      await workerFetch('updateShipmentTracking', {
        shipment_id:            detailShipment.id,
        courier_partner:        trk.courier_partner || null,
        tracking_number:        trk.tracking_number || null,
        tracking_link:          trk.tracking_link || null,
        expected_delivery_date: trk.expected_delivery_date || null,
        delivery_date:          trk.delivery_date || null,
      }, session);
      showToast('Tracking saved', 'success');
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Failed to save tracking', 'error');
    } finally {
      setTrkSaving(false);
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

  async function addBoxes(shipmentId, count, capacity) {
    const n = Math.max(1, parseInt(count, 10) || 1);
    const cap = (capacity != null && parseInt(capacity, 10) > 0) ? parseInt(capacity, 10) : null;
    try {
      const res = await workerFetch('createBoxes', { shipment_id: shipmentId, count: n, capacity: cap }, session);
      const r = res?.data || res;
      const created = r?.created ?? n;
      showToast(`${created} box${created !== 1 ? 'es' : ''} added${cap ? ` · max ${cap}/box` : ''}`, 'success');
      setAddBoxCount(1);
      setAddBoxCapacity('');
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
    // Append only the variants not already present — supports topping up a
    // product whose lineup has expanded (new colour added to product_master
    // after the line was first added) and idempotent re-click.
    setCreateLines(prev => {
      const key = (p, m, c) => `${p}|${m || ''}|${c || ''}`;
      const existing = new Set(prev.map(l => key(l.product, l.model, l.color)));
      const additions = productCodes[product]
        .filter(v => !existing.has(key(product, v.model, v.color)))
        .map(v => ({ product, model: v.model, color: v.color, label: v.label, qty: 0 }));
      if (additions.length === 0) return prev;
      return [...prev, ...additions];
    });
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
    // Append only the variants not already on this shipment. The old guard
    // bailed entirely if ANY variant of the product was present, blocking
    // the operator from adding a newly-launched colour (e.g. Nitro Race
    // Blue) to a shipment that already had other Nitro variants.
    setEditLines(prev => {
      const key = (p, m, c) => `${p}|${m || ''}|${c || ''}`;
      const existing = new Set(prev.map(l => key(l.product, l.model, l.color)));
      const additions = productCodes[product]
        .filter(v => !existing.has(key(product, v.model, v.color)))
        .map(v => ({ product, model: v.model, color: v.color, label: v.label, target_qty: 0, packed_qty: 0 }));
      if (additions.length === 0) return prev;
      return [...prev, ...additions];
    });
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

  // Hide a product from the Add Product dropdown ONLY when every variant
  // it offers is already on the shipment. If a typo'd line covers Burnout
  // Blue but the operator still needs Race Blue, "Nitro" must remain
  // selectable — addCreateLine / addEditLine already dedupe per-variant.
  function hasMissingVariant(product, groups) {
    const all = productCodes[product] || [];
    if (all.length === 0) return false;
    const existing = new Set((groups[product] || []).map(l => `${l.model || ''}|${l.color || ''}`));
    return all.some(v => !existing.has(`${v.model || ''}|${v.color || ''}`));
  }

  // For create — compute selected channel
  const selectedChannel = channels.find(c => c.id === createChannelId);
  const isBulk = selectedChannel?.fulfillment_model === 'bulk';

  // Manifest group card (shared by create + edit modals).
  const groupCard = { background: 'var(--surface-2)', border: '1px solid var(--border-2)',
    borderRadius: 'var(--r-sm)', padding: 11, marginBottom: 8 };

  const TABS = [
    ['', 'All'], ['draft', 'Draft'], ['packing', 'Packing'],
    ['ready', 'Ready'], ['shipped', 'Shipped'], ['cancelled', 'Cancelled'],
  ];

  const cols = '150px 1.3fr 1fr 104px 120px 96px 96px 220px';

  // Client-side search across shipment number, title, and channel name.
  const q = query.trim().toLowerCase();
  const visibleShipments = q
    ? shipments.filter(s => {
        const hay = [
          s.shipment_no,
          s.title,
          s.dispatch_channels?.name,
          s.dispatch_channels?.type,
          s.sales_order_no,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
    : shipments;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', fontFamily: 'var(--font-ui)' }}>
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
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Shipment"
        titleColor="var(--yellow)"
        size="lg"
      >
        {createOpen && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <span className="eyebrow" style={eyebrowLbl}>Title · optional</span>
                <input style={inputStyle} value={createTitle} onChange={e => setCreateTitle(e.target.value)} placeholder="e.g. Amazon Mar wk-3" />
              </div>
              <div>
                <span className="eyebrow" style={eyebrowLbl}>Channel <span style={{ color: 'var(--bad-fg)' }}>*</span></span>
                <select style={{ ...selectStyle, width: '100%' }} value={createChannelId} onChange={e => setCreateChannelId(e.target.value)}>
                  <option value="">Select channel…</option>
                  {channels.filter(c => c.is_active !== false).map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                  ))}
                </select>
              </div>
            </div>

            {isBulk && (
              <div style={{ marginBottom: 14 }}>
                <span className="eyebrow" style={eyebrowLbl}>Destination Warehouse</span>
                <input style={inputStyle} value={createWarehouse} onChange={e => setCreateWarehouse(e.target.value)} placeholder="e.g. BOM Bulk" />
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <span className="eyebrow" style={eyebrowLbl}>Scheduled Date</span>
                <input type="date" style={inputStyle} value={createDate} onChange={e => setCreateDate(e.target.value)} />
              </div>
              <div>
                <span className="eyebrow" style={eyebrowLbl}>Notes</span>
                <input style={inputStyle} value={createNotes} onChange={e => setCreateNotes(e.target.value)} placeholder="Internal notes" />
              </div>
            </div>

            {/* Manifest */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span className="label" style={{ fontSize: 11, color: 'var(--t2)' }}>Manifest</span>
                <div style={{ flex: 1 }} />
                <select style={selectStyle} value={createProduct} onChange={e => setCreateProduct(e.target.value)}>
                  <option value="">{productOptions.length ? 'Select product…' : 'Loading products…'}</option>
                  {productOptions.filter(p => hasMissingVariant(p, createGroups)).map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <button style={btnGhost} onClick={() => addCreateLine(createProduct)} disabled={!createProduct}>
                  <Icon name="plus" size={13} /> Add
                </button>
              </div>

              {Object.keys(createGroups).length === 0 ? (
                <div style={{ padding: '14px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 12.5, fontFamily: 'var(--font-ui)' }}>
                  No products yet — add one above
                </div>
              ) : (
                Object.entries(createGroups).map(([product, group]) => (
                  <div key={product} style={groupCard}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 700, color: 'var(--t1)' }}>{product}</span>
                      <div style={{ flex: 1 }} />
                      <button onClick={() => removeCreateProduct(product)}
                        style={{ ...actionBtn('var(--bad-fg)'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Icon name="x" size={11} /> Remove
                      </button>
                    </div>
                    {group.map((l) => {
                      const idx = createLines.findIndex(x => x.product === l.product && x.model === l.model && x.color === l.color);
                      return (
                        <div key={`${l.product}-${l.model}-${l.color}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', flex: 1 }}>{l.label}</span>
                          <input
                            type="number" min={0}
                            value={l.qty}
                            onChange={e => updateCreateLineQty(idx, e.target.value)}
                            className="num"
                            style={{ ...inputStyle, width: 84, textAlign: 'right', padding: '6px 9px' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))
              )}

              <div style={{ marginTop: 10, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>
                Total: <span className="num" style={{ color: 'var(--yellow)', fontWeight: 700 }}>{fmt(createTotal)}</span> units
              </div>
            </div>

            {createError && (
              <div style={{ color: 'var(--bad-fg)', fontSize: 12.5, marginTop: 12, fontFamily: 'var(--font-ui)' }}>{createError}</div>
            )}

            {/* TODO: B-4 follow-up: Modal lacks a `footer` slot — keeping inline buttons to preserve yellow-on-black primary style. */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setCreateOpen(false)} style={btnGhost} disabled={createLoading}>Cancel</button>
              <button
                onClick={submitCreate}
                disabled={createLoading}
                style={{ ...btnPrimary, opacity: createLoading ? 0.5 : 1 }}
              >
                {createLoading ? 'Creating…' : 'Create Shipment'}
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* Edit panel */}
      <Modal
        open={editOpen && !!editShipment}
        onClose={() => setEditOpen(false)}
        title={editShipment ? `Edit ${editShipment.shipment_no}` : 'Edit Shipment'}
        titleColor="var(--yellow)"
        size="lg"
      >
        {editOpen && editShipment && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <span className="eyebrow" style={eyebrowLbl}>Title</span>
                <input style={inputStyle} value={editTitle} onChange={e => setEditTitle(e.target.value)} />
              </div>
              <div>
                <span className="eyebrow" style={eyebrowLbl}>Scheduled Date</span>
                <input type="date" style={inputStyle} value={editDate} onChange={e => setEditDate(e.target.value)} />
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <span className="eyebrow" style={eyebrowLbl}>Notes</span>
              <input style={inputStyle} value={editNotes} onChange={e => setEditNotes(e.target.value)} />
            </div>

            {/* Manifest */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span className="label" style={{ fontSize: 11, color: 'var(--t2)' }}>Manifest</span>
                <div style={{ flex: 1 }} />
                <select style={selectStyle} value={editProduct} onChange={e => setEditProduct(e.target.value)}>
                  <option value="">{productOptions.length ? 'Add product…' : 'Loading…'}</option>
                  {productOptions.filter(p => hasMissingVariant(p, editGroups)).map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <button style={btnGhost} onClick={() => addEditLine(editProduct)} disabled={!editProduct}>
                  <Icon name="plus" size={13} /> Add
                </button>
              </div>

              {Object.entries(editGroups).map(([product, group]) => {
                const groupPacked = group.reduce((s, l) => s + (l.packed_qty || 0), 0);
                return (
                  <div key={product} style={groupCard}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 700, color: 'var(--t1)' }}>{product}</span>
                      <div style={{ flex: 1 }} />
                      {groupPacked === 0 && (
                        <button onClick={() => removeEditProduct(product)}
                          style={{ ...actionBtn('var(--bad-fg)'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Icon name="x" size={11} /> Remove
                        </button>
                      )}
                    </div>
                    {group.map((l) => {
                      const idx = editLines.findIndex(x => x.product === l.product && x.model === l.model && x.color === l.color);
                      return (
                        <div key={`${l.product}-${l.model}-${l.color}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', flex: 1 }}>{l.label}</span>
                          <span className="num" style={{ fontSize: 11, color: 'var(--t3)', minWidth: 80, textAlign: 'right' }}>packed {fmt(l.packed_qty)}</span>
                          <input
                            type="number" min={l.packed_qty || 0}
                            value={l.target_qty}
                            onChange={e => updateEditLineQty(idx, e.target.value)}
                            className="num"
                            style={{ ...inputStyle, width: 84, textAlign: 'right', padding: '6px 9px' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              <div style={{ marginTop: 10, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>
                Target: <span className="num" style={{ color: 'var(--yellow)', fontWeight: 700 }}>{fmt(editTargetTotal)}</span>
                {' · '}
                Packed: <span className="num" style={{ color: 'var(--ok-fg)', fontWeight: 700 }}>{fmt(editPackedTotal)}</span>
              </div>
            </div>

            {editError && (
              <div style={{ color: 'var(--bad-fg)', fontSize: 12.5, marginTop: 12, fontFamily: 'var(--font-ui)' }}>{editError}</div>
            )}

            {/* TODO: B-4 follow-up: Modal lacks a `footer` slot — keeping inline buttons to preserve yellow-on-black primary style. */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setEditOpen(false)} style={btnGhost} disabled={editLoading}>Cancel</button>
              <button
                onClick={submitEdit}
                disabled={editLoading}
                style={{ ...btnPrimary, opacity: editLoading ? 0.5 : 1 }}
              >
                {editLoading ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* Page content */}
      <div>
        {/* Filter tabs + Create */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {TABS.map(([val, label]) => (
            <FilterChip key={val || 'all'} active={statusFilter === val} dot={STATUS_DOT[val]}
              onClick={() => setStatusFilter(val)}>
              {label}
            </FilterChip>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: 10, color: 'var(--t3)', display: 'flex', pointerEvents: 'none' }}>
              <Icon name="search" size={14} />
            </span>
            <input
              data-search-primary
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search ref, title, channel…  · /"
              style={{ ...inputStyle, width: 250, padding: '8px 11px 8px 31px', fontSize: 13 }}
            />
          </div>
          <button style={btnPrimary} onClick={openCreate}>
            <Icon name="plus" size={15} /> New Shipment
          </button>
        </div>

        {/* Shipments table */}
        <Panel pad={8}>
          {loading ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : visibleShipments.length === 0 ? (
            <div style={{ padding: '44px 0', textAlign: 'center' }}>
              <div style={{ display: 'inline-grid', placeItems: 'center', width: 44, height: 44, borderRadius: '50%',
                background: 'var(--surface-2)', color: 'var(--t3)', border: '1px solid var(--border-2)', marginBottom: 12 }}>
                <Icon name={q ? 'search' : 'send'} size={20} />
              </div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>
                {q ? 'No shipments match your search' : `No ${statusFilter || ''} shipments`}
              </div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>
                {q ? 'Try a different ref, title, or channel.' : 'Create a shipment to start packing for a channel.'}
              </div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 1080 }}>
                <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '0 12px 9px', borderBottom: '1px solid var(--border)' }}>
                  {['Ref', 'Title', 'Channel', 'Pool / target', 'Packed', 'Scheduled', 'Status', 'Actions'].map(h => (
                    <div key={h} className="eyebrow">{h}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {visibleShipments.map((s, i) => {
                    const isOpen = detailShipment?.id === s.id;
                    const ch = s.dispatch_channels;
                    const ready = s.is_ready && s.status !== 'shipped';
                    const pct = (Number(s.expected_units) || 0) > 0
                      ? Math.min(100, Math.round((Number(s.packed_count) || 0) * 100 / Number(s.expected_units)))
                      : 0;
                    return (
                      <div
                        key={s.id}
                        onClick={() => isOpen ? setDetailShipment(null) : openDetail(s)}
                        style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center',
                          padding: '11px 12px', cursor: 'pointer',
                          borderTop: i ? '1px solid var(--border)' : 'none',
                          background: isOpen ? 'var(--surface-2)' : 'transparent',
                          transition: 'background var(--fast) var(--ease)' }}
                        onMouseEnter={(e) => { if (!isOpen) e.currentTarget.style.background = 'var(--surface-2)'; }}
                        onMouseLeave={(e) => { if (!isOpen) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span className="num" style={{ fontSize: 12, fontWeight: 700, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>{s.shipment_no}</span>
                          {s.sales_order_no && (
                            <span className="num" title={`Offline sales order ${s.sales_order_no}`}
                              style={{ fontSize: 9, fontWeight: 700, color: 'var(--info-fg)', border: '1px solid var(--info-bd)',
                                background: 'var(--info-bg)', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                              {s.sales_order_no}
                            </span>
                          )}
                          {ready && <ToneBadge tone="ok">Ready</ToneBadge>}
                          {/* Stale-draft nudge, 7 days (Afshaan 2026-07-31). A draft only
                              closes when its LAST box is dispatched out, so an unfinished
                              consignment sits here forever with its cartons still live —
                              DSO-0152 went 41 days unnoticed. Age counts from the newest
                              box activity, not created_at, so an actively-worked shipment
                              never trips it. */}
                          {s.stale_draft && (
                            <span title={`Draft, untouched for ${s.idle_days} days · ${fmt(s.draft_units_packed)} unit(s) sitting in ${s.draft_boxes} box(es). Dispatch it out or cancel it.`}
                              style={{ fontSize: 9, fontWeight: 700, color: 'var(--warn-fg)', border: '1px solid var(--warn-bd)',
                                background: 'var(--warn-bg)', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                              STALE {s.idle_days}d
                            </span>
                          )}
                          {s.tracking_number && (
                            <span title={`Tracked${s.courier_partner ? ` · ${s.courier_partner}` : ''}: ${s.tracking_number}`}
                              style={{ display: 'inline-flex', color: 'var(--blue-bright)', flexShrink: 0 }}>
                              <Icon name="truck" size={13} />
                            </span>
                          )}
                        </span>
                        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: s.title ? 'var(--t1)' : 'var(--t4)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title || '—'}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: ch ? 'var(--t2)' : 'var(--t4)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ch?.name || '—'}</span>
                          {ch && <CType t={ch.type} />}
                        </span>
                        <span className="num" style={{ fontSize: 12.5, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                          {fmt(s.pool_count)} / {fmt(s.expected_units)}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div style={{ flex: 1, height: 5, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden', minWidth: 30 }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--ok-fg)' : 'var(--yellow)', borderRadius: 3 }} />
                          </div>
                          <span className="num" style={{ fontSize: 12, color: pct === 100 ? 'var(--ok-fg)' : 'var(--t2)' }}>{fmt(s.packed_count)}</span>
                        </span>
                        <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{formatDate(s.scheduled_date)}</span>
                        <span><ShipmentStatusBadge status={s.status} /></span>
                        <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {!['shipped', 'cancelled'].includes(s.status) && (
                            <button onClick={(e) => { e.stopPropagation(); confirmMarkShipped(s); }} style={actionBtn('var(--ok-fg)')}>Shipped</button>
                          )}
                          {['draft', 'packing'].includes(s.status) && (
                            <button onClick={(e) => { e.stopPropagation(); openEdit(s); }} style={actionBtn('var(--yellow)')}>Edit</button>
                          )}
                          {['draft', 'packing'].includes(s.status) && (
                            <button onClick={(e) => { e.stopPropagation(); confirmCancel(s); }} style={actionBtn('var(--warn-fg)')}>Cancel</button>
                          )}
                          {s.status === 'draft' && (
                            <button onClick={(e) => { e.stopPropagation(); confirmDelete(s); }} style={actionBtn('var(--bad-fg)')}>Delete</button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </Panel>

        {/* Detail — drill-down drawer */}
        <Drawer open={!!detailShipment} onClose={() => setDetailShipment(null)} width={540}>
          {detailShipment && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '15px 20px', borderBottom: '1px solid var(--border)' }}>
                <span className="num" style={{ fontSize: 13, fontWeight: 700, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>{detailShipment.shipment_no}</span>
                <ShipmentStatusBadge status={detailShipment.status} />
                {detailShipment.sales_order_no && (
                  <span className="num" style={{ fontSize: 10, fontWeight: 700, color: 'var(--info-fg)', border: '1px solid var(--info-bd)',
                    background: 'var(--info-bg)', borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }}>
                    Order {detailShipment.sales_order_no}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {detailLoading && <Spinner size="sm" />}
                <button onClick={() => setDetailShipment(null)}
                  style={{ background: 'none', border: '1px solid var(--border-2)', borderRadius: 'var(--r-xs)',
                    width: 26, height: 26, color: 'var(--t3)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
                  <Icon name="x" size={14} />
                </button>
              </div>

              <div style={{ overflowY: 'auto', padding: 20, flex: 1 }}>
                {detailShipment.title && (
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 600, color: 'var(--t1)', marginBottom: 14 }}>
                    {detailShipment.title}
                  </div>
                )}

                {/* Meta cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 18 }}>
                  <MetaCard label="Channel" value={detailShipment.dispatch_channels?.name || '—'}
                    extra={<CType t={detailShipment.dispatch_channels?.type} />} text />
                  <MetaCard label="Pool / target" value={`${fmt(detailShipment.pool_count)} / ${fmt(detailShipment.expected_units)}`} />
                  <MetaCard label="Packed" value={fmt(detailShipment.packed_count)}
                    sub={`of ${fmt(detailShipment.expected_units)}`} />
                  <MetaCard label="Scheduled" value={formatDate(detailShipment.scheduled_date)} />
                </div>

                {/* Tracking & delivery — courier/AWB/link + expected & actual delivery.
                    Snorkel reads these on the sales order; actual delivery starts the
                    partner's payment-due clock (falls back to dispatch date if blank). */}
                {detailShipment.status !== 'cancelled' && trk && (
                  <div style={{ marginBottom: 18, padding: '13px 14px',
                    background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                      <span className="label" style={{ fontSize: 11, color: 'var(--t2)' }}>Tracking &amp; delivery</span>
                      <div style={{ flex: 1 }} />
                      <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>Dispatched {formatDate(detailShipment.shipped_at)}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <span className="eyebrow" style={{ display: 'block', marginBottom: 5 }}>Courier</span>
                        <select style={trkInput}
                          value={courierOther ? 'Other' : (COURIERS.includes(trk.courier_partner) ? trk.courier_partner : '')}
                          onChange={e => {
                            const v = e.target.value;
                            if (v === 'Other') { setCourierOther(true); setTrk(t => ({ ...t, courier_partner: '' })); }
                            else { setCourierOther(false); setTrk(t => ({ ...t, courier_partner: v })); }
                          }}>
                          <option value="">Select courier…</option>
                          {COURIERS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        {courierOther && (
                          <input style={{ ...trkInput, marginTop: 6 }} value={trk.courier_partner}
                            onChange={e => setTrk(t => ({ ...t, courier_partner: e.target.value }))}
                            placeholder="Courier name" autoFocus />
                        )}
                        {trk.courier_partner === 'Delhivery' && (
                          <span style={{ display: 'block', marginTop: 4, fontSize: 10.5, color: 'var(--t3)' }}>
                            Auto-tracked every 30 min once an AWB is set.
                          </span>
                        )}
                      </div>
                      <div>
                        <span className="eyebrow" style={{ display: 'block', marginBottom: 5 }}>Tracking number</span>
                        <input style={trkInput} value={trk.tracking_number}
                          onChange={e => setTrk(t => ({ ...t, tracking_number: e.target.value }))} placeholder="AWB / docket no." />
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <span className="eyebrow" style={{ display: 'block', marginBottom: 5 }}>Tracking link</span>
                        <input style={trkInput} value={trk.tracking_link}
                          onChange={e => setTrk(t => ({ ...t, tracking_link: e.target.value }))} placeholder="https://…" />
                      </div>
                      <div>
                        <span className="eyebrow" style={{ display: 'block', marginBottom: 5 }}>Expected delivery</span>
                        <input type="date" style={trkInput} value={trk.expected_delivery_date}
                          onChange={e => setTrk(t => ({ ...t, expected_delivery_date: e.target.value }))} />
                      </div>
                      <div>
                        <span className="eyebrow" style={{ display: 'block', marginBottom: 5 }}>Actual delivery</span>
                        <input type="date" style={trkInput} value={trk.delivery_date}
                          onChange={e => setTrk(t => ({ ...t, delivery_date: e.target.value }))} />
                      </div>
                    </div>
                    {detailShipment.sales_order_no && (
                      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.5, marginTop: 9 }}>
                        Sales order {detailShipment.sales_order_no} — actual delivery starts the partner&apos;s payment-due clock in Snorkel (defaults to dispatch date if blank).
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 11 }}>
                      {trk.tracking_link && (
                        <a href={trk.tracking_link} target="_blank" rel="noreferrer"
                          style={{ ...actionBtn('var(--blue-bright)'), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Icon name="upRight" size={11} /> Open link
                        </a>
                      )}
                      <button onClick={saveTracking} disabled={trkSaving}
                        style={{ ...btnGhost, padding: '6px 14px', fontSize: 12, opacity: trkSaving ? 0.5 : 1 }}>
                        {trkSaving ? 'Saving…' : 'Save Tracking'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Courier tracking timeline (courierops). Read-only; current stage + full scan history. */}
                {Array.isArray(detailShipment.tracking_checkpoints) && detailShipment.tracking_checkpoints.length > 0 && (
                  <div style={{ marginBottom: 18 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span className="label" style={{ fontSize: 11, color: 'var(--t2)' }}>Courier timeline</span>
                      {detailShipment.tracking_status && (
                        <ToneBadge tone={STAGE_TONE[detailShipment.tracking_status] || 'mute'}>
                          {STAGE_LABEL[detailShipment.tracking_status] || detailShipment.tracking_status}
                        </ToneBadge>
                      )}
                      <div style={{ flex: 1 }} />
                      {detailShipment.tracking_synced_at && (
                        <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>updated {relTime(detailShipment.tracking_synced_at)}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      {detailShipment.tracking_checkpoints.map((c, i) => (
                        <div key={i} style={{ display: 'flex', gap: 10, paddingBottom: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                            <span style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 4,
                              background: i === 0 ? 'var(--ok-fg)' : 'var(--border-2)' }} />
                            {i < detailShipment.tracking_checkpoints.length - 1 &&
                              <span style={{ width: 1, flex: 1, background: 'var(--border)', marginTop: 2 }} />}
                          </div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)' }}>
                              {c.label || STAGE_LABEL[c.stage] || c.stage}
                            </div>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)' }}>
                              {c.location || '—'}{c.timestamp ? ` · ${formatDateTime(c.timestamp)}` : ''}
                            </div>
                            {c.description && (
                              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t4)', marginTop: 1 }}>{c.description}</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Manifest */}
                <div className="label" style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 10 }}>Manifest</div>
                {detailLines.length === 0 ? (
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', padding: '4px 0 14px' }}>No lines.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 18 }}>
                    {detailLines.map((l, i) => {
                      const pct = l.target_qty > 0 ? Math.min(100, Math.round((l.packed_qty || 0) * 100 / l.target_qty)) : 0;
                      const done = pct === 100;
                      return (
                        <div key={`${l.product}-${l.model}-${l.color}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)', width: 168, flexShrink: 0,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {l.product} <span style={{ color: 'var(--t4)' }}>{[l.model, l.color].filter(Boolean).join(' ')}</span>
                          </span>
                          <div style={{ flex: 1, height: 7, background: 'var(--bg-2)', borderRadius: 4, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: done ? 'var(--ok-fg)' : 'var(--yellow)',
                              borderRadius: 4, transition: 'width var(--base) var(--ease)' }} />
                          </div>
                          <span className="num" style={{ fontSize: 12, color: done ? 'var(--ok-fg)' : 'var(--t2)', width: 84, textAlign: 'right' }}>
                            {fmt(l.packed_qty)}/{fmt(l.target_qty)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Removed after packing — sits directly under the manifest because it
                    answers the question the manifest raises ("why is this line short?").
                    Removing a packed unit is routine (~1,100/month) and correctly drops
                    packed_qty, so this is an explanation, not an exception report. Units
                    that were later re-packed into THIS shipment are shown greyed as
                    "back in" so they are not mistaken for losses. */}
                {detailRemovals.length > 0 && (() => {
                  const gone = detailRemovals.filter(r => !r.returned_to_this_shipment);
                  return (
                    <>
                      <div className="label" style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 10 }}>
                        Removed after packing · {gone.length}
                        {detailRemovals.length !== gone.length && (
                          <span style={{ color: 'var(--t4)' }}> ({detailRemovals.length - gone.length} came back)</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
                        {detailRemovals.map((r, i) => {
                          const back = r.returned_to_this_shipment;
                          const dest = back
                            ? 'back in this shipment'
                            : r.now_in_shipment ? `now on ${r.now_in_shipment}`
                            : r.now_in_box     ? `now in ${r.now_in_box}${r.current_status === 'shipped' ? ' · shipped separately' : ''}`
                            : (r.current_status || 'not in a box');
                          return (
                            <div key={`${r.car_upc}-${r.removed_at}-${i}`}
                              style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-ui)',
                                fontSize: 12, color: back ? 'var(--t4)' : 'var(--t2)' }}>
                              <span className="num" style={{ color: back ? 'var(--t4)' : 'var(--t1)', width: 132, flexShrink: 0 }}>{r.car_upc}</span>
                              <span style={{ width: 150, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {[r.product, r.model, r.color].filter(Boolean).join(' ')}
                              </span>
                              <span style={{ width: 96, flexShrink: 0, color: 'var(--t4)' }}>{r.removed_from_box || '—'}</span>
                              <span style={{ width: 118, flexShrink: 0, color: 'var(--t4)' }}>{formatDateTime(r.removed_at)}</span>
                              <span style={{ flex: 1, color: back ? 'var(--t4)' : 'var(--yellow)' }}>{dest}</span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}

                {/* Boxes */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span className="label" style={{ fontSize: 11, color: 'var(--t2)' }}>Boxes · {detailBoxes.length}</span>
                  <div style={{ flex: 1 }} />
                  {!['shipped', 'cancelled'].includes(detailShipment.status) && (
                    <>
                      <input
                        type="number" min={1}
                        value={addBoxCount}
                        onChange={e => setAddBoxCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        className="num" title="How many boxes to open"
                        style={{ ...inputStyle, width: 56, textAlign: 'right', padding: '5px 8px', fontSize: 12.5 }}
                      />
                      <input
                        type="number" min={1}
                        value={addBoxCapacity}
                        onChange={e => setAddBoxCapacity(e.target.value)}
                        className="num" placeholder="cap" title="Max units per box (blank = unlimited)"
                        style={{ ...inputStyle, width: 64, textAlign: 'right', padding: '5px 8px', fontSize: 12.5 }}
                      />
                      <button onClick={() => addBoxes(detailShipment.id, addBoxCount, addBoxCapacity)}
                        style={{ ...btnGhost, padding: '6px 11px', fontSize: 12 }}>
                        <Icon name="plus" size={13} /> Add Boxes
                      </button>
                    </>
                  )}
                </div>
                {detailBoxes.length === 0 ? (
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', padding: '4px 0' }}>No boxes yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {detailBoxes.map(box => {
                      const expanded = expandedBoxes.has(box.id);
                      const units = boxUnitsCache[box.id];
                      const isPacked = box.status === 'packed' || box.status === 'closed';
                      return (
                        <div key={box.id} style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer' }}
                            onClick={() => toggleBoxUnits(box.id)}
                          >
                            <span style={{ color: 'var(--t4)', display: 'flex',
                              transform: expanded ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform var(--fast) var(--ease)' }}>
                              <Icon name="chevD" size={12} />
                            </span>
                            <span className="num" style={{ fontSize: 12, fontWeight: 700, color: 'var(--yellow)' }}>{box.box_ref || `Box ${box.id}`}</span>
                            <span className="num" style={{ fontSize: 11.5, color: 'var(--t2)' }}>{fmt(box.unit_count)}{box.capacity ? ` / ${box.capacity}` : ''} units</span>
                            <BoxStatusBadge status={box.status} />
                            <div style={{ flex: 1 }} />
                            {isPacked && (
                              <>
                                <button onClick={(e) => { e.stopPropagation(); reprintBox(box.id); }} style={actionBtn('var(--blue-bright)')}>Reprint</button>
                                <button onClick={(e) => { e.stopPropagation(); reopenBox(box.id); }} style={actionBtn('var(--warn-fg)')}>Reopen</button>
                              </>
                            )}
                            {!isPacked && (box.unit_count || 0) === 0 && (
                              <button onClick={(e) => { e.stopPropagation(); confirmDeleteBox(box); }} style={actionBtn('var(--bad-fg)')}>Remove</button>
                            )}
                          </div>
                          {expanded && (
                            <div style={{ borderTop: '1px solid var(--border)', padding: '6px 12px 10px 30px' }}>
                              {units == null ? (
                                <div style={{ padding: '6px 0', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--font-ui)' }}>Loading units…</div>
                              ) : units.length === 0 ? (
                                <div style={{ padding: '6px 0', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--font-ui)' }}>No active units.</div>
                              ) : (
                                <div>
                                  <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 96px 70px', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                                    {['Batch', 'Product', 'Added', ''].map((h, hi) => <div key={hi} className="eyebrow">{h}</div>)}
                                  </div>
                                  {units.map(u => (
                                    <div key={u.id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 96px 70px', gap: 8,
                                      alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                                      <span className="num" style={{ fontSize: 11.5, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>{u.batch_label || '—'}</span>
                                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t1)', minWidth: 0,
                                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {u.product || '—'}
                                        {(u.model || u.color) && <span style={{ color: 'var(--t4)', marginLeft: 5 }}>{[u.model, u.color].filter(Boolean).join(' ')}</span>}
                                      </span>
                                      <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{formatDateTime(u.added_at)}</span>
                                      <span>
                                        {!isPacked && (
                                          <button onClick={() => confirmRemoveUnit(u.id, box.id, u.batch_label)} style={actionBtn('var(--bad-fg)')}>Remove</button>
                                        )}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </Drawer>
      </div>
    </div>
  );
}

function MetaCard({ label, value, sub, extra, text }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: '10px 13px' }}>
      <div className="eyebrow">{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <span className={text ? undefined : 'num'} style={{ fontFamily: text ? 'var(--font-ui)' : undefined,
          fontSize: text ? 13.5 : 15, fontWeight: 700, color: 'var(--t1)', minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
        {extra}
      </div>
      {sub && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
