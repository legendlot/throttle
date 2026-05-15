'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { FlushVerifyPanel } from '../../../components/flush/FlushVerifyPanel.js';

const LF_RETURN_TYPES = ['Unused', 'Damaged', 'QC Rejected', 'Partial Assembly', 'Wrong Issue'];
const LF_STATUS_TONES = { 'Pending Verification': 'yellow', Verified: 'green', Disputed: 'red' };

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

const tabBtn = (active) => ({
  background: active ? 'var(--yellow)' : 'var(--surface2)',
  color: active ? '#000' : 'var(--t3)',
  border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
  borderRadius: 4, padding: '5px 12px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: active ? 700 : 500,
});

function newCard(seed = {}) {
  return {
    id: Date.now() + Math.random(),
    partCode: seed.partCode || '',
    partName: seed.partName || '',
    category: seed.category || '',
    splits: [{ id: Date.now() + Math.random(), type: 'Unused', qty: '' }],
  };
}

export default function LineFlushPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState('flushes');
  const [view, setView] = useState('list'); // list | detail
  const [showNewFlush, setShowNewFlush] = useState(false);

  // List state
  const [flushRows, setFlushRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [listLoading, setListLoading] = useState(true);

  // Detail state
  const [currentFlush, setCurrentFlush] = useState(null); // { flush, lines, dispositions }
  const [detailLoading, setDetailLoading] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);

  // New flush form state
  const [flushType, setFlushType] = useState('run');
  const [flushDate, setFlushDate] = useState(todayStr());
  const [flushLine, setFlushLine] = useState('L1');
  const [flushShift, setFlushShift] = useState('Morning');
  const [flushNotes, setFlushNotes] = useState('');
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [runInfo, setRunInfo] = useState(null);
  const [runPickList, setRunPickList] = useState([]);
  const [partCards, setPartCards] = useState([]);
  const [materialCache, setMaterialCache] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // Quarantine
  const [quarantine, setQuarantine] = useState([]);
  const [quarantineLoaded, setQuarantineLoaded] = useState(false);
  const [quarantineLoading, setQuarantineLoading] = useState(false);

  const loadFlushes = useCallback(async () => {
    if (!session) return;
    setListLoading(true);
    try {
      const data = await garageFetch('getFlushes', statusFilter ? { status: statusFilter } : {}, session);
      setFlushRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load flushes', 'error');
      setFlushRows([]);
    } finally {
      setListLoading(false);
    }
  }, [session, statusFilter, showToast]);

  useEffect(() => { loadFlushes(); }, [loadFlushes]);

  const loadQuarantine = useCallback(async () => {
    if (!session) return;
    setQuarantineLoading(true);
    try {
      const data = await garageFetch('getQuarantine', {}, session);
      setQuarantine(Array.isArray(data) ? data : []);
      setQuarantineLoaded(true);
    } catch (e) {
      showToast(e.message || 'Failed to load quarantine', 'error');
    } finally {
      setQuarantineLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => {
    if (activeTab === 'quarantine' && !quarantineLoaded) loadQuarantine();
  }, [activeTab, quarantineLoaded, loadQuarantine]);

  // ── New-flush form ──────────────────────────────────────────────
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

  const loadRunsForForm = useCallback(async () => {
    if (!session) return;
    try {
      // Compute date 7 days ago in YYYY-MM-DD format (IST)
      const d = new Date();
      d.setDate(d.getDate() - 7);
      const sevenDaysAgo = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });

      // Open runs (Issued, In Progress): no date filter — always include regardless of age
      // Completed runs: last 7 days only to keep the list short
      const [issuedData, inProgressData, completedData] = await Promise.all([
        garageFetch('getProductionRuns', { status: 'Issued' }, session),
        garageFetch('getProductionRuns', { status: 'In Progress' }, session),
        garageFetch('getProductionRuns', { status: 'Completed', date_from: sevenDaysAgo }, session),
      ]);

      const combined = [
        ...(issuedData     || []),
        ...(inProgressData || []),
        ...(completedData  || []),
      ];

      // Deduplicate by run_no in case any run appears in multiple fetches.
      // Exclude outsourced runs — they don't generate physical return-to-store flushes.
      const seen = new Set();
      const deduped = combined.filter((r) => {
        if (seen.has(r.run_no)) return false;
        if (r.run_type && r.run_type !== 'in-house') return false;
        seen.add(r.run_no);
        return true;
      });

      // Sort: open runs first (Issued, In Progress), then Completed; within each group newest first
      const statusOrder = { 'Issued': 0, 'In Progress': 1, 'Completed': 2 };
      deduped.sort((a, b) => {
        const so = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
        if (so !== 0) return so;
        return new Date(b.run_date || 0) - new Date(a.run_date || 0);
      });

      setRuns(deduped);
    } catch (e) {
      showToast(e.message || 'Failed to load runs', 'error');
    }
  }, [session, showToast]);

  useEffect(() => {
    if (showNewFlush && flushType === 'run') {
      loadRunsForForm();
      ensureMaterialCache();
    }
    if (showNewFlush && flushType === 'standalone') {
      ensureMaterialCache();
    }
  }, [showNewFlush, flushType, loadRunsForForm, ensureMaterialCache]);

  async function handleRunSelect(runNo) {
    setSelectedRun(runNo);
    setRunInfo(null);
    setRunPickList([]);
    if (!runNo) return;
    try {
      const data = await garageFetch('getProductionRun', { run_no: runNo }, session);
      setRunInfo(data.run || null);
      setRunPickList(Array.isArray(data.pick_list) ? data.pick_list : []);
    } catch (e) {
      showToast(e.message || 'Failed to load run', 'error');
    }
  }

  function loadPartsFromRun() {
    if (!runPickList.length) {
      showToast('No parts available in this run', 'error');
      return;
    }
    const cards = runPickList.map((p) => newCard({
      partCode: p.part_code,
      partName: p.part_name || (materialCache[p.part_code]?.part_name) || '',
      category: p.category || materialCache[p.part_code]?.part_category || '',
    }));
    setPartCards(cards);
  }

  function addEmptyCard() {
    setPartCards((cards) => [...cards, newCard()]);
  }
  function removeCard(id) {
    setPartCards((cards) => cards.filter((c) => c.id !== id));
  }
  function updateCard(id, field, value) {
    setPartCards((cards) => cards.map((c) => c.id === id ? { ...c, [field]: value } : c));
  }
  function lookupPart(id, partCode) {
    const code = (partCode || '').trim();
    if (!code) return;
    const m = materialCache[code];
    if (m) {
      setPartCards((cards) => cards.map((c) => c.id === id
        ? { ...c, partCode: code, partName: m.part_name || c.partName, category: m.part_category || c.category }
        : c));
    } else {
      setPartCards((cards) => cards.map((c) => c.id === id ? { ...c, partCode: code } : c));
    }
  }
  function addSplit(cardId) {
    setPartCards((cards) => cards.map((c) => c.id === cardId
      ? { ...c, splits: [...c.splits, { id: Date.now() + Math.random(), type: 'Unused', qty: '' }] }
      : c));
  }
  function removeSplit(cardId, splitId) {
    setPartCards((cards) => cards.map((c) => {
      if (c.id !== cardId) return c;
      if (c.splits.length <= 1) return c;
      return { ...c, splits: c.splits.filter((s) => s.id !== splitId) };
    }));
  }
  function updateSplit(cardId, splitId, field, value) {
    setPartCards((cards) => cards.map((c) => {
      if (c.id !== cardId) return c;
      return { ...c, splits: c.splits.map((s) => s.id === splitId ? { ...s, [field]: value } : s) };
    }));
  }

  function resetNewForm() {
    setFlushType('run');
    setFlushDate(todayStr());
    setFlushLine('L1');
    setFlushShift('Morning');
    setFlushNotes('');
    setSelectedRun('');
    setRunInfo(null);
    setRunPickList([]);
    setPartCards([]);
  }

  async function submitFlush() {
    const isRun = flushType === 'run';
    if (isRun && !selectedRun) {
      showToast('Select a production run', 'error');
      return;
    }
    const lines = [];
    partCards.forEach((card) => {
      if (!card.partCode) return;
      card.splits.forEach((split) => {
        const qty = parseFloat(split.qty) || 0;
        if (qty > 0) {
          lines.push({
            part_code:  card.partCode,
            part_name:  card.partName,
            return_type: split.type || 'Unused',
            qty_raised: qty,
          });
        }
      });
    });
    if (!lines.length) {
      showToast('Enter at least one non-zero quantity to return', 'error');
      return;
    }
    const payload = {
      flush_date: flushDate,
      line_no:    flushLine,
      shift:      flushShift,
      notes:      flushNotes || null,
      lines,
    };
    if (isRun) payload.run_no = selectedRun;
    setSubmitting(true);
    try {
      const res = await workerFetch('postFlush', { data: payload }, session);
      const result = res.data || res;
      showToast(`${result.flush_id} submitted — ${result.lines} parts`, 'success');
      resetNewForm();
      setShowNewFlush(false);
      loadFlushes();
    } catch (e) {
      showToast(e.message || 'Flush submission failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Detail view ─────────────────────────────────────────────────
  async function openFlushDetail(flushId) {
    setView('detail');
    setDetailLoading(true);
    setVerifyOpen(false);
    setCurrentFlush(null);
    try {
      const data = await garageFetch('getFlush', { flush_id: flushId }, session);
      setCurrentFlush(data);
    } catch (e) {
      showToast(e.message || 'Failed to load flush', 'error');
    } finally {
      setDetailLoading(false);
    }
  }

  function handleVerified() {
    setVerifyOpen(false);
    setView('list');
    loadFlushes();
  }

  const pendingCount = useMemo(
    () => flushRows.filter((r) => r.status === 'Pending Verification').length,
    [flushRows]
  );

  const canCreate = !!perms?.line_flush_create;
  const canVerify = !!perms?.line_flush_verify;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Line Flush
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Production raises line flushes; store verifies them.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button style={tabBtn(activeTab === 'flushes')} onClick={() => setActiveTab('flushes')}>Flushes</button>
        <button style={tabBtn(activeTab === 'quarantine')} onClick={() => setActiveTab('quarantine')}>Quarantine Register</button>
      </div>

      {activeTab === 'flushes' && view === 'list' && (
        <>
          {pendingCount > 0 && (
            <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.3)', borderRadius: 4, padding: '8px 12px', marginBottom: 12, color: '#ff7070', fontSize: 12 }}>
              ⚠ {pendingCount} flush{pendingCount === 1 ? '' : 'es'} awaiting store verification
            </div>
          )}
          <div style={panelStyle}>
            <div style={panelHeaderStyle}>
              <span>Flushes {flushRows.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({flushRows.length})</span>}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">All Statuses</option>
                  <option>Pending Verification</option>
                  <option>Verified</option>
                  <option>Disputed</option>
                </select>
                <button style={btnSecondary} onClick={loadFlushes} disabled={listLoading}>↻</button>
                {canCreate && (
                  <button style={btnPrimary} onClick={() => { resetNewForm(); setShowNewFlush(true); }}>+ NEW FLUSH</button>
                )}
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              {listLoading ? (
                <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
              ) : flushRows.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No flushes</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={tableThStyle}>Flush ID</th>
                      <th style={tableThStyle}>Date</th>
                      <th style={tableThStyle}>WO / Run</th>
                      <th style={tableThStyle}>Line</th>
                      <th style={tableThStyle}>Shift</th>
                      <th style={tableThStyle}>Parts</th>
                      <th style={tableThStyle}>Raised Qty</th>
                      <th style={tableThStyle}>Damages</th>
                      <th style={tableThStyle}>Raised By</th>
                      <th style={tableThStyle}>Status</th>
                      <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {flushRows.map((r) => {
                      const damages = (r.damaged_lines || 0) + (r.rejected_lines || 0);
                      return (
                        <tr key={r.flush_id} style={{ cursor: 'pointer' }} onClick={() => openFlushDetail(r.flush_id)}>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.flush_id}</td>
                          <td style={tableTdStyle}>{r.flush_date || '—'}</td>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.run_no || r.wo_no || 'Standalone'}</td>
                          <td style={tableTdStyle}>{r.line_no || '—'}</td>
                          <td style={tableTdStyle}>{r.shift || '—'}</td>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.line_count || r.parts_count || 0}</td>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.total_qty_raised || 0}</td>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: damages > 0 ? '#ff7070' : 'var(--t3)' }}>{damages > 0 ? damages : '—'}</td>
                          <td style={tableTdStyle}>{r.raised_by || '—'}</td>
                          <td style={tableTdStyle}><StatusBadge label={r.status || '—'} tone={LF_STATUS_TONES[r.status] || 'gray'} /></td>
                          <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                            <button
                              style={btnSecondary}
                              onClick={(e) => { e.stopPropagation(); openFlushDetail(r.flush_id); }}
                            >
                              VIEW →
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {activeTab === 'flushes' && view === 'detail' && (
        <FlushDetailView
          loading={detailLoading}
          data={currentFlush}
          canVerify={canVerify}
          verifyOpen={verifyOpen}
          openVerify={() => setVerifyOpen(true)}
          onVerified={handleVerified}
          onClose={() => { setView('list'); setCurrentFlush(null); setVerifyOpen(false); }}
        />
      )}

      <Modal
        open={showNewFlush}
        onClose={() => { resetNewForm(); setShowNewFlush(false); }}
        size="lg"
      >
        <NewFlushForm
          flushType={flushType} setFlushType={setFlushType}
          flushDate={flushDate} setFlushDate={setFlushDate}
          flushLine={flushLine} setFlushLine={setFlushLine}
          flushShift={flushShift} setFlushShift={setFlushShift}
          flushNotes={flushNotes} setFlushNotes={setFlushNotes}
          runs={runs}
          selectedRun={selectedRun} setSelectedRun={handleRunSelect}
          runInfo={runInfo}
          runPickList={runPickList}
          partCards={partCards}
          loadPartsFromRun={loadPartsFromRun}
          addEmptyCard={addEmptyCard}
          removeCard={removeCard}
          updateCard={updateCard}
          lookupPart={lookupPart}
          addSplit={addSplit}
          removeSplit={removeSplit}
          updateSplit={updateSplit}
          submitFlush={submitFlush}
          submitting={submitting}
          onCancel={() => { resetNewForm(); setShowNewFlush(false); }}
        />
      </Modal>

      {activeTab === 'quarantine' && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Quarantine Register {quarantine.length > 0 && <span style={{ color: '#ff7070', marginLeft: 6 }}>({quarantine.length})</span>}</span>
            <button style={btnSecondary} onClick={loadQuarantine} disabled={quarantineLoading}>↻ Refresh</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {quarantineLoading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : quarantine.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>Quarantine register is empty</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={tableThStyle}>Disp ID</th>
                    <th style={tableThStyle}>Date</th>
                    <th style={tableThStyle}>Flush</th>
                    <th style={tableThStyle}>WO</th>
                    <th style={tableThStyle}>Part Code</th>
                    <th style={tableThStyle}>Part Name</th>
                    <th style={tableThStyle}>Return Type</th>
                    <th style={tableThStyle}>Qty</th>
                    <th style={tableThStyle}>Bin</th>
                  </tr>
                </thead>
                <tbody>
                  {quarantine.map((q) => (
                    <tr key={q.disp_id}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{q.disp_id}</td>
                      <td style={tableTdStyle}>{(q.created_at || '').slice(0, 10) || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{q.flush_id || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{q.wo_no || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{q.part_code}</td>
                      <td style={tableTdStyle}>{q.part_name || '—'}</td>
                      <td style={tableTdStyle}>{q.return_type || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{q.qty}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{q.bin_code || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NewFlushForm(props) {
  const {
    flushType, setFlushType,
    flushDate, setFlushDate,
    flushLine, setFlushLine,
    flushShift, setFlushShift,
    flushNotes, setFlushNotes,
    runs, selectedRun, setSelectedRun, runInfo,
    runPickList, partCards,
    loadPartsFromRun, addEmptyCard, removeCard, updateCard, lookupPart,
    addSplit, removeSplit, updateSplit,
    submitFlush, submitting, onCancel,
  } = props;

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button style={btnSecondary} onClick={onCancel} disabled={submitting}>← Back to list</button>
      </div>
      <h2 style={{ fontFamily: 'var(--cond)', fontSize: 18, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' }}>New Line Flush</h2>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Flush Header</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 10 }}>
            <div>
              <span style={labelStyle}>Date</span>
              <input type="date" value={flushDate} onChange={(e) => setFlushDate(e.target.value)} style={{ ...inputStyle, fontFamily: 'var(--mono)', width: '100%' }} disabled={submitting} />
            </div>
            <div>
              <span style={labelStyle}>Flush Type</span>
              <select value={flushType} onChange={(e) => setFlushType(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                <option value="run">Production Run</option>
                <option value="standalone">Standalone</option>
              </select>
            </div>
            <div>
              <span style={labelStyle}>Line</span>
              <select value={flushLine} onChange={(e) => setFlushLine(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                <option>L1</option><option>L2</option><option>L3</option>
              </select>
            </div>
            <div>
              <span style={labelStyle}>Shift</span>
              <select value={flushShift} onChange={(e) => setFlushShift(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                <option>Morning</option><option>Afternoon</option><option>Night</option>
              </select>
            </div>
          </div>

          {flushType === 'run' && (
            <div style={{ marginBottom: 10 }}>
              <span style={labelStyle}>Production Run</span>
              <select
                value={selectedRun}
                onChange={(e) => setSelectedRun(e.target.value)}
                style={{ ...selectStyle, width: '100%' }}
                disabled={submitting}
              >
                <option value="">Select a run…</option>
                {runs.map((r) => (
                  <option key={r.run_no} value={r.run_no}>
                    {r.run_no} — {r.product} — {r.total_units || 0} units ({r.status})
                  </option>
                ))}
              </select>
              {runInfo && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
                  Run {runInfo.run_no} — {runInfo.product} — status {runInfo.status}
                </div>
              )}
            </div>
          )}

          <div>
            <span style={labelStyle}>Notes</span>
            <input type="text" placeholder="Optional notes…" value={flushNotes} onChange={(e) => setFlushNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Parts Being Returned</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {flushType === 'run' && selectedRun && runPickList.length > 0 && (
              <button style={btnSecondary} onClick={loadPartsFromRun} disabled={submitting}>↓ Load From Run</button>
            )}
            <button style={btnSecondary} onClick={addEmptyCard} disabled={submitting}>+ Add Part</button>
          </div>
        </div>
        <div style={panelBodyStyle}>
          {partCards.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
              No parts added yet — click "+ Add Part" or load from a selected run.
            </div>
          )}
          {partCards.map((card) => {
            const total = card.splits.reduce((s, sp) => s + (parseFloat(sp.qty) || 0), 0);
            return (
              <div key={card.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: 10, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1, minWidth: 240 }}>
                    <input
                      type="text"
                      value={card.partCode}
                      onChange={(e) => updateCard(card.id, 'partCode', e.target.value)}
                      onBlur={(e) => lookupPart(card.id, e.target.value)}
                      placeholder="Part code"
                      style={{ ...inputStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)', width: 140 }}
                      disabled={submitting}
                    />
                    <span style={{ fontSize: 12, color: 'var(--t2)' }}>{card.partName || '—'}</span>
                    {card.category && (
                      <span style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>· {card.category}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, color: 'var(--t3)' }}>Total: <strong style={{ color: 'var(--yellow)', fontFamily: 'var(--mono)' }}>{total}</strong></span>
                    <button onClick={() => removeCard(card.id)} disabled={submitting} style={{ background: 'transparent', border: '1px solid var(--border)', color: '#ff7070', cursor: 'pointer', fontSize: 11, borderRadius: 3, padding: '2px 8px' }}>✕</button>
                  </div>
                </div>

                {card.splits.map((s) => (
                  <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '200px 120px 24px', gap: 6, marginBottom: 4 }}>
                    <select
                      value={s.type}
                      onChange={(e) => updateSplit(card.id, s.id, 'type', e.target.value)}
                      style={selectStyle}
                      disabled={submitting}
                    >
                      {LF_RETURN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Qty"
                      value={s.qty}
                      onChange={(e) => updateSplit(card.id, s.id, 'qty', e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
                      disabled={submitting}
                    />
                    <button
                      onClick={() => removeSplit(card.id, s.id)}
                      disabled={submitting || card.splits.length <= 1}
                      style={{ background: 'transparent', border: '1px solid var(--border)', color: card.splits.length <= 1 ? 'var(--t3)' : '#ff7070', cursor: card.splits.length <= 1 ? 'not-allowed' : 'pointer', fontSize: 11, borderRadius: 3, padding: 0 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}

                <button onClick={() => addSplit(card.id)} disabled={submitting} style={{ ...btnSecondary, marginTop: 4, fontSize: 10 }}>
                  + Add Split
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} disabled={submitting} style={btnSecondary}>Cancel</button>
        <button onClick={submitFlush} disabled={submitting} style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}>
          {submitting ? 'SUBMITTING…' : 'SUBMIT FLUSH'}
        </button>
      </div>
    </>
  );
}

function FlushDetailView({ loading, data, canVerify, verifyOpen, openVerify, onVerified, onClose }) {
  const grouped = useMemoLineGroups(data?.lines);
  if (loading) {
    return (
      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          <button style={btnSecondary} onClick={onClose}>← Back</button>
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)' }}>Flush not found.</div>
        </div>
      </div>
    );
  }
  const { flush, dispositions } = data;
  const isPending = flush.status === 'Pending Verification';

  return (
    <>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button style={btnSecondary} onClick={onClose}>← Back to list</button>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 13 }}>{flush.flush_id}</span>
          <StatusBadge label={flush.status || '—'} tone={LF_STATUS_TONES[flush.status] || 'gray'} />
          {isPending && canVerify && !verifyOpen && (
            <button onClick={openVerify} style={btnPrimary}>VERIFY THIS FLUSH</button>
          )}
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Flush Details</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 12, fontSize: 12 }}>
            <div><div style={labelStyle}>Date</div><div>{flush.flush_date || '—'}</div></div>
            <div><div style={labelStyle}>Work Order</div><div style={{ fontFamily: 'var(--mono)' }}>{flush.run_no || flush.wo_no || 'Standalone'}</div></div>
            <div><div style={labelStyle}>Line</div><div>{flush.line_no || '—'}</div></div>
            <div><div style={labelStyle}>Shift</div><div>{flush.shift || '—'}</div></div>
            <div><div style={labelStyle}>Raised By</div><div>{flush.raised_by || '—'}</div></div>
          </div>
          {flush.notes && (
            <div style={{ marginTop: 10, padding: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, fontSize: 12, color: 'var(--t2)', fontStyle: 'italic' }}>
              {flush.notes}
            </div>
          )}
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Parts Returned by Production</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={tableThStyle}>Part Code</th>
                <th style={tableThStyle}>Part Name</th>
                <th style={tableThStyle}>Return Type</th>
                <th style={tableThStyle}>Qty Raised</th>
                <th style={tableThStyle}>Qty Verified</th>
                <th style={tableThStyle}>Variance</th>
                <th style={tableThStyle}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((group) => (
                <FragmentRows key={group.part_code} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {isPending && canVerify && verifyOpen && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Store Verification</span></div>
          <FlushVerifyPanel
            flushId={flush.flush_id}
            onClose={() => onVerified()}
            onVerified={onVerified}
          />
        </div>
      )}

      {Array.isArray(dispositions) && dispositions.length > 0 && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Dispositions ({dispositions.length})</span></div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={tableThStyle}>Part Code</th>
                  <th style={tableThStyle}>Part Name</th>
                  <th style={tableThStyle}>Disposition</th>
                  <th style={tableThStyle}>Qty</th>
                  <th style={tableThStyle}>Bin</th>
                  <th style={tableThStyle}>Rework WO</th>
                  <th style={tableThStyle}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {dispositions.map((d) => (
                  <tr key={d.disp_id}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{d.part_code}</td>
                    <td style={tableTdStyle}>{d.part_name || '—'}</td>
                    <td style={tableTdStyle}>{d.disposition || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{d.qty}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{d.bin_code || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{d.rework_wo_no || '—'}</td>
                    <td style={tableTdStyle}>{d.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function useMemoLineGroups(lines) {
  return useMemo(() => {
    const groups = {};
    (lines || []).forEach((l) => {
      const key = l.part_code;
      if (!groups[key]) groups[key] = { part_code: key, part_name: l.part_name, splits: [] };
      groups[key].splits.push(l);
    });
    return Object.values(groups);
  }, [lines]);
}

function FragmentRows({ group }) {
  const totalRaised = group.splits.reduce((s, l) => s + (parseFloat(l.qty_raised) || 0), 0);
  const totalVerified = group.splits.reduce((s, l) => s + (parseFloat(l.qty_verified) || 0), 0);
  const totalVariance = Math.round((totalVerified - totalRaised) * 100) / 100;
  return (
    <>
      {group.splits.map((l, i) => {
        const variance = Math.round(((parseFloat(l.qty_verified) || 0) - (parseFloat(l.qty_raised) || 0)) * 100) / 100;
        return (
          <tr key={l.line_id}>
            <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: i === 0 ? 'var(--yellow)' : 'var(--t3)' }}>
              {i === 0 ? group.part_code : '↳'}
            </td>
            <td style={tableTdStyle}>{i === 0 ? (group.part_name || '—') : ''}</td>
            <td style={tableTdStyle}>{l.return_type || '—'}</td>
            <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.qty_raised || 0}</td>
            <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.qty_verified ?? '—'}</td>
            <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: variance > 0 ? '#ffaa33' : variance < 0 ? '#ff7070' : 'var(--t3)' }}>
              {l.qty_verified == null ? '—' : (variance === 0 ? '—' : variance)}
            </td>
            <td style={tableTdStyle}>{l.notes || '—'}</td>
          </tr>
        );
      })}
      {group.splits.length > 1 && (
        <tr style={{ background: 'var(--surface2)' }}>
          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }} colSpan={3}>Part Total</td>
          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700 }}>{totalRaised}</td>
          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700 }}>{totalVerified || '—'}</td>
          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: totalVariance > 0 ? '#ffaa33' : totalVariance < 0 ? '#ff7070' : 'var(--t3)' }}>
            {totalVerified ? (totalVariance === 0 ? '—' : totalVariance) : '—'}
          </td>
          <td style={tableTdStyle}></td>
        </tr>
      )}
    </>
  );
}
