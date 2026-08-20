'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast, Combobox, useEscapeClose } from '@throttle/ui';
import { useProducts } from '../../../hooks/useProducts.js';

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
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

const tabBtn = (active) => ({
  background: active ? 'var(--yellow)' : 'var(--surface2)',
  color: active ? '#000' : 'var(--t3)',
  border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
  borderRadius: 4,
  padding: '5px 12px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 1,
  cursor: 'pointer',
  fontWeight: active ? 700 : 500,
});

function aggregateIssues(rows) {
  const map = {};
  rows.forEach((r) => {
    const key = r.issue_no;
    if (!map[key]) {
      map[key] = {
        issue_no:      r.issue_no,
        issue_date:    r.issue_date,
        issue_type:    r.issue_type,
        wo_no:         r.wo_no,
        run_id:        r.run_id,
        run_no:        r.run_no || null,
        product:       r.product,
        variant:       r.variant,
        colour:        r.colour || '',
        issued_by:     r.issued_by,
        part_count:    0,
        total_qty:     0,
      };
    }
    map[key].part_count += 1;
    map[key].total_qty += parseFloat(r.actual_issued) || 0;
  });
  return Object.values(map).sort((a, b) => (b.issue_date || '').localeCompare(a.issue_date || ''));
}

export default function StoreHistoryPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { PRODUCTS, loading: productsLoading } = useProducts();
  const [activeTab, setActiveTab] = useState('issues');

  // Issues state
  const [issueRows, setIssueRows] = useState([]);
  const [issueFilters, setIssueFilters] = useState({ product: '', type: '', from: '', to: '' });
  // Search is held separately from the dropdown filters because it is DEBOUNCED — every
  // keystroke would otherwise be a round trip to a 45k-row table.
  const [issueSearch, setIssueSearch] = useState('');
  const [issueSearchQ, setIssueSearchQ] = useState('');
  const [flushSearch, setFlushSearch] = useState('');
  const [flushSearchQ, setFlushSearchQ] = useState('');
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [detailIssueNo, setDetailIssueNo] = useState(null);

  // Flushes state
  const [flushRows, setFlushRows] = useState([]);
  const [flushStatus, setFlushStatus] = useState('');
  const [flushesLoading, setFlushesLoading] = useState(false);
  // Flush detail (Piyush, 2026-07-30): the Flush ID was styled as a link but had
  // no handler — clicking an Issue No. opened its contents, clicking a Flush ID
  // did nothing. Unlike issues (whose lines all arrive in the list payload and
  // are aggregated client-side), getFlushes returns header rows only, so the
  // detail is fetched per flush from the existing getFlush handler.
  const [detailFlushId, setDetailFlushId] = useState(null);
  const [flushDetail, setFlushDetail] = useState(null);
  const [flushDetailLoading, setFlushDetailLoading] = useState(false);

  // ⚠️ These filters USED to run client-side over whatever the worker's flat row cap had
  // returned — in practice the last 4 days. Filtering to an older date therefore emptied the
  // table instead of reaching back, which is what "unable to see old entries" meant. They are
  // server-side now; the client-side pass below is gone deliberately, not misplaced.
  const loadIssues = useCallback(async () => {
    if (!session) return;
    setIssuesLoading(true);
    try {
      const p = {};
      if (issueFilters.product) p.product = issueFilters.product;
      if (issueFilters.type)    p.issue_type = issueFilters.type;
      if (issueFilters.from)    p.from = issueFilters.from;
      if (issueFilters.to)      p.to = issueFilters.to;
      if (issueSearchQ)         p.q = issueSearchQ;
      const data = await garageFetch('getIssues', p, session);
      setIssueRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load issues', 'error');
      setIssueRows([]);
    } finally {
      setIssuesLoading(false);
    }
  }, [session, showToast, issueFilters, issueSearchQ]);

  const loadFlushes = useCallback(async () => {
    if (!session) return;
    setFlushesLoading(true);
    try {
      // Explicit limit: the worker still defaults to 50 for the pending-queue and report
      // callers, so the history screen has to say it wants history.
      const p = { limit: 2000 };
      if (flushStatus)  p.status = flushStatus;
      if (flushSearchQ) p.q = flushSearchQ;
      const data = await garageFetch('getFlushes', p, session);
      setFlushRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load flushes', 'error');
      setFlushRows([]);
    } finally {
      setFlushesLoading(false);
    }
  }, [session, flushStatus, flushSearchQ, showToast]);

  // 350ms debounce — the search now hits a 45k-row table, so a request per keystroke
  // would be both slow and pointless.
  useEffect(() => {
    const t = setTimeout(() => setIssueSearchQ(issueSearch.trim()), 350);
    return () => clearTimeout(t);
  }, [issueSearch]);
  useEffect(() => {
    const t = setTimeout(() => setFlushSearchQ(flushSearch.trim()), 350);
    return () => clearTimeout(t);
  }, [flushSearch]);

  useEffect(() => { loadIssues(); }, [loadIssues]);
  useEffect(() => {
    if (activeTab === 'flushes') loadFlushes();
  }, [activeTab, loadFlushes]);

  useEffect(() => {
    if (!detailFlushId || !session) { setFlushDetail(null); return; }
    let cancelled = false;
    setFlushDetailLoading(true);
    setFlushDetail(null);
    garageFetch('getFlush', { flush_id: detailFlushId }, session)
      .then((d) => { if (!cancelled) setFlushDetail(d || null); })
      .catch((e) => {
        if (cancelled) return;
        showToast(e.message || 'Failed to load flush', 'error');
        setDetailFlushId(null);
      })
      .finally(() => { if (!cancelled) setFlushDetailLoading(false); });
    return () => { cancelled = true; };
  }, [detailFlushId, session, showToast]);

  // The worker has already applied product/type/date/search, so this only groups the
  // line rows into issues. Re-filtering here would be dead code that hides a server bug.
  const filteredIssues = useMemo(() => aggregateIssues(issueRows), [issueRows]);

  const detailRows = useMemo(() => {
    if (!detailIssueNo) return [];
    return issueRows.filter((r) => r.issue_no === detailIssueNo);
  }, [issueRows, detailIssueNo]);

  function clearFilters() {
    setIssueFilters({ product: '', type: '', from: '', to: '' });
    setIssueSearch('');
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Store History
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Read-only record of past issues and line flushes.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button style={tabBtn(activeTab === 'issues')} onClick={() => setActiveTab('issues')}>Issues</button>
        <button style={tabBtn(activeTab === 'flushes')} onClick={() => setActiveTab('flushes')}>Line Flushes</button>
      </div>

      {activeTab === 'issues' && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>
              Issues {filteredIssues.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({filteredIssues.length})</span>}
              {/* The worker stops at 25,000 line rows to keep the payload sane. Landing
                  exactly on it means there is more history behind the filter — say so,
                  rather than presenting a clipped list as the whole answer. */}
              {issueRows.length >= 25000 && (
                <span style={{ color: 'var(--warn, #e8b93c)', marginLeft: 8, fontSize: 11, fontFamily: 'var(--mono)' }}>
                  showing the newest 25,000 lines — narrow the dates to see further back
                </span>
              )}
            </span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={issueSearch}
                onChange={(e) => setIssueSearch(e.target.value)}
                placeholder="Search issue no, part, WO…"
                style={{ ...inputStyle, minWidth: 200 }}
              />
              <div style={{ minWidth: 180 }}>
                <Combobox
                  value={issueFilters.product}
                  options={PRODUCTS.map((p) => ({ value: p, label: p }))}
                  onChange={(v) => setIssueFilters((f) => ({ ...f, product: v }))}
                  placeholder="All products"
                  loading={productsLoading}
                />
              </div>
              <select
                value={issueFilters.type}
                onChange={(e) => setIssueFilters((f) => ({ ...f, type: e.target.value }))}
                style={selectStyle}
              >
                <option value="">All Types</option>
                <option>Planned</option>
                <option>Ad Hoc</option>
                <option>Rework</option>
                <option>Short Issue</option>
              </select>
              <input
                type="date"
                value={issueFilters.from}
                onChange={(e) => setIssueFilters((f) => ({ ...f, from: e.target.value }))}
                style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
              />
              <input
                type="date"
                value={issueFilters.to}
                onChange={(e) => setIssueFilters((f) => ({ ...f, to: e.target.value }))}
                style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
              />
              <button style={btnSecondary} onClick={clearFilters}>Clear</button>
              <button style={btnSecondary} onClick={loadIssues} disabled={issuesLoading}>↻</button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {issuesLoading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : filteredIssues.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No issues match the filter</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={tableThStyle}>Issue No.</th>
                    <th style={tableThStyle}>Date</th>
                    <th style={tableThStyle}>Type</th>
                    <th style={tableThStyle}>WO / Run</th>
                    <th style={tableThStyle}>Product</th>
                    <th style={tableThStyle}>Variant</th>
                    <th style={tableThStyle}>Colour</th>
                    <th style={tableThStyle}>Parts</th>
                    <th style={tableThStyle}>Total Qty</th>
                    <th style={tableThStyle}>Issued By</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.map((r) => (
                    <tr key={r.issue_no}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)', cursor: 'pointer' }} onClick={() => setDetailIssueNo(r.issue_no)}>{r.issue_no}</td>
                      <td style={tableTdStyle}>{r.issue_date || '—'}</td>
                      <td style={tableTdStyle}><StatusBadge label={r.issue_type || '—'} tone={issueTypeTone(r.issue_type)} /></td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.wo_no || r.run_no || '—'}</td>
                      <td style={tableTdStyle}>{r.product || '—'}</td>
                      <td style={tableTdStyle}>{r.variant || '—'}</td>
                      <td style={tableTdStyle}>{r.colour || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.part_count}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.total_qty}</td>
                      <td style={tableTdStyle}>{r.issued_by || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {activeTab === 'flushes' && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Line Flushes {flushRows.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({flushRows.length})</span>}</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={flushSearch}
                onChange={(e) => setFlushSearch(e.target.value)}
                placeholder="Search flush ID, WO, run…"
                style={{ ...inputStyle, minWidth: 200 }}
              />
              <select
                value={flushStatus}
                onChange={(e) => setFlushStatus(e.target.value)}
                style={selectStyle}
              >
                <option value="">All Statuses</option>
                <option>Pending Verification</option>
                <option>Verified</option>
                <option>Disputed</option>
              </select>
              <button style={btnSecondary} onClick={loadFlushes} disabled={flushesLoading}>↻</button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {flushesLoading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : flushRows.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No flushes match the filter</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={tableThStyle}>Flush ID</th>
                    <th style={tableThStyle}>Date</th>
                    <th style={tableThStyle}>Run / WO</th>
                    <th style={tableThStyle}>Line</th>
                    <th style={tableThStyle}>Shift</th>
                    <th style={tableThStyle}>Parts</th>
                    <th style={tableThStyle}>Raised By</th>
                    <th style={tableThStyle}>Verified By</th>
                    <th style={tableThStyle}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {flushRows.map((r) => (
                    <tr key={r.flush_id}>
                      <td
                        style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)', cursor: 'pointer' }}
                        onClick={() => setDetailFlushId(r.flush_id)}
                      >{r.flush_id}</td>
                      <td style={tableTdStyle}>{r.flush_date || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.run_no || r.wo_no || 'Standalone'}</td>
                      <td style={tableTdStyle}>{r.line_no || '—'}</td>
                      <td style={tableTdStyle}>{r.shift || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.line_count || r.parts_count || 0}</td>
                      <td style={tableTdStyle}>{r.raised_by || '—'}</td>
                      <td style={tableTdStyle}>{r.verified_by || '—'}</td>
                      <td style={tableTdStyle}><StatusBadge label={r.status || '—'} tone={LF_STATUS_TONES[r.status] || 'gray'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {detailIssueNo && (
        <IssueDetailModal
          issueNo={detailIssueNo}
          rows={detailRows}
          onClose={() => setDetailIssueNo(null)}
        />
      )}

      {detailFlushId && (
        <FlushDetailModal
          flushId={detailFlushId}
          detail={flushDetail}
          loading={flushDetailLoading}
          onClose={() => setDetailFlushId(null)}
        />
      )}
    </div>
  );
}

function IssueDetailModal({ issueNo, rows, onClose }) {
  useEscapeClose(true, onClose);
  if (!rows.length) {
    return (
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000 }}
      >
        <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee' }}>
          Issue {issueNo} not found.
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <button onClick={onClose} style={btnSecondary}>Close</button>
          </div>
        </div>
      </div>
    );
  }
  const head = rows[0];
  const totalBomIssue = rows.reduce((s, r) => s + (parseFloat(r.bom_issue_qty) || 0), 0);
  const totalActual   = rows.reduce((s, r) => s + (parseFloat(r.actual_issued)  || 0), 0);
  const totalVariance = totalActual - totalBomIssue;

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 720, maxWidth: 980, maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 16 }}>{head.issue_no}</h3>
          <button onClick={onClose} style={btnSecondary}>✕ Close</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 14 }}>
          {head.issue_date || '—'} · <StatusBadge label={head.issue_type || '—'} tone={issueTypeTone(head.issue_type)} />
          {head.wo_no && <> · WO {head.wo_no}</>}
          {head.run_id && <> · Run {head.run_id}</>}
          {head.product && <> · {head.product}</>}
          {head.variant && <> · {head.variant}</>}
          {head.colour && <> · {head.colour}</>}
          {head.issued_by && <> · {head.issued_by}</>}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={tableThStyle}>Part Code</th>
              <th style={tableThStyle}>Part Name</th>
              <th style={tableThStyle}>BOM Qty/Unit</th>
              <th style={tableThStyle}>BOM Issue</th>
              <th style={tableThStyle}>Actual Issued</th>
              <th style={tableThStyle}>Variance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const bomIssue = parseFloat(r.bom_issue_qty) || 0;
              const actual = parseFloat(r.actual_issued) || 0;
              const variance = Math.round((actual - bomIssue) * 100) / 100;
              const vColor = variance > 0 ? '#ffaa33' : variance < 0 ? '#ff7070' : 'var(--t3)';
              return (
                <tr key={`${r.issue_no}-${r.part_code}-${i}`}>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.part_code}</td>
                  <td style={tableTdStyle}>{r.part_name || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.bom_qty ?? '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{bomIssue}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{actual}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: vColor }}>{variance === 0 ? '—' : variance}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: 'var(--surface2)' }}>
              <td style={{ ...tableTdStyle, fontWeight: 700 }} colSpan={3}>TOTALS</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700 }}>{totalBomIssue}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700 }}>{totalActual}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: totalVariance > 0 ? '#ffaa33' : totalVariance < 0 ? '#ff7070' : 'var(--t3)' }}>
                {totalVariance === 0 ? '—' : totalVariance}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// Flush detail — the Line Flushes twin of IssueDetailModal (Piyush, 2026-07-30).
// Shows what was raised per part and, where the flush has been verified, what
// each part was actually dispositioned to (Return to Stock / Damaged / Rework /
// Rejected, with bin). Dispositions are grouped by line_id: one raised line can
// split across several dispositions, which is the whole point of verification.
function FlushDetailModal({ flushId, detail, loading, onClose }) {
  useEscapeClose(true, onClose);

  const shell = (children) => (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 720, maxWidth: 980, maxHeight: '90vh', overflowY: 'auto' }}
      >
        {children}
      </div>
    </div>
  );

  if (loading) {
    return shell(<div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>);
  }
  if (!detail || !detail.flush) {
    return shell(
      <>
        Flush {flushId} not found.
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </>
    );
  }

  const head  = detail.flush;
  const lines = Array.isArray(detail.lines) ? detail.lines : [];
  const disps = Array.isArray(detail.dispositions) ? detail.dispositions : [];

  const dispsByLine = {};
  disps.forEach((d) => {
    if (!dispsByLine[d.line_id]) dispsByLine[d.line_id] = [];
    dispsByLine[d.line_id].push(d);
  });

  const totalRaised = lines.reduce((s, l) => s + (parseFloat(l.qty_raised) || 0), 0);
  const totalDisp   = disps.reduce((s, d) => s + (parseFloat(d.qty) || 0), 0);
  const hasDisps    = disps.length > 0;
  const totalDiff   = Math.round((totalDisp - totalRaised) * 100) / 100;

  return shell(
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 16 }}>{head.flush_id}</h3>
        <button onClick={onClose} style={btnSecondary}>✕ Close</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 14 }}>
        {head.flush_date || '—'} · <StatusBadge label={head.status || '—'} tone={LF_STATUS_TONES[head.status] || 'gray'} />
        {(head.run_no || head.wo_no) && <> · {head.run_no || head.wo_no}</>}
        {head.line_no && <> · Line {head.line_no}</>}
        {head.shift && <> · {head.shift}</>}
        {head.raised_by && <> · Raised by {head.raised_by}</>}
        {head.verified_by && <> · Verified by {head.verified_by}</>}
      </div>
      {head.notes && (
        <div style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 14, fontStyle: 'italic' }}>{head.notes}</div>
      )}

      {lines.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>This flush has no parts recorded.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={tableThStyle}>Part Code</th>
              <th style={tableThStyle}>Part Name</th>
              <th style={tableThStyle}>Return Type</th>
              <th style={tableThStyle}>Qty Raised</th>
              <th style={tableThStyle}>Where It Went</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const mine = dispsByLine[l.line_id] || [];
              return (
                <tr key={`${l.line_id}-${i}`}>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.part_code}</td>
                  <td style={tableTdStyle}>{l.part_name || '—'}</td>
                  <td style={tableTdStyle}>{l.return_type || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{parseFloat(l.qty_raised) || 0}</td>
                  <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>
                    {mine.length === 0 ? (
                      <span style={{ color: 'var(--t3)' }}>Not yet verified</span>
                    ) : (
                      mine.map((d, di) => (
                        <div key={`${d.disp_id}-${di}`} style={{ fontSize: 11 }}>
                          <span style={{ fontFamily: 'var(--mono)' }}>{parseFloat(d.qty) || 0}</span>
                          {' → '}{d.disposition || '—'}
                          {d.bin_code && <span style={{ color: 'var(--t3)' }}> · bin {d.bin_code}</span>}
                          {d.rework_wo_no && <span style={{ color: 'var(--t3)' }}> · {d.rework_wo_no}</span>}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: 'var(--surface2)' }}>
              <td style={{ ...tableTdStyle, fontWeight: 700 }} colSpan={3}>TOTALS</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700 }}>{Math.round(totalRaised * 100) / 100}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: !hasDisps ? 'var(--t3)' : totalDiff === 0 ? 'var(--t3)' : totalDiff > 0 ? '#ffaa33' : '#ff7070' }}>
                {hasDisps ? `${Math.round(totalDisp * 100) / 100}${totalDiff === 0 ? '' : ` (${totalDiff > 0 ? '+' : ''}${totalDiff})`}` : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </>
  );
}
