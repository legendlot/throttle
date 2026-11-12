'use client';
// F9 R8 hand-offs (spec §4.6) — the pieces outside the task view's property grid:
//   HandoffChip    — "→ Design" on list rows, grid cards and board cards (amber until accepted).
//   HandoffRows    — the review pack's / founders' page hand-off rows (one shape: the worker's pack row).
//   IncomingSection — My Tasks → Incoming (getIncoming): "To you" / "To your team", Accept inline.
// The rules (who may accept, what counts as unowned / overdue) are the worker's; wording is lib/handoff.js.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useToast } from '@throttle/ui';
import { ArrowRightLeft, Check } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../lib/docketopsFetch.js';
import { STATUS_MAP, effectiveDeadline } from '../../lib/tasks.js';
import { handoffChip, handoffAccepted, handoffTarget, handoffErrorText, groupIncoming, canAcceptIncoming, handoffDirection, receiverText } from '../../lib/handoff.js';
import { tsDay } from '../../lib/review.js';
import { Button, SegmentedTabs } from '../ui/index.js';

export function HandoffChip({ task, className = '' }) {
  const c = handoffChip(task);
  if (!c) return null;
  return <span className={'ho-chip' + (c.pending ? ' pending' : '') + (className ? ' ' + className : '')} title={c.title}>{c.label}</span>;
}

export function HandoffRows({ rows = [] }) {
  return (rows || []).filter(Boolean).map(r => {
    const st = STATUS_MAP[r.status];
    return (
      <div key={r.task_id} className="rv-row ho-row">
        <span className="pw-st" style={{ background: st?.color }} aria-label={st?.label} />
        <Link className="rv-task rv-t" href={'/tasks?task=' + r.task_id}><span className="pl-code">{r.task_no}</span> {r.title}</Link>
        <span className="rv-meta">
          {handoffDirection(r)} · by {r.giver_name || 'no owner'} · to {receiverText(r)} · {r.accepted ? 'accepted' : 'not accepted'} · due {tsDay(r.effective_deadline)}
        </span>
      </div>
    );
  });
}

const TABS = [{ value: 'me', label: 'To you' }, { value: 'team', label: 'To your team' }];

// Hidden entirely when nothing is incoming. `refreshKey` is a counter the page bumps after a task-view write
// (an accept in the drawer included) — never the task array, so inline edits and focus syncs don't re-read.
export function IncomingSection({ session, myEmployeeId, onOpen, refreshKey }) {
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(async () => {
    if (!session) return;
    try { setData(await docketopsGet('getIncoming', { scope: 'all' }, session)); }
    catch { setData(null); }   // a failed read hides the section; My Tasks itself is unaffected
  }, [session]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const tasks = (data?.tasks || []).filter(Boolean);
  if (!tasks.length) return null;
  const g = groupIncoming(tasks, myEmployeeId);
  const cur = tab || (g.me.length ? 'me' : 'team');
  const rows = cur === 'me' ? g.me : g.team;
  const unaccepted = Number(data?.counts?.unaccepted) || 0;

  async function accept(t) {
    setBusy(t.id);
    try {
      await docketopsPost('acceptHandoff', { id: t.id }, session);
      showToast(`Accepted ${t.task_no || 'the hand-off'}`, 'success');
      await load();
    } catch (e) { showToast(handoffErrorText(e), 'error'); }
    finally { setBusy(null); }
  }

  return (
    <section className="ho-in" aria-label="Incoming hand-offs">
      <div className="ho-in-h">
        <ArrowRightLeft size={14} aria-hidden className="pw-ic" />
        <span className="ho-in-t">Incoming</span>
        {unaccepted > 0 && <span className="pl-count" title="Not accepted yet">{unaccepted}</span>}
        <span className="ho-in-tabs">
          <SegmentedTabs label="Incoming" tabs={TABS.map(x => ({ ...x, label: `${x.label} ${x.value === 'me' ? g.me.length : g.team.length}` }))}
            value={cur} onChange={setTab} />
        </span>
      </div>
      {rows.length === 0 ? <p className="rv-none ho-none">Nothing here.</p> : rows.map(t => {
        const st = STATUS_MAP[t.status];
        const ok = handoffAccepted(t);
        return (
          <div key={t.id} className="ho-in-row">
            <button type="button" className="ho-in-main" onClick={() => onOpen?.(t.id)} title={`${t.task_no || ''} ${t.title}`.trim()}>
              <span className="pw-st" style={{ background: st?.color }} aria-label={st?.label} />
              <span className="pl-code">{t.task_no}</span>
              <span className="ho-in-ttl">{t.title}</span>
              <span className="rv-meta">from {t.giver_name || t.owner_name || 'someone'}{t.giver_team_name ? ` · ${t.giver_team_name}` : ''} · to {handoffTarget(t)} · due {tsDay(effectiveDeadline(t))}</span>
            </button>
            {ok ? <span className="ho-chip">accepted</span>
              : !canAcceptIncoming(t, myEmployeeId) ? <span className="ho-chip pending">waiting</span>
              : <Button size="sm" variant="neutral" icon={Check} loading={busy === t.id} onClick={() => accept(t)}>Accept</Button>}
          </div>
        );
      })}
    </section>
  );
}
