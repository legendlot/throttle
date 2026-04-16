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

export default function TaskDrillModal({ bucket, sprintId, onClose }) {
  const { session } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTasks();
  }, [bucket, sprintId]);

  async function loadTasks() {
    setLoading(true);
    try {
      const data = await workerFetch('getTasksInBucket', { bucket, sprintId }, session);
      setTasks(data.tasks || []);
    } catch (e) {
      console.error('Drill modal load error:', e);
    }
    setLoading(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-white">{BUCKET_LABELS[bucket] || bucket}</h2>
            {!loading && (
              <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
                {tasks.length} task{tasks.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-zinc-600 text-sm">Loading...</p>
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-zinc-600 text-sm">No tasks in this bucket.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {tasks.map(task => {
                const stage = getStageConfig(task.stage);
                const priority = getPriorityConfig(task.priority);
                const assigneeNames = (task.assignees || []).map(a => a.name).join(', ') || 'Unassigned';

                return (
                  <div
                    key={task.id}
                    className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-zinc-200 text-xs font-medium leading-snug">
                          {task.title}
                        </p>
                        {task.blocked_reason && (
                          <p className="text-zinc-500 text-xs mt-1 italic">
                            {task.blocked_reason}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Priority badge */}
                        <span
                          className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
                          style={{ color: priority.color, backgroundColor: priority.color + '15' }}
                        >
                          <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: priority.color }} />
                          {priority.label}
                        </span>
                        {/* Stage badge */}
                        <span
                          className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
                          style={{ color: stage.color, backgroundColor: stage.color + '15' }}
                        >
                          <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: stage.color }} />
                          {stage.label}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
                      <span>{assigneeNames}</span>
                      {task.due_date && (
                        <span className="ml-auto">
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
