'use client';
/* ════════════════════════════════════════════════════════════
   PROCESS DEVIATIONS — Pit Wall v2 reskin (redesign-reference/
   app/dev.jsx). Status tab chips · list rows with the tiered
   approval stepper (data model carries current_tier/required_tier
   + approved_l1/l2/l3 fields) · active-on-floor by-line cards ·
   drill-down drawer with approval chain, what's-changing, history
   timeline and the full action set (approve / reject / escalate /
   ack / close / retro sign-off). All workerFetch actions, params
   and permission gates preserved exactly from the pre-redesign
   page; chrome only.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast } from '@throttle/ui';
import { LINES } from '@throttle/domain';
import {
  Icon, Panel, ToneBadge, Drawer,
  lineColor, lineRgb, btnPrimary, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

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
  { id: 'low',      label: 'Low',      required_tier: 'L1' },
  { id: 'medium',   label: 'Medium',   required_tier: 'L1 + L2 (second-eye)' },
  { id: 'high',     label: 'High',     required_tier: 'L3 (admin)' },
  { id: 'critical', label: 'Critical', required_tier: 'L3 (admin)' },
];

// severity → required approval chain (mirrors worker tiering rules)
const CHAIN = { low: ['l1'], medium: ['l1', 'l2'], high: ['l3'], critical: ['l3'] };

const STATUS_TABS = [
  { id: 'pending',     label: 'Pending',         dot: 'var(--warn-fg)' },
  { id: 'active',      label: 'Active on floor', dot: 'var(--blue-bright)' },
  { id: 'retroactive', label: 'Retro sign-off',  dot: 'var(--orange)' },
  { id: 'rejected',    label: 'Rejected',        dot: 'var(--bad-fg)' },
  { id: 'closed',      label: 'Closed',          dot: 'var(--t3)' },
  { id: 'all',         label: 'All',             dot: 'var(--t3)' },
];

const SEV_TONE = {
  low:      { fg: 'var(--ok-fg)',   bg: 'var(--ok-bg)',   bd: 'var(--ok-bd)' },
  medium:   { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)', bd: 'var(--warn-bd)' },
  high:     { fg: 'var(--orange)',  bg: 'rgba(249,115,22,0.14)', bd: 'rgba(249,115,22,0.3)' },
  critical: { fg: 'var(--bad-fg)',  bg: 'var(--bad-bg)',  bd: 'var(--bad-bd)' },
};
const sevStyle = (sev) => SEV_TONE[sev] || { fg: 'var(--t2)', bg: 'var(--surface-2)', bd: 'var(--border-2)' };

const STATUS_TONE = {
  pending:   { label: 'Pending',   tone: 'warn' },
  approved:  { label: 'Approved',  tone: 'ok' },
  rejected:  { label: 'Rejected',  tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'mute' },
  closed:    { label: 'Closed',    tone: 'mute' },
};

function SevBadge({ severity }) {
  const s = sevStyle(severity);
  return (
    <span className="num" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: s.fg, background: s.bg, border: `1px solid ${s.bd}`,
      borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }}>{severity}</span>
  );
}

function StatusBadge({ status }) {
  const cfg = STATUS_TONE[status] || { label: status, tone: 'mute' };
  return <ToneBadge tone={cfg.tone}>{cfg.label}</ToneBadge>;
}

function LineChip({ line }) {
  if (!line) return null;
  return (
    <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(line),
      background: `rgba(${lineRgb(line)},0.12)`, borderRadius: 3, padding: '1px 5px',
      whiteSpace: 'nowrap' }}>{line}</span>
  );
}

function fmtTs(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } }
function isCurrentlyActive(dev) {
  if (dev.status !== 'approved') return false;
  const now = new Date();
  if (dev.effective_from && new Date(dev.effective_from) > now) return false;
  if (dev.effective_until && new Date(dev.effective_until) < now) return false;
  return true;
}
function chainFor(dev) { return CHAIN[dev.severity] || ['l1']; }
function tierApproval(dev, t) {
  // t is 'l1' | 'l2' | 'l3' — list + detail rows expose approved_lX_at
  return dev[`approved_${t}_at`]
    ? { at: dev[`approved_${t}_at`], by: dev[`approver_${t}_name`], note: dev[`approver_${t}_reason`] }
    : null;
}

/* ── tiered approval stepper ────────────────────────────────── */
function TierStepper({ dev, compact }) {
  const chain = chainFor(dev);
  const cur = dev.status === 'pending' ? (dev.current_tier || '').toLowerCase() : null;
  const rejected = dev.status === 'rejected';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 4 : 6 }}>
      {chain.map((t, i) => {
        const done = !!tierApproval(dev, t);
        const isCur = t === cur;
        const color = done ? 'var(--ok-fg)' : isCur ? 'var(--yellow)' : rejected ? 'var(--bad-fg)' : 'var(--t4)';
        return (
          <span key={t} style={{ display: 'contents' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: compact ? '2px 6px' : '3px 8px', borderRadius: 'var(--r-full)',
              border: `1px solid ${done ? 'var(--ok-bd)' : isCur ? 'var(--yellow)' : 'var(--border-2)'}`,
              background: done ? 'var(--ok-bg)' : isCur ? 'var(--yellow-dim)' : 'transparent' }}>
              {done && <Icon name="shield" size={compact ? 10 : 11} style={{ color }} />}
              <span className="num" style={{ fontSize: compact ? 10 : 11, fontWeight: 700, color, textTransform: 'uppercase' }}>{t}</span>
            </span>
            {i < chain.length - 1 && (
              <span style={{ width: compact ? 8 : 14, height: 1.5,
                background: tierApproval(dev, chain[i]) ? 'var(--ok-bd)' : 'var(--border-2)' }} />
            )}
          </span>
        );
      })}
    </div>
  );
}

/* ── list row ───────────────────────────────────────────────── */
const LIST_COLS = '112px minmax(220px,1.6fr) 142px 118px 150px 96px 140px';

function DevRow({ r, onOpen, hover, setHover }) {
  const typeLabel = (r.type || '').replace(/_/g, ' ');
  return (
    <div onClick={() => onOpen(r.deviation_no)}
      onMouseEnter={() => setHover(r.id)} onMouseLeave={() => setHover(null)}
      style={{ display: 'grid', gridTemplateColumns: LIST_COLS, gap: 12, alignItems: 'center',
        padding: '11px 12px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
        background: hover === r.id ? 'var(--surface-2)' : 'transparent',
        border: '1px solid', borderColor: hover === r.id ? 'var(--border-2)' : 'transparent',
        transition: 'all var(--fast) var(--ease)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="num" style={{ fontSize: 12, fontWeight: 700, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>{r.deviation_no}</span>
        {r.reactive && <span title="reactive — logged after the fact" style={{ color: 'var(--amber)', display: 'flex' }}><Icon name="alert" size={12} /></span>}
        {r.needs_retroactive_signoff && <span title="needs retro sign-off" style={{ color: 'var(--orange)', display: 'flex' }}><Icon name="flag" size={12} /></span>}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
          {typeLabel}{r.run_id ? <span className="num"> · RUN-{r.run_id}</span> : null}{r.description ? ` · ${r.description.slice(0, 60)}${r.description.length > 60 ? '…' : ''}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SevBadge severity={r.severity} />
        <LineChip line={r.line} />
      </div>
      <TierStepper dev={r} compact />
      <div className="num" style={{ fontSize: 10.5, color: 'var(--t3)', lineHeight: 1.4 }}>
        {fmtTs(r.effective_from)}<br />{r.effective_until ? `→ ${fmtTs(r.effective_until)}` : '→ open-ended'}
      </div>
      <div><StatusBadge status={r.status} /></div>
      <div style={{ textAlign: 'right' }}>
        <div className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{fmtTs(r.proposed_at)}</div>
        {r.proposed_by_name && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t2)', marginTop: 1 }}>{r.proposed_by_name}</div>}
      </div>
    </div>
  );
}

/* ── active-on-floor by-line cards ──────────────────────────── */
function ActiveByLine({ rows, onOpen }) {
  const byLine = {};
  rows.forEach((a) => { const k = a.line || 'All lines'; (byLine[k] = byLine[k] || []).push(a); });
  const keys = Object.keys(byLine).sort();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
      {keys.map(line => (
        <div key={line} style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 13px', borderBottom: '1px solid var(--border)' }}>
            <span className="font-display" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
              color: byLine[line][0]?.line ? lineColor(line) : 'var(--t2)' }}>{line}</span>
            <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{byLine[line].length} active</span>
          </div>
          <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {byLine[line].map(d => (
              <div key={d.id} onClick={() => onOpen(d.deviation_no)} style={{ padding: 9, borderRadius: 'var(--r-sm)', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="num" style={{ fontSize: 11, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>{d.deviation_no}</span>
                  <SevBadge severity={d.severity} />
                  {d.needs_retroactive_signoff && <span title="needs retro sign-off" style={{ marginLeft: 'auto', color: 'var(--orange)', display: 'flex' }}><Icon name="flag" size={12} /></span>}
                </div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)', marginTop: 5 }}>{d.title}</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--t3)', marginTop: 3 }}>
                  {(d.type || '').replace(/_/g, ' ')}
                  {d.station ? ` · ${d.station}` : ''}
                  {d.effective_until ? ` · until ${fmtTs(d.effective_until)}` : ' · open-ended'}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
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
  const [hoverId, setHoverId] = useState(null);

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
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {STATUS_TABS.map(t => {
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                background: on ? 'var(--surface-3)' : 'transparent', border: `1px solid ${on ? 'var(--border-3)' : 'var(--border)'}`,
                color: on ? 'var(--t1)' : 'var(--t3)', borderRadius: 'var(--r-full)', padding: '6px 13px', whiteSpace: 'nowrap',
                fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.dot }} />{t.label}
              </button>
            );
          })}
        </div>
        {canPropose && (
          <button onClick={() => setNewOpen(true)} style={btnPrimary}>
            <Icon name="plus" size={15} /> Propose Deviation
          </button>
        )}
      </div>

      <Panel pad={tab === 'active' ? 14 : 8}>
        {loading ? (
          <div style={{ padding: '32px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '48px 0', textAlign: 'center' }}>
            <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
              background: 'var(--ok-bg)', color: 'var(--ok-fg)', border: '1px solid var(--ok-bd)', marginBottom: 12 }}>
              <Icon name="shield" size={22} />
            </div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>Nothing here</div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>
              No {STATUS_TABS.find(t => t.id === tab)?.label.toLowerCase()} deviations.
            </div>
          </div>
        ) : tab === 'active' ? (
          <ActiveByLine rows={rows} onOpen={openDetail} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 980 }}>
              <div style={{ display: 'grid', gridTemplateColumns: LIST_COLS, gap: 12, padding: '0 12px 9px', borderBottom: '1px solid var(--border)' }}>
                {['PD No', 'Title / type', 'Severity · line', 'Approval', 'Window', 'Status', 'Proposed'].map((h, i) => (
                  <div key={h} className="eyebrow" style={{ textAlign: i === 6 ? 'right' : 'left' }}>{h}</div>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2 }}>
                {rows.map(r => <DevRow key={r.id} r={r} onOpen={openDetail} hover={hoverId} setHover={setHoverId} />)}
              </div>
            </div>
          </div>
        )}
      </Panel>

      {detailNo && (
        <DeviationDrawer
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
function KV({ label, value }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 3 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}

const actBtn = (kind) => ({
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  borderRadius: 'var(--r-sm)', padding: '10px 12px', cursor: 'pointer',
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5,
  letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
  ...(kind === 'ok'
    ? { background: 'var(--ok-bg)', color: 'var(--ok-fg)', border: '1px solid var(--ok-bd)' }
    : kind === 'bad'
      ? { background: 'var(--bad-bg)', color: 'var(--bad-fg)', border: '1px solid var(--bad-bd)' }
      : kind === 'brand'
        ? { background: 'var(--yellow)', color: '#1a1a1a', border: '1px solid var(--yellow)' }
        : { background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border-2)' }),
});

function DeviationDrawer({ deviation_no, detail, loading, session, toast, canApproveL1, canApproveL2, canApproveL3, canClose, onClose, onReload }) {
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

  const s = detail ? sevStyle(detail.severity) : null;
  const cur = detail && detail.status === 'pending' ? (detail.current_tier || '').toLowerCase() : null;

  return (
    <Drawer open onClose={onClose} width={480}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '15px 20px', borderBottom: '1px solid var(--border)' }}>
        <span className="num" style={{ fontSize: 13, fontWeight: 700, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>{deviation_no}</span>
        {detail && <SevBadge severity={detail.severity} />}
        {detail?.reactive && (
          <span className="num" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9.5, fontWeight: 700,
            color: 'var(--amber)', background: 'var(--warn-bg)', border: '1px solid var(--warn-bd)', borderRadius: 3, padding: '2px 6px' }}>
            <Icon name="alert" size={10} /> REACTIVE
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: '1px solid var(--border-2)',
          borderRadius: 'var(--r-xs)', width: 26, height: 26, color: 'var(--t3)', cursor: 'pointer',
          display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} /></button>
      </div>

      {loading || !detail ? (
        <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : (
        <>
          <div style={{ overflowY: 'auto', padding: 20, flex: 1 }}>
            {detail.reactive && (
              <div style={{ marginBottom: 14, padding: '8px 11px', background: 'var(--warn-bg)', border: '1px solid var(--warn-bd)',
                borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--warn-fg)' }}>
                Reactive deviation — logged after the fact.
                {detail.needs_retroactive_signoff && ' Supervisor sign-off still required below.'}
              </div>
            )}

            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 18, fontWeight: 700, color: 'var(--t1)', lineHeight: 1.3 }}>{detail.title}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t2)' }}>{(detail.type || '').replace(/_/g, ' ')}</span>
              <StatusBadge status={detail.status} />
              {isCurrentlyActive(detail) && (
                <span className="num" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--ok-fg)' }}>
                  <span className="rl-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)' }} /> ACTIVE NOW
                </span>
              )}
              {detail.needs_retroactive_signoff && (
                <span className="num" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700,
                  color: 'var(--orange)', background: 'rgba(249,115,22,0.14)', border: '1px solid rgba(249,115,22,0.3)',
                  borderRadius: 3, padding: '2px 7px' }}>
                  <Icon name="flag" size={10} /> RETRO SIGN-OFF NEEDED
                </span>
              )}
            </div>

            {/* approval chain */}
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '13px 15px', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
                <span className="eyebrow">Approval chain</span>
                <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>
                  {detail.severity} → {chainFor(detail).map(t => t.toUpperCase()).join(' + ')} · required {String(detail.required_tier || '').toUpperCase()}
                </span>
              </div>
              <TierStepper dev={detail} />
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {chainFor(detail).map(t => {
                  const a = tierApproval(detail, t);
                  return (
                    <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-ui)', fontSize: 11.5 }}>
                      <span style={{ width: 18, color: a ? 'var(--ok-fg)' : 'var(--t4)', display: 'flex' }}><Icon name={a ? 'shield' : 'clock'} size={13} /></span>
                      <span className="num" style={{ color: 'var(--t2)', width: 22, textTransform: 'uppercase' }}>{t}</span>
                      {a
                        ? <span style={{ color: 'var(--t2)' }}>{a.by || '—'} · <span className="num" style={{ color: 'var(--t3)' }}>{fmtTs(a.at)}</span>{a.note ? ` · "${a.note}"` : ''}</span>
                        : <span style={{ color: t === cur ? 'var(--yellow)' : 'var(--t4)' }}>{t === cur ? 'awaiting approval' : 'pending'}</span>}
                    </div>
                  );
                })}
                {detail.escalated_count > 0 && (
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)' }}>
                    Escalated <span className="num">{detail.escalated_count}×</span>{detail.last_escalated_by ? <> · last by <span className="num">{detail.last_escalated_by.slice(0, 8)}</span></> : null}
                  </div>
                )}
              </div>
            </div>

            {/* what's changing */}
            <div style={{ borderLeft: `2px solid ${s.bd}`, paddingLeft: 13, marginBottom: 16 }}>
              <div className="label" style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 5 }}>What&apos;s changing</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{detail.description}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <KV label="Reason" value={detail.reason || '—'} />
              <KV label="Rollback plan" value={detail.rollback_plan || '—'} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <KV label="Line / run" value={<>{detail.line || 'All lines'}{detail.run_id ? <span className="num"> · RUN-{detail.run_id}</span> : null}</>} />
              <KV label="Station" value={detail.station || '—'} />
              <KV label="Product" value={[detail.product, detail.variant, detail.color].filter(Boolean).join(' · ') || '—'} />
              <KV label="Proposed" value={<><span className="num">{fmtTs(detail.proposed_at)}</span> · {detail.proposed_by_name || '—'}</>} />
              <KV label="Effective from" value={<span className="num">{fmtTs(detail.effective_from)}</span>} />
              <KV label="Effective until" value={<span className="num">{detail.effective_until ? fmtTs(detail.effective_until) : 'open-ended'}</span>} />
              {detail.rejected_at && <KV label="Rejected" value={<><span className="num">{fmtTs(detail.rejected_at)}</span> · {detail.rejected_by_name || '—'}{detail.reject_reason ? ` · ${detail.reject_reason}` : ''}</>} />}
              {detail.closed_at && <KV label="Closed" value={<><span className="num">{fmtTs(detail.closed_at)}</span> · {detail.closed_by_name || '—'}{detail.close_reason ? ` · ${detail.close_reason}` : ''}</>} />}
              {detail.retroactive_signed_at && <KV label="Retro sign-off" value={<><span className="num">{fmtTs(detail.retroactive_signed_at)}</span> · {detail.retroactive_signed_by_name || '—'}{detail.retroactive_signed_reason ? ` · ${detail.retroactive_signed_reason}` : ''}</>} />}
            </div>

            {/* history timeline */}
            <div className="label" style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 10 }}>
              History · <span className="num">{detail.history?.length || 0}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {(detail.history || []).map((h, i, arr) => (
                <div key={h.id} style={{ display: 'flex', gap: 11, paddingBottom: 12, position: 'relative' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 3,
                      background: /reject|cancel/i.test(h.action) ? 'var(--bad-fg)' : /approv|propos|close|confirm/i.test(h.action) ? 'var(--ok-fg)' : 'var(--t3)' }} />
                    {i < arr.length - 1 && <span style={{ flex: 1, width: 1.5, background: 'var(--border-2)', marginTop: 2 }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap' }}>{h.action}</span>
                      <span className="num" style={{ fontSize: 10, color: 'var(--t4)' }}>{h.old_status || '—'} → {h.new_status}</span>
                      <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{fmtTs(h.acted_at)}</span>
                    </div>
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>
                      {h.actor_name || (h.actor ? h.actor.slice(0, 8) : '—')}{h.reason ? ` · ${h.reason}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* actions footer */}
          <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
            {action ? (
              <div>
                <div className="eyebrow" style={{ marginBottom: 7 }}>
                  {(action === 'approve' || action === 'ack') ? 'Notes (optional)'
                    : action === 'confirm_yes' ? 'Sign-off note (optional)'
                    : <>Reason{(action === 'reject' || action === 'cancel' || action === 'close') && <span style={{ color: 'var(--bad-fg)' }}> *</span>}</>}
                </div>
                <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} autoFocus
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-ui)' }} />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                  <button onClick={() => { setAction(null); setReason(''); }} style={btnGhost} disabled={acting}>Cancel</button>
                  <button onClick={doAction} disabled={acting}
                    style={actBtn((action === 'reject' || action === 'confirm_no' || action === 'close' || action === 'cancel') ? 'bad' : 'ok')}>
                    {acting ? 'Working…' : `Confirm ${action.replace('_', ' ')}`}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {/* Approve / Reject when pending */}
                {detail.status === 'pending' && (
                  <>
                    {((cur === 'l1' && canApproveL1) ||
                      (cur === 'l2' && canApproveL2) ||
                      (cur === 'l3' && canApproveL3)) && (
                      <>
                        <button onClick={() => setAction('approve')} style={actBtn('ok')}>
                          <Icon name="shield" size={14} /> Approve {cur.toUpperCase()}
                        </button>
                        <button onClick={() => setAction('reject')} style={actBtn('bad')}>
                          <Icon name="alert" size={14} /> Reject
                        </button>
                      </>
                    )}
                    {/* Escalate (operator or any L1+) */}
                    {cur !== 'l3' && (
                      <button onClick={() => setAction('escalate')} style={actBtn('ghost')}>
                        <Icon name="arrowUp" size={14} /> Escalate
                      </button>
                    )}
                  </>
                )}
                {/* Retroactive sign-off */}
                {detail.needs_retroactive_signoff && (
                  (detail.severity === 'low' && canApproveL1) ||
                  (detail.severity === 'medium' && canApproveL2)
                ) && (
                  <>
                    <button onClick={() => setAction('confirm_yes')} style={actBtn('brand')}>
                      <Icon name="flag" size={14} /> Confirm retro
                    </button>
                    <button onClick={() => setAction('confirm_no')} style={actBtn('bad')}>
                      <Icon name="alert" size={14} /> Reject retro
                    </button>
                  </>
                )}
                {/* Acknowledge */}
                {(detail.status === 'approved' || detail.status === 'closed' || detail.status === 'rejected') &&
                 canApproveL1 && !detail.currentUserAcknowledged && (
                  <button onClick={() => setAction('ack')} style={actBtn('ghost')}>
                    <Icon name="clipboard" size={14} /> Acknowledge
                  </button>
                )}
                {detail.currentUserAcknowledged && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)',
                    fontSize: 12, fontWeight: 600, color: 'var(--ok-fg)', padding: '10px 4px' }}>
                    <Icon name="shield" size={13} /> You acknowledged
                  </span>
                )}
                {/* Close (only approved) */}
                {detail.status === 'approved' && canClose && (
                  <button onClick={() => setAction('close')} style={actBtn('ghost')}>
                    <Icon name="clock" size={14} /> Close deviation
                  </button>
                )}
                {(detail.status === 'rejected' || detail.status === 'closed' || detail.status === 'cancelled') &&
                 !detail.needs_retroactive_signoff && (
                  <span style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', padding: '10px 0' }}>
                    {detail.status === 'rejected' ? 'This deviation was rejected.' : detail.status === 'cancelled' ? 'This deviation was cancelled.' : 'This deviation is closed.'}
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </Drawer>
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

  const sev = SEVERITY_OPTIONS.find(x => x.id === form.severity);
  const chain = (CHAIN[form.severity] || ['l1']).map(t => t.toUpperCase());
  const eyebrow = { marginBottom: 6, display: 'block' };

  return (
    <Modal open onClose={onClose} size="lg" title="Propose process deviation"
           confirmLabel={submitting ? 'Creating…' : 'Propose'} onConfirm={submit} loading={submitting}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1 / 3' }}>
          <span className="eyebrow" style={eyebrow}>Title <span style={{ color: 'var(--bad-fg)' }}>*</span></span>
          <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="short summary (visible in lists)" style={inputStyle} autoFocus />
        </div>
        <div>
          <span className="eyebrow" style={eyebrow}>Type <span style={{ color: 'var(--bad-fg)' }}>*</span></span>
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
            {TYPE_OPTIONS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <span className="eyebrow" style={eyebrow}>Line</span>
          <select value={form.line} onChange={e => setForm({ ...form, line: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="">— all lines —</option>
            {/* S326: was ['L1','L2','L3','D1','D2'] — a deviation on L4/L5 could not be filed. */}
            {[...LINES, 'D1', 'D2'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <span className="eyebrow" style={eyebrow}>Severity <span style={{ color: 'var(--bad-fg)' }}>*</span></span>
          <div style={{ display: 'flex', gap: 6 }}>
            {SEVERITY_OPTIONS.map(sv => {
              const st = sevStyle(sv.id); const on = form.severity === sv.id;
              return (
                <button key={sv.id} type="button" onClick={() => setForm({ ...form, severity: sv.id })}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                    border: `1px solid ${on ? st.fg : 'var(--border-2)'}`, background: on ? st.bg : 'var(--surface-2)',
                    color: on ? st.fg : 'var(--t2)', fontFamily: 'var(--font-display)', fontWeight: 700,
                    fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{sv.label}</button>
              );
            })}
          </div>
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <span className="eyebrow" style={eyebrow}>Description <span style={{ color: 'var(--bad-fg)' }}>*</span></span>
          <textarea rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="what's being done differently from the SOP" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-ui)' }} />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <span className="eyebrow" style={eyebrow}>Reason</span>
          <textarea rows={2} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="why the deviation is needed" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-ui)' }} />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <span className="eyebrow" style={eyebrow}>Rollback plan</span>
          <textarea rows={2} value={form.rollback_plan} onChange={e => setForm({ ...form, rollback_plan: e.target.value })} placeholder="how to revert when the deviation ends" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-ui)' }} />
        </div>

        <div>
          <span className="eyebrow" style={eyebrow}>Run ID (optional)</span>
          <input type="number" className="num" value={form.run_id} onChange={e => setForm({ ...form, run_id: e.target.value })} placeholder="numeric production_runs.id" style={inputStyle} />
        </div>
        <div>
          <span className="eyebrow" style={eyebrow}>Station</span>
          <input value={form.station} onChange={e => setForm({ ...form, station: e.target.value })} placeholder="Assembly / QC / Packaging…" style={inputStyle} />
        </div>
        <div>
          <span className="eyebrow" style={eyebrow}>Product</span>
          <input value={form.product} onChange={e => setForm({ ...form, product: e.target.value })} style={inputStyle} />
        </div>
        <div />
        <div>
          <span className="eyebrow" style={eyebrow}>Effective from (default = now)</span>
          <input type="datetime-local" className="num" value={form.effective_from} onChange={e => setForm({ ...form, effective_from: e.target.value })} style={inputStyle} />
        </div>
        <div>
          <span className="eyebrow" style={eyebrow}>Effective until (optional)</span>
          <input type="datetime-local" className="num" value={form.effective_until} onChange={e => setForm({ ...form, effective_until: e.target.value })} style={inputStyle} />
        </div>

        <div style={{ gridColumn: '1 / 3', padding: '11px 13px', background: 'var(--warn-bg)', border: '1px solid var(--warn-bd)', borderRadius: 'var(--r-sm)' }}>
          <label style={{ display: 'flex', gap: 9, alignItems: 'center', cursor: 'pointer', color: 'var(--t2)', fontFamily: 'var(--font-ui)', fontSize: 12.5 }}>
            <input type="checkbox" checked={form.reactive} onChange={e => setForm({ ...form, reactive: e.target.checked })} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--warn-fg)', fontWeight: 700 }}>
              <Icon name="alert" size={13} /> Reactive
            </span>
            — this deviation is already in effect on the floor
          </label>
          {form.reactive && (
            <div style={{ marginTop: 7, fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t2)', lineHeight: 1.5 }}>
              {form.severity === 'low' || form.severity === 'medium'
                ? <>Reactive {form.severity} deviation will be created as <strong>approved immediately</strong> but flagged for supervisor retro sign-off. Use only when waiting for approval is not operationally possible.</>
                : <>Reactive flag captured, but {form.severity} severity still requires pre-approval before the deviation can be considered active. Operator should stop deviating until approved.</>}
            </div>
          )}
        </div>

        <div style={{ gridColumn: '1 / 3', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
          padding: '10px 13px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="eyebrow">Approval needed</span>
          <span className="num" style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>{chain.join(' → ')}</span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)' }}>
            {sev?.required_tier}.
            {form.severity === 'medium' && ' Two approvers needed (L1 then L2 second-eye).'}
            {(form.severity === 'high' || form.severity === 'critical') && ' Reactive auto-approval blocked at this severity.'}
          </span>
        </div>
      </div>
    </Modal>
  );
}
