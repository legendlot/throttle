'use client';
// /checklist/record/?id=… — one record checklist (F8 P2, spec 2026-11-11-docket-checklists-v2.md §3.2–3.3):
// header (title, product, owner, space, template + version, progress, archive), the "template has N new items"
// banner (C3), Linked tasks, then sections → items. Each item: ✓ / N/A (anyone who can see the record — C6),
// who ticked and when, a note, Create task (→ the capture line, prefilled), the spun-out task's chip, and the
// C4 "DKT-123 is done — tick this?" suggestion (never an auto-tick). The worker decides every right; this page
// only hides controls the answer says you don't have.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Check, Ban, Archive, ArchiveRestore, Plus, X, ArrowLeft, SquarePen, EyeOff, RefreshCw, ClipboardCheck } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { groupSections, recordProgress, progressLabel, RECORD_STATUS, recordErrorText, createTaskErrorText, tickSuggestion } from '../../../../lib/records.js';
import { STATUS_MAP } from '../../../../lib/tasks.js';
import { Button, IconButton, EmptyState } from '../../../../components/ui/index.js';
import { ProgressBar } from '../../../../components/ChecklistRecords.js';

const fmtWhen = (iso) => (iso ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) : '');
const HIST = {
  created: 'created the record', items_copied: 'copied the template’s items', item_done: 'ticked', item_na: 'marked N/A', item_reopened: 're-opened', item_note: 'edited the note on',
  item_added: 'added an item', template_pulled: 'added the template’s new items', item_task_created: 'made a task from',
  task_linked: 'linked a task', task_unlinked: 'unlinked a task', record_completed: 'completed the record', record_reopened: 're-opened the record',
  title_changed: 'renamed the record', product_changed: 'changed the product', owner_changed: 'changed the owner', archived: 'archived the record', unarchived: 'un-archived the record',
};

function ItemRow({ item, rec, busy, onState, onNote, onCreateTask, router }) {
  const [note, setNote] = useState(item.note || '');
  const [capture, setCapture] = useState(null);   // the capture line's text while open
  useEffect(() => { setNote(item.note || ''); }, [item.note]);
  const canTick = rec._can_tick;
  const suggestion = tickSuggestion(item);
  const st = item.task && !item.task.hidden ? STATUS_MAP[item.task.status] : null;
  return (
    <li className={'cl-item has-help rc-item' + (item.state !== 'open' ? ' done' : '')}>
      <button className={'cl-check' + (item.state === 'done' ? ' on' : '')} disabled={!canTick || busy} aria-pressed={item.state === 'done'}
        aria-label={item.state === 'done' ? 'Mark not done' : 'Mark done'} onClick={() => onState(item, item.state === 'done' ? 'open' : 'done')}>
        {item.state === 'done' && <Check size={12} strokeWidth={3} />}
      </button>
      <span className="cl-item-text">
        <span className="cl-item-title">{item.title}</span>
        {item.help_text && <span className="cl-item-help">{item.help_text}</span>}
        {item.state === 'na' && <span className="rc-na">N/A — {item.na_reason}</span>}
        {item.state !== 'open' && item.done_at && <span className="cl-done-at">{item.state === 'na' ? 'N/A' : 'Done'} · {fmtWhen(item.done_at)}{item.done_by_name ? ` · ${item.done_by_name}` : ''}</span>}
        {item.no_longer_in_template && <span className="cl-hint">No longer in template</span>}
        {suggestion && canTick && <button type="button" className="rc-suggest" disabled={busy} onClick={() => onState(item, 'done')}><Check size={12} /> {suggestion}</button>}
        {capture != null && (
          <span className="rc-capture">
            <input className="cl-input" autoFocus value={capture} maxLength={300} aria-label="New task title" onChange={e => setCapture(e.target.value)}
              onKeyDown={async e => { if (e.key === 'Escape') setCapture(null); if (e.key === 'Enter' && capture.trim()) { if (await onCreateTask(item, capture.trim())) setCapture(null); } }} />
            <Button size="sm" variant="primary" disabled={busy || !capture.trim()} onClick={async () => { if (await onCreateTask(item, capture.trim())) setCapture(null); }}>Create task</Button>
            <IconButton icon={X} size="sm" label="Cancel" onClick={() => setCapture(null)} />
          </span>
        )}
        {canTick && <textarea className="rc-note" rows={1} placeholder="Note" value={note} aria-label="Note" maxLength={2000}
          onChange={e => setNote(e.target.value)} onBlur={() => { if (note !== (item.note || '')) onNote(item, note); }} />}
        {!canTick && item.note && <span className="cl-item-help">{item.note}</span>}
      </span>
      <span className="cl-item-meta">
        {item.task && (item.task.hidden
          ? <span className="cl-sub"><EyeOff size={12} aria-hidden /> a task you can’t see</span>
          : <button type="button" className="rc-task" onClick={() => router.push(`/tasks/detail/?id=${item.task.id}`)} title={item.task.title}>
              <span className="dp-dot" style={{ background: st?.color || 'var(--text-4)' }} />
              <span className="dp-no">{item.task.task_no}</span>
              {item.task.owner_name && <span className="cl-sub">{item.task.owner_name}</span>}
              <span className="cl-sub">{st?.label || item.task.status}</span>
            </button>)}
        {canTick && item.state === 'open' && !item.task && capture == null && (
          <Button size="sm" variant="ghost" icon={SquarePen} onClick={() => setCapture(`${item.title} — ${rec.title}`)}>Create task</Button>)}
        {canTick && (item.state === 'na'
          ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onState(item, 'open')}>Undo N/A</Button>
          : item.state === 'open' && <Button size="sm" variant="ghost" icon={Ban} disabled={busy} onClick={() => onState(item, 'na')}>N/A</Button>)}
      </span>
    </li>
  );
}

function RecordInner() {
  const { session } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const id = useSearchParams().get('id');
  const [rec, setRec] = useState(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [products, setProducts] = useState([]);
  const [titleDraft, setTitleDraft] = useState('');
  const [adding, setAdding] = useState(null);   // { title, section_title }

  // Only the latest request for the CURRENT id may land (a slow answer for the previous record, or an older
  // reload racing a newer one, is dropped); switching records clears the page first.
  const reqRef = useRef(0);
  const load = useCallback(async () => {
    if (!session || !id) return;
    const token = ++reqRef.current;
    try {
      const r = await docketopsGet('getChecklistRecord', { id }, session);
      if (token !== reqRef.current || r?.id !== id) return;
      setRec(r); setTitleDraft(r.title); setMissing(false);
    } catch (e) {
      if (token !== reqRef.current) return;
      if (/not_found/.test(e.message || '')) setMissing(true); else showToast(e.message || 'Failed to load', 'error');
    }
  }, [session, id, showToast]);
  useEffect(() => { setRec(null); setMissing(false); setAdding(null); }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session || !rec?._can_edit) return;
    Promise.all([docketopsGet('getEmployees', {}, session).catch(() => []), docketopsGet('getChecklistProducts', {}, session).catch(() => [])])
      .then(([e, p]) => { setEmployees(e || []); setProducts(p || []); });
  }, [session, rec?._can_edit]);

  const sections = useMemo(() => groupSections(rec?.items || []), [rec?.items]);
  const progress = useMemo(() => recordProgress(rec?.items || []), [rec?.items]);

  async function act(action, body, okText) {
    setBusy(true);
    try { const r = await docketopsPost(action, body, session); if (okText) showToast(okText, 'success'); await load(); return r || true; }
    catch (e) { showToast(recordErrorText(e), 'error'); await load(); return null; }
    finally { setBusy(false); }
  }
  async function setState(item, state) {
    let na_reason;
    if (state === 'na') {
      na_reason = window.prompt('Why doesn’t this apply? (e.g. “No new tooling needed”)');
      if (na_reason == null) return;
      if (!na_reason.trim()) { showToast('Say briefly why it doesn’t apply', 'error'); return; }
    }
    // optimistic: the tick shows at once; load() brings the record's own status (the DB completes it).
    setRec(r => ({ ...r, items: r.items.map(i => i.id === item.id ? { ...i, state, na_reason: na_reason || null, suggest_tick: false } : i) }));
    const res = await act('setRecordItemState', { item_id: item.id, state, ...(na_reason ? { na_reason: na_reason.trim() } : {}) });
    if (res?.record_status === 'complete' && rec.status !== 'complete') showToast('Every item is done — record complete', 'success');
  }
  const saveNote = (item, note) => act('setRecordItemState', { item_id: item.id, note });
  const createTask = async (item, title) => {
    setBusy(true);
    try {
      const r = await docketopsPost('createTaskFromRecordItem', { item_id: item.id, title }, session);
      if (r?.task_no) showToast(`Created ${r.task_no}`, 'success');
      return true;
    } catch (e) {
      // A task was made but something after it failed (lost race / link) — say which task exists.
      showToast(createTaskErrorText(e), 'error');
      return !!e?.detail?.task_no;
    } finally { setBusy(false); await load(); }
  };
  const saveField = (field, value) => act('updateChecklistRecord', { id: rec.id, [field]: value });

  if (!id || missing) return <EmptyState icon={ClipboardCheck} title="Record not found" body="It isn’t there, or it lives in a space you can’t open." />;
  if (!rec) return <Spinner />;
  const canEdit = rec._can_edit;
  const st = RECORD_STATUS[rec.status];

  return (
    <div className="screen checklist rc-page">
      <div className="rc-top">
        <IconButton icon={ArrowLeft} size="sm" label="Back to records" onClick={() => router.push('/checklist/?tab=records')} />
        {canEdit && rec.status !== 'archived'
          ? <input className="rc-title-input" value={titleDraft} maxLength={200} aria-label="Record title" onChange={e => setTitleDraft(e.target.value)}
              onBlur={() => { const t = titleDraft.trim(); if (t && t !== rec.title) saveField('title', t); else setTitleDraft(rec.title); }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          : <h1 className="rc-title">{rec.title}</h1>}
        <span className="rc-status" style={{ color: st?.color }}>{st?.label || rec.status}</span>
        {canEdit && (rec.status === 'archived'
          ? <Button size="sm" icon={ArchiveRestore} disabled={busy} onClick={() => saveField('archived', false)}>Un-archive</Button>
          : <Button size="sm" variant="ghost" icon={Archive} disabled={busy} onClick={() => { if (window.confirm('Archive this record? It stays readable; ticking stops.')) saveField('archived', true); }}>Archive</Button>)}
      </div>

      <div className="rc-meta">
        <span className="rc-meta-f"><span>Product</span>{canEdit
          ? <Combobox value={rec.product || ''} allowClear placeholder="Not in the catalog yet" style={{ width: 200 }} options={products.map(p => ({ value: p, label: p }))} onChange={v => saveField('product', v || null)} />
          : <b>{rec.product || '—'}</b>}</span>
        <span className="rc-meta-f"><span>Owner</span>{canEdit
          ? <Combobox value={rec.owner_employee_id || ''} allowClear style={{ width: 200 }} options={employees.map(e => ({ value: e.id, label: e.full_name }))} onChange={v => saveField('owner_employee_id', v || null)} />
          : <b>{rec.owner_name || '—'}</b>}</span>
        <span className="rc-meta-f"><span>Space</span><b>{rec.space?.name}</b></span>
        <span className="rc-meta-f"><span>Template</span><b>{rec.template?.name || '—'} · v{rec.template_version}</b></span>
        <span className="rc-meta-f"><span>Progress</span><ProgressBar progress={progress} /><b>{progressLabel(progress)}</b></span>
      </div>

      {rec.template_has_updates && (
        <div className="rc-banner">
          <RefreshCw size={14} aria-hidden />
          Template has {rec.template_updates.new_items} new item{rec.template_updates.new_items === 1 ? '' : 's'} — add them? Nothing already ticked changes.
          <Button size="sm" variant="primary" disabled={busy} onClick={() => act('pullTemplateUpdates', { record_id: rec.id }, 'Template items added')}>Add them</Button>
        </div>
      )}

      <section className="cl-group">
        <div className="tv-sh">Linked tasks</div>
        {!rec.linked_tasks.length && !rec.linked_hidden ? <div className="cl-empty">No linked tasks. Link one from the task’s Checklists strip, or make one from an item.</div> : (
          <div className="dp-groups">
            {rec.linked_tasks.map(t => {
              const ts = STATUS_MAP[t.status];
              return (
                <div key={t.link_id} className={'dp-row' + (t.status === 'done' || t.status === 'abandoned' ? ' cleared' : '')}>
                  <button type="button" className="dp-open" onClick={() => router.push(`/tasks/detail/?id=${t.id}`)}>
                    <span className="dp-dot" style={{ background: ts?.color || 'var(--text-4)' }} />
                    <span className="dp-no">{t.task_no}</span><span className="dp-ttl">{t.title}</span>
                    {t.owner_name && <span className="dp-own">{t.owner_name}</span>}
                  </button>
                  {t.can_edit && <button type="button" className="dp-x" aria-label={`Unlink ${t.task_no}`} disabled={busy}
                    onClick={() => act('unlinkTaskChecklist', { task_id: t.id, record_id: rec.id }, 'Unlinked')}><X size={12} /></button>}
                </div>
              );
            })}
            {rec.linked_hidden > 0 && <div className="dp-row dp-hidden"><EyeOff size={12} aria-hidden />{rec.linked_hidden} linked task{rec.linked_hidden === 1 ? '' : 's'} you can’t see</div>}
          </div>
        )}
      </section>

      {sections.map((s, si) => (
        <section className="cl-group cl-section" key={si}>
          <div className="cl-section-head"><span className="cl-section-title">{s.title || 'Items'}</span>
            <span className="cl-section-meta"><span className="cl-section-prog">{progressLabel(recordProgress(s.items))}</span></span></div>
          <ul className="cl-rows">
            {s.items.map(i => <ItemRow key={i.id} item={i} rec={rec} busy={busy} onState={setState} onNote={saveNote} onCreateTask={createTask} router={router} />)}
          </ul>
        </section>
      ))}
      {!rec.items.length && <div className="cl-empty">This record has no items yet.</div>}

      {rec._can_tick && (adding ? (
        <div className="cl-create">
          <input className="cl-input" autoFocus placeholder="An item only this record needs" value={adding.title} maxLength={300}
            onChange={e => setAdding(a => ({ ...a, title: e.target.value }))}
            onKeyDown={async e => { if (e.key === 'Enter' && adding.title.trim()) { if (await act('addRecordItem', { record_id: rec.id, ...adding })) setAdding(null); } }} />
          <label className="cl-field"><span>Section</span>
            <Combobox value={adding.section_title} allowClear style={{ width: 240 }} options={sections.filter(s => s.title).map(s => ({ value: s.title, label: s.title }))}
              onChange={v => setAdding(a => ({ ...a, section_title: v || '' }))} /></label>
          <div className="cl-create-actions"><Button variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
            <Button variant="primary" icon={Check} disabled={busy || !adding.title.trim()} onClick={async () => { if (await act('addRecordItem', { record_id: rec.id, ...adding })) setAdding(null); }}>Add item</Button></div>
        </div>
      ) : <Button variant="ghost" size="sm" icon={Plus} className="cl-additem" onClick={() => setAdding({ title: '', section_title: sections[sections.length - 1]?.title || '' })}>Add item</Button>)}

      {rec.history?.length > 0 && (
        <details className="rc-history">
          <summary>History ({rec.history.length})</summary>
          <ul>
            {rec.history.map(h => {
              const item = h.item_id ? rec.items.find(i => i.id === h.item_id) : null;
              return (
                <li key={h.id}><span className="cl-done-at">{fmtWhen(h.at)}</span> {h.actor_name || 'Someone'} {HIST[h.event] || h.event}
                  {item && ['item_done', 'item_na', 'item_reopened', 'item_note', 'item_task_created', 'item_added'].includes(h.event) ? ` “${item.title}”` : ''}
                  {h.event === 'items_copied' || h.event === 'template_pulled' ? ` (${h.detail?.added || 0})` : ''}
                  {h.detail?.task_no ? ` (${h.detail.task_no})` : ''}{h.detail?.hidden_task ? ' (a task you can’t see)' : ''}</li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function RecordPage() {
  return <Suspense fallback={<Spinner />}><RecordInner /></Suspense>;
}
