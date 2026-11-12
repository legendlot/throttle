'use client';
// /review — the weekly review pack (F9 R6a — spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md
// §8.1–§8.5). ONE read (getReviewPack) returns the whole pack, already cut to the viewer: a plan admin sees
// any team or all of them; anyone else gets their own team only. ?week= (this | last | a week-ending date)
// and ?team= (a department id | all) live in the URL. Plan admins can Hold (store the provisional view for
// the minutes) and open stored snapshots, which render through the same components. Hand-offs (§8.1 #5)
// are not in this release.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ClipboardCheck, ChevronLeft, ChevronRight, Copy, Pause, History, X, Users } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { Button, EmptyState, Pill } from '../../../components/ui/index.js';
import { fmtPlanStamp } from '../../../lib/plan.js';
import { slackText, stepWeek, weekParam, weekState, reviewTitle, reviewHref, reviewErrorText, foundersHref } from '../../../lib/review.js';
import { shortDay } from '../../../lib/weeks.js';
import { ReviewPack } from './ReviewPack.js';

export default function ReviewPage() {
  return <Suspense fallback={<div className="pl"><Spinner /></div>}><ReviewInner /></Suspense>;
}

function ReviewInner() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const search = useSearchParams();
  const week = search.get('week') || 'this';
  const team = search.get('team') || '';          // '' = the default scope (plan admin: all; else own team)
  const [data, setData] = useState(null);
  const [holding, setHolding] = useState(false);
  const [snaps, setSnaps] = useState(null);       // null = list closed; [] / [...] = open
  const [snap, setSnap] = useState(null);         // an opened snapshot { id, kind, created_at, payload }

  const go = useCallback((next) => router.replace(reviewHref({ week, team, ...next })), [router, week, team]);

  // Only the newest request may land: stepping weeks fast must never leave an older week on screen under
  // a newer URL (Hold and the arrows read data.week). Each call takes a ticket; a stale ticket is dropped.
  const ticket = useRef(0);
  const redirected = useRef(false);
  const load = useCallback(async () => {
    if (!session) return;
    const mine = ++ticket.current;
    try {
      const d = await docketopsGet('getReviewPack', { week, team }, session);
      if (mine === ticket.current) setData(d);
    } catch (e) {
      if (mine !== ticket.current) return;
      // Not a plan admin and asked for another team → back to their own (the worker's default), ONCE: the
      // redirect drops ?team, and a second forbidden shows the error instead of redirecting again.
      if (e?.message === 'forbidden' && team && !redirected.current) {
        redirected.current = true;
        router.replace(reviewHref({ week }));
        return;
      }
      setData({ error: reviewErrorText(e), code: e?.message });
    }
  }, [session, week, team, router]);
  useEffect(() => { load(); }, [load]);
  // A new week / team: spinner until ITS pack lands (never the old pack under the new URL); close snapshots.
  useEffect(() => { setData(null); setSnap(null); setSnaps(null); }, [week, team]);
  useEffect(() => () => { ticket.current++; }, []);   // unmount: drop whatever is in flight

  if (!data) return <div className="pl"><Spinner /></div>;
  if (data.error) return <div className="pl"><EmptyState icon={ClipboardCheck}
    title={data.code === 'no_team' ? 'No team on your profile' : 'Couldn’t load the review'} body={data.error}
    action={data.code === 'no_team' ? null : <Button size="sm" onClick={() => { setData(null); load(); }}>Retry</Button>} /></div>;

  const w = data.week || {};
  const shown = snap?.payload || data;
  const state = weekState(w);
  const isThis = weekParam(w.week_end) === 'this';
  const teamValue = data.team_id || 'all';
  const deptName = (id) => (data.departments || []).find(d => d.id === id)?.name || (id ? 'A team' : 'All teams');

  async function copySlack() {
    const text = slackText(shown);
    if (!text) { showToast('Nothing to copy', 'error'); return; }
    try { await navigator.clipboard.writeText(text); showToast('Copied for Slack', 'success'); }
    catch { showToast('Could not copy', 'error'); }
  }
  async function hold() {
    setHolding(true);
    try {
      await docketopsPost('holdReview', { week: w.week_end, team: data.team_id || 'all' }, session);
      showToast('Held — provisional snapshot stored', 'success');
      if (snaps) openSnaps();
    } catch (e) { showToast(reviewErrorText(e), 'error'); }
    finally { setHolding(false); }
  }
  async function openSnaps() {
    try { setSnaps((await docketopsGet('getReviewSnapshots', { week: w.week_end }, session))?.snapshots || []); }
    catch (e) { showToast(reviewErrorText(e), 'error'); }
  }
  async function openSnap(id) {
    try { setSnap((await docketopsGet('getReviewSnapshots', { id }, session))?.snapshot || null); }
    catch (e) { showToast(reviewErrorText(e), 'error'); }
  }

  return (
    <div className="pl rv">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title rv-title">
            {reviewTitle(w.week_end)}
            <Pill tone="status" color={w.final ? 'var(--st-done)' : 'var(--st-blocked)'}>{w.final ? 'FINAL' : 'PROVISIONAL'}</Pill>
          </h1>
          <p className="pl-lede">
            {w.as_of && <>As of {fmtPlanStamp(w.as_of)} IST</>}
            {w.opened_late && <span className="rv-late"> · opened late — not exact</span>}
          </p>
        </div>
        <div className="pl-head-acts">
          {data.can_admin && <Button variant="ghost" icon={Users} onClick={() => router.push(foundersHref({ week: weekParam(w.week_end) }))}>Founders’ catch-up →</Button>}
          <Button variant="neutral" icon={Copy} onClick={copySlack} disabled={state !== 'scored'}>Copy for Slack</Button>
          {data.can_admin && <Button variant="neutral" icon={Pause} loading={holding} onClick={hold}
            disabled={state !== 'scored' || !!snap || w.final}>Hold</Button>}
          {data.can_admin && <Button variant="ghost" icon={History} onClick={() => (snaps ? setSnaps(null) : openSnaps())}
            aria-expanded={!!snaps}>Snapshots</Button>}
        </div>
      </div>

      <div className="pw-bar rv-bar">
        <div className="rv-step" role="group" aria-label="Week">
          <Button size="sm" variant="neutral" icon={ChevronLeft} aria-label="Previous week" onClick={() => go({ week: weekParam(stepWeek(w.week_end, -1)) })} />
          <Button size="sm" variant={isThis ? 'primary' : 'neutral'} onClick={() => go({ week: 'this' })}>This week</Button>
          <Button size="sm" variant="neutral" icon={ChevronRight} aria-label="Next week" disabled={state === 'future'}
            onClick={() => go({ week: weekParam(stepWeek(w.week_end, 1)) })} />
        </div>
        {/* Plan admins and Founders' Associates (level R, R6c) may pick any team; Hold / Snapshots / Proposals stay admin-only. */}
        {(data.can_admin || data.can_review) && (
          <label className="pw-team">
            <span className="pl-lbl">Team</span>
            <select className="tk-fp-sel" value={teamValue} onChange={e => go({ team: e.target.value === 'all' ? '' : e.target.value })} aria-label="Team">
              <option value="all">All teams</option>
              {(data.departments || []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {snaps && (
        <div className="rv-snaps">
          <div className="pw-wh">Snapshots · week ending {shortDay(w.week_end)}<span className="pl-count">{snaps.length}</span></div>
          {snaps.length === 0 ? <p className="rv-none">None stored for this week yet.</p> : snaps.map(s => (
            <button key={s.id} type="button" className={'rv-row rv-snap dk-press' + (snap?.id === s.id ? ' on' : '')} onClick={() => openSnap(s.id)}>
              <span className="rv-t">{fmtPlanStamp(s.created_at)} IST</span>
              <Pill tone="status" color={s.kind === 'final' ? 'var(--st-done)' : 'var(--st-blocked)'}>{s.kind}</Pill>
              <span className="rv-meta">{deptName(s.department_id)} · {s.created_by_name || 'the system'}</span>
            </button>
          ))}
        </div>
      )}

      {snap && (
        <div className="rv-snapbar">
          <span>Snapshot · {fmtPlanStamp(snap.created_at)} IST · {snap.kind}</span>
          <Button size="sm" variant="ghost" icon={X} onClick={() => setSnap(null)}>Back to live</Button>
        </div>
      )}

      {snap ? (snap.payload?.teams ? <ReviewPack pack={snap.payload} /> : <p className="rv-none">This snapshot has no stored pack.</p>)
        : state !== 'scored' ? (
          <EmptyState icon={ClipboardCheck}
            title={state === 'future' ? 'Not started yet' : 'This week has no score'}
            body={state === 'future'
              ? `Week ending ${shortDay(w.week_end)} has not started yet — its commitments are frozen when it opens.`
              : `Week ending ${shortDay(w.week_end)} was never opened, so there is no committed list to score.`}
            action={isThis ? null : <Button variant="neutral" size="sm" onClick={() => go({ week: 'this' })}>This week</Button>} />
        ) : <ReviewPack pack={data} />}
    </div>
  );
}
