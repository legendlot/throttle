'use client';
// Leave R1 — HR settings (D4, D13, D14): the cutover month, the holiday calendar, covered people with their
// balances + opening balances (PL and SL once each, L5; after that an adjustment with a note), a person's ledger.
// R2 (plan 2026-11-13-podium-leave-r2): "Payroll — unpaid days" (E1: the month's LOP, CSV, mark exported, what
// changed since), "Year end" (E5, 1 Nov – 31 Jan, read only) and "Grant maternity / paternity" (E3).
// The worker gates every action with isHr.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { CalendarDays, Plus, Save, Trash2, Users, BookOpen, X, Download, CheckCheck, Wallet, Baby, Hourglass } from 'lucide-react';
import { Card, Note, inp, comboInp, primaryBtn, ghostBtn, dangerBtn, muted } from '../../../../components/HiringBits.js';
import { LedgerTable } from '../../../../components/LeaveBits.js';
import { fmtDate } from '../../../../lib/format.js';
import {
  LEDGER_TYPES, GRANT_TYPES, leaveError, arr, personOf, istToday, addDays, fmtDay, fmtNum, fmtDays, fmtMonth,
  getLeaveAdmin, getLeaveLedger, setLeaveSettings, saveHoliday, deleteHoliday, setOpeningBalance, adjustLeave,
  getLeaveLopReport, markLopExported, grantLeave, lopCsv, lopDatesText, lopCheckText, downloadText,
} from '../../../../lib/leave.js';

const th = { textAlign: 'left', padding: '6px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '6px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', fontSize: 13 };
const smallBtn = { ...ghostBtn, padding: '4px 10px', fontSize: 11 };
const title = (Ic, t) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Ic size={13} /> {t}</span>;

// Whether a person's opening row exists for a type — the worker's flag shape is not pinned; read the likely ones.
function openingSet(p, t) {
  const v = p.opening?.[t] ?? p.opening_set?.[t] ?? p.has_opening?.[t] ?? p[`opening_${t.toLowerCase()}`] ?? p[`opening_${t.toLowerCase()}_set`];
  return v != null && v !== false;
}
function balOf(p, t) {
  const b = p.balances?.[t] ?? p[t];
  if (b == null) return null;
  return typeof b === 'object' ? b.balance : b;
}

export default function LeaveSettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [cutover, setCutover] = useState('');
  const [hol, setHol] = useState([]);
  const [newHol, setNewHol] = useState({ date: '', name: '', kind: 'fixed' });
  const [edit, setEdit] = useState(null);       // { id, PL: {amount, note}, SL: {...} }
  const [ledger, setLedger] = useState(null);   // { id, name, rows }
  const [q, setQ] = useState('');

  const load = useCallback(() => {
    if (!session) return;
    getLeaveAdmin(session).then(r => {
      setD(r);
      setCutover(String(r?.settings?.cutover_month || r?.cutover_month || '').slice(0, 7));
      setHol(arr(r, 'holidays').map(h => ({ ...h, _name: h.name })).sort((a, b) => a.date.localeCompare(b.date)));
    }).catch(e => { setD(false); showToast(leaveError(e, 'Could not load leave settings'), 'error'); });
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--t3)' }}>Requires podium_hr.</div>;
  if (d === false) return <div style={{ color: 'var(--t3)' }}>Could not load leave settings.</div>;
  if (!d) return <Spinner />;

  const today = istToday();
  const people = arr(d, 'people', 'employees').map(p => ({ ...p, _p: personOf(p) }))
    .filter(p => !q || `${p._p.name} ${p._p.code}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a._p.name.localeCompare(b._p.name));

  // msg: a string, or (result) → string.
  async function run(fn, msg) {
    try { const r = await fn(); showToast(typeof msg === 'function' ? msg(r) : msg, 'success'); load(); return true; }
    catch (e) { showToast(leaveError(e), 'error'); return false; }
  }
  // D13: a holiday change never recounts a request — say how many include the date (the worker's affected_requests
  // counts pending + approved: requestsOnDate).
  const withAffected = (msg) => (r) => {
    const n = Number(r?.affected_requests) || 0;
    return n > 0 ? `${msg}. ${n} pending or approved request${n === 1 ? ' includes' : 's include'} this date — their day counts were not changed.` : msg;
  };
  const saveCutover = () => run(() => setLeaveSettings({ cutover_month: cutover }, session), 'Cutover month saved');
  async function addHoliday() {
    if (!newHol.date || !newHol.name.trim()) { showToast('Give the date and the name', 'error'); return; }
    if (await run(() => saveHoliday({ date: newHol.date, name: newHol.name.trim(), kind: newHol.kind }, session), withAffected('Holiday added'))) setNewHol({ date: '', name: '', kind: 'fixed' });
  }
  const renameHoliday = (h) => run(() => saveHoliday({ date: h.date, name: h._name.trim(), kind: h.kind }, session), withAffected('Holiday renamed'));
  function removeHoliday(h) {
    if (!window.confirm(`Delete ${h.name} (${fmtDay(h.date)})? Requests already approved over it keep their day count.`)) return;
    run(() => deleteHoliday(h.date, session), withAffected('Holiday deleted'));
  }

  function openEdit(p) {
    setEdit({ id: p._p.id, name: p._p.name, PL: { amount: '', note: '' }, SL: { amount: '', note: '' } });
  }
  async function saveEntry(p, t) {
    const e = edit[t];
    const n = Number(e.amount);
    if (e.amount === '' || !Number.isFinite(n) || Math.round(n * 2) !== n * 2) { showToast('Days in steps of 0.5', 'error'); return; }
    const opening = !openingSet(p, t);
    if (!opening && (!n || !e.note.trim())) { showToast('An adjustment needs a non-zero amount and a note', 'error'); return; }
    const ok = await run(
      () => opening ? setOpeningBalance(p._p.id, t, n, e.note.trim(), session) : adjustLeave(p._p.id, t, n, e.note.trim(), session),
      opening ? `${t} opening balance set` : `${t} adjusted`,
    );
    if (ok) {
      setEdit(x => x && ({ ...x, [t]: { amount: '', note: '' } }));
      if (ledger?.id === p._p.id) showLedger(p);
    }
  }
  async function showLedger(p) {
    try { const r = await getLeaveLedger(p._p.id, session); setLedger({ id: p._p.id, name: p._p.name, rows: r }); }
    catch (e) { showToast(leaveError(e), 'error'); }
  }

  return (
    <div style={{ maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PayrollLop session={session} />
      {d.year_end_year != null && <YearEnd year={d.year_end_year} people={arr(d, 'people', 'employees')} />}
      <GrantLeave session={session} people={arr(d, 'people', 'employees')} onGranted={load} />

      <Card title="Cutover">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
          Monthly credits start from
          <input type="month" style={{ ...inp, width: 170 }} value={cutover} onChange={e => setCutover(e.target.value)} />
          <button style={smallBtn} onClick={saveCutover} disabled={!/^\d{4}-\d{2}$/.test(cutover)}><Save size={12} /> Save</button>
        </div>
        <div style={{ ...muted, marginTop: 6 }}>Earlier months are covered by the opening balance. Each month&apos;s 1.5 PL + 1 SL is credited on the 1st.</div>
      </Card>

      <Card title={title(CalendarDays, `Holidays (${hol.length})`)}>
        <Note tone="warn">A holiday added or deleted after a request was approved does not recount that request.</Note>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Date</th><th style={th}>Name</th><th style={th}>Kind</th><th style={th}></th></tr></thead>
          <tbody>
            {hol.map((h, i) => {
              const future = h.date > today;
              return (
                <tr key={h.date} style={{ opacity: future ? 1 : 0.6 }}>
                  <td style={td} className="num">{fmtDay(h.date)}</td>
                  <td style={td}>
                    {future
                      ? <input style={{ ...inp, fontFamily: 'var(--font-ui)' }} value={h._name} onChange={e => setHol(hs => hs.map((x, j) => (j === i ? { ...x, _name: e.target.value } : x)))} />
                      : h.name}
                  </td>
                  <td style={td}>{h.kind === 'optional' ? 'Optional' : 'Fixed'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {future && h._name !== h.name && h._name.trim() && <button style={{ ...primaryBtn, padding: '4px 10px' }} onClick={() => renameHoliday(h)}><Save size={12} /> Save</button>}
                    {future && <button style={{ ...smallBtn, marginLeft: 6 }} onClick={() => removeHoliday(h)} aria-label="Delete"><Trash2 size={12} /></button>}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td style={td}><input type="date" style={inp} min={addDays(today, 1)} value={newHol.date} onChange={e => setNewHol(n => ({ ...n, date: e.target.value }))} /></td>
              <td style={td}><input style={{ ...inp, fontFamily: 'var(--font-ui)' }} placeholder="Name" value={newHol.name} onChange={e => setNewHol(n => ({ ...n, name: e.target.value }))} /></td>
              <td style={td}>
                <select style={{ ...inp, width: 120 }} value={newHol.kind} onChange={e => setNewHol(n => ({ ...n, kind: e.target.value }))}>
                  <option value="fixed">Fixed</option><option value="optional">Optional</option>
                </select>
              </td>
              <td style={td}><button style={{ ...primaryBtn, padding: '5px 10px' }} onClick={addHoliday}><Plus size={12} /> Add</button></td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card title={title(Users, `Covered people (${arr(d, 'people', 'employees').length})`)}
        right={<input style={{ ...inp, width: 220, fontFamily: 'var(--font-ui)' }} placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />}>
        <div style={{ ...muted, marginBottom: 8 }}>Turn leave on or off for a person in their profile (Leave policy). Opening balances are entered once per type; after that, use an adjustment with a note.</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Person</th><th style={{ ...th, textAlign: 'right' }}>PL</th><th style={{ ...th, textAlign: 'right' }}>SL</th><th style={th}>Opening</th><th style={th}></th></tr></thead>
          <tbody>
            {people.map(p => {
              const open = edit?.id === p._p.id;
              return [
                <tr key={p._p.id}>
                  <td style={td}><div style={{ fontWeight: 600 }}>{p._p.name}</div><div style={muted}>{p._p.code}</div></td>
                  {LEDGER_TYPES.map(t => {
                    const b = balOf(p, t);
                    return <td key={t} style={{ ...td, textAlign: 'right', color: Number(b) < 0 ? 'var(--bad-fg)' : undefined }} className="num">{b == null ? '—' : fmtNum(b)}</td>;
                  })}
                  <td style={td}>{LEDGER_TYPES.map(t => <span key={t} style={{ marginRight: 8, color: openingSet(p, t) ? 'var(--ok-fg)' : 'var(--warn-fg)', fontSize: 12 }}>{t} {openingSet(p, t) ? 'set' : 'not set'}</span>)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button style={smallBtn} onClick={() => (open ? setEdit(null) : openEdit(p))}>{open ? <X size={12} /> : <Plus size={12} />} {open ? 'Close' : 'Balance'}</button>
                    <button style={{ ...smallBtn, marginLeft: 6 }} onClick={() => showLedger(p)}><BookOpen size={12} /> Ledger</button>
                  </td>
                </tr>,
                open && (
                  <tr key={`${p._p.id}-edit`}>
                    <td colSpan={5} style={{ ...td, background: 'var(--surface-2)' }}>
                      {LEDGER_TYPES.map(t => {
                        const opening = !openingSet(p, t);
                        const e = edit[t];
                        return (
                          <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' }}>
                            <span style={{ width: 150, fontSize: 12.5 }}>{t} {opening ? 'opening balance' : 'adjustment (±)'}</span>
                            <input type="number" step="0.5" style={{ ...inp, width: 100 }} value={e.amount} placeholder={opening ? 'e.g. 7.5' : 'e.g. -1'}
                              onChange={ev => setEdit(x => ({ ...x, [t]: { ...x[t], amount: ev.target.value } }))} />
                            <input style={{ ...inp, fontFamily: 'var(--font-ui)', flex: '1 1 240px' }} placeholder={opening ? 'Note (optional, e.g. from RazorpayX on 30 Nov)' : 'Why (required)'} value={e.note}
                              onChange={ev => setEdit(x => ({ ...x, [t]: { ...x[t], note: ev.target.value } }))} />
                            <button style={{ ...(opening ? primaryBtn : dangerBtn), padding: '5px 10px', fontSize: 11 }} onClick={() => saveEntry(p, t)}><Save size={12} /> {opening ? 'Set opening' : 'Adjust'}</button>
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
        {people.length === 0 && <div style={{ ...muted, padding: '10px 0' }}>{q ? 'No match.' : 'Nobody is covered yet.'}</div>}
      </Card>

      {ledger && (
        <Card title={title(BookOpen, `Ledger: ${ledger.name}`)} right={<button style={smallBtn} onClick={() => setLedger(null)}><X size={12} /> Close</button>}>
          <LedgerTable rows={ledger.rows} />
        </Card>
      )}
    </div>
  );
}


// ── R2 E1: Payroll — unpaid days ────────────────────────────────────────────
// The month's LOP from approved PL / SL requests (the worker places it on each request's last working halves). HR
// enters it in RazorpayX by hand (no API write); "Mark exported" snapshots it so a late change shows up here.
function PayrollLop({ session }) {
  const { showToast } = useToast();
  const [month, setMonth] = useState(istToday().slice(0, 7));   // default: this month (IST)
  const [r, setR] = useState(null);                             // null = loading, false = failed
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);                                         // review E: only the latest request's answer lands
  const monthRef = useRef(month);                                // re-verify E': the month picked NOW (not at click time)
  monthRef.current = month;
  const load = useCallback(() => {
    if (!session || !/^\d{4}-\d{2}$/.test(month)) return;
    const my = ++gen.current;
    setR(null);
    getLeaveLopReport(month, session)
      .then(x => { if (my === gen.current) setR(x && x.month === month ? x : false); })
      .catch(e => { if (my !== gen.current) return; setR(false); showToast(leaveError(e, 'Could not load the unpaid days'), 'error'); });
  }, [session, month, showToast]);
  useEffect(() => { load(); }, [load]);

  // Download / Mark exported act on THIS loaded report only (its month = the picked one, and its hash is sent back).
  const ready = !!r && r.month === month && typeof r.report_hash === 'string';
  const rows = arr(r, 'rows');
  const warnings = arr(r, 'warnings');
  const pending = arr(r, 'pending');
  const changes = arr(r, 'changes_since_export');
  const nPending = pending.reduce((n, p) => n + (Number(p.requests) || 0), 0);
  function download() { if (ready) downloadText(`unpaid-days-${r.month}.csv`, lopCsv(rows, warnings)); }
  async function markExported() {
    if (!ready) return;
    if (!window.confirm(`Mark ${fmtMonth(r.month)} as entered in payroll? Later changes will be listed here against this export.`)) return;
    const m = r.month;
    // Reload only if the same month is still picked: a month switched mid-export has its own load in flight, and this
    // click-time load() would otherwise replace it with the old month.
    const reload = () => { if (monthRef.current === m) load(); };
    setBusy(true);
    try { await markLopExported(m, r.report_hash, session); showToast(`Marked ${fmtMonth(m)} exported`, 'success'); reload(); }
    catch (e) { showToast(leaveError(e), 'error'); if (String(e?.message || '').startsWith('report_changed')) reload(); }
    finally { setBusy(false); }
  }
  return (
    <Card title={title(Wallet, 'Payroll — unpaid days')}
      right={<input type="month" style={{ ...inp, width: 170 }} value={month} onChange={e => setMonth(e.target.value || istToday().slice(0, 7))} />}>
      {r === null ? <Spinner /> : r === false ? <div style={muted}>Could not load.</div> : (<>
        {pending.length > 0 && (
          <Note tone="warn">
            <span>{nPending} leave request{nPending === 1 ? '' : 's'} touching {fmtMonth(month)} still pending — decide these before running payroll: {pending.map(p => p.full_name || p.employee_code).join(', ')}.</span>
          </Note>
        )}
        {r.last_export && (
          <div style={{ ...muted, marginBottom: 8 }}>
            Last marked exported {fmtDate(r.last_export.exported_at)}{r.last_export.exported_by_name ? ` by ${r.last_export.exported_by_name}` : ''} ({r.last_export.people} {r.last_export.people === 1 ? 'person' : 'people'}).
            {changes.length === 0 ? ' No change since.' : ''}
          </div>
        )}
        {changes.length > 0 && (
          <Note tone="bad">
            <span>Changed since the last export — carry the difference into next month&apos;s payroll:
              {changes.map(c => <span key={c.employee_id} style={{ display: 'block', marginTop: 2 }}>{c.full_name || c.employee_code}: was <b className="num">{fmtNum(c.was)}</b>, now <b className="num">{fmtNum(c.now)}</b>{c.now > 0 ? ` (${lopDatesText(c.now_dates)})` : ''}</span>)}
            </span>
          </Note>
        )}
        {warnings.length > 0 && (
          <Note tone="warn">
            <span>The holiday list changed after {warnings.length === 1 ? 'this leave was' : 'these leaves were'} approved — the unpaid days are placed over today&apos;s working days; check them:
              {warnings.map(w => <span key={w.request_id} style={{ display: 'block', marginTop: 2 }}>{w.full_name || w.employee_code}: {lopCheckText([w])}{Number(w.placed_in_month) === 0 ? ' — none of it falls in this month' : ''}</span>)}
            </span>
          </Note>
        )}
        {rows.length === 0 ? <div style={muted}>No unpaid days in {fmtMonth(month)}.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Code</th><th style={th}>RazorpayX id</th><th style={th}>Name</th><th style={{ ...th, textAlign: 'right' }}>Unpaid days</th><th style={th}>Dates</th></tr></thead>
            <tbody>
              {rows.map(x => (
                <tr key={x.employee_id}>
                  <td style={td} className="num">{x.employee_code || '—'}</td>
                  <td style={td} className="num">{x.razorpayx_employee_id || <span style={{ color: 'var(--warn-fg)' }}>missing</span>}</td>
                  <td style={td}>{x.full_name || '—'}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600 }} className="num">{fmtNum(x.lop_days)}</td>
                  <td style={{ ...td, fontSize: 12 }}>{lopDatesText(x.dates)}
                    {x.recount_mismatch && <div style={{ color: 'var(--warn-fg)', fontSize: 11 }}>A holiday changed after this leave was approved — check the dates.</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
          <span style={muted}>Total <b className="num">{fmtNum(r.total_lop_days || 0)}</b> · {rows.length} {rows.length === 1 ? 'person' : 'people'}. Exit balances are settled in the F&amp;F, not here.</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button style={smallBtn} onClick={download} disabled={!ready || (!rows.length && !warnings.length)}><Download size={12} /> Download CSV</button>
            <button style={{ ...primaryBtn, padding: '5px 12px', opacity: busy || !ready ? 0.6 : 1 }} onClick={markExported} disabled={busy || !ready}><CheckCheck size={12} /> Mark exported</button>
          </span>
        </div>
      </>)}
    </Card>
  );
}

// ── R2 E5: Year end (read only; the real close is the lazy one on 1 Jan) ─────
function YearEnd({ year, people }) {
  const rows = (people || []).filter(p => p.year_end).map(p => ({ ...p, _p: personOf(p) })).sort((a, b) => a._p.name.localeCompare(b._p.name));
  const actual = rows.some(p => p.year_end.actual);
  const neg = (n) => (Number(n) < 0 ? { color: 'var(--bad-fg)' } : {});
  return (
    <Card title={title(Hourglass, actual ? `Year end ${year} — the close (31 December)` : `Year end ${year} — projected 31 December`)}>
      <div style={{ ...muted, marginBottom: 8 }}>
        {actual
          ? 'What the year-end close wrote: the balance at 31 December, what carried and what lapsed. Requests from that year still pending are shown separately — deciding one re-closes the year.'
          : 'Balance + the credits still to come this year − pending requests. PL carries up to 5 (a negative balance carries as it is); the rest lapses. SL lapses fully.'}
      </div>
      {rows.length === 0 ? <div style={muted}>Nobody is covered.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Person</th><th style={{ ...th, textAlign: 'right' }}>PL at 31 Dec{actual ? ' (before lapse)' : ''}</th><th style={{ ...th, textAlign: 'right' }}>PL carries</th><th style={{ ...th, textAlign: 'right' }}>PL lapses</th><th style={{ ...th, textAlign: 'right' }}>SL at 31 Dec</th><th style={{ ...th, textAlign: 'right' }}>SL lapses</th><th style={{ ...th, textAlign: 'right' }}>Pending PL / SL</th></tr></thead>
          <tbody>
            {rows.map(p => {
              const y = p.year_end;
              return (
                <tr key={p._p.id}>
                  <td style={td}><div style={{ fontWeight: 600 }}>{p._p.name}</div><div style={muted}>{p._p.code}</div></td>
                  <td style={{ ...td, textAlign: 'right', ...neg(y.PL?.projected) }} className="num">{fmtNum(y.PL?.projected)}</td>
                  <td style={{ ...td, textAlign: 'right', ...neg(y.PL?.carry) }} className="num">{fmtNum(y.PL?.carry)}</td>
                  <td style={{ ...td, textAlign: 'right', color: Number(y.PL?.lapse) > 0 ? 'var(--warn-fg)' : undefined }} className="num">{fmtNum(y.PL?.lapse)}</td>
                  <td style={{ ...td, textAlign: 'right', ...neg(y.SL?.projected) }} className="num">{fmtNum(y.SL?.projected)}</td>
                  <td style={{ ...td, textAlign: 'right' }} className="num">{fmtNum(y.SL?.lapse)}</td>
                  <td style={{ ...td, textAlign: 'right', color: Number(y.PL?.pending) + Number(y.SL?.pending) > 0 ? 'var(--warn-fg)' : undefined }} className="num">{fmtNum(y.PL?.pending)} / {fmtNum(y.SL?.pending)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ── R2 E3: grant maternity / paternity (approved on save; never for yourself) ─
function GrantLeave({ session, people, onGranted }) {
  const { showToast } = useToast();
  const [who, setWho] = useState('');
  const [type, setType] = useState('MATERNITY');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');             // optional: empty = the full length
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const opts = (people || []).map(p => { const x = personOf(p); return { value: x.id, label: x.name, hint: x.code }; }).filter(o => o.value);
  const person = (people || []).find(p => personOf(p).id === who);
  const genderMissing = !!person && !person.gender;
  async function submit() {
    if (!who || !start) { showToast('Pick the person and the start date', 'error'); return; }
    if (type === 'MATERNITY' && !note.trim()) { showToast('Record the eligibility check in the note', 'error'); return; }
    setBusy(true);
    try {
      const r = await grantLeave({ employee_id: who, leave_type: type, start_date: start, ...(end ? { end_date: end } : {}), note: note.trim() || null }, session);
      const q = r?.request || {};
      const mail = r?.email === 'sent' ? ' They have been emailed.' : r?.email === 'failed' ? ' (The email did not go out; tell them.)' : '';
      showToast(`Granted: ${fmtDay(q.start_date || start)} – ${fmtDay(q.end_date)} (${fmtDays(q.days)}).${mail}`, 'success');
      setWho(''); setStart(''); setEnd(''); setNote('');
      onGranted && onGranted();
    } catch (e) { showToast(leaveError(e), 'error'); }
    finally { setBusy(false); }
  }
  return (
    <Card title={title(Baby, 'Grant maternity / paternity leave')}>
      <div style={{ ...muted, marginBottom: 8 }}>
        Maternity: 182 calendar days (26 weeks) from the start. Paternity: 15 working days from the start (weekends and fixed holidays are free).
        Both may cross 31 December, use no leave balance and are approved on save. Returning early? Cancel it and grant again with the actual end date.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: '1 1 220px' }}>
          <Combobox value={who} onChange={v => setWho(v || '')} inputStyle={comboInp} placeholder="Person" options={opts} />
        </div>
        <select style={{ ...inp, width: 170 }} value={type} onChange={e => setType(e.target.value)}>
          {GRANT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <input type="date" style={{ ...inp, width: 170 }} value={start} onChange={e => { setStart(e.target.value); if (end && e.target.value > end) setEnd(''); }} aria-label="Starts on" />
        <label style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 6 }}>Ends on
          <input type="date" style={{ ...inp, width: 170 }} value={end} min={start || undefined} onChange={e => setEnd(e.target.value)} />
        </label>
      </div>
      <div style={{ ...muted, marginTop: 4 }}>Leave “Ends on” empty for the full length.</div>
      {genderMissing && <div style={{ fontSize: 12, color: 'var(--warn-fg)', marginTop: 6 }}>This person&apos;s gender is not recorded — fill it in their profile first.</div>}
      <input style={{ ...inp, fontFamily: 'var(--font-ui)', marginTop: 8, width: '100%' }} maxLength={500} value={note} onChange={e => setNote(e.target.value)}
        placeholder={type === 'MATERNITY' ? 'Eligibility check (required): e.g. 80+ days worked in the last 12 months' : 'Note (optional)'} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy || genderMissing}><Save size={12} /> Grant</button>
      </div>
    </Card>
  );
}
