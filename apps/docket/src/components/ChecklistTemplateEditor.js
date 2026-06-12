'use client';
// Create/edit a structured checklist template: sections → items (+ tags), schedule
// (time-optional), role label, department, and assignees. RULE-DOCKET-009.
import { useEffect, useState, useCallback } from 'react';
import { Combobox, useToast } from '@throttle/ui';
import { Plus, Trash2, ChevronUp, ChevronDown, Check, X } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../lib/docketopsFetch.js';
import { RecurrenceEditor } from './RecurrenceEditor.js';
import { CHECKLIST_TAGS } from './TagPill.js';
import { isValidTemplateRecurrence } from '../lib/recurrence.js';

const blankItem = () => ({ id: null, title: '', help_text: '', tags: [] });
const blankSection = () => ({ id: null, title: '', subtitle: '', due_time: '', items: [blankItem()] });

export function ChecklistTemplateEditor({ templateId, employees, departments, session, onSaved, onCancel }) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState(null);
  const [assignees, setAssignees] = useState([]);     // [{employee_id, full_name}]
  const [busy, setBusy] = useState(false);
  const isNew = !templateId;

  useEffect(() => {
    if (!templateId) {
      setDraft({ id: null, name: '', role_label: '', department_id: '', description: '', recurrence: { freq: 'daily' }, sections: [blankSection()] });
      setAssignees([]);
      return;
    }
    docketopsGet('getChecklistTemplate', { id: templateId }, session).then(t => {
      setDraft({
        id: t.id, name: t.name || '', role_label: t.role_label || '', department_id: t.department_id || '',
        description: t.description || '', recurrence: t.recurrence || { freq: 'daily' },
        sections: (t.sections || []).map(s => ({ id: s.id, title: s.title, subtitle: s.subtitle || '', due_time: s.due_time || '', items: (s.items || []).map(i => ({ id: i.id, title: i.title, help_text: i.help_text || '', tags: i.tags || [] })) })),
      });
      setAssignees(t.assignees || []);
    }).catch(e => showToast(e.message || 'Failed to load', 'error'));
  }, [templateId, session, showToast]);

  const patch = useCallback((p) => setDraft(d => ({ ...d, ...p })), []);
  const setSection = (si, p) => setDraft(d => ({ ...d, sections: d.sections.map((s, i) => i === si ? { ...s, ...p } : s) }));
  const setItem = (si, ii, p) => setDraft(d => ({ ...d, sections: d.sections.map((s, i) => i === si ? { ...s, items: s.items.map((it, j) => j === ii ? { ...it, ...p } : it) } : s) }));
  const moveSection = (si, dir) => setDraft(d => { const a = d.sections.slice(); const j = si + dir; if (j < 0 || j >= a.length) return d; [a[si], a[j]] = [a[j], a[si]]; return { ...d, sections: a }; });
  const toggleTag = (si, ii, tag) => setItem(si, ii, { tags: (draft.sections[si].items[ii].tags || []).includes(tag) ? draft.sections[si].items[ii].tags.filter(t => t !== tag) : [...(draft.sections[si].items[ii].tags || []), tag] });

  async function addAssignee(empId) {
    if (!empId || assignees.some(a => a.employee_id === empId)) return;
    const emp = employees.find(e => e.id === empId);
    setAssignees(a => [...a, { employee_id: empId, full_name: emp?.full_name || '' }]);
    if (!isNew) { try { await docketopsPost('assignChecklistTemplate', { template_id: templateId, employee_id: empId }, session); } catch (e) { showToast(e.message, 'error'); } }
  }
  async function removeAssignee(empId) {
    setAssignees(a => a.filter(x => x.employee_id !== empId));
    if (!isNew) { try { await docketopsPost('unassignChecklistTemplate', { template_id: templateId, employee_id: empId }, session); } catch (e) { showToast(e.message, 'error'); } }
  }

  async function save() {
    if (!draft.name.trim()) { showToast('Name required', 'error'); return; }
    if (!isValidTemplateRecurrence(draft.recurrence)) { showToast('Pick a valid schedule', 'error'); return; }
    setBusy(true);
    try {
      const res = await docketopsPost('saveChecklistTemplate', {
        id: draft.id, name: draft.name.trim(), role_label: draft.role_label || null,
        department_id: draft.department_id || null, description: draft.description || null,
        recurrence: draft.recurrence,
        sections: draft.sections.map(s => ({ id: s.id, title: s.title, subtitle: s.subtitle || null, due_time: s.due_time || null, items: s.items.map(i => ({ id: i.id, title: i.title, help_text: i.help_text || null, tags: i.tags || [] })) })),
      }, session);
      const newId = res?.id || draft.id;
      if (isNew && newId) {
        for (const a of assignees) { await docketopsPost('assignChecklistTemplate', { template_id: newId, employee_id: a.employee_id }, session); }
      }
      showToast('Saved', 'success'); onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  if (!draft) return null;
  return (
    <div className="cl-editor">
      <div className="cl-editor-grid">
        <label className="cl-field"><span>Name</span>
          <input className="cl-input" value={draft.name} placeholder="e.g. Senior Production Manager — Daily" onChange={e => patch({ name: e.target.value })} /></label>
        <label className="cl-field"><span>Role label</span>
          <input className="cl-input" value={draft.role_label} placeholder="e.g. Senior Production Manager" onChange={e => patch({ role_label: e.target.value })} /></label>
        <label className="cl-field"><span>Team</span>
          <Combobox value={draft.department_id} allowClear style={{ width: '100%' }}
            options={[{ value: '', label: '— None —' }, ...departments.map(d => ({ value: d.id, label: d.name }))]}
            onChange={v => patch({ department_id: v || '' })} /></label>
      </div>
      <label className="cl-field"><span>Description</span>
        <textarea className="cl-textarea" value={draft.description} onChange={e => patch({ description: e.target.value })} /></label>

      <div className="cl-field"><span>Schedule</span>
        <RecurrenceEditor value={draft.recurrence} hideTime onChange={r => patch({ recurrence: r })} /></div>

      <div className="cl-field"><span>Assigned to</span>
        <div className="cl-assignees">
          {assignees.map(a => (
            <span className="chip" key={a.employee_id}>{a.full_name}
              <button className="chip-x" onClick={() => removeAssignee(a.employee_id)}><X size={11} /></button></span>
          ))}
          <Combobox value="" allowClear={false} placeholder="+ Add person" style={{ width: 200 }}
            options={employees.filter(e => !assignees.some(a => a.employee_id === e.id)).map(e => ({ value: e.id, label: e.full_name }))}
            onChange={v => addAssignee(v)} />
        </div>
      </div>

      <div className="cl-sections-edit">
        {draft.sections.map((s, si) => (
          <div className="cl-section-edit" key={si}>
            <div className="cl-section-edit-head">
              <input className="cl-input" placeholder="Section title" value={s.title} onChange={e => setSection(si, { title: e.target.value })} />
              <input className="cl-time" type="time" value={s.due_time} onChange={e => setSection(si, { due_time: e.target.value })} title="Due by (optional)" />
              <button className="dr-icon" onClick={() => moveSection(si, -1)}><ChevronUp size={14} /></button>
              <button className="dr-icon" onClick={() => moveSection(si, 1)}><ChevronDown size={14} /></button>
              <button className="dr-icon" onClick={() => setDraft(d => ({ ...d, sections: d.sections.filter((_, i) => i !== si) }))}><Trash2 size={14} /></button>
            </div>
            <input className="cl-input cl-sub-input" placeholder="Section help line (optional)" value={s.subtitle} onChange={e => setSection(si, { subtitle: e.target.value })} />
            <ul className="cl-items-edit">
              {s.items.map((it, ii) => (
                <li key={ii} className="cl-item-edit">
                  <input className="cl-input" placeholder="Item" value={it.title} onChange={e => setItem(si, ii, { title: e.target.value })} />
                  <input className="cl-input cl-help-input" placeholder="Help text (optional)" value={it.help_text} onChange={e => setItem(si, ii, { help_text: e.target.value })} />
                  <div className="cl-tag-toggles">
                    {CHECKLIST_TAGS.map(t => (
                      <button key={t} className={'cl-tagbtn' + ((it.tags || []).includes(t) ? ' on' : '')} onClick={() => toggleTag(si, ii, t)}>{t}</button>
                    ))}
                    <button className="dr-icon" onClick={() => setSection(si, { items: s.items.filter((_, j) => j !== ii) })}><Trash2 size={13} /></button>
                  </div>
                </li>
              ))}
            </ul>
            <button className="btn btn-ghost btn-sm" onClick={() => setSection(si, { items: [...s.items, blankItem()] })}><Plus size={13} /> Add item</button>
          </div>
        ))}
        <button className="btn btn-ghost" onClick={() => setDraft(d => ({ ...d, sections: [...d.sections, blankSection()] }))}><Plus size={14} /> Add section</button>
      </div>

      <div className="cl-editor-actions">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={save}><Check size={14} /> Save template</button>
      </div>
    </div>
  );
}
export default ChecklistTemplateEditor;
