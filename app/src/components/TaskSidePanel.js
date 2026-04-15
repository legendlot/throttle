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

  // Stage move
  const [movingStage, setMovingStage] = useState(false);
  const [targetStage, setTargetStage] = useState(null);
  const [blockedReason, setBlockedReason] = useState('');

  // Priority
  const [editingPriority, setEditingPriority] = useState(false);

  // Abandon
  const [abandonReason, setAbandonReason] = useState('');
  const [showAbandon, setShowAbandon] = useState(false);

  const isAdminLead = ['admin', 'lead'].includes(brandUser?.role);
  const validTransitions = getValidTransitions(task.stage, brandUser?.role);
  const stageConfig = getStageConfig(task.stage);
  const priorityConfig = getPriorityConfig(task.priority);

  useEffect(() => {
    loadAssignees();
    if (isAdminLead) loadTeamMembers();
  }, [task.id]);

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

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-zinc-950 border-l border-zinc-800 z-50 overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-zinc-800 sticky top-0 bg-zinc-950">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: stageConfig.color }}
              />
              <span className="text-xs text-zinc-500">{stageConfig.label}</span>
              {task.is_spillover && (
                <span className="text-xs bg-amber-900/40 text-amber-400 border border-amber-800 px-1.5 py-0.5 rounded">
                  Spillover
                </span>
              )}
            </div>
            <h2 className="text-white font-semibold text-base leading-tight">{task.title}</h2>
            {task.product_code && (
              <p className="text-zinc-600 text-xs mt-1">Product: {task.product_code}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-600 hover:text-white transition-colors text-lg flex-shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-6">

          {/* Error */}
          {error && (
            <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Stage */}
          <Section title="Stage">
            {!movingStage ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: stageConfig.color }}
                  />
                  <span className="text-sm text-zinc-200">{stageConfig.label}</span>
                </div>
                {validTransitions.length > 0 && (
                  <button
                    onClick={() => setMovingStage(true)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Move →
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {validTransitions.map(s => {
                    const sc = getStageConfig(s);
                    return (
                      <button
                        key={s}
                        onClick={() => setTargetStage(s)}
                        className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                          targetStage === s
                            ? 'bg-white text-black border-white'
                            : 'text-zinc-400 border-zinc-700 hover:border-zinc-500'
                        }`}
                      >
                        {sc.label}
                      </button>
                    );
                  })}
                </div>

                {(targetStage === 'ext_blocked' || targetStage === 'abandoned') && (
                  <textarea
                    value={blockedReason}
                    onChange={e => setBlockedReason(e.target.value)}
                    placeholder={targetStage === 'abandoned'
                      ? 'Why is this task being abandoned?'
                      : 'What is blocking this task externally?'}
                    className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none resize-none h-20"
                  />
                )}

                <div className="flex gap-2">
                  <button
                    onClick={moveStage}
                    disabled={!targetStage || loading}
                    className="bg-white text-black text-xs font-semibold px-4 py-2 rounded-lg disabled:opacity-40 hover:bg-zinc-100 transition-colors"
                  >
                    {loading ? 'Moving...' : 'Confirm Move'}
                  </button>
                  <button
                    onClick={() => { setMovingStage(false); setTargetStage(null); setBlockedReason(''); }}
                    className="text-zinc-600 text-xs hover:text-zinc-400 transition-colors px-3"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </Section>

          {/* Priority */}
          <Section title="Priority">
            {!editingPriority ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: priorityConfig.color }}
                  />
                  <span className="text-sm text-zinc-200">{priorityConfig.label}</span>
                </div>
                {isAdminLead && (
                  <button
                    onClick={() => setEditingPriority(true)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Edit
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {PRIORITIES.map(p => (
                  <button
                    key={p.value}
                    onClick={() => changePriority(p.value)}
                    disabled={loading}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                      task.priority === p.value
                        ? 'bg-white text-black border-white'
                        : 'text-zinc-400 border-zinc-700 hover:border-zinc-500'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  onClick={() => setEditingPriority(false)}
                  className="text-zinc-600 text-xs hover:text-zinc-400 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </Section>

          {/* Assignees */}
          <Section title="Assignees">
            {assignees.length === 0 ? (
              <p className="text-zinc-600 text-sm">Unassigned</p>
            ) : (
              <div className="flex flex-wrap gap-2 mb-2">
                {assignees.map(a => (
                  <span key={a.id} className="bg-zinc-800 text-zinc-300 text-xs px-2 py-1 rounded">
                    {a.name}
                    {a.discipline && <span className="text-zinc-600 ml-1">· {a.discipline}</span>}
                  </span>
                ))}
              </div>
            )}

            {isAdminLead && teamMembers.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-zinc-600 mb-2">Click to assign / unassign</p>
                <div className="flex flex-wrap gap-2">
                  {teamMembers.map(m => {
                    const assigned = assignees.some(a => a.id === m.id);
                    return (
                      <button
                        key={m.id}
                        onClick={() => toggleAssignee(m.id)}
                        disabled={loading}
                        className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                          assigned
                            ? 'bg-zinc-700 text-white border-zinc-600'
                            : 'text-zinc-500 border-zinc-700 hover:border-zinc-500'
                        }`}
                      >
                        {assigned && <span className="mr-1 text-green-400">✓</span>}
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
            <div className="space-y-2">
              <DetailRow label="Type" value={task.type?.replace(/_/g, ' ')} />
              <DetailRow
                label="Deliverable"
                value={DELIVERABLE_TYPES.find(d => d.value === task.deliverable_type)?.label || task.deliverable_type}
              />
              {task.due_date && (
                <DetailRow
                  label="Due"
                  value={new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                />
              )}
              {task.sprint_id && (
                <DetailRow label="Sprint" value={task.sprint_id.slice(0, 8) + '...'} />
              )}
              {task.spillover_count > 0 && (
                <DetailRow label="Spillovers" value={String(task.spillover_count)} />
              )}
            </div>
          </Section>

          {/* Notes */}
          {task.notes && (
            <Section title="Notes">
              <p className="text-zinc-400 text-sm whitespace-pre-wrap">{task.notes}</p>
            </Section>
          )}

          {/* Attachments */}
          <AttachmentsSection taskId={task.id} />

          {/* Blocked reason */}
          {task.blocked_reason && task.stage === 'ext_blocked' && (
            <Section title="External Blocker">
              <p className="text-amber-400 text-sm">{task.blocked_reason}</p>
            </Section>
          )}

          {/* Submit for Review */}
          {!['done', 'abandoned', 'in_review', 'approved'].includes(task.stage) &&
            assignees.some(a => a.id === brandUser?.id) && (
            <SubmitForReviewSection
              task={task}
              session={session}
              onUpdate={onUpdate}
              onError={setError}
            />
          )}

          {/* Work Approval — for admin/lead when task is in_review */}
          {isAdminLead && task.stage === 'in_review' && (
            <WorkApprovalSection
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
                  className="text-xs text-red-500 hover:text-red-400 transition-colors"
                >
                  Abandon task
                </button>
              ) : (
                <div className="space-y-3">
                  <textarea
                    value={abandonReason}
                    onChange={e => setAbandonReason(e.target.value)}
                    placeholder="Why is this task being abandoned?"
                    className="w-full bg-zinc-900 border border-red-900 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none resize-none h-20"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={abandonTask}
                      disabled={loading}
                      className="bg-red-900 text-red-100 text-xs font-semibold px-4 py-2 rounded-lg hover:bg-red-800 transition-colors disabled:opacity-40"
                    >
                      {loading ? 'Abandoning...' : 'Confirm Abandon'}
                    </button>
                    <button
                      onClick={() => { setShowAbandon(false); setAbandonReason(''); }}
                      className="text-zinc-600 text-xs hover:text-zinc-400 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <p className="text-xs text-zinc-600 uppercase tracking-widest mb-2">{title}</p>
      {children}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex gap-3">
      <span className="text-xs text-zinc-600 w-24 flex-shrink-0">{label}</span>
      <span className="text-xs text-zinc-300 capitalize">{value}</span>
    </div>
  );
}

function SubmitForReviewSection({ task, session, onUpdate, onError }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!url.trim()) { onError('A deliverable URL is required'); return; }
    setSubmitting(true);
    try {
      await workerFetch('submitForReview', {
        task_id: task.id,
        attachment_url: url.trim(),
        attachment_label: label.trim() || 'Deliverable',
      }, session?.access_token);
      onUpdate({ ...task, stage: 'in_review' });
      setOpen(false);
    } catch (e) {
      onError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Section title="Submit for Review">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="bg-white text-black text-xs font-semibold px-4 py-2 rounded-lg hover:bg-zinc-100 transition-colors"
        >
          Submit Work for Review →
        </button>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Deliverable URL *</label>
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://drive.google.com/... or Figma link, etc."
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Label (optional)</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Final designs, Video edit v2"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={submitting}
              className="bg-white text-black text-xs font-semibold px-4 py-2 rounded-lg disabled:opacity-40 hover:bg-zinc-100 transition-colors"
            >
              {submitting ? 'Submitting...' : 'Submit for Review'}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="text-zinc-600 text-xs hover:text-zinc-400 px-3"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

function WorkApprovalSection({ task, session, onUpdate, onClose, onError }) {
  const [decision, setDecision] = useState(null); // 'approve' | 'reject'
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (decision === 'reject' && !feedback.trim()) {
      onError('Feedback is required when rejecting work');
      return;
    }
    setSubmitting(true);
    try {
      const action = decision === 'approve' ? 'approveWork' : 'rejectWork';
      await workerFetch(action, {
        task_id: task.id,
        feedback: feedback.trim() || undefined,
      }, session?.access_token);

      if (decision === 'approve') {
        onUpdate({ ...task, stage: 'done' });
        onClose();
      } else {
        onUpdate({ ...task, stage: 'in_progress' });
        setDecision(null);
        setFeedback('');
      }
    } catch (e) {
      onError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Section title="Review Submitted Work">
      <div className="bg-cyan-950/40 border border-cyan-800 rounded-lg p-3 mb-3">
        <p className="text-cyan-400 text-xs">
          ⏳ Work has been submitted for your review
        </p>
      </div>

      {!decision ? (
        <div className="flex gap-2">
          <button
            onClick={() => setDecision('approve')}
            className="flex-1 py-2 text-xs font-medium rounded-lg border border-green-700 text-green-400 hover:bg-green-950 transition-colors"
          >
            Approve
          </button>
          <button
            onClick={() => setDecision('reject')}
            className="flex-1 py-2 text-xs font-medium rounded-lg border border-red-700 text-red-400 hover:bg-red-950 transition-colors"
          >
            Request Revision
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            placeholder={
              decision === 'approve'
                ? 'Optional note for the team member...'
                : 'What needs to be revised? (required)'
            }
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none resize-none h-20"
          />
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={submitting}
              className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 ${
                decision === 'approve'
                  ? 'bg-green-700 text-white hover:bg-green-600'
                  : 'bg-red-900 text-red-100 hover:bg-red-800'
              }`}
            >
              {submitting
                ? 'Submitting...'
                : decision === 'approve' ? 'Confirm Approval' : 'Send for Revision'}
            </button>
            <button
              onClick={() => { setDecision(null); setFeedback(''); }}
              className="text-zinc-600 text-xs hover:text-zinc-400 px-3"
            >
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
      <div className="space-y-2">
        {attachments.map(a => (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs text-zinc-400 hover:text-white transition-colors group"
          >
            <span className="text-zinc-600 group-hover:text-zinc-400">🔗</span>
            <span className="truncate">{a.label || a.url}</span>
          </a>
        ))}
      </div>
    </Section>
  );
}
