'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch, garageFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState } from '@throttle/ui';

/* ────────────────────────────────────────────────────────────────
   Depot — Dispatch Stock Audit (RULE-AUDIT-001).
   Governed full-scan count: floor scans held cars (scanner Stock Audit
   station, dedup) → open variance per product + missing batch labels →
   submit → a DIFFERENT supervisor reviews + approves → corrections post
   (missing→lost, extra→handed_over). This page is the register + the
   review surface. Scanning happens on the floor scanner; a desk paste
   fallback is offered while open.
   ──────────────────────────────────────────────────────────────── */

const STATUS_TABS = [
  { id: 'open',       label: 'Open',       tone: 'yellow' },
  { id: 'in_review',  label: 'In Review',  tone: 'blue'   },
  { id: 'completed',  label: 'Completed',  tone: 'green'  },
  { id: 'cancelled',  label: 'Cancelled',  tone: 'gray'   },
  { id: 'all',        label: 'All',        tone: 'gray'   },
];
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
const variantName = (r) => [r.product, r.model, r.color].filter(Boolean).join(' · ') || '—';

// Assignee list = holders of cycle_count_record, i.e. people who could actually run the
// count. Loaded once per mount and shared by the create modal + the detail reassign
// control. A failure leaves the list empty, which degrades to "Unassigned" rather than
// blocking the audit — assignment is accountability, never a precondition for counting.
function useAssignees(session) {
  const [assignees, setAssignees] = useState([]);
  useEffect(() => {
    if (!session) return;
    let alive = true;
    (async () => {
      try {
        const d = await garageFetch('getAuditAssignees', {}, session);
        if (alive) setAssignees(d?.assignees || []);
      } catch { if (alive) setAssignees([]); }
    })();
    return () => { alive = false; };
  }, [session]);
  return assignees;
}

// An assignee whose profile no longer resolves comes back with a null name (the worker
// deliberately does not echo the raw uuid). Show that as a flag, not as unassigned —
// silently reading "—" would hide that a real audit has an owner who no longer exists.
function AssigneeCell({ audit }) {
  if (!audit?.assigned_to) return <span style={{ color: 'var(--t3)' }}>Unassigned</span>;
  if (!audit.assigned_to_name) return <span style={{ color: '#fbbf24' }} title="Assigned to a user profile that no longer resolves">unknown user</span>;
  return <span>{audit.assigned_to_name}</span>;
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

export default function StockAuditPage() {
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const canRecord  = hasPermission(perms, 'cycle_count_record');
  const canApprove = hasPermission(perms, 'cycle_count_approve_l1');

  const [tab, setTab]         = useState('open');
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [active, setActive]   = useState(null); // audit_no
  const assignees = useAssignees(session);

  async function loadList() {
    if (!session) return;
    setLoading(true);
    try {
      const params = tab === 'all' ? {} : { status: tab };
      const d = await garageFetch('getDispatchAudits', params, session);
      setRows(d?.audits || []);
    } catch (e) { toast(e.message || 'Load failed', 'error'); setRows([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [tab, session]);

  if (active) {
    return <AuditDetail
      auditNo={active} session={session} toast={toast}
      canRecord={canRecord} canApprove={canApprove}
      meId={session?.user?.id}
      onBack={() => { setActive(null); loadList(); }}
    />;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <span>Dispatch Stock Audit</span>
          {canRecord && <button onClick={() => setNewOpen(true)} style={btnP}>+ OPEN NEW AUDIT</button>}
        </div>
        <div style={pbody}>
          <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 3, fontSize: 11, color: 'var(--t2)', lineHeight: 1.5 }}>
            <strong>How it works:</strong> Open an audit, then on the floor scanner (<code>Dispatch → Stock Audit</code>) scan
            every car box label you physically hold — re-scans merge automatically. Watch the variance below (system-held vs
            scanned, per product) and the exact <em>missing batch labels</em> to go find. When settled, <strong>Submit for review</strong>;
            a different supervisor approves and the system self-corrects (missing → lost, extra → back into holding).
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {STATUS_TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ ...btnS, ...(tab === t.id ? { background: TONE[t.tone].bg, color: TONE[t.tone].fg, borderColor: TONE[t.tone].border } : {}) }}>
                {t.label}
              </button>
            ))}
          </div>
          {loading ? <Spinner /> : rows.length === 0 ? (
            <EmptyState title="No audits" message="Open a new audit to start a floor count." />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>Audit</th><th style={th}>Status</th><th style={th}>Assigned to</th><th style={th}>Opened</th>
                  <th style={{ ...th, textAlign: 'right' }}>Present</th>
                  <th style={{ ...th, textAlign: 'right' }}>Missing</th>
                  <th style={{ ...th, textAlign: 'right' }}>Extra</th>
                  <th style={{ ...th, textAlign: 'right' }}>Corrected</th>
                </tr></thead>
                <tbody>
                  {rows.map(a => (
                    <tr key={a.id} onClick={() => setActive(a.audit_no)} style={{ cursor: 'pointer' }}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow, #f2cd1a)' }}>{a.audit_no}{a.area ? <span style={{ color: 'var(--t3)', fontSize: 10 }}> · {a.area}</span> : null}</td>
                      <td style={td}><StatusBadge status={a.status} /></td>
                      <td style={{ ...td, fontSize: 11 }}><AssigneeCell audit={a} /></td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>{fmtTs(a.opened_at)}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)' }}>{a.present_count ?? '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: a.missing_count ? '#ff7070' : 'var(--t2)' }}>{a.missing_count ?? '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: a.extra_count ? '#fbbf24' : 'var(--t2)' }}>{a.extra_count ?? '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)' }}>{a.corrected_count ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {newOpen && (
        <NewAuditModal session={session} toast={toast} assignees={assignees}
          onClose={() => setNewOpen(false)}
          onCreated={(no) => { setNewOpen(false); setActive(no); }} />
      )}
    </div>
  );
}

function NewAuditModal({ session, toast, assignees, onClose, onCreated }) {
  const [form, setForm] = useState({ area: '', notes: '', assigned_to: '' });
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    setSubmitting(true);
    try {
      const r = await workerFetch('createDispatchAudit', { data: {
        area: form.area.trim() || null,
        notes: form.notes.trim() || null,
        assigned_to: form.assigned_to || null,
      } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed — is another audit already open?', 'error'); return; }
      toast(`Opened ${r.data.audit.audit_no}`, 'success');
      onCreated(r.data.audit.audit_no);
    } finally { setSubmitting(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title="Open a stock audit"
           confirmLabel={submitting ? 'OPENING…' : 'OPEN AUDIT'} onConfirm={submit} loading={submitting}>
      <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--t2)' }}>Only one audit can be open at a time. Submit or cancel any open audit first.</div>
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Assign to (optional)</label>
        <select value={form.assigned_to} onChange={e => setForm({ ...form, assigned_to: e.target.value })} style={{ ...input, width: '100%' }}>
          <option value="">Unassigned</option>
          {assignees.map(u => <option key={u.id} value={u.id}>{u.full_name || u.id}</option>)}
        </select>
        <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, lineHeight: 1.45 }}>
          Who is expected to walk the count. Advisory only — it does not restrict who may scan,
          submit or approve, and can be changed while the audit is live.
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Area / note (optional)</label>
        <input value={form.area} onChange={e => setForm({ ...form, area: e.target.value })} placeholder="e.g. D1 racks" style={{ ...input, width: '100%' }} />
      </div>
      <div>
        <label style={lbl}>Notes (optional)</label>
        <textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...input, width: '100%', resize: 'vertical' }} />
      </div>
    </Modal>
  );
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Discrepancy lines → CSV (matches the on-screen table + car_upc split out for analysis).
// "Last Stage" = where the unit was last seen (missing → expected_status, extra → found_status);
// "Correction" = what it's moving to now.
function downloadAuditCsv(audit, lines) {
  const header = ['Result', 'Product', 'Model', 'Color', 'Car UPC', 'Batch Label', 'Last Stage', 'Correction'];
  const rows = lines.map(l => {
    const lastStage = l.result === 'channel_mismatch' ? `${l.expected_status || ''} -> ${l.found_status || ''}`
      : l.result === 'missing' ? (l.expected_status || '') : (l.found_status || '');
    const correction = l.reviewed
      ? (l.corrected_to_status ? `-> ${l.corrected_to_status}` : (l.correction === 'skip' ? 'skipped' : 'no change'))
      : (l.result === 'channel_mismatch' ? `-> relabel ${l.found_status || ''}`.trim()
         : l.correction === 'write_off' ? '-> lost' : '-> handed_over');
    return [l.result, l.product, l.model, l.color, l.car_upc, l.batch_label, lastStage, correction];
  });
  const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${audit.audit_no}-discrepancies.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function AuditDetail({ auditNo, session, toast, canRecord, canApprove, meId, onBack }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [paste, setPaste]     = useState('');
  const [busy, setBusy]       = useState(false);
  const [skip, setSkip]       = useState(() => new Set());
  const assignees = useAssignees(session);

  async function load() {
    setLoading(true);
    try { setData(await garageFetch('getDispatchAudit', { audit_no: auditNo }, session)); }
    catch (e) { toast(e.message || 'Load failed', 'error'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [auditNo]);

  if (loading || !data) return <div style={{ padding: 16 }}><Spinner /></div>;
  const audit = data.audit;
  const isOpen     = audit.status === 'open';
  const isReview   = audit.status === 'in_review';
  const v = data.variance || {};
  const lines = data.lines || [];
  const isCounter = meId && (meId === audit.opened_by || meId === audit.submitted_by);

  async function addPaste() {
    const codes = paste.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (!codes.length) return;
    setBusy(true);
    try {
      const r = await workerFetch('addAuditScansBulk', { data: { audit_no: auditNo, codes } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'error'); return; }
      toast(`Added ${r.data.added} · ${r.data.total_scanned} scanned`, 'success');
      setPaste(''); load();
    } finally { setBusy(false); }
  }
  async function reassign(userId) {
    setBusy(true);
    try {
      const r = await workerFetch('assignDispatchAudit', { data: { audit_no: auditNo, assigned_to: userId || null } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Assign failed', 'error'); return; }
      const name = r.data?.audit?.assigned_to_name;
      toast(userId ? `Assigned to ${name || 'that person'}` : 'Assignment cleared', 'success');
      load();
    } finally { setBusy(false); }
  }
  async function submit() {
    if (!confirm('Submit this audit for review? Scanning stops and the variance is frozen.')) return;
    setBusy(true);
    try {
      const r = await workerFetch('submitDispatchAudit', { data: { audit_no: auditNo } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'error'); return; }
      toast(`Submitted · ${r.data.missing} missing / ${r.data.extra} extra`, 'success'); load();
    } finally { setBusy(false); }
  }
  async function approve() {
    if (!confirm('Approve and apply corrections? Missing units → lost, extras → back into holding, channel mismatches relabelled to the scanned channel.')) return;
    setBusy(true);
    try {
      const r = await workerFetch('reviewDispatchAudit', { data: { audit_no: auditNo, skip_line_ids: [...skip] } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'error'); return; }
      toast(`Completed · corrected ${r.data.corrected} (wrote off ${r.data.wrote_off}, restored ${r.data.restored}, relabelled ${r.data.relabeled ?? 0})`, 'success'); load();
    } finally { setBusy(false); }
  }
  async function cancel() {
    if (!confirm('Cancel this audit? No corrections are applied.')) return;
    setBusy(true);
    try {
      const r = await workerFetch('cancelDispatchAudit', { data: { audit_no: auditNo } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'error'); return; }
      toast('Cancelled', 'success'); load();
    } finally { setBusy(false); }
  }
  function toggleSkip(id) { setSkip(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  const counts = isOpen ? (v.counts || { present: 0, missing: 0, extra: 0 })
    : { present: audit.present_count || 0, missing: audit.missing_count || 0, extra: audit.extra_count || 0 };
  const chmm = audit.channel_mismatch_count || 0;

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={onBack} style={btnS}>← BACK</button>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--yellow, #f2cd1a)' }}>{audit.audit_no}</span>
            <StatusBadge status={audit.status} />
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>
              opened {fmtTs(audit.opened_at)}{audit.submitted_at ? ` · submitted ${fmtTs(audit.submitted_at)}` : ''}{audit.reviewed_at ? ` · reviewed ${fmtTs(audit.reviewed_at)}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {isOpen && canRecord && <button onClick={submit} disabled={busy} style={btnP}>SUBMIT FOR REVIEW</button>}
            {(isOpen || isReview) && canRecord && <button onClick={cancel} disabled={busy} style={btnS}>CANCEL</button>}
            {isReview && canApprove && !isCounter && <button onClick={approve} disabled={busy} style={{ ...btnP, background: '#16a34a' }}>APPROVE &amp; CORRECT</button>}
          </div>
        </div>
        <div style={pbody}>
          {/* Assignment is editable only while the audit is live — a completed or cancelled
              audit is a historical record of who was accountable, and the worker rejects it
              with a 409 too, so this is not the only guard. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap', fontSize: 11 }}>
            <span style={{ ...lbl, marginBottom: 0 }}>Assigned to</span>
            {(isOpen || isReview) && canRecord ? (
              <>
                <select value={audit.assigned_to || ''} disabled={busy}
                  onChange={e => reassign(e.target.value)}
                  style={{ ...input, minWidth: 190 }}>
                  <option value="">Unassigned</option>
                  {assignees.map(u => <option key={u.id} value={u.id}>{u.full_name || u.id}</option>)}
                  {/* Keep an unresolvable current assignee selectable so switching away from
                      it does not silently look like it was never set. */}
                  {audit.assigned_to && !assignees.some(u => u.id === audit.assigned_to) && (
                    <option value={audit.assigned_to}>{audit.assigned_to_name || 'unknown user'}</option>
                  )}
                </select>
                {audit.assigned_at && <span style={{ color: 'var(--t3)' }}>since {fmtTs(audit.assigned_at)}</span>}
              </>
            ) : (
              <><AssigneeCell audit={audit} />{audit.assigned_at && <span style={{ color: 'var(--t3)' }}>since {fmtTs(audit.assigned_at)}</span>}</>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <KpiTile label="Scanned" value={data.scans_count ?? 0} tone="blue" />
            <KpiTile label="Present" value={counts.present} tone="green" />
            <KpiTile label="Missing" value={counts.missing} tone="red" />
            <KpiTile label="Extra" value={counts.extra} tone="orange" />
            {chmm > 0 && <KpiTile label="Channel" value={chmm} tone="yellow" />}
            {audit.status === 'completed' && <KpiTile label="Corrected" value={audit.corrected_count ?? 0} />}
          </div>

          {isReview && !canApprove && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: TONE.blue.bg, border: `1px solid ${TONE.blue.border}`, borderRadius: 3, fontSize: 11, color: 'var(--t2)' }}>
              Awaiting a supervisor with approval rights to review.
            </div>
          )}
          {isReview && isCounter && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: TONE.orange.bg, border: `1px solid ${TONE.orange.border}`, borderRadius: 3, fontSize: 11, color: 'var(--t2)' }}>
              You opened or submitted this audit, so you can&apos;t approve it — a different supervisor must review (check-and-balance).
            </div>
          )}

          {/* OPEN — live variance + missing labels + desk paste */}
          {isOpen && (
            <>
              <SectionTitle>Variance by product (only products scanned)</SectionTitle>
              {(v.byProduct || []).length === 0 ? <Muted>No scans yet. Scan on the floor or paste below.</Muted> : (
                <ProductTable rows={v.byProduct} />
              )}

              <SectionTitle>Missing — batch labels to look for ({(v.missingLines || []).length})</SectionTitle>
              <LabelList rows={v.missingLines || []} tone="red" />

              {(v.extraLines || []).length > 0 && <>
                <SectionTitle>Extra — scanned but not currently held ({v.extraLines.length})</SectionTitle>
                <LabelList rows={v.extraLines} tone="orange" showFound />
              </>}

              {canRecord && (
                <div style={{ marginTop: 14, padding: 10, background: 'var(--surface2)', borderRadius: 3 }}>
                  <label style={lbl}>Desk fallback — paste UPCs / box labels (dedups with floor scans)</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={paste} onChange={e => setPaste(e.target.value)} placeholder="LOT-00012345-E LOT-00012346 …" style={{ ...input, flex: 1, fontFamily: 'var(--mono)' }} />
                    <button onClick={addPaste} disabled={busy || !paste.trim()} style={btnS}>+ ADD SCANS</button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* IN REVIEW / COMPLETED / CANCELLED — frozen lines */}
          {!isOpen && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <SectionTitle>Discrepancies ({lines.length})</SectionTitle>
                {lines.length > 0 && (
                  <button onClick={() => downloadAuditCsv(audit, lines)} style={btnS}>⬇ CSV</button>
                )}
              </div>
              {lines.length === 0 ? <Muted>No discrepancies — scanned stock matched the system exactly.</Muted> : (
                <div style={{ overflowX: 'auto', maxHeight: 540, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}><tr>
                      <th style={th}>Result</th><th style={th}>Product</th><th style={th}>Batch Label</th>
                      <th style={th}>Status</th><th style={th}>Correction</th>
                      {isReview && canApprove && !isCounter && <th style={{ ...th, textAlign: 'center' }}>Skip</th>}
                    </tr></thead>
                    <tbody>
                      {lines.map(l => (
                        <tr key={l.id}>
                          <td style={td}>
                            {l.result === 'channel_mismatch'
                              ? <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', background: TONE.yellow.bg, color: TONE.yellow.fg, border: `1px solid ${TONE.yellow.border}`, whiteSpace: 'nowrap' }}>Channel</span>
                              : <StatusBadge status={l.result === 'missing' ? 'cancelled' : 'in_review'} />}
                          </td>
                          <td style={{ ...td, fontSize: 11 }}>{variantName(l)}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{l.batch_label || l.car_upc}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                            {l.result === 'channel_mismatch'
                              ? `${l.expected_status || '—'} → ${l.found_status || '—'}`
                              : (l.result === 'missing' ? (l.expected_status || '—') : (l.found_status || '—'))}
                          </td>
                          <td style={{ ...td, fontSize: 11, color: l.corrected_to_status ? '#4ade80' : 'var(--t2)' }}>
                            {l.reviewed
                              ? (l.corrected_to_status ? `→ ${l.corrected_to_status}` : (l.correction === 'skip' ? 'skipped' : 'no change'))
                              : (skip.has(l.id) ? 'will skip'
                                 : l.result === 'channel_mismatch' ? `→ relabel ${l.found_status || ''}`.trim()
                                 : l.correction === 'write_off' ? '→ lost' : '→ handed_over')}
                          </td>
                          {isReview && canApprove && !isCounter && (
                            <td style={{ ...td, textAlign: 'center' }}>
                              <input type="checkbox" checked={skip.has(l.id)} onChange={() => toggleSkip(l.id)} />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div style={{ fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--t2)', margin: '14px 0 6px' }}>{children}</div>;
}
function Muted({ children }) { return <div style={{ fontSize: 11, color: 'var(--t3)', padding: '6px 0' }}>{children}</div>; }

function ProductTable({ rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={th}>Product</th>
          <th style={{ ...th, textAlign: 'right' }}>Held</th>
          <th style={{ ...th, textAlign: 'right' }}>Scanned</th>
          <th style={{ ...th, textAlign: 'right' }}>Missing</th>
          <th style={{ ...th, textAlign: 'right' }}>Extra</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ ...td, fontSize: 11 }}>{variantName(r)}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.held}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: '#7b93ff' }}>{r.scanned}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: r.missing ? '#ff7070' : 'var(--t3)' }}>{r.missing}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: r.extra ? '#fbbf24' : 'var(--t3)' }}>{r.extra}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LabelList({ rows, tone = 'gray', showFound = false }) {
  if (!rows.length) return <Muted>None.</Muted>;
  const c = TONE[tone];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
      {rows.map((r, i) => (
        <span key={i} title={variantName(r)}
          style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '3px 8px', borderRadius: 3, background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}>
          {r.batch_label || r.car_upc}
          <span style={{ color: 'var(--t3)', fontSize: 10 }}> · {[r.product, r.color].filter(Boolean).join(' ')}{showFound && r.found_status ? ` · ${r.found_status}` : ''}</span>
        </span>
      ))}
    </div>
  );
}
