'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { EmptyState, Spinner, useToast, printWindow } from '@throttle/ui';

// ── Helpers ────────────────────────────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(raw) {
  if (!raw) return '—';
  const str = String(raw);
  if (/^\d{2}-[A-Za-z]{3}-\d{4}/.test(str)) return str.slice(0, 11);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return String(d.getDate()).padStart(2,'0') + '-' + months[d.getMonth()] + '-' + d.getFullYear();
    }
  }
  return str.slice(0, 10);
}

function buildBagLabelsHtml(bags, shipmentId) {
  const shipRef = shipmentId || '—';
  const labelItems = bags.map(b => {
    const qrData = encodeURIComponent(b.bag_id || '');
    const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=90x90&margin=2&data=${qrData}`;
    return `
      <div class="label">
        <div class="lh">
          <span class="lp">LOT</span>
          <span class="lc">${b.part_code || ''}</span>
          <span class="ls">${shipRef}</span>
        </div>
        <div class="lb">
          <div class="ll">
            <div class="ln">${b.part_name || b.name || ''}</div>
            <div class="lqr"><span class="lqn">${b.qty || 0}</span><span class="lqu"> pcs</span></div>
            <div class="lm">
              <div>Bag ${b.bag_seq || ''}${b.total_bags ? ' of ' + b.total_bags : ''}</div>
              ${b.mark_code && b.mark_code !== '—' ? `<div class="lsub">${b.mark_code}</div>` : ''}
              ${b.bin_code  && b.bin_code  !== '—' ? `<div class="lsub">Bin: ${b.bin_code}</div>` : ''}
            </div>
          </div>
          <div class="lq"><img src="${qrUrl}" width="60" height="60" alt="QR"></div>
        </div>
        <div class="lf">
          <span class="lid">${b.bag_id || ''}</span>
          <span>${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><title>Bag Labels (${bags.length})</title><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;background:#fff}
    .page{display:flex;flex-wrap:wrap;gap:4mm;padding:5mm}
    .label{width:110mm;height:55mm;border:1px solid #000;padding:3mm;display:flex;flex-direction:column;page-break-inside:avoid}
    .lh{display:flex;align-items:center;gap:6px;border-bottom:1px solid #000;padding-bottom:2mm;margin-bottom:2mm}
    .lp{font-weight:900;font-size:14pt;letter-spacing:2px;margin-right:2px}
    .lc{font-family:monospace;font-size:12pt;font-weight:700;flex:1}
    .ls{font-family:monospace;font-size:8pt;color:#555}
    .lb{display:flex;gap:2mm;flex:1;align-items:flex-start}
    .ll{display:flex;flex-direction:column;flex:1;min-width:0;gap:1mm}
    .ln{font-size:9pt;font-weight:600;line-height:1.2}
    .lqr{display:flex;align-items:baseline;gap:2px}
    .lqn{font-size:18pt;font-weight:900;font-family:monospace;line-height:1}
    .lqu{font-size:9pt;color:#555}
    .lm{font-size:7pt;color:#444;line-height:1.4}
    .lsub{color:#666}
    .lq{flex-shrink:0;display:flex;align-items:center}
    .lf{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #000;padding-top:1.5mm;margin-top:auto}
    .lid{font-family:monospace;font-size:6.5pt;color:#333}
    @media print{body{background:#fff}.page{padding:2mm;gap:2mm}}
  </style></head><body><div class="page">${labelItems}</div></body></html>`;
}

// ── Style constants ────────────────────────────────────────────────────────────
const panel    = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = { padding: '10px 16px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const th       = { padding: '7px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td       = { padding: '8px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const inp      = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, width: '100%' };
const sel      = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12 };
const btnPri   = { background: 'var(--yellow)', color: '#000', border: 'none', borderRadius: 4, padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700 };
const btnSec   = { background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 4, padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer' };
const btnBlue  = { background: 'rgba(33,60,226,.2)', color: '#7b93ff', border: '1px solid rgba(33,60,226,.3)', borderRadius: 4, padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer' };
const lbl      = { fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const BADGE    = { yellow: { background: 'rgba(242,205,26,.12)', color: '#f2cd1a', border: '1px solid rgba(242,205,26,.2)' }, green: { background: 'rgba(34,197,94,.12)', color: '#4ade80', border: '1px solid rgba(34,197,94,.2)' }, red: { background: 'rgba(222,42,42,.15)', color: '#ff7070', border: '1px solid rgba(222,42,42,.25)' }, blue: { background: 'rgba(33,60,226,.2)', color: '#7b93ff', border: '1px solid rgba(33,60,226,.3)' }, orange: { background: 'rgba(255,140,0,.15)', color: '#ffaa33', border: '1px solid rgba(255,140,0,.25)' }, gray: { background: 'rgba(80,80,80,.2)', color: '#888', border: '1px solid rgba(80,80,80,.3)' } };

function StatusBadge({ label: text, tone = 'gray', small }) {
  const s = BADGE[tone] || BADGE.gray;
  return (
    <span style={{ display: 'inline-block', padding: small ? '1px 5px' : '2px 6px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: small ? 8 : 9, letterSpacing: '.04em', textTransform: 'uppercase', ...s }}>
      {text}
    </span>
  );
}

function shipmentTone(status) {
  const s = (status || '').toLowerCase();
  if (s === 'arriving')       return 'yellow';
  if (s === 'in progress')    return 'blue';
  if (s === 'complete')       return 'green';
  if (s === 'closed')         return 'gray';
  return 'gray';
}

// ── Receiving Page ─────────────────────────────────────────────────────────────
export default function ReceivingPage() {
  const { session, perms } = useAuth();
  const { showToast }      = useToast();

  // ── View state ──────────────────────────────────────────────────────────────
  const [view, setView]                   = useState('list');      // 'list' | 'detail'
  const [currentShipmentId, setCurrentShipmentId] = useState(null);

  // ── List view state ──────────────────────────────────────────────────────────
  const [shipments, setShipments]         = useState([]);
  const [upcoming, setUpcoming]           = useState([]);
  const [pos, setPOs]                     = useState([]);
  const [listLoading, setListLoading]     = useState(true);
  const [showNewForm, setShowNewForm]     = useState(false);
  // New shipment form fields
  const [newSup,    setNewSup]            = useState('');
  const [newPO,     setNewPO]             = useState('');
  const [newDate,   setNewDate]           = useState(todayISO());
  const [newBoxes,  setNewBoxes]          = useState('');
  const [newWeight, setNewWeight]         = useState('');
  const [newOrigin, setNewOrigin]         = useState('China');
  const [newFormat, setNewFormat]         = useState('parts');
  const [newNotes,  setNewNotes]          = useState('');
  const [newSubmitting, setNewSubmitting] = useState(false);

  // ── Detail view state ────────────────────────────────────────────────────────
  const [shipmentData, setShipmentData]   = useState(null);    // { shipment, marks, lines }
  const [detailLoading, setDetailLoading] = useState(false);
  const [isFbu, setIsFbu]                 = useState(false);
  const [activeMarkId, setActiveMarkId]   = useState(null);
  const [reconExpanded, setReconExpanded] = useState(false);
  const [boxContentsExpanded, setBoxContentsExpanded] = useState(false);
  const [bagCountCache, setBagCountCache] = useState({});         // line_id → total_bags

  // Mark form
  const [showMarkForm,  setShowMarkForm]  = useState(false);
  const [markTab,       setMarkTab]       = useState('range');
  const [rPrefix,  setRPrefix]            = useState('');
  const [rFrom,    setRFrom]              = useState('1');
  const [rTo,      setRTo]               = useState('');
  const [rSkip,    setRSkip]             = useState('');
  const [rWeight,  setRWeight]           = useState('');
  const [rSubmitting, setRSubmitting]    = useState(false);
  const [sCode,    setSCode]             = useState('');
  const [sWeight,  setSWeight]           = useState('');
  const [sStatus,  setSStatus]           = useState('Received');
  const [sNotes,   setSNotes]            = useState('');
  const [sSubmitting, setSSubmitting]    = useState(false);

  // Box intake
  const [boxQtys,      setBoxQtys]       = useState({});    // key: `${lineId}:OK` or `${lineId}:Damaged`
  const [unexpected,   setUnexpected]    = useState([]);    // [{desc, ok, damaged}]
  const [boxSubmitting, setBoxSubmitting] = useState(false);

  // ── Permission check ─────────────────────────────────────────────────────────
  if (perms && (!perms.receiving || perms.receiving === 'none')) {
    return (
      <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
        <EmptyState message="You do not have permission to access Receiving." />
      </div>
    );
  }

  // ── List loaders ─────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    if (!session) return;
    setListLoading(true);
    try {
      const [shipmentsData, upcomingData, posData] = await Promise.all([
        garageFetch('getShipments',        {}, session),
        garageFetch('getUpcomingShipments', {}, session),
        garageFetch('getPOs',              {}, session),
      ]);
      setShipments(shipmentsData || []);
      setUpcoming(upcomingData   || []);
      setPOs(posData             || []);
    } catch (e) {
      showToast('Failed to load shipments: ' + e.message, 'error');
    } finally {
      setListLoading(false);
    }
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (view === 'list') loadList(); }, [view, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── New shipment form ────────────────────────────────────────────────────────
  function resetNewForm() {
    setNewSup(''); setNewPO(''); setNewDate(todayISO());
    setNewBoxes(''); setNewWeight(''); setNewOrigin('China');
    setNewFormat('parts'); setNewNotes('');
    setShowNewForm(false);
  }

  function prefillFromPO(poNumber) {
    const po = pos.find(p => p.po_number === poNumber);
    if (!po) return;
    setNewPO(poNumber);
    if (po.vendor_name) setNewSup(po.vendor_name);
    if (po.source)      setNewOrigin(po.source);
  }

  async function submitNewShipment() {
    if (!newSup.trim()) { showToast('Enter supplier name', 'error'); return; }
    setNewSubmitting(true);
    try {
      const res = await workerFetch('postShipment', {
        data: {
          supplier:     newSup.trim(),
          po_ref:       newPO.trim() || null,
          arrival_date: newDate || todayISO(),
          total_boxes:  parseInt(newBoxes) || 0,
          total_weight: parseFloat(newWeight) || null,
          origin:       newOrigin,
          receive_format: newFormat,
          notes:        newNotes.trim() || null,
        }
      }, session);
      showToast(res.data.shipment_id + ' created', 'success');
      resetNewForm();
      openShipment(res.data.shipment_id);
    } catch (e) {
      showToast(e.message || 'Failed to create shipment', 'error');
    } finally {
      setNewSubmitting(false);
    }
  }

  // ── Detail: open / refresh ───────────────────────────────────────────────────
  async function openShipment(id) {
    setCurrentShipmentId(id);
    setActiveMarkId(null);
    setReconExpanded(false);
    setBoxContentsExpanded(false);
    setBagCountCache({});
    setBoxQtys({});
    setUnexpected([]);
    setShowMarkForm(false);
    setView('detail');
    await refreshDetail(id);
  }

  async function refreshDetail(id) {
    const shipId = id || currentShipmentId;
    if (!shipId || !session) return;
    setDetailLoading(true);
    try {
      const data = await garageFetch('getShipment', { id: shipId }, session);
      // Parallel fetch receiving entries for each line (TD-024: N+1 — resolve with getShipmentDetail RPC in future)
      if (data.lines && data.lines.length > 0) {
        const entryResults = await Promise.all(
          data.lines.map(l =>
            garageFetch('getReceivingEntries', { line_id: l.line_id }, session)
              .then(d => ({ ok: true, data: d }))
              .catch(() => ({ ok: false, data: [] }))
          )
        );
        data.lines.forEach((l, i) => {
          l._entries = entryResults[i].ok ? (entryResults[i].data || []) : [];
        });
      }
      setShipmentData(data);
      setIsFbu((data.shipment?.receive_format || '') === 'fbu');
    } catch (e) {
      showToast('Failed to load shipment: ' + e.message, 'error');
    } finally {
      setDetailLoading(false);
    }
  }

  function backToList() {
    setView('list');
    setCurrentShipmentId(null);
    setShipmentData(null);
    setActiveMarkId(null);
  }

  // ── Mark form ────────────────────────────────────────────────────────────────
  async function submitMarkRange() {
    if (!rPrefix.trim()) { showToast('Enter a prefix', 'error'); return; }
    const from = parseInt(rFrom) || 1;
    const to   = parseInt(rTo)   || 1;
    if (to < from) { showToast('To must be ≥ From', 'error'); return; }
    const skip   = rSkip ? rSkip.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];
    const weight = parseFloat(rWeight) || null;
    setRSubmitting(true);
    try {
      const res = await workerFetch('postMarkRange', {
        data: { shipment_id: currentShipmentId, prefix: rPrefix.trim(), from, to, skip, weight_per_box: weight }
      }, session);
      showToast(res.data.created + ' marks generated', 'success');
      setShowMarkForm(false);
      setRPrefix(''); setRFrom('1'); setRTo(''); setRSkip(''); setRWeight('');
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Failed to create marks', 'error');
    } finally {
      setRSubmitting(false);
    }
  }

  async function submitMarkSingle() {
    if (!sCode.trim()) { showToast('Enter mark code', 'error'); return; }
    setSSubmitting(true);
    try {
      const res = await workerFetch('postShippingMark', {
        data: {
          shipment_id: currentShipmentId, mark_code: sCode.trim(),
          box_count_expected: 1, box_count_received: 1,
          weight_actual: parseFloat(sWeight) || null,
          status: sStatus,
          notes: sNotes.trim() || null,
        }
      }, session);
      showToast('Mark ' + res.data.mark_id + ' added', 'success');
      setShowMarkForm(false);
      setSCode(''); setSWeight(''); setSStatus('Received'); setSNotes('');
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Failed to add mark', 'error');
    } finally {
      setSSubmitting(false);
    }
  }

  // ── Box intake ────────────────────────────────────────────────────────────────
  function openBoxIntake(markId) {
    setActiveMarkId(markId);
    setBoxQtys({});
    setUnexpected([]);
    if (!reconExpanded) setReconExpanded(true);
  }

  function closeBoxIntake() {
    setActiveMarkId(null);
    setBoxQtys({});
    setUnexpected([]);
  }

  function setBoxQty(lineId, condition, value) {
    const key = `${lineId}:${condition}`;
    setBoxQtys(prev => ({ ...prev, [key]: parseInt(value) || 0 }));
  }

  function addUnexpectedRow() {
    setUnexpected(prev => [...prev, { desc: '', ok: 0, damaged: 0 }]);
  }

  function updateUnexpected(idx, field, value) {
    setUnexpected(prev => prev.map((r, i) => i !== idx ? r : { ...r, [field]: field === 'desc' ? value : parseInt(value) || 0 }));
  }

  function removeUnexpected(idx) {
    setUnexpected(prev => prev.filter((_, i) => i !== idx));
  }

  async function submitBoxIntake() {
    if (!activeMarkId || !currentShipmentId) return;
    const entries = Object.entries(boxQtys)
      .filter(([, qty]) => qty > 0)
      .map(([key, qty]) => {
        const [lineId, condition] = key.split(':');
        return { line_id: lineId, condition, qty };
      });
    const unexpectedItems = unexpected
      .filter(u => u.desc.trim() && (u.ok + u.damaged) > 0)
      .map(u => ({ description: u.desc.trim(), ok_qty: u.ok, damaged_qty: u.damaged }));
    if (!entries.length && !unexpectedItems.length) {
      showToast('Enter at least one qty', 'error'); return;
    }
    setBoxSubmitting(true);
    try {
      const res = await workerFetch('postBoxIntake', {
        data: { shipment_id: currentShipmentId, mark_id: activeMarkId, entries, unexpected: unexpectedItems }
      }, session);
      showToast('Box recorded — ' + res.data.entries_created + ' entries', 'success');
      closeBoxIntake();
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Box intake failed', 'error');
    } finally {
      setBoxSubmitting(false);
    }
  }

  // ── Bags ─────────────────────────────────────────────────────────────────────
  async function generateBagsForLine(lineId) {
    try {
      const res = await workerFetch('generateBags', { data: { line_id: lineId } }, session);
      if (res.data.already_complete) {
        showToast('Bags already fully generated for this line', 'info'); return;
      }
      const total = res.data.total_bags;
      setBagCountCache(prev => ({ ...prev, [lineId]: total }));
      showToast(`${res.data.bags_created} bag(s) generated`, 'success');
    } catch (e) {
      showToast(e.message || 'Failed to generate bags', 'error');
    }
  }

  async function generateAllBags() {
    if (!currentShipmentId) return;
    try {
      const res = await workerFetch('generateBagsForShipment', { data: { shipment_id: currentShipmentId } }, session);
      if (res.data.bags_created > 0) {
        showToast(`${res.data.bags_created} bags generated`, 'success');
        // Refresh bag counts for display
        const lines = (shipmentData?.lines || []).filter(l => !isFbu && (parseInt(l.qty_counted) || 0) > 0);
        const cache = { ...bagCountCache };
        await Promise.all(lines.map(async l => {
          try {
            const bags = await garageFetch('getBags', { line_id: l.line_id }, session);
            if (bags && bags.length) cache[l.line_id] = bags[bags.length - 1]?.total_bags || bags.length;
          } catch {}
        }));
        setBagCountCache(cache);
      } else {
        showToast('All bags already up to date', 'info');
      }
    } catch (e) {
      showToast(e.message || 'Failed to generate bags', 'error');
    }
  }

  async function updateLineBagSize(lineId, newSize) {
    const size = parseInt(newSize);
    if (!size || size < 1) { showToast('Bag size must be at least 1', 'error'); return; }
    try {
      await workerFetch('updateLineBagSize', { data: { line_id: lineId, bags_of: size } }, session);
      showToast('Bag size updated — applies to new bags only', 'info');
    } catch (e) {
      showToast(e.message || 'Failed to update bag size', 'error');
    }
  }

  async function printLineLabels(lineId) {
    try {
      const bags = await garageFetch('getBags', { line_id: lineId }, session);
      if (!bags || !bags.length) { showToast('No bags generated yet — click GEN first', 'error'); return; }
      printWindow(buildBagLabelsHtml(bags, currentShipmentId));
    } catch (e) {
      showToast(e.message || 'Failed to load bags for print', 'error');
    }
  }

  async function printAllLabels() {
    if (!shipmentData) return;
    const countedLines = (shipmentData.lines || []).filter(l => l.status === 'Counted' || l.status === 'GRN Raised');
    if (!countedLines.length) { showToast('No counted lines to print', 'error'); return; }
    try {
      const allBagArrays = await Promise.all(
        countedLines.map(l =>
          garageFetch('getBags', { line_id: l.line_id }, session).then(d => d || []).catch(() => [])
        )
      );
      const allBags = allBagArrays.flat();
      if (!allBags.length) { showToast('No bags generated yet — click GEN ALL first', 'error'); return; }
      printWindow(buildBagLabelsHtml(allBags, currentShipmentId));
    } catch (e) {
      showToast(e.message || 'Failed to load bags for print', 'error');
    }
  }

  // ── Raise GRN from receiving ──────────────────────────────────────────────────
  async function raiseGRN() {
    if (!shipmentData) return;
    const ids = (shipmentData.lines || [])
      .filter(l => (parseInt(l.qty_counted) || 0) > 0 && !l.grn_no)
      .map(l => l.line_id);
    if (!ids.length) { showToast('No counted lines ready for GRN', 'error'); return; }
    try {
      const res = await workerFetch('raiseGRNFromReceiving', {
        data: { shipment_id: currentShipmentId, line_ids: ids }
      }, session);
      showToast(`${res.data.grn_no} raised — ${res.data.lines} lines`, 'success');
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'GRN raise failed', 'error');
    }
  }

  // ── Computed detail values ────────────────────────────────────────────────────
  const shipment = shipmentData?.shipment || {};
  const marks    = shipmentData?.marks    || [];
  const lines    = shipmentData?.lines    || [];

  const hasQtyForGRN   = lines.some(l => (parseInt(l.qty_counted) || 0) > 0 && !l.grn_no);
  const showBagButtons = !isFbu && lines.some(l => l.status === 'Counted' || l.status === 'GRN Raised');

  // ── RENDER: permission guard ──────────────────────────────────────────────────
  // (Early return for no-perms already at top)

  // ── RENDER: list view ─────────────────────────────────────────────────────────
  if (view === 'list') {
    return (
      <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
            Receiving
          </h1>
          <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
            Inbound shipment management — log arrivals, record box contents, raise GRNs.
          </p>
        </div>

        {/* Active shipments */}
        <div style={{ ...panel, marginBottom: 16 }}>
          <div style={panelHdr}>
            <span>Active Shipments</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {listLoading && <Spinner size="sm" />}
              <button style={{ ...btnPri, padding: '3px 12px', fontSize: 11 }} onClick={() => setShowNewForm(f => !f)}>
                {showNewForm ? '✕ Cancel' : '+ New Shipment'}
              </button>
            </div>
          </div>

          {/* New shipment form */}
          {showNewForm && (
            <div style={{ padding: 16, borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
              <div style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t3)', marginBottom: 12 }}>
                Create New Shipment
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 10 }}>
                <div>
                  <span style={lbl}>Supplier *</span>
                  <input style={inp} value={newSup} onChange={e => setNewSup(e.target.value)} placeholder="Supplier name" />
                </div>
                <div>
                  <span style={lbl}>PO Reference</span>
                  <select style={{ ...sel, width: '100%' }} value={newPO} onChange={e => { setNewPO(e.target.value); prefillFromPO(e.target.value); }}>
                    <option value="">— None / Manual —</option>
                    {pos.filter(p => p.status !== 'Closed' && p.status !== 'Cancelled').map(p => (
                      <option key={p.po_number} value={p.po_number}>{p.po_number} · {p.vendor_name || '—'}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <span style={lbl}>Arrival Date</span>
                  <input style={inp} type="date" value={newDate} onChange={e => setNewDate(e.target.value)} />
                </div>
                <div>
                  <span style={lbl}>Expected Boxes</span>
                  <input style={inp} type="number" min="0" value={newBoxes} onChange={e => setNewBoxes(e.target.value)} placeholder="0" />
                </div>
                <div>
                  <span style={lbl}>Total Weight (kg)</span>
                  <input style={inp} type="number" min="0" step="0.1" value={newWeight} onChange={e => setNewWeight(e.target.value)} placeholder="Optional" />
                </div>
                <div>
                  <span style={lbl}>Origin</span>
                  <input style={inp} value={newOrigin} onChange={e => setNewOrigin(e.target.value)} placeholder="China" />
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <span style={lbl}>Receive Format</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={newFormat === 'parts' ? btnPri : btnSec} onClick={() => setNewFormat('parts')}>Parts / CKD</button>
                  <button style={newFormat === 'fbu'   ? btnPri : btnSec} onClick={() => setNewFormat('fbu')}>FBU Units</button>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <span style={lbl}>Notes</span>
                <input style={inp} value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Optional" />
              </div>
              <button style={btnPri} onClick={submitNewShipment} disabled={newSubmitting}>
                {newSubmitting ? 'Creating…' : 'Create Shipment'}
              </button>
            </div>
          )}

          {/* Shipments table */}
          {listLoading && !shipments.length ? (
            <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
          ) : shipments.length === 0 ? (
            <EmptyState message="No shipments yet" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Shipment ID</th>
                    <th style={th}>Supplier</th>
                    <th style={th}>Arrival</th>
                    <th style={th}>Boxes</th>
                    <th style={th}>Format</th>
                    <th style={th}>Progress</th>
                    <th style={th}>Status</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {shipments.map((s, i) => {
                    const progress = s.parts_total > 0
                      ? `${s.parts_grn_raised || 0}/${s.parts_total} GRN'd`
                      : `${s.marks_received || 0}/${s.marks_total || 0} boxes`;
                    const pct = s.parts_total > 0 ? Math.round(((s.parts_grn_raised || 0) / s.parts_total) * 100) : 0;
                    return (
                      <tr key={i} style={{ cursor: 'pointer' }} onClick={() => openShipment(s.shipment_id)}>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{s.shipment_id}</td>
                        <td style={td}>{s.supplier || '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatDisplayDate(s.arrival_date)}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)' }}>{s.total_boxes_received || 0} / {s.total_boxes_expected || 0}</td>
                        <td style={td}>
                          {s.receive_format === 'fbu'
                            ? <StatusBadge label="FBU" tone="blue" />
                            : <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{(s.parts_total || 0)} parts</span>}
                        </td>
                        <td style={td}>
                          <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 3 }}>{progress}</div>
                          {s.parts_total > 0 && (
                            <div style={{ background: 'var(--surface2)', borderRadius: 2, height: 4 }}>
                              <div style={{ background: 'var(--green)', height: 4, borderRadius: 2, width: `${pct}%` }} />
                            </div>
                          )}
                        </td>
                        <td style={td}><StatusBadge label={s.status || '—'} tone={shipmentTone(s.status)} /></td>
                        <td style={td}>
                          <button
                            style={{ ...btnSec, padding: '2px 8px', fontSize: 10 }}
                            onClick={e => { e.stopPropagation(); openShipment(s.shipment_id); }}
                          >
                            Open →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Upcoming POs */}
        {upcoming.length > 0 && (
          <div style={panel}>
            <div style={panelHdr}>
              <span>Upcoming Shipments — Pending POs</span>
              <span style={{ color: 'var(--t3)' }}>{upcoming.length}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>PO Number</th>
                    <th style={th}>Vendor</th>
                    <th style={th}>Expected Delivery</th>
                    <th style={th}>Format</th>
                    <th style={th}>Lines</th>
                    <th style={th}>Qty Outstanding</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((r, i) => {
                    const lines2   = r.outstanding_lines || [];
                    const totalQty = lines2.reduce((s, l) => s + ((l.qty_ordered || 0) - (l.qty_received || 0)), 0);
                    const allFbu   = lines2.length > 0 && lines2.every(l => l.receive_format === 'FBU');
                    const daysUntil = r.expected_delivery
                      ? Math.ceil((new Date(r.expected_delivery) - new Date()) / 86400000)
                      : null;
                    const dateTone = daysUntil !== null ? (daysUntil <= 3 ? 'var(--red)' : daysUntil <= 7 ? 'var(--yellow)' : 'var(--t3)') : 'var(--t3)';
                    const dateStr  = r.expected_delivery
                      ? `${formatDisplayDate(r.expected_delivery)} (${daysUntil !== null ? (daysUntil >= 0 ? `in ${daysUntil}d` : `${Math.abs(daysUntil)}d overdue`) : '—'})`
                      : '—';
                    return (
                      <tr key={i}>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 11 }}>{r.po_number}</td>
                        <td style={td}>{r.vendor_name || '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: dateTone, fontSize: 11 }}>{dateStr}</td>
                        <td style={td}>{allFbu ? <StatusBadge label="FBU" tone="blue" /> : <StatusBadge label="Parts" tone="yellow" />}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)' }}>{lines2.length}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontWeight: 700 }}>{totalQty.toLocaleString()} pcs</td>
                        <td style={td}>
                          <button
                            style={{ ...btnPri, padding: '2px 10px', fontSize: 10 }}
                            onClick={() => {
                              setNewSup(r.vendor_name || '');
                              setNewPO(r.po_number);
                              setNewDate(r.expected_delivery ? r.expected_delivery.slice(0, 10) : todayISO());
                              setNewFormat(allFbu ? 'fbu' : 'parts');
                              setNewOrigin(r.source || 'China');
                              setShowNewForm(true);
                            }}
                          >
                            + Create Shipment
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── RENDER: detail view ───────────────────────────────────────────────────────
  return (
    <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
      {/* Back nav + header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button style={{ ...btnSec, padding: '4px 12px', fontSize: 11 }} onClick={backToList}>← Back</button>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          {currentShipmentId}
        </h1>
        {shipmentData && (
          <StatusBadge label={shipment.status || '—'} tone={shipmentTone(shipment.status)} />
        )}
        {detailLoading && <Spinner size="sm" />}
      </div>

      {detailLoading && !shipmentData ? (
        <div style={{ padding: 64, textAlign: 'center' }}><Spinner /></div>
      ) : !shipmentData ? (
        <EmptyState message="Shipment not found" />
      ) : (
        <>
          {/* Summary card */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Supplier',  value: shipment.supplier || '—' },
              { label: 'Arrival',   value: formatDisplayDate(shipment.arrival_date) },
              { label: 'Boxes',     value: `${shipment.total_boxes_received || 0} / ${shipment.total_boxes_expected || 0}` },
              { label: isFbu ? 'Units' : 'Parts',
                value: `${lines.reduce((s, l) => s + (parseInt(l.qty_counted) || 0), 0)} / ${lines.reduce((s, l) => s + (parseInt(l.qty_expected) || 0), 0)}` },
              { label: 'Format',    value: isFbu ? 'FBU' : 'Parts' },
            ].map(c => (
              <div key={c.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 14px' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', marginBottom: 3 }}>{c.label.toUpperCase()}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 700 }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Action bar */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {hasQtyForGRN && (
              <button style={btnPri} onClick={raiseGRN}>Raise GRN</button>
            )}
            {showBagButtons && (
              <>
                <button style={btnSec} onClick={generateAllBags}>⚙ Gen All Bags</button>
                <button style={btnSec} onClick={printAllLabels}>🖨 Print All Labels</button>
              </>
            )}
            <button style={btnSec} onClick={() => refreshDetail()}>↻ Refresh</button>
          </div>

          {/* Marks panel */}
          <div style={{ ...panel, marginBottom: 16 }}>
            <div style={panelHdr}>
              <span>Shipping Marks ({marks.length})</span>
              <button
                style={{ ...btnSec, padding: '3px 10px', fontSize: 11 }}
                onClick={() => setShowMarkForm(f => !f)}
              >
                {showMarkForm ? '✕ Cancel' : '+ Add Marks'}
              </button>
            </div>

            {/* Mark form */}
            {showMarkForm && (
              <div style={{ padding: 16, borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                  <button style={markTab === 'range'  ? btnPri : btnSec} onClick={() => setMarkTab('range')}>Range</button>
                  <button style={markTab === 'single' ? btnPri : btnSec} onClick={() => setMarkTab('single')}>Single</button>
                </div>
                {markTab === 'range' ? (
                  <div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 10 }}>
                      <div>
                        <span style={lbl}>Prefix *</span>
                        <input style={inp} value={rPrefix} onChange={e => setRPrefix(e.target.value)} placeholder="e.g. BOX-" />
                      </div>
                      <div>
                        <span style={lbl}>From *</span>
                        <input style={inp} type="number" min="1" value={rFrom} onChange={e => setRFrom(e.target.value)} />
                      </div>
                      <div>
                        <span style={lbl}>To *</span>
                        <input style={inp} type="number" min="1" value={rTo} onChange={e => setRTo(e.target.value)} />
                      </div>
                      <div>
                        <span style={lbl}>Skip (comma-separated)</span>
                        <input style={inp} value={rSkip} onChange={e => setRSkip(e.target.value)} placeholder="e.g. 3,7" />
                      </div>
                      <div>
                        <span style={lbl}>Weight/box (kg)</span>
                        <input style={inp} type="number" step="0.1" value={rWeight} onChange={e => setRWeight(e.target.value)} placeholder="Optional" />
                      </div>
                    </div>
                    <button style={btnPri} onClick={submitMarkRange} disabled={rSubmitting}>
                      {rSubmitting ? 'Generating…' : 'Generate Marks'}
                    </button>
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 10 }}>
                      <div>
                        <span style={lbl}>Mark Code *</span>
                        <input style={inp} value={sCode} onChange={e => setSCode(e.target.value)} placeholder="e.g. BOX-1" />
                      </div>
                      <div>
                        <span style={lbl}>Weight (kg)</span>
                        <input style={inp} type="number" step="0.1" value={sWeight} onChange={e => setSWeight(e.target.value)} placeholder="Optional" />
                      </div>
                      <div>
                        <span style={lbl}>Status</span>
                        <select style={{ ...sel, width: '100%' }} value={sStatus} onChange={e => setSStatus(e.target.value)}>
                          <option value="Received">Received</option>
                          <option value="Pending">Pending</option>
                          <option value="Missing">Missing</option>
                          <option value="Damaged">Damaged</option>
                        </select>
                      </div>
                      <div>
                        <span style={lbl}>Notes</span>
                        <input style={inp} value={sNotes} onChange={e => setSNotes(e.target.value)} placeholder="Optional" />
                      </div>
                    </div>
                    <button style={btnPri} onClick={submitMarkSingle} disabled={sSubmitting}>
                      {sSubmitting ? 'Adding…' : 'Add Mark'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Marks table */}
            {marks.length === 0 ? (
              <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--t3)' }}>
                No marks yet — add marks using the form above.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Mark Code</th>
                    <th style={th}>Boxes</th>
                    <th style={th}>Weight</th>
                    <th style={th}>Status</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {marks.map((m, i) => {
                    const isActive = activeMarkId === m.mark_id;
                    // Build count badge from line entries
                    const okQty  = (lines || []).flatMap(l => l._entries || []).filter(e => e.mark_id === m.mark_id && e.condition !== 'Damaged').reduce((s, e) => s + (e.qty || 0), 0);
                    const dmgQty = (lines || []).flatMap(l => l._entries || []).filter(e => e.mark_id === m.mark_id && e.condition === 'Damaged').reduce((s, e) => s + (e.qty || 0), 0);
                    return (
                      <tr key={i} style={isActive ? { background: 'rgba(33,60,226,.06)' } : {}}>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 12 }}>
                          {isActive && <span style={{ color: '#7b93ff', marginRight: 4 }}>▶</span>}
                          {m.mark_code}
                          {(okQty + dmgQty) > 0 && (
                            <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 6px', borderRadius: 2, background: 'rgba(34,197,94,.12)', color: '#4ade80', border: '1px solid rgba(34,197,94,.2)' }}>
                              {okQty} ok{dmgQty > 0 ? ` · ${dmgQty} dmg` : ''}
                            </span>
                          )}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--mono)' }}>{m.box_count_received || 0} / {m.box_count_expected || 1}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                          {m.weight_actual != null ? m.weight_actual + ' kg' : m.weight_expected ? `exp: ${m.weight_expected} kg` : '—'}
                        </td>
                        <td style={td}>
                          <StatusBadge label={m.status || '—'} tone={m.status === 'Received' ? 'green' : m.status === 'Missing' || m.status === 'Damaged' ? 'red' : 'gray'} />
                        </td>
                        <td style={td}>
                          <button
                            style={isActive ? { ...btnBlue, padding: '2px 8px', fontSize: 10 } : { ...btnSec, padding: '2px 8px', fontSize: 10 }}
                            onClick={() => isActive ? closeBoxIntake() : openBoxIntake(m.mark_id)}
                          >
                            {isActive ? '✎ Editing' : 'Open Box'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Box intake panel */}
          {activeMarkId && (
            <div style={{ ...panel, marginBottom: 16, border: '1px solid rgba(33,60,226,.3)' }}>
              <div style={{ ...panelHdr, borderColor: 'rgba(33,60,226,.3)' }}>
                <span style={{ color: '#7b93ff' }}>
                  📦 Box Intake — {marks.find(m => m.mark_id === activeMarkId)?.mark_code || activeMarkId}
                </span>
                <button style={{ ...btnSec, padding: '2px 10px', fontSize: 11 }} onClick={closeBoxIntake}>✕ Close</button>
              </div>
              <div style={{ padding: 16 }}>
                {/* Expected lines grid */}
                {(() => {
                  const expectedLines = lines.filter(l => l.line_type !== 'unexpected');
                  if (!expectedLines.length) {
                    return <p style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 12 }}>No expected items. Link a PO when creating the shipment, or use + Add Unexpected below.</p>;
                  }
                  const cols = isFbu ? '1.2fr 1fr 1fr 80px 80px 80px' : '90px 1fr 80px 80px 80px';
                  return (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '4px 0', marginBottom: 2 }}>
                        {isFbu ? (
                          <><span style={lbl}>Product</span><span style={lbl}>Variant</span><span style={lbl}>Colour</span></>
                        ) : (
                          <><span style={lbl}>Code</span><span style={lbl}>Part Name</span></>
                        )}
                        <span style={{ ...lbl, textAlign: 'right' }}>Expected</span>
                        <span style={{ ...lbl, textAlign: 'center', color: 'var(--green)' }}>✓ OK</span>
                        <span style={{ ...lbl, textAlign: 'center', color: 'var(--red)'   }}>✕ Dmg</span>
                      </div>
                      {expectedLines.map((l, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid rgba(42,42,42,.5)' }}>
                          {isFbu ? (
                            <>
                              <div style={{ fontSize: 12 }}>
                                {l.product || '—'}
                                {l.component_type === 'remote' && <span style={{ marginLeft: 5, fontFamily: 'var(--mono)', fontSize: 9, color: '#7b93ff' }}>Remote</span>}
                                {l.component_type === 'car'    && <span style={{ marginLeft: 5, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)' }}>Car</span>}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--t2)' }}>{l.variant || '—'}</div>
                              <div style={{ fontSize: 11, color: 'var(--t2)' }}>{l.color   || '—'}</div>
                            </>
                          ) : (
                            <>
                              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)' }}>{l.part_code || '—'}</div>
                              <div style={{ fontSize: 11 }}>{l.part_name || '—'}</div>
                            </>
                          )}
                          <div style={{ fontFamily: 'var(--mono)', textAlign: 'right', fontSize: 11, color: 'var(--t3)' }}>{l.qty_expected || 0}</div>
                          <div>
                            <input
                              type="number" min="0"
                              value={boxQtys[`${l.line_id}:OK`] || 0}
                              onChange={e => setBoxQty(l.line_id, 'OK', e.target.value)}
                              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, padding: '4px 6px', color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 13, width: '100%', textAlign: 'center' }}
                            />
                          </div>
                          <div>
                            <input
                              type="number" min="0"
                              value={boxQtys[`${l.line_id}:Damaged`] || 0}
                              onChange={e => setBoxQty(l.line_id, 'Damaged', e.target.value)}
                              style={{ background: 'rgba(222,42,42,.06)', border: '1px solid rgba(222,42,42,.2)', borderRadius: 2, padding: '4px 6px', color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 13, width: '100%', textAlign: 'center' }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Unexpected items */}
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Unexpected Items</span>
                    <button style={{ ...btnSec, padding: '2px 8px', fontSize: 10 }} onClick={addUnexpectedRow}>+ Add Unexpected</button>
                  </div>
                  {unexpected.map((u, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 24px', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <input style={{ ...inp, fontSize: 12 }} placeholder="Description" value={u.desc} onChange={e => updateUnexpected(i, 'desc', e.target.value)} />
                      <input type="number" min="0" style={{ ...inp, textAlign: 'center', padding: '5px' }} placeholder="OK" value={u.ok || ''} onChange={e => updateUnexpected(i, 'ok', e.target.value)} />
                      <input type="number" min="0" style={{ ...inp, textAlign: 'center', padding: '5px', background: 'rgba(222,42,42,.06)', borderColor: 'rgba(222,42,42,.2)', color: 'var(--red)' }} placeholder="Dmg" value={u.damaged || ''} onChange={e => updateUnexpected(i, 'damaged', e.target.value)} />
                      <button onClick={() => removeUnexpected(i)} style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 18 }}>×</button>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 14 }}>
                  <button style={btnPri} onClick={submitBoxIntake} disabled={boxSubmitting}>
                    {boxSubmitting ? 'Submitting…' : 'Submit Box'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Reconciliation — collapsible */}
          <div style={{ ...panel, marginBottom: 16 }}>
            <div
              style={{ ...panelHdr, cursor: 'pointer' }}
              onClick={() => setReconExpanded(e => !e)}
            >
              <span>Reconciliation — Expected vs Counted</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                {reconExpanded ? '▼ Hide' : '▶ Show'}
              </span>
            </div>
            {reconExpanded && (
              <div style={{ overflowX: 'auto' }}>
                {lines.length === 0 ? (
                  <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--t3)' }}>
                    No expected items — link a PO when creating the shipment.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={th}>{isFbu ? 'SKU' : 'Part'}</th>
                        <th style={{ ...th, textAlign: 'right' }}>Expected</th>
                        <th style={{ ...th, textAlign: 'right', color: 'var(--green)' }}>OK</th>
                        <th style={{ ...th, textAlign: 'right', color: 'var(--red)'   }}>Damaged</th>
                        <th style={{ ...th, textAlign: 'right' }}>Total</th>
                        <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                        <th style={th}>GRN</th>
                        <th style={th}>Status</th>
                        {!isFbu && <th style={th}>Bags</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => {
                        const entries     = l._entries || [];
                        const okQty       = entries.filter(e => e.condition !== 'Damaged').reduce((s, e) => s + (parseInt(e.qty) || 0), 0);
                        const dmgQty      = entries.filter(e => e.condition === 'Damaged').reduce((s, e) => s + (parseInt(e.qty) || 0), 0);
                        const totalCounted= okQty + dmgQty;
                        const expected    = parseInt(l.qty_expected) || 0;
                        const short       = Math.max(0, expected - totalCounted);
                        const over        = Math.max(0, totalCounted - expected);

                        const skuLabel = isFbu
                          ? [l.product, l.variant, l.color].filter(Boolean).join(' ')
                          : (l.part_code ? l.part_code + ' · ' + (l.part_name || '') : (l.part_name || '—'));

                        let statusTone = 'gray', statusLabel = 'Pending';
                        if (l.grn_no)              { statusLabel = 'GRN Raised'; statusTone = 'green'; }
                        else if (totalCounted === 0){ statusLabel = 'Pending';    statusTone = 'gray';  }
                        else if (short > 0)         { statusLabel = 'Short';      statusTone = 'red';   }
                        else if (over  > 0)         { statusLabel = 'Over';       statusTone = 'orange';}
                        else if (dmgQty > 0)        { statusLabel = 'Has Damage'; statusTone = 'orange';}
                        else                        { statusLabel = 'Matched';    statusTone = 'green'; }

                        const bagsTotal = bagCountCache[l.line_id];
                        const bagsOf    = l.bags_of || 25;
                        const expBags   = totalCounted > 0 ? Math.ceil(totalCounted / bagsOf) : 0;

                        return (
                          <tr key={i}>
                            <td style={{ ...td, fontSize: 11 }}>
                              {skuLabel}
                              {l.line_type === 'unexpected' && <StatusBadge label="Unexpected" tone="orange" small />}
                            </td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--t3)' }}>{expected || '—'}</td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--green)' }}>{okQty}</td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: dmgQty > 0 ? 'var(--red)' : 'var(--t3)' }}>{dmgQty}</td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700 }}>{totalCounted}</td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                              {short > 0 ? <span style={{ color: 'var(--red)' }}>-{short}</span>
                                : over > 0 ? <span style={{ color: 'var(--yellow)' }}>+{over}</span>
                                : <span style={{ color: 'var(--t3)' }}>—</span>}
                            </td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{l.grn_no || ''}</td>
                            <td style={td}><StatusBadge label={statusLabel} tone={statusTone} /></td>
                            {!isFbu && (
                              <td style={td}>
                                {totalCounted > 0 ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <input
                                      type="number" min="1"
                                      defaultValue={bagsOf}
                                      style={{ width: 50, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, padding: '2px 4px', fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--t1)' }}
                                      onBlur={e => updateLineBagSize(l.line_id, e.target.value)}
                                      title="Pcs per bag"
                                    />
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)', minWidth: 36 }}>
                                      {bagsTotal != null ? bagsTotal + ' gen' : expBags + ' exp'}
                                    </span>
                                    <button
                                      onClick={() => generateBagsForLine(l.line_id)}
                                      style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--t2)', fontSize: 9, fontFamily: 'var(--mono)', padding: '2px 5px', cursor: 'pointer' }}
                                    >Gen</button>
                                    <button
                                      onClick={() => printLineLabels(l.line_id)}
                                      style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--t2)', fontSize: 9, padding: '2px 5px', cursor: 'pointer' }}
                                    >🖨</button>
                                  </div>
                                ) : <span style={{ color: 'var(--t3)', fontSize: 11 }}>—</span>}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* Box contents — collapsible */}
          <div style={panel}>
            <div
              style={{ ...panelHdr, cursor: 'pointer' }}
              onClick={() => setBoxContentsExpanded(e => !e)}
            >
              <span>Box Contents by Mark</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                {boxContentsExpanded ? '▼ Hide' : '▶ Show'}
              </span>
            </div>
            {boxContentsExpanded && (
              <div style={{ padding: 16 }}>
                {marks.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--t3)' }}>No marks yet.</p>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                    {marks.map((m, i) => {
                      // Build per-mark item totals from line entries
                      const items = {};
                      lines.forEach(l => {
                        const skuLabel = isFbu
                          ? [l.product, l.variant, l.color].filter(Boolean).join(' ')
                          : (l.part_code ? l.part_code + ' — ' + (l.part_name || '') : l.part_name || '—');
                        (l._entries || []).forEach(e => {
                          if (e.mark_id !== m.mark_id) return;
                          if (!items[skuLabel]) items[skuLabel] = { ok: 0, damaged: 0 };
                          if (e.condition === 'Damaged') items[skuLabel].damaged += parseInt(e.qty) || 0;
                          else items[skuLabel].ok += parseInt(e.qty) || 0;
                        });
                      });
                      const itemEntries = Object.entries(items);
                      const total = itemEntries.reduce((s, [, v]) => s + v.ok + v.damaged, 0);
                      return (
                        <div key={i} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12 }}>{m.mark_code}</span>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)' }}>{total > 0 ? total + ' units' : 'empty'}</span>
                          </div>
                          {itemEntries.length === 0 ? (
                            <p style={{ fontSize: 11, color: 'var(--t3)' }}>No items recorded</p>
                          ) : (
                            <>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 44px 44px', gap: 6, marginBottom: 4 }}>
                                <span style={{ ...lbl, marginBottom: 0 }}>SKU</span>
                                <span style={{ ...lbl, marginBottom: 0, textAlign: 'right', color: 'var(--green)' }}>OK</span>
                                <span style={{ ...lbl, marginBottom: 0, textAlign: 'right', color: 'var(--red)' }}>Dmg</span>
                              </div>
                              {itemEntries.map(([sku, v], j) => (
                                <div key={j} style={{ display: 'grid', gridTemplateColumns: '1fr 44px 44px', gap: 6, padding: '3px 0', borderBottom: j < itemEntries.length - 1 ? '1px solid rgba(42,42,42,.4)' : 'none' }}>
                                  <span style={{ fontSize: 11 }}>{sku}</span>
                                  <span style={{ fontFamily: 'var(--mono)', textAlign: 'right', fontSize: 11, color: 'var(--green)' }}>{v.ok}</span>
                                  <span style={{ fontFamily: 'var(--mono)', textAlign: 'right', fontSize: 11, color: v.damaged > 0 ? 'var(--red)' : 'var(--t3)' }}>{v.damaged}</span>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
