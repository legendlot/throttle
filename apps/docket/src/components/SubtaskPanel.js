'use client';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { StatusBadge } from './StatusBadge.js';
import { PriorityBadge } from './PriorityBadge.js';
import { effectiveDeadline } from '../lib/tasks.js';
import { fmtDate } from '../lib/format.js';

// Children of a task (one level). Parent shows roll-up; rows link to the child.
// Hidden when this task is itself a sub-task (a child can't take children — one level).
export function SubtaskPanel({ task, session }) {
  const router = useRouter();
  const children = task.children || [];
  const isChild = !!task.parent_task_id;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {children.length > 0 ? `${task.child_done}/${task.child_count} done` : 'No sub-tasks'}
        </span>
        {!isChild && (
          <button style={btn} onClick={() => router.push(`/tasks/new?parent=${task.id}`)}>
            <Plus size={13} /> Add sub-task
          </button>
        )}
      </div>
      {isChild && <div style={note}>This is a sub-task of its parent — sub-tasks are one level deep, so it can’t have its own sub-tasks.</div>}
      {children.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {children.map(c => (
            <div key={c.id} style={row} onClick={() => router.push(`/tasks/detail/?id=${c.id}`)}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-4)', width: 70 }}>{c.task_no}</span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-1)' }}>{c.title}</span>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{c.owner_name || '—'}</span>
              <PriorityBadge priority={c.priority} />
              <StatusBadge status={c.status} />
              <span style={{ fontSize: 11, color: 'var(--text-3)', width: 90, textAlign: 'right' }}>{fmtDate(effectiveDeadline(c))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const row = { display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', cursor: 'pointer' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 'var(--radius-sm)', padding: '5px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
const note = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12, color: 'var(--text-3)', marginBottom: 10 };
