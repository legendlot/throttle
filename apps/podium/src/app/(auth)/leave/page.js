'use client';
// Leave R1 (plan 2026-11-13-podium-leave-r1, D7–D11): my balances, apply with a live preview, my requests;
// for a manager / HR, the requests waiting for them and "Who's out". Nav gate: podium_leave_access
// (covered OR has reports OR HR) — so a manager who is not covered sees only the team half.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Note, muted } from '../../../components/HiringBits.js';
import { BalanceTiles, HolidayList, ApplyForm, MyRequests, PendingDecisions, WhosOut, rangeFor } from '../../../components/LeaveBits.js';
import { getMyLeave, getTeamLeave, getLeaveAdmin, leaveError, leaveErrorCode, arr, personOf, istToday } from '../../../lib/leave.js';

// Team balances, keyed by employee id: getTeamLeave people[] ({id, …, balances}), then — for someone waiting on the
// caller who is outside people[] — the balances each to_decide row carries.
function balanceMap(d) {
  const out = {};
  for (const p of arr(d, 'people')) if (p?.id && p.balances) out[p.id] = p.balances;
  for (const r of arr(d, 'to_decide', 'pending')) {
    const id = personOf(r).id;
    if (id && !out[id] && r.balances) out[id] = r.balances;
  }
  return out;
}

export default function LeavePage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [my, setMy] = useState(null);          // getMyLeave | { not_covered: true }
  const [team, setTeam] = useState(null);      // getTeamLeave | false (not a manager)
  const [people, setPeople] = useState([]);    // HR: covered people, for "record for someone else"
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(istToday());

  const loadMine = useCallback(() => {
    if (!session) return;
    getMyLeave(session).then(setMy).catch(e => {
      if (leaveErrorCode(e) !== 'not_covered') showToast(leaveError(e, 'Failed to load your leave'), 'error');
      setMy({ not_covered: true });
    });
  }, [session, showToast]);
  const loadTeam = useCallback(() => {
    if (!session) return;
    const { from, to } = rangeFor(mode, anchor);
    getTeamLeave(from, to, session).then(d => setTeam(d || false)).catch(e => {
      if (leaveErrorCode(e) !== 'forbidden') showToast(leaveError(e, 'Failed to load your team'), 'error');
      setTeam(false);
    });
  }, [session, mode, anchor, showToast]);

  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => { loadTeam(); }, [loadTeam]);
  useEffect(() => {
    if (!session || !perms?.podium_hr) return;
    getLeaveAdmin(session).then(d => setPeople(arr(d, 'people', 'employees').map(p => {
      const x = personOf(p);
      return { value: x.id, label: x.name, hint: x.code };
    }).filter(o => o.value))).catch(() => setPeople([]));
  }, [session, perms?.podium_hr]);

  if (!my || team === null) return <Spinner />;
  const refresh = () => { loadMine(); loadTeam(); };

  const pending = arr(team, 'pending', 'to_decide');
  const teamReqs = arr(team, 'requests', 'in_range', 'calendar');
  const teamBal = balanceMap(team);
  const isManager = !!team && (pending.length > 0 || teamReqs.length > 0 || Object.keys(teamBal).length > 0 || arr(team, 'people', 'members').length > 0);
  const covered = !my.not_covered;
  const holidays = arr(my, 'holidays').length ? arr(my, 'holidays') : arr(team, 'holidays');

  return (
    <div style={{ maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {covered ? (<>
        <BalanceTiles balances={my.balances} canPeriod={!!my.can_period} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
          <ApplyForm session={session} canPeriod={!!my.can_period} holidays={holidays} people={people} onApplied={refresh} />
          <HolidayList holidays={holidays} />
        </div>
        <MyRequests requests={arr(my, 'requests')} session={session} onChanged={refresh} />
      </>) : (
        <Note tone="neutral">Leave is not set up for you in Podium. If you think it should be, ask HR.</Note>
      )}

      {!covered && perms?.podium_hr && people.length > 0 && (
        <ApplyForm session={session} canPeriod={false} holidays={holidays} people={people} onApplied={refresh} />
      )}

      {isManager && (<>
        <PendingDecisions pending={pending} teamBalances={teamBal} session={session} onChanged={refresh} />
        <WhosOut mode={mode} anchor={anchor} onMode={setMode} onAnchor={setAnchor} requests={[...teamReqs, ...pending.filter(p => !teamReqs.some(r => r.id === p.id))]}
          holidays={holidays} session={session} onChanged={refresh} />
      </>)}
      {!covered && !isManager && <div style={muted}>Nothing to show.</div>}
    </div>
  );
}
