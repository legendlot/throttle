'use client';
// Checklist — per-person recurring tasks (flat, RULE-DOCKET-008) + structured template
// runs (RULE-DOCKET-009), with a My day / Records / Manage / Oversight tab set. Records (F8 P2) are
// copies of a record template per product or launch — ChecklistRecords + /checklist/record.
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, Check, Repeat, Pencil, Ban, Archive, ChevronLeft, ChevronRight, ListChecks, CalendarDays, Eye, Grid3x3, ClipboardCheck } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { RecurrencePopover } from '../../../components/RecurrencePopover.js';
import { GroupHeader } from '../../../components/tasks/GroupHeader.js';
import { PriorityFlag } from '../../../components/tasks/TaskCells.js';
import { SegmentedTabs, Button, IconButton, EmptyState } from '../../../components/ui/index.js';
import { ChecklistRun } from '../../../components/ChecklistRun.js';
import { ChecklistTemplateEditor } from '../../../components/ChecklistTemplateEditor.js';
import { OversightPanel } from '../../../components/OversightPanel.js';
import { ChecklistRegister } from '../../../components/ChecklistRegister.js';
import { ChecklistRecords } from '../../../components/ChecklistRecords.js';
import { TaskView } from '../../../components/task/TaskView.js';
import { recurrenceSummary, templateRecurrenceSummary, fmtTime, fmtISTDate, isValidRecurrence, isDueOn, isExpired, restOfWeek, WEEKDAYS } from '../../../lib/recurrence.js';
import { fmtClockIST } from '../../../lib/checklist.js';
import { PRIORITIES } from '../../../lib/tasks.js';

const timeKey = (i) => (i.recurrence?.time) || '99:99';
const byTime = (a, b) => timeKey(a).localeCompare(timeKey(b)) || (a.title || '').localeCompare(b.title || '');

// IST today as YYYY-MM-DD. en-CA formats that way natively, and going through Intl keeps this
// consistent with the nowHM clock below instead of reintroducing the toISOString() off-by-one
// (that helper returns YESTERDAY between 00:00 and 05:30 IST).
const istTodayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
// Pure UTC arithmetic on a date-only string — no local-timezone drift either way.
const shiftISO = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

export default function ChecklistPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [tab, setTab] = useState('day');           // 'day' | 'records' | 'manage' | 'oversight'
  // ?tab=records (the Record page's back link) — read after mount so the static render stays 'day'.
  useEffect(() => { try { const t = new URLSearchParams(window.location.search).get('tab'); if (['records', 'manage', 'oversight'].includes(t)) setTab(t); } catch { /* ignore */ } }, []);
  // F8 P1: My day shows the same ticks two ways — the Today list or the Register chart. Remembered per device.
  const [dayView, setDayViewState] = useState(() => { try { return localStorage.getItem('docket.checklist.view') === 'register' ? 'register' : 'today'; } catch { return 'today'; } });
  const setDayView = (v) => { setDayViewState(v); try { localStorage.setItem('docket.checklist.view', v); } catch { /* private mode */ } };
  const [collapsed, setCollapsed] = useState({});  // group key → true (P7 list-view groups)
  const toggleGroup = (k) => setCollapsed(c => ({ ...c, [k]: !c[k] }));
  // '' = today. Any past date is viewable AND completable — the whole worker path is already
  // date-relative (getChecklist / toggleChecklistItem / toggleChecklistOccurrence all take a
  // date, and due_today/completed_today are computed from it), so this is purely the UI
  // catching up. Forgetting to tick yesterday previously had no recourse at all.
  const [viewDate, setViewDate] = useState('');
  const [me, setMe] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [personId, setPersonId] = useState('');
  const [data, setData] = useState(null);          // { owner, date, recurring_items, template_runs }
  const [loading, setLoading] = useState(true);
  const [drawerId, setDrawerId] = useState(null);
  const [busy, setBusy] = useState(false);
  // personal-recurring create/edit/stop (unchanged from S124)
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState(null);
  // templates (manage)
  const [templates, setTemplates] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTemplateId, setEditorTemplateId] = useState(null);

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
    return (employees || []).filter(e => e.id === me.employee_id || viewAll || (me.department_id && e.department_id === me.department_id));
  }, [me, employees, viewAll]);

  const load = useCallback(async (pid, dateArg) => {
    if (!session || !pid) return;
    setLoading(true);
    const params = { employee_id: pid };
    if (dateArg) params.date = dateArg;   // omitted ⇒ the worker uses IST today
    try { setData(await docketopsGet('getChecklist', params, session)); }
    catch (e) { showToast(e.message || 'Failed to load checklist', 'error'); setData(null); }
    finally { setLoading(false); }
  }, [session, showToast]);
  // Manage's "My recurring tasks" list reads the same payload, so it loads there too (hostile review #1).
  useEffect(() => { if (personId && ((tab === 'day' && dayView === 'today') || tab === 'manage')) load(personId, viewDate); }, [personId, tab, dayView, viewDate, load]);

  const loadTemplates = useCallback(async () => {
    if (!session) return;
    try { setTemplates(await docketopsGet('getChecklistTemplates', {}, session) || []); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }, [session, showToast]);
  useEffect(() => { if (tab === 'manage') loadTemplates(); }, [tab, loadTemplates]);

  const recItems = data?.recurring_items || [];
  const runs = data?.template_runs || [];
  const today = data?.date;
  const dueToday = useMemo(() => recItems.filter(i => i.due_today).sort(byTime), [recItems]);
  const doneCount = dueToday.filter(i => i.completed_today).length;
  const allSorted = useMemo(() => recItems.slice().sort(byTime), [recItems]);
  // "Recurring this week" (P7): the rest of the week AFTER the viewed day, previewed
  // client-side from each recurrence with the worker's own isDueOn/isExpired rules. Personal
  // recurring tasks only — template runs come from the worker per date, so they can't be
  // previewed. Read-only (a future occurrence can't be ticked, see canGoNext); today only.
  const weekAhead = useMemo(() => {
    if (!data?.date) return [];
    const days = restOfWeek(data.date);
    return recItems.map(i => ({ item: i, days: days.filter(d => isDueOn(i.recurrence, d) && !isExpired(i.recurrence, d)) }))
      .filter(x => x.days.length).sort((a, b) => a.days[0].localeCompare(b.days[0]) || byTime(a.item, b.item));
  }, [recItems, data?.date]);
  const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  // `today` above is the date the worker ANSWERED for, which is the viewed date. Compare it to
  // real IST today to decide whether this is a back-fill view.
  const istToday = istTodayStr();
  const isToday = !today || today === istToday;
  // Future dates are deliberately NOT reachable. A checklist records that something WAS done;
  // ticking tomorrow's box is meaningless and would make adherence unauditable. Past-only.
  const canGoNext = !!today && today < istToday;
  const isOwn = personId === me?.employee_id;

  // ── personal recurring toggle (flat) ──
  async function toggleRecurring(item) {
    if (!item._can_complete) return;
    const next = !item.completed_today;
    setData(d => ({ ...d, recurring_items: d.recurring_items.map(i => i.id === item.id ? { ...i, completed_today: next } : i) }));
    try { await docketopsPost('toggleChecklistOccurrence', { id: item.id, completed: next, date: today || undefined }, session); }
    catch (e) { showToast(e.message || 'Failed', 'error'); load(personId, viewDate); }
  }
  // ── template run handlers ──
  async function toggleItem(itemId, completed) {
    setData(d => ({ ...d, template_runs: d.template_runs.map(run => ({ ...run, sections: run.sections.map(s => ({ ...s, items: s.items.map(it => it.id === itemId ? { ...it, completed, completed_at: completed ? new Date().toISOString() : null, completed_by: completed ? (me?.full_name || null) : null } : it) })) })) }));
    try { await docketopsPost('toggleChecklistItem', { template_item_id: itemId, completed, date: today || undefined }, session); }
    catch (e) { showToast(e.message || 'Failed', 'error'); load(personId, viewDate); }
  }
  async function saveComment(sectionId, body) {
    try { await docketopsPost('saveSectionComment', { section_id: sectionId, body }, session); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  // ── personal recurring create/edit/stop (unchanged) ──
  function openCreate() { setDraft({ title: '', recurrence: { freq: 'daily', time: '09:00' }, owner_employee_id: personId, priority: 'P2', department_id: '', description: '' }); setShowCreate(true); }
  async function submitCreate() {
    if (!draft.title.trim()) { showToast('Title required', 'error'); return; }
    if (!isValidRecurrence(draft.recurrence)) { showToast('Pick a valid schedule', 'error'); return; }
    setBusy(true);
    try {
      await docketopsPost('createRecurringTask', { title: draft.title.trim(), recurrence: draft.recurrence, owner_employee_id: draft.owner_employee_id || null, priority: draft.priority, department_id: draft.department_id || null, description: draft.description || null }, session);
      setShowCreate(false); setDraft(null); showToast('Recurring task added', 'success'); load(personId, viewDate);
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  // Edit schedule: the RecurrencePopover holds the draft; this is the same write as before.
  async function saveSched(item, rec) {
    if (!isValidRecurrence(rec)) { showToast('Pick a valid schedule', 'error'); return false; }
    setBusy(true);
    try { await docketopsPost('updateRecurrence', { id: item.id, recurrence: rec }, session); load(personId, viewDate); return true; }
    catch (e) { showToast(e.message || 'Failed', 'error'); return false; } finally { setBusy(false); }
  }
  async function stopTask(item) {
    const reason = window.prompt('Stop this recurring task? It leaves the checklist (logged, not deleted). Reason:');
    if (reason == null) return;
    if (!reason.trim()) { showToast('Reason required', 'error'); return; }
    try { await docketopsPost('abandonTask', { id: item.id, reason: reason.trim() }, session); showToast('Stopped', 'success'); load(personId, viewDate); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function archiveTemplate(t) {
    if (!window.confirm(t.kind === 'record' ? `Archive "${t.name}"? No new records can start from it; existing records keep their items.` : `Archive "${t.name}"? It stops appearing on assignees' checklists.`)) return;
    try { await docketopsPost('archiveChecklistTemplate', { id: t.id }, session); showToast('Archived', 'success'); loadTemplates(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  if (!me) return <Spinner />;
  if (!me.employee_id) return (<div className="screen"><EmptyState icon={ListChecks} title="No checklist yet" body="Your account isn’t linked to an employee profile yet, so you have no checklist. Ask an admin to link you in Podium." /></div>);

  const dayLabel = (d) => WEEKDAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]?.label;
  const nothingToday = dueToday.length === 0 && runs.length === 0 && !(isToday && weekAhead.length);

  return (
    <div className="screen checklist">
      <SegmentedTabs className="cl-tabs" label="Checklist" value={tab} onChange={setTab}
        tabs={[{ value: 'day', label: 'My day', icon: ListChecks }, { value: 'records', label: 'Records', icon: ClipboardCheck }, { value: 'manage', label: 'Manage', icon: Repeat }, { value: 'oversight', label: 'Oversight', icon: Eye }]} />

      {tab === 'day' && (<>
        <div className="cl-head">
          <SegmentedTabs label="Checklist view" value={dayView} onChange={setDayView}
            tabs={[{ value: 'today', label: 'Today', icon: ListChecks }, { value: 'register', label: 'Register', icon: Grid3x3 }]} />
          <p className="cl-lede">{dayView === 'register'
            ? `Every day at a glance${isOwn ? '' : ` for ${viewablePeople.find(e => e.id === personId)?.full_name || 'this person'}`}: a tick per item per day, adherence at the end of each row.`
            : <>Recurring tasks{isOwn ? ' on your checklist' : ` on ${data?.owner?.full_name || 'this'}’s checklist`}. Check them off as you go.</>}</p>
          {dayView === 'today' && <div className="cl-datenav">
            <IconButton icon={ChevronLeft} size="sm" variant="neutral" label="Previous day"
              onClick={() => setViewDate(shiftISO(today || istToday, -1))} />
            <span className={'cl-datelbl' + (isToday ? '' : ' past')}>{isToday ? 'Today' : fmtISTDate(today)}</span>
            {/* Forward is capped at today on purpose — see canGoNext. */}
            <IconButton icon={ChevronRight} size="sm" variant="neutral" label={canGoNext ? 'Next day' : 'Cannot tick a future checklist'}
              disabled={!canGoNext} onClick={() => canGoNext && setViewDate(shiftISO(today, 1))} />
            {!isToday && <Button size="sm" onClick={() => setViewDate('')}>Today</Button>}
          </div>}
          {viewablePeople.length > 1 && (
            <div className="cl-person">
              <Combobox value={personId} allowClear={false} style={{ width: 260, maxWidth: '100%' }}
                options={viewablePeople.map(e => ({ value: e.id, label: e.id === me.employee_id ? `${e.full_name} (me)` : e.full_name }))}
                onChange={(v) => { if (v) setPersonId(v); }} />
            </div>
          )}
        </div>
        {dayView === 'register' ? <ChecklistRegister personId={personId} session={session} isOwn={isOwn} /> : loading ? <Spinner /> : nothingToday ? (
          <EmptyState icon={ListChecks} title={`Nothing scheduled for ${isToday ? 'today' : fmtISTDate(today)}`}
            body={isOwn ? 'Add a recurring task or a checklist template under Manage.' : 'Nothing on this checklist for the day.'} />
        ) : (<>
          {dueToday.length > 0 && (
            <section className="cl-group">
              <GroupHeader variant="cl-ghead" collapsed={!!collapsed.today} onToggle={() => toggleGroup('today')}
                group={{ label: isToday ? 'Today' : `Back-fill · ${fmtISTDate(today)}`, rows: dueToday, color: isToday ? 'var(--accent)' : 'var(--state-warning)', hint: `${doneCount}/${dueToday.length} done` }} />
              {!collapsed.today && (
                <ul className="cl-rows">
                  {dueToday.map(i => {
                    // Only meaningful for today — on a past date every timed item is trivially
                    // "past its time", so flagging them all red says nothing.
                    const overdue = isToday && !i.completed_today && i.recurrence?.time && i.recurrence.time < nowHM;
                    return (
                      <li key={i.id} className={'cl-item' + (i.completed_today ? ' done' : '')}>
                        <button className={'cl-check' + (i.completed_today ? ' on' : '')} disabled={!i._can_complete} aria-pressed={!!i.completed_today} aria-label={i.completed_today ? 'Mark not done' : 'Mark done'} title={i._can_complete ? '' : 'You can only complete your own checklist'} onClick={() => toggleRecurring(i)}>{i.completed_today && <Check size={12} strokeWidth={3} />}</button>
                        <button className="cl-item-title" onClick={() => setDrawerId(i.id)}>{i.title}</button>
                        <span className="cl-item-meta">
                          {i.completed_today && i.completed_at && (<span className={'cl-done-at' + (i.late ? ' late' : '')}>{i.late ? 'late · ' : ''}{fmtClockIST(i.completed_at)}{i.completed_by ? ` · ${i.completed_by}` : ''}</span>)}
                          {i.department_name && <span className="cl-team">{i.department_name}</span>}
                          <PriorityFlag priority={i.priority} />
                          <span className={'cl-at' + (overdue ? ' over' : '')}>{fmtTime(i.recurrence?.time)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
          {runs.map(run => (
            <ChecklistRun key={run.template.id} run={run} canComplete={run._can_complete && isOwn}
              collapsed={!!collapsed['run:' + run.template.id]} onToggle={() => toggleGroup('run:' + run.template.id)}
              onToggleItem={toggleItem} onSaveComment={saveComment} />
          ))}
          {isToday && weekAhead.length > 0 && (
            <section className="cl-group">
              <GroupHeader variant="cl-ghead" collapsed={!!collapsed.week} onToggle={() => toggleGroup('week')}
                group={{ label: 'Recurring this week', rows: weekAhead, icon: CalendarDays, hint: 'upcoming · tick on the day' }} />
              {!collapsed.week && (
                <ul className="cl-rows">
                  {weekAhead.map(({ item: i, days }) => (
                    <li key={i.id} className="cl-item ahead">
                      <span className="cl-check ghost" aria-hidden />
                      <button className="cl-item-title" onClick={() => setDrawerId(i.id)}>{i.title}</button>
                      <span className="cl-item-meta">
                        <span className="cl-days">{days.map(dayLabel).join(' · ')}</span>
                        <PriorityFlag priority={i.priority} />
                        <span className="cl-at">{fmtTime(i.recurrence?.time)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>)}
      </>)}

      {tab === 'manage' && (
        <div className="cl-manage-wrap">
          {/* personal recurring */}
          <section className="cl-group">
            <div className="cl-group-bar">
              <GroupHeader variant="cl-ghead" collapsed={!!collapsed.mine} onToggle={() => toggleGroup('mine')}
                group={{ label: 'My recurring tasks', rows: allSorted, icon: Repeat }} />
              {!showCreate && <Button variant="primary" size="sm" icon={Plus} onClick={() => { openCreate(); setCollapsed(c => ({ ...c, mine: false })); }}>New</Button>}
            </div>
            {!collapsed.mine && (<>
              {showCreate && draft && (
                <div className="cl-create">
                  <input className="cl-input" autoFocus placeholder="What needs doing, on a schedule?" value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
                  <div className="cl-field"><span>Schedule</span>
                    <RecurrencePopover value={draft.recurrence} onChange={r => setDraft(d => ({ ...d, recurrence: r }))} /></div>
                  <div className="cl-create-grid">
                    <label className="cl-field"><span>Assign to</span><Combobox value={draft.owner_employee_id} allowClear={false} style={{ width: '100%' }} options={employees.map(e => ({ value: e.id, label: e.full_name }))} onChange={v => setDraft(d => ({ ...d, owner_employee_id: v }))} /></label>
                    <label className="cl-field"><span>Priority</span><Combobox value={draft.priority} allowClear={false} style={{ width: '100%' }} options={PRIORITIES.map(p => ({ value: p.key, label: p.label }))} onChange={v => setDraft(d => ({ ...d, priority: v || 'P2' }))} /></label>
                    <label className="cl-field"><span>Team</span><Combobox value={draft.department_id} allowClear style={{ width: '100%' }} options={[{ value: '', label: '— None —' }, ...departments.map(dp => ({ value: dp.id, label: dp.name }))]} onChange={v => setDraft(d => ({ ...d, department_id: v || '' }))} /></label>
                  </div>
                  <textarea className="cl-textarea" placeholder="Description (optional)" value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} />
                  <div className="cl-create-actions"><Button variant="ghost" onClick={() => { setShowCreate(false); setDraft(null); }}>Cancel</Button><Button variant="primary" icon={Check} disabled={busy || !draft.title.trim() || !isValidRecurrence(draft.recurrence)} onClick={submitCreate}>Add</Button></div>
                </div>
              )}
              {allSorted.length === 0 ? <div className="cl-empty">No recurring tasks yet.</div> : (
                <ul className="cl-rows">
                  {allSorted.map(i => (
                    <li key={i.id} className="cl-item">
                      <Repeat className="cl-row-ic" size={14} aria-hidden />
                      <button className="cl-item-title" onClick={() => setDrawerId(i.id)}>{i.title}</button>
                      <span className="cl-item-meta">
                        {i.department_name && <span className="cl-team">{i.department_name}</span>}
                        <PriorityFlag priority={i.priority} />
                        <span className="cl-rec">{recurrenceSummary(i.recurrence)}</span>
                      </span>
                      {i._can_complete && (
                        <span className="cl-row-acts">
                          <RecurrencePopover value={i.recurrence || { freq: 'daily', time: '09:00' }} align="right" label="Edit schedule" busy={busy}
                            valid={isValidRecurrence} onSave={(rec) => saveSched(i, rec)}
                            trigger={({ ref, onClick, open }) => <IconButton ref={ref} icon={Pencil} size="sm" label="Edit schedule" aria-expanded={open} onClick={onClick} />} />
                          <IconButton icon={Ban} size="sm" label="Stop (abandon)" onClick={() => stopTask(i)} />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>)}
          </section>

          {/* checklist templates */}
          <section className="cl-group">
            <div className="cl-group-bar">
              <GroupHeader variant="cl-ghead" collapsed={!!collapsed.tmpl} onToggle={() => toggleGroup('tmpl')}
                group={{ label: 'Checklist templates', rows: templates, icon: ListChecks }} />
              {!editorOpen && <Button variant="primary" size="sm" icon={Plus} onClick={() => { setEditorTemplateId(null); setEditorOpen(true); setCollapsed(c => ({ ...c, tmpl: false })); }}>New template</Button>}
            </div>
            {!collapsed.tmpl && (editorOpen ? (
              <ChecklistTemplateEditor templateId={editorTemplateId} employees={employees} departments={departments} session={session}
                onSaved={() => { setEditorOpen(false); setEditorTemplateId(null); loadTemplates(); }}
                onCancel={() => { setEditorOpen(false); setEditorTemplateId(null); loadTemplates(); /* a failed save may still have written the row */ }} />
            ) : templates.length === 0 ? <div className="cl-empty">No templates yet. Create a routine (a role’s daily checklist) or a record template (copied per product launch).</div> : (
              <ul className="cl-rows">
                {templates.map(t => (
                  <li key={t.id} className="cl-item">
                    <ListChecks className="cl-row-ic" size={14} aria-hidden />
                    <button className="cl-item-title" disabled={!t._can_edit} onClick={() => { if (t._can_edit) { setEditorTemplateId(t.id); setEditorOpen(true); } }}>{t.name}</button>
                    <span className="cl-item-meta">
                      {t.kind === 'record' && <span className="cl-team">Record · v{t.version || 1}</span>}
                      {t.role_label && <span className="cl-team">{t.role_label}</span>}
                      <span className="cl-sub">{t.section_count} sections · {t.item_count} items{t.kind === 'record' ? '' : ` · ${t.assignee_count} assigned`}</span>
                      {t.kind !== 'record' && <span className="cl-rec">{templateRecurrenceSummary(t.recurrence)}</span>}
                    </span>
                    {t._can_edit && <span className="cl-row-acts"><IconButton icon={Archive} size="sm" label="Archive" onClick={() => archiveTemplate(t)} /></span>}
                  </li>
                ))}
              </ul>
            ))}
          </section>
        </div>
      )}

      {tab === 'records' && <ChecklistRecords session={session} employees={employees} me={me} />}

      {tab === 'oversight' && <OversightPanel session={session} employees={employees} departments={departments} />}

      {drawerId && (<TaskView id={drawerId} session={session} departments={departments} employees={employees} onClose={() => setDrawerId(null)} onOpen={setDrawerId} onMutated={() => load(personId, viewDate)} />)}
    </div>
  );
}
