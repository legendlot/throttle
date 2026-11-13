'use client';
// Leave R1 — the shared pieces for /leave (my balances, apply, my requests, the manager inbox, who's out)
// and /admin/leave (the ledger). Presentation + calls; every count, split and gate is the worker's (D6–D11).
import { useEffect, useRef, useState } from 'react';
import { useToast, Combobox } from '@throttle/ui';
import { Send, Undo2, Ban, Check, X, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { Card, F, Row, Note, ListBadge, inp, comboInp, primaryBtn, ghostBtn, dangerBtn, muted } from './HiringBits.js';
import {
  LEAVE_TYPES, GRANT_TYPES, LEAVE_STATUSES, LEDGER_KINDS, START_HALVES, END_HALVES, SINGLE_HALVES, MAX_REASON,
  leaveTypeLabel, leaveError, leaveErrorCode, previewLeave, applyLeave, withdrawLeave, cancelLeave, decideLeave,
  splitOf, personOf, arr, istToday, addDays, weekdayOf, mondayOf, monthStart, monthEnd, shiftMonth, daysBetween,
  fmtDay, fmtMonth, fmtRange, fmtDays, fmtNum, halfOn,
} from '../lib/leave.js';
import { labelFrom } from '../lib/hiring.js';

const smallBtn = { ...ghostBtn, padding: '4px 10px', fontSize: 11 };
const rowLine = { display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap', fontSize: 13 };

export function LeaveStatusBadge({ status }) { return <ListBadge list={LEAVE_STATUSES} status={status} />; }
const isGrant = (r) => GRANT_TYPES.some(t => t.id === r?.leave_type);

// ── My balances ─────────────────────────────────────────────────────────────

function Tile({ label, big, sub, warn }) {
  return (
    <div style={{ flex: '1 1 170px', minWidth: 170, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11, padding: '12px 15px' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t4)' }}>{label}</div>
      <div className="num" style={{ fontSize: 24, fontWeight: 600, color: warn ? 'var(--warn-fg)' : 'var(--t1)', marginTop: 3 }}>{big}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// balances: {PL,SL: {balance, available, cap}, PERIOD: {used_this_month}, OPTIONAL_HOLIDAY: {used_this_year}}
export function BalanceTiles({ balances, canPeriod }) {
  const b = balances || {};
  const led = (t) => {
    const x = b[t] || {};
    const bal = Number(x.balance) || 0;
    return (
      <Tile key={t} label={leaveTypeLabel(t)} big={fmtNum(x.available ?? bal)} warn={bal < 0}
        sub={`available · balance ${fmtNum(bal)} · can borrow up to ${fmtNum(x.cap ?? 0)}`} />
    );
  };
  const periodUsed = Number(b.PERIOD?.used_this_month) || 0;
  const optUsed = Number(b.OPTIONAL_HOLIDAY?.used_this_year) || 0;
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {led('PL')}{led('SL')}
      {canPeriod && <Tile label="Period leave" big={periodUsed >= 1 ? 'Used' : '1'} sub={periodUsed >= 1 ? 'this month (used or requested)' : 'left this month'} />}
      <Tile label="Optional holiday" big={optUsed >= 1 ? 'Used' : '1'} sub={optUsed >= 1 ? 'this year (used or requested)' : 'left this year'} />
    </div>
  );
}

export function HolidayList({ holidays }) {
  const today = istToday();
  const up = (holidays || []).filter(h => h.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);
  return (
    <Card title="Upcoming holidays">
      {up.length === 0 ? <div style={muted}>None listed. HR adds the next year&apos;s list in Leave Settings.</div> : up.map(h => (
        <div key={h.date} style={{ display: 'flex', gap: 10, padding: '5px 0', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
          <span className="num" style={{ minWidth: 120, color: 'var(--text-2)' }}>{fmtDay(h.date)}</span>
          <span style={{ flex: 1 }}>{h.name}</span>
          <span style={{ ...muted, fontSize: 11 }}>{h.kind === 'optional' ? 'Optional' : 'Fixed'}</span>
        </div>
      ))}
    </Card>
  );
}

// ── Apply form with the live preview (D6/D7) ────────────────────────────────

// people (HR only): [{value, label, hint}] — record a request for someone else (D8). Empty = for yourself.
// wfhApprover (R2 E4): getMyLeave's wfh_approver ({id, full_name} | null = HR) — shown for your own WFH request.
export function ApplyForm({ session, canPeriod, holidays, people, onApplied, wfhApprover }) {
  const { showToast } = useToast();
  const today = istToday();
  const [forId, setForId] = useState('');
  const [type, setType] = useState('PL');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [startHalf, setStartHalf] = useState('full');
  const [endHalf, setEndHalf] = useState('full');
  const [reason, setReason] = useState('');
  const [pv, setPv] = useState(null);          // { days, borrowed_days, lop_days } | { code }
  const [pvBusy, setPvBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const forOther = !!forId;
  const single = !end || end === start;
  const optionals = (holidays || []).filter(h => h.kind === 'optional' && (forOther || h.date >= today)).sort((a, b) => a.date.localeCompare(b.date));
  const types = LEAVE_TYPES.filter(t => !t.grant && (t.id !== 'PERIOD' || canPeriod || forOther));
  // Notice (D8): HR recording for someone else may pick any past date; the worker re-checks. WFH as SL (E4).
  const minStart = forOther ? undefined : type === 'SL' || type === 'WFH' ? addDays(today, -7) : today;
  const wfh = type === 'WFH';

  function pickType(t) {
    setType(t); setPv(null);
    if (t === 'PERIOD' || t === 'OPTIONAL_HOLIDAY') { setEnd(''); setEndHalf('full'); }
    if (t === 'OPTIONAL_HOLIDAY') { setStart(''); setStartHalf('full'); }
  }
  // The body the worker sees. A single day sends its half as both start_half and end_half.
  function body() {
    const e = type === 'PERIOD' || type === 'OPTIONAL_HOLIDAY' || !end ? start : end;
    const one = e === start;
    return {
      leave_type: type, start_date: start, end_date: e,
      start_half: type === 'OPTIONAL_HOLIDAY' || (!one && startHalf === 'first') ? 'full' : startHalf,
      end_half: type === 'OPTIONAL_HOLIDAY' ? 'full' : one ? startHalf : endHalf,
      ...(forId ? { employee_id: forId } : {}),
    };
  }

  // Debounced preview: the latest answer wins (seq).
  useEffect(() => {
    if (!session || !start || (end && end < start)) { setPv(null); return; }
    const my = ++seq.current;
    setPvBusy(true);
    const t = setTimeout(() => {
      previewLeave(body(), session)
        .then(r => {
          if (my !== seq.current) return;
          const code = r?.refusal || r?.code || r?.error || null;
          setPv(code ? { code, message: r?.refusal_message || r?.message } : { ...splitOf(r) });
        })
        .catch(e => { if (my === seq.current) setPv({ code: leaveErrorCode(e), message: leaveError(e) }); })
        .finally(() => { if (my === seq.current) setPvBusy(false); });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, type, start, end, startHalf, endHalf, forId]);

  async function submit() {
    if (!start) { showToast('Pick the dates', 'error'); return; }
    if (pv?.code) { showToast(pv.code === 'no_holiday_list' && pv.message ? pv.message : leaveError(pv.code), 'error'); return; }
    setBusy(true);
    try {
      const r = await applyLeave({ ...body(), reason: reason.trim() || null }, session);
      const mail = r?.email === 'sent' ? ' Your approver has been emailed.' : r?.email === 'failed' ? ' (The email to your approver did not go out; tell them.)' : '';
      showToast(`${wfh ? 'Work from home' : 'Leave'} requested.${mail}`, 'success');
      setStart(''); setEnd(''); setStartHalf('full'); setEndHalf('full'); setReason(''); setPv(null);
      onApplied && onApplied();
    } catch (e) { showToast(leaveError(e), 'error'); }
    finally { setBusy(false); }
  }

  const blocked = !start || !!pv?.code || pvBusy || busy;
  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CalendarDays size={13} /> Apply for leave or work from home</span>}>
      {people && people.length > 0 && (
        <F label="For (HR: record for someone else; leave empty for yourself)">
          <Combobox value={forId} onChange={v => { setForId(v || ''); setPv(null); }} inputStyle={comboInp} placeholder="Myself" options={people} />
        </F>
      )}
      <F label="Type">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {types.map(t => (
            <button key={t.id} type="button" onClick={() => pickType(t.id)}
              style={{ ...smallBtn, ...(type === t.id ? { background: 'var(--podium-accent)', color: '#1f1f1f', borderColor: 'var(--podium-accent)', fontWeight: 700 } : {}) }}>{t.label}</button>
          ))}
        </div>
      </F>
      {type === 'OPTIONAL_HOLIDAY' ? (
        <F label="Optional holiday">
          <select style={inp} value={start} onChange={e => setStart(e.target.value)}>
            <option value="">Pick one…</option>
            {optionals.map(h => <option key={h.date} value={h.date}>{fmtDay(h.date)} · {h.name}</option>)}
          </select>
        </F>
      ) : (
        <Row>
          <F label={type === 'PERIOD' ? 'Date' : 'From'}>
            <input type="date" style={inp} value={start} min={minStart} onChange={e => { setStart(e.target.value); if (end && e.target.value > end) setEnd(''); }} />
          </F>
          {type !== 'PERIOD' && (
            <F label="To (leave empty for one day)">
              <input type="date" style={inp} value={end} min={start || minStart} onChange={e => setEnd(e.target.value)} />
            </F>
          )}
          {single || type === 'PERIOD' ? (
            <F label="Day">
              <select style={inp} value={startHalf} onChange={e => setStartHalf(e.target.value)}>
                {SINGLE_HALVES.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}
              </select>
            </F>
          ) : (<>
            <F label="First day">
              <select style={inp} value={startHalf === 'first' ? 'full' : startHalf} onChange={e => setStartHalf(e.target.value)}>
                {START_HALVES.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}
              </select>
            </F>
            <F label="Last day">
              <select style={inp} value={endHalf} onChange={e => setEndHalf(e.target.value)}>
                {END_HALVES.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}
              </select>
            </F>
          </>)}
        </Row>
      )}
      <F label={`Reason (optional; only your approver and HR see it)`}>
        <textarea rows={2} maxLength={MAX_REASON} style={{ ...inp, resize: 'vertical', fontFamily: 'var(--font-ui)' }} value={reason} onChange={e => setReason(e.target.value)} />
      </F>
      {wfh && !forOther && (
        <div style={{ ...muted, marginBottom: 8 }}>
          Work from home is approved by {wfhApprover?.full_name ? <b>{wfhApprover.full_name}</b> : 'HR'}{wfhApprover?.full_name ? ' (your manager; your manager’s manager or HR can also approve it)' : ''}. It uses no leave balance.
        </div>
      )}
      <PreviewLine pv={pv} busy={pvBusy} type={type} />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={submit} disabled={blocked} style={{ ...primaryBtn, opacity: blocked ? 0.6 : 1 }}><Send size={13} /> {busy ? 'Sending…' : wfh ? 'Request work from home' : 'Request leave'}</button>
      </div>
    </Card>
  );
}

function PreviewLine({ pv, busy, type }) {
  if (busy && !pv) return <div style={{ ...muted, marginBottom: 10 }}>Counting…</div>;
  if (!pv) return null;
  if (pv.code) return <Note tone="bad">{pv.code === 'no_holiday_list' && pv.message ? pv.message : leaveError(pv.code) || pv.message}</Note>;
  const ledger = type === 'PL' || type === 'SL';
  return (
    <Note tone={pv.lop_days > 0 ? 'bad' : pv.borrowed_days > 0 ? 'warn' : 'ok'}>
      <span>
        <b className="num">{fmtDays(pv.days)}</b> of {leaveTypeLabel(type).toLowerCase()}
        {ledger && pv.borrowed_days > 0 && <> · <b className="num">{fmtDays(pv.borrowed_days)}</b> borrowed ahead (your balance goes negative; next months&apos; credits pay it back)</>}
        {ledger && pv.lop_days > 0 && <> · <b className="num">{fmtDays(pv.lop_days)}</b> unpaid (beyond what you can borrow this year)</>}
        {busy && <span style={{ opacity: 0.7 }}> · updating…</span>}
      </span>
    </Note>
  );
}

// ── My requests (D10) ───────────────────────────────────────────────────────

export function MyRequests({ requests, session, onChanged }) {
  const { showToast } = useToast();
  const today = istToday();
  const rows = [...(requests || [])].sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
  async function withdraw(r) {
    if (!window.confirm('Withdraw this request?')) return;
    try { await withdrawLeave(r.id, session); showToast('Request withdrawn', 'success'); onChanged(); }
    catch (e) { showToast(leaveError(e), 'error'); }
  }
  async function cancel(r) {
    const note = window.prompt(r.leave_type === 'PL' || r.leave_type === 'SL' ? 'Cancel this approved leave? The days go back to your balance. Note (optional):' : 'Cancel this approved request? Note (optional):', '');
    if (note === null) return;
    try { await cancelLeave(r.id, note.trim(), session); showToast('Leave cancelled', 'success'); onChanged(); }
    catch (e) { showToast(leaveError(e), 'error'); }
  }
  return (
    <Card title={`My requests (${rows.length})`}>
      {rows.length === 0 ? <div style={muted}>No leave requested this year.</div> : rows.map(r => {
        const sp = splitOf(r);
        return (
          <div key={r.id} style={rowLine}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{leaveTypeLabel(r.leave_type)} · <span className="num">{fmtDays(sp.days)}</span></div>
              <div style={{ ...muted, fontSize: 11.5 }}>
                {fmtRange(r)}
                {sp.borrowed_days > 0 && ` · ${fmtDays(sp.borrowed_days)} borrowed`}
                {sp.lop_days > 0 && ` · ${fmtDays(sp.lop_days)} unpaid`}
              </div>
              {r.decision_note && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>“{r.decision_note}”</div>}
            </div>
            <LeaveStatusBadge status={r.status} />
            {r.status === 'pending' && <button style={smallBtn} onClick={() => withdraw(r)}><Undo2 size={12} /> Withdraw</button>}
            {/* R2 E3: a maternity / paternity grant is changed or ended by HR (cancel + grant again). */}
            {r.status === 'approved' && isGrant(r) && <span style={{ ...muted, fontSize: 11 }}>Granted by HR: ask HR to change or end it</span>}
            {r.status === 'approved' && !isGrant(r) && r.start_date > today && <button style={{ ...smallBtn, ...dangerBtn, padding: '4px 10px', fontSize: 11 }} onClick={() => cancel(r)}><Ban size={12} /> Cancel</button>}
            {r.status === 'approved' && !isGrant(r) && r.start_date <= today && <span style={{ ...muted, fontSize: 11 }}>Started: ask your manager to cancel</span>}
          </div>
        );
      })}
    </Card>
  );
}

// ── Manager inbox: pending to decide (D7/D9) ────────────────────────────────

function BalanceChips({ balances }) {
  const b = balances || {};
  const one = (t) => b[t] ? <span key={t}>{t} <b className="num">{fmtNum(b[t].available ?? b[t].balance)}</b>{b[t].balance != null && b[t].available != null && Number(b[t].balance) !== Number(b[t].available) ? <span style={muted}> (bal {fmtNum(b[t].balance)})</span> : null}</span> : null;
  const parts = ['PL', 'SL'].map(one).filter(Boolean);
  if (!parts.length) return null;
  return <span style={{ display: 'inline-flex', gap: 10, fontSize: 11.5, color: 'var(--text-2)' }}>{parts}</span>;
}

// teamBalances: { [employee_id]: {PL, SL} } — used when a pending row carries no balances of its own.
export function PendingDecisions({ pending, teamBalances, session, onChanged }) {
  const { showToast } = useToast();
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null);   // { id, note }
  const rows = pending || [];
  if (rows.length === 0) return null;

  async function decide(r, decision, note) {
    setBusyId(r.id);
    const sp = splitOf(r);
    try {
      const res = await decideLeave({ id: r.id, decision, note: note || null, expected_split: { borrowed_days: sp.borrowed_days, lop_days: sp.lop_days } }, session);
      const mail = res?.email === 'failed' ? ' (The email to them did not go out.)' : '';
      showToast(`${decision === 'approve' ? 'Approved' : 'Rejected'}.${mail}`, 'success');
      setRejecting(null); onChanged();
    } catch (e) {
      showToast(leaveError(e), 'error');
      if (leaveErrorCode(e) === 'balance_changed' || leaveErrorCode(e) === 'not_pending') onChanged();
    } finally { setBusyId(null); }
  }

  return (
    <Card title={`Waiting for you (${rows.length})`}>
      {rows.map(r => {
        const p = personOf(r);
        const sp = splitOf(r);
        const bal = r.balances || teamBalances?.[p.id];
        const busy = busyId === r.id;
        return (
          <div key={r.id} style={{ ...rowLine, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 300px', minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{p.name} <span style={{ ...muted, fontWeight: 400 }}>{p.code}</span></div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                {leaveTypeLabel(r.leave_type)} · {fmtRange(r)} · <b className="num">{fmtDays(sp.days)}</b>
              </div>
              {(sp.borrowed_days > 0 || sp.lop_days > 0) && (
                <div style={{ fontSize: 12, marginTop: 2, color: sp.lop_days > 0 ? 'var(--bad-fg)' : 'var(--warn-fg)' }}>
                  {sp.borrowed_days > 0 && `${fmtDays(sp.borrowed_days)} borrowed ahead`}{sp.borrowed_days > 0 && sp.lop_days > 0 && ' · '}
                  {sp.lop_days > 0 && `${fmtDays(sp.lop_days)} unpaid`}
                </div>
              )}
              {r.split_changed && <div style={{ fontSize: 11.5, marginTop: 2, color: 'var(--warn-fg)' }}>Balance changed since they applied — the split shown is today&apos;s.</div>}
              <div style={{ marginTop: 2 }}><BalanceChips balances={bal} /></div>
              {r.reason && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, whiteSpace: 'pre-wrap' }}>“{r.reason}”</div>}
              {rejecting?.id === r.id && (
                <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input style={{ ...inp, fontFamily: 'var(--font-ui)', flex: '1 1 220px' }} placeholder="Why (they will see this)" value={rejecting.note} onChange={e => setRejecting({ id: r.id, note: e.target.value })} autoFocus />
                  <button style={{ ...dangerBtn, padding: '5px 10px', fontSize: 11 }} disabled={busy || !rejecting.note.trim()} onClick={() => decide(r, 'reject', rejecting.note.trim())}><X size={12} /> Reject</button>
                  <button style={smallBtn} onClick={() => setRejecting(null)}>Back</button>
                </div>
              )}
            </div>
            {rejecting?.id !== r.id && (
              <span style={{ display: 'flex', gap: 6 }}>
                <button style={{ ...primaryBtn, padding: '5px 12px', fontSize: 11, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => decide(r, 'approve')}><Check size={12} /> Approve</button>
                <button style={smallBtn} disabled={busy} onClick={() => setRejecting({ id: r.id, note: '' })}><X size={12} /> Reject</button>
              </span>
            )}
          </div>
        );
      })}
    </Card>
  );
}

// ── Who's out (D11: the chain's own view, so types are shown) ───────────────

export function rangeFor(mode, anchor) {
  if (mode === 'month') return { from: monthStart(anchor), to: monthEnd(anchor) };
  const from = mondayOf(anchor);
  return { from, to: addDays(from, 6) };
}
export function shiftAnchor(mode, anchor, dir) { return mode === 'month' ? shiftMonth(anchor, dir) : addDays(mondayOf(anchor), 7 * dir); }

export function WhosOut({ mode, anchor, onMode, onAnchor, requests, holidays, session, onChanged }) {
  const { showToast } = useToast();
  const { from, to } = rangeFor(mode, anchor);
  const days = daysBetween(from, to);
  const today = istToday();
  const hol = Object.fromEntries((holidays || []).map(h => [h.date, h]));
  const live = (requests || []).filter(r => r.status === 'approved' || r.status === 'pending')
    .filter(r => r.start_date <= to && (r.end_date || r.start_date) >= from);
  const people = [];
  const byPerson = {};
  for (const r of live) {
    const p = personOf(r);
    if (!byPerson[p.id]) { byPerson[p.id] = { ...p, reqs: [] }; people.push(byPerson[p.id]); }
    byPerson[p.id].reqs.push(r);
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  const cell = mode === 'month' ? 24 : 64;

  async function cancel(r) {
    const note = window.prompt(`Cancel ${personOf(r).name}'s approved leave (${fmtRange(r)})? The days go back to their balance. Note:`, '');
    if (note === null) return;
    try { await cancelLeave(r.id, note.trim(), session); showToast('Leave cancelled', 'success'); onChanged(); }
    catch (e) { showToast(leaveError(e), 'error'); }
  }

  return (
    <Card title="Who's out (and who works from home)"
      right={
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <button style={{ ...smallBtn, ...(mode === 'week' ? { color: 'var(--t1)', borderColor: 'var(--podium-accent)' } : {}) }} onClick={() => onMode('week')}>Week</button>
          <button style={{ ...smallBtn, ...(mode === 'month' ? { color: 'var(--t1)', borderColor: 'var(--podium-accent)' } : {}) }} onClick={() => onMode('month')}>Month</button>
          <button style={smallBtn} onClick={() => onAnchor(shiftAnchor(mode, anchor, -1))} aria-label="Previous"><ChevronLeft size={12} /></button>
          <span style={{ fontSize: 12, minWidth: 150, textAlign: 'center' }}>{mode === 'month' ? fmtMonth(from) : `${fmtDay(from, { weekday: false, year: false })} – ${fmtDay(to, { weekday: false })}`}</span>
          <button style={smallBtn} onClick={() => onAnchor(shiftAnchor(mode, anchor, 1))} aria-label="Next"><ChevronRight size={12} /></button>
          <button style={smallBtn} onClick={() => onAnchor(today)}>Today</button>
        </span>
      }>
      {people.length === 0 ? <div style={muted}>Nobody on your team is out in this {mode}.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `180px repeat(${days.length}, ${cell}px)`, fontSize: 11, minWidth: 180 + days.length * cell }}>
            <div />
            {days.map(d => {
              const we = weekdayOf(d) === 0 || weekdayOf(d) === 6;
              return (
                <div key={d} title={hol[d]?.name || ''} style={{ textAlign: 'center', padding: '4px 0', color: d === today ? 'var(--podium-accent)' : we || hol[d] ? 'var(--text-3)' : 'var(--text-2)', fontWeight: d === today ? 700 : 400 }}>
                  {mode === 'month' ? d.slice(8) : fmtDay(d, { year: false })}
                  {hol[d] && <div style={{ fontSize: 9 }}>{hol[d].kind === 'optional' ? 'opt' : 'hol'}</div>}
                </div>
              );
            })}
            {people.map(p => (<Line key={p.id} p={p} days={days} hol={hol} mode={mode} />))}
          </div>
        </div>
      )}
      {live.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {live.sort((a, b) => a.start_date.localeCompare(b.start_date)).map(r => (
            <div key={r.id} style={{ ...rowLine, padding: '6px 0', fontSize: 12.5 }}>
              <span style={{ fontWeight: 600, minWidth: 160 }}>{personOf(r).name}</span>
              <span style={{ flex: 1 }}>{leaveTypeLabel(r.leave_type)} · {fmtRange(r)} · {fmtDays(splitOf(r).days)}</span>
              <LeaveStatusBadge status={r.status} />
              {r.status === 'approved' && r.can_cancel !== false && <button style={smallBtn} onClick={() => cancel(r)}><Ban size={12} /> Cancel</button>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Line({ p, days, hol, mode }) {
  return (<>
    <div style={{ padding: '5px 6px 5px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 12, borderTop: '1px solid var(--border)' }}>{p.name}</div>
    {days.map(d => {
      const we = weekdayOf(d) === 0 || weekdayOf(d) === 6;
      let half = null, pending = false, type = null;
      for (const r of p.reqs) { const h = halfOn(r, d); if (h) { half = h === 'full' || half === 'full' ? 'full' : half && half !== h ? 'full' : h; pending = pending || r.status === 'pending'; type = r.leave_type; } }
      const off = we || (hol[d] && hol[d].kind === 'fixed');
      // R2 E4: work from home is not "out" — its own colour and a WFH mark.
      const wfh = type === 'WFH';
      const bg = half && !off ? (wfh ? (pending ? 'rgba(96,165,250,0.30)' : 'rgba(96,165,250,0.65)') : pending ? 'rgba(251,191,36,0.35)' : 'rgba(242,205,26,0.75)') : off ? 'var(--surface-2)' : 'transparent';
      const grad = half === 'first' ? `linear-gradient(90deg, ${bg} 50%, transparent 50%)` : half === 'second' ? `linear-gradient(90deg, transparent 50%, ${bg} 50%)` : bg;
      return (
        <div key={d} title={half && !off ? `${leaveTypeLabel(type)}${half !== 'full' ? ` (${half} half)` : ''}${pending ? ' · pending' : ''}` : ''}
          style={{ borderTop: '1px solid var(--border)', borderLeft: '1px solid var(--hairline)', padding: 3 }}>
          <div style={{ height: 18, borderRadius: 3, background: off && !half ? bg : grad, opacity: off && half ? 0.4 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#1f1f1f', fontWeight: 700 }}>
            {mode === 'week' && half && !off ? `${wfh ? 'WFH' : ''}${half === 'full' ? '' : `${wfh ? ' ' : ''}${half === 'first' ? '½ AM' : '½ PM'}`}` : mode === 'month' && half && !off && wfh ? 'W' : ''}
          </div>
        </div>
      );
    })}
  </>);
}

// ── Ledger (HR / self / chain) ──────────────────────────────────────────────

export function LedgerTable({ rows }) {
  const list = arr(rows, 'rows', 'ledger', 'entries');
  if (list.length === 0) return <div style={muted}>No ledger rows yet.</div>;
  const th = { textAlign: 'left', padding: '6px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
  const td = { padding: '6px', borderBottom: '1px solid var(--border)', fontSize: 12.5, verticalAlign: 'top' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr><th style={th}>Date</th><th style={th}>Type</th><th style={th}>Kind</th><th style={{ ...th, textAlign: 'right' }}>Days</th><th style={th}>Period</th><th style={th}>Note</th></tr></thead>
      <tbody>
        {list.map((r, i) => {
          const d = Number(r.delta) || 0;
          return (
            <tr key={r.id || i}>
              <td style={td} className="num">{fmtDay(r.effective_date || r.created_at, { weekday: false })}</td>
              <td style={td}>{r.leave_type}</td>
              <td style={td}>{labelFrom(LEDGER_KINDS, r.kind)}</td>
              <td style={{ ...td, textAlign: 'right', color: d < 0 ? 'var(--bad-fg)' : 'var(--ok-fg)' }} className="num">{d > 0 ? '+' : ''}{fmtNum(d)}</td>
              <td style={td} className="num">{r.period || ''}</td>
              <td style={{ ...td, color: 'var(--text-2)' }}>{r.note || ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
