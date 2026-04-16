'use client';
import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { supabase } from '@/lib/supabase';
import {
  STAGES, PRIORITIES, DELIVERABLE_TYPES,
  getStageConfig, getPriorityConfig, getValidTransitions
} from '@/lib/taskConfig';

export default function TaskSidePanel({ task, onClose, onUpdate }) {
  const { session, brandUser } = useAuth();
  const [teamMembers, setTeamMembers] = useState([]);
  const [assignees, setAssignees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [movingStage, setMovingStage] = useState(false);
  const [targetStage, setTargetStage] = useState(null);
  const [blockedReason, setBlockedReason] = useState('');
  const [editingPriority, setEditingPriority] = useState(false);
  const [abandonReason, setAbandonReason] = useState('');
  const [showAbandon, setShowAbandon] = useState(false);
  const [activity, setActivity] = useState([]);

  const isAdminLead = ['admin', 'lead'].includes(brandUser?.role);
  const validTransitions = getValidTransitions(task.stage, brandUser?.role);
  const stageConfig = getStageConfig(task.stage);
  const priorityConfig = getPriorityConfig(task.priority);

  useEffect(() => {
    loadAssignees();
    loadActivity();
    if (isAdminLead) loadTeamMembers();
  }, [task.id]);

  async function loadActivity() {
    try {
      const data = await workerFetch('getTaskActivity', { taskId: task.id }, session?.access_token);
      setActivity(data.activity || []);
    } catch (e) {
      console.error('Failed to load activity:', e);
    }
  }

  async function loadAssignees() {
    const { data } = await supabase
      .from('task_assignees')
      .select('user_id, users(id, name, discipline)')
      .eq('task_id', task.id);
    setAssignees(data?.map(a => a.users).filter(Boolean) || []);
  }

  async function loadTeamMembers() {
    const { data } = await supabase
      .from('users')
      .select('id, name, discipline, role')
      .in('role', ['member', 'lead']);
    setTeamMembers(data || []);
  }

  async function moveStage() {
    if (!targetStage) return;
    const needsReason = targetStage === 'ext_blocked' || targetStage === 'abandoned';
    if (needsReason && !blockedReason.trim()) {
      setError('A reason is required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await workerFetch('updateTaskStage', {
        task_id: task.id,
        stage: targetStage,
        blocked_reason: blockedReason || undefined,
      }, session?.access_token);
      onUpdate({ ...task, stage: targetStage, blocked_reason: blockedReason || null });
      setMovingStage(false);
      setTargetStage(null);
      setBlockedReason('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function changePriority(priority) {
    setLoading(true);
    setError(null);
    try {
      await workerFetch('updateTaskPriority', { task_id: task.id, priority }, session?.access_token);
      onUpdate({ ...task, priority });
      setEditingPriority(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function toggleAssignee(userId) {
    const isAssigned = assignees.some(a => a.id === userId);
    const newIds = isAssigned
      ? assignees.filter(a => a.id !== userId).map(a => a.id)
      : [...assignees.map(a => a.id), userId];
    setLoading(true);
    setError(null);
    try {
      await workerFetch('assignTask', { task_id: task.id, user_ids: newIds }, session?.access_token);
      await loadAssignees();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function abandonTask() {
    if (!abandonReason.trim()) { setError('A reason is required'); return; }
    setLoading(true);
    setError(null);
    try {
      await workerFetch('abandonTask', { task_id: task.id, reason: abandonReason }, session?.access_token);
      onUpdate({ ...task, stage: 'abandoned' });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    width: '100%',
    background: 'var(--s2)',
    border: '1px solid var(--b2)',
    borderRadius: 6,
    padding: '8px 12px',
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    fontSize: 12,
    outline: 'none',
    resize: 'none',
    height: 80,
  };

  const pillStyle = (active) => ({
    fontFamily: 'var(--mono)',
    fontSize: 11,
    padding: '5px 12px',
    borderRadius: 20,
    border: active ? '1px solid #F2CD1A' : '1px solid var(--b2)',
    background: active ? 'rgba(242,205,26,0.12)' : 'transparent',
    color: active ? '#F2CD1A' : 'var(--t2)',
    cursor: 'pointer',
    transition: 'all .15s',
  });

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 40 }}
        onClick={onClose}
      />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, height: '100%', width: '100%', maxWidth: 480,
        background: 'var(--s1)', borderLeft: '1px solid var(--b1)', zIndex: 50, overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          padding: 20, borderBottom: '1px solid var(--b1)', position: 'sticky', top: 0, background: 'var(--s1)', zIndex: 1,
        }}>
          <div style={{ flex: 1, minWidth: 0, paddingRight: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: stageConfig.color, flexShrink: 0 }} />
              <span style={{ fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--t3)' }}>{stageConfig.label}</span>
              {task.is_spillover && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, background: 'rgba(245,158,11,0.12)', color: 'var(--amber)', border: '1px solid rgba(245,158,11,0.3)', padding: '2px 6px', borderRadius: 3 }}>
                  Spillover
                </span>
              )}
            </div>
            <h2 style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>{task.title}</h2>
            {task.product_code && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>Product: {task.product_code}</p>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ color: 'var(--t3)', background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', padding: '4px 8px', borderRadius: 4, transition: 'background .15s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--s3)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 24 }}>

          {/* Error */}
          {error && (
            <div style={{ background: 'rgba(222,42,42,0.08)', border: '1px solid rgba(222,42,42,0.3)', borderRadius: 6, padding: '10px 14px' }}>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)' }}>{error}</p>
            </div>
          )}

          {/* Stage */}
          <Section title="Stage">
            {!movingStage ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: stageConfig.color }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)' }}>{stageConfig.label}</span>
                </div>
                {validTransitions.length > 0 && (
                  <button onClick={() => setMovingStage(true)} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Move →
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {validTransitions.map(s => {
                    const sc = getStageConfig(s);
                    return (
                      <button key={s} onClick={() => setTargetStage(s)} style={pillStyle(targetStage === s)}>
                        {sc.label}
                      </button>
                    );
                  })}
                </div>
                {(targetStage === 'ext_blocked' || targetStage === 'abandoned') && (
                  <textarea
                    value={blockedReason}
                    onChange={e => setBlockedReason(e.target.value)}
                    placeholder={targetStage === 'abandoned' ? 'Why is this task being abandoned?' : 'What is blocking this task externally?'}
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = '#F2CD1A'}
                    onBlur={e => e.target.style.borderColor = 'var(--b2)'}
                  />
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={moveStage}
                    disabled={!targetStage || loading}
                    style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 6, padding: '8px 16px', fontFamily: 'var(--head)', fontWeight: 700, fontSize: 10, letterSpacing: '.15em', textTransform: 'uppercase', cursor: 'pointer', opacity: (!targetStage || loading) ? 0.4 : 1 }}
                  >
                    {loading ? 'Moving...' : 'Confirm Move'}
                  </button>
                  <button onClick={() => { setMovingStage(false); setTargetStage(null); setBlockedReason(''); }} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </Section>

          {/* Priority */}
          <Section title="Priority">
            {!editingPriority ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: priorityConfig.color }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)' }}>{priorityConfig.label}</span>
                </div>
                {isAdminLead && (
                  <button onClick={() => setEditingPriority(true)} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Edit
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {PRIORITIES.map(p => (
                  <button key={p.value} onClick={() => changePriority(p.value)} disabled={loading} style={pillStyle(task.priority === p.value)}>
                    {p.label}
                  </button>
                ))}
                <button onClick={() => setEditingPriority(false)} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            )}
          </Section>

          {/* Assignees */}
          <Section title="Assignees">
            {assignees.length === 0 ? (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>Unassigned</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {assignees.map(a => (
                  <span key={a.id} style={{ fontFamily: 'var(--mono)', fontSize: 11, background: 'var(--s3)', color: 'var(--t2)', padding: '4px 8px', borderRadius: 4 }}>
                    {a.name}
                    {a.discipline && <span style={{ color: 'var(--t3)', marginLeft: 4 }}>· {a.discipline}</span>}
                  </span>
                ))}
              </div>
            )}
            {isAdminLead && teamMembers.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginBottom: 8 }}>Click to assign / unassign</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {teamMembers.map(m => {
                    const assigned = assignees.some(a => a.id === m.id);
                    return (
                      <button key={m.id} onClick={() => toggleAssignee(m.id)} disabled={loading} style={pillStyle(assigned)}>
                        {assigned && <span style={{ color: 'var(--green)', marginRight: 4 }}>✓</span>}
                        {m.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Section>

          {/* Details */}
          <Section title="Details">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <DetailRow label="Type" value={task.type?.replace(/_/g, ' ')} />
              <DetailRow label="Deliverable" value={DELIVERABLE_TYPES.find(d => d.value === task.deliverable_type)?.label || task.deliverable_type} />
              {task.due_date && <DetailRow label="Due" value={new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} />}
              {task.sprint_id && <DetailRow label="Sprint" value={task.sprint_id.slice(0, 8) + '...'} />}
              {task.spillover_count > 0 && <DetailRow label="Spillovers" value={String(task.spillover_count)} />}
            </div>
          </Section>

          {/* Notes */}
          {task.notes && (
            <Section title="Notes">
              <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', whiteSpace: 'pre-wrap' }}>{task.notes}</p>
            </Section>
          )}

          {/* Attachments */}
          <AttachmentsSection taskId={task.id} />

          {/* Blocked reason */}
          {task.blocked_reason && task.stage === 'ext_blocked' && (
            <Section title="External Blocker">
              <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--amber)' }}>{task.blocked_reason}</p>
            </Section>
          )}

          {/* Submit for Review */}
          {!['done', 'abandoned', 'in_review', 'approved'].includes(task.stage) &&
            assignees.some(a => a.id === brandUser?.id) && (
            <SubmitForReviewSection task={task} session={session} onUpdate={onUpdate} onError={setError} />
          )}

          {/* Work Approval */}
          {isAdminLead && task.stage === 'in_review' && (
            <WorkApprovalSection task={task} session={session} onUpdate={onUpdate} onClose={onClose} onError={setError} />
          )}

          {/* Abandon */}
          {isAdminLead && !['done', 'abandoned'].includes(task.stage) && (
            <Section title="Danger Zone">
              {!showAbandon ? (
                <button
                  onClick={() => setShowAbandon(true)}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  Abandon task
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <textarea
                    value={abandonReason}
                    onChange={e => setAbandonReason(e.target.value)}
                    placeholder="Why is this task being abandoned?"
                    style={{ ...inputStyle, borderColor: 'rgba(222,42,42,0.3)' }}
                    onFocus={e => e.target.style.borderColor = 'var(--red)'}
                    onBlur={e => e.target.style.borderColor = 'rgba(222,42,42,0.3)'}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={abandonTask}
                      disabled={loading}
                      style={{ background: 'rgba(222,42,42,0.15)', color: 'var(--red)', border: '1px solid rgba(222,42,42,0.3)', borderRadius: 6, padding: '8px 16px', fontFamily: 'var(--head)', fontWeight: 700, fontSize: 10, letterSpacing: '.15em', textTransform: 'uppercase', cursor: 'pointer', opacity: loading ? 0.4 : 1 }}
                    >
                      {loading ? 'Abandoning...' : 'Confirm Abandon'}
                    </button>
                    <button onClick={() => { setShowAbandon(false); setAbandonReason(''); }} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Section>
          )}

          {/* Activity Feed */}
          <ActivityFeed
            activity={activity}
            taskId={task.id}
            session={session}
            onAddComment={loadActivity}
          />
        </div>
      </div>
    </>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <p style={{ fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.25em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 10, fontWeight: 700 }}>{title}</p>
      {children}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', width: 80, flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', textTransform: 'capitalize' }}>{value}</span>
    </div>
  );
}

function SubmitForReviewSection({ task, session, onUpdate, onError }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const inputStyle = {
    width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6,
    padding: '8px 12px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, outline: 'none',
  };

  async function submit() {
    if (!url.trim()) { onError('A deliverable URL is required'); return; }
    setSubmitting(true);
    try {
      await workerFetch('submitForReview', {
        task_id: task.id, attachment_url: url.trim(), attachment_label: label.trim() || 'Deliverable',
      }, session?.access_token);
      onUpdate({ ...task, stage: 'in_review' });
      setOpen(false);
    } catch (e) { onError(e.message); } finally { setSubmitting(false); }
  }

  return (
    <Section title="Submit for Review">
      {!open ? (
        <button onClick={() => setOpen(true)} style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 6, padding: '9px 20px', fontFamily: 'var(--head)', fontWeight: 700, fontSize: 10, letterSpacing: '.15em', textTransform: 'uppercase', cursor: 'pointer' }}>
          Submit Work for Review →
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>Deliverable URL *</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://drive.google.com/..." style={inputStyle} onFocus={e => e.target.style.borderColor = '#F2CD1A'} onBlur={e => e.target.style.borderColor = 'var(--b2)'} />
          </div>
          <div>
            <label style={{ display: 'block', fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>Label (optional)</label>
            <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Final designs, Video edit v2" style={inputStyle} onFocus={e => e.target.style.borderColor = '#F2CD1A'} onBlur={e => e.target.style.borderColor = 'var(--b2)'} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={submit} disabled={submitting} style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 6, padding: '8px 16px', fontFamily: 'var(--head)', fontWeight: 700, fontSize: 10, letterSpacing: '.15em', textTransform: 'uppercase', cursor: 'pointer', opacity: submitting ? 0.4 : 1 }}>
              {submitting ? 'Submitting...' : 'Submit for Review'}
            </button>
            <button onClick={() => setOpen(false)} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
    </Section>
  );
}

function WorkApprovalSection({ task, session, onUpdate, onClose, onError }) {
  const [decision, setDecision] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (decision === 'reject' && !feedback.trim()) { onError('Feedback is required when rejecting work'); return; }
    setSubmitting(true);
    try {
      const action = decision === 'approve' ? 'approveWork' : 'rejectWork';
      await workerFetch(action, { task_id: task.id, feedback: feedback.trim() || undefined }, session?.access_token);
      if (decision === 'approve') { onUpdate({ ...task, stage: 'done' }); onClose(); }
      else { onUpdate({ ...task, stage: 'in_progress' }); setDecision(null); setFeedback(''); }
    } catch (e) { onError(e.message); } finally { setSubmitting(false); }
  }

  return (
    <Section title="Review Submitted Work">
      <div style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', borderRadius: 6, padding: 12, marginBottom: 12 }}>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#22d3ee' }}>⏳ Work has been submitted for your review</p>
      </div>
      {!decision ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setDecision('approve')} style={{ flex: 1, padding: '8px 0', fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', borderRadius: 6, border: '1px solid rgba(34,197,94,0.4)', color: 'var(--green)', background: 'transparent', cursor: 'pointer' }}>
            Approve
          </button>
          <button onClick={() => setDecision('reject')} style={{ flex: 1, padding: '8px 0', fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', borderRadius: 6, border: '1px solid rgba(222,42,42,0.4)', color: 'var(--red)', background: 'transparent', cursor: 'pointer' }}>
            Request Revision
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            placeholder={decision === 'approve' ? 'Optional note for the team member...' : 'What needs to be revised? (required)'}
            style={{ width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6, padding: '8px 12px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, outline: 'none', resize: 'none', height: 80 }}
            onFocus={e => e.target.style.borderColor = '#F2CD1A'}
            onBlur={e => e.target.style.borderColor = 'var(--b2)'}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={submit} disabled={submitting} style={{
              flex: 1, padding: '8px 0', fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', borderRadius: 6, cursor: 'pointer', opacity: submitting ? 0.4 : 1, border: 'none',
              background: decision === 'approve' ? 'rgba(34,197,94,0.15)' : 'rgba(222,42,42,0.15)',
              color: decision === 'approve' ? 'var(--green)' : 'var(--red)',
            }}>
              {submitting ? 'Submitting...' : decision === 'approve' ? 'Confirm Approval' : 'Send for Revision'}
            </button>
            <button onClick={() => { setDecision(null); setFeedback(''); }} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 12px' }}>
              Back
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

function AttachmentsSection({ taskId }) {
  const [attachments, setAttachments] = useState([]);

  useEffect(() => {
    supabase
      .from('task_attachments')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
      .then(({ data }) => setAttachments(data || []));
  }, [taskId]);

  if (attachments.length === 0) return null;

  return (
    <Section title="Attachments">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {attachments.map(a => (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', textDecoration: 'none', transition: 'color .15s' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t2)'}
          >
            <span style={{ color: 'var(--t3)' }}>🔗</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label || a.url}</span>
          </a>
        ))}
      </div>
    </Section>
  );
}

// ── Activity Feed ────────────────────────────────────────────────────────────

function ActivityFeed({ activity, taskId, session, onAddComment }) {
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await workerFetch('addComment', { taskId, comment: comment.trim() }, session?.access_token);
      setComment('');
      onAddComment();
    } catch (e) {
      console.error('Failed to add comment:', e);
    }
    setSubmitting(false);
  };

  return (
    <div style={{ marginTop: 24, borderTop: '1px solid var(--b1)', paddingTop: 20 }}>
      <div style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: '.25em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 16, fontWeight: 700 }}>
        Activity
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {activity.length === 0 && (
          <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 16 }}>No activity yet.</p>
        )}
        {activity.map((entry, i) => (
          <ActivityEntry key={entry.id} entry={entry} isLast={i === activity.length - 1} />
        ))}
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
          placeholder="Add a comment..."
          rows={2}
          style={{
            background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6,
            padding: '8px 12px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
            resize: 'vertical', outline: 'none', width: '100%',
          }}
          onFocus={e => e.target.style.borderColor = '#F2CD1A'}
          onBlur={e => e.target.style.borderColor = 'var(--b2)'}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>Cmd+Enter to submit</span>
          <button
            onClick={handleSubmit}
            disabled={submitting || !comment.trim()}
            style={{
              background: comment.trim() ? '#F2CD1A' : 'var(--s3)',
              color: comment.trim() ? '#080808' : 'var(--t3)',
              border: 'none', borderRadius: 4, padding: '6px 14px',
              fontFamily: 'var(--head)', fontWeight: 700, fontSize: 10, letterSpacing: '.15em', textTransform: 'uppercase',
              cursor: comment.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'Posting...' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityEntry({ entry, isLast }) {
  const time = new Date(entry.created_at).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
  const name = entry.user?.name || 'System';
  const isComment = entry.event_type === 'comment';
  const message = getActivityMessage(entry);

  return (
    <div style={{ display: 'flex', gap: 10, paddingBottom: 14, position: 'relative' }}>
      {!isLast && (
        <div style={{ position: 'absolute', left: 12, top: 26, bottom: 0, width: 1, background: 'var(--b1)' }} />
      )}
      <div style={{
        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
        background: isComment ? 'var(--s3)' : 'var(--s1)',
        border: `1px solid ${isComment ? 'var(--b2)' : 'var(--b1)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, color: 'var(--t2)',
      }}>
        {getActivityIcon(entry.event_type)}
      </div>
      <div style={{ flex: 1, paddingTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', fontWeight: 600 }}>{name}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{time}</span>
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.5,
          color: isComment ? 'var(--text)' : 'var(--t2)',
          background: isComment ? 'var(--s2)' : 'transparent',
          borderRadius: isComment ? 4 : 0,
          padding: isComment ? '6px 10px' : 0,
        }}>
          {message}
        </div>
      </div>
    </div>
  );
}

function getActivityIcon(type) {
  return { comment: '✦', stage_change: '→', assignment: '◎', approval: '✓', attachment: '⊕', flag: '⚠', completion: '✓', abandonment: '✗' }[type] || '·';
}

function getActivityMessage(entry) {
  const p = entry.payload || {};
  const stageLabel = s => ({ backlog:'Backlog', in_sprint:'In Sprint', in_progress:'In Progress', ext_blocked:'Ext. Blocked', in_review:'In Review', approved:'Approved', done:'Done', abandoned:'Abandoned' }[s] || s);
  switch (entry.event_type) {
    case 'comment':       return p.comment;
    case 'stage_change':  return `moved from ${stageLabel(p.from)} → ${stageLabel(p.to)}`;
    case 'assignment':    return `assigned to ${p.assignee_name || 'someone'}`;
    case 'approval':      return p.decision === 'approved' ? 'approved the work' : `rejected — "${p.feedback || 'no feedback'}"`;
    case 'attachment':    return `attached "${p.label || 'a file'}"`;
    case 'flag':          return `flagged as externally blocked — "${p.reason || ''}"`;
    case 'completion':    return 'marked as done';
    case 'abandonment':   return `abandoned — "${p.reason || ''}"`;
    default:              return JSON.stringify(p);
  }
}
