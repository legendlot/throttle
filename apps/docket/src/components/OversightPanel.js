'use client';
// Oversight (R1): per-person checklist adherence for a date, scoped to people the caller
// manages or has assigned to. Drill into a person → their read-only run for the date.
import { useEffect, useState, useCallback } from 'react';
import { Spinner, useToast } from '@throttle/ui';
import { ChevronRight } from 'lucide-react';
import { docketopsGet } from '../lib/docketopsFetch.js';
import { ChecklistRun } from './ChecklistRun.js';
import { todayIST, fmtISTDate } from '../lib/recurrence.js';

export function OversightPanel({ session }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(todayIST());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [personData, setPersonData] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try { setData(await docketopsGet('getChecklistOversight', { date }, session)); }
    catch (e) { showToast(e.message || 'Failed', 'error'); setData(null); }
    finally { setLoading(false); }
  }, [session, date, showToast]);
  useEffect(() => { load(); }, [load]);

  async function openPerson(empId) {
    if (openId === empId) { setOpenId(null); setPersonData(null); return; }
    setOpenId(empId); setPersonData(null);
    try { setPersonData(await docketopsGet('getChecklist', { employee_id: empId, date }, session)); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  const people = data?.people || [];
  return (
    <div className="cl-oversight">
      <div className="screen-head cl-head">
        <p>Checklist adherence for people you manage or have assigned to.</p>
        <input className="cl-date" type="date" value={date} onChange={e => { setDate(e.target.value || todayIST()); setOpenId(null); setPersonData(null); }} />
      </div>
      {loading ? <Spinner /> : people.length === 0 ? (
        <div className="cl-empty">Nothing to monitor for {fmtISTDate(date)}.</div>
      ) : (
        <ul className="cl-ovr-list">
          {people.map(p => (
            <li key={p.employee_id} className="cl-ovr-row">
              <button className="cl-ovr-head" onClick={() => openPerson(p.employee_id)}>
                <ChevronRight size={14} className={'cl-ovr-chev' + (openId === p.employee_id ? ' open' : '')} />
                <span className="cl-ovr-name">{p.full_name}</span>
                {p.department_name && <span className="chip soft">{p.department_name}</span>}
                <span className="cl-ovr-stats">
                  {p.recurring.total > 0 && <span className={'cl-ovr-stat' + (p.recurring.done >= p.recurring.total ? ' ok' : '')}>tasks {p.recurring.done}/{p.recurring.total}</span>}
                  {p.templates.map(t => (
                    <span key={t.template_id} className={'cl-ovr-stat' + (t.done >= t.total && t.total > 0 ? ' ok' : '')} title={t.incomplete_sections.join(', ')}>
                      {t.name} {t.done}/{t.total}
                    </span>
                  ))}
                </span>
              </button>
              {openId === p.employee_id && (
                <div className="cl-ovr-detail">
                  {!personData ? <Spinner /> : (
                    <>
                      {(personData.recurring_items || []).filter(i => i.due_today).length > 0 && (
                        <div className="cl-ovr-recurring">
                          <h5>Recurring tasks</h5>
                          <ul className="cl-today">
                            {(personData.recurring_items || []).filter(i => i.due_today).map(i => (
                              <li key={i.id} className={'cl-item' + (i.completed_today ? ' done' : '')}>
                                <span className={'cl-check' + (i.completed_today ? ' on' : '')} />
                                <div className="cl-item-main"><div className="cl-item-title">{i.title}</div></div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(personData.template_runs || []).map(run => (
                        <ChecklistRun key={run.template.id} run={run} canComplete={false} onToggleItem={() => {}} onSaveComment={() => {}} />
                      ))}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export default OversightPanel;
