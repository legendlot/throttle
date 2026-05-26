'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState, buildUnitCountSheetHtml, printWindow } from '@throttle/ui';

const STATUS_TABS = [
  { id: 'in_progress', label: 'In Progress', tone: 'yellow' },
  { id: 'counted',     label: 'Counted',     tone: 'blue'   },
  { id: 'reconciled',  label: 'Reconciled',  tone: 'green'  },
  { id: 'cancelled',   label: 'Cancelled',   tone: 'gray'   },
  { id: 'all',         label: 'All',         tone: 'gray'   },
];
const SCOPE_OPTIONS = ['handed_over','allocated','packed','rtd','pending_rtd'];
const TONE = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.25)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)'    },
};
const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody = { padding: '12px 14px' };
const th    = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP  = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function StatusBadge({ status }) {
  const tab = STATUS_TABS.find(t => t.id === status) || { label: status, tone: 'gray' };
  const s = TONE[tab.tone];
  return <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', background: s.bg, color: s.fg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>{tab.label}</span>;
}
function fmtTs(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }); } catch { return d; } }

export default function UnitCountsPage() {
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const canRecord = hasPermission(perms, 'cycle_count_record');

  const [tab,     setTab]     = useState('in_progress');
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [activeCount, setActiveCount] = useState(null);
  const [detail,      setDetail]      = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function loadList() {
    if (!session) return;
    setLoading(true);
    try {
      // No filter endpoint built for unit_counts list, use stock_adjustments source-filter as a proxy isn't right;
      // instead inline: query the unit_counts table via supabase indirectly is not available — fall back to
      // creating + storing locally for now. Worker doesn't have a getUnitCounts list yet; using getUnitCount one at a time.
      // For v1 we surface counts via the per-row openDetail. Listing endpoint can be added later.
      // ---
      // Workaround: pull recent unit counts via a special action would be ideal. For now show a simple "search by count_no" placeholder.
      setRows([]); // intentionally empty — see note above
    } finally { setLoading(false); }
  }
  useEffect(() => { loadList(); }, [tab, session]);

  async function openDetail(count_no) {
    setActiveCount(count_no);
    setDetail(null);
    setDetailLoading(true);
    try {
      const r = await workerFetch('getUnitCount', { data: { count_no } }, session);
      setDetail(r?.ok ? r.data : null);
    } finally { setDetailLoading(false); }
  }

  if (activeCount && detail) {
    return <UnitCountDetail
      header={detail.header}
      lines={detail.lines}
      session={session}
      toast={toast}
      canRecord={canRecord}
      onBack={() => { setActiveCount(null); setDetail(null); }}
      onReload={() => openDetail(activeCount)}
    />;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <span>Dispatch Unit Counts</span>
          {canRecord && <button onClick={() => setNewOpen(true)} style={btnP}>+ NEW UNIT COUNT</button>}
        </div>
        <div style={pbody}>
          <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 3, fontSize: 11, color: 'var(--t2)' }}>
            <strong>Workflow:</strong> Create a count snapshotting all UPCs in a chosen status (e.g. <code>handed_over</code>).
            Print the UPC checklist sheet. Counter walks staging, marks Present/Missing/Extra. Enter results into the system.
            Complete the count to auto-create stock adjustments for missing/extra units (queued for L1 approval).
          </div>
          <div style={{ marginBottom: 10 }}>
            <input
              type="text"
              placeholder="Open by count_no (UCN-NNN)…"
              style={{ ...input, width: 280, fontFamily: 'var(--mono)' }}
              onKeyDown={e => { if (e.key === 'Enter' && e.target.value.trim()) openDetail(e.target.value.trim()); }}
            />
          </div>
          <EmptyState title="Open a count to view" message="Use the search above to jump to a UCN-NNN, or create a new count." />
        </div>
      </div>

      {newOpen && (
        <NewUnitCountModal
          session={session}
          toast={toast}
          onClose={() => setNewOpen(false)}
          onCreated={(count_no) => { setNewOpen(false); openDetail(count_no); }}
        />
      )}
    </div>
  );
}

function NewUnitCountModal({ session, toast, onClose, onCreated }) {
  const [form, setForm] = useState({ scope_status: 'handed_over', area: '', counter: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    setSubmitting(true);
    try {
      const r = await workerFetch('createUnitCount', {
        data: {
          scope_status: form.scope_status,
          area:         form.area.trim() || null,
          notes:        form.counter ? `Counter: ${form.counter.trim()}${form.notes ? ' · ' + form.notes.trim() : ''}` : (form.notes.trim() || null),
        },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'err'); return; }
      toast(`Created ${r.data.count_no} · ${r.data.expected_count} units`, 'ok');
      onCreated(r.data.count_no);
    } finally { setSubmitting(false); }
  }
  return (
    <Modal open onClose={onClose} size="md" title="New dispatch unit count"
           confirmLabel={submitting ? 'CREATING…' : 'CREATE'} onConfirm={submit} loading={submitting}>
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Scope Status (which units to verify)</label>
        <select value={form.scope_status} onChange={e => setForm({ ...form, scope_status: e.target.value })} style={{ ...input, width: '100%' }}>
          {SCOPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Area / Zone</label>
        <input value={form.area} onChange={e => setForm({ ...form, area: e.target.value })} placeholder="e.g. Dispatch Staging A" style={{ ...input, width: '100%' }} />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Counter</label>
        <input value={form.counter} onChange={e => setForm({ ...form, counter: e.target.value })} placeholder="written on sheet" style={{ ...input, width: '100%' }} />
      </div>
      <div>
        <label style={lbl}>Notes</label>
        <textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
      </div>
    </Modal>
  );
}

function UnitCountDetail({ header, lines, session, toast, onBack, onReload, canRecord }) {
  const [pending,    setPending]    = useState({}); // unit_upc → 'present' | 'missing' | 'extra'
  const [extraInput, setExtraInput] = useState('');
  const [saving,     setSaving]     = useState(false);
  const [completing, setCompleting] = useState(false);

  const isInProgress = header.status === 'in_progress';

  async function applyMarks(extraExtras = []) {
    const results = [
      ...Object.entries(pending).map(([unit_upc, result]) => ({ unit_upc, result })),
      ...extraExtras.map(upc => ({ unit_upc: upc, result: 'extra' })),
    ];
    if (!results.length) { toast('Nothing to apply', 'err'); return; }
    setSaving(true);
    try {
      const r = await workerFetch('enterUnitCountResults', {
        data: { count_no: header.count_no, results },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Save failed', 'err'); return; }
      toast(`Applied ${r.data.applied}`, 'ok');
      setPending({});
      setExtraInput('');
      onReload();
    } finally { setSaving(false); }
  }

  async function addExtra() {
    const upcs = extraInput.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (!upcs.length) return;
    await applyMarks(upcs);
  }

  async function complete() {
    if (!confirm(`Complete ${header.count_no}? Auto-creates stock adjustments for missing + extra units.`)) return;
    setCompleting(true);
    try {
      const r = await workerFetch('completeUnitCount', { data: { count_no: header.count_no } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'err'); return; }
      const d = r.data;
      toast(`Completed · present ${d.present_count} / missing ${d.missing_count} / extra ${d.extra_count} · ${d.adjustments_created} adjustment(s) created`, 'ok');
      onReload();
    } finally { setCompleting(false); }
  }

  function printSheet() { printWindow(buildUnitCountSheetHtml(header, lines)); }

  const stats = useMemo(() => ({
    total:   lines.length,
    present: lines.filter(l => l.result === 'present' || l.result === 'reconciled').length,
    missing: lines.filter(l => l.result === 'missing').length,
    extra:   lines.filter(l => l.result === 'extra').length,
    pending: lines.filter(l => !l.result).length,
  }), [lines]);

  function mark(upc, result) {
    setPending(prev => ({ ...prev, [upc]: result }));
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={onBack} style={btnS}>← BACK</button>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--yellow)' }}>{header.count_no}</span>
            <StatusBadge status={header.status} />
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>{fmtDate(header.count_date)} · {header.scope_status} · {header.area || '—'}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={printSheet} style={btnS}>🖨 PRINT SHEET</button>
            {canRecord && isInProgress && Object.keys(pending).length > 0 && (
              <button onClick={() => applyMarks()} disabled={saving} style={btnP}>{saving ? 'SAVING…' : `APPLY ${Object.keys(pending).length} MARKS`}</button>
            )}
            {canRecord && isInProgress && stats.pending === 0 && (
              <button onClick={complete} disabled={completing} style={{ ...btnP, opacity: completing ? 0.6 : 1 }}>{completing ? 'COMPLETING…' : '✓ COMPLETE'}</button>
            )}
          </div>
        </div>
        <div style={pbody}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <KpiTile label="Expected" value={stats.total} />
            <KpiTile label="Present" value={stats.present} tone="green" />
            <KpiTile label="Missing" value={stats.missing} tone="red" />
            <KpiTile label="Extra" value={stats.extra} tone="orange" />
            <KpiTile label="Pending" value={stats.pending} tone="yellow" />
          </div>

          {isInProgress && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(33,60,226,.08)', border: '1px solid rgba(33,60,226,.2)', borderRadius: 3, fontSize: 11, color: 'var(--t2)' }}>
              Mark each row Present / Missing / Extra below. Found a UPC not on the sheet? Paste it in the &quot;Extra&quot; box at the bottom and click Add.
            </div>
          )}

          <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
                <tr>
                  <th style={th}>UPC</th>
                  <th style={th}>Product</th>
                  {isInProgress && <th style={{ ...th, textAlign: 'center' }}>Mark</th>}
                  <th style={th}>Result</th>
                  <th style={th}>By / When</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => {
                  const draft = pending[l.unit_upc];
                  return (
                    <tr key={l.id}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t1)' }}>{l.unit_upc}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t2)' }}>{[l.product, l.model, l.color].filter(Boolean).join(' · ') || '—'}</td>
                      {isInProgress && (
                        <td style={{ ...td, textAlign: 'center' }}>
                          <div style={{ display: 'inline-flex', gap: 4 }}>
                            <button onClick={() => mark(l.unit_upc, 'present')} style={{ ...btnS, padding: '4px 8px', fontSize: 11, background: draft === 'present' ? 'rgba(34,197,94,.15)' : 'transparent', color: draft === 'present' ? '#4ade80' : 'var(--t2)' }}>✓</button>
                            <button onClick={() => mark(l.unit_upc, 'missing')} style={{ ...btnS, padding: '4px 8px', fontSize: 11, background: draft === 'missing' ? 'rgba(222,42,42,.15)' : 'transparent', color: draft === 'missing' ? '#ff7070' : 'var(--t2)' }}>✗</button>
                          </div>
                        </td>
                      )}
                      <td style={td}>
                        {draft ? <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: '#fbbf24', fontStyle: 'italic' }}>DRAFT: {draft}</span> :
                          l.result ? <StatusBadge status={l.result === 'reconciled' ? 'reconciled' : l.result === 'present' ? 'reconciled' : l.result === 'missing' ? 'cancelled' : 'in_progress'} /> : '—'}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{l.result_at ? fmtTs(l.result_at) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {isInProgress && (
            <div style={{ marginTop: 14, padding: 10, background: 'var(--surface2)', borderRadius: 3 }}>
              <label style={lbl}>Add EXTRA UPCs found not on the sheet</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={extraInput} onChange={e => setExtraInput(e.target.value)} placeholder="LOT-00012345 LOT-00012346 (space or comma separated)" style={{ ...input, flex: 1, fontFamily: 'var(--mono)' }} />
                <button onClick={addExtra} disabled={saving || !extraInput.trim()} style={btnS}>+ ADD EXTRAS</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value, tone = 'gray' }) {
  const s = TONE[tone];
  return (
    <div style={{ background: 'var(--surface2)', border: `1px solid ${s.border}`, borderRadius: 4, padding: '8px 12px', minWidth: 100 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', marginBottom: 2 }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 16, fontFamily: 'var(--mono)', fontWeight: 700, color: s.fg }}>{value}</div>
    </div>
  );
}
