'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState, Panel, Chip, StatusBadge } from '@throttle/ui';

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
  { id: 'low',      label: 'Low',      variant: 'success', desc: 'L1 supervisor approves' },
  { id: 'medium',   label: 'Medium',   variant: 'brand',   desc: 'L1 + L2 (second-eye)' },
  { id: 'high',     label: 'High',     variant: 'warning', desc: 'L3 admin only' },
  { id: 'critical', label: 'Critical', variant: 'error',   desc: 'L3 admin only · reactive blocked' },
];

const th    = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left', fontWeight: 600 };
const td    = { padding: '10px 14px', borderBottom: '1px solid rgba(64,64,64,.5)', fontSize: 13, color: 'var(--t1)', fontFamily: 'var(--mono)', verticalAlign: 'top' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'var(--mono)' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP  = { padding: '8px 14px', background: 'var(--yellow)', color: '#0a0a0a', border: '1px solid var(--yellow)', borderRadius: 3, fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const btnS  = { padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' };

function SeverityBadge({ severity }) {
  const cfg = SEVERITY_OPTIONS.find(s => s.id === severity) || { label: severity, variant: 'neutral' };
  return <StatusBadge variant={cfg.variant}>{cfg.label}</StatusBadge>;
}

function fmtTs(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } }

export default function RedlineProcessDeviationsPage() {
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const canPropose   = hasPermission(perms, 'deviation_propose');
  const canApproveL1 = hasPermission(perms, 'deviation_approve_l1');

  const [active,     setActive]     = useState([]);
  const [pending,    setPending]    = useState([]);
  const [retro,      setRetro]      = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [newOpen,    setNewOpen]    = useState(false);
  const [ackBusy,    setAckBusy]    = useState(null);

  async function loadAll() {
    if (!session) return;
    setLoading(true);
    try {
      const [activeR, pendingR, retroR] = await Promise.all([
        workerFetch('getActiveDeviations', { data: {} }, session),
        workerFetch('getProcessDeviations', { data: { status: 'pending' } }, session),
        workerFetch('getProcessDeviations', { data: { needs_retroactive_signoff: true } }, session),
      ]);
      setActive(activeR?.ok ? (activeR.data || []) : []);
      setPending(pendingR?.ok ? (pendingR.data || []) : []);
      setRetro(retroR?.ok ? (retroR.data || []) : []);
    } finally { setLoading(false); }
  }
  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, [session]);

  const activeByLine = useMemo(() => {
    const map = { L1: [], L2: [], L3: [], D1: [], D2: [], 'All lines': [] };
    active.forEach(a => {
      const k = a.line || 'All lines';
      if (!map[k]) map[k] = [];
      map[k].push(a);
    });
    return map;
  }, [active]);

  async function quickAck(devNo) {
    setAckBusy(devNo);
    try {
      const r = await workerFetch('acknowledgeDeviation', { data: { deviation_no: devNo } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'error'); return; }
      toast(`Acknowledged ${devNo}`, 'success');
      loadAll();
    } finally { setAckBusy(null); }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 16 }}>
      <Panel
        header="Process Deviations · Floor View"
        headerAction={canPropose && <button onClick={() => setNewOpen(true)} style={btnP}>+ Propose Deviation</button>}
      >
          <div style={{ marginBottom: 12, padding: '8px 10px', background: 'var(--surface2)', borderRadius: 3, fontSize: 12, color: 'var(--t2)' }}>
            Active deviations apply <strong>right now</strong>. Operators must follow them.
            Use the Garage <code>/process-deviations</code> page for the full approval queue + history.
          </div>

          {/* ACTIVE BY LINE */}
          <div style={{ marginBottom: 18 }}>
            <h3 style={{ margin: '0 0 8px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, color: 'var(--t2)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Active on Floor · {active.length}</h3>
            {loading ? <Spinner /> : active.length === 0 ? (
              <EmptyState icon="✓" message="No active deviations" />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
                {Object.entries(activeByLine).filter(([_, devs]) => devs.length > 0).map(([line, devs]) => (
                  <div key={line} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--yellow)' }}>{line}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{devs.length} active</span>
                    </div>
                    {devs.map(d => (
                      <div key={d.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6 }}>
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
            )}
          </div>

          {/* PENDING APPROVAL */}
          <div style={{ marginBottom: 18 }}>
            <h3 style={{ margin: '0 0 8px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, color: 'var(--t2)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Pending Approval · {pending.length}</h3>
            {pending.length === 0 ? (
              <div style={{ padding: 14, textAlign: 'center', color: 'var(--t3)', fontSize: 11 }}>None waiting</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>PD No</th><th style={th}>Title</th><th style={th}>Line</th>
                  <th style={th}>Severity</th><th style={th}>Tier</th><th style={th}>Proposed</th>
                </tr></thead>
                <tbody>
                  {pending.map(d => (
                    <tr key={d.id}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{d.deviation_no}</td>
                      <td style={td}>{d.title}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{d.line || '—'}</td>
                      <td style={td}><SeverityBadge severity={d.severity} /></td>
                      <td style={td}>
                        <StatusBadge variant={d.current_tier === 'l3' ? 'error' : d.current_tier === 'l2' ? 'warning' : 'info'}>
                          {d.current_tier.toUpperCase()}
                        </StatusBadge>
                      </td>
                      <td style={{ ...td, color: 'var(--t3)' }}>{fmtTs(d.proposed_at)}<div style={{ color: 'var(--t2)' }}>{d.proposed_by_name}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* RETRO SIGNOFF NEEDED (supervisor handover) */}
          {canApproveL1 && retro.length > 0 && (
            <div style={{ marginBottom: 18, padding: 10, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.3)', borderRadius: 4 }}>
              <h3 style={{ margin: '0 0 8px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--yellow)' }}>⚐ Awaiting Your Sign-Off · {retro.length}</h3>
              <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 8 }}>
                These reactive deviations were applied while you were out. Review each and either confirm or reject the after-the-fact sign-off.
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>PD No</th><th style={th}>Title</th><th style={th}>Severity</th>
                  <th style={th}>Proposed</th><th style={{ ...th, textAlign: 'right' }}>Quick Ack</th>
                </tr></thead>
                <tbody>
                  {retro.map(d => (
                    <tr key={d.id}>
                      <td style={{ ...td, color: 'var(--yellow)' }}>{d.deviation_no} ⚡</td>
                      <td style={td}>{d.title}</td>
                      <td style={td}><SeverityBadge severity={d.severity} /></td>
                      <td style={{ ...td, color: 'var(--t3)' }}>{fmtTs(d.proposed_at)}<div style={{ color: 'var(--t2)' }}>{d.proposed_by_name}</div></td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <button onClick={() => quickAck(d.deviation_no)} disabled={ackBusy === d.deviation_no} style={btnS}>
                          {ackBusy === d.deviation_no ? '…' : '👁 Ack'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>
      </div>

      {newOpen && (
        <NewDeviationModal
          session={session}
          toast={toast}
          onClose={() => setNewOpen(false)}
          onCreated={() => { setNewOpen(false); loadAll(); }}
        />
      )}
    </div>
  );
}

// Floor-friendly propose modal — only the most important fields
function NewDeviationModal({ session, toast, onClose, onCreated }) {
  const [form, setForm] = useState({
    type: 'material_substitution', severity: 'low',
    line: 'L1', station: '', title: '', description: '', reason: '',
    effective_until: '', reactive: false,
  });
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!form.title.trim() || form.title.length < 3) { toast('Title required (min 3 chars)', 'error'); return; }
    if (!form.description.trim() || form.description.length < 10) { toast('Description required (min 10 chars)', 'error'); return; }
    setSubmitting(true);
    try {
      const r = await workerFetch('proposeDeviation', {
        data: {
          type:       form.type,
          severity:   form.severity,
          line:       form.line || null,
          station:    form.station || null,
          title:      form.title.trim(),
          description: form.description.trim(),
          reason:     form.reason.trim() || null,
          effective_until: form.effective_until || null,
          reactive:   form.reactive,
        },
      }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Failed', 'error'); return; }
      toast(`${r.data.deviation_no} · ${r.data.status}`, 'success');
      onCreated();
    } finally { setSubmitting(false); }
  }

  const sev = SEVERITY_OPTIONS.find(s => s.id === form.severity);

  return (
    <Modal open onClose={onClose} size="md" title="Propose deviation"
           confirmLabel={submitting ? 'CREATING…' : 'PROPOSE'} onConfirm={submit} loading={submitting}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={lbl}>Type</label>
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ ...input, width: '100%' }}>
            {TYPE_OPTIONS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Severity</label>
          <select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })} style={{ ...input, width: '100%' }}>
            {SEVERITY_OPTIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>{sev?.desc}</div>
        </div>
        <div>
          <label style={lbl}>Line</label>
          <select value={form.line} onChange={e => setForm({ ...form, line: e.target.value })} style={{ ...input, width: '100%' }}>
            <option value="">— all lines —</option>
            {['L1','L2','L3','D1','D2'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Station</label>
          <input value={form.station} onChange={e => setForm({ ...form, station: e.target.value })} placeholder="Assembly / QC / Pkg" style={{ ...input, width: '100%' }} />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={lbl}>Title <span style={{ color: '#ff7070' }}>*</span></label>
          <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="short summary" style={{ ...input, width: '100%' }} autoFocus />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={lbl}>Description <span style={{ color: '#ff7070' }}>*</span></label>
          <textarea rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="what's being done differently" style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={lbl}>Reason</label>
          <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="why the deviation is needed" style={{ ...input, width: '100%' }} />
        </div>
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={lbl}>Effective until (optional)</label>
          <input type="datetime-local" value={form.effective_until} onChange={e => setForm({ ...form, effective_until: e.target.value })} style={{ ...input, width: '100%' }} />
        </div>
        <div style={{ gridColumn: '1 / 3', padding: 10, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.2)', borderRadius: 3 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', color: 'var(--t2)', fontSize: 12 }}>
            <input type="checkbox" checked={form.reactive} onChange={e => setForm({ ...form, reactive: e.target.checked })} />
            <strong style={{ color: '#fbbf24' }}>⚡ Reactive</strong> — already in effect, log after the fact
          </label>
          {form.reactive && (form.severity === 'high' || form.severity === 'critical') && (
            <div style={{ marginTop: 6, fontSize: 11, color: '#ff7070' }}>
              ⚠ {form.severity} severity blocks reactive auto-approval. Must wait for L3 sign-off.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
