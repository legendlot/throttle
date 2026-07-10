'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { RotateCw } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, ToneBadge, btnPrimary, btnGhost, inputStyle, lineColor, lineRgb,
} from '../../../components/kit/index.js';

// Pit Wall v2 reskin — flush flows, calls and payloads unchanged.

const LF_RETURN_TYPES = ['Unused', 'Damaged', 'QC Rejected', 'Partial Assembly', 'Wrong Issue'];
const LF_STATUS_TONES = { 'Pending Verification': 'warn', Verified: 'ok', Disputed: 'bad' };

/* ── v2 style vocabulary ─────────────────────────────────────── */
const inp = { ...inputStyle, fontSize: 13.5, width: 'auto' };
const inpFull = { ...inputStyle, fontSize: 13.5 };
const numInp = { ...inpFull, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' };
const lblStyle = { display: 'block', marginBottom: 6 };
const th = { padding: '9px 12px', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', textAlign: 'left', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td = { padding: '9px 12px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap' };
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 26, background: 'transparent', border: '1px solid var(--border-2)',
  borderRadius: 'var(--r-xs)', color: 'var(--t3)', cursor: 'pointer',
};

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
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [view, setView] = useState('list'); // list | detail
  const [showNewFlush, setShowNewFlush] = useState(false);

  // List state
  const [flushRows, setFlushRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [listLoading, setListLoading] = useState(true);

  // Detail state
  const [currentFlush, setCurrentFlush] = useState(null); // { flush, lines, dispositions }
  const [detailLoading, setDetailLoading] = useState(false);

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

  const loadFlushes = useCallback(async () => {
    if (!session) return;
    setListLoading(true);
    setRefreshing(true);
    try {
      const data = await garageFetch('getFlushes', statusFilter ? { status: statusFilter } : {}, session);
      setFlushRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load flushes', 'error');
      setFlushRows([]);
    } finally {
      setListLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, statusFilter, showToast, setRefreshing, setLastRefreshed]);

  useEffect(() => { loadFlushes(); }, [loadFlushes]);

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

  const pendingCount = useMemo(
    () => flushRows.filter((r) => r.status === 'Pending Verification').length,
    [flushRows]
  );

  const canCreate = !!perms?.line_flush_create;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <p style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', margin: '0 0 16px', lineHeight: 1.5 }}>
        Raise a line flush to return leftover material to the store. The store receives, dispositions and verifies it in Garage (Flush Verify).
      </p>

      {view === 'list' && (
        <>
          {pendingCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--bad-bg)',
              border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)', padding: '9px 13px',
              marginBottom: 14, color: 'var(--bad-fg)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
              <Icon name="alert" size={15} />
              <span><span className="num" style={{ fontWeight: 700 }}>{pendingCount}</span> flush{pendingCount === 1 ? '' : 'es'} awaiting store verification</span>
            </div>
          )}
          <Panel
            title="Flushes"
            icon="undo"
            pad={0}
            action={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {flushRows.length > 0 && <span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>{flushRows.length}</span>}
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  style={{ ...inp, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer' }}
                >
                  <option value="">All Statuses</option>
                  <option>Pending Verification</option>
                  <option>Verified</option>
                  <option>Disputed</option>
                </select>
                <button style={{ ...btnGhost, padding: '6px 10px' }} onClick={loadFlushes} disabled={listLoading} title="Refresh">
                  <RotateCw size={14} strokeWidth={1.75} />
                </button>
                {canCreate && (
                  <button style={{ ...btnPrimary, padding: '7px 14px' }} onClick={() => { resetNewForm(); setShowNewFlush(true); }}>
                    <Icon name="plus" size={14} />New Flush
                  </button>
                )}
              </div>
            }
          >
            <div style={{ overflowX: 'auto' }}>
              {listLoading ? (
                <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
              ) : flushRows.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>No flushes</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th}>Flush ID</th>
                      <th style={th}>Date</th>
                      <th style={th}>WO / Run</th>
                      <th style={th}>Line</th>
                      <th style={th}>Shift</th>
                      <th style={th}>Parts</th>
                      <th style={th}>Raised Qty</th>
                      <th style={th}>Damages</th>
                      <th style={th}>Raised By</th>
                      <th style={th}>Status</th>
                      <th style={{ ...th, textAlign: 'right' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {flushRows.map((r) => {
                      const damages = (r.damaged_lines || 0) + (r.rejected_lines || 0);
                      return (
                        <tr key={r.flush_id} style={{ cursor: 'pointer' }} onClick={() => openFlushDetail(r.flush_id)}>
                          <td style={td}><span className="num" style={{ color: 'var(--yellow)' }}>{r.flush_id}</span></td>
                          <td style={td}><span className="num">{r.flush_date || '—'}</span></td>
                          <td style={td}><span className="num" style={{ fontSize: 12, color: 'var(--t2)' }}>{r.run_no || r.wo_no || 'Standalone'}</span></td>
                          <td style={td}>{r.line_no
                            ? <span className="num" style={{ fontSize: 11, fontWeight: 700, color: lineColor(r.line_no), background: `rgba(${lineRgb(r.line_no)},0.12)`, padding: '1px 6px', borderRadius: 3 }}>{r.line_no}</span>
                            : '—'}</td>
                          <td style={{ ...td, color: 'var(--t2)' }}>{r.shift || '—'}</td>
                          <td style={td}><span className="num">{r.line_count || r.parts_count || 0}</span></td>
                          <td style={td}><span className="num">{r.total_qty_raised || 0}</span></td>
                          <td style={td}><span className="num" style={{ color: damages > 0 ? 'var(--bad-fg)' : 'var(--t3)' }}>{damages > 0 ? damages : '—'}</span></td>
                          <td style={{ ...td, color: 'var(--t2)' }}>{r.raised_by || '—'}</td>
                          <td style={td}><ToneBadge tone={LF_STATUS_TONES[r.status] || 'mute'}>{r.status || '—'}</ToneBadge></td>
                          <td style={{ ...td, textAlign: 'right' }}>
                            <button
                              style={{ ...btnGhost, padding: '5px 10px', fontSize: 12 }}
                              onClick={(e) => { e.stopPropagation(); openFlushDetail(r.flush_id); }}
                            >
                              View<Icon name="chevR" size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        </>
      )}

      {view === 'detail' && (
        <FlushDetailView
          loading={detailLoading}
          data={currentFlush}
          onClose={() => { setView('list'); setCurrentFlush(null); }}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Icon name="plus" size={17} style={{ color: 'var(--yellow)' }} />
        <span className="label" style={{ fontSize: 13, color: 'var(--t1)', flex: 1 }}>New line flush</span>
        <button style={{ ...btnGhost, padding: '5px 10px', fontSize: 12 }} onClick={onCancel} disabled={submitting}>
          <Icon name="chevL" size={13} />Back to list
        </button>
      </div>

      <Panel title="Flush Header" icon="clipboard" pad={16} style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 12 }}>
          <div>
            <span className="eyebrow" style={lblStyle}>Date</span>
            <input type="date" value={flushDate} onChange={(e) => setFlushDate(e.target.value)} style={numInp} disabled={submitting} />
          </div>
          <div>
            <span className="eyebrow" style={lblStyle}>Flush Type</span>
            <select value={flushType} onChange={(e) => setFlushType(e.target.value)} style={{ ...inpFull, cursor: 'pointer' }} disabled={submitting}>
              <option value="run">Production Run</option>
              <option value="standalone">Standalone</option>
            </select>
          </div>
          <div>
            <span className="eyebrow" style={lblStyle}>Line</span>
            <div style={{ display: 'flex', gap: 5 }}>
              {['L1', 'L2', 'L3', 'L4', 'L5'].map(l => (
                <button key={l} type="button" disabled={submitting} onClick={() => setFlushLine(l)}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                    border: `1px solid ${flushLine === l ? lineColor(l) : 'var(--border-2)'}`,
                    background: flushLine === l ? `rgba(${lineRgb(l)},0.12)` : 'var(--surface-2)',
                    color: flushLine === l ? lineColor(l) : 'var(--t2)',
                    fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12, letterSpacing: '0.05em',
                    transition: 'all var(--fast) var(--ease)' }}>{l}</button>
              ))}
            </div>
          </div>
          <div>
            <span className="eyebrow" style={lblStyle}>Shift</span>
            <select value={flushShift} onChange={(e) => setFlushShift(e.target.value)} style={{ ...inpFull, cursor: 'pointer' }} disabled={submitting}>
              <option>Morning</option><option>Afternoon</option><option>Night</option>
            </select>
          </div>
        </div>

        {flushType === 'run' && (
          <div style={{ marginBottom: 12 }}>
            <span className="eyebrow" style={lblStyle}>Production Run</span>
            <select
              value={selectedRun}
              onChange={(e) => setSelectedRun(e.target.value)}
              style={{ ...inpFull, cursor: 'pointer' }}
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
              <div className="num" style={{ marginTop: 6, fontSize: 11.5, color: 'var(--t3)' }}>
                Run {runInfo.run_no} — {runInfo.product} — status {runInfo.status}
              </div>
            )}
          </div>
        )}

        <div>
          <span className="eyebrow" style={lblStyle}>Notes</span>
          <input type="text" placeholder="Optional notes…" value={flushNotes} onChange={(e) => setFlushNotes(e.target.value)} style={inpFull} disabled={submitting} />
        </div>
      </Panel>

      <Panel
        title="Parts Being Returned"
        icon="box"
        pad={16}
        style={{ marginBottom: 16 }}
        action={
          <div style={{ display: 'flex', gap: 6 }}>
            {flushType === 'run' && selectedRun && runPickList.length > 0 && (
              <button style={{ ...btnGhost, padding: '5px 10px', fontSize: 12 }} onClick={loadPartsFromRun} disabled={submitting}>
                <Icon name="arrowDown" size={13} />Load from run
              </button>
            )}
            <button style={{ ...btnGhost, padding: '5px 10px', fontSize: 12 }} onClick={addEmptyCard} disabled={submitting}>
              <Icon name="plus" size={13} />Add part
            </button>
          </div>
        }
      >
        {partCards.length === 0 && (
          <div style={{ padding: 18, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
            No parts added yet — click &quot;Add part&quot; or load from a selected run.
          </div>
        )}
        {partCards.map((card) => {
          const total = card.splits.reduce((s, sp) => s + (parseFloat(sp.qty) || 0), 0);
          return (
            <div key={card.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 9, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', flex: 1, minWidth: 240 }}>
                  <input
                    type="text"
                    value={card.partCode}
                    onChange={(e) => updateCard(card.id, 'partCode', e.target.value)}
                    onBlur={(e) => lookupPart(card.id, e.target.value)}
                    placeholder="Part code"
                    style={{ ...numInp, color: 'var(--yellow)', width: 140, background: 'var(--bg-2)' }}
                    disabled={submitting}
                  />
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t2)' }}>{card.partName || '—'}</span>
                  {card.category && (
                    <span className="eyebrow">· {card.category}</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span className="eyebrow">Total <span className="num" style={{ color: 'var(--yellow)', fontSize: 13, fontWeight: 700, letterSpacing: 0 }}>{total}</span></span>
                  <button onClick={() => removeCard(card.id)} disabled={submitting} style={{ ...iconBtn, color: 'var(--bad-fg)' }} title="Remove part">
                    <Icon name="x" size={13} />
                  </button>
                </div>
              </div>

              {card.splits.map((s) => (
                <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '200px 120px 28px', gap: 6, marginBottom: 5 }}>
                  <select
                    value={s.type}
                    onChange={(e) => updateSplit(card.id, s.id, 'type', e.target.value)}
                    style={{ ...inpFull, cursor: 'pointer', background: 'var(--bg-2)' }}
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
                    style={{ ...numInp, background: 'var(--bg-2)' }}
                    disabled={submitting}
                  />
                  <button
                    onClick={() => removeSplit(card.id, s.id)}
                    disabled={submitting || card.splits.length <= 1}
                    style={{ ...iconBtn, width: '100%', height: '100%',
                      color: card.splits.length <= 1 ? 'var(--t4)' : 'var(--bad-fg)',
                      cursor: card.splits.length <= 1 ? 'not-allowed' : 'pointer' }}
                    title="Remove split"
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              ))}

              <button onClick={() => addSplit(card.id)} disabled={submitting} style={{ ...btnGhost, marginTop: 5, padding: '4px 9px', fontSize: 11.5, background: 'transparent' }}>
                <Icon name="plus" size={12} />Add split
              </button>
            </div>
          );
        })}
      </Panel>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button onClick={onCancel} disabled={submitting} style={btnGhost}>Cancel</button>
        <button onClick={submitFlush} disabled={submitting} style={{ ...btnPrimary, padding: '9px 18px', opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}>
          {submitting ? 'Submitting…' : 'Submit Flush'}
        </button>
      </div>
    </>
  );
}

function FlushDetailView({ loading, data, onClose }) {
  const grouped = useMemoLineGroups(data?.lines);
  if (loading) {
    return (
      <Panel pad={24}>
        <div style={{ display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel pad={16}>
        <button style={btnGhost} onClick={onClose}><Icon name="chevL" size={13} />Back</button>
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>Flush not found.</div>
      </Panel>
    );
  }
  const { flush, dispositions } = data;

  return (
    <>
      <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button style={btnGhost} onClick={onClose}><Icon name="chevL" size={13} />Back to list</button>
        <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
          <span className="num" style={{ color: 'var(--yellow)', fontSize: 14, fontWeight: 700 }}>{flush.flush_id}</span>
          <ToneBadge tone={LF_STATUS_TONES[flush.status] || 'mute'}>{flush.status || '—'}</ToneBadge>
        </div>
      </div>

      <Panel title="Flush Details" icon="clipboard" pad={16} style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 14 }}>
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Date</div><div className="num" style={{ fontSize: 13 }}>{flush.flush_date || '—'}</div></div>
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Work Order</div><div className="num" style={{ fontSize: 13 }}>{flush.run_no || flush.wo_no || 'Standalone'}</div></div>
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Line</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>{flush.line_no
            ? <span className="num" style={{ fontSize: 11, fontWeight: 700, color: lineColor(flush.line_no), background: `rgba(${lineRgb(flush.line_no)},0.12)`, padding: '1px 6px', borderRadius: 3 }}>{flush.line_no}</span>
            : '—'}</div></div>
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Shift</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>{flush.shift || '—'}</div></div>
          <div><div className="eyebrow" style={{ marginBottom: 4 }}>Raised By</div><div style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>{flush.raised_by || '—'}</div></div>
        </div>
        {flush.notes && (
          <div style={{ marginTop: 12, padding: '9px 12px', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t2)' }}>
            {flush.notes}
          </div>
        )}
      </Panel>

      <Panel title="Parts Returned by Production" icon="undo" pad={0} style={{ marginBottom: 16 }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Part Code</th>
                <th style={th}>Part Name</th>
                <th style={th}>Return Type</th>
                <th style={th}>Qty Raised</th>
                <th style={th}>Qty Verified</th>
                <th style={th}>Variance</th>
                <th style={th}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((group) => (
                <FragmentRows key={group.part_code} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {Array.isArray(dispositions) && dispositions.length > 0 && (
        <Panel title={`Dispositions (${dispositions.length})`} icon="flow" pad={0}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Part Code</th>
                  <th style={th}>Part Name</th>
                  <th style={th}>Disposition</th>
                  <th style={th}>Qty</th>
                  <th style={th}>Bin</th>
                  <th style={th}>Rework WO</th>
                  <th style={th}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {dispositions.map((d) => (
                  <tr key={d.disp_id}>
                    <td style={td}><span className="num" style={{ color: 'var(--yellow)' }}>{d.part_code}</span></td>
                    <td style={td}>{d.part_name || '—'}</td>
                    <td style={{ ...td, color: 'var(--t2)' }}>{d.disposition || '—'}</td>
                    <td style={td}><span className="num">{d.qty}</span></td>
                    <td style={td}><span className="num">{d.bin_code || '—'}</span></td>
                    <td style={td}><span className="num">{d.rework_wo_no || '—'}</span></td>
                    <td style={{ ...td, color: 'var(--t2)' }}>{d.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
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
            <td style={td}><span className="num" style={{ color: i === 0 ? 'var(--yellow)' : 'var(--t3)' }}>
              {i === 0 ? group.part_code : '↳'}
            </span></td>
            <td style={td}>{i === 0 ? (group.part_name || '—') : ''}</td>
            <td style={{ ...td, color: 'var(--t2)' }}>{l.return_type || '—'}</td>
            <td style={td}><span className="num">{l.qty_raised || 0}</span></td>
            <td style={td}><span className="num">{l.qty_verified ?? '—'}</span></td>
            <td style={td}><span className="num" style={{ color: variance > 0 ? 'var(--warn-fg)' : variance < 0 ? 'var(--bad-fg)' : 'var(--t3)' }}>
              {l.qty_verified == null ? '—' : (variance === 0 ? '—' : variance)}
            </span></td>
            <td style={{ ...td, color: 'var(--t2)' }}>{l.notes || '—'}</td>
          </tr>
        );
      })}
      {group.splits.length > 1 && (
        <tr style={{ background: 'var(--surface-2)' }}>
          <td style={{ ...td, fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, color: 'var(--t3)', letterSpacing: '0.12em', textTransform: 'uppercase' }} colSpan={3}>Part Total</td>
          <td style={td}><span className="num" style={{ fontWeight: 700 }}>{totalRaised}</span></td>
          <td style={td}><span className="num" style={{ fontWeight: 700 }}>{totalVerified || '—'}</span></td>
          <td style={td}><span className="num" style={{ fontWeight: 700, color: totalVariance > 0 ? 'var(--warn-fg)' : totalVariance < 0 ? 'var(--bad-fg)' : 'var(--t3)' }}>
            {totalVerified ? (totalVariance === 0 ? '—' : totalVariance) : '—'}
          </span></td>
          <td style={td}></td>
        </tr>
      )}
    </>
  );
}
