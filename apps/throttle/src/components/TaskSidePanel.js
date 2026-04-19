'use client';
import { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch, supabaseBrand as supabase } from '@throttle/db';
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
  const [sprintName, setSprintName] = useState('—');

  const isAdminLead = ['admin', 'lead'].includes(brandUser?.role);
  const validTransitions = getValidTransitions(task.stage, brandUser?.role);
  const stageConfig = getStageConfig(task.stage);
  const priorityConfig = getPriorityConfig(task.priority);

  useEffect(() => {
    loadAssignees();
    loadActivity();
    if (isAdminLead) loadTeamMembers();
    if (task.sprint_id) {
      supabase.from('sprints').select('name').eq('id', task.sprint_id).single()
        .then(({ data }) => setSprintName(data?.name || '—'));
    } else {
      setSprintName('—');
    }
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
    // Two separate queries — task_assignees has two FKs to users (user_id + assigned_by),
    // which makes the PostgREST join ambiguous and silently return null. Fetch separately.
    const { data: rows } = await supabase
      .from('task_assignees')
      .select('user_id, is_owner')
      .eq('task_id', task.id);

    if (!rows || rows.length === 0) { setAssignees([]); return; }

    const userIds = [...new Set(rows.map(r => r.user_id))];
    const { data: users } = await supabase
      .from('users')
      .select('id, name, discipline')
      .in('id', userIds);

    const usersById = Object.fromEntries((users || []).map(u => [u.id, u]));
    setAssignees(
      rows
        .map(r => ({ ...usersById[r.user_id], user_id: r.user_id, is_owner: r.is_owner }))
        .filter(a => a.user_id)
    );
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
            <EditableTitle task={task} brandUser={brandUser} session={session} onUpdate={onUpdate} />
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

          {/* Assignees — Owner / Collaborator model */}
          <AssigneesSection task={{ ...task, assignees }} teamMembers={teamMembers} brandUser={brandUser} session={session} onUpdate={async () => { await loadAssignees(); await loadActivity(); }} />

          {/* Details */}
          <Section title="Details">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <DetailRow label="Type" value={task.type?.replace(/_/g, ' ')} />
              <DetailRow label="Deliverable" value={DELIVERABLE_TYPES.find(d => d.value === task.deliverable_type)?.label || task.deliverable_type} />
              <div style={{ display: 'flex', gap: 12 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', width: 80, flexShrink: 0 }}>Due</span>
                <EditableDueDate task={task} brandUser={brandUser} session={session} onUpdate={onUpdate} />
              </div>
              {task.sprint_id && <DetailRow label="Sprint" value={sprintName} />}
              {task.spillover_count > 0 && <DetailRow label="Spillovers" value={String(task.spillover_count)} />}
              {task.is_revision && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--b1)' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>Work Type</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)', background: 'rgba(245,158,11,0.1)', padding: '1px 8px', borderRadius: 3 }}>Revision</span>
                </div>
              )}
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

          {/* Deliver to Requester — shown on approved tasks to assignees and admin/lead */}
          {task.stage === 'approved' && (
            assignees.some(a => a.user_id === brandUser?.id) || isAdminLead
          ) && (
            <DeliverTaskSection
              task={task}
              session={session}
              onUpdate={onUpdate}
              onError={setError}
            />
          )}

          {/* Mark Done override — admin/lead only, shown on delivered tasks */}
          {isAdminLead && task.stage === 'delivered' && (
            <MarkDoneSection
              task={task}
              session={session}
              onUpdate={onUpdate}
              onClose={onClose}
              onError={setError}
            />
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

function AssigneesSection({ task, teamMembers, brandUser, session, onUpdate }) {
  const owner = task.assignees?.find(a => a.is_owner);
  const collaborators = task.assignees?.filter(a => !a.is_owner) || [];
  const isAdminLead = ['admin', 'lead'].includes(brandUser?.role);
  const isAlreadyAssigned = task.assignees?.some(a => a.user_id === brandUser?.id);

  const call = async (action, userId) => {
    try {
      await workerFetch('assignTask', { taskId: task.id, action, ...(userId ? { userId } : {}) }, session?.access_token);
      onUpdate();
    } catch (e) { alert(e.message); }
  };

  return (
    <div style={{ borderBottom: '1px solid var(--b1)', paddingBottom: 14 }}>
      <div style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: '.25em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 12, fontWeight: 700 }}>Assignees</div>

      {/* Owner */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.12em', textTransform: 'uppercase', marginBottom: 8 }}>Owner</div>
        {owner ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#F2CD1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--head)', fontSize: 11, fontWeight: 700, color: '#080808', flexShrink: 0 }}>
                {owner.name?.[0]?.toUpperCase() || '?'}
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)' }}>{owner.name}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', background: 'var(--s3)', padding: '1px 6px', borderRadius: 3, letterSpacing: '.08em', textTransform: 'uppercase' }}>owner</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {owner.user_id === brandUser?.id && (
                <button onClick={() => call('remove_self')} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--mono)' }}>Leave</button>
              )}
              {isAdminLead && owner.user_id !== brandUser?.id && (
                <button onClick={() => call('remove_assignee', owner.user_id)} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--mono)' }}>Remove</button>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>Unassigned</span>
            {!isAlreadyAssigned && (
              <button onClick={() => call('self_assign_owner')} style={{ background: 'rgba(242,205,26,0.1)', color: '#F2CD1A', border: '1px solid rgba(242,205,26,0.25)', borderRadius: 4, padding: '5px 12px', fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', cursor: 'pointer', alignSelf: 'flex-start' }}>
                Assign to me
              </button>
            )}
            {isAdminLead && (
              <select defaultValue="" onChange={e => { if (e.target.value) call('set_owner', e.target.value); }} style={{ background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '5px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none' }}>
                <option value="">Assign owner...</option>
                {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
          </div>
        )}
        {isAdminLead && owner && (
          <select defaultValue="" onChange={e => { if (e.target.value) call('set_owner', e.target.value); }} style={{ marginTop: 8, background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '5px 10px', color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none', width: '100%' }}>
            <option value="">Change owner...</option>
            {teamMembers.filter(m => m.id !== owner.user_id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
      </div>

      {/* Collaborators */}
      <div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.12em', textTransform: 'uppercase', marginBottom: 8 }}>Collaborators</div>
        {collaborators.length === 0 && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>None</span>}
        {collaborators.map(c => (
          <div key={c.user_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--s3)', border: '1px solid var(--b2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--head)', fontSize: 9, color: 'var(--t2)', flexShrink: 0 }}>
                {c.name?.[0]?.toUpperCase() || '?'}
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{c.name}</span>
            </div>
            {(c.user_id === brandUser?.id || isAdminLead) && (
              <button onClick={() => c.user_id === brandUser?.id ? call('remove_self') : call('remove_assignee', c.user_id)} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--mono)' }}>
                {c.user_id === brandUser?.id ? 'Leave' : 'Remove'}
              </button>
            )}
          </div>
        ))}
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {owner && !isAlreadyAssigned && (
            <button onClick={() => call('self_add_collaborator')} style={{ background: 'var(--s2)', color: 'var(--t2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '5px 12px', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', alignSelf: 'flex-start' }}>
              + Add me as collaborator
            </button>
          )}
          {teamMembers.filter(m => !task.assignees?.some(a => a.user_id === m.id)).length > 0 && (
            <select defaultValue="" onChange={e => { if (e.target.value) call('add_collaborator', e.target.value); }} style={{ background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '5px 10px', color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none' }}>
              <option value="">Add collaborator...</option>
              {teamMembers.filter(m => !task.assignees?.some(a => a.user_id === m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}

function EditableTitle({ task, brandUser, session, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const canEdit = ['admin', 'lead'].includes(brandUser?.role);

  useEffect(() => { setValue(task.title); }, [task.title]);

  const handleSave = async () => {
    if (value.trim() === task.title) { setEditing(false); return; }
    try {
      await workerFetch('updateTaskMeta', { taskId: task.id, title: value.trim() }, session?.access_token);
      onUpdate({ ...task, title: value.trim() });
    } catch (e) { console.error(e); }
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setValue(task.title); setEditing(false); } }}
          style={{ background: 'var(--s2)', border: '1px solid #F2CD1A', borderRadius: 4, padding: '6px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, outline: 'none', width: '100%' }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleSave} style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 4, padding: '4px 12px', fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase', cursor: 'pointer' }}>Save</button>
          <button onClick={() => { setValue(task.title); setEditing(false); }} style={{ background: 'var(--s3)', color: 'var(--t2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '4px 12px', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={canEdit ? () => setEditing(true) : undefined}
      style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4, cursor: canEdit ? 'text' : 'default', borderBottom: canEdit ? '1px dashed var(--b2)' : 'none', paddingBottom: canEdit ? 2 : 0 }}
      title={canEdit ? 'Click to edit' : undefined}
    >
      {task.title}
    </div>
  );
}

function EditableDueDate({ task, brandUser, session, onUpdate }) {
  const canEdit = ['admin', 'lead'].includes(brandUser?.role);
  const [editing, setEditing] = useState(false);

  const handleChange = async (e) => {
    const newDate = e.target.value || null;
    try {
      await workerFetch('updateTaskMeta', { taskId: task.id, dueDate: newDate }, session?.access_token);
      onUpdate({ ...task, due_date: newDate });
    } catch (err) { console.error(err); }
    setEditing(false);
  };

  if (editing) {
    return (
      <input type="date" defaultValue={task.due_date || ''} onChange={handleChange} onBlur={() => setEditing(false)} autoFocus
        style={{ background: 'var(--s2)', border: '1px solid #F2CD1A', borderRadius: 4, padding: '3px 8px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, outline: 'none' }}
      />
    );
  }

  const display = task.due_date
    ? new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

  return (
    <span onClick={canEdit ? () => setEditing(true) : undefined}
      style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', cursor: canEdit ? 'pointer' : 'default', borderBottom: canEdit ? '1px dashed var(--b2)' : 'none' }}
      title={canEdit ? 'Click to edit' : undefined}
    >
      {display}
    </span>
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
  return { comment: '✦', stage_change: '→', assignment: '◎', approval: '✓', attachment: '⊕', flag: '⚠', completion: '✓', abandonment: '✗', delivery: '📦', iteration: '🔄' }[type] || '·';
}

function getActivityMessage(entry) {
  const p = entry.payload || {};
  const stageLabel = s => ({ backlog:'Backlog', in_sprint:'In Sprint', in_progress:'In Progress', ext_blocked:'Ext. Blocked', in_review:'In Review', approved:'Approved', delivered:'Delivered', done:'Done', abandoned:'Abandoned' }[s] || s);
  switch (entry.event_type) {
    case 'comment':       return p.comment;
    case 'stage_change':  return `moved from ${stageLabel(p.from)} → ${stageLabel(p.to)}`;
    case 'assignment':    return `assigned to ${p.assignee_name || 'someone'}`;
    case 'approval':      return p.decision === 'approved' ? 'approved the work' : `rejected — "${p.feedback || 'no feedback'}"`;
    case 'attachment':    return `attached "${p.label || 'a file'}"`;
    case 'flag':          return `flagged as externally blocked — "${p.reason || ''}"`;
    case 'completion':    return 'marked as done';
    case 'abandonment':   return `abandoned — "${p.reason || ''}"`;
    case 'delivery':      return `delivered to requester${p.message ? ` — "${p.message}"` : ''}`;
    case 'iteration':     return `iteration ${p.iteration_number} requested${p.comment ? ` — "${p.comment}"` : ''}`;
    default:              return JSON.stringify(p);
  }
}

// ── DELIVER TASK SECTION — shown on 'approved' tasks to assignee / admin / lead
function DeliverTaskSection({ task, session, onUpdate, onError }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [delivering, setDelivering] = useState(false);

  async function deliver() {
    setDelivering(true);
    try {
      await workerFetch('deliverTask', {
        task_id: task.id,
        message: message.trim() || undefined,
        attachment_url: url.trim() || undefined,
        attachment_label: label.trim() || undefined,
      }, session?.access_token);
      onUpdate({ ...task, stage: 'delivered' });
      setOpen(false);
    } catch (e) {
      onError(e.message);
    } finally {
      setDelivering(false);
    }
  }

  return (
    <Section title="Deliver to Requester">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 4, padding: '7px 14px', fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', cursor: 'pointer' }}
        >
          Deliver →
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Message to requester (optional)</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="e.g. Here's the v1. We went with a white background as discussed."
              style={{ width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '8px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none', resize: 'none', height: 72, boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Deliverable URL (optional)</label>
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://drive.google.com/... or Figma link"
              style={{ width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '7px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Label (optional)</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Final assets v1"
              style={{ width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '7px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={deliver}
              disabled={delivering}
              style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 4, padding: '7px 14px', fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', cursor: 'pointer', opacity: delivering ? 0.5 : 1 }}
            >
              {delivering ? 'Delivering...' : 'Confirm Delivery'}
            </button>
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── MARK DONE OVERRIDE — admin/lead only, shown on delivered tasks
function MarkDoneSection({ task, session, onUpdate, onClose, onError }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  async function markDone() {
    setSaving(true);
    try {
      await workerFetch('markTaskDone', { task_id: task.id, reason: reason.trim() || undefined }, session?.access_token);
      onUpdate({ ...task, stage: 'done' });
      onClose();
    } catch (e) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Admin Override">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          style={{ background: 'none', border: '1px solid var(--b2)', borderRadius: 4, padding: '6px 12px', color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}
        >
          Mark as Done
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', margin: 0 }}>
            This closes the task regardless of requester feedback.
          </p>
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Reason (optional)"
            style={{ width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '7px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={markDone}
              disabled={saving}
              style={{ background: 'var(--s3)', border: '1px solid var(--b2)', borderRadius: 4, padding: '6px 12px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', opacity: saving ? 0.5 : 1 }}
            >
              {saving ? 'Saving...' : 'Confirm'}
            </button>
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
    </Section>
  );
}
