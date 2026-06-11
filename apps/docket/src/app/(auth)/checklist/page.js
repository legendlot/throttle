'use client';
// Checklist — a per-person page of recurring tasks (RULE-DOCKET-008). Today's due
// occurrences as checkboxes + a manage list of all the person's recurring tasks.
// Defaults to your own checklist; managers / view_all can view a report's via the
// person picker (recurring tasks follow normal task visibility, unlike Scratchpad).
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, Check, Repeat, Pencil, Ban } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { PriorityBadge } from '../../../components/PriorityBadge.js';
import { RecurrenceEditor } from '../../../components/RecurrenceEditor.js';
import { TaskDrawer } from '../../../components/TaskDrawer.js';
import { recurrenceSummary, fmtTime, fmtISTDate, isValidRecurrence } from '../../../lib/recurrence.js';
import { PRIORITIES } from '../../../lib/tasks.js';

const timeKey = (i) => (i.recurrence?.time) || '99:99';
const byTime = (a, b) => timeKey(a).localeCompare(timeKey(b)) || (a.title || '').localeCompare(b.title || '');

export default function ChecklistPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [me, setMe] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [personId, setPersonId] = useState('');
  const [data, setData] = useState(null);          // { owner, today, items }
  const [loading, setLoading] = useState(true);
  const [drawerId, setDrawerId] = useState(null);
  const [busy, setBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState(null);
  const [editSchedId, setEditSchedId] = useState(null);
  const [schedDraft, setSchedDraft] = useState(null);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getMe', {}, session),
      docketopsGet('getEmployees', {}, session),
      docketopsGet('getDepartments', {}, session),
    ]).then(([m, emps, depts]) => {
      setMe(m); setEmployees(emps || []); setDepartments(depts || []);
      setPersonId(m?.employee_id || '');
      if (!m?.employee_id) setLoading(false);
    }).catch(e => { showToast(e.message || 'Failed to load', 'error'); setLoading(false); });
  }, [session, showToast]);

  const viewAll = !!(me?.permissions?.docket_admin || me?.permissions?.docket_view_all);

  const viewablePeople = useMemo(() => {
    if (!me) return [];
    return (employees || []).filter(e =>
      e.id === me.employee_id || viewAll || (me.department_id && e.department_id === me.department_id));
  }, [me, employees, viewAll]);

  const load = useCallback(async (pid) => {
    if (!session || !pid) return;
    setLoading(true);
    try { setData(await docketopsGet('getChecklist', { employee_id: pid }, session)); }
    catch (e) { showToast(e.message || 'Failed to load checklist', 'error'); setData(null); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { if (personId) load(personId); }, [personId, load]);

  const items = data?.items || [];
  const today = data?.today;
  const dueToday = useMemo(() => items.filter(i => i.due_today).sort(byTime), [items]);
  const doneCount = dueToday.filter(i => i.completed_today).length;
  const allSorted = useMemo(() => items.slice().sort(byTime), [items]);
  const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

  async function toggle(item) {
    if (!item._can_complete) return;
    const next = !item.completed_today;
    setData(d => ({ ...d, items: d.items.map(i => i.id === item.id ? { ...i, completed_today: next } : i) }));
    try { await docketopsPost('toggleChecklistOccurrence', { id: item.id, completed: next }, session); }
    catch (e) { showToast(e.message || 'Failed', 'error'); load(personId); }
  }

  function openCreate() {
    setDraft({ title: '', recurrence: { freq: 'daily', time: '09:00' }, owner_employee_id: personId, priority: 'P2', department_id: '', description: '' });
    setShowCreate(true);
  }
  async function submitCreate() {
    if (!draft.title.trim()) { showToast('Title required', 'error'); return; }
    if (!isValidRecurrence(draft.recurrence)) { showToast('Pick a valid schedule', 'error'); return; }
    setBusy(true);
    try {
      await docketopsPost('createRecurringTask', {
        title: draft.title.trim(), recurrence: draft.recurrence,
        owner_employee_id: draft.owner_employee_id || null, priority: draft.priority,
        department_id: draft.department_id || null, description: draft.description || null,
      }, session);
      setShowCreate(false); setDraft(null);
      showToast('Recurring task added', 'success');
      load(personId);
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  function openEditSched(item) { setEditSchedId(item.id); setSchedDraft(item.recurrence || { freq: 'daily', time: '09:00' }); }
  async function saveSched() {
    if (!isValidRecurrence(schedDraft)) { showToast('Pick a valid schedule', 'error'); return; }
    setBusy(true);
    try { await docketopsPost('updateRecurrence', { id: editSchedId, recurrence: schedDraft }, session); setEditSchedId(null); setSchedDraft(null); load(personId); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function stopTask(item) {
    const reason = window.prompt('Stop this recurring task? It leaves the checklist (logged, not deleted). Reason:');
    if (reason == null) return;
    if (!reason.trim()) { showToast('Reason required', 'error'); return; }
    try { await docketopsPost('abandonTask', { id: item.id, reason: reason.trim() }, session); showToast('Stopped', 'success'); load(personId); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  if (!me) return <Spinner />;
  if (!me.employee_id) return (
    <div className="screen"><div className="screen-head"><p>Your account isn’t linked to an employee profile yet, so you have no checklist. Ask an admin to link you in Podium.</p></div></div>
  );

  const isOwn = personId === me.employee_id;

  return (
    <div className="screen checklist">
      <div className="screen-head cl-head">
        <p>Recurring tasks{isOwn ? ' on your checklist' : ` on ${data?.owner?.full_name || 'this'}’s checklist`}. Check them off as you go.</p>
        {viewablePeople.length > 1 && (
          <div className="cl-person">
            <Combobox value={personId} allowClear={false} style={{ width: 260 }}
              options={viewablePeople.map(e => ({ value: e.id, label: e.id === me.employee_id ? `${e.full_name} (me)` : e.full_name }))}
              onChange={(v) => { if (v) setPersonId(v); }} />
          </div>
        )}
      </div>

      {loading ? <Spinner /> : (
        <>
          {/* Today */}
          <section className="cl-card">
            <div className="cl-card-head">
              <div><h3>Today</h3><span className="cl-sub">{fmtISTDate(today)}</span></div>
              {dueToday.length > 0 && (
                <div className="cl-progress">
                  <span>{doneCount}/{dueToday.length} done</span>
                  <div className="cl-bar"><i style={{ width: `${dueToday.length ? (doneCount / dueToday.length * 100) : 0}%` }} /></div>
                </div>
              )}
            </div>
            {dueToday.length === 0 ? <div className="cl-empty">Nothing scheduled for today.</div> : (
              <ul className="cl-today">
                {dueToday.map(i => {
                  const overdue = !i.completed_today && i.recurrence?.time && i.recurrence.time < nowHM;
                  return (
                    <li key={i.id} className={'cl-item' + (i.completed_today ? ' done' : '')}>
                      <button className={'cl-check' + (i.completed_today ? ' on' : '')} disabled={!i._can_complete}
                        title={i._can_complete ? '' : 'You can only complete your own checklist'} onClick={() => toggle(i)}>
                        {i.completed_today && <Check size={14} />}
                      </button>
                      <div className="cl-item-main">
                        <button className="cl-item-title" onClick={() => setDrawerId(i.id)}>{i.title}</button>
                        <div className="cl-item-meta">
                          <span className={'cl-time' + (overdue ? ' over' : '')}>{fmtTime(i.recurrence?.time)}</span>
                          <PriorityBadge priority={i.priority} />
                          {i.department_name && <span className="chip soft">{i.department_name}</span>}
                          {i.program && <span className="chip soft">{i.program.name}</span>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* All recurring (manage) */}
          <section className="cl-card">
            <div className="cl-card-head">
              <div><h3>All recurring tasks</h3><span className="cl-sub">{items.length} total</span></div>
              {!showCreate && <button className="btn btn-primary" onClick={openCreate}><Plus size={14} /> New</button>}
            </div>

            {showCreate && draft && (
              <div className="cl-create">
                <input className="cl-input" autoFocus placeholder="What needs doing, on a schedule?"
                  value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
                <RecurrenceEditor value={draft.recurrence} onChange={r => setDraft(d => ({ ...d, recurrence: r }))} />
                <div className="cl-create-grid">
                  <label className="cl-field"><span>Assign to</span>
                    <Combobox value={draft.owner_employee_id} allowClear={false} style={{ width: '100%' }}
                      options={employees.map(e => ({ value: e.id, label: e.full_name }))}
                      onChange={v => setDraft(d => ({ ...d, owner_employee_id: v }))} /></label>
                  <label className="cl-field"><span>Priority</span>
                    <Combobox value={draft.priority} allowClear={false} style={{ width: '100%' }}
                      options={PRIORITIES.map(p => ({ value: p.key, label: p.label }))}
                      onChange={v => setDraft(d => ({ ...d, priority: v || 'P2' }))} /></label>
                  <label className="cl-field"><span>Team</span>
                    <Combobox value={draft.department_id} allowClear style={{ width: '100%' }}
                      options={[{ value: '', label: '— None —' }, ...departments.map(dp => ({ value: dp.id, label: dp.name }))]}
                      onChange={v => setDraft(d => ({ ...d, department_id: v || '' }))} /></label>
                </div>
                <textarea className="cl-textarea" placeholder="Description (optional)"
                  value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} />
                <div className="cl-create-actions">
                  <button className="btn btn-ghost" onClick={() => { setShowCreate(false); setDraft(null); }}>Cancel</button>
                  <button className="btn btn-primary" disabled={busy || !draft.title.trim() || !isValidRecurrence(draft.recurrence)} onClick={submitCreate}><Check size={13} /> Add</button>
                </div>
              </div>
            )}

            {allSorted.length === 0 ? <div className="cl-empty">No recurring tasks yet.</div> : (
              <ul className="cl-manage">
                {allSorted.map(i => (
                  <li key={i.id} className="cl-mrow">
                    <div className="cl-mrow-top">
                      <div className="cl-mrow-main">
                        <button className="cl-item-title" onClick={() => setDrawerId(i.id)}>{i.title}</button>
                        <div className="cl-item-meta">
                          <span className="cl-rec"><Repeat size={12} /> {recurrenceSummary(i.recurrence)}</span>
                          {i.department_name && <span className="chip soft">{i.department_name}</span>}
                          <PriorityBadge priority={i.priority} />
                        </div>
                      </div>
                      {i._can_complete && (
                        <div className="cl-mrow-actions">
                          <button className="dr-icon" title="Edit schedule" onClick={() => openEditSched(i)}><Pencil size={14} /></button>
                          <button className="dr-icon" title="Stop (abandon)" onClick={() => stopTask(i)}><Ban size={14} /></button>
                        </div>
                      )}
                    </div>
                    {editSchedId === i.id && (
                      <div className="cl-sched-edit">
                        <RecurrenceEditor value={schedDraft} onChange={setSchedDraft} />
                        <div className="cl-sched-actions">
                          <button className="btn btn-ghost" onClick={() => { setEditSchedId(null); setSchedDraft(null); }}>Cancel</button>
                          <button className="btn btn-primary" disabled={busy} onClick={saveSched}><Check size={13} /> Save</button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {drawerId && (
        <TaskDrawer id={drawerId} session={session} departments={departments} employees={employees}
          onClose={() => setDrawerId(null)} onMutated={() => load(personId)} />
      )}
    </div>
  );
}
