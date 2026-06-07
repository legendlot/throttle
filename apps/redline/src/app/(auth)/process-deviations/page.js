'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState } from '@throttle/ui';

const TYPE_OPTIONS = [
  { id: 'material_substitution',    label: 'Material Substitution' },
  { id: 'step_skip',                label: 'Step Skip' },
  { id: 'sequence_change',          label: 'Sequence Change' },
  { id: 'tool_change',              label: 'Tool Change' },
  { id: 'quality_criteria_relaxed', label: 'Quality Criteria Relaxed' },
  { id: 'process_workaround',       label: 'Process Workaround' },
  { id: 'parameter_change',         label: 'Parameter Change' },
  { id: 'documentation_correction', label: 'Documentation Correction' },
  { id: 'other',                    label: 'Other' },
];

const SEVERITY_OPTIONS = [
  { id: 'low',      label: 'Low',      tone: 'green',  required_tier: 'L1' },
  { id: 'medium',   label: 'Medium',   tone: 'yellow', required_tier: 'L1 + L2 (second-eye)' },
  { id: 'high',     label: 'High',     tone: 'orange', required_tier: 'L3 (admin)' },
  { id: 'critical', label: 'Critical', tone: 'red',    required_tier: 'L3 (admin)' },
];

const STATUS_TABS = [
  { id: 'pending',     label: 'Pending Approval', tone: 'yellow' },
  { id: 'active',      label: 'Active on Floor',  tone: 'blue'   },
  { id: 'retroactive', label: 'Retro Sign-off',   tone: 'orange' },
  { id: 'rejected',    label: 'Rejected',         tone: 'red'    },
  { id: 'closed',      label: 'Closed',           tone: 'gray'   },
  { id: 'all',         label: 'All',              tone: 'gray'   },
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
const btnP  = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#0a0a0a', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnG  = { background: 'rgba(34,197,94,.15)', border: '1px solid #4ade80', color: '#4ade80', borderRadius: 3, padding: '8px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnR  = { background: 'rgba(222,42,42,.15)', border: '1px solid #ff7070', color: '#ff7070', borderRadius: 3, padding: '8px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };

function SeverityBadge({ severity }) {
  const cfg = SEVERITY_OPTIONS.find(s => s.id === severity) || { label: severity, tone: 'gray' };
  const s = TONE[cfg.tone];
  return <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', background: s.bg, color: s.fg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>{cfg.label}</span>;
}

function StatusBadge({ status }) {
  const STATUS_MAP = {
    pending:  { label: 'Pending',  tone: 'yellow' },
    approved: { label: 'Approved', tone: 'green'  },
    rejected: { label: 'Rejected', tone: 'red'    },
    cancelled:{ label: 'Cancelled',tone: 'gray'   },
    closed:   { label: 'Closed',   tone: 'gray'   },
  };
  const cfg = STATUS_MAP[status] || { label: status, tone: 'gray' };
  const s = TONE[cfg.tone];
  return <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', background: s.bg, color: s.fg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>{cfg.label}</span>;
}

function fmtTs(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } }
function isCurrentlyActive(dev) {
  if (dev.status !== 'approved') return false;
  const now = new Date();
  if (dev.effective_from && new Date(dev.effective_from) > now) return false;
  if (dev.effective_until && new Date(dev.effective_until) < now) return false;
  return true;
}

export default function ProcessDeviationsPage() {
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const canPropose    = hasPermission(perms, 'deviation_propose');
  const canApproveL1  = hasPermission(perms, 'deviation_approve_l1');
  const canApproveL2  = hasPermission(perms, 'deviation_approve_l2');
  const canApproveL3  = hasPermission(perms, 'deviation_approve_l3');
  const canClose      = hasPermission(perms, 'deviation_close');

  const [tab,     setTab]     = useState('pending');
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [detailNo, setDetailNo] = useState(null);
  const [detail,   setDetail]   = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  // Active tab keeps the floor-friendly by-line card layout (ported from the old Redline floor view).
  const activeByLine = useMemo(() => {
    const map = { L1: [], L2: [], L3: [], D1: [], D2: [], 'All lines': [] };
    rows.forEach((a) => {
      const k = a.line || 'All lines';
      if (!map[k]) map[k] = [];
      map[k].push(a);
    });
    return map;
  }, [rows]);

  async function loadList() {
    if (!session) return;
    setLoading(true);
    try {
      let filter;
      if      (tab === 'pending')     filter = { status: 'pending' };
      else if (tab === 'retroactive') filter = { needs_retroactive_signoff: true };
      else if (tab === 'rejected')    filter = { status: 'rejected' };
      else if (tab === 'closed')      filter = { status: ['closed','cancelled'] };
      else if (tab === 'active') {
        // Active = approved + currently in window. Use getActiveDeviations.
        const ar = await workerFetch('getActiveDeviations', { data: {} }, session);
        setRows(ar?.ok ? (ar.data || []) : []);
        setLoading(false);
        return;
      }
      else filter = {}; // all
      const r = await workerFetch('getProcessDeviations', { data: filter }, session);
      setRows(r?.ok ? (r.data || []) : []);
    } finally { setLoading(false); }
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [tab, session]);

  async function openDetail(deviation_no) {
    setDetailNo(deviation_no);
    setDetail(null);
    setDetailLoading(true);
    try {
      const r = await workerFetch('getProcessDeviation', { data: { deviation_no } }, session);
      setDetail(r?.ok ? r.data : null);
    } finally { setDetailLoading(false); }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <span>Process Deviations</span>
          {canPropose && <button onClick={() => setNewOpen(true)} style={btnP}>+ PROPOSE DEVIATION</button>}
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
          {loading ? <Spinner /> : rows.length === 0 ? (
            <EmptyState title="No deviations" message={`No ${STATUS_TABS.find(t => t.id === tab)?.label.toLowerCase()} deviations.`} />
          ) : tab === 'active' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
              {Object.entries(activeByLine).filter(([, devs]) => devs.length > 0).map(([line, devs]) => (
                <div key={line} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--yellow)' }}>{line}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{devs.length} active</span>
                  </div>
                  {devs.map(d => (
                    <div key={d.id} onClick={() => openDetail(d.deviation_no)} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6, cursor: 'pointer' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)' }}>{d.deviation_no}</span>
                        <SeverityBadge severity={d.severity} />
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--t1)', marginTop: 4 }}>{d.title}</div>
                      <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
                        {(d.type || '').replace(/_/g, ' ')}
                        {d.station ? ` · ${d.station}` : ''}
                        {d.effective_until ? ` · until ${fmtTs(d.effective_until)}` : ' · open-ended'}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>PD No</th>
                    <th style={th}>Title</th>
                    <th style={th}>Type</th>
                    <th style={th}>Severity</th>
                    <th style={th}>Line / Run</th>
                    <th style={th}>Window</th>
                    <th style={th}>Tier</th>
                    <th style={th}>Status</th>
                    <th style={th}>Proposed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(r.deviation_no)}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>
                        {r.deviation_no}
                        {r.reactive && <span title="reactive" style={{ marginLeft: 6, color: '#fbbf24' }}>⚡</span>}
                        {r.needs_retroactive_signoff && <span title="needs retro sign-off" style={{ marginLeft: 4, color: '#fbbf24' }}>⚐</span>}
                      </td>
                      <td style={td}>
                        <div style={{ color: 'var(--t1)', fontSize: 12 }}>{r.title}</div>
                        <div style={{ color: 'var(--t3)', fontSize: 10, marginTop: 2 }}>{r.description?.slice(0, 80)}{r.description?.length > 80 ? '…' : ''}</div>
                      </td>
                      <td style={{ ...td, fontSize: 10, color: 'var(--t2)' }}>{(r.type || '').replace(/_/g, ' ')}</td>
                      <td style={td}><SeverityBadge severity={r.severity} /></td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>
                        {r.line || '—'}{r.run_id ? <div style={{ color: 'var(--t3)' }}>RUN-{r.run_id}</div> : null}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                        {fmtTs(r.effective_from)}
                        <div>→ {r.effective_until ? fmtTs(r.effective_until) : '∞'}</div>
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: r.current_tier === 'l3' ? '#ff7070' : r.current_tier === 'l2' ? '#fbbf24' : r.current_tier === 'l1' ? '#7b93ff' : '#4ade80' }}>
                        {r.current_tier.toUpperCase()}
                      </td>
                      <td style={td}><StatusBadge status={r.status} /></td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                        {fmtTs(r.proposed_at)}
                        {r.proposed_by_name && <div style={{ color: 'var(--t2)' }}>{r.proposed_by_name}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {detailNo && (
        <DeviationDetailModal
          deviation_no={detailNo}
          detail={detail}
          loading={detailLoading}
          session={session}
          toast={toast}
          canApproveL1={canApproveL1}
          canApproveL2={canApproveL2}
          canApproveL3={canApproveL3}
          canClose={canClose}
          onClose={() => { setDetailNo(null); setDetail(null); }}
          onReload={() => { openDetail(detailNo); loadList(); }}
        />
      )}

      {newOpen && (
        <NewDeviationModal
          session={session}
          toast={toast}
          onClose={() => setNewOpen(false)}
          onCreated={() => { setNewOpen(false); loadList(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function DeviationDetailModal({ deviation_no, detail, loading, session, toast, canApproveL1, canApproveL2, canApproveL3, canClose, onClose, onReload }) {
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [acting, setActing] = useState(false);

  async function doAction() {
    if (!action || !detail) return;
    if ((action === 'reject' || action === 'cancel' || action === 'escalate' || action === 'close' || action === 'confirm_no' || action === 'confirm_yes') && action !== 'approve' && action !== 'ack') {
      if (!reason.trim() && (action === 'reject' || action === 'cancel' || action === 'close')) {
        toast('Reason required', 'error'); return;
      }
    }
    setActing(true);
    try {
      let r;
      const payload = { deviation_no, reason: reason.trim() || undefined };
      if      (action === 'approve')     r = await workerFetch('approveDeviation',     { data: payload }, session);
      else if (action === 'reject')      r = await workerFetch('rejectDeviation',      { data: payload }, session);
      else if (action === 'escalate')    r = await workerFetch('escalateDeviation',    { data: payload }, session);
      else if (action === 'ack')         r = await workerFetch('acknowledgeDeviation', { data: payload }, session);
      else if (action === 'cancel')      r = await workerFetch('cancelDeviation',      { data: payload }, session);
      else if (action === 'close')       r = await workerFetch('closeDeviation',       { data: payload }, session);
      else if (action === 'confirm_yes') r = await workerFetch('confirmRetroactiveDeviation', { data: { ...payload, confirmed: true } }, session);
      else if (action === 'confirm_no')  r = await workerFetch('confirmRetroactiveDeviation', { data: { ...payload, confirmed: false } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'error'); return; }
      toast(`${action.toUpperCase()} · ${deviation_no}`, 'success');
      setAction(null);
      setReason('');
      onReload();
    } finally { setActing(false); }
  }

  return (
    <Modal open onClose={onClose} size="lg" title={`Deviation · ${deviation_no}`}>
      {loading || !detail ? <Spinner /> : (
        <>
          {detail.reactive && (
            <div style={{ marginBottom: 10, padding: '6px 10px', background: 'rgba(245,158,11,.15)', border: '1px solid rgba(245,158,11,.3)', borderRadius: 3, fontSize: 11, color: '#fbbf24' }}>
              ⚡ <strong>Reactive deviation</strong> — logged after the fact.
              {detail.needs_retroactive_signoff && ' Supervisor sign-off still required below.'}
            </div>
          )}

          <div style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0, color: 'var(--t1)', fontSize: 14 }}>{detail.title}</h3>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <SeverityBadge severity={detail.severity} />
              <StatusBadge status={detail.status} />
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{(detail.type || '').replace(/_/g, ' ')}</span>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>tier: {detail.current_tier.toUpperCase()} (required {detail.required_tier.toUpperCase()})</span>
              {isCurrentlyActive(detail) && (
                <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: '#4ade80', fontWeight: 700 }}>● ACTIVE NOW</span>
              )}
            </div>
          </div>

          <div style={{ marginBottom: 12, padding: 10, background: 'var(--surface2)', borderRadius: 3, fontSize: 12, color: 'var(--t1)', whiteSpace: 'pre-wrap' }}>{detail.description}</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12, fontSize: 11 }}>
            <KV label="Reason" value={detail.reason || '—'} />
            <KV label="Rollback plan" value={detail.rollback_plan || '—'} />
            <KV label="Line" value={detail.line || '—'} />
            <KV label="Run" value={detail.run_id ? `RUN-${detail.run_id}` : '—'} />
            <KV label="Product" value={[detail.product, detail.variant, detail.color].filter(Boolean).join(' · ') || '—'} />
            <KV label="Station" value={detail.station || '—'} />
            <KV label="Effective from" value={fmtTs(detail.effective_from)} />
            <KV label="Effective until" value={detail.effective_until ? fmtTs(detail.effective_until) : '∞ open-ended'} />
            <KV label="Proposed" value={`${fmtTs(detail.proposed_at)} · ${detail.proposed_by_name || '—'}`} />
            {detail.escalated_count > 0 && <KV label="Escalated" value={`${detail.escalated_count}× · last by ${detail.last_escalated_by ? detail.last_escalated_by.slice(0,8) : '—'}`} />}
            {detail.approved_l1_at && <KV label="L1 approval" value={`${fmtTs(detail.approved_l1_at)} · ${detail.approver_l1_name || '—'}${detail.approver_l1_reason ? ` · "${detail.approver_l1_reason}"` : ''}`} />}
            {detail.approved_l2_at && <KV label="L2 approval" value={`${fmtTs(detail.approved_l2_at)} · ${detail.approver_l2_name || '—'}${detail.approver_l2_reason ? ` · "${detail.approver_l2_reason}"` : ''}`} />}
            {detail.approved_l3_at && <KV label="L3 approval" value={`${fmtTs(detail.approved_l3_at)} · ${detail.approver_l3_name || '—'}${detail.approver_l3_reason ? ` · "${detail.approver_l3_reason}"` : ''}`} />}
            {detail.rejected_at && <KV label="Rejected" value={`${fmtTs(detail.rejected_at)} · ${detail.rejected_by_name || '—'} · ${detail.reject_reason || ''}`} />}
            {detail.closed_at && <KV label="Closed" value={`${fmtTs(detail.closed_at)} · ${detail.closed_by_name || '—'} · ${detail.close_reason || ''}`} />}
            {detail.retroactive_signed_at && <KV label="Retro sign-off" value={`${fmtTs(detail.retroactive_signed_at)} · ${detail.retroactive_signed_by_name || '—'} · ${detail.retroactive_signed_reason || ''}`} />}
          </div>

          {action ? (
            <div style={{ padding: 10, background: 'var(--surface2)', borderRadius: 3, marginBottom: 10 }}>
              <label style={lbl}>{(action === 'approve' || action === 'ack') ? 'Notes (optional)' : action === 'confirm_yes' ? 'Sign-off note (optional)' : 'Reason'} {(action === 'reject' || action === 'cancel' || action === 'close') && <span style={{ color: '#ff7070' }}>*</span>}</label>
              <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
                <button onClick={() => { setAction(null); setReason(''); }} style={btnS} disabled={acting}>CANCEL</button>
                <button onClick={doAction} disabled={acting} style={(action === 'reject' || action === 'confirm_no' || action === 'close' || action === 'cancel') ? btnR : btnG}>
                  {acting ? 'WORKING…' : `CONFIRM ${action.toUpperCase()}`}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {/* Approve / Reject when pending */}
              {detail.status === 'pending' && (
                <>
                  {((detail.current_tier === 'l1' && canApproveL1) ||
                    (detail.current_tier === 'l2' && canApproveL2) ||
                    (detail.current_tier === 'l3' && canApproveL3)) && (
                    <>
                      <button onClick={() => setAction('approve')} style={btnG}>✓ APPROVE</button>
                      <button onClick={() => setAction('reject')} style={btnR}>✗ REJECT</button>
                    </>
                  )}
                  {/* Escalate (operator or any L1+) */}
                  {detail.current_tier !== 'l3' && (canApproveL1 || true) && (
                    <button onClick={() => setAction('escalate')} style={btnS}>⬆ ESCALATE</button>
                  )}
                </>
              )}
              {/* Retroactive sign-off */}
              {detail.needs_retroactive_signoff && (
                (detail.severity === 'low' && canApproveL1) ||
                (detail.severity === 'medium' && canApproveL2)
              ) && (
                <>
                  <button onClick={() => setAction('confirm_yes')} style={btnG}>✓ CONFIRM RETRO</button>
                  <button onClick={() => setAction('confirm_no')} style={btnR}>✗ REJECT RETRO</button>
                </>
              )}
              {/* Acknowledge */}
              {(detail.status === 'approved' || detail.status === 'closed' || detail.status === 'rejected') &&
               canApproveL1 && !detail.currentUserAcknowledged && (
                <button onClick={() => setAction('ack')} style={btnS}>👁 ACKNOWLEDGE</button>
              )}
              {detail.currentUserAcknowledged && (
                <span style={{ fontSize: 11, color: '#4ade80', fontFamily: 'var(--mono)' }}>✓ You acknowledged</span>
              )}
              {/* Close (only approved) */}
              {detail.status === 'approved' && canClose && (
                <button onClick={() => setAction('close')} style={{ ...btnS, color: '#fbbf24', borderColor: 'rgba(245,158,11,.3)' }}>⏹ CLOSE</button>
              )}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 6 }}>HISTORY · {detail.history?.length || 0}</div>
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>When</th><th style={th}>Action</th><th style={th}>From → To</th><th style={th}>By</th><th style={th}>Reason</th>
                </tr></thead>
                <tbody>
                  {(detail.history || []).map(h => (
                    <tr key={h.id}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10 }}>{fmtTs(h.acted_at)}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>{h.action}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10 }}><span style={{ color: 'var(--t3)' }}>{h.old_status || '—'}</span> → <span style={{ color: 'var(--t1)' }}>{h.new_status}</span></td>
                      <td style={{ ...td, fontSize: 11 }}>{h.actor_name || (h.actor ? h.actor.slice(0,8) : '—')}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t2)' }}>{h.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function KV({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <div style={{ color: 'var(--t1)', fontSize: 11 }}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function NewDeviationModal({ session, toast, onClose, onCreated }) {
  const [form, setForm] = useState({
    type: 'material_substitution', severity: 'low',
    line: '', run_id: '', product: '', variant: '', color: '', station: '',
    effective_from: '', effective_until: '',
    title: '', description: '', reason: '', rollback_plan: '',
    reactive: false,
  });
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!form.title.trim() || form.title.trim().length < 3) { toast('Title required (min 3 chars)', 'error'); return; }
    if (!form.description.trim() || form.description.trim().length < 10) { toast('Description required (min 10 chars)', 'error'); return; }
    setSubmitting(true);
    try {
      const data = {
        type:       form.type,
        severity:   form.severity,
        title:      form.title.trim(),
        description: form.description.trim(),
        reason:     form.reason.trim() || null,
        rollback_plan: form.rollback_plan.trim() || null,
        line:       form.line || null,
        run_id:     form.run_id ? parseInt(form.run_id) : null,
        product:    form.product || null,
        variant:    form.variant || null,
        color:      form.color || null,
        station:    form.station || null,
        effective_from:  form.effective_from || undefined,
        effective_until: form.effective_until || null,
        reactive:   form.reactive,
      };
      const r = await workerFetch('proposeDeviation', { data }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'error'); return; }
      toast(`Created ${r.data.deviation_no} · tier=${r.data.current_tier.toUpperCase()}${r.data.needs_retroactive_signoff ? ' · needs retro sign-off' : ''}`, 'success');
      onCreated();
    } finally { setSubmitting(false); }
  }

  const sev = SEVERITY_OPTIONS.find(s => s.id === form.severity);

  return (
    <Modal open onClose={onClose} size="lg" title="Propose process deviation"
           confirmLabel={submitting ? 'CREATING…' : 'PROPOSE'} onConfirm={submit} loading={submitting}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={lbl}>Type <span style={{ color: '#ff7070' }}>*</span></label>
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ ...input, width: '100%' }}>
            {TYPE_OPTIONS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Severity <span style={{ color: '#ff7070' }}>*</span></label>
          <select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })} style={{ ...input, width: '100%' }}>
            {SEVERITY_OPTIONS.map(s => <option key={s.id} value={s.id}>{s.label} — {s.required_tier}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={lbl}>Title <span style={{ color: '#ff7070' }}>*</span></label>
          <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="short summary (visible in lists)" style={{ ...input, width: '100%' }} autoFocus />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={lbl}>Description <span style={{ color: '#ff7070' }}>*</span></label>
          <textarea rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="what's being done differently from the SOP" style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={lbl}>Reason</label>
          <textarea rows={2} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="why the deviation is needed" style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={lbl}>Rollback plan</label>
          <textarea rows={2} value={form.rollback_plan} onChange={e => setForm({ ...form, rollback_plan: e.target.value })} placeholder="how to revert when the deviation ends" style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        <div>
          <label style={lbl}>Line</label>
          <select value={form.line} onChange={e => setForm({ ...form, line: e.target.value })} style={{ ...input, width: '100%' }}>
            <option value="">— all lines —</option>
            {['L1','L2','L3','D1','D2'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Run ID (optional)</label>
          <input type="number" value={form.run_id} onChange={e => setForm({ ...form, run_id: e.target.value })} placeholder="numeric production_runs.id" style={{ ...input, width: '100%' }} />
        </div>
        <div>
          <label style={lbl}>Product</label>
          <input value={form.product} onChange={e => setForm({ ...form, product: e.target.value })} style={{ ...input, width: '100%' }} />
        </div>
        <div>
          <label style={lbl}>Station</label>
          <input value={form.station} onChange={e => setForm({ ...form, station: e.target.value })} placeholder="Assembly / QC / Packaging…" style={{ ...input, width: '100%' }} />
        </div>
        <div>
          <label style={lbl}>Effective from (optional, default = now)</label>
          <input type="datetime-local" value={form.effective_from} onChange={e => setForm({ ...form, effective_from: e.target.value })} style={{ ...input, width: '100%' }} />
        </div>
        <div>
          <label style={lbl}>Effective until (optional)</label>
          <input type="datetime-local" value={form.effective_until} onChange={e => setForm({ ...form, effective_until: e.target.value })} style={{ ...input, width: '100%' }} />
        </div>

        <div style={{ gridColumn: '1 / 3', padding: 10, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.2)', borderRadius: 3 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', color: 'var(--t2)', fontSize: 12 }}>
            <input type="checkbox" checked={form.reactive} onChange={e => setForm({ ...form, reactive: e.target.checked })} />
            <strong style={{ color: '#fbbf24' }}>⚡ Reactive</strong> — this deviation is already in effect on the floor
          </label>
          {form.reactive && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--t2)' }}>
              {form.severity === 'low' || form.severity === 'medium'
                ? <>Reactive {form.severity} deviation will be created as <strong>approved immediately</strong> but flagged for supervisor retro sign-off. Use only when waiting for approval is not operationally possible.</>
                : <>Reactive flag captured, but {form.severity} severity still requires pre-approval before the deviation can be considered active. Operator should stop deviating until approved.</>}
            </div>
          )}
        </div>

        <div style={{ gridColumn: '1 / 3', fontSize: 11, color: 'var(--t3)', padding: 6 }}>
          <strong>Approval flow for {sev?.label}:</strong> {sev?.required_tier}.
          {form.severity === 'medium' && ' Two approvers needed (L1 then L2 second-eye).'}
          {(form.severity === 'high' || form.severity === 'critical') && ' Reactive auto-approval blocked at this severity.'}
        </div>
      </div>
    </Modal>
  );
}
