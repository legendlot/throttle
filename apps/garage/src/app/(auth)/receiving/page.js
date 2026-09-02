'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { EmptyState, Spinner, useToast, printWindow, buildBagLabelsHtml } from '@throttle/ui';
import { todayStr } from '@throttle/domain';

// ── Helpers ────────────────────────────────────────────────────────────────────
// arrival_date is persisted on the shipment — must be the LOCAL calendar day.
// `new Date().toISOString().slice(0,10)` returned YESTERDAY between 00:00–05:30 IST.
const todayISO = todayStr;

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

// ── Style constants ────────────────────────────────────────────────────────────
const panel    = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = { padding: '11px 16px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const th       = { padding: '9px 12px', fontSize: 10.5, textAlign: 'left', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td       = { padding: '11px 12px', fontSize: 13.5, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
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
  // Active-shipments filters (Piyush 2026-06-26): search + format / status / source
  const [fltText,   setFltText]           = useState('');
  const [fltFormat, setFltFormat]         = useState('all');
  const [fltStatus, setFltStatus]         = useState('all');
  const [fltSource, setFltSource]         = useState('all');
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
  // FBU run-model refinement (S180): link an FBU receipt to an open outsourced run → job-work
  // GRN + auto-close. The picker only shows when the declared format is FBU.
  const [newExtRun, setNewExtRun]         = useState('');
  const [newFbuKind, setNewFbuKind]       = useState('');   // '' | 'jobwork' | 'purchase'
  const [extRuns,   setExtRuns]           = useState([]);

  useEffect(() => {
    if (newFormat !== 'fbu') { setExtRuns([]); setNewExtRun(''); setNewFbuKind(''); return; }
    garageFetch('getOpenOutsourcedRuns', {}, session)
      .then(d => setExtRuns(Array.isArray(d?.runs) ? d.runs : []))
      .catch(() => setExtRuns([]));
  }, [newFormat, session]);

  // ── Detail view state ────────────────────────────────────────────────────────
  const [shipmentData, setShipmentData]   = useState(null);    // { shipment, marks, lines }
  const [detailLoading, setDetailLoading] = useState(false);
  const [isFbu, setIsFbu]                 = useState(false);
  const [activeMarkId, setActiveMarkId]   = useState(null);
  const [reconExpanded, setReconExpanded] = useState(false);
  const [boxContentsExpanded, setBoxContentsExpanded] = useState(false);
  const [bagCountCache, setBagCountCache] = useState({});         // line_id → total_bags
  const [missingBagsBusy, setMissingBagsBusy] = useState(false);  // S324 — missing-label print in flight
  const [bagSizeMap, setBagSizeMap]       = useState({});         // part_code → default_bag_size (central catalogue)

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
  const [boxExpects,   setBoxExpects]    = useState({});    // key: line_id → expected qty IN THIS BOX
  const [varReport,    setVarReport]     = useState(null);  // inward variance report payload
  const [varBusy,      setVarBusy]       = useState(false);
  const [unexpected,   setUnexpected]    = useState([]);    // [{desc, ok, damaged}]
  const [boxSubmitting, setBoxSubmitting] = useState(false);
  const [isAmendMode,  setIsAmendMode]   = useState(false); // true when reopening a box that already has entries

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

  // Load central bag-size catalogue once per session for inline pre-fill.
  useEffect(() => {
    if (!session) return;
    workerFetch('getPartBagSizes', {}, session)
      .then(r => {
        if (!r?.ok) return;
        const map = {};
        (r.data || []).forEach(b => { map[b.part_code] = b.default_bag_size || 0; });
        setBagSizeMap(map);
      })
      .catch(() => {});
  }, [session]);

  // Close any open overlay panel on Escape — innermost first
  useEffect(() => {
    function handleEsc(e) {
      if (e.key !== 'Escape') return;
      if (activeMarkId)  { closeBoxIntake();        return; }
      if (showMarkForm)  { setShowMarkForm(false);  return; }
      if (showNewForm)   { setShowNewForm(false);   return; }
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarkId, showMarkForm, showNewForm]);

  // ── New shipment form ────────────────────────────────────────────────────────
  function resetNewForm() {
    setNewSup(''); setNewPO(''); setNewDate(todayISO());
    setNewBoxes(''); setNewWeight(''); setNewOrigin('China');
    setNewFormat('parts'); setNewNotes(''); setNewExtRun(''); setNewFbuKind('');
    setShowNewForm(false);
  }

  function prefillFromPO(poNumber) {
    setNewPO(poNumber);
    const po = pos.find(p => p.po_number === poNumber);
    if (!po) { setNewSup(''); return; }   // cleared selection → clear the PO-derived supplier
    // Supplier is ALWAYS taken from the PO now (no free-text entry) — Afshaan 2026-07-15.
    setNewSup(po.vendor_name || '');
    if (po.source)      setNewOrigin(po.source);
    // FBU unification (Plan 1): default the declared format to the PO's intent when known
    // (receiver confirms/overrides). Best-effort — no-op if the list row lacks the field.
    if (String(po.receive_format || '').toLowerCase() === 'fbu') setNewFormat('fbu');
  }

  async function submitNewShipment() {
    // PO is now MANDATORY — no receiving without a linked purchase order (Afshaan 2026-07-15).
    // Supplier is derived from the PO (never free-typed), so a missing supplier = a PO with no vendor.
    if (!newPO.trim()) { showToast('Select a PO — receiving requires a linked purchase order', 'error'); return; }
    if (!newSup.trim()) { showToast('That PO has no supplier set — fix the PO first', 'error'); return; }
    // RULE-EXT-001 / ITC-04: an FBU receipt is either a job-work return (materials we sent out,
    // built and returned — must reconcile to an EXT run) or an outright purchase of built units.
    // Both used to land with ext_run_no NULL, so the answer and the absence of an answer were the
    // same value — which is why the link had never once been made. Force the choice.
    if (newFormat === 'fbu') {
      if (!newFbuKind) {
        showToast('Say whether these are a job-work return or purchased units', 'error'); return;
      }
      if (newFbuKind === 'jobwork' && !newExtRun) {
        showToast('Pick the outsourced run these units came back against', 'error'); return;
      }
    }
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
          fbu_kind:     newFormat === 'fbu' ? newFbuKind : null,
          ext_run_no:   newFormat === 'fbu' && newFbuKind === 'jobwork' ? (newExtRun || null) : null,
          notes:        newNotes.trim() || null,
        }
      }, session);
      showToast(res.data.shipment_id + ' created', 'success');
      // FBU unification (Plan 1): soft, non-blocking purchase-vs-receipt mismatch flag.
      if (res.data.warning) showToast(res.data.warning, 'error');
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

  // Delete an empty shipment (nothing received yet). Worker enforces the empty guard;
  // the button only shows when the loaded shipment looks empty.
  async function deleteShipment() {
    if (!currentShipmentId) return;
    if (!window.confirm(`Delete shipment ${currentShipmentId}? This only works if nothing has been received against it, and it can't be undone.`)) return;
    setDetailLoading(true);
    try {
      const res = await workerFetch('deleteReceivingShipment', { data: { shipment_id: currentShipmentId } }, session);
      if (!res.ok) throw new Error(res.data || 'Delete failed');
      showToast(`${currentShipmentId} deleted`, 'success');
      backToList();
    } catch (e) {
      showToast(e.message || 'Delete failed', 'error');
    } finally {
      setDetailLoading(false);
    }
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

  // Edit / delete a shipping mark — allowed only while nothing has been counted
  // against it (the worker re-checks: rejects if any receiving_entries exist).
  async function renameMark(m) {
    const next = window.prompt('Edit mark code', m.mark_code);
    if (next == null) return;
    const code = next.trim();
    if (!code || code === m.mark_code) return;
    try {
      await workerFetch('updateShippingMark', { data: { mark_id: m.mark_id, mark_code: code } }, session);
      showToast('Mark renamed', 'success');
      await refreshDetail();
    } catch (e) { showToast(e.message || 'Rename failed', 'error'); }
  }
  async function deleteMark(m) {
    if (!window.confirm(`Delete mark ${m.mark_code}? Only works if nothing has been counted into it.`)) return;
    try {
      await workerFetch('deleteShippingMark', { data: { mark_id: m.mark_id } }, session);
      showToast('Mark deleted', 'success');
      if (activeMarkId === m.mark_id) closeBoxIntake();
      await refreshDetail();
    } catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  // Exp/box is the only thing that makes the inward variance report mean anything, and it
  // was being left unset from memory alone — every row on SHP-154 read "no expected qty
  // set", so the report's headline comparison was dead weight. Afshaan 2026-08-16: tighten
  // the ENTRY, do not stop intake. So this nudges once at box save and the operator can
  // still proceed; after the prompt, whatever is saved (a number, or nothing) is deliberate.
  // Scoped to lines actually being counted whose PO qty is known — there is nothing to
  // expect against on a line the PO never priced, and nagging about those trains it away.
  function confirmMissingBoxExpectations() {
    const countedLineIds = new Set(
      Object.entries(boxQtys)
        .filter(([, qty]) => Number(qty) > 0)
        .map(([key]) => key.split(':')[0])
    );
    const missing = (lines || [])
      .filter(l => l.line_type !== 'unexpected')
      .filter(l => countedLineIds.has(l.line_id))
      .filter(l => (parseInt(l.qty_expected) || 0) > 0)
      .filter(l => !(Number(boxExpects[l.line_id]) > 0));
    if (!missing.length) return true;
    const shown = missing.slice(0, 6).map(l => l.part_code).join(', ');
    const more  = missing.length > 6 ? `, and ${missing.length - 6} more` : '';
    const isOne = missing.length === 1;
    return window.confirm(
      `${missing.length} line${isOne ? '' : 's'} in this box ha${isOne ? 's' : 've'} no Exp/box set:\n${shown}${more}\n\n`
      + 'The inward variance report cannot compare these — they will read "not set" '
      + 'instead of showing a shortfall or an excess.\n\nSave the box anyway?'
    );
  }

  // Persist what was expected in this box alongside the count. Best-effort: a failure
  // here must never lose the counts the operator just entered, so it is logged and
  // swallowed rather than surfaced as a failed intake.
  async function saveBoxExpectations(markId) {
    const expectations = (lines || [])
      .filter(l => l.line_type !== 'unexpected')
      .map(l => ({ part_code: l.part_code, qty_expected: boxExpects[l.line_id] }))
      .filter(e => e.part_code && Number.isFinite(Number(e.qty_expected)));
    if (!expectations.length) return;
    try {
      await workerFetch('setBoxExpectations', { data: { mark_id: markId, expectations } }, session);
    } catch (e) {
      console.warn('[receiving] box expectations not saved:', e?.message);
    }
  }

  // ── Inward variance report ────────────────────────────────────────────────────
  // Scope is "boxes counted since the last report", so it needs no tranche object and
  // copes with boxes turning up days apart.
  async function loadVarianceReport() {
    if (!currentShipmentId) return;
    setVarBusy(true);
    try {
      const r = await workerFetch('getInwardVarianceReport', { data: { shipment_id: currentShipmentId } }, session);
      if (!r?.ok) { showToast(r?.data?.error || 'Could not build report', 'error'); return; }
      setVarReport(r.data);
    } catch (e) {
      showToast(e.message || 'Could not build report', 'error');
    } finally { setVarBusy(false); }
  }

  async function sendVarianceReport() {
    if (!varReport) return;
    const markCodes = varReport.boxes?.codes || [];
    setVarBusy(true);
    try {
      const text = varianceReportText(varReport);
      const ids = (shipmentData?.marks || [])
        .filter(m => markCodes.includes(m.mark_code) || markCodes.includes(m.mark_id))
        .map(m => m.mark_id);

      // The worker stamps the boxes ONLY on a confirmed delivery, so a Slack outage
      // leaves the inward still reportable rather than silently swallowing it — which
      // is why this reads the reply instead of assuming success. `text` posts as the
      // message and `csv` attaches as the file, both via the reports bot; the Incoming
      // Webhook fallback was deleted 2026-09-02 (S332), so a failure now returns Slack's
      // own error in `message` (surfaced in the toast below) instead of degrading to a
      // text-only post that still stamped the boxes. (Channel = SLACK_REPORTS_CHANNEL_ID.)
      const r = await workerFetch('sendInwardVarianceReport',
        { data: { shipment_id: currentShipmentId, mark_ids: ids, text, csv: varianceReportCsv(varReport) } }, session);

      if (r?.ok && r.data?.posted) {
        showToast(`Sent to Slack — ${r.data.marked} box${r.data.marked === 1 ? '' : 'es'} marked as reported`, 'success');
        setVarReport(null);
        await refreshDetail();
        return;
      }
      // Not delivered: fall back to the clipboard and leave the boxes unreported, so
      // nothing is lost and the same report can be sent again once Slack is reachable.
      try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
      showToast(`${r?.data?.message || 'Slack not reachable'} — report copied to clipboard instead; boxes left unreported`, 'info');
    } catch (e) {
      showToast(e.message || 'Send failed', 'error');
    } finally { setVarBusy(false); }
  }

  function varianceReportText(r) {
    const L = [];
    L.push(`Inward variance — ${r.shipment_id}${r.po_reference ? ` (PO ${r.po_reference})` : ''}`);
    L.push(`${r.supplier || ''} · ${r.boxes.in_this_report} box(es) this inward · ${r.boxes.counted}/${r.boxes.total} counted overall`);
    L.push('');
    for (const p of (r.inward || [])) {
      const v = p.variance;
      const tag = v == null ? 'no expected qty set' : v === 0 ? 'matches' : (v > 0 ? `+${v} over` : `${v} short`);
      L.push(`${p.part_code} ${p.part_name} — expected ${p.expected}, received ${p.received}${p.damaged ? `, damaged ${p.damaged}` : ''} (${tag})`);
    }
    // Per-box lines (Piyush asked for the report at box level). Deliberately a
    // SUMMARY here and the full grain in the CSV: a Slack message listing every
    // part of every box is unreadable at 20 boxes, and unreadable gets ignored.
    // Clean boxes are still listed — "which boxes did I already check" is half
    // the value, and silence would read as missing data.
    const boxes = r.by_box || [];
    if (boxes.length) {
      L.push('');
      L.push('By box:');
      for (const b of boxes) {
        const bits = [];
        if (b.short_count) bits.push(`${b.short_count} short`);
        if (b.over_count) bits.push(`${b.over_count} over`);
        if (b.damaged_qty) bits.push(`${b.damaged_qty} damaged`);
        L.push(`  ${b.mark_code} — ${bits.length ? bits.join(', ') : 'matches'}`);
        // Name the offending parts inline; without them the summary tells you a box
        // is wrong but not what to go and count.
        for (const p of b.parts) {
          if (p.variance == null || p.variance === 0) continue;
          L.push(`      ${p.part_code} ${p.part_name} — expected ${p.expected}, received ${p.received} (${p.variance > 0 ? `+${p.variance} over` : `${p.variance} short`})`);
        }
      }
    }
    if (r.po_complete && r.po_summary) {
      L.push('');
      L.push('PO complete:');
      for (const p of r.po_summary) {
        L.push(`  ${p.part_code} — ordered ${p.ordered}, received ${p.received}${p.delta === 0 ? ' (in full)' : p.delta > 0 ? ` (+${p.delta} extra)` : ` (${-p.delta} short)`}`);
      }
    }
    return L.join('\n');
  }

  // Spreadsheet form of the same report, attached alongside the text when the
  // reports bot token is configured (a webhook can only post text). One row per
  // part, PO position folded in as columns so the whole picture is on one sheet.
  function varianceReportCsv(r) {
    const q = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const poBy = {};
    for (const p of (r.po || [])) poBy[p.part_code] = p;
    // `Box` is the first column so the sheet filters by box, which is the whole
    // point of the box-level ask. Two grains share the sheet: one row per
    // box+part, then the arrival total per part on a row marked TOTAL.
    // ⚠️ The PO columns are populated ONLY on the TOTAL rows. PO position is a
    // per-part running figure against the contract, so repeating it on every box
    // row would multiply it by the box count for anyone who sums the column —
    // and a procurement sheet exists to be summed.
    const rows = [[
      'Box', 'Shipment', 'PO', 'Supplier', 'Part code', 'Part name',
      'Expected', 'Received', 'Damaged', 'Variance', 'Status',
      'PO ordered', 'PO received to date', 'PO outstanding',
    ]];
    const status = (v) => v == null ? 'no expected qty set' : v === 0 ? 'matches' : v > 0 ? 'over' : 'short';
    for (const b of (r.by_box || [])) {
      for (const p of b.parts) {
        rows.push([
          b.mark_code, r.shipment_id, r.po_reference || '', r.supplier || '',
          p.part_code, p.part_name,
          p.expected, p.received, p.damaged || 0,
          p.variance == null ? '' : p.variance, status(p.variance),
          '', '', '',
        ]);
      }
    }
    for (const p of (r.inward || [])) {
      const v = p.variance;
      const po = poBy[p.part_code] || {};
      rows.push([
        'TOTAL', r.shipment_id, r.po_reference || '', r.supplier || '',
        p.part_code, p.part_name,
        p.expected, p.received, p.damaged || 0,
        v == null ? '' : v, status(v),
        po.ordered ?? '', po.received_to_date ?? '', po.outstanding ?? '',
      ]);
    }
    return rows.map(r2 => r2.map(q).join(',')).join('\n');
  }

  // ── Box intake ────────────────────────────────────────────────────────────────
  function openBoxIntake(markId) {
    // Pre-fill from already-loaded line entries (refreshDetail loads them per line).
    // Amend mode kicks in if any prior entry exists on this mark.
    const prefilled = {};
    let hasPrior = false;
    (lines || []).forEach(l => {
      (l._entries || [])
        .filter(e => e.mark_id === markId && l.line_type !== 'unexpected')
        .forEach(e => {
          const cond = e.condition === 'Damaged' ? 'Damaged' : 'OK';
          const key  = `${l.line_id}:${cond}`;
          prefilled[key] = (prefilled[key] || 0) + (parseInt(e.qty) || 0);
          hasPrior = true;
        });
    });
    setActiveMarkId(markId);
    setBoxQtys(prefilled);
    setUnexpected([]);
    setIsAmendMode(hasPrior);
    if (!reconExpanded) setReconExpanded(true);
    seedBoxExpectations(markId);
  }

  // Expected qty IN THIS BOX. The PO figure on the line is the whole order, which is
  // why a per-inward variance could never be computed from it (boxes arrive over days).
  // Auto-fill = outstanding ÷ remaining boxes, per Afshaan; always overridable, and a
  // value already saved for this box always wins over the auto-fill.
  async function seedBoxExpectations(markId) {
    const allMarks   = shipmentData?.marks || [];
    const countedIds = new Set((lines || []).flatMap(l => l._entries || []).map(e => e.mark_id).filter(Boolean));
    // This box counts as remaining even if it already has counts (we are re-opening it).
    const remaining  = Math.max(1, allMarks.filter(m => !countedIds.has(m.mark_id) || m.mark_id === markId).length);

    let saved = {};
    try {
      const r = await workerFetch('getBoxExpectations', { data: { mark_id: markId } }, session);
      if (r?.ok) for (const row of (r.data?.expectations || [])) saved[row.part_code] = Number(row.qty_expected);
    } catch { /* first box on this shipment — nothing saved yet */ }

    const next = {};
    (lines || []).filter(l => l.line_type !== 'unexpected').forEach(l => {
      if (saved[l.part_code] != null) { next[l.line_id] = saved[l.part_code]; return; }
      const outstanding = Math.max(0, (parseInt(l.qty_expected) || 0) - (parseInt(l.qty_counted) || 0));
      next[l.line_id] = Math.round(outstanding / remaining);
    });
    setBoxExpects(next);
  }

  function closeBoxIntake() {
    setActiveMarkId(null);
    setBoxQtys({});
    setBoxExpects({});
    setUnexpected([]);
    setIsAmendMode(false);
  }

  function setBoxQty(lineId, condition, value) {
    const key = `${lineId}:${condition}`;
    setBoxQtys(prev => ({ ...prev, [key]: Math.max(0, parseInt(value) || 0) }));
  }

  function addUnexpectedRow() {
    setUnexpected(prev => [...prev, { desc: '', ok: 0, damaged: 0 }]);
  }

  function updateUnexpected(idx, field, value) {
    setUnexpected(prev => prev.map((r, i) => i !== idx ? r : { ...r, [field]: field === 'desc' ? value : Math.max(0, parseInt(value) || 0) }));
  }

  function removeUnexpected(idx) {
    setUnexpected(prev => prev.filter((_, i) => i !== idx));
  }

  async function submitBoxIntake() {
    if (!activeMarkId || !currentShipmentId) return;
    if (isAmendMode) {
      // Overwrite-mode: send every expected line's current OK/Damaged values
      // (including zeros) so the worker can clear cells the user emptied.
      const expectedLineIds = (lines || [])
        .filter(l => l.line_type !== 'unexpected')
        .map(l => l.line_id);
      const amendLines = expectedLineIds.map(lid => ({
        line_id: lid,
        ok_qty:  parseInt(boxQtys[`${lid}:OK`])      || 0,
        dmg_qty: parseInt(boxQtys[`${lid}:Damaged`]) || 0,
      }));
      if (!confirmMissingBoxExpectations()) return;
      setBoxSubmitting(true);
      try {
        const res = await workerFetch('amendBoxIntake', {
          data: { shipment_id: currentShipmentId, mark_id: activeMarkId, lines: amendLines }
        }, session);
        await saveBoxExpectations(activeMarkId);
        const cleaned = res.data?.bags_cleaned_up || 0;
        const topup   = !!res.data?.bags_topped_up_needed;
        let msg = 'Box updated — ' + res.data.entries_created + ' entries';
        if (cleaned > 0) msg += ` · ${cleaned} surplus label${cleaned === 1 ? '' : 's'} removed`;
        showToast(msg, 'success');
        if (topup) {
          showToast('Some lines have more counted qty than generated bags — use "Generate Bags" on the reconciliation row to print additional labels', 'info');
        }
        closeBoxIntake();
        await refreshDetail();
      } catch (e) {
        showToast(e.message || 'Amend failed', 'error');
      } finally {
        setBoxSubmitting(false);
      }
      return;
    }

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
    if (!confirmMissingBoxExpectations()) return;
    setBoxSubmitting(true);
    try {
      const res = await workerFetch('postBoxIntake', {
        data: { shipment_id: currentShipmentId, mark_id: activeMarkId, entries, unexpected: unexpectedItems }
      }, session);
      await saveBoxExpectations(activeMarkId);
      showToast('Box recorded — ' + res.data.entries_created + ' entries', 'success');
      closeBoxIntake();
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Box intake failed', 'error');
    } finally {
      setBoxSubmitting(false);
    }
  }

  async function submitAndPrintBoxLabels() {
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

    // Lines with OK entries — bags are generated from OK qty only
    const okLineIds = [...new Set(
      entries.filter(e => e.condition === 'OK').map(e => e.line_id)
    )];

    if (!confirmMissingBoxExpectations()) return;
    setBoxSubmitting(true);
    try {
      // Step 1: Submit box intake
      await workerFetch('postBoxIntake', {
        data: { shipment_id: currentShipmentId, mark_id: activeMarkId, entries, unexpected: unexpectedItems }
      }, session);
      await saveBoxExpectations(activeMarkId);

      if (okLineIds.length === 0) {
        showToast('Box recorded — no OK qty, no labels to print', 'info');
        closeBoxIntake();
        await refreshDetail();
        return;
      }

      // Step 2: Snapshot existing bag IDs before generating (so we only print new bags)
      const priorBagArrays = await Promise.all(
        okLineIds.map(lid =>
          garageFetch('getBags', { line_id: lid }, session).then(d => d || []).catch(() => [])
        )
      );
      const priorBagIds = new Set(priorBagArrays.flat().map(b => b.bag_id));

      // Step 3: Generate bags for lines touched by this box
      await Promise.all(
        okLineIds.map(lid =>
          workerFetch('generateBags', { data: { line_id: lid } }, session).catch(() => {})
        )
      );

      // Step 4: Fetch bags and isolate only the newly created ones
      const afterBagArrays = await Promise.all(
        okLineIds.map(lid =>
          garageFetch('getBags', { line_id: lid }, session).then(d => d || []).catch(() => [])
        )
      );
      const newBags = afterBagArrays.flat().filter(b => !priorBagIds.has(b.bag_id));

      if (newBags.length === 0) {
        showToast('Box recorded — bags already up to date, nothing new to print', 'info');
      } else {
        printWindow(buildBagLabelsHtml(newBags, currentShipmentId));
        showToast(`Box recorded — ${newBags.length} bag label(s) sent to print`, 'success');
      }

      closeBoxIntake();
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Submit and print failed', 'error');
    } finally {
      setBoxSubmitting(false);
    }
  }

  async function printMarkLabels(markId) {
    const okLineIds = [...new Set(
      lines.flatMap(l =>
        (l._entries || [])
          .filter(e => e.mark_id === markId && e.condition !== 'Damaged' && (e.qty || 0) > 0)
          .map(() => l.line_id)
      )
    )];
    if (!okLineIds.length) {
      showToast('No OK items recorded for this box', 'info'); return;
    }
    try {
      await Promise.all(
        okLineIds.map(lid =>
          workerFetch('generateBags', { data: { line_id: lid } }, session).catch(() => {})
        )
      );

      const bagArrays = await Promise.all(
        okLineIds.map(lid =>
          garageFetch('getBags', { line_id: lid }, session).then(d => d || []).catch(() => [])
        )
      );
      const allBags = bagArrays.flat();

      if (allBags.length === 0) {
        showToast('No bags found for this box', 'info');
      } else {
        printWindow(buildBagLabelsHtml(allBags, currentShipmentId));
        showToast(`${allBags.length} bag label(s) sent to print`, 'success');
      }
    } catch (e) {
      showToast(e.message || 'Failed to print labels for this box', 'error');
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

  // Generate + print ONLY the bag labels a line is short of (S324).
  //
  // The gap this closes: generateBags is append-only and correct, but nothing
  // re-invokes it when a line's qty_counted grows after its box was submitted
  // (a later box, an amend, recompute_line_counts). The label series then stops
  // short permanently — 147 of 1,678 counted lines, ~1,546 bags, measured
  // 2026-08-31 — and the floor, which has physically bagged the full counted
  // quantity, ends up improvising a bag QR that hard-404s at STORE_ISSUE.
  //
  // ⚠️ Prints ONLY the newly-created bags, never the whole series. "Print All
  // Labels" already reprints everything, and a duplicate label lets the SAME
  // physical stock be picked twice (RUN-387 read 500 against a required 100) —
  // which is exactly what the S317 double-print guards exist to stop. Hence the
  // before/after bag-id snapshot, the same shape handleBoxSubmit uses.
  async function generateAndPrintMissingLabels() {
    if (!currentShipmentId) return;
    const shortLines = (shipmentData?.lines || []).filter(l => (l.bags_short || 0) > 0);
    if (!shortLines.length) { showToast('Every counted line already has its labels', 'info'); return; }
    // ⚠️ The BACKLOG item's ⛔ is real and this confirm is how it is honoured:
    // new bags are numbered from existing+1, so they will NOT match a number
    // already written on a bag that somehow carries one. Sticking a second label
    // on an already-labelled bag is the RUN-387 double-pick failure. The labels
    // are only safe on bags that carry NO label at all.
    const shortBags = shortLines.reduce((s, l) => s + (parseInt(l.bags_short) || 0), 0);
    const okToPrint = window.confirm(
      `Print ${shortBags} missing bag label(s) across ${shortLines.length} line(s).\n\n` +
      `These are numbered on from the last label this system printed.\n\n` +
      `Only stick them on bags that have NO label. If a bag already carries a label, ` +
      `do NOT add a second one — the same stock would then be pickable twice.`
    );
    if (!okToPrint) return;
    setMissingBagsBusy(true);
    try {
      const priorArrays = await Promise.all(
        shortLines.map(l =>
          garageFetch('getBags', { line_id: l.line_id }, session).then(d => d || []).catch(() => [])
        )
      );
      const priorIds = new Set(priorArrays.flat().map(b => b.bag_id));

      // ⛔ Per-LINE generateBags, NOT generateBagsForShipment — caught by hostile review.
      // The shipment-wide call mints bags for every line with an un-bagged remainder,
      // which since the bags_present>0 scoping is a WIDER set than the lines counted
      // here. Those extra lines would get bag ROWS while this function prints labels
      // only for the lines it snapshotted — a row with no physical label, i.e. the
      // original bug inverted, and the line's "unlabelled" badge would vanish while
      // nothing had been printed. Per-line keeps generated and printed identical.
      // Concurrent, not a per-row await loop (CORE.md global invariant) — the same
      // Promise.all shape handleBoxSubmit already uses for this exact call.
      // Failures are COUNTED, not swallowed: with a bare .catch(() => {}) a total
      // failure fell through to the "already up to date" toast below, which tells the
      // operator the opposite of what happened (S324 hostile review).
      let mintFailed = 0;
      await Promise.all(shortLines.map(l =>
        workerFetch('generateBags', { data: { line_id: l.line_id } }, session)
          .catch(() => { mintFailed += 1; })
      ));

      const afterArrays = await Promise.all(
        shortLines.map(l =>
          garageFetch('getBags', { line_id: l.line_id }, session).then(d => d || []).catch(() => [])
        )
      );
      const newBags = afterArrays.flat().filter(b => !priorIds.has(b.bag_id));

      if (!newBags.length) {
        showToast(mintFailed
          ? `Could not generate labels for ${mintFailed} line(s) — nothing printed, try again`
          : 'Nothing new to print — labels were already up to date',
          mintFailed ? 'error' : 'info');
      } else {
        printWindow(buildBagLabelsHtml(newBags, currentShipmentId));
        showToast(mintFailed
          ? `${newBags.length} label(s) printed, but ${mintFailed} line(s) failed — check the badges`
          : `${newBags.length} missing bag label(s) sent to print`,
          mintFailed ? 'error' : 'success');
      }
      await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Failed to generate missing labels', 'error');
    } finally {
      setMissingBagsBusy(false);
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
  async function raiseGRN(force = false) {
    if (!shipmentData) return;
    const ids = (shipmentData.lines || [])
      .filter(l => (parseInt(l.qty_counted) || 0) > (parseInt(l.qty_grn) || 0))
      .map(l => l.line_id);
    if (!ids.length) { showToast('No counted lines ready for GRN', 'error'); return; }
    try {
      const res = await workerFetch('raiseGRNFromReceiving', {
        data: { shipment_id: currentShipmentId, line_ids: ids, force }
      }, session);
      showToast(`${res.data.grn_no} raised — ${res.data.lines} lines`, 'success');
      await refreshDetail();
    } catch (e) {
      const msg = e.message || 'GRN raise failed';
      // Wrong-code guard: the worker blocks a receipt landing on a superseded/discontinued
      // code and returns a `GRN_CODE_GUARD:` message. Offer an informed override.
      if (!force && msg.startsWith('GRN_CODE_GUARD:')) {
        const clean = msg.replace(/^GRN_CODE_GUARD:\s*/, '');
        if (window.confirm(`Heads up — ${clean}\n\nPost anyway?`)) return raiseGRN(true);
        return;
      }
      showToast(msg, 'error');
    }
  }

  // ── Re-sync receiving lines from the current BOM (L67 / PATTERN-128) ───────────
  // Additively pulls any BOM part added/reactivated after this shipment was seeded.
  async function resyncFromBOM() {
    if (!currentShipmentId) return;
    try {
      const res = await workerFetch('resyncReceivingFromBOM', { data: { shipment_id: currentShipmentId } }, session);
      const n = res.data?.added || 0;
      showToast(n ? `Re-synced — ${n} new line${n === 1 ? '' : 's'} added from BOM` : 'Already in sync — no missing BOM parts', 'success');
      if (n) await refreshDetail();
    } catch (e) {
      showToast(e.message || 'Re-sync failed', 'error');
    }
  }

  // ── Computed detail values ────────────────────────────────────────────────────
  const shipment = shipmentData?.shipment || {};
  const marks    = shipmentData?.marks    || [];
  const lines    = shipmentData?.lines    || [];

  const hasQtyForGRN   = lines.some(l => (parseInt(l.qty_counted) || 0) > (parseInt(l.qty_grn) || 0));
  const showBagButtons = !isFbu && lines.some(l => l.status === 'Counted' || l.status === 'GRN Raised');
  // S324 — bags a line was counted for but never got a label printed for.
  // Server-computed (getShipment → store.bag_coverage); absent on an older
  // worker, in which case this is 0 and the button simply does not appear.
  const bagsShortTotal = lines.reduce((s, l) => s + (parseInt(l.bags_short) || 0), 0);
  // Empty shipment = nothing received: no boxes in, no counted/GRN'd lines (expected-only
  // lines from a PO are fine). Only then is the Delete button offered (worker re-checks).
  const shipmentEmpty  = !!shipmentData
    && (parseInt(shipment.total_boxes_received) || 0) === 0
    && lines.every(l => (parseInt(l.qty_counted) || 0) === 0 && (parseInt(l.qty_grn) || 0) === 0 && !l.grn_no);

  // ── RENDER: permission guard ──────────────────────────────────────────────────
  // Must run AFTER all hooks (Rules of Hooks). Moved here from above the
  // hook block to fix the conditional-hook violation surfaced by ESLint S77.
  if (perms && (!perms.receiving || perms.receiving === 'none')) {
    return (
      <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
        <EmptyState message="You do not have permission to access Receiving." />
      </div>
    );
  }

  // ── RENDER: list view ─────────────────────────────────────────────────────────
  if (view === 'list') {
    // Active-shipments filtering (Piyush 2026-06-26). Source/Status options derived
    // from the loaded rows; search matches Shipment ID, Supplier (vendor) and PO ref.
    const norm        = v => (v == null ? '' : String(v)).toLowerCase();
    const sourceOpts  = [...new Set(shipments.map(s => s.origin).filter(Boolean))].sort();
    const statusOpts  = [...new Set(shipments.map(s => s.status).filter(Boolean))].sort();
    const q           = fltText.trim().toLowerCase();
    const filteredShipments = shipments.filter(s => {
      if (fltFormat !== 'all') {
        const isFbuRow = (s.receive_format || '') === 'fbu';
        if (fltFormat === 'fbu'   && !isFbuRow) return false;
        if (fltFormat === 'parts' &&  isFbuRow) return false;
      }
      if (fltStatus !== 'all' && (s.status || '') !== fltStatus) return false;
      if (fltSource !== 'all' && (s.origin || '') !== fltSource) return false;
      if (q && !(norm(s.shipment_id).includes(q) || norm(s.supplier).includes(q) || norm(s.po_reference).includes(q))) return false;
      return true;
    });
    const fltActive = !!q || fltFormat !== 'all' || fltStatus !== 'all' || fltSource !== 'all';

    return (
      <div style={{ padding: '16px 24px', color: 'var(--t1)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
            Receiving
          </h1>
          <p style={{ color: 'var(--t3)', fontSize: 13, marginTop: 5, fontFamily: 'var(--mono)' }}>
            Inbound shipment management — log arrivals, record box contents, raise GRNs.
          </p>
        </div>

        {/* Active shipments — ordered below Upcoming (§5: Upcoming first) */}
        <div style={{ ...panel, marginBottom: 16, order: 2 }}>
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
                  <span style={lbl}>PO Reference *</span>
                  <select style={{ ...sel, width: '100%' }} value={newPO} onChange={e => prefillFromPO(e.target.value)}>
                    <option value="">— Select PO (required) —</option>
                    {pos.filter(p => p.status !== 'Closed' && p.status !== 'Cancelled').map(p => (
                      <option key={p.po_number} value={p.po_number}>{p.po_number} · {p.vendor_name || '—'}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <span style={lbl}>Supplier (from PO)</span>
                  <input style={{ ...inp, opacity: 0.7, cursor: 'not-allowed' }} value={newSup} readOnly placeholder="Select a PO first" />
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
              {/* ⚠️ Renders whenever the format is FBU — NOT gated on extRuns.length. It used to be,
                  so when no run was open the control vanished entirely and the receiver could not
                  know the link existed. A silently absent field is worse than an empty one. */}
              {newFormat === 'fbu' && (
                <div style={{ marginBottom: 10 }}>
                  <span style={lbl}>Where did these units come from? · required</span>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button
                      style={newFbuKind === 'jobwork' ? btnPri : btnSec}
                      onClick={() => setNewFbuKind('jobwork')}
                    >Job-work return</button>
                    <button
                      style={newFbuKind === 'purchase' ? btnPri : btnSec}
                      onClick={() => { setNewFbuKind('purchase'); setNewExtRun(''); }}
                    >Purchased built units</button>
                  </div>
                  {newFbuKind === 'jobwork' && (
                    <div style={{ marginTop: 8 }}>
                      {extRuns.length > 0 ? (
                        <select style={inp} value={newExtRun} onChange={e => setNewExtRun(e.target.value)}>
                          <option value="">— Select the outsourced run —</option>
                          {extRuns.map(r => <option key={r.run_no} value={r.run_no}>{r.run_no} · {r.product} ({r.status})</option>)}
                        </select>
                      ) : (
                        <p style={{ margin: 0, fontSize: 12, color: '#b45309' }}>
                          No outsourced run is open to link to. Raise or issue the run first, or
                          record this as purchased units.
                        </p>
                      )}
                      <p style={{ margin: '6px 0 0', fontSize: 11, opacity: .7 }}>
                        Links the returned units to the materials sent out, for ITC-04.
                      </p>
                    </div>
                  )}
                </div>
              )}
              <div style={{ marginBottom: 12 }}>
                <span style={lbl}>Notes</span>
                <input style={inp} value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Optional" />
              </div>
              <button style={btnPri} onClick={submitNewShipment} disabled={newSubmitting}>
                {newSubmitting ? 'Creating…' : 'Create Shipment'}
              </button>
            </div>
          )}

          {/* Filters (Piyush 2026-06-26) — search + format / status / source */}
          {shipments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
              <input
                style={{ ...inp, width: 'auto', flex: '1 1 200px', minWidth: 180 }}
                value={fltText}
                onChange={e => setFltText(e.target.value)}
                placeholder="Search ID / supplier / PO…"
              />
              <select style={sel} value={fltFormat} onChange={e => setFltFormat(e.target.value)}>
                <option value="all">All formats</option>
                <option value="parts">Parts / CKD</option>
                <option value="fbu">FBU</option>
              </select>
              <select style={sel} value={fltStatus} onChange={e => setFltStatus(e.target.value)}>
                <option value="all">All statuses</option>
                {statusOpts.map(st => <option key={st} value={st}>{st}</option>)}
              </select>
              <select style={sel} value={fltSource} onChange={e => setFltSource(e.target.value)}>
                <option value="all">All sources</option>
                {sourceOpts.map(sc => <option key={sc} value={sc}>{sc}</option>)}
              </select>
              {fltActive && (
                <button
                  style={{ ...btnSec, padding: '6px 12px' }}
                  onClick={() => { setFltText(''); setFltFormat('all'); setFltStatus('all'); setFltSource('all'); }}
                >
                  Clear
                </button>
              )}
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>
                {filteredShipments.length} of {shipments.length}
              </span>
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
                  {filteredShipments.length === 0 ? (
                    <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: 'var(--t3)' }}>No shipments match the filters</td></tr>
                  ) : filteredShipments.map((s, i) => {
                    const progress = s.parts_total > 0
                      ? `${s.parts_grn_raised || 0}/${s.parts_total} GRN'd`
                      : `${s.marks_received || 0}/${s.marks_total || 0} boxes`;
                    const pct = s.parts_total > 0 ? Math.round(((s.parts_grn_raised || 0) / s.parts_total) * 100) : 0;
                    // §3: a fully-GRN'd (or fully-received-box) shipment shouldn't keep
                    // reading "Arriving" — surface that it's done. Falls back to the
                    // raw status while still in progress.
                    const partsDone = s.parts_total > 0 && (s.parts_grn_raised || 0) >= s.parts_total;
                    const boxesDone = !s.parts_total && (s.marks_total || 0) > 0 && (s.marks_received || 0) >= s.marks_total;
                    const isDone = (s.status || '').toLowerCase() !== 'complete' && (partsDone || boxesDone);
                    const dispLabel = (s.status || '').toLowerCase() === 'complete'
                      ? s.status
                      : (partsDone ? "GRN'd" : (boxesDone ? 'Received' : (s.status || '—')));
                    const dispTone = (isDone || (s.status || '').toLowerCase() === 'complete') ? 'green' : shipmentTone(s.status);
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
                        <td style={td}><StatusBadge label={dispLabel} tone={dispTone} /></td>
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

        {/* Upcoming POs — moved to the TOP (§5) */}
        {upcoming.length > 0 && (
          <div style={{ ...panel, marginBottom: 16, order: 1 }}>
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
                    // Applied as text color. Use state-error-fg for the urgent case (PATTERN-054).
                    // Yellow keeps as brand accent for the warning case (passes AAA on dark).
                    const dateTone = daysUntil !== null ? (daysUntil <= 3 ? 'var(--state-error-fg)' : daysUntil <= 7 ? 'var(--yellow)' : 'var(--t3)') : 'var(--t3)';
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
              <button style={btnPri} onClick={() => raiseGRN()}>Raise GRN</button>
            )}
            {showBagButtons && (
              <>
                <button style={btnSec} onClick={generateAllBags}>⚙ Gen All Bags</button>
                <button style={btnSec} onClick={printAllLabels}>🖨 Print All Labels</button>
                {bagsShortTotal > 0 && (
                  <button
                    style={{ ...btnSec, color: 'var(--yellow)', borderColor: 'rgba(214,168,42,.45)' }}
                    onClick={generateAndPrintMissingLabels}
                    disabled={missingBagsBusy}
                    title="Generate and print ONLY the labels these lines are short of — does not reprint existing labels"
                  >
                    {missingBagsBusy ? '…' : `🏷 Print ${bagsShortTotal} missing label${bagsShortTotal === 1 ? '' : 's'}`}
                  </button>
                )}
              </>
            )}
            {shipment.po_reference && (
              <button style={btnSec} onClick={resyncFromBOM} title="Add any BOM part created/reactivated after this shipment was set up">⟳ Re-sync from BOM</button>
            )}
            <button style={btnSec} onClick={() => refreshDetail()}>↻ Refresh</button>
            {shipmentEmpty && (
              <button
                style={{ ...btnSec, color: '#ff7070', borderColor: 'rgba(222,42,42,.3)', marginLeft: 'auto' }}
                onClick={deleteShipment}
                title="Delete this shipment — only works while nothing has been received against it"
              >🗑 Delete shipment</button>
            )}
          </div>

          {/* Inward variance report — expected vs received for the boxes counted since
              the last report. Deliberately separate from the PO totals above, which only
              become conclusive once nothing is outstanding. */}
          <div style={{ ...panel, marginBottom: 16 }}>
            <div style={panelHdr}>
              <span>Inward Variance</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button onClick={loadVarianceReport} disabled={varBusy} style={btnSec}>
                  {varBusy ? 'WORKING…' : (varReport ? '↻ REFRESH' : 'BUILD REPORT')}
                </button>
                {varReport && !varReport.nothing_to_report && (
                  <button onClick={sendVarianceReport} disabled={varBusy} style={btnPri}>SEND REPORT</button>
                )}
              </span>
            </div>
            <div style={{ padding: 12 }}>
              {!varReport ? (
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>
                  Build a report after an inward to compare what was <strong>expected in the boxes you just counted</strong> against what actually arrived.
                  It covers only boxes counted since the last report, so run it after each arrival.
                </div>
              ) : varReport.nothing_to_report ? (
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>No newly counted boxes since the last report.</div>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 8 }}>
                    <strong>{varReport.boxes.in_this_report}</strong> box(es) in this report · {varReport.boxes.counted}/{varReport.boxes.total} counted overall
                    {varReport.po_reference ? <> · PO <span style={{ fontFamily: 'var(--mono)' }}>{varReport.po_reference}</span></> : null}
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={th}>Part</th>
                      <th style={{ ...th, textAlign: 'right' }}>Expected</th>
                      <th style={{ ...th, textAlign: 'right' }}>Received</th>
                      <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                      <th style={{ ...th, textAlign: 'right' }}>PO outstanding</th>
                    </tr></thead>
                    <tbody>
                      {varReport.inward.map(p => {
                        const po = (varReport.po || []).find(x => x.part_code === p.part_code);
                        const v  = p.variance;
                        const tone = v == null ? 'var(--t3)' : v === 0 ? 'var(--state-success-fg)' : '#f59e0b';
                        return (
                          <tr key={p.part_code}>
                            <td style={td}>
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)' }}>{p.part_code}</span>
                              <span style={{ marginLeft: 6, fontSize: 11 }}>{p.part_name}</span>
                            </td>
                            <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)' }}>{p.expected || (v == null ? '—' : 0)}</td>
                            <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)' }}>
                              {p.received}{p.damaged ? <span style={{ color: 'var(--state-error-fg)', fontSize: 10 }}> +{p.damaged} dmg</span> : null}
                            </td>
                            <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: tone }}>
                              {v == null ? 'not set' : v === 0 ? 'match' : (v > 0 ? `+${v}` : v)}
                            </td>
                            <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{po ? po.outstanding : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {/* By box — the same inward split per box, so a short count points at
                      the box to go and recount rather than at the arrival as a whole.
                      Summary only on screen (and in the Slack text); the CSV carries
                      every box×part row for anyone who wants to filter it. */}
                  {(varReport.by_box || []).length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '.06em', marginBottom: 5 }}>BY BOX</div>
                      {varReport.by_box.map(b => {
                        const off = b.parts.filter(p => p.variance != null && p.variance !== 0);
                        const clean = !off.length && !b.damaged_qty;
                        return (
                          <div key={b.mark_id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)', minWidth: 90 }}>{b.mark_code}</span>
                            <span style={{ color: clean ? 'var(--state-success-fg)' : '#f59e0b' }}>
                              {clean ? 'matches' : [
                                b.short_count ? `${b.short_count} short` : null,
                                b.over_count ? `${b.over_count} over` : null,
                                b.damaged_qty ? `${b.damaged_qty} damaged` : null,
                              ].filter(Boolean).join(' · ')}
                            </span>
                            {off.length > 0 && (
                              <span style={{ color: 'var(--t3)', fontSize: 10, fontFamily: 'var(--mono)' }}>
                                {off.map(p => `${p.part_code} ${p.variance > 0 ? `+${p.variance}` : p.variance}`).join('  ')}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {varReport.po_complete && (
                    <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(16,140,90,.08)', border: '1px solid rgba(16,140,90,.25)', borderRadius: 3, fontSize: 11 }}>
                      <strong>PO fully received.</strong>{' '}
                      {(varReport.po_summary || []).map(p => (
                        <span key={p.part_code} style={{ marginRight: 10, fontFamily: 'var(--mono)' }}>
                          {p.part_code}: {p.delta === 0 ? 'in full' : p.delta > 0 ? `+${p.delta} extra` : `${-p.delta} short`}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--t3)' }}>
                    {/* Deliberately unnamed: the channel lives in the webhook URL / token config,
                        so hardcoding a name here goes stale the moment it is re-pointed — which is
                        exactly what happened (this said #inwarding-reports long after the report
                        had moved to #procurement-core). */}
                    Send posts the report to Slack and marks these boxes as reported. If Slack cannot be reached it copies to your clipboard instead and leaves the boxes unreported, so nothing is lost.
                  </div>
                </>
              )}
            </div>
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
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                            <button
                              style={isActive ? { ...btnBlue, padding: '2px 8px', fontSize: 10 } : { ...btnSec, padding: '2px 8px', fontSize: 10 }}
                              onClick={() => isActive ? closeBoxIntake() : openBoxIntake(m.mark_id)}
                            >
                              {isActive ? '✎ Editing' : (okQty + dmgQty) > 0 ? '✎ Edit' : 'Open Box'}
                            </button>
                            {(okQty + dmgQty) === 0 && !isActive && (
                              <>
                                <button style={{ ...btnSec, padding: '2px 8px', fontSize: 10 }} title="Edit mark code" onClick={() => renameMark(m)}>✎ Code</button>
                                <button style={{ ...btnSec, padding: '2px 8px', fontSize: 10, color: '#ff7070', borderColor: 'rgba(222,42,42,.3)' }} title="Delete this empty mark" onClick={() => deleteMark(m)}>🗑</button>
                              </>
                            )}
                          </div>
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
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {isAmendMode && (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 6px', borderRadius: 2, background: 'rgba(255,180,0,.12)', color: 'var(--yellow)', border: '1px solid rgba(255,180,0,.25)' }}>
                      AMEND
                    </span>
                  )}
                  {!isAmendMode && Object.values(boxQtys).some(v => v > 0) && (
                    <button
                      style={{ ...btnSec, padding: '2px 10px', fontSize: 11 }}
                      onClick={submitAndPrintBoxLabels}
                      disabled={boxSubmitting}
                    >
                      🖨 Submit &amp; Print Labels
                    </button>
                  )}
                  <button style={{ ...btnSec, padding: '2px 10px', fontSize: 11 }} onClick={closeBoxIntake}>✕ Close</button>
                </div>
              </div>
              <div style={{ padding: 16 }}>
                {/* Expected lines grid */}
                {(() => {
                  const expectedLines = lines.filter(l => l.line_type !== 'unexpected');
                  if (!expectedLines.length) {
                    return <p style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 12 }}>No expected items. Link a PO when creating the shipment, or use + Add Unexpected below.</p>;
                  }
                  const cols = isFbu ? '1.2fr 1fr 1fr 80px 80px 80px 80px' : '90px 1fr 80px 80px 80px 80px';
                  return (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '4px 0', marginBottom: 2 }}>
                        {isFbu ? (
                          <><span style={lbl}>Product</span><span style={lbl}>Variant</span><span style={lbl}>Colour</span></>
                        ) : (
                          <><span style={lbl}>Code</span><span style={lbl}>Part Name</span></>
                        )}
                        <span style={{ ...lbl, textAlign: 'right' }} title="Total ordered on the PO">PO Qty</span>
                        <span style={{ ...lbl, textAlign: 'center' }} title="Expected in THIS box — auto-filled as outstanding ÷ remaining boxes, override as needed">Exp/box</span>
                        <span style={{ ...lbl, textAlign: 'center', color: 'var(--state-success-fg)' }}>✓ OK</span>
                        <span style={{ ...lbl, textAlign: 'center', color: 'var(--state-error-fg)'   }}>✕ Dmg</span>
                      </div>
                      {expectedLines.map((l, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'var(--surface2)' : 'transparent' }}>
                          {isFbu ? (
                            <>
                              <div style={{ fontSize: 12 }}>
                                {l.product || '—'}
                                {l.component_type === 'remote' && <span style={{ marginLeft: 5, fontFamily: 'var(--mono)', fontSize: 9, color: '#7b93ff' }}>Remote</span>}
                                {l.component_type === 'car'    && <span style={{ marginLeft: 5, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--state-success-fg)' }}>Car</span>}
                                {l.component_type === 'drone'  && <span style={{ marginLeft: 5, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--state-warning-fg)' }}>Drone</span>}
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
                              value={boxExpects[l.line_id] ?? ''}
                              onChange={e => setBoxExpects(prev => ({ ...prev, [l.line_id]: Math.max(0, parseInt(e.target.value) || 0) }))}
                              title="Expected in this box. Auto-filled from outstanding ÷ remaining boxes — change it if this box is different."
                              style={{ background: 'var(--surface2)', border: '1px dashed var(--border)', borderRadius: 2, padding: '4px 6px', color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 13, width: '100%', textAlign: 'center' }}
                            />
                          </div>
                          {(() => {
                            // Flag only, never block — Piyush's explicit answer: "just flag it
                            // and let the counter carry on."
                            const exp = boxExpects[l.line_id];
                            const got = parseInt(boxQtys[`${l.line_id}:OK`]) || 0;
                            const typed = boxQtys[`${l.line_id}:OK`] !== undefined && boxQtys[`${l.line_id}:OK`] !== '';
                            const off = typed && exp != null && exp > 0 && got !== exp;
                            return (
                              <div style={{ position: 'relative' }}>
                                <input
                                  type="number" min="0"
                                  value={boxQtys[`${l.line_id}:OK`] || ''}
                                  onChange={e => setBoxQty(l.line_id, 'OK', e.target.value)}
                                  title={off ? `Expected ${exp} in this box, counted ${got} (${got > exp ? '+' : ''}${got - exp})` : undefined}
                                  style={{ background: off ? 'rgba(245,158,11,.10)' : 'var(--surface2)', border: `1px solid ${off ? 'rgba(245,158,11,.55)' : 'var(--border)'}`, borderRadius: 2, padding: '4px 6px', color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 13, width: '100%', textAlign: 'center' }}
                                />
                                {off && (
                                  <span style={{ position: 'absolute', right: 3, top: -8, fontFamily: 'var(--mono)', fontSize: 9, color: '#f59e0b', background: 'var(--surface)', padding: '0 3px', borderRadius: 2 }}>
                                    {got > exp ? '+' : ''}{got - exp}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                          <div>
                            <input
                              type="number" min="0"
                              value={boxQtys[`${l.line_id}:Damaged`] || ''}
                              onChange={e => setBoxQty(l.line_id, 'Damaged', e.target.value)}
                              style={{ background: 'rgba(222,42,42,.06)', border: '1px solid rgba(222,42,42,.2)', borderRadius: 2, padding: '4px 6px', color: 'var(--state-error-fg)', fontFamily: 'var(--mono)', fontSize: 13, width: '100%', textAlign: 'center' }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Unexpected items — hidden in amend mode (amend overwrites expected lines only) */}
                {!isAmendMode && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Unexpected Items</span>
                    <button style={{ ...btnSec, padding: '2px 8px', fontSize: 10 }} onClick={addUnexpectedRow}>+ Add Unexpected</button>
                  </div>
                  {unexpected.map((u, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 24px', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <input style={{ ...inp, fontSize: 12 }} placeholder="Description" value={u.desc} onChange={e => updateUnexpected(i, 'desc', e.target.value)} />
                      <input type="number" min="0" style={{ ...inp, textAlign: 'center', padding: '5px' }} placeholder="OK" value={u.ok || ''} onChange={e => updateUnexpected(i, 'ok', e.target.value)} />
                      <input type="number" min="0" style={{ ...inp, textAlign: 'center', padding: '5px', background: 'rgba(222,42,42,.06)', borderColor: 'rgba(222,42,42,.2)', color: 'var(--state-error-fg)' }} placeholder="Dmg" value={u.damaged || ''} onChange={e => updateUnexpected(i, 'damaged', e.target.value)} />
                      <button onClick={() => removeUnexpected(i)} style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 18 }}>×</button>
                    </div>
                  ))}
                </div>
                )}

                <div style={{ marginTop: 14 }}>
                  <button style={btnPri} onClick={submitBoxIntake} disabled={boxSubmitting}>
                    {boxSubmitting ? 'Submitting…' : isAmendMode ? 'Save Changes' : 'Submit Box'}
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
                        <th style={{ ...th, textAlign: 'right', color: 'var(--state-success-fg)' }}>OK</th>
                        <th style={{ ...th, textAlign: 'right', color: 'var(--state-error-fg)'   }}>Damaged</th>
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
                        const grnQty = parseInt(l.qty_grn) || 0;
                        if (grnQty > 0 && grnQty >= totalCounted) { statusLabel = 'GRN Raised'; statusTone = 'green'; }
                        else if (grnQty > 0)        { statusLabel = `GRN'd ${grnQty}/${totalCounted}`; statusTone = 'orange'; }
                        else if (totalCounted === 0){ statusLabel = 'Pending';    statusTone = 'gray';  }
                        else if (short > 0)         { statusLabel = 'Short';      statusTone = 'red';   }
                        else if (over  > 0)         { statusLabel = 'Over';       statusTone = 'orange';}
                        else if (dmgQty > 0)        { statusLabel = 'Has Damage'; statusTone = 'orange';}
                        else                        { statusLabel = 'Matched';    statusTone = 'green'; }

                        const bagsOf    = l.bags_of || bagSizeMap[l.part_code] || 50;
                        const expBags   = totalCounted > 0 ? Math.ceil(totalCounted / bagsOf) : 0;
                        // Prefer the server's live count (S324) over the click-populated
                        // cache — the cache is only filled after Gen All, so before that
                        // every line read "N exp" whether or not it had any bags at all.
                        const bagsPresent = l.bags_present != null
                          ? Number(l.bags_present)
                          : bagCountCache[l.line_id];
                        const bagsShort   = parseInt(l.bags_short) || 0;

                        return (
                          <tr key={i}>
                            <td style={{ ...td, fontSize: 11 }}>
                              {skuLabel}
                              {l.line_type === 'unexpected' && <StatusBadge label="Unexpected" tone="orange" small />}
                            </td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--t3)' }}>{expected || '—'}</td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--state-success-fg)' }}>{okQty}</td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: dmgQty > 0 ? 'var(--red)' : 'var(--t3)' }}>{dmgQty}</td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700 }}>{totalCounted}</td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                              {short > 0 ? <span style={{ color: 'var(--state-error-fg)' }}>-{short}</span>
                                : over > 0 ? <span style={{ color: 'var(--yellow)' }}>+{over}</span>
                                : <span style={{ color: 'var(--t3)' }}>—</span>}
                            </td>
                            <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--state-success-fg)' }}>{l.grn_no || ''}</td>
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
                                      {bagsPresent != null ? bagsPresent + ' gen' : expBags + ' exp'}
                                    </span>
                                    {/* S324 — pieces counted on this line that no printed
                                        label covers. The floor has these bags physically;
                                        without a label it improvises a QR that 404s at
                                        STORE_ISSUE. Server-computed; absent = 0 = hidden. */}
                                    {bagsShort > 0 && (
                                      <span
                                        style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--state-error-fg)', border: '1px solid rgba(222,42,42,.35)', borderRadius: 2, padding: '1px 4px', whiteSpace: 'nowrap' }}
                                        title={`${l.bags_short_pcs} pcs counted on this line have no printed bag label (${bagsShort} bag${bagsShort === 1 ? '' : 's'} of ${bagsOf})`}
                                      >{bagsShort} unlabelled</span>
                                    )}
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
                            {total > 0 && (
                              <button
                                onClick={() => printMarkLabels(m.mark_id)}
                                style={{ marginLeft: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--t2)', fontSize: 9, fontFamily: 'var(--mono)', padding: '2px 6px', cursor: 'pointer', letterSpacing: '0.04em' }}
                              >🖨 Print Labels</button>
                            )}
                          </div>
                          {itemEntries.length === 0 ? (
                            <p style={{ fontSize: 11, color: 'var(--t3)' }}>No items recorded</p>
                          ) : (
                            <>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 44px 44px', gap: 6, marginBottom: 4 }}>
                                <span style={{ ...lbl, marginBottom: 0 }}>SKU</span>
                                <span style={{ ...lbl, marginBottom: 0, textAlign: 'right', color: 'var(--state-success-fg)' }}>OK</span>
                                <span style={{ ...lbl, marginBottom: 0, textAlign: 'right', color: 'var(--state-error-fg)' }}>Dmg</span>
                              </div>
                              {itemEntries.map(([sku, v], j) => (
                                <div key={j} style={{ display: 'grid', gridTemplateColumns: '1fr 44px 44px', gap: 6, padding: '3px 0', borderBottom: j < itemEntries.length - 1 ? '1px solid rgba(42,42,42,.4)' : 'none' }}>
                                  <span style={{ fontSize: 11 }}>{sku}</span>
                                  <span style={{ fontFamily: 'var(--mono)', textAlign: 'right', fontSize: 11, color: 'var(--state-success-fg)' }}>{v.ok}</span>
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
