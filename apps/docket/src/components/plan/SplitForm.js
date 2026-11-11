'use client';
// F9 R3 — split an agreed milestone or result (spec §4.3.1), super admins only. One call, one transaction
// (docket.plan_split): 2..10 new parts, every result under a milestone mapped to a part or dropped, every
// open linked task re-linked. The per-task list holds only the tasks you can open; the rest go to the
// default part (the RPC sees them all).
import { useMemo, useState } from 'react';
import { Combobox } from '@throttle/ui';
import { Plus, Trash2, Scissors } from 'lucide-react';
import { docketopsPost } from '../../lib/docketopsFetch.js';
import { Button, IconButton } from '../ui/index.js';
import { MeasureFields } from './MeasureFields.js';
import {
  newSplitForm, emptySplitChild, splitFormError, splitPayload, splitTasks, splitHiddenCount, splitTaskTargets,
  planErrorText, SPLIT_MAX, SPLIT_MIN,
} from '../../lib/plan.js';

export function SplitForm({ item, data, ownerOpts, metrics, session, showToast, onCancel, onDone }) {
  const results = useMemo(() => (item.kind === 'milestone' ? (data.children || []).filter(c => c.kind === 'result') : []), [item, data]);
  const tasks = data.tasks || [];
  const [form, setForm] = useState(() => newSplitForm(item, results));
  const [busy, setBusy] = useState(false);
  const set = (p) => setForm(f => ({ ...f, ...p }));
  const setChild = (i, p) => setForm(f => ({ ...f, children: f.children.map((c, j) => (j === i ? { ...c, ...p } : c)) }));
  const partLabel = (i) => form.children[i]?.title.trim() || `Part ${i + 1}`;
  const error = splitFormError(item, form, results, tasks);
  const relink = splitTasks(item, tasks, form);
  const hidden = splitHiddenCount(item, data.hidden_open, form);
  const targets = splitTaskTargets(form, results);
  const parts = form.children.map((_, i) => ({ value: String(i), label: partLabel(i) }));

  function removeChild(i) {
    setForm(f => {
      const children = f.children.filter((_, j) => j !== i);
      // indexes after i shift down; a mapping to i is cleared
      const shift = (v) => (/^[0-9]+$/.test(v) ? (Number(v) === i ? '' : String(Number(v) > i ? Number(v) - 1 : Number(v))) : v);
      const results2 = Object.fromEntries(Object.entries(f.results).map(([k, v]) => [k, shift(v)]));
      const tasks2 = Object.fromEntries(Object.entries(f.tasks).map(([k, v]) => [k, v.startsWith('c:') ? (shift(v.slice(2)) ? `c:${shift(v.slice(2))}` : '') : v]));
      return { ...f, children, results: results2, tasks: tasks2, tasks_default: shift(f.tasks_default) || '0' };
    });
  }
  async function submit() {
    setBusy(true);
    try {
      const res = await docketopsPost('planItemAction', { id: item.id, op: 'split', payload: splitPayload(item, form, tasks) }, session);
      const codes = (res?.children || []).map(c => c.code).join(', ');
      showToast(`${item.code} split into ${codes}`, 'success');
      onDone();
    } catch (e) { showToast(planErrorText(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="pl-op pl-split">
      <p className="pl-hint">{item.code} becomes read-only (“Split”). The new parts are agreed now; their due dates lock.</p>
      <label className="pl-field"><span className="pl-lbl">Reason *</span>
        <textarea className="pl-input pl-ta" value={form.reason} onChange={e => set({ reason: e.target.value })} /></label>

      {form.children.map((c, i) => (
        <fieldset key={i} className="pl-split-part">
          <legend className="pl-lbl">Part {i + 1}
            {form.children.length > SPLIT_MIN && <IconButton icon={Trash2} size="sm" label={`Remove part ${i + 1}`} onClick={() => removeChild(i)} />}
          </legend>
          <input className="pl-input" placeholder="Title *" value={c.title} onChange={e => setChild(i, { title: e.target.value })} />
          <Combobox value={c.owner_employee_id} options={ownerOpts} placeholder="Owner *" allowClear={false} portal
            onChange={v => setChild(i, { owner_employee_id: v || '' })} style={{ width: '100%' }} />
          <input type="date" className="pl-input" aria-label={`Part ${i + 1} due date`} value={c.due_date} onChange={e => setChild(i, { due_date: e.target.value })} />
          <textarea className="pl-input pl-ta" placeholder="Done when *" value={c.done_when} onChange={e => setChild(i, { done_when: e.target.value })} />
          <MeasureFields value={c.measure} metrics={metrics} onChange={m => setChild(i, { measure: m })} />
        </fieldset>
      ))}
      {form.children.length < SPLIT_MAX && (
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => set({ children: [...form.children, { ...emptySplitChild(), owner_employee_id: item.owner_employee_id || '' }] })}>Add a part</Button>
      )}

      {results.length > 0 && (
        <div className="pl-split-map">
          <span className="pl-lbl">Results under {item.code} — each goes to a part</span>
          {results.map(r => {
            const isLive = r.state === 'proposed' || r.state === 'agreed';
            return (
              <div key={r.id} className="pl-split-row">
                <span className="pl-code">{r.code}</span><span className="pl-kid-t">{r.title}</span>
                <select className="pl-input" aria-label={`Where ${r.code} goes`} value={form.results[r.id] || ''}
                  onChange={e => set({ results: { ...form.results, [r.id]: e.target.value } })}>
                  <option value="">{isLive ? 'Pick…' : `Default (${partLabel(Number(form.tasks_default) || 0)})`}</option>
                  {parts.map(p => <option key={p.value} value={p.value}>→ {p.label}</option>)}
                  {isLive && <option value="drop">Drop it</option>}
                </select>
              </div>
            );
          })}
          {Object.values(form.results).includes('drop') && (
            <label className="pl-field"><span className="pl-lbl">Why the dropped results are dropped *</span>
              <textarea className="pl-input pl-ta" value={form.result_drop_reason} onChange={e => set({ result_drop_reason: e.target.value })} /></label>
          )}
        </div>
      )}

      <div className="pl-split-map">
        <span className="pl-lbl">Linked open tasks</span>
        <label className="pl-split-row"><span className="pl-kid-t">Default part for linked tasks</span>
          <select className="pl-input" value={form.tasks_default} onChange={e => set({ tasks_default: e.target.value })}>
            {parts.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        {relink.map(t => (
          <div key={t.id} className="pl-split-row">
            <span className="pl-code">{t.task_no}</span><span className="pl-kid-t">{t.title}</span>
            <select className="pl-input" aria-label={`Where ${t.task_no} goes`} value={form.tasks[t.id] || ''}
              onChange={e => set({ tasks: { ...form.tasks, [t.id]: e.target.value } })}>
              <option value="">Default ({partLabel(Number(form.tasks_default) || 0)})</option>
              {targets.map(o => <option key={o.value} value={o.value}>→ {o.label}</option>)}
            </select>
          </div>
        ))}
        {relink.length === 0 && !hidden && <span className="pl-muted">No open tasks to re-link.</span>}
        {hidden > 0 && <span className="pl-muted">+{hidden} in spaces you can’t open will go to {partLabel(Number(form.tasks_default) || 0)}.</span>}
        <small className="pl-hint">Done and abandoned tasks keep their link to {item.code}.</small>
      </div>

      {error && <small className="pl-hint pl-warn">{error}</small>}
      <div className="pl-save">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="sm" icon={Scissors} loading={busy} disabled={!!error} onClick={submit}>Split {item.code}</Button>
      </div>
    </div>
  );
}

export default SplitForm;
