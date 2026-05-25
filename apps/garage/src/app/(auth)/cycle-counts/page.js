'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState, buildCycleCountSheetHtml, printWindow } from '@throttle/ui';

const STATUS_TABS = [
  { id: 'in_progress', label: 'In Progress',  tone: 'yellow' },
  { id: 'counted',     label: 'Counted',      tone: 'blue'   },
  { id: 'reconciled',  label: 'Reconciled',   tone: 'green'  },
  { id: 'cancelled',   label: 'Cancelled',    tone: 'gray'   },
  { id: 'all',         label: 'All',          tone: 'gray'   },
];
const TONE = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.25)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)'    },
};
const panel  = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr   = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody  = { padding: '12px 14px' };
const th     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td     = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };
const input  = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const lbl    = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP   = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS   = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function StatusBadge({ status }) {
  const tab = STATUS_TABS.find(t => t.id === status) || { label: status, tone: 'gray' };
  const s = TONE[tab.tone];
  return <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', background: s.bg, color: s.fg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>{tab.label}</span>;
}

function fmtTs(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } }
function fmtNum(n) { if (n == null) return '—'; return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }); } catch { return d; } }

export default function CycleCountsPage() {
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const canRecord  = hasPermission(perms, 'cycle_count_record');
  const canAdmin   = hasPermission(perms, 'cycle_count_admin');

  const [tab,      setTab]      = useState('in_progress');
  const [counts,   setCounts]   = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [activeCount, setActiveCount] = useState(null);  // count_no for detail
  const [detail,      setDetail]      = useState(null);  // { header, lines }
  const [detailLoading, setDetailLoading] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  async function loadList() {
    if (!session) return;
    setLoading(true);
    try {
      const filter = tab === 'all' ? {} : { status: tab };
      const r = await workerFetch('getCycleCounts', { data: filter }, session);
      setCounts(r?.ok ? (r.data || []) : []);
    } finally { setLoading(false); }
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [tab, session]);

  async function openDetail(count_no, opts = {}) {
    setActiveCount(count_no);
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await workerFetch('getCycleCount', { data: { count_no, blind: opts.blind !== false } }, session);
      setDetail(r?.ok ? r.data : null);
    } finally { setDetailLoading(false); }
  }

  if (activeCount && detail) {
    return <CountDetailView
      header={detail.header}
      lines={detail.lines}
      session={session}
      toast={toast}
      onBack={() => { setActiveCount(null); setDetail(null); loadList(); }}
      onReload={() => openDetail(activeCount, { blind: detail.header.status === 'in_progress' })}
      canRecord={canRecord}
    />;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <span>Cycle Counts</span>
          {canRecord && <button onClick={() => setNewOpen(true)} style={btnP}>+ NEW COUNT</button>}
        </div>
        <div style={pbody}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {STATUS_TABS.map(t => {
              const active = tab === t.id;
              const s = TONE[t.tone];
              return <button key={t.id} onClick={() => setTab(t.id)} style={{
                background: active ? s.bg : 'transparent',
                border: `1px solid ${active ? s.border : 'var(--border)'}`,
                color: active ? s.fg : 'var(--t2)',
                borderRadius: 3, padding: '5px 12px', fontSize: 11,
                cursor: 'pointer', fontFamily: 'var(--cond)',
                letterSpacing: '0.05em', textTransform: 'uppercase',
                fontWeight: active ? 700 : 400,
              }}>{t.label}</button>;
            })}
          </div>
          {loading ? <Spinner /> : counts.length === 0 ? (
            <EmptyState title="No counts" message={`No ${STATUS_TABS.find(t => t.id === tab)?.label.toLowerCase()} cycle counts.`} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Count No</th>
                    <th style={th}>Date</th>
                    <th style={th}>Type</th>
                    <th style={th}>Area</th>
                    <th style={th}>Status</th>
                    <th style={th}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map(c => (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(c.count_no, { blind: c.status === 'in_progress' })}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{c.count_no}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtDate(c.count_date)}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t2)' }}>{c.count_type}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t2)' }}>{c.area || '—'}</td>
                      <td style={td}><StatusBadge status={c.status} /></td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{fmtTs(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {newOpen && (
        <NewCountModal
          onClose={() => setNewOpen(false)}
          onCreated={(count_no) => { setNewOpen(false); loadList(); openDetail(count_no, { blind: true }); }}
          session={session}
          toast={toast}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// New Count modal — pulls due parts from schedule, lets user pick subset
// ─────────────────────────────────────────────────────────────────────────────
function NewCountModal({ onClose, onCreated, session, toast }) {
  const [schedule, setSchedule] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [search,   setSearch]   = useState('');
  const [classFilter, setClassFilter] = useState('all');
  const [area,        setArea]        = useState('');
  const [counterName, setCounterName] = useState('');
  const [notes,       setNotes]       = useState('');
  const [creating,    setCreating]    = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await workerFetch('getCycleCountSchedule', {}, session);
        setSchedule(r?.ok ? r.data : null);
      } finally { setLoading(false); }
    })();
  }, [session]);

  // Multi-token AND-of-OR across product / part_code / part_name / abc_class.
  // Matches Stock Ledger pattern — "Flare A" picks Flare parts in A class.
  const filtered = useMemo(() => {
    if (!schedule?.due) return [];
    const tokens = (search || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return schedule.due.filter(d => {
      if (classFilter !== 'all' && d.abc_class !== classFilter) return false;
      if (!tokens.length) return true;
      const fields = [d.part_code, d.part_name, d.product, d.abc_class]
        .map((v) => (v || '').toLowerCase());
      for (const t of tokens) {
        if (!fields.some((f) => f.includes(t))) return false;
      }
      return true;
    });
  }, [schedule, search, classFilter]);

  function toggleRow(pc) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(pc)) next.delete(pc); else next.add(pc);
      return next;
    });
  }
  function selectAllFiltered() {
    setSelected(new Set(filtered.map(d => d.part_code)));
  }

  async function submit() {
    if (selected.size === 0) { toast('Select at least one part', 'err'); return; }
    setCreating(true);
    try {
      const r = await workerFetch('createCycleCount', {
        data: {
          part_codes: [...selected],
          count_type: 'scheduled',
          area:       area.trim() || null,
          notes:      counterName ? `Counter: ${counterName.trim()}${notes ? ' · ' + notes.trim() : ''}` : (notes.trim() || null),
        },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Create failed', 'err'); return; }
      toast(`Created ${r.data.count_no} · ${r.data.lines_created} lines`, 'ok');
      onCreated(r.data.count_no);
    } finally { setCreating(false); }
  }

  return (
    <Modal open onClose={onClose} size="lg" title="New cycle count"
           confirmLabel={creating ? 'CREATING…' : `CREATE COUNT · ${selected.size} part${selected.size === 1 ? '' : 's'}`}
           onConfirm={submit} loading={creating}>
      {loading ? <Spinner /> : !schedule ? <EmptyState message="No schedule available" /> : (
        <>
          <div style={{ marginBottom: 12, padding: '8px 10px', background: 'var(--surface2)', borderRadius: 3, fontSize: 11, color: 'var(--t2)' }}>
            <strong>{schedule.total}</strong> part{schedule.total === 1 ? '' : 's'} due ·
            <span style={{ color: '#ff7070', marginLeft: 6 }}>A: {schedule.by_class.A}</span> ·
            <span style={{ color: '#fbbf24', marginLeft: 6 }}>B: {schedule.by_class.B}</span> ·
            <span style={{ color: '#7b93ff', marginLeft: 6 }}>C: {schedule.by_class.C}</span>
            <span style={{ marginLeft: 10, color: 'var(--t3)' }}>(ABC by 90-day movement × unit_cost)</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div>
              <label style={lbl}>Area / Zone</label>
              <input value={area} onChange={e => setArea(e.target.value)} placeholder="e.g. Rack 3, Shelf B" style={{ ...input, width: '100%' }} />
            </div>
            <div>
              <label style={lbl}>Counter Name</label>
              <input value={counterName} onChange={e => setCounterName(e.target.value)} placeholder="written on count sheet" style={{ ...input, width: '100%' }} />
            </div>
            <div>
              <label style={lbl}>Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} style={{ ...input, width: '100%' }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input data-search-primary value={search} onChange={e => setSearch(e.target.value)} placeholder="Search — try “Flare A” or “Apex metal”  · /" style={{ ...input, flex: 1 }} />
            <select value={classFilter} onChange={e => setClassFilter(e.target.value)} style={{ ...input, minWidth: 100 }}>
              <option value="all">All classes</option>
              <option value="A">A (monthly)</option>
              <option value="B">B (quarterly)</option>
              <option value="C">C (annual)</option>
            </select>
            <button onClick={selectAllFiltered} style={btnS}>SELECT ALL ({filtered.length})</button>
            <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{selected.size} sel</span>
          </div>

          <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 30 }}><input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={(e) => e.target.checked ? selectAllFiltered() : setSelected(new Set())} /></th>
                  <th style={th}>Part</th>
                  <th style={{ ...th, textAlign: 'center', width: 36 }}>ABC</th>
                  <th style={{ ...th, textAlign: 'right' }}>Days Overdue</th>
                  <th style={{ ...th, textAlign: 'right' }}>Last Counted</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'var(--t3)' }}>No matches</td></tr>
                ) : filtered.map(d => (
                  <tr key={d.part_code} style={{ background: selected.has(d.part_code) ? 'rgba(33,60,226,.06)' : 'transparent', cursor: 'pointer' }} onClick={() => toggleRow(d.part_code)}>
                    <td style={td}><input type="checkbox" checked={selected.has(d.part_code)} onChange={() => toggleRow(d.part_code)} onClick={e => e.stopPropagation()} /></td>
                    <td style={td}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t1)' }}>{d.part_code}</div>
                      <div style={{ fontSize: 10, color: 'var(--t3)' }}>{d.part_name}{d.product ? ` · ${d.product}` : ''}</div>
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700, color: d.abc_class === 'A' ? '#ff7070' : d.abc_class === 'B' ? '#fbbf24' : '#7b93ff' }}>{d.abc_class}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: (d.days_overdue || 0) > 30 ? '#ff7070' : 'var(--t2)' }}>{d.days_overdue == null ? 'never' : d.days_overdue + 'd'}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{fmtDate(d.last_count_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Count detail view — blind entry UX
// ─────────────────────────────────────────────────────────────────────────────
function CountDetailView({ header, lines, session, toast, onBack, onReload, canRecord }) {
  const [entries, setEntries] = useState({}); // part_code → counted_qty draft
  const [savingPart, setSavingPart] = useState(null);
  const [recountSel, setRecountSel] = useState(new Set());
  const [recountReason, setRecountReason] = useState('');
  const [recountOpen, setRecountOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const isInProgress = header.status === 'in_progress';
  const isBlind      = isInProgress; // server already redacted

  async function saveLine(line) {
    const val = entries[line.part_code];
    if (val == null || val === '') { toast('Enter a count', 'err'); return; }
    const counted = Number(val);
    if (!isFinite(counted) || counted < 0) { toast('Invalid count', 'err'); return; }
    setSavingPart(line.part_code);
    try {
      const r = await workerFetch('enterCycleCountLine', {
        data: { count_no: header.count_no, part_code: line.part_code, counted_qty: counted },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Save failed', 'err'); return; }
      // Reload to fetch updated line with revealed variance
      onReload();
      // Keep entry value for visibility
    } finally { setSavingPart(null); }
  }

  async function flagRecount() {
    if (recountSel.size === 0) return;
    const reason = recountReason.trim();
    if (!reason) { toast('Reason required', 'err'); return; }
    const r = await workerFetch('requestRecount', {
      data: { line_ids: [...recountSel], reason },
    }, session);
    if (!r?.ok) { toast(r?.data?.error || 'Failed', 'err'); return; }
    toast(`${r.data.flagged} line(s) flagged for recount`, 'ok');
    setRecountSel(new Set());
    setRecountReason('');
    setRecountOpen(false);
    onReload();
  }

  async function complete() {
    if (!confirm(`Complete ${header.count_no}? This proposes adjustments for any variance.`)) return;
    setCompleting(true);
    try {
      const r = await workerFetch('completeCycleCount', { data: { count_no: header.count_no } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Complete failed', 'err'); return; }
      const d = r.data;
      toast(`Completed · ${d.lines_counted} counted · ${d.adjustments_created} adjustment(s) proposed${d.lines_recount_queued ? ` · ${d.lines_recount_queued} recount queued` : ''}`, 'ok');
      onReload();
    } finally { setCompleting(false); }
  }

  async function cancel() {
    const reason = prompt(`Cancel ${header.count_no}? Reason:`);
    if (!reason || !reason.trim()) return;
    setCancelling(true);
    try {
      const r = await workerFetch('cancelCycleCount', { data: { count_no: header.count_no, reason: reason.trim() } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Cancel failed', 'err'); return; }
      toast(`${header.count_no} cancelled`, 'ok');
      onBack();
    } finally { setCancelling(false); }
  }

  function printSheet() {
    printWindow(buildCycleCountSheetHtml(header, lines));
  }

  const stats = useMemo(() => ({
    total:     lines.length,
    pending:   lines.filter(l => l.status === 'pending_count').length,
    counted:   lines.filter(l => l.status === 'counted').length,
    recount:   lines.filter(l => l.status === 'recount_required').length,
    reconciled: lines.filter(l => l.status === 'reconciled').length,
    variance_lines: lines.filter(l => l.variance != null && Math.abs(parseFloat(l.variance)) > 0.001).length,
    total_variance_value: lines.reduce((s, l) => s + Math.abs(parseFloat(l.variance_value) || 0), 0),
  }), [lines]);

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={onBack} style={btnS}>← BACK</button>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--yellow)' }}>{header.count_no}</span>
            <StatusBadge status={header.status} />
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>{fmtDate(header.count_date)} · {header.area || '—'} · {header.count_type}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={printSheet} style={btnS}>🖨 PRINT SHEET</button>
            {canRecord && isInProgress && stats.counted > 0 && recountSel.size > 0 && (
              <button onClick={() => setRecountOpen(true)} style={btnS}>⤿ FLAG {recountSel.size} FOR RECOUNT</button>
            )}
            {canRecord && isInProgress && stats.pending === 0 && (
              <button onClick={complete} disabled={completing} style={{ ...btnP, opacity: completing ? 0.6 : 1 }}>{completing ? 'COMPLETING…' : '✓ COMPLETE COUNT'}</button>
            )}
            {canRecord && header.status !== 'reconciled' && header.status !== 'cancelled' && (
              <button onClick={cancel} disabled={cancelling} style={{ ...btnS, color: '#ff7070', borderColor: 'rgba(222,42,42,.3)' }}>CANCEL</button>
            )}
          </div>
        </div>
        <div style={pbody}>
          {/* KPI strip */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <KpiTile label="Total" value={stats.total} />
            <KpiTile label="Pending" value={stats.pending} tone="yellow" />
            <KpiTile label="Counted" value={stats.counted} tone="blue" />
            <KpiTile label="Recount" value={stats.recount} tone="orange" />
            <KpiTile label="Reconciled" value={stats.reconciled} tone="green" />
            {!isBlind && stats.variance_lines > 0 && <KpiTile label="With Variance" value={stats.variance_lines} tone="red" />}
          </div>

          {isBlind && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(33,60,226,.08)', border: '1px solid rgba(33,60,226,.2)', borderRadius: 3, fontSize: 11, color: 'var(--t2)' }}>
              <strong>Blind count mode.</strong> ERP qty hidden until you enter a counted qty. Variance reveals after entry on that line only.
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {isInProgress && <th style={{ ...th, width: 30 }}></th>}
                  <th style={th}>Part</th>
                  <th style={{ ...th, textAlign: 'center', width: 36 }}>ABC</th>
                  <th style={{ ...th, textAlign: 'right' }}>ERP Qty</th>
                  <th style={{ ...th, textAlign: 'right' }}>Counted</th>
                  <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                  <th style={{ ...th, textAlign: 'right' }}>Value (₹)</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => {
                  const isPending = l.status === 'pending_count';
                  const isCounted = l.status === 'counted' || l.status === 'reconciled';
                  const erpVisible = !isPending || l.erp_qty_at_print != null;
                  return (
                    <tr key={l.id} style={{ background: recountSel.has(l.id) ? 'rgba(245,158,11,.08)' : 'transparent' }}>
                      {isInProgress && (
                        <td style={td}>
                          {l.status === 'counted' && (
                            <input type="checkbox" checked={recountSel.has(l.id)} onChange={() => {
                              setRecountSel(prev => {
                                const next = new Set(prev);
                                if (next.has(l.id)) next.delete(l.id); else next.add(l.id);
                                return next;
                              });
                            }} />
                          )}
                        </td>
                      )}
                      <td style={td}>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t1)' }}>{l.part_code}</div>
                        <div style={{ fontSize: 10, color: 'var(--t3)' }}>{l.part_name}{l.product ? ` · ${l.product}` : ''}</div>
                      </td>
                      <td style={{ ...td, textAlign: 'center', fontWeight: 700, fontSize: 10, color: l.abc_class === 'A' ? '#ff7070' : l.abc_class === 'B' ? '#fbbf24' : l.abc_class === 'C' ? '#7b93ff' : 'var(--t3)' }}>{l.abc_class || '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: erpVisible ? 'var(--t2)' : 'var(--t3)' }}>
                        {erpVisible ? fmtNum(l.erp_qty_at_print) : <span style={{ filter: 'blur(4px)', userSelect: 'none' }}>—</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)' }}>
                        {isPending && canRecord ? (
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                            <input
                              type="number" min={0} step="any"
                              value={entries[l.part_code] ?? ''}
                              onChange={e => setEntries({ ...entries, [l.part_code]: e.target.value })}
                              onKeyDown={e => { if (e.key === 'Enter') saveLine(l); }}
                              style={{ ...input, width: 80, textAlign: 'right' }}
                              disabled={savingPart === l.part_code}
                            />
                            <button onClick={() => saveLine(l)} disabled={savingPart === l.part_code} style={{ ...btnS, padding: '4px 8px', fontSize: 10 }}>{savingPart === l.part_code ? '…' : '↵'}</button>
                          </div>
                        ) : (
                          <span style={{ fontWeight: 700, color: 'var(--t1)' }}>{fmtNum(l.counted_qty)}</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700, color: l.variance == null ? 'var(--t3)' : Math.abs(parseFloat(l.variance)) < 0.001 ? '#4ade80' : parseFloat(l.variance) > 0 ? '#ff7070' : '#fbbf24' }}>
                        {l.variance == null ? '—' : (parseFloat(l.variance) > 0 ? '+' : '') + fmtNum(l.variance)}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: l.variance_value == null ? 'var(--t3)' : Math.abs(parseFloat(l.variance_value)) < 0.001 ? 'var(--t3)' : '#ff7070' }}>
                        {l.variance_value == null ? '—' : fmtNum(l.variance_value)}
                      </td>
                      <td style={td}><StatusBadge status={l.status === 'pending_count' ? 'in_progress' : l.status === 'counted' ? 'counted' : l.status === 'recount_required' ? 'in_progress' : l.status === 'reconciled' ? 'reconciled' : 'cancelled'} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {recountOpen && (
        <Modal open onClose={() => setRecountOpen(false)} size="md" title={`Flag ${recountSel.size} line(s) for recount`}
               confirmLabel="FLAG FOR RECOUNT" onConfirm={flagRecount}>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--t2)' }}>
            Flagged lines stay on this count but get marked as <code>recount_required</code>. Create a fresh count
            with <code>count_type='recount'</code> assigning a <strong>different counter</strong> to satisfy
            segregation of duties.
          </p>
          <div>
            <label style={lbl}>Reason</label>
            <input value={recountReason} onChange={e => setRecountReason(e.target.value)} placeholder="e.g. variance too large, suspicious miscount" style={{ ...input, width: '100%' }} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function KpiTile({ label, value, tone = 'gray' }) {
  const s = TONE[tone];
  return (
    <div style={{ background: 'var(--surface2)', border: `1px solid ${s.border}`, borderRadius: 4, padding: '8px 12px', minWidth: 100 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', marginBottom: 2 }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 16, fontFamily: 'var(--mono)', fontWeight: 700, color: s.fg }}>{fmtNum(value)}</div>
    </div>
  );
}
