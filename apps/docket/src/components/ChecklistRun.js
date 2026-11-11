'use client';
// Renders ONE assigned template run (shape from getChecklist.template_runs[i]):
// sections → items with check-off, per-item completion time + late pill, per-section comment.
// P7: a run is a List-view group (GroupHeader + 36px rows); `collapsed`/`onToggle` are the
// page's when given (My day), local otherwise (Oversight drill-in).
import { useState, useRef, useCallback } from 'react';
import { Check, ClipboardList } from 'lucide-react';
import { GroupHeader } from './tasks/GroupHeader.js';
import { TagPill } from './TagPill.js';
import { runProgress, fmtClockIST } from '../lib/checklist.js';
import { fmtTime } from '../lib/recurrence.js';

function SectionComment({ section, canComplete, onSaveComment }) {
  const [body, setBody] = useState(section.comment || '');
  const timer = useRef(null);
  const onChange = useCallback((v) => {
    setBody(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSaveComment(section.id, v), 600);
  }, [section.id, onSaveComment]);
  return (
    <textarea className="cl-seccomment" placeholder="Comments…" value={body}
      disabled={!canComplete} onChange={e => onChange(e.target.value)}
      onBlur={() => { if (timer.current) { clearTimeout(timer.current); onSaveComment(section.id, body); } }} />
  );
}

export function ChecklistRun({ run, canComplete, onToggleItem, onSaveComment, collapsed, onToggle }) {
  const { done, total } = runProgress(run);
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const isCollapsed = onToggle ? !!collapsed : localCollapsed;
  const tags = [run.template.role_label, run.template.department_name].filter(Boolean).join(' · ');
  return (
    <section className="cl-group cl-run">
      <GroupHeader variant="cl-ghead" collapsed={isCollapsed} onToggle={onToggle || (() => setLocalCollapsed(c => !c))}
        group={{ label: run.template.name, rows: [], count: `${done}/${total}`, icon: ClipboardList, hint: [run.template.run_scope === 'shared' ? 'Shared chart' : null, tags].filter(Boolean).join(' · ') || null }} />
      {!isCollapsed && (run.sections || []).map(s => {
        const sd = (s.items || []).filter(i => i.completed).length;
        return (
          <div className="cl-section" key={s.id}>
            <div className="cl-section-head">
              <span className="cl-section-title">{s.title}</span>
              {s.subtitle && <span className="cl-section-sub">{s.subtitle}</span>}
              <span className="cl-section-meta">
                {s.due_time && <span className="cl-due">by {fmtTime(s.due_time)}</span>}
                <span className="cl-section-prog">{sd}/{(s.items || []).length}</span>
              </span>
            </div>
            <ul className="cl-rows">
              {(s.items || []).map(it => (
                <li key={it.id} className={'cl-item' + (it.completed ? ' done' : '') + (it.help_text ? ' has-help' : '')}>
                  <button className={'cl-check' + (it.completed ? ' on' : '')} disabled={!canComplete}
                    aria-pressed={!!it.completed} aria-label={it.completed ? 'Mark not done' : 'Mark done'}
                    title={canComplete ? '' : 'You can only complete your own checklist'}
                    onClick={() => onToggleItem(it.id, !it.completed)}>
                    {it.completed && <Check size={12} strokeWidth={3} />}
                  </button>
                  <span className="cl-item-text">
                    <span className="cl-item-title">{it.title}</span>
                    {it.help_text && <span className="cl-item-help">{it.help_text}</span>}
                  </span>
                  <span className="cl-item-meta">
                    {it.completed && it.completed_at && (
                      <span className={'cl-done-at' + (it.late ? ' late' : '')}>
                        {it.late ? 'late · ' : ''}{fmtClockIST(it.completed_at)}
                        {it.completed_by ? ` · ${it.completed_by}` : ''}
                        {it.done_by_note ? ` · for ${it.done_by_note}` : ''}
                      </span>
                    )}
                    {(it.tags || []).map(t => <TagPill key={t} tag={t} />)}
                  </span>
                </li>
              ))}
            </ul>
            <SectionComment section={s} canComplete={canComplete} onSaveComment={onSaveComment} />
          </div>
        );
      })}
    </section>
  );
}
export default ChecklistRun;
