'use client';
// /plan side panel (F9 R1): create an item, or open one to edit its fields, run the lifecycle actions
// the matrix allows (lib/plan.js — the database enforces the same matrix) and read its history.
// Fixed right panel, no backdrop: the register stays usable behind it (the .tv-side pattern).
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Combobox, useToast } from '@throttle/ui';
import { X, Lock, Check, History } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../lib/docketopsFetch.js';
import { Button, Pill } from '../ui/index.js';
import {
  planFlags, editableFields, planActionsFor, chipState, effectiveDue, isRedated, fmtPlanDate, fmtPlanStamp,
  planErrorText, historyText, KIND_LABEL, ACTION_LABEL,
} from '../../lib/plan.js';

const EDIT_KEYS = ['title', 'code', 'owner_employee_id', 'done_when', 'target_text', 'due_date', 'restricted'];
const draftOf = (it) => ({
  title: it.title || '', code: it.code || '', owner_employee_id: it.owner_employee_id || '',
  done_when: it.done_when || '', target_text: it.target_text || '', due_date: it.due_date || '',
  restricted: !!it.restricted,
});
// Only the keys that changed; '' clears.
function patchOf(item, draft, editable) {
  const base = draftOf(item);
  const out = {};
  for (const k of EDIT_KEYS) {
    if (!editable.includes(k) || draft[k] === base[k]) continue;
    out[k] = typeof draft[k] === 'string' ? (draft[k].trim() === '' ? null : draft[k].trim()) : draft[k];
  }
  return out;
}

function Field({ label, children, hint }) {
  return (
    <label className="pl-field">
      <span className="pl-lbl">{label}</span>
      {children}
      {hint && <small className="pl-hint">{hint}</small>}
    </label>
  );
}
function ReadValue({ children }) { return <div className="pl-read">{children || <span className="pl-muted">—</span>}</div>; }

export function PlanPanel({ target, isSuper, employeeId, byId, employees, session, onClose, onChanged, onOpen }) {
  const { showToast } = useToast();
  const ownerOpts = useMemo(() => (employees || []).map(e => ({ value: e.id, label: e.full_name })), [employees]);
  const nameOf = useMemo(() => Object.fromEntries((employees || []).map(e => [e.id, e.full_name])), [employees]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.querySelector('.ui-pop, .pop')) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { ae.blur(); return; }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="pl-panel" aria-label="Plan item">
      {target.mode === 'new'
        ? <NewItem key={`new-${target.kind}-${target.parent?.id || ''}`} target={target} isSuper={isSuper} ownerOpts={ownerOpts}
            session={session} showToast={showToast} onClose={onClose}
            onCreated={(id) => { onChanged(); onOpen(id); }} />
        : <ItemView key={target.id} id={target.id} isSuper={isSuper} employeeId={employeeId} byId={byId} ownerOpts={ownerOpts}
            nameOf={nameOf} session={session} showToast={showToast} onClose={onClose} onChanged={onChanged} onOpen={onOpen} />}
    </aside>
  );
}

function Head({ kind, code, onClose, children }) {
  return (
    <div className="pl-panel-head">
      <span className="pl-panel-kind">{KIND_LABEL[kind] || 'Item'}</span>
      {code && <span className="pl-code">{code}</span>}
      <span className="pl-panel-sp">{children}</span>
      <button type="button" className="pl-x" aria-label="Close" onClick={onClose}><X size={16} /></button>
    </div>
  );
}

// ── create ───────────────────────────────────────────────────────────────────
function NewItem({ target, isSuper, ownerOpts, session, showToast, onClose, onCreated }) {
  const { kind, parent } = target;
  const [d, setD] = useState({ title: '', code: '', owner_employee_id: '', done_when: '', due_date: '', target_text: '', restricted: false, agreeNow: true });
  const [busy, setBusy] = useState(false);
  const set = (p) => setD(x => ({ ...x, ...p }));
  const dated = kind !== 'theme';

  async function create() {
    const data = { kind, title: d.title.trim() };
    if (parent) data.parent_id = parent.id;
    if (d.owner_employee_id) data.owner_employee_id = d.owner_employee_id;
    if (dated && d.done_when.trim()) data.done_when = d.done_when.trim();
    if (dated && d.due_date) data.due_date = d.due_date;
    if (isSuper && d.code.trim()) data.code = d.code.trim();
    if (isSuper && d.target_text.trim()) data.target_text = d.target_text.trim();
    if (isSuper && kind === 'theme' && d.restricted) data.restricted = true;
    if (kind === 'milestone') data.state = d.agreeNow ? 'agreed' : 'proposed';
    setBusy(true);
    try {
      const res = await docketopsPost('createPlanItem', { data }, session);
      showToast(`${KIND_LABEL[kind]} ${res?.code || ''} created`, 'success');
      onCreated(res?.id);
    } catch (e) { showToast(planErrorText(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Head kind={kind} onClose={onClose}>New{parent ? <> under <b>{parent.code}</b></> : null}</Head>
      <div className="pl-panel-body">
        <Field label="Title *"><input className="pl-input" autoFocus value={d.title} onChange={e => set({ title: e.target.value })} /></Field>
        {isSuper && <Field label="Code" hint="Leave blank for the next code"><input className="pl-input mono" value={d.code} placeholder="auto" onChange={e => set({ code: e.target.value })} /></Field>}
        <Field label={kind === 'theme' ? 'Owner (blank = both founders)' : 'Owner *'}>
          <Combobox value={d.owner_employee_id} options={ownerOpts} placeholder="Pick a person…" allowClear portal
            onChange={v => set({ owner_employee_id: v || '' })} style={{ width: '100%' }} />
        </Field>
        {dated && <Field label={kind === 'result' || d.agreeNow ? 'Done when *' : 'Done when'}>
          <textarea className="pl-input pl-ta" value={d.done_when} onChange={e => set({ done_when: e.target.value })} /></Field>}
        {dated && <Field label={kind === 'result' || d.agreeNow ? 'Due date *' : 'Due date'}>
          <input type="date" className="pl-input" value={d.due_date} onChange={e => set({ due_date: e.target.value })} /></Field>}
        {isSuper && <Field label="Target"><textarea className="pl-input pl-ta" value={d.target_text} onChange={e => set({ target_text: e.target.value })} /></Field>}
        {isSuper && kind === 'theme' && (
          <label className="pl-check"><input type="checkbox" checked={d.restricted} onChange={e => set({ restricted: e.target.checked })} />
            <Lock size={13} aria-hidden /> Restricted — founders only, the whole theme</label>
        )}
        {kind === 'milestone' && (
          <label className="pl-check"><input type="checkbox" checked={d.agreeNow} onChange={e => set({ agreeNow: e.target.checked })} />
            Agreed now (the due date locks)</label>
        )}
        {kind === 'result' && <p className="pl-hint">A result is agreed when it’s created; its due date then changes only by Re-date.</p>}
      </div>
      <div className="pl-panel-foot">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" icon={Check} loading={busy} disabled={!d.title.trim()} onClick={create}>Create {KIND_LABEL[kind].toLowerCase()}</Button>
      </div>
    </>
  );
}

// ── open an item ─────────────────────────────────────────────────────────────
function ItemView({ id, isSuper, employeeId, byId, ownerOpts, nameOf, session, showToast, onClose, onChanged, onOpen }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [op, setOp] = useState(null);           // the action whose form is open
  const [form, setForm] = useState({});

  const load = useCallback(async () => {
    try {
      const r = await docketopsGet('getPlanItem', { id }, session);
      setData(r); setDraft(draftOf(r.item));
    } catch (e) { showToast(planErrorText(e), 'error'); onClose(); }
  }, [id, session, showToast, onClose]);
  useEffect(() => { load(); }, [load]);

  if (!data || !draft) return <><Head onClose={onClose} /><div className="pl-panel-body pl-muted">Loading…</div></>;
  const it = data.item;
  const flags = planFlags(it, { isSuper, employeeId, byId: { ...byId, [it.id]: it } });
  const editable = editableFields(it, flags);
  const actions = planActionsFor(it, flags);
  const patch = patchOf(it, draft, editable);
  const dirty = Object.keys(patch).length > 0;
  const can = (k) => editable.includes(k);
  const set = (p) => setDraft(x => ({ ...x, ...p }));
  const chip = chipState(it);
  const names = { ...nameOf, ...(it.owner_employee_id ? { [it.owner_employee_id]: it.owner_name } : {}) };

  async function save() {
    setBusy(true);
    try {
      await docketopsPost('updatePlanItem', { id: it.id, patch }, session);
      showToast('Saved', 'success'); await load(); onChanged();
    } catch (e) { showToast(planErrorText(e), 'error'); }
    finally { setBusy(false); }
  }
  function openOp(a) {
    setOp(a);
    setForm(a === 'agree'
      ? { owner_employee_id: draft.owner_employee_id, due_date: draft.due_date, done_when: draft.done_when }
      : a === 'redate' ? { due_date: effectiveDue(it) || '', reason: '' } : { text: '' });
  }
  async function runOp() {
    const payload = op === 'agree' ? { owner_employee_id: form.owner_employee_id || undefined, due_date: form.due_date || undefined, done_when: form.done_when || undefined }
      : op === 'redate' ? { due_date: form.due_date, reason: form.reason }
      : op === 'done' ? { evidence: form.text } : { reason: form.text };
    setBusy(true);
    try {
      await docketopsPost('planItemAction', { id: it.id, op, payload }, session);
      showToast(`${ACTION_LABEL[op]} — done`, 'success'); setOp(null); await load(); onChanged();
    } catch (e) { showToast(planErrorText(e), 'error'); }
    finally { setBusy(false); }
  }
  const opReady = op === 'agree' ? !!(form.owner_employee_id && form.due_date && (form.done_when || '').trim())
    : op === 'redate' ? !!(form.due_date && (form.reason || '').trim()) : !!(form.text || '').trim();

  return (
    <>
      <Head kind={it.kind} code={it.code} onClose={onClose}>
        <Pill tone="status" color={chip.color}>{chip.label}</Pill>
        {it.restricted && <Lock size={13} className="pl-lock" aria-label="Restricted" />}
      </Head>
      <div className="pl-panel-body">
        <Field label="Title">{can('title')
          ? <input className="pl-input" value={draft.title} onChange={e => set({ title: e.target.value })} />
          : <ReadValue>{it.title}</ReadValue>}</Field>
        {can('code') && <Field label="Code"><input className="pl-input mono" value={draft.code} onChange={e => set({ code: e.target.value })} /></Field>}
        <Field label="Owner">{can('owner_employee_id')
          ? <Combobox value={draft.owner_employee_id} options={ownerOpts} placeholder="Pick a person…" allowClear={it.kind === 'theme'} portal
              onChange={v => set({ owner_employee_id: v || '' })} style={{ width: '100%' }} />
          : <ReadValue>{it.owner_name || (it.kind === 'theme' ? 'Both founders' : '')}</ReadValue>}</Field>
        {it.kind !== 'theme' && <Field label="Done when">{can('done_when')
          ? <textarea className="pl-input pl-ta" value={draft.done_when} onChange={e => set({ done_when: e.target.value })} />
          : <ReadValue>{it.done_when}</ReadValue>}</Field>}
        {it.kind !== 'theme' && <Field label="Due date" hint={it.state === 'proposed' ? 'A proposal’s date is a draft until it’s agreed.' : undefined}>
          {can('due_date')
            ? <input type="date" className="pl-input" value={draft.due_date} onChange={e => set({ due_date: e.target.value })} />
            : <ReadValue>{fmtPlanDate(effectiveDue(it))}{isRedated(it) && <> <Pill className="pl-redated">Re-dated</Pill> <span className="pl-muted">was {fmtPlanDate(it.due_date)}</span></>}</ReadValue>}
        </Field>}
        {(isSuper || it.target_text) && <Field label="Target">{can('target_text')
          ? <textarea className="pl-input pl-ta" value={draft.target_text} onChange={e => set({ target_text: e.target.value })} />
          : <ReadValue>{it.target_text}</ReadValue>}</Field>}
        {can('restricted') && (
          <label className="pl-check"><input type="checkbox" checked={draft.restricted} onChange={e => set({ restricted: e.target.checked })} />
            <Lock size={13} aria-hidden /> Restricted — founders only, the whole theme</label>
        )}
        {it.done_evidence && <Field label="Done — evidence"><ReadValue>{it.done_evidence}</ReadValue></Field>}
        {it.drop_reason && <Field label="Dropped — reason"><ReadValue>{it.drop_reason}</ReadValue></Field>}
        {dirty && (
          <div className="pl-save">
            <Button variant="ghost" size="sm" onClick={() => setDraft(draftOf(it))} disabled={busy}>Discard</Button>
            <Button variant="primary" size="sm" icon={Check} loading={busy} onClick={save}>Save changes</Button>
          </div>
        )}

        {actions.length > 0 && (
          <div className="pl-acts">
            <span className="pl-lbl">Actions</span>
            <div className="pl-acts-row">
              {actions.map(a => (
                <Button key={a} size="sm" variant={a === 'drop' ? 'danger' : 'neutral'} aria-pressed={op === a}
                  onClick={() => (op === a ? setOp(null) : openOp(a))}>{ACTION_LABEL[a]}</Button>
              ))}
            </div>
            {op && (
              <div className="pl-op">
                {op === 'agree' && <>
                  <Field label="Owner *"><Combobox value={form.owner_employee_id || ''} options={ownerOpts} placeholder="Pick a person…" allowClear={false} portal
                    onChange={v => setForm(f => ({ ...f, owner_employee_id: v || '' }))} style={{ width: '100%' }} /></Field>
                  <Field label="Due date * (locks on agree)"><input type="date" className="pl-input" value={form.due_date || ''} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} /></Field>
                  <Field label="Done when *"><textarea className="pl-input pl-ta" value={form.done_when || ''} onChange={e => setForm(f => ({ ...f, done_when: e.target.value }))} /></Field>
                </>}
                {op === 'redate' && <>
                  <Field label="New due date *"><input type="date" className="pl-input" value={form.due_date || ''} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} /></Field>
                  <Field label="Reason *"><textarea className="pl-input pl-ta" value={form.reason || ''} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} /></Field>
                </>}
                {(op === 'drop' || op === 'reopen' || op === 'done') && (
                  <Field label={op === 'done' ? 'Evidence *' : 'Reason *'}>
                    <textarea className="pl-input pl-ta" autoFocus value={form.text || ''} onChange={e => setForm(f => ({ ...f, text: e.target.value }))}
                      placeholder={op === 'done' ? 'What shows it is done — a link, a number, a note' : ''} />
                  </Field>
                )}
                <div className="pl-save">
                  <Button variant="ghost" size="sm" onClick={() => setOp(null)} disabled={busy}>Cancel</Button>
                  <Button variant={op === 'drop' ? 'danger' : 'primary'} size="sm" loading={busy} disabled={!opReady} onClick={runOp}>{ACTION_LABEL[op]}</Button>
                </div>
              </div>
            )}
          </div>
        )}

        {data.children?.length > 0 && (
          <div className="pl-kids">
            <span className="pl-lbl">{it.kind === 'theme' ? 'Milestones' : 'Results'}</span>
            {data.children.map(c => {
              const cc = chipState(c);
              return (
                <button key={c.id} type="button" className="pl-kid" onClick={() => onOpen(c.id)}>
                  <span className="pl-code">{c.code}</span><span className="pl-kid-t">{c.title}</span>
                  <Pill tone="status" color={cc.color}>{cc.label}</Pill>
                </button>
              );
            })}
          </div>
        )}

        <div className="pl-hist">
          <span className="pl-lbl"><History size={12} aria-hidden /> History</span>
          {(data.history || []).length === 0 && <span className="pl-muted">No history visible.</span>}
          <ul>
            {(data.history || []).map(h => (
              <li key={h.id}>
                <span className="pl-hist-t">{historyText(h, names)}</span>
                {h.note && <span className="pl-hist-note">“{h.note}”</span>}
                <span className="pl-hist-m">{h.actor_name || 'Someone'} · {fmtPlanStamp(h.at)} IST</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

export default PlanPanel;
