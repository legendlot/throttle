'use client';
import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, printWindow, Modal } from '@throttle/ui';
import { RejectRunModal } from '../../../components/production-runs/RejectRunModal.js';
import { RejectWorkOrderModal } from '../../../components/work-orders/RejectWorkOrderModal.js';

const PICK_CAT_ORDER  = ['Car', 'Remote', 'Accessories', 'Packaging', 'Para', 'Batteries', 'License'];
const PICK_TYPE_ORDER = ['Electronic', 'Metal', 'Plastic', 'Cardboard', 'Paper', 'Fabric', 'Chemical', 'Rubber'];

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  orange: { bg: 'rgba(255,140,0,.15)',  fg: '#ffaa33', border: 'rgba(255,140,0,.25)' },
  amber:  { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)' },
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

function issueTypeTone(t) {
  const v = (t || '').toLowerCase();
  if (v === 'planned') return 'blue';
  if (v === 'rework') return 'red';
  if (v === 'short issue') return 'orange';
  if (v === 'ad hoc') return 'yellow';
  return 'gray';
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnDanger        = { ...btnPrimary, background: 'var(--red, #ef4444)', border: '1px solid var(--red, #ef4444)', color: '#fff' };

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatDateTime(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function pickSortKey(p, materialCache) {
  const cat  = (p.category || '').trim();
  const type = ((materialCache[p.part_code] || {}).part_type || '').trim();
  const catI  = PICK_CAT_ORDER.findIndex((c) => cat.toLowerCase().includes(c.toLowerCase()));
  const typeI = PICK_TYPE_ORDER.findIndex((t) => t.toLowerCase() === type.toLowerCase());
  return (catI < 0 ? 90 : catI) * 1000 + (typeI < 0 ? 90 : typeI);
}

export default function IssueQueuePage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [queue, setQueue] = useState([]);
  const [history, setHistory] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectWOModalOpen, setRejectWOModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [materialCache, setMaterialCache] = useState({});
  const [rejectedRefs, setRejectedRefs] = useState(() => new Set());
  const [issuedState, setIssuedState] = useState(null);
  // { ref, issueNo, product } — set on successful issue, cleared on close
  // FEAT-016 Phase 2 — run-type filter chip on the queue
  const [runTypeFilter, setRunTypeFilter] = useState('all'); // 'all' | 'in-house' | 'outsourced'
  // FEAT-020 — pick status for the currently-open run (null unless run is Picking)
  const [pickStatus, setPickStatus]           = useState(null);
  const [pickStatusLoading, setPickStatusLoading] = useState(false);
  const [voidModal, setVoidModal]             = useState(null); // line being voided, or null
  const [voidReason, setVoidReason]           = useState('');
  const [voidSubmitting, setVoidSubmitting]   = useState(false);

  // Refs to read uncontrolled inputs at submit time
  const detailFormRef = useRef(null);

  const ensureMaterialCache = useCallback(async () => {
    if (Object.keys(materialCache).length > 0) return materialCache;
    try {
      const data = await garageFetch('getMaterials', {}, session);
      const map = {};
      (data || []).forEach((m) => { map[m.part_code] = m; });
      setMaterialCache(map);
      return map;
    } catch {
      return {};
    }
  }, [session, materialCache]);

  const loadQueue = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      await ensureMaterialCache();
      // FEAT-020: getProductionRuns uses status=eq.X (no IN-list support), so call twice and merge.
      const [submittedRuns, pickingRuns, wos] = await Promise.all([
        garageFetch('getProductionRuns', { status: 'Submitted' }, session),
        garageFetch('getProductionRuns', { status: 'Picking' }, session),
        garageFetch('getWorkOrders', {}, session),
      ]);
      const runs = [ ...(submittedRuns || []), ...(pickingRuns || []) ];
      const rows = [];
      (runs || []).forEach((run) => {
        const isOutsourced = run.run_type === 'outsourced';
        const isPicking    = run.status === 'Picking';
        const variantStr = (run.variants || []).map((v) => {
          const e    = v.qty_ecomm || 0;
          const r    = v.qty_retail || 0;
          const name = v.variant || 'Common';
          if (e > 0 || r > 0) return `${name} E:${e} R:${r}`;
          return `${name} ×${v.qty}`;
        }).join(', ');
        const vendorName   = isOutsourced && run.vendor ? run.vendor.vendor_name : null;
        const vendorSuffix = vendorName ? `Vendor: ${vendorName}` : null;
        // FEAT-020 — Picking runs show a distinct badge/tone; outsourced still wins on label
        const badge = isPicking
          ? (isOutsourced ? `${vendorName || 'OUTSOURCED'} · PICKING` : 'PICKING')
          : (isOutsourced ? (vendorName || 'OUTSOURCED') : 'PROD RUN');
        const badgeTone = isPicking ? 'amber' : (isOutsourced ? 'amber' : 'blue');
        rows.push({
          type:     'run',
          ref:      run.run_no,
          badge,
          badgeTone,
          run_type: run.run_type || 'in-house',
          run_status: run.status,
          product:  run.product,
          details: [variantStr, vendorSuffix].filter(Boolean).join(' — '),
          units:    run.total_units || 0,
          run_date: run.run_date,
          submitted: run.released_at,
          line_no:  run.line_no || '—',
          raw: run,
        });
      });
      (wos || []).forEach((wo) => {
        const isRework     = wo.status === 'Pending Rework';
        const isShortIssue = !!wo.receipt_id;
        if (!isShortIssue && !isRework && !['Parts Request', 'adhoc', 'standalone'].includes(wo.wo_type)) return;
        let badge, badgeTone, type;
        if (isShortIssue)  { badge = 'SHORT ISSUE'; badgeTone = 'orange'; type = 'short-issue'; }
        else if (isRework) { badge = 'REWORK';      badgeTone = 'red';    type = 'wo'; }
        else               { badge = 'AD HOC';      badgeTone = 'yellow'; type = 'wo'; }
        rows.push({
          type,
          ref:      wo.wo_no,
          badge, badgeTone,
          product:  wo.product || '—',
          details:  isShortIssue ? `Short re-issue — ${wo.notes || ''}` : `${wo.variant || ''} ${wo.colour || ''}`.trim() || '—',
          units:    wo.qty || '—',
          run_date: wo.date,
          submitted: wo.created_at,
          line_no:  wo.line_no || '—',
          receipt_id: wo.receipt_id || null,
          raw: wo,
        });
      });
      setQueue(rows);
    } catch (e) {
      showToast(e.message || 'Failed to load queue', 'error');
      setQueue([]);
    } finally {
      setLoading(false);
    }
  }, [session, ensureMaterialCache, showToast]);

  const loadHistory = useCallback(async () => {
    if (!session) return;
    try {
      const issues = await garageFetch('getIssues', {}, session);
      const map = {};
      (issues || []).forEach((r) => {
        const key = r.issue_no;
        if (!map[key]) {
          map[key] = {
            issue_no:     r.issue_no,
            ref_issue_no: r.ref_issue_no || null,
            issue_date:   r.issue_date,
            issue_type:   r.issue_type,
            wo_no:        r.wo_no,
            run_id:       r.run_id,
            run_no:       r.run_no || null,
            product:      r.product,
            variant:      r.variant,
            colour:       r.colour || '',
            issued_by:    r.issued_by,
            units:        r.units_planned,
            lines:        [],
          };
        }
        map[key].lines.push(r);
      });
      const sorted = Object.values(map)
        .sort((a, b) => (b.issue_date || '').localeCompare(a.issue_date || ''))
        .slice(0, 20);
      setHistory(sorted);
    } catch (e) {
      // noop — history is informational
    }
  }, [session]);

  useEffect(() => { loadQueue(); }, [loadQueue]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const visibleQueue = useMemo(
    () => queue.filter((r) => {
      if (rejectedRefs.has(r.ref)) return false;
      if (runTypeFilter === 'all') return true;
      // WO-type rows aren't production runs — always shown except when filtering for outsourced.
      if (r.type !== 'run') return runTypeFilter === 'in-house';
      const rt = r.run_type || 'in-house';
      return runTypeFilter === 'outsourced' ? rt === 'outsourced' : rt !== 'outsourced';
    }),
    [queue, rejectedRefs, runTypeFilter]
  );

  async function openItem(row) {
    setSelectedItem({ ...row, loading: true });
    setConfirmChecked(false);
    setPickStatus(null);
    setVoidModal(null);
    setVoidReason('');
    setDetailLoading(true);
    try {
      if (row.type === 'run') {
        const data = await garageFetch('getProductionRun', { run_no: row.ref }, session);
        setSelectedItem({
          ...row,
          run: data.run,
          wos: data.wos || [],
          lines: data.pick_list || [],
          fbu_lines: data.fbu_lines || [],
        });
        // FEAT-020 — fetch pick status if the run is in Picking state
        if (data.run?.status === 'Picking') {
          setPickStatusLoading(true);
          try {
            const pickData = await garageFetch('getRunPickStatus', { run_no: row.ref }, session);
            setPickStatus(pickData);
          } catch {
            // Soft fail — pick panel just won't render
          } finally {
            setPickStatusLoading(false);
          }
        }
      } else if (row.type === 'short-issue') {
        const [woParts, materials] = await Promise.all([
          garageFetch('getWOParts', { wo_no: row.ref }, session),
          ensureMaterialCache(),
        ]);
        // wo is row.raw
        const lines = (woParts || []).map((p) => ({
          part_code: p.part_code,
          part_name: p.part_name,
          product:   row.product,
          required:  p.qty_requested,
          available: 0,
        }));
        setSelectedItem({ ...row, wo: row.raw, lines });
      } else if (row.type === 'wo') {
        const wo = row.raw;
        if (wo.wo_type === 'Parts Request') {
          const woParts = await garageFetch('getWOParts', { wo_no: row.ref }, session);
          const lines = (woParts || []).map((p) => ({
            part_code: p.part_code,
            part_name: p.part_name,
            product:   wo.product,
            required:  p.qty_requested,
            available: 0,
          }));
          setSelectedItem({ ...row, wo, lines });
        } else {
          // Rework / standalone — calc kit
          const kitData = await garageFetch('calcKit', {
            product: wo.product || '',
            variant: wo.variant || '',
            colour:  wo.colour || '',
            qty:     wo.qty || 1,
          }, session);
          const lines = (kitData?.kit || []).map((k) => ({
            part_code: k.part_code,
            part_name: k.part_name,
            required:  k.required || (k.bom_qty || 0) * (wo.qty || 1),
            available: k.available || 0,
          }));
          setSelectedItem({ ...row, wo, lines });
        }
      }
    } catch (e) {
      showToast(e.message || 'Failed to load item', 'error');
      setSelectedItem(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function closeItem() {
    setSelectedItem(null);
    setConfirmChecked(false);
    setPickStatus(null);
    setVoidModal(null);
    setVoidReason('');
  }

  function setAllAsPlanned() {
    const root = detailFormRef.current;
    if (!root) return;
    root.querySelectorAll('input.iss-actual-qty').forEach((inp) => {
      inp.value = inp.dataset.planned || '';
    });
    root.querySelectorAll('input.iss-fbu-qty').forEach((inp) => {
      inp.value = inp.dataset.planned || '';
    });
  }

  async function submitIssue() {
    if (!selectedItem) return;
    const root = detailFormRef.current;
    if (!root) return;
    const lineInputs = root.querySelectorAll('input.iss-actual-qty');
    const lines = [];
    lineInputs.forEach((inp) => {
      const qty = Math.round(parseFloat(inp.value) * 100) / 100;
      if (!qty || qty <= 0) return;
      lines.push({
        part_code:     inp.dataset.partCode,
        part_name:     inp.dataset.partName || '',
        actual_issued: Math.round(qty),
        actual_qty:    Math.round(qty), // postIssue uses actual_qty
        bom_qty:       parseFloat(inp.dataset.bomQty) || 0,
      });
    });
    const fbuLines = [];
    root.querySelectorAll('input.iss-fbu-qty').forEach((inp) => {
      const qty = parseFloat(inp.value);
      if (!qty || qty <= 0) return;
      fbuLines.push({
        product: inp.dataset.fbuProduct,
        variant: inp.dataset.fbuVariant || '',
        color:   inp.dataset.fbuColor || '',
        actual_issued: qty,
      });
    });
    if (!lines.length && !fbuLines.length) {
      showToast('Enter at least one quantity to issue', 'error');
      return;
    }
    setSubmitting(true);
    try {
      // FEAT-020 — warn (but don't block) when issuing a Picking run before all bags are scanned
      if (selectedItem.type === 'run' && pickStatus && !pickStatus.pick_complete) {
        showToast(
          `Pick incomplete (${pickStatus.lines_complete}/${pickStatus.lines_total} parts). Issuing with current quantities.`,
          'info'
        );
      }
      let res;
      if (selectedItem.type === 'run') {
        res = await workerFetch('issueAgainstRun', {
          data: { run_no: selectedItem.ref, lines, fbu_lines: fbuLines },
        }, session);
      } else if (selectedItem.type === 'short-issue') {
        res = await workerFetch('postShortIssue', {
          data: { receipt_id: selectedItem.receipt_id, wo_no: selectedItem.ref, lines },
        }, session);
      } else {
        const wo = selectedItem.wo;
        const isRework = wo?.status === 'Pending Rework';
        const issueType = wo?.wo_type === 'Parts Request' ? 'Planned' : (isRework ? 'Rework' : 'Planned');
        res = await workerFetch('postIssue', {
          data: {
            issue_type: issueType,
            wo_no:      selectedItem.ref,
            product:    wo?.product || '',
            variant:    wo?.variant || '',
            units:      wo?.qty || 1,
            lines,
          },
        }, session);
      }
      const result = res.data || res;
      const issueNo = result.issue_no || '—';
      setIssuedState({
        ref:     selectedItem.ref,
        issueNo,
        product: selectedItem.product || '',
      });
      setTimeout(() => {
        setIssuedState(null);
        closeItem();
        loadQueue();
        loadHistory();
      }, 2500);
    } catch (e) {
      showToast(e.message || 'Issue submission failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function handleRejectSuccess() {
    if (selectedItem) {
      setRejectedRefs((prev) => {
        const next = new Set(prev);
        next.add(selectedItem.ref);
        return next;
      });
    }
    setRejectModalOpen(false);
    closeItem();
    loadQueue();
  }

  function handleRejectWOSuccess() {
    if (selectedItem) {
      setRejectedRefs((prev) => {
        const next = new Set(prev);
        next.add(selectedItem.ref);
        return next;
      });
    }
    setRejectWOModalOpen(false);
    closeItem();
    loadQueue();
  }

  async function handleVoidLine() {
    if (!voidModal) return;
    if (!pickStatus?.run_id) {
      showToast('Pick status missing run_id — refresh and retry', 'error');
      return;
    }
    setVoidSubmitting(true);
    try {
      await workerFetch('voidRunPickLine', {
        data: {
          run_id:      pickStatus.run_id,
          part_code:   voidModal.part_code,
          void_reason: voidReason || null,
        },
      }, session);
      showToast(`${voidModal.part_code} marked as not needed`, 'success');
      const closing = voidModal;
      setVoidModal(null);
      setVoidReason('');
      // Refresh pick status from the worker
      try {
        const updated = await garageFetch('getRunPickStatus', { run_no: selectedItem.ref }, session);
        setPickStatus(updated);
        if (updated?.pick_complete) {
          showToast('All parts accounted for — run is ready to issue', 'success');
        }
      } catch {
        // Soft fail
      }
      void closing;
    } catch (e) {
      showToast(e.message || 'Failed to void line', 'error');
    } finally {
      setVoidSubmitting(false);
    }
  }

  async function buildPickListHtml(item) {
    if (item.type !== 'run' && item.type !== 'wo') return '';
    const materials = await ensureMaterialCache();
    const today = new Date().toLocaleDateString('en-IN');

    // ── WO (ad hoc) path ──────────────────────────────────────────────────────
    if (item.type === 'wo') {
      const wo = item.wo || {};
      const rows = (item.lines || [])
        .slice()
        .sort((a, b) => pickSortKey(a, materials) - pickSortKey(b, materials));
      const partRows = rows.map((p) => {
        const bagSize = (materials[p.part_code]?.bag_size) || 25;
        const bags = Math.ceil((p.required || 0) / bagSize);
        const status = (p.available || 0) >= (p.required || 0) ? 'OK' : 'SHORT';
        return `
          <tr>
            <td class="check"></td>
            <td class="mono">${escapeHtml(p.part_code)}</td>
            <td>${escapeHtml(p.part_name || '')}</td>
            <td>${escapeHtml(wo.product || '')}</td>
            <td class="num mono">${p.required || 0}</td>
            <td class="num mono">${p.available || 0}</td>
            <td class="num mono">${bagSize}</td>
            <td class="num mono">${bags}</td>
            <td class="${status === 'SHORT' ? 'short' : 'ok'}">${status}</td>
          </tr>`;
      }).join('');
      const variantLabel = [wo.variant, wo.colour].filter(Boolean).join(' / ') || 'Common';
      const totalUnits = wo.qty || 1;
      const woTypeLabel = wo.wo_type || 'Ad Hoc';
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pick List — ${escapeHtml(item.ref)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111; }
  .hdr { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 14px; }
  .brand { font-weight: 900; font-size: 18px; letter-spacing: 0.04em; }
  .title { font-size: 16px; font-weight: 700; text-transform: uppercase; }
  .meta { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; font-size: 11px; margin-bottom: 16px; }
  .meta div { border: 1px solid #ddd; padding: 6px 8px; }
  .meta strong { display: block; font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #ccc; padding: 5px 6px; text-align: left; }
  th { background: #f5f5f5; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
  .num { text-align: right; }
  .check { width: 20px; }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .short { color: #c00; font-weight: 700; }
  .ok { color: #060; font-weight: 700; }
  .sig { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 28px; font-size: 11px; }
  .sig div { border-top: 1px solid #000; padding-top: 4px; text-align: center; }
</style></head><body>
  <div class="hdr">
    <div class="brand">LEGEND <strong>OF</strong> TOYS</div>
    <div class="title">Pick List — Store → Production</div>
  </div>
  <div class="meta">
    <div><strong>WO No</strong>${escapeHtml(item.ref)}</div>
    <div><strong>Product</strong>${escapeHtml(wo.product || '')}</div>
    <div><strong>Total Units</strong>${totalUnits}</div>
    <div><strong>Date Printed</strong>${today}</div>
    <div><strong>Variant</strong>${escapeHtml(variantLabel)}</div>
  </div>
  <div style="font-size:10px;color:#666;margin-bottom:12px;font-family:ui-monospace,Menlo,monospace">Type: ${escapeHtml(woTypeLabel)}</div>
  <table>
    <thead><tr><th>✓</th><th>Part Code</th><th>Part Name</th><th>Product</th><th>Qty Required</th><th>In Stock</th><th>Bag Size</th><th>Bags</th><th>Status</th></tr></thead>
    <tbody>${partRows}</tbody>
  </table>
  <div class="sig">
    <div>Picked By</div>
    <div>Checked By</div>
    <div>Issued By</div>
  </div>
</body></html>`;
    }

    // ── Run path (unchanged) ───────────────────────────────────────────────────
    const run = item.run;
    const rows = (item.lines || [])
      .slice()
      .sort((a, b) => pickSortKey(a, materials) - pickSortKey(b, materials));
    const partRows = rows.map((p) => {
      const bagSize = (materials[p.part_code]?.bag_size) || 25;
      const bags = Math.ceil((p.total_qty || 0) / bagSize);
      const status = (p.available || 0) >= (p.total_qty || 0) ? 'OK' : 'SHORT';
      return `
        <tr>
          <td class="check"></td>
          <td class="mono">${escapeHtml(p.part_code)}</td>
          <td>${escapeHtml(p.part_name || '')}</td>
          <td>${escapeHtml(run.product || '')}</td>
          <td class="num mono">${p.total_qty || 0}</td>
          <td class="num mono">${p.available || 0}</td>
          <td class="num mono">${bagSize}</td>
          <td class="num mono">${bags}</td>
          <td class="${status === 'SHORT' ? 'short' : 'ok'}">${status}</td>
        </tr>`;
    }).join('');
    const variants = (item.wos || []).map((w) => `${w.variant || 'Common'} ×${w.qty}`).join(', ');
    const totalUnits = (item.wos || []).reduce((s, w) => s + (w.qty || 0), 0);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pick List — ${escapeHtml(item.ref)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111; }
  .hdr { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 14px; }
  .brand { font-weight: 900; font-size: 18px; letter-spacing: 0.04em; }
  .title { font-size: 16px; font-weight: 700; text-transform: uppercase; }
  .meta { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; font-size: 11px; margin-bottom: 16px; }
  .meta div { border: 1px solid #ddd; padding: 6px 8px; }
  .meta strong { display: block; font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #ccc; padding: 5px 6px; text-align: left; }
  th { background: #f5f5f5; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
  .num { text-align: right; }
  .check { width: 20px; }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .short { color: #c00; font-weight: 700; }
  .ok { color: #060; font-weight: 700; }
  .sig { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 28px; font-size: 11px; }
  .sig div { border-top: 1px solid #000; padding-top: 4px; text-align: center; }
</style></head><body>
  <div class="hdr">
    <div class="brand">LEGEND <strong>OF</strong> TOYS</div>
    <div class="title">Pick List — Store → Production</div>
  </div>
  <div class="meta">
    <div><strong>Run No</strong>${escapeHtml(item.ref)}</div>
    <div><strong>Product</strong>${escapeHtml(run?.product || '')}</div>
    <div><strong>Total Units</strong>${totalUnits}</div>
    <div><strong>Date Printed</strong>${today}</div>
    <div><strong>Variants</strong>${escapeHtml(variants)}</div>
  </div>
  <table>
    <thead><tr><th>✓</th><th>Part Code</th><th>Part Name</th><th>Product</th><th>Qty Required</th><th>In Stock</th><th>Bag Size</th><th>Bags</th><th>Status</th></tr></thead>
    <tbody>${partRows}</tbody>
  </table>
  <div class="sig">
    <div>Picked By</div>
    <div>Checked By</div>
    <div>Issued By</div>
  </div>
</body></html>`;
  }

  async function handlePrint(item) {
    try {
      const html = await buildPickListHtml(item);
      if (html) printWindow(html);
    } catch (e) {
      showToast('Failed to build pick list', 'error');
    }
  }

  async function reprintHistoryItem(issueGroup) {
    // Build a minimal pick list from issue lines
    try {
      const materials = await ensureMaterialCache();
      const today = new Date().toLocaleDateString('en-IN');
      const partRows = issueGroup.lines.map((l) => {
        const bagSize = (materials[l.part_code]?.bag_size) || 25;
        const bags = Math.ceil((parseFloat(l.actual_issued) || 0) / bagSize);
        return `
          <tr>
            <td class="check"></td>
            <td class="mono">${escapeHtml(l.part_code)}</td>
            <td>${escapeHtml(l.part_name || '')}</td>
            <td>${escapeHtml(l.product || '')}</td>
            <td class="num mono">${l.actual_issued || 0}</td>
            <td class="num mono">—</td>
            <td class="num mono">${bagSize}</td>
            <td class="num mono">${bags}</td>
            <td class="ok">ISSUED</td>
          </tr>`;
      }).join('');
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pick List — ${escapeHtml(issueGroup.issue_no)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111; }
  .hdr { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 14px; }
  .brand { font-weight: 900; font-size: 18px; letter-spacing: 0.04em; }
  .title { font-size: 16px; font-weight: 700; text-transform: uppercase; }
  .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; font-size: 11px; margin-bottom: 16px; }
  .meta div { border: 1px solid #ddd; padding: 6px 8px; }
  .meta strong { display: block; font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #ccc; padding: 5px 6px; text-align: left; }
  th { background: #f5f5f5; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
  .num { text-align: right; }
  .check { width: 20px; }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .ok { color: #060; font-weight: 700; }
</style></head><body>
  <div class="hdr"><div class="brand">LEGEND <strong>OF</strong> TOYS</div><div class="title">Pick List — Reprint</div></div>
  <div class="meta">
    <div><strong>Issue No</strong>${escapeHtml(issueGroup.issue_no)}</div>
    <div><strong>Type</strong>${escapeHtml(issueGroup.issue_type || '')}</div>
    <div><strong>Product</strong>${escapeHtml(issueGroup.product || '')}</div>
    <div><strong>Date</strong>${today}</div>
  </div>
  <table>
    <thead><tr><th>✓</th><th>Part Code</th><th>Part Name</th><th>Product</th><th>Qty Issued</th><th>In Stock</th><th>Bag Size</th><th>Bags</th><th>Status</th></tr></thead>
    <tbody>${partRows}</tbody>
  </table>
</body></html>`;
      printWindow(html);
    } catch {
      showToast('Print failed', 'error');
    }
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Issue Queue
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          All open requests from production — production runs, ad hoc requests, and rework
        </p>
      </div>

      {/* OPEN REQUESTS */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Open Requests {visibleQueue.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({visibleQueue.length})</span>}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {[
              { key: 'all',        label: 'All' },
              { key: 'in-house',   label: 'In-House' },
              { key: 'outsourced', label: 'Outsourced' },
            ].map(opt => (
              <button
                key={opt.key}
                onClick={() => setRunTypeFilter(opt.key)}
                style={{
                  padding: '3px 10px', fontSize: 10, fontWeight: 600,
                  fontFamily: 'var(--mono)', letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  background:   runTypeFilter === opt.key ? 'var(--yellow)' : 'var(--surface2)',
                  color:        runTypeFilter === opt.key ? '#000'          : 'var(--t3)',
                  border: '1px solid ' + (runTypeFilter === opt.key ? 'var(--yellow)' : 'var(--border)'),
                  borderRadius: 4, cursor: 'pointer',
                }}
              >
                {opt.label}
              </button>
            ))}
            <button style={btnSecondary} onClick={loadQueue} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : visibleQueue.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No open requests — all clear ✓</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={tableThStyle}>Ref</th>
                  <th style={tableThStyle}>Type</th>
                  <th style={tableThStyle}>Line</th>
                  <th style={tableThStyle}>Product</th>
                  <th style={tableThStyle}>Details</th>
                  <th style={tableThStyle}>Units</th>
                  <th style={tableThStyle}>Run Date</th>
                  <th style={tableThStyle}>Submitted</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {visibleQueue.map((r) => (
                  <tr key={`${r.type}-${r.ref}`}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.ref}</td>
                    <td style={tableTdStyle}><StatusBadge label={r.badge} tone={r.badgeTone} /></td>
                    <td style={tableTdStyle}>{r.line_no}</td>
                    <td style={tableTdStyle}>{r.product}</td>
                    <td style={tableTdStyle}>{r.details}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.units}</td>
                    <td style={tableTdStyle}>{formatDate(r.run_date)}</td>
                    <td style={tableTdStyle}>{formatDateTime(r.submitted)}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                      <button style={btnPrimary} onClick={() => openItem(r)}>ISSUE →</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ISSUED SUCCESS OVERLAY */}
      {issuedState && (
        <div style={{
          ...panelStyle,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px 24px',
          textAlign: 'center',
          gap: 10,
        }}>
          <div style={{ fontSize: 13, color: 'var(--green)', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            ✓ Issued
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 28, fontWeight: 700, color: 'var(--yellow)', letterSpacing: '0.04em' }}>
            {issuedState.issueNo}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t2)' }}>
            {issuedState.ref} — {issuedState.product}
          </div>
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' }}>
            Closing in 2.5 seconds…
          </div>
        </div>
      )}

      {/* DETAIL PANEL */}
      {selectedItem && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>{selectedItem.ref} — {detailLoading ? 'Loading…' : (selectedItem.product || '')}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {(selectedItem.type === 'run' || selectedItem.type === 'wo') && (
                <button style={btnSecondary} onClick={() => handlePrint(selectedItem)}>🖨 Print</button>
              )}
              <button style={btnSecondary} onClick={closeItem} disabled={submitting}>✕ Close</button>
            </div>
          </div>
          <div style={panelBodyStyle} ref={detailFormRef}>
            {/* FEAT-020 — Pick Status panel for runs in Picking state */}
            {selectedItem.type === 'run' && (pickStatus || pickStatusLoading) && (
              <PickStatusPanel
                pickStatus={pickStatus}
                loading={pickStatusLoading}
                onVoid={(line) => { setVoidModal(line); setVoidReason(''); }}
              />
            )}
            {detailLoading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : (
              <DetailBody
                item={selectedItem}
                materialCache={materialCache}
                pickedMap={pickStatus?.pick_lines ? Object.fromEntries(
                  pickStatus.pick_lines
                    .filter((l) => !l.is_void)
                    .map((l) => [l.part_code, l.scanned_qty || 0])
                ) : null}
              />
            )}

            {!detailLoading && (
              <div style={{ marginTop: 14, padding: 12, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={confirmChecked}
                    onChange={(e) => setConfirmChecked(e.target.checked)}
                    disabled={submitting}
                  />
                  I confirm parts have been physically picked for <strong style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{selectedItem.ref}</strong>
                </label>
              </div>
            )}

            {!detailLoading && (
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {selectedItem.type === 'run' && (
                    <button style={btnDanger} onClick={() => setRejectModalOpen(true)} disabled={submitting}>REJECT</button>
                  )}
                  {selectedItem.type === 'wo' && selectedItem.wo?.wo_type !== 'Short Supply' && (
                    <button style={btnDanger} onClick={() => setRejectWOModalOpen(true)} disabled={submitting}>REJECT</button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={btnSecondary} onClick={setAllAsPlanned} disabled={submitting}>All as planned</button>
                  <button
                    style={{ ...btnPrimary, opacity: !confirmChecked || submitting ? 0.5 : 1, cursor: !confirmChecked || submitting ? 'not-allowed' : 'pointer' }}
                    onClick={submitIssue}
                    disabled={!confirmChecked || submitting}
                  >
                    {submitting ? 'ISSUING…' : 'CONFIRM ISSUE'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* FEAT-020 — void pick line modal */}
      <Modal
        open={!!voidModal}
        onClose={() => { if (!voidSubmitting) { setVoidModal(null); setVoidReason(''); } }}
        title="Mark part as not needed"
        confirmLabel="Confirm"
        confirmColor="red"
        onConfirm={handleVoidLine}
        loading={voidSubmitting}
      >
        {voidModal && (
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            <p style={{ margin: '0 0 10px' }}>
              Mark <strong style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{voidModal.part_code}</strong>
              {' '}as not needed for{' '}
              <strong style={{ fontFamily: 'var(--mono)' }}>{selectedItem?.ref}</strong>?
            </p>
            <p style={{ margin: '0 0 12px', color: 'var(--t3)', fontSize: 11 }}>
              This signals a possible BOM correction. The line is excluded from the pick-complete check.
            </p>
            <textarea
              placeholder="Reason (optional)"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              rows={2}
              style={{
                width: '100%', padding: '8px 10px', fontSize: 12,
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 3, color: 'var(--t1)', fontFamily: 'inherit', resize: 'vertical',
              }}
            />
          </div>
        )}
      </Modal>

      {/* RECENT ISSUES */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Recent Issues</span>
          <button style={btnSecondary} onClick={loadHistory}>↻</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {history.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No recent issues</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={tableThStyle}>Issue No.</th>
                  <th style={tableThStyle}>Type</th>
                  <th style={tableThStyle}>Run</th>
                  <th style={tableThStyle}>WO</th>
                  <th style={tableThStyle}>Product</th>
                  <th style={tableThStyle}>Variant</th>
                  <th style={tableThStyle}>Colour</th>
                  <th style={tableThStyle}>Units</th>
                  <th style={tableThStyle}>Date</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.issue_no}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>
                      {h.issue_no}
                      {h.ref_issue_no && (
                        <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
                          ref:{h.ref_issue_no}
                        </div>
                      )}
                    </td>
                    <td style={tableTdStyle}><StatusBadge label={h.issue_type || '—'} tone={issueTypeTone(h.issue_type)} /></td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>
                      {h.run_no ? (
                        <span
                          onClick={() => router.push(`/production-runs?run=${encodeURIComponent(h.run_no)}`)}
                          title={`View run ${h.run_no}`}
                          style={{ color: 'var(--yellow)', cursor: 'pointer', textDecoration: 'underline dotted' }}
                        >
                          {h.run_no}
                        </span>
                      ) : <span style={{ color: 'var(--t3)' }}>—</span>}
                    </td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{h.wo_no || '—'}</td>
                    <td style={tableTdStyle}>{h.product || '—'}</td>
                    <td style={tableTdStyle}>{h.variant || '—'}</td>
                    <td style={tableTdStyle}>{h.colour || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{h.units || '—'}</td>
                    <td style={tableTdStyle}>{formatDate(h.issue_date)}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                      <button style={btnSecondary} onClick={() => reprintHistoryItem(h)}>🖨</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <RejectRunModal
        open={rejectModalOpen}
        runNo={selectedItem?.ref}
        onClose={() => setRejectModalOpen(false)}
        onSuccess={handleRejectSuccess}
        session={session}
      />

      <RejectWorkOrderModal
        open={rejectWOModalOpen}
        woNo={selectedItem?.ref}
        onClose={() => setRejectWOModalOpen(false)}
        onSuccess={handleRejectWOSuccess}
        session={session}
      />
    </div>
  );
}

function DetailBody({ item, materialCache, pickedMap }) {
  if (!item) return null;

  if (item.type === 'run') {
    const wos = item.wos || [];
    const totalUnits = wos.reduce((s, w) => s + (w.qty || 0), 0);
    const fbu = item.fbu_lines || [];
    return (
      <>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {wos.map((wo) => (
            <div key={wo.wo_no} style={{ padding: '4px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, fontSize: 11 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{wo.wo_no}</span>
              <span style={{ color: 'var(--t3)', margin: '0 4px' }}>·</span>
              <span>{(wo.variant || 'Common')}{wo.colour ? ' ' + wo.colour : ''}</span>
              <span style={{ color: '#7b93ff', marginLeft: 6 }}>{wo.qty} units</span>
              {(wo.qty_ecomm > 0 || wo.qty_retail > 0) && (
                <span style={{ color: 'var(--t3)', fontSize: 10, marginLeft: 5, fontFamily: 'var(--mono)' }}>
                  E:{wo.qty_ecomm || 0} R:{wo.qty_retail || 0}
                </span>
              )}
            </div>
          ))}
          <div style={{ padding: '4px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, fontSize: 11 }}>
            <span style={{ color: 'var(--t3)' }}>Total: </span>
            <strong>{totalUnits} units</strong>
          </div>
        </div>

        <RunPickListTable lines={item.lines || []} fbu={fbu} run={item.run} materialCache={materialCache} pickedMap={pickedMap} />
      </>
    );
  }

  // short-issue or wo
  const wo = item.wo || item.raw || {};
  const lines = item.lines || [];
  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {item.type === 'short-issue' ? (
          <>
            <Chip label="Receipt" value={item.receipt_id || '—'} />
            <Chip label="Short Parts" value={lines.length} />
          </>
        ) : (
          <>
            <Chip label="Type" value={wo.wo_type || '—'} />
            {wo.product && <Chip label="Product" value={wo.product} />}
            {wo.variant && <Chip label="Variant" value={wo.variant} />}
            {wo.colour && <Chip label="Colour" value={wo.colour} />}
            <Chip label="Parts" value={lines.length} />
          </>
        )}
      </div>

      <SimplePartTable lines={lines} showProduct={item.type !== 'wo' || wo.wo_type === 'Parts Request'} />
    </>
  );
}

function Chip({ label, value }) {
  return (
    <div style={{ padding: '4px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, fontSize: 11 }}>
      <span style={{ color: 'var(--t3)' }}>{label}: </span>
      <strong>{value}</strong>
    </div>
  );
}

function SimplePartTable({ lines, showProduct }) {
  if (!lines.length) {
    return <div style={{ padding: 16, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No parts to issue</div>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={tableThStyle}>Part Code</th>
            <th style={tableThStyle}>Part Name</th>
            {showProduct && <th style={tableThStyle}>Product</th>}
            <th style={tableThStyle}>Required</th>
            <th style={tableThStyle}>In Stock</th>
            <th style={tableThStyle}>Actual Issue Qty</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const planned = l.required || 0;
            const short = (l.available || 0) < planned;
            return (
              <tr key={l.part_code}>
                <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.part_code}</td>
                <td style={tableTdStyle}>{l.part_name || '—'}</td>
                {showProduct && <td style={tableTdStyle}>{l.product || '—'}</td>}
                <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{planned}</td>
                <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: short ? '#ff7070' : '#4ade80' }}>{l.available || 0}</td>
                <td style={tableTdStyle}>
                  <input
                    className="iss-actual-qty"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={planned}
                    data-part-code={l.part_code}
                    data-part-name={l.part_name || ''}
                    data-planned={planned}
                    data-bom-qty={l.bom_qty || 1}
                    style={{ ...inputStyle, width: 110, fontFamily: 'var(--mono)' }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunPickListTable({ lines, fbu, run, materialCache, pickedMap }) {
  const sorted = useMemo(() => {
    return (lines || []).slice().sort((a, b) => pickSortKey(a, materialCache) - pickSortKey(b, materialCache));
  }, [lines, materialCache]);

  const groups = useMemo(() => {
    const out = [];
    let lastCat = null, lastType = null, current = null;
    sorted.forEach((p) => {
      const cat = (p.category || 'Other').trim();
      const type = ((materialCache[p.part_code] || {}).part_type || '—').trim();
      if (cat !== lastCat) {
        current = { cat, types: [] };
        out.push(current);
        lastCat = cat;
        lastType = null;
      }
      if (type !== lastType) {
        current.types.push({ type, parts: [] });
        lastType = type;
      }
      current.types[current.types.length - 1].parts.push(p);
    });
    return out;
  }, [sorted, materialCache]);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={tableThStyle}>Part Code</th>
            <th style={tableThStyle}>Part Name</th>
            <th style={tableThStyle}>Product</th>
            <th style={tableThStyle}>Required</th>
            <th style={tableThStyle}>In Stock</th>
            <th style={tableThStyle}>Actual Issue Qty</th>
          </tr>
        </thead>
        <tbody>
          {fbu.length > 0 && (
            <>
              <tr style={{ background: 'rgba(33,60,226,.08)' }}>
                <td colSpan={6} style={{ padding: '6px 10px', fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', color: '#7b93ff' }}>
                  ▶ FBU UNITS
                </td>
              </tr>
              {fbu.map((f) => {
                const label = [f.product, f.variant, f.color].filter(Boolean).join(' ');
                const short = f.shortfall > 0;
                return (
                  <tr key={`fbu-${label}`}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: '#7b93ff' }}>FBU</td>
                    <td style={tableTdStyle}>{label}</td>
                    <td style={tableTdStyle}><StatusBadge label="FBU Unit" tone="blue" /></td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{f.qty}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: short ? '#ff7070' : '#4ade80' }}>{f.available || 0}</td>
                    <td style={tableTdStyle}>
                      <input
                        className="iss-fbu-qty"
                        type="number"
                        min="0"
                        defaultValue={f.qty}
                        data-fbu-product={f.product}
                        data-fbu-variant={f.variant || ''}
                        data-fbu-color={f.color || ''}
                        data-planned={f.qty}
                        style={{ ...inputStyle, width: 110, fontFamily: 'var(--mono)' }}
                      />
                    </td>
                  </tr>
                );
              })}
            </>
          )}
          {groups.map((g) => (
            <CategoryGroup key={g.cat} group={g} run={run} pickedMap={pickedMap} />
          ))}
          {sorted.length === 0 && fbu.length === 0 && (
            <tr>
              <td colSpan={6} style={{ ...tableTdStyle, textAlign: 'center', color: 'var(--t3)' }}>No parts in pick list</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CategoryGroup({ group, run, pickedMap }) {
  return (
    <>
      <tr style={{ background: 'rgba(242,205,26,.07)' }}>
        <td colSpan={6} style={{ padding: '6px 10px', fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--yellow)' }}>
          ▶ {group.cat}
        </td>
      </tr>
      {group.types.map((t) => (
        <Fragment key={t.type}>
          <tr style={{ background: 'rgba(255,255,255,.018)' }}>
            <td colSpan={6} style={{ padding: '3px 10px 3px 22px', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.18em', color: 'var(--t3)' }}>
              {(t.type || '—').toUpperCase()}
            </td>
          </tr>
          {t.parts.map((p) => {
            const planned = p.total_qty || 0;
            const short = (p.available || 0) < planned;
            // FEAT-020 — pre-fill input from scanned_qty when in Picking state
            const scanned = pickedMap && Object.prototype.hasOwnProperty.call(pickedMap, p.part_code)
              ? pickedMap[p.part_code]
              : null;
            const defaultQty = scanned != null ? scanned : planned;
            return (
              <tr key={p.part_code}>
                <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{p.part_code}</td>
                <td style={tableTdStyle}>{p.part_name || '—'}</td>
                <td style={tableTdStyle}>{run?.product || '—'}</td>
                <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                  {planned}
                  {p.is_packaging_split && (p.total_ecomm_qty > 0 || p.total_retail_qty > 0) && (
                    <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
                      E:{Math.round(p.total_ecomm_qty || 0)} R:{Math.round(p.total_retail_qty || 0)}
                    </div>
                  )}
                </td>
                <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: short ? '#ff7070' : '#4ade80' }}>{p.available || 0}</td>
                <td style={tableTdStyle}>
                  <input
                    className="iss-actual-qty"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={defaultQty}
                    data-part-code={p.part_code}
                    data-part-name={p.part_name || ''}
                    data-planned={planned}
                    style={{
                      ...inputStyle, width: 110, fontFamily: 'var(--mono)',
                      ...(scanned != null && scanned !== planned
                        ? { borderColor: '#fbbf24', color: '#fbbf24' }
                        : {}),
                    }}
                    title={scanned != null ? `Pre-filled from scanned qty (BOM: ${planned})` : undefined}
                  />
                </td>
              </tr>
            );
          })}
        </Fragment>
      ))}
    </>
  );
}

// FEAT-020 — pick-status panel rendered above the detail body for Picking runs
function PickStatusPanel({ pickStatus, loading, onVoid }) {
  if (loading) {
    return (
      <div style={{ padding: 16, marginBottom: 12, border: '1px solid var(--border)', borderRadius: 3, background: 'var(--surface2)' }}>
        <Spinner />
      </div>
    );
  }
  if (!pickStatus) return null;

  const { pick_lines: lines = [], pick_complete, lines_complete, lines_total } = pickStatus;
  const headline = pick_complete
    ? `✓ ALL PARTS PICKED (${lines_complete}/${lines_total})`
    : `${lines_complete} / ${lines_total} PARTS COMPLETE`;
  const headlineColor = pick_complete ? '#4ade80' : '#fbbf24';

  return (
    <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 3, background: 'var(--surface2)' }}>
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase',
      }}>
        <span style={{ color: 'var(--t2)' }}>Pick Status</span>
        <span style={{ color: headlineColor, fontFamily: 'var(--mono)' }}>{headline}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={tableThStyle}>Part Code</th>
              <th style={tableThStyle}>Part Name</th>
              <th style={tableThStyle}>Required</th>
              <th style={tableThStyle}>Scanned</th>
              <th style={tableThStyle}>Status</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const tone =
                l.is_void                              ? 'gray'
                : l.pick_status === 'complete'         ? 'green'
                : l.pick_status === 'partial'          ? 'amber'
                :                                        'red';
              const label =
                l.is_void                              ? 'Not needed'
                : l.pick_status === 'complete'         ? 'Complete'
                : l.pick_status === 'partial'          ? 'Partial'
                :                                        'Pending';
              return (
                <tr key={l.part_code} style={{ opacity: l.is_void ? 0.55 : 1 }}>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.part_code}</td>
                  <td style={tableTdStyle}>{l.part_name || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.required_qty}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.scanned_qty || 0}</td>
                  <td style={tableTdStyle}><StatusBadge label={label} tone={tone} /></td>
                  <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                    {!l.is_void && l.pick_status !== 'complete' && (
                      <button
                        onClick={() => onVoid(l)}
                        style={{ ...btnSecondary, padding: '4px 10px', fontSize: 10 }}
                      >
                        Mark not needed
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...tableTdStyle, textAlign: 'center', color: 'var(--t3)' }}>No pick lines</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
