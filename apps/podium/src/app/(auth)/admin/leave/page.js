'use client';
// Leave R1 — HR settings (D4, D13, D14): the cutover month, the holiday calendar, covered people with their
// balances + opening balances (PL and SL once each, L5; after that an adjustment with a note), a person's ledger.
// The worker gates every action with isHr.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { CalendarDays, Plus, Save, Trash2, Users, BookOpen, X } from 'lucide-react';
import { Card, Note, inp, primaryBtn, ghostBtn, dangerBtn, muted } from '../../../../components/HiringBits.js';
import { LedgerTable } from '../../../../components/LeaveBits.js';
import {
  LEDGER_TYPES, leaveError, arr, personOf, istToday, addDays, fmtDay, fmtNum,
  getLeaveAdmin, getLeaveLedger, setLeaveSettings, saveHoliday, deleteHoliday, setOpeningBalance, adjustLeave,
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

