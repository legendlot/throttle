'use client';
// Renders ONE assigned template run (shape from getChecklist.template_runs[i]):
// sections → items with check-off, per-item completion time + late pill, per-section comment.
import { useState, useRef, useCallback } from 'react';
import { Check } from 'lucide-react';
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

export function ChecklistRun({ run, canComplete, onToggleItem, onSaveComment }) {
  const { done, total } = runProgress(run);
  return (
    <section className="cl-run">
      <div className="cl-run-head">
        <div className="cl-run-title">
          <h4>{run.template.name}</h4>
          {run.template.role_label && <span className="chip soft">{run.template.role_label}</span>}
          {run.template.department_name && <span className="chip soft">{run.template.department_name}</span>}
        </div>
        <span className="cl-run-prog">{done}/{total}</span>
      </div>
      {(run.sections || []).map(s => {
        const sd = (s.items || []).filter(i => i.completed).length;
        return (
          <div className="cl-section" key={s.id}>
            <div className="cl-section-head">
              <div>
                <h5>{s.title}</h5>
                {s.subtitle && <span className="cl-section-sub">{s.subtitle}</span>}
              </div>
              <div className="cl-section-meta">
                {s.due_time && <span className="cl-due">by {fmtTime(s.due_time)}</span>}
                <span className="cl-section-prog">{sd}/{(s.items || []).length}</span>
              </div>
            </div>
            <ul className="cl-items">
              {(s.items || []).map(it => (
                <li key={it.id} className={'cl-item' + (it.completed ? ' done' : '')}>
                  <button className={'cl-check' + (it.completed ? ' on' : '')} disabled={!canComplete}
                    title={canComplete ? '' : 'You can only complete your own checklist'}
                    onClick={() => onToggleItem(it.id, !it.completed)}>
                    {it.completed && <Check size={14} />}
                  </button>
                  <div className="cl-item-main">
                    <div className="cl-item-title">{it.title}</div>
                    {it.help_text && <div className="cl-item-help">{it.help_text}</div>}
                    <div className="cl-item-meta">
                      {(it.tags || []).map(t => <TagPill key={t} tag={t} />)}
                      {it.completed && it.completed_at && (
                        <span className={'cl-done-at' + (it.late ? ' late' : '')}>
                          {it.late ? 'late · ' : ''}{fmtClockIST(it.completed_at)}
                          {it.completed_by ? ` · ${it.completed_by}` : ''}
                        </span>
                      )}
                    </div>
                  </div>
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
