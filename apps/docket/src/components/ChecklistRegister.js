'use client';
// F8 P1 — the checklist REGISTER (spec 2026-11-11-docket-checklists-v2.md §3.1): the paper chart on
// the wall. Rows = items, columns = the dates they were due, a tick per cell, adherence at the end of
// every row, the foot of every column and in each chart's header. Same ticks as the Today view.
//
// One block per chart for the selected person: their own recurring tasks (if any), then every
// checklist template assigned to them (a shared template shows its ONE chart, whoever ticked).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner, useToast } from '@throttle/ui';
import { Check, X, ChevronLeft, ChevronRight, ListChecks, ClipboardList, Users } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../lib/docketopsFetch.js';
import { SegmentedTabs, Button, IconButton, EmptyState } from './ui/index.js';
import { windowFor, pageWindow, cellState, pct, pctTone, colHead, cellTip, groupRows, fmtDay } from '../lib/register.js';

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fmtStamp = (iso, withDate) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
  ...(withDate ? { day: 'numeric', month: 'short' } : {}),
}).format(new Date(iso));
const SPANS = [{ value: '7', label: '7D' }, { value: '14', label: '14D' }, { value: '30', label: '30D' }];

export function ChecklistRegister({ personId, session, isOwn }) {
  const { showToast } = useToast();
  const today = istToday();
  const [span, setSpan] = useState('14');
  const [end, setEnd] = useState(today);
  const [charts, setCharts] = useState(null);   // [{ key, params, data }]
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);   // only the latest load may write (window/person can change mid-flight)

  const { from, to } = windowFor(end, Number(span));

  const fetchChart = useCallback((params) => docketopsGet('getChecklistRegister', { ...params, from, to }, session), [from, to, session]);

  const load = useCallback(async () => {
    if (!session || !personId) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const own = await fetchChart({ employee_id: personId });
      const list = [];
      if (own.rows.length) list.push({ key: 'own', params: { employee_id: personId }, data: own });
      const tmpl = await Promise.all((own.templates || []).map(t => {
        const params = t.run_scope === 'shared' ? { template_id: t.id } : { template_id: t.id, employee_id: personId };
        return fetchChart(params).then(data => ({ key: 't:' + t.id, params, data })).catch(() => null);
      }));
      if (mine !== seq.current) return;
      setCharts([...list, ...tmpl.filter(Boolean)]);
    } catch (e) { if (mine === seq.current) { showToast(e.message || 'Failed to load the register', 'error'); setCharts([]); } }
    finally { if (mine === seq.current) setLoading(false); }
  }, [session, personId, fetchChart, showToast]);
  useEffect(() => { load(); }, [load]);

  // `gen` = the load generation the chart was rendered under. A tick that lands after the person or
  // window changed must not refresh (or overwrite) the new view with the old chart (Codex review #2).
  const reloadOne = useCallback(async (key, gen) => {
    if (gen !== seq.current) return;
    const c = charts?.find(x => x.key === key); if (!c) return;
    try { const data = await fetchChart(c.params); if (gen === seq.current) setCharts(cs => cs.map(x => x.key === key ? { ...x, data } : x)); }
    catch (e) { showToast(e.message || 'Failed to refresh', 'error'); }
  }, [charts, fetchChart, showToast]);

  return (
    <div className="rg">
      <div className="rg-bar">
        <SegmentedTabs label="Register window" value={span} onChange={(v) => setSpan(v)} tabs={SPANS} />
        <div className="cl-datenav">
          <IconButton icon={ChevronLeft} size="sm" variant="neutral" label="Earlier" onClick={() => setEnd(pageWindow(end, Number(span), -1, today))} />
          <span className="cl-datelbl">{fmtDay(from)} – {end === today ? 'today' : fmtDay(to)}</span>
          <IconButton icon={ChevronRight} size="sm" variant="neutral" label={end < today ? 'Later' : 'Already at today'}
            disabled={end >= today} onClick={() => setEnd(pageWindow(end, Number(span), 1, today))} />
          {end !== today && <Button size="sm" onClick={() => setEnd(today)}>Today</Button>}
        </div>
        <span className="rg-legend" aria-hidden>
          <span className="rg-k done"><Check size={10} strokeWidth={3} /></span>done
          <span className="rg-k late"><Check size={10} strokeWidth={3} /></span>late
          <span className="rg-k backfilled"><Check size={10} strokeWidth={3} /></span>ticked later
          <span className="rg-k missed"><X size={10} strokeWidth={3} /></span>missed
        </span>
      </div>
      {loading && !charts ? <Spinner /> : !charts?.length ? (
        <EmptyState icon={ListChecks} title="No register yet" body={isOwn ? 'Add a recurring task or get a checklist assigned under Manage, and its chart shows here.' : 'Nothing recurring on this checklist.'} />
      ) : (
        <div style={{ opacity: loading ? 0.6 : 1 }}>
          {(() => { const gen = seq.current; return charts.map(c => <RegisterChart key={c.key} chart={c} session={session} today={today} onChanged={() => reloadOne(c.key, gen)} />); })()}
        </div>
      )}
    </div>
  );
}

function RegisterChart({ chart, session, today, onChanged }) {
  const { showToast } = useToast();
  const { data } = chart;
  const [busy, setBusy] = useState(null);       // 'row|date' while a tick is in flight
  const [onBehalf, setOnBehalf] = useState(''); // shared charts: "done by" (F8 C7)
  const shared = data.template?.run_scope === 'shared';
  const title = data.template ? data.template.name : 'Recurring tasks';
  const overall = pct(data.adherence.overall);
  const groups = groupRows(data.rows);
  const dueSets = Object.fromEntries(data.rows.map(r => [r.id, new Set(r.due)]));

  async function tick(row, date, state) {
    const key = `${row.id}|${date}`;
    const completed = !(state === 'done' || state === 'late' || state === 'backfilled');
    setBusy(key);
    try {
      if (row.kind === 'task') await docketopsPost('toggleChecklistOccurrence', { id: row.id, date, completed }, session);
      else await docketopsPost('toggleChecklistItem', { template_item_id: row.id, date, completed, ...(completed && shared && onBehalf.trim() ? { done_by_note: onBehalf.trim() } : {}) }, session);
      await onChanged();
    } catch (e) { showToast(e.message || 'Could not save the tick', 'error'); }
    finally { setBusy(null); }
  }

  return (
    <section className="cl-group rg-chart">
      <div className="rg-head">
        {data.template ? <ClipboardList size={14} aria-hidden /> : <ListChecks size={14} aria-hidden />}
        <span className="rg-title">{title}</span>
        {shared && <span className="rg-pill"><Users size={11} aria-hidden /> Shared chart</span>}
        <span className={'rg-overall ' + pctTone(overall)} title="Done ÷ due over this window (today counts once ticked)">
          {overall == null ? '—' : `${overall}%`} <small>{data.adherence.overall.done}/{data.adherence.overall.due}</small>
        </span>
        {shared && data.can_tick && (
          <input className="cl-input rg-behalf" value={onBehalf} maxLength={120} placeholder="Ticking for someone? Name them"
            aria-label="Done by (optional)" onChange={e => setOnBehalf(e.target.value)} />
        )}
      </div>
      {!data.cols.length ? <p className="rg-empty">Nothing was due in this window.</p> : (
        <div className="rg-scroll">
          <table className="rg-table">
            <thead>
              <tr>
                <th className="rg-rowh" scope="col">Item</th>
                {data.cols.map((d, i) => { const h = colHead(d, i === 0); return (
                  <th key={d} scope="col" className={'rg-colh' + (d === today ? ' today' : '')}>
                    <span className="m">{h.month}</span><span className="w">{h.wd}</span><span className="d">{h.day}</span>
                  </th>); })}
                <th className="rg-pcth" scope="col">%</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, gi) => [
                g.section ? <tr key={'s' + gi} className="rg-sec"><th colSpan={data.cols.length + 2} scope="colgroup">{g.section}</th></tr> : null,
                ...g.rows.map(r => {
                  const rp = pct(data.adherence.rows[r.id]);
                  return (
                    <tr key={r.id}>
                      <th className="rg-rowh" scope="row" title={r.title}>
                        <span className="t">{r.title}</span>{r.due_time && <span className="tm">{r.due_time}</span>}
                      </th>
                      {data.cols.map(d => {
                        const cell = data.cells[`${r.id}|${d}`];
                        const st = cellState(dueSets[r.id], cell, d, today);
                        const tip = cellTip(st, cell, d, fmtStamp);
                        // A shared tick is a record: only whoever made it (or the checklist's editor) can clear it.
                        const can = data.can_tick && st !== 'nodue' && d <= today && (!cell || !shared || cell.mine || data.can_clear_any);
                        const key = `${r.id}|${d}`;
                        const mark = st === 'missed' ? <X size={11} strokeWidth={3} /> : (st === 'done' || st === 'late' || st === 'backfilled') ? <Check size={11} strokeWidth={3} /> : null;
                        return (
                          <td key={d} className={'rg-cell ' + st + (d === today ? ' today' : '')}>
                            {can
                              ? <button type="button" className="rg-btn" title={tip} aria-label={tip} disabled={busy === key}
                                  aria-pressed={!!cell} onClick={() => tick(r, d, st)}>{mark}</button>
                              : <span className="rg-btn ro" title={tip} aria-label={tip}>{st === 'nodue' ? '·' : mark}</span>}
                          </td>
                        );
                      })}
                      <td className={'rg-pct ' + pctTone(rp)}>{rp == null ? '—' : `${rp}%`}</td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
            <tfoot>
              <tr>
                <th className="rg-rowh" scope="row">Day</th>
                {data.cols.map(d => { const p = pct(data.adherence.cols[d]); return <td key={d} className={'rg-pct col ' + pctTone(p)}>{p == null ? '' : p}</td>; })}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
