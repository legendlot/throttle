'use client';
// Create/edit a structured checklist template: sections → items (+ tags), schedule
// (time-optional), role label, department, and assignees. RULE-DOCKET-009.
// F8 P2: a kind switch — Routine (the above) or Record (copied per product / launch, ticked once): a record
// template has no schedule, chart type or assignees. The kind is fixed once saved (the worker: kind_locked).
import { useEffect, useState, useCallback } from 'react';
import { Combobox, useToast } from '@throttle/ui';
import { Plus, Trash2, ChevronUp, ChevronDown, Check, X } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../lib/docketopsFetch.js';
import { RecurrencePopover } from './RecurrencePopover.js';
import { CHECKLIST_TAGS } from './TagPill.js';
import { isValidTemplateRecurrence } from '../lib/recurrence.js';
import { recordErrorText } from '../lib/records.js';
import { SegmentedTabs, Button, IconButton } from './ui/index.js';

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
      setDraft({ id: null, kind: 'routine', name: '', role_label: '', department_id: '', description: '', recurrence: { freq: 'daily' }, run_scope: 'per_person', sections: [blankSection()] });
      setAssignees([]);
      return;
    }
    docketopsGet('getChecklistTemplate', { id: templateId }, session).then(t => {
      setDraft({
        id: t.id, kind: t.kind || 'routine', version: t.version || 1, name: t.name || '', role_label: t.role_label || '', department_id: t.department_id || '',
        description: t.description || '', recurrence: t.recurrence || { freq: 'daily' }, run_scope: t.run_scope || 'per_person',
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
    const isRecord = draft.kind === 'record';
    if (!isRecord && !isValidTemplateRecurrence(draft.recurrence)) { showToast('Pick a valid schedule', 'error'); return; }
    setBusy(true);
    let newId = null;
    try {
      const res = await docketopsPost('saveChecklistTemplate', {
        id: draft.id, kind: draft.kind, name: draft.name.trim(), role_label: draft.role_label || null,
        department_id: draft.department_id || null, description: draft.description || null,
        ...(isRecord ? {} : { recurrence: draft.recurrence, run_scope: draft.run_scope }),
        sections: draft.sections.map(s => ({ id: s.id, title: s.title, subtitle: s.subtitle || null, due_time: s.due_time || null, items: s.items.map(i => ({ id: i.id, title: i.title, help_text: i.help_text || null, tags: i.tags || [] })) })),
      }, session);
      newId = res?.id || draft.id;
      if (isNew && newId && !isRecord) {
        for (const a of assignees) { await docketopsPost('assignChecklistTemplate', { template_id: newId, employee_id: a.employee_id }, session); }
      }
      showToast(res?.version_failed || res?.history_failed ? 'Saved (the change log didn’t record it)' : 'Saved', 'success'); onSaved();
    } catch (e) {
      // A refusal after the template row exists carries its id: close the editor so a retry edits it, not a copy.
      if (e?.detail?.id && e.detail.partial) { showToast(`Saved partly — reopen the template to check it (${recordErrorText(e)})`, 'error'); onSaved(); }
      // The template saved but an assignee didn't: close, so a retry edits it rather than making a second copy.
      else if (isNew && newId) { showToast(`Saved, but an assignee wasn't added — reopen the template to check (${recordErrorText(e)})`, 'error'); onSaved(); }
      else showToast(recordErrorText(e), 'error');
    }
    finally { setBusy(false); }
  }

  if (!draft) return null;
  const isRecord = draft.kind === 'record';
  return (
    <div className="cl-editor">
      <div className="cl-field"><span>Kind</span>
        {isNew ? (
          <SegmentedTabs label="Kind" value={draft.kind} onChange={v => patch({ kind: v })}
            tabs={[{ value: 'routine', label: 'Routine' }, { value: 'record', label: 'Record' }]} />
        ) : <b className="cl-sub">{isRecord ? `Record · v${draft.version}` : 'Routine'}</b>}
        <small className="cl-hint">{isRecord
          ? 'Copied once per product or launch and ticked once. Editing items later bumps the version; open records are offered the new items.'
          : 'Repeats on a schedule for the people assigned, ticked every time it is due.'}</small></div>
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

      {!isRecord && <>
      <div className="cl-field"><span>Schedule</span>
        <RecurrencePopover value={draft.recurrence} hideTime onChange={r => patch({ recurrence: r })} /></div>

      {/* F8 C1: a shared chart is ONE register per date (a washroom, a line) — any assignee ticks it. */}
      <div className="cl-field"><span>Chart</span>
        <SegmentedTabs label="Chart" value={draft.run_scope} onChange={v => patch({ run_scope: v })}
          tabs={[{ value: 'per_person', label: 'Each person their own' }, { value: 'shared', label: 'One shared chart' }]} />
        <small className="cl-hint">{draft.run_scope === 'shared'
          ? 'One chart for everyone assigned. Whoever ticks an item ticks it for the day, and the tick records who.'
          : 'Every assignee keeps their own chart and ticks only their own.'}</small></div>

      <div className="cl-field"><span>Assigned to</span>
        <div className="cl-assignees">
          {assignees.map(a => (
            <span className="cl-chip" key={a.employee_id}>{a.full_name}
              <button className="chip-x" aria-label={`Remove ${a.full_name}`} onClick={() => removeAssignee(a.employee_id)}><X size={11} /></button></span>
          ))}
          <Combobox value="" allowClear={false} placeholder="+ Add person" style={{ width: 200 }}
            options={employees.filter(e => !assignees.some(a => a.employee_id === e.id)).map(e => ({ value: e.id, label: e.full_name }))}
            onChange={v => addAssignee(v)} />
        </div>
      </div>
      </>}

      <div className="cl-sections-edit">
        {draft.sections.map((s, si) => (
          <div className="cl-section-edit" key={si}>
            <div className="cl-section-edit-head">
              <input className="cl-input" placeholder="Section title" value={s.title} onChange={e => setSection(si, { title: e.target.value })} />
              {!isRecord && <input className="cl-time" type="time" value={s.due_time} onChange={e => setSection(si, { due_time: e.target.value })} title="Due by (optional)" />}
              <IconButton icon={ChevronUp} size="sm" label="Move section up" onClick={() => moveSection(si, -1)} />
              <IconButton icon={ChevronDown} size="sm" label="Move section down" onClick={() => moveSection(si, 1)} />
              <IconButton icon={Trash2} size="sm" label="Remove section" onClick={() => setDraft(d => ({ ...d, sections: d.sections.filter((_, i) => i !== si) }))} />
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
                    <IconButton icon={Trash2} size="sm" label="Remove item" onClick={() => setSection(si, { items: s.items.filter((_, j) => j !== ii) })} />
                  </div>
                </li>
              ))}
            </ul>
            <Button variant="ghost" size="sm" icon={Plus} className="cl-additem" onClick={() => setSection(si, { items: [...s.items, blankItem()] })}>Add item</Button>
          </div>
        ))}
        <Button variant="neutral" icon={Plus} className="cl-additem" onClick={() => setDraft(d => ({ ...d, sections: [...d.sections, blankSection()] }))}>Add section</Button>
      </div>

      <div className="cl-editor-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" icon={Check} loading={busy} disabled={!draft.name.trim()} onClick={save}>Save template</Button>
      </div>
    </div>
  );
}
export default ChecklistTemplateEditor;
