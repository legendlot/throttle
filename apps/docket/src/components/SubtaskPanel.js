'use client';
import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@throttle/ui';
import { Plus, Check, ExternalLink } from 'lucide-react';
import { docketopsPost } from '../lib/docketopsFetch.js';
import { StatusBadge } from './StatusBadge.js';
import { PriorityBadge } from './PriorityBadge.js';
import { effectiveDeadline } from '../lib/tasks.js';
import { fmtDate } from '../lib/format.js';

// Children of a task (one level). Parent shows roll-up; rows link to the child.
// Speed-create: a title-only inline add lets you fire off sub-tasks one after the
// other (the input keeps focus); owner / program / team carry over from the parent
// (worker-side, createSubtask) — fill the rest in later from the sub-task itself.
// Hidden when this task is itself a sub-task (a child can't take children — one level).
export function SubtaskPanel({ task, session, canEdit = false, onChange }) {
  const router = useRouter();
  const { showToast } = useToast();
  const children = task.children || [];
  const isChild = !!task.parent_task_id;
  const canAdd = canEdit && !isChild;

  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  async function add() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      await docketopsPost('createSubtask', { parent_task_id: task.id, title: t }, session);
      setTitle('');
      await onChange?.();
      inputRef.current?.focus();   // keep going — add the next one
    } catch (e) { showToast(e.message || 'Failed to add sub-task', 'error'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {children.length > 0 ? `${task.child_done}/${task.child_count} done` : 'No sub-tasks'}
        </span>
        {canAdd && (
          <button style={fullLink} title="Open the full form (all fields)" onClick={() => router.push(`/tasks/new?parent=${task.id}`)}>
            <ExternalLink size={12} /> full form
          </button>
        )}
      </div>

      {isChild && <div style={note}>This is a sub-task of its parent. Sub-tasks are one level deep, so it can’t have its own sub-tasks.</div>}

      {children.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: canAdd ? 8 : 0 }}>
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

      {canAdd && (
        <div style={addRow}>
          <Plus size={14} style={{ color: 'var(--text-4)', flexShrink: 0 }} />
          <input ref={inputRef} data-subtask-add value={title} onChange={e => setTitle(e.target.value)} disabled={saving}
            placeholder="Add a sub-task, press Enter — owner & program carry over"
            style={addInput}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          {title.trim() && (
            <button style={addBtn} onClick={add} disabled={saving} title="Add (Enter)"><Check size={13} /></button>
          )}
        </div>
      )}
    </div>
  );
}

const row = { display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', cursor: 'pointer' };
const note = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12, color: 'var(--text-3)', marginBottom: 10 };
const addRow = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)', border: '1px dashed var(--border-2)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' };
const addInput = { flex: 1, background: 'transparent', color: 'var(--text-1)', border: 'none', outline: 'none', fontSize: 13, fontFamily: 'inherit', padding: '2px 0' };
const addBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 'var(--radius-sm)', background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: 'none', cursor: 'pointer', flexShrink: 0 };
const fullLink = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--text-4)', fontSize: 11, cursor: 'pointer', padding: 0, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: 'var(--font-cond)', fontWeight: 700 };
