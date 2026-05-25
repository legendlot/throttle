'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState, buildDamageManifestHtml, printWindow } from '@throttle/ui';

const STATUS_TABS = [
  { id: 'pending',                label: 'Pending',           tone: 'yellow' },
  { id: 'sent_to_repair',         label: 'Sent to Repair',    tone: 'blue'   },
  { id: 'returned_to_vendor',     label: 'Returned to Vendor', tone: 'orange'},
  { id: 'scrapped',               label: 'Scrapped',          tone: 'red'    },
  { id: 'repaired_and_restocked', label: 'Restocked',         tone: 'green'  },
  { id: 'cancelled',              label: 'Cancelled',         tone: 'gray'   },
  { id: 'all',                    label: 'All',               tone: 'gray'   },
];
const SOURCE_LABELS = {
  line_flush: 'Line Flush', receiving: 'Receiving', dispatch: 'Dispatch',
  production: 'Production', qc: 'QC',              manual: 'Manual',
};

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.25)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)'    },
};

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnDanger        = { background: 'rgba(222,42,42,.15)', border: '1px solid #ff7070', color: '#ff7070', borderRadius: 3, padding: '8px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnRepair        = { background: 'rgba(33,60,226,.2)', border: '1px solid #7b93ff', color: '#7b93ff', borderRadius: 3, padding: '8px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnRtv           = { background: 'rgba(245,158,11,.15)', border: '1px solid #fbbf24', color: '#fbbf24', borderRadius: 3, padding: '8px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };

function StatusBadge({ status }) {
  const tab = STATUS_TABS.find(t => t.id === status) || STATUS_TABS[6];
  const s = TONE_STYLES[tab.tone];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{tab.label}</span>
  );
}

function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}

export default function DamageLedgerPage() {
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission(perms, 'damage_manage');

  const [tab,      setTab]      = useState('pending');
  const [rows,     setRows]     = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [search,   setSearch]   = useState('');
  const [source,   setSource]   = useState('');
  const [selected, setSelected] = useState(() => new Set());

  // Modals
  const [repairOpen,  setRepairOpen]  = useState(false);
  const [scrapOpen,   setScrapOpen]   = useState(false);
  const [rtvOpen,     setRtvOpen]     = useState(false);
  const [recordOpen,  setRecordOpen]  = useState(false);
  const [historyTarget, setHistoryTarget] = useState(null);
  const [history,       setHistory]       = useState([]);
  const [histLoading,   setHistLoading]   = useState(false);

  // Modal forms
  const [repairForm, setRepairForm] = useState({ destination: '', notes: '' });
  const [scrapForm,  setScrapForm]  = useState({ notes: '' });
  const [rtvForm,    setRtvForm]    = useState({ destination: '', notes: '' });
  const [recordForm, setRecordForm] = useState({ part_code: '', part_name: '', product: '', qty: '', source: 'manual', reason: '', notes: '' });
  const [acting,     setActing]     = useState(false);

  // Reprint manifest by batch_no
  const [reprintBatch, setReprintBatch] = useState('');

  async function loadLedger() {
    if (!session) return;
    setLoading(true);
    setSelected(new Set());
    try {
      const filter = { limit: 500 };
      if (tab !== 'all') filter.status = tab;
      if (source) filter.source = source;
      const r = await workerFetch('getDamageLedger', { data: filter }, session);
      setRows(r?.ok ? (r.data || []) : []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { loadLedger(); /* eslint-disable-next-line */ }, [tab, source, session]);

  // Multi-token AND-of-OR across the standard Stock-Ledger field set plus
  // damage-specific identifiers (ledger_no, batch numbers, reason).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    const tokens = q.split(/\s+/).filter(Boolean);
    return rows.filter(r => tokens.every(t =>
      (r.ledger_no  || '').toLowerCase().includes(t) ||
      (r.part_code  || '').toLowerCase().includes(t) ||
      (r.part_name  || '').toLowerCase().includes(t) ||
      (r.product    || '').toLowerCase().includes(t) ||
      (r.category   || '').toLowerCase().includes(t) ||
      (r.reason     || '').toLowerCase().includes(t) ||
      (r.source_ref || '').toLowerCase().includes(t) ||
      (r.repair_batch_no   || '').toLowerCase().includes(t) ||
      (r.disposal_batch_no || '').toLowerCase().includes(t) ||
      (r.rtv_batch_no      || '').toLowerCase().includes(t)
    ));
  }, [rows, search]);

  const stats = useMemo(() => {
    const out = { total: filtered.length, qty: 0 };
    filtered.forEach(r => { out.qty += (parseInt(r.qty) || 0); });
    return out;
  }, [filtered]);

  function toggleRow(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(r => r.id)));
  }

  const selectedRows = useMemo(() => filtered.filter(r => selected.has(r.id)), [filtered, selected]);
  // Repair / RTV require all selected to be 'pending'. Scrap allows pending OR sent_to_repair.
  const canBatchRepair = selectedRows.length > 0 && selectedRows.every(r => r.status === 'pending');
  const canBatchScrap  = selectedRows.length > 0 && selectedRows.every(r => ['pending','sent_to_repair'].includes(r.status));
  const canBatchRtv    = selectedRows.length > 0 && selectedRows.every(r => r.status === 'pending');

  async function printBatch(batchNo) {
    if (!batchNo) return;
    try {
      const r = await workerFetch('getDamageBatch', { data: { batch_no: batchNo } }, session);
      if (!r?.ok) { toast('Could not fetch batch', 'err'); return; }
      const { rows: batchRows, ...header } = r.data;
      if (!batchRows?.length) { toast('Batch is empty', 'err'); return; }
      printWindow(buildDamageManifestHtml(header, batchRows));
    } catch (e) {
      toast(e.message || 'Print failed', 'err');
    }
  }

  async function submitRepair() {
    if (!canBatchRepair) return;
    const destination = repairForm.destination.trim();
    if (!destination) { toast('Destination required', 'err'); return; }
    setActing(true);
    try {
      const r = await workerFetch('damageBatchSendToRepair', {
        data: { ledger_ids: [...selected], destination, notes: repairForm.notes.trim() },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Send to repair failed', 'err'); return; }
      toast(`Sent to repair · ${r.data.batch_no} · ${r.data.item_count} item${r.data.item_count === 1 ? '' : 's'}`, 'ok');
      setRepairOpen(false);
      setRepairForm({ destination: '', notes: '' });
      await loadLedger();
      printBatch(r.data.batch_no);
    } finally { setActing(false); }
  }
  async function submitScrap() {
    if (!canBatchScrap) return;
    setActing(true);
    try {
      const r = await workerFetch('damageBatchScrap', {
        data: { ledger_ids: [...selected], notes: scrapForm.notes.trim() },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Scrap failed', 'err'); return; }
      toast(`Scrapped · ${r.data.batch_no} · ${r.data.item_count} item${r.data.item_count === 1 ? '' : 's'}`, 'ok');
      setScrapOpen(false);
      setScrapForm({ notes: '' });
      await loadLedger();
      printBatch(r.data.batch_no);
    } finally { setActing(false); }
  }
  async function submitRtv() {
    if (!canBatchRtv) return;
    const destination = rtvForm.destination.trim();
    if (!destination) { toast('Vendor required', 'err'); return; }
    setActing(true);
    try {
      const r = await workerFetch('damageBatchReturnToVendor', {
        data: { ledger_ids: [...selected], destination, notes: rtvForm.notes.trim() },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'RTV failed', 'err'); return; }
      toast(`Returned to vendor · ${r.data.batch_no} · ${r.data.item_count} item${r.data.item_count === 1 ? '' : 's'}`, 'ok');
      setRtvOpen(false);
      setRtvForm({ destination: '', notes: '' });
      await loadLedger();
      printBatch(r.data.batch_no);
    } finally { setActing(false); }
  }

  async function submitRecord() {
    const f = recordForm;
    if (!f.part_code.trim() || !f.part_name.trim() || !(parseInt(f.qty) > 0)) {
      toast('Part code, name and qty required', 'err'); return;
    }
    setActing(true);
    try {
      const r = await workerFetch('recordDamage', {
        data: {
          part_code: f.part_code.trim(), part_name: f.part_name.trim(),
          product:   f.product.trim() || null,
          qty:       parseInt(f.qty),
          source:    f.source || 'manual',
          reason:    f.reason.trim() || null,
          notes:     f.notes.trim() || null,
          entry_type: 'damage',
        },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Record failed', 'err'); return; }
      toast(`Recorded · ${r.data.ledger_no}`, 'ok');
      setRecordOpen(false);
      setRecordForm({ part_code: '', part_name: '', product: '', qty: '', source: 'manual', reason: '', notes: '' });
      await loadLedger();
    } finally { setActing(false); }
  }

  async function markRepaired(row) {
    if (!confirm(`Mark ${row.ledger_no} as repaired and restock ${row.qty} ${row.part_code}?`)) return;
    const r = await workerFetch('damageMarkRepaired', { data: { ledger_id: row.id } }, session);
    if (!r?.ok) { toast(r?.data?.error || 'Failed', 'err'); return; }
    toast(`${row.ledger_no} restocked +${r.data.restocked_qty}`, 'ok');
    loadLedger();
  }
  async function markNotRepairable(row) {
    const reason = prompt(`Why is ${row.ledger_no} not repairable? (becomes scrap on next batch)`);
    if (reason == null) return;
    const r = await workerFetch('damageMarkNotRepairable', { data: { ledger_id: row.id, notes: reason } }, session);
    if (!r?.ok) { toast(r?.data?.error || 'Failed', 'err'); return; }
    toast(`${row.ledger_no} returned to pending`, 'ok');
    loadLedger();
  }
  async function cancelRow(row) {
    const reason = prompt(`Cancel ${row.ledger_no} — reason?`);
    if (!reason || !reason.trim()) return;
    const r = await workerFetch('damageCancel', { data: { ledger_id: row.id, reason: reason.trim() } }, session);
    if (!r?.ok) { toast(r?.data?.error || 'Failed', 'err'); return; }
    toast(`${row.ledger_no} cancelled`, 'ok');
    loadLedger();
  }

  async function openHistory(row) {
    setHistoryTarget(row);
    setHistory([]);
    setHistLoading(true);
    try {
      const r = await workerFetch('getDamageLedgerHistory', { data: { ledger_id: row.id } }, session);
      setHistory(r?.ok ? (r.data || []) : []);
    } finally { setHistLoading(false); }
  }

  function batchPillFor(row) {
    if (row.repair_batch_no)   return <code style={{ color: '#7b93ff' }}>{row.repair_batch_no}</code>;
    if (row.disposal_batch_no) return <code style={{ color: '#ff7070' }}>{row.disposal_batch_no}</code>;
    if (row.rtv_batch_no)      return <code style={{ color: '#fbbf24' }}>{row.rtv_batch_no}</code>;
    return <span style={{ color: 'var(--t3)' }}>—</span>;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Damage / Scrap Ledger</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Reprint manifest by batch no (DRB-/DSB-/RTV-)…"
              value={reprintBatch}
              onChange={e => setReprintBatch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && reprintBatch.trim()) printBatch(reprintBatch.trim()); }}
              style={{ ...inputStyle, width: 280, fontFamily: 'var(--mono)' }}
            />
            <button onClick={() => reprintBatch.trim() && printBatch(reprintBatch.trim())} style={btnSecondary} disabled={!reprintBatch.trim()}>REPRINT</button>
            {canEdit && (
              <button onClick={() => setRecordOpen(true)} style={btnSecondary}>+ RECORD DAMAGE</button>
            )}
          </div>
        </div>
        <div style={panelBodyStyle}>
          {!canEdit && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(242,205,26,.08)', border: '1px solid rgba(242,205,26,.2)', borderRadius: 3, fontSize: 11, color: 'var(--t2)' }}>
              View-only — `damage_manage` permission required to record or action ledger rows.
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {STATUS_TABS.map(t => {
              const active = tab === t.id;
              const s = TONE_STYLES[t.tone];
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    background: active ? s.bg : 'transparent',
                    border: `1px solid ${active ? s.border : 'var(--border)'}`,
                    color: active ? s.fg : 'var(--t2)',
                    borderRadius: 3, padding: '5px 12px', fontSize: 11,
                    cursor: 'pointer', fontFamily: 'var(--cond)',
                    letterSpacing: '0.05em', textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={labelStyle}>Search</label>
              <input
                type="text" value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search — try “Flare metal” or “Apex DRB-007”"
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
            <div>
              <label style={labelStyle}>Source</label>
              <select value={source} onChange={e => setSource(e.target.value)} style={{ ...inputStyle, minWidth: 130 }}>
                <option value="">All sources</option>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
              {stats.total} row{stats.total === 1 ? '' : 's'} · {stats.qty} qty
            </div>
          </div>

          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, padding: '8px 12px', background: 'rgba(33,60,226,.08)', border: '1px solid rgba(33,60,226,.2)', borderRadius: 3 }}>
              <span style={{ fontSize: 11, color: 'var(--t2)' }}>
                {selected.size} selected · {selectedRows.reduce((s, r) => s + (parseInt(r.qty) || 0), 0)} qty
              </span>
              <div style={{ flex: 1 }} />
              {canEdit && (
                <>
                  <button onClick={() => setRepairOpen(true)} disabled={!canBatchRepair} style={{ ...btnRepair, opacity: canBatchRepair ? 1 : 0.4, cursor: canBatchRepair ? 'pointer' : 'not-allowed' }}>
                    SEND TO REPAIR
                  </button>
                  <button onClick={() => setRtvOpen(true)} disabled={!canBatchRtv} style={{ ...btnRtv, opacity: canBatchRtv ? 1 : 0.4, cursor: canBatchRtv ? 'pointer' : 'not-allowed' }}>
                    RETURN TO VENDOR
                  </button>
                  <button onClick={() => setScrapOpen(true)} disabled={!canBatchScrap} style={{ ...btnDanger, opacity: canBatchScrap ? 1 : 0.4, cursor: canBatchScrap ? 'pointer' : 'not-allowed' }}>
                    SCRAP
                  </button>
                </>
              )}
              <button onClick={() => setSelected(new Set())} style={btnSecondary}>CLEAR</button>
            </div>
          )}

          {/* Table */}
          {loading ? <Spinner /> : filtered.length === 0 ? (
            <EmptyState title="No entries" message={`No damage-ledger rows in "${STATUS_TABS.find(t => t.id === tab)?.label}".`} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {canEdit && (
                      <th style={{ ...tableThStyle, width: 30 }}>
                        <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} />
                      </th>
                    )}
                    <th style={tableThStyle}>Ledger</th>
                    <th style={tableThStyle}>Part</th>
                    <th style={{ ...tableThStyle, textAlign: 'right' }}>Qty</th>
                    <th style={tableThStyle}>Status</th>
                    <th style={tableThStyle}>Source</th>
                    <th style={tableThStyle}>Batch</th>
                    <th style={tableThStyle}>Recorded</th>
                    <th style={tableThStyle}>Reason</th>
                    <th style={{ ...tableThStyle, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.id} style={{ background: selected.has(r.id) ? 'rgba(33,60,226,.06)' : 'transparent' }}>
                      {canEdit && (
                        <td style={tableTdStyle}>
                          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
                        </td>
                      )}
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.ledger_no}</td>
                      <td style={tableTdStyle}>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t1)' }}>{r.part_code}</div>
                        <div style={{ fontSize: 10, color: 'var(--t3)' }}>{r.part_name}{r.product ? ` · ${r.product}` : ''}</div>
                      </td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700 }}>{r.qty}</td>
                      <td style={tableTdStyle}><StatusBadge status={r.status} /></td>
                      <td style={{ ...tableTdStyle, fontSize: 11, color: 'var(--t2)' }}>
                        {SOURCE_LABELS[r.source] || r.source}
                        {r.source_ref && (
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)' }}>{r.source_ref}</div>
                        )}
                      </td>
                      <td style={tableTdStyle}>{batchPillFor(r)}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                        {fmtTs(r.recorded_at)}
                        {r.recorded_by_name && <div style={{ color: 'var(--t2)' }}>{r.recorded_by_name}</div>}
                      </td>
                      <td style={{ ...tableTdStyle, fontSize: 11, color: 'var(--t2)', maxWidth: 240, whiteSpace: 'normal' }}>{r.reason || '—'}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 4 }}>
                          <button onClick={() => openHistory(r)} style={btnSecondary}>HISTORY</button>
                          {canEdit && r.status === 'sent_to_repair' && (
                            <>
                              <button onClick={() => markRepaired(r)} style={{ ...btnSecondary, color: '#4ade80', borderColor: 'rgba(34,197,94,.4)' }}>RESTOCK</button>
                              <button onClick={() => markNotRepairable(r)} style={{ ...btnSecondary, color: '#ff7070', borderColor: 'rgba(222,42,42,.3)' }}>NOT REPAIRABLE</button>
                            </>
                          )}
                          {canEdit && r.status === 'pending' && (
                            <button onClick={() => cancelRow(r)} style={btnSecondary}>CANCEL</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Send to Repair modal */}
      <Modal
        open={repairOpen}
        onClose={() => setRepairOpen(false)}
        title={`Send ${selected.size} item${selected.size === 1 ? '' : 's'} to repair`}
        titleColor="#7b93ff"
        size="md"
        confirmLabel={acting ? 'SENDING…' : 'SEND & PRINT MANIFEST'}
        confirmColor="#3b82f6"
        loading={acting}
        onConfirm={submitRepair}
      >
        <div>
          <label style={labelStyle}>Repair Destination <span style={{ color: '#ff7070' }}>*</span></label>
          <input
            type="text" value={repairForm.destination}
            onChange={e => setRepairForm({ ...repairForm, destination: e.target.value })}
            placeholder="e.g. In-house paint touch-up · Vendor XYZ"
            style={{ ...inputStyle, width: '100%' }}
            autoFocus
          />
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea
            rows={2} value={repairForm.notes}
            onChange={e => setRepairForm({ ...repairForm, notes: e.target.value })}
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
      </Modal>

      {/* Scrap modal */}
      <Modal
        open={scrapOpen}
        onClose={() => setScrapOpen(false)}
        title={`Scrap ${selected.size} item${selected.size === 1 ? '' : 's'}`}
        titleColor="#ff7070"
        size="md"
        confirmLabel={acting ? 'SCRAPPING…' : 'SCRAP & PRINT MANIFEST'}
        confirmColor="red"
        loading={acting}
        onConfirm={submitScrap}
      >
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--t2)' }}>
          These items will be marked as scrapped and grouped under a single DSB-NNN batch.
          The disposal manifest will print for the physical pile leaving the building.
        </p>
        <div>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea
            rows={2} value={scrapForm.notes}
            onChange={e => setScrapForm({ notes: e.target.value })}
            placeholder="e.g. monthly e-waste pickup, contractor name…"
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
      </Modal>

      {/* Return to Vendor modal */}
      <Modal
        open={rtvOpen}
        onClose={() => setRtvOpen(false)}
        title={`Return ${selected.size} item${selected.size === 1 ? '' : 's'} to vendor`}
        titleColor="#fbbf24"
        size="md"
        confirmLabel={acting ? 'PROCESSING…' : 'RETURN & PRINT MANIFEST'}
        confirmColor="#f59e0b"
        loading={acting}
        onConfirm={submitRtv}
      >
        <div>
          <label style={labelStyle}>Vendor <span style={{ color: '#ff7070' }}>*</span></label>
          <input
            type="text" value={rtvForm.destination}
            onChange={e => setRtvForm({ ...rtvForm, destination: e.target.value })}
            placeholder="Vendor name or code"
            style={{ ...inputStyle, width: '100%' }}
            autoFocus
          />
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea
            rows={2} value={rtvForm.notes}
            onChange={e => setRtvForm({ ...rtvForm, notes: e.target.value })}
            placeholder="e.g. RMA-XXXX, courier slip…"
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
      </Modal>

      {/* Manual Record Damage modal */}
      <Modal
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        title="Record damage"
        size="md"
        confirmLabel={acting ? 'SAVING…' : 'RECORD'}
        onConfirm={submitRecord}
        loading={acting}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Part Code <span style={{ color: '#ff7070' }}>*</span></label>
            <input type="text" value={recordForm.part_code}
              onChange={e => setRecordForm({ ...recordForm, part_code: e.target.value })}
              style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} autoFocus />
          </div>
          <div>
            <label style={labelStyle}>Part Name <span style={{ color: '#ff7070' }}>*</span></label>
            <input type="text" value={recordForm.part_name}
              onChange={e => setRecordForm({ ...recordForm, part_name: e.target.value })}
              style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div>
            <label style={labelStyle}>Product (optional)</label>
            <input type="text" value={recordForm.product}
              onChange={e => setRecordForm({ ...recordForm, product: e.target.value })}
              style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div>
            <label style={labelStyle}>Qty <span style={{ color: '#ff7070' }}>*</span></label>
            <input type="number" min={1} value={recordForm.qty}
              onChange={e => setRecordForm({ ...recordForm, qty: e.target.value })}
              style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div>
            <label style={labelStyle}>Source</label>
            <select value={recordForm.source}
              onChange={e => setRecordForm({ ...recordForm, source: e.target.value })}
              style={{ ...inputStyle, width: '100%' }}>
              {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>Reason (visible on manifest)</label>
          <input type="text" value={recordForm.reason}
            onChange={e => setRecordForm({ ...recordForm, reason: e.target.value })}
            placeholder="e.g. cracked on impact, found broken on floor…"
            style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>Notes (internal)</label>
          <textarea rows={2} value={recordForm.notes}
            onChange={e => setRecordForm({ ...recordForm, notes: e.target.value })}
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
      </Modal>

      {/* History drawer */}
      {historyTarget && (
        <Modal open onClose={() => { setHistoryTarget(null); setHistory([]); }} size="lg"
               title={`History · ${historyTarget.ledger_no}`}>
          <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--t2)' }}>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{historyTarget.part_code}</span>{' '}
            <span>{historyTarget.part_name}</span> · <strong>{historyTarget.qty} qty</strong>{' '}
            <span style={{ color: 'var(--t3)' }}>·</span> source: {SOURCE_LABELS[historyTarget.source] || historyTarget.source}
          </div>
          {histLoading ? <Spinner /> : history.length === 0 ? (
            <EmptyState title="No history" message="No transitions recorded yet." />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={tableThStyle}>When</th>
                  <th style={tableThStyle}>Action</th>
                  <th style={tableThStyle}>From → To</th>
                  <th style={tableThStyle}>By</th>
                  <th style={tableThStyle}>Batch</th>
                  <th style={tableThStyle}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10 }}>{fmtTs(h.acted_at)}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>{h.action}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10 }}>
                      <span style={{ color: 'var(--t3)' }}>{h.old_status || '—'}</span> → <span style={{ color: 'var(--t1)' }}>{h.new_status}</span>
                    </td>
                    <td style={{ ...tableTdStyle, fontSize: 11 }}>{h.actor_name || (h.actor ? h.actor.slice(0, 8) : '—')}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10 }}>{h.batch_no || '—'}</td>
                    <td style={{ ...tableTdStyle, fontSize: 11, color: 'var(--t2)' }}>{h.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
}
