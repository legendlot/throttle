'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { getStageConfig, getPriorityConfig } from '@/lib/taskConfig';

const BUCKET_LABELS = {
  in_review: 'Tasks In Review',
  overdue: 'Overdue Tasks',
  ext_blocked: 'Externally Blocked',
  abandoned: 'Abandoned',
  spillovers: 'Spillovers',
};

export default function TaskDrillModal({ bucket, sprintId, personId, onClose }) {
  const { session } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTasks();
  }, [bucket, sprintId, personId]);

  async function loadTasks() {
    setLoading(true);
    try {
      const data = await workerFetch('getTasksInBucket', { bucket, sprintId, personId: personId || undefined }, session);
      setTasks(data.tasks || []);
    } catch (e) {
      console.error('Drill modal load error:', e);
    }
    setLoading(false);
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--s1)', border: '1px solid var(--b2)', borderRadius: 12, width: '100%', maxWidth: 640, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 25px 50px rgba(0,0,0,0.5)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--b1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ fontFamily: 'var(--head)', fontSize: 11, fontWeight: 700, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)' }}>
              {BUCKET_LABELS[bucket] || bucket}
            </h2>
            {!loading && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, background: 'var(--s3)', color: 'var(--t2)', padding: '2px 7px', borderRadius: 3, letterSpacing: '.1em' }}>
                {tasks.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ color: 'var(--t3)', background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', padding: '4px 8px', borderRadius: 4, transition: 'background .15s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--s3)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0' }}>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '.2em', textTransform: 'uppercase' }}>Loading...</p>
            </div>
          ) : tasks.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0' }}>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>No tasks in this bucket.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tasks.map(task => {
                const stage = getStageConfig(task.stage);
                const priority = getPriorityConfig(task.priority);
                const assigneeNames = (task.assignees || []).map(a => a.name).join(', ') || 'Unassigned';

                return (
                  <div
                    key={task.id}
                    style={{ background: 'var(--s2)', border: '1px solid var(--b1)', borderLeft: `3px solid ${priority.color}`, borderRadius: 6, padding: 12 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', fontWeight: 500, lineHeight: 1.3 }}>
                          {task.title}
                        </p>
                        {task.blocked_reason && (
                          <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 4, fontStyle: 'italic' }}>
                            {task.blocked_reason}
                          </p>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 7px', borderRadius: 3, letterSpacing: '.08em', textTransform: 'uppercase',
                          color: priority.color, background: priority.color + '15',
                        }}>
                          {priority.label}
                        </span>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 7px', borderRadius: 3, letterSpacing: '.08em', textTransform: 'uppercase',
                          color: stage.color, background: stage.color + '15',
                        }}>
                          {stage.label}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                      <span>{assigneeNames}</span>
                      {task.due_date && (
                        <span style={{ marginLeft: 'auto' }}>
                          Due: {new Date(task.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
