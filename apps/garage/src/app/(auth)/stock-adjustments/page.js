'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch, garageFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState, Combobox } from '@throttle/ui';

const STATUS_TABS = [
  { id: 'pending_l1', label: 'Pending L1',  tone: 'yellow' },
  { id: 'pending_l2', label: 'Pending L2',  tone: 'orange' },
  { id: 'approved',   label: 'Approved',    tone: 'blue'   },
  { id: 'rejected',   label: 'Rejected',    tone: 'red'    },
  { id: 'cancelled',  label: 'Cancelled',   tone: 'gray'   },
  { id: 'all',        label: 'All',         tone: 'gray'   },
];
const TONE = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.25)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)'    },
};
const REASON_CODES = [
  { id: 'cycle_count_variance',        label: 'Cycle count variance' },
  { id: 'physical_recount_correction', label: 'Physical recount correction' },
  { id: 'damage_in_storage',           label: 'Damage in storage' },
  { id: 'pilferage_or_loss',           label: 'Pilferage / unexplained loss' },
  { id: 'system_error',                label: 'System / data entry error' },
  { id: 'unit_of_measure_error',       label: 'Unit-of-measure error' },
  { id: 'unrecorded_consumption',      label: 'Unrecorded consumption' },
  { id: 'unrecorded_return',           label: 'Unrecorded return' },
  { id: 'obsolete_writeoff',           label: 'Obsolete write-off' },
  { id: 'found_stock',                 label: 'Found stock (orphan)' },
  { id: 'transfer_error',              label: 'Transfer / location error' },
  { id: 'vendor_short_ship',           label: 'Vendor short-ship (post-receipt)' },
  { id: 'unit_lost',                   label: 'Unit lost (dispatch)' },
  { id: 'unit_found',                  label: 'Unit found (dispatch)' },
  { id: 'other',                       label: 'Other (requires explanation)' },
];

const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody = { padding: '12px 14px' };
const th    = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP  = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnG  = { background: 'rgba(34,197,94,.15)', border: '1px solid #4ade80', color: '#4ade80', borderRadius: 3, padding: '8px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnR  = { background: 'rgba(222,42,42,.15)', border: '1px solid #ff7070', color: '#ff7070', borderRadius: 3, padding: '8px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };

function StatusBadge({ status }) {
  const tab = STATUS_TABS.find(t => t.id === status) || { label: status, tone: 'gray' };
  const s = TONE[tab.tone];
  return <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', background: s.bg, color: s.fg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>{tab.label}</span>;
}
function fmtTs(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } }
function fmtNum(n) { if (n == null) return '—'; return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

export default function StockAdjustmentsPage() {
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const canRecord     = hasPermission(perms, 'cycle_count_record');
  const canApproveL1  = hasPermission(perms, 'cycle_count_approve_l1');
  const canApproveL2  = hasPermission(perms, 'cycle_count_approve_l2');

  const [tab,      setTab]      = useState('pending_l1');
  const [rows,     setRows]     = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [detailAdj, setDetailAdj] = useState(null); // adj_no string
  const [detail,    setDetail]    = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  async function loadList() {
    if (!session) return;
    setLoading(true);
    try {
      const f = tab === 'all' ? { posted: false } : { approval_status: tab };
      const r = await workerFetch('getStockAdjustments', { data: f }, session);
      setRows(r?.ok ? (r.data || []) : []);
    } finally { setLoading(false); }
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [tab, session]);

  async function openDetail(adj_no) {
    setDetailAdj(adj_no);
    setDetail(null);
    setDetailLoading(true);
    try {
      const r = await workerFetch('getStockAdjustment', { data: { adj_no } }, session);
      setDetail(r?.ok ? r.data : null);
    } finally { setDetailLoading(false); }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <span>Stock Adjustments</span>
          {canRecord && <button onClick={() => setNewOpen(true)} style={btnP}>+ MANUAL ADJUSTMENT</button>}
        </div>
        <div style={pbody}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {STATUS_TABS.map(t => {
              const active = tab === t.id;
              const s = TONE[t.tone];
              return <button key={t.id} onClick={() => setTab(t.id)} style={{
                background: active ? s.bg : 'transparent', border: `1px solid ${active ? s.border : 'var(--border)'}`,
                color: active ? s.fg : 'var(--t2)', borderRadius: 3, padding: '5px 12px', fontSize: 11,
                cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.05em', textTransform: 'uppercase',
                fontWeight: active ? 700 : 400,
              }}>{t.label}</button>;
            })}
          </div>
          {loading ? <Spinner /> : rows.length === 0 ? (
            <EmptyState title="No adjustments" message={`No ${STATUS_TABS.find(t => t.id === tab)?.label.toLowerCase()} adjustments.`} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>ADJ No</th>
                    <th style={th}>Type</th>
                    <th style={th}>Part / Unit</th>
                    <th style={{ ...th, textAlign: 'right' }}>Before → After</th>
                    <th style={{ ...th, textAlign: 'right' }}>Δ</th>
                    <th style={{ ...th, textAlign: 'right' }}>Value (₹)</th>
                    <th style={th}>Reason</th>
                    <th style={th}>Source</th>
                    <th style={th}>Tier</th>
                    <th style={th}>Status</th>
                    <th style={th}>Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(r.adj_no)}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.adj_no}{r.posted && <span style={{ marginLeft: 6, color: '#4ade80' }}>✓</span>}</td>
                      <td style={{ ...td, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{r.adj_type}</td>
                      <td style={td}>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r.part_code || r.unit_upc}</div>
                        <div style={{ fontSize: 10, color: 'var(--t3)' }}>{r.part_name}{r.product ? ` · ${r.product}` : ''}</div>
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>
                        <span style={{ color: 'var(--t3)' }}>{fmtNum(r.before_qty)}</span>
                        <span style={{ color: 'var(--t3)', margin: '0 4px' }}>→</span>
                        <span style={{ color: 'var(--t1)', fontWeight: 700 }}>{fmtNum(r.after_qty)}</span>
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700, color: parseFloat(r.delta) > 0 ? '#4ade80' : '#ff7070' }}>
                        {parseFloat(r.delta) > 0 ? '+' : ''}{fmtNum(r.delta)}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{r.delta_value ? fmtNum(r.delta_value) : '—'}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t2)' }}>{r.reason_code.replace(/_/g, ' ')}</td>
                      <td style={{ ...td, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{r.source}{r.source_ref ? <div>{r.source_ref}</div> : null}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: r.required_tier === 'l2' ? '#ff7070' : r.required_tier === 'l1' ? '#fbbf24' : '#4ade80' }}>{r.required_tier.toUpperCase()}</td>
                      <td style={td}><StatusBadge status={r.approval_status} /></td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                        {fmtTs(r.requested_at)}
                        {r.requested_by_name && <div style={{ color: 'var(--t2)' }}>{r.requested_by_name}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {detailAdj && (
        <AdjustmentDetailModal
          adjNo={detailAdj}
          detail={detail}
          loading={detailLoading}
          session={session}
          toast={toast}
          canApproveL1={canApproveL1}
          canApproveL2={canApproveL2}
          onClose={() => { setDetailAdj(null); setDetail(null); }}
          onReload={() => { openDetail(detailAdj); loadList(); }}
        />
      )}

      {newOpen && (
        <NewAdjustmentModal
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
function AdjustmentDetailModal({ adjNo, detail, loading, session, toast, canApproveL1, canApproveL2, onClose, onReload }) {
  const [action, setAction] = useState(null); // 'approve' | 'reject' | 'post' | 'reverse'
  const [reason, setReason] = useState('');
  const [acting, setActing] = useState(false);

  async function doAction() {
    if (!action || !detail) return;
    if ((action === 'reject' || action === 'reverse') && !reason.trim()) { toast('Reason required', 'err'); return; }
    setActing(true);
    try {
      let r;
      if (action === 'approve' || action === 'reject') {
        r = await workerFetch('approveStockAdjustment', { data: { adj_no: adjNo, action, reason: reason.trim() } }, session);
      } else if (action === 'post') {
        r = await workerFetch('postStockAdjustment', { data: { adj_no: adjNo } }, session);
      } else if (action === 'reverse') {
        r = await workerFetch('reverseStockAdjustment', { data: { adj_no: adjNo, reason: reason.trim() } }, session);
      }
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'err'); return; }
      toast(`${action.toUpperCase()} · ${adjNo}${r.data?.adj_no && r.data.adj_no !== adjNo ? ` → ${r.data.adj_no}` : ''}`, 'ok');
      setAction(null);
      setReason('');
      onReload();
    } finally { setActing(false); }
  }

  return (
    <Modal open onClose={onClose} size="lg" title={`Adjustment · ${adjNo}`}>
      {loading || !detail ? <Spinner /> : (
        <>
          <div style={{ marginBottom: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
            <KV label="Status" value={<StatusBadge status={detail.approval_status} />} />
            <KV label="Required Tier" value={<span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: detail.required_tier === 'l2' ? '#ff7070' : detail.required_tier === 'l1' ? '#fbbf24' : '#4ade80' }}>{detail.required_tier.toUpperCase()}</span>} />
            <KV label="Type" value={detail.adj_type} />
            <KV label="Source" value={`${detail.source}${detail.source_ref ? ` · ${detail.source_ref}` : ''}`} />
            <KV label="Part / Unit" value={<span style={{ fontFamily: 'var(--mono)' }}>{detail.part_code || detail.unit_upc}</span>} />
            <KV label="Name" value={detail.part_name} />
            <KV label="Before → After" value={<span style={{ fontFamily: 'var(--mono)' }}><span style={{ color: 'var(--t3)' }}>{fmtNum(detail.before_qty)}</span> → <span style={{ color: 'var(--t1)', fontWeight: 700 }}>{fmtNum(detail.after_qty)}</span></span>} />
            <KV label="Δ Qty (value)" value={<span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: parseFloat(detail.delta) > 0 ? '#4ade80' : '#ff7070' }}>{parseFloat(detail.delta) > 0 ? '+' : ''}{fmtNum(detail.delta)} ({fmtNum(detail.delta_value)})</span>} />
            <KV label="Reason Code" value={detail.reason_code.replace(/_/g, ' ')} />
            <KV label="Reason Text" value={detail.reason_text || '—'} />
            <KV label="Requested" value={`${fmtTs(detail.requested_at)} · ${detail.requested_by_name || '—'}`} />
            <KV label="L1 Approval" value={detail.approved_l1_at ? `${fmtTs(detail.approved_l1_at)} · ${detail.approver_l1_name || '—'}` : '—'} />
            <KV label="L2 Approval" value={detail.approved_l2_at ? `${fmtTs(detail.approved_l2_at)} · ${detail.approver_l2_name || '—'}` : '—'} />
            <KV label="Posted" value={detail.posted ? `✓ ${fmtTs(detail.posted_at)} · ${detail.posted_by_name || '—'}` : 'No'} />
            {detail.rejected_at && <KV label="Rejected" value={`${fmtTs(detail.rejected_at)} · ${detail.rejected_by_name || '—'} · ${detail.reject_reason || ''}`} />}
            {detail.reverses_adjustment_id && <KV label="Reverses" value={`Adjustment id ${detail.reverses_adjustment_id}`} />}
            {detail.reversed_by_adjustment_id && <KV label="Reversed by" value={`Adjustment id ${detail.reversed_by_adjustment_id}`} />}
          </div>

          {action ? (
            <div style={{ padding: 10, background: 'var(--surface2)', borderRadius: 3, marginBottom: 10 }}>
              <label style={lbl}>{action === 'reject' ? 'Rejection reason' : action === 'reverse' ? 'Reversal reason' : 'Notes (optional)'}{(action === 'reject' || action === 'reverse') && <span style={{ color: '#ff7070' }}> *</span>}</label>
              <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
                <button onClick={() => { setAction(null); setReason(''); }} style={btnS} disabled={acting}>CANCEL</button>
                <button onClick={doAction} disabled={acting} style={action === 'reject' || action === 'reverse' ? btnR : btnG}>{acting ? 'WORKING…' : `CONFIRM ${action.toUpperCase()}`}</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {(detail.approval_status === 'pending_l1' || detail.approval_status === 'pending_l2') && (
                <>
                  {((detail.approval_status === 'pending_l1' && canApproveL1) || (detail.approval_status === 'pending_l2' && canApproveL2)) && (
                    <>
                      <button onClick={() => setAction('approve')} style={btnG}>✓ APPROVE</button>
                      <button onClick={() => setAction('reject')} style={btnR}>✗ REJECT</button>
                    </>
                  )}
                </>
              )}
              {detail.approval_status === 'approved' && !detail.posted && (canApproveL1 || canApproveL2) && (
                <button onClick={() => { setAction('post'); doAction(); }} disabled={acting} style={btnP}>{acting ? 'POSTING…' : '⮕ POST TO LEDGER'}</button>
              )}
              {detail.posted && !detail.reversed_by_adjustment_id && canApproveL1 && (
                <button onClick={() => setAction('reverse')} style={{ ...btnS, color: '#fbbf24', borderColor: 'rgba(245,158,11,.3)' }}>⤺ REVERSE</button>
              )}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 6 }}>HISTORY</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>When</th>
                  <th style={th}>Action</th>
                  <th style={th}>From → To</th>
                  <th style={th}>By</th>
                  <th style={th}>Reason</th>
                </tr>
              </thead>
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
        </>
      )}
    </Modal>
  );
}

function KV({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <div style={{ color: 'var(--t1)', fontSize: 12 }}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function NewAdjustmentModal({ session, toast, onClose, onCreated }) {
  const [partsCat, setPartsCat] = useState([]);
  const [form, setForm] = useState({
    adj_type: 'parts', part_code: '', unit_upc: '', after_qty: '',
    reason_code: 'physical_recount_correction', reason_text: '', notes: '',
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    garageFetch('getProcurementParts', {}, session).then(d => setPartsCat(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  const partOpts = useMemo(() => partsCat.map(p => ({ value: p.part_code, label: `${p.part_code}${p.part_name ? ' — ' + p.part_name : ''}` })), [partsCat]);

  async function submit() {
    if (form.adj_type === 'parts' && !form.part_code) { toast('Pick a part', 'err'); return; }
    if (form.adj_type === 'unit'  && !form.unit_upc)  { toast('Enter unit UPC', 'err'); return; }
    if (form.after_qty === '')                         { toast('after_qty required', 'err'); return; }
    if (form.reason_code === 'other' && !form.reason_text.trim()) { toast('Explanation required when reason=Other', 'err'); return; }
    setSubmitting(true);
    try {
      const r = await workerFetch('requestStockAdjustment', {
        data: {
          adj_type:   form.adj_type,
          part_code:  form.adj_type === 'parts' ? form.part_code : undefined,
          unit_upc:   form.adj_type === 'unit'  ? form.unit_upc.trim()  : undefined,
          after_qty:  Number(form.after_qty),
          reason_code: form.reason_code,
          reason_text: form.reason_text.trim() || null,
          notes:       form.notes.trim() || null,
        },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'err'); return; }
      toast(`Created ${r.data.adj_no} · tier=${r.data.required_tier.toUpperCase()} · status=${r.data.approval_status}`, 'ok');
      onCreated();
    } finally { setSubmitting(false); }
  }

  return (
    <Modal open onClose={onClose} size="md" title="Request manual stock adjustment"
           confirmLabel={submitting ? 'CREATING…' : 'REQUEST'}
           onConfirm={submit} loading={submitting}>
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Type</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {['parts','unit'].map(t => (
            <button key={t} onClick={() => setForm({ ...form, adj_type: t })} style={{
              ...btnS,
              background: form.adj_type === t ? 'rgba(33,60,226,.15)' : 'transparent',
              color: form.adj_type === t ? '#7b93ff' : 'var(--t2)',
              border: `1px solid ${form.adj_type === t ? '#7b93ff' : 'var(--border)'}`,
            }}>{t.toUpperCase()}</button>
          ))}
        </div>
      </div>
      {form.adj_type === 'parts' ? (
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Part</label>
          <Combobox value={form.part_code} onChange={(v) => setForm({ ...form, part_code: v })} options={partOpts} placeholder="Type part code or name…" />
        </div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Unit UPC</label>
          <input value={form.unit_upc} onChange={e => setForm({ ...form, unit_upc: e.target.value })} placeholder="LOT-XXXXXXXX" style={{ ...input, width: '100%', fontFamily: 'var(--mono)' }} />
        </div>
      )}
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Target qty (after)</label>
        <input type="number" min={0} step="any" value={form.after_qty} onChange={e => setForm({ ...form, after_qty: e.target.value })} style={{ ...input, width: 160 }} />
        {form.adj_type === 'unit' && <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--t3)' }}>0 = lost, 1 = found</span>}
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Reason code</label>
        <select value={form.reason_code} onChange={e => setForm({ ...form, reason_code: e.target.value })} style={{ ...input, width: '100%' }}>
          {REASON_CODES.map(rc => <option key={rc.id} value={rc.id}>{rc.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={lbl}>Explanation {form.reason_code === 'other' && <span style={{ color: '#ff7070' }}>*</span>}</label>
        <textarea rows={2} value={form.reason_text} onChange={e => setForm({ ...form, reason_text: e.target.value })} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} placeholder="What happened? Visible on the adjustment record." />
      </div>
    </Modal>
  );
}
