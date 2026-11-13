'use client';
// Instant load (2026-11-14, Snorkel's permission-gated pattern), DEPARTMENTS ONLY: that read paints its
// last-known result from this tab's sessionStorage and refreshes behind it. The people read is never
// cached for anyone — skeletons, then a fresh, server-projected answer (lib/dashboard.mjs cacheIdentities).
// Each section fills when its own call lands; a failure with nothing to show is an error + Retry, never
// zeros. Candidate responses and the profile banner are fresh too.
// Not polled: refreshed on mount and when the tab returns after more than a minute hidden.
import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { getValidSession, useCachedQuery, writeCache } from '@throttle/db';
import { Skeleton } from '@throttle/ui';
import { CalendarDays } from 'lucide-react';
import { podiumopsGet, isForbidden } from '../../../lib/podiumopsFetch.js';
import { labelOf, EMPLOYMENT_TYPES, tenure } from '../../../lib/format.js';
import { Avatar, KpiTile, card, cardLabel } from '../../../components/ui.js';
import { fmtDateTime } from '../../../lib/hiring.js';
import { RESPONSE_KIND } from '../../../components/OfferBits.js';
import { ProfileBanner } from '../../../components/OnboardingBits.js';
import { LoadError } from '../../../components/LoadError.js';
import {
  dashboardPeople, dashboardDepartments, peopleKey, cacheIdentities, purgeLegacyPeopleCache, DEPARTMENTS_KEY,
  freshness, shouldRefreshOnReturn, istDate, msUntilNextIstMidnight,
} from '../../../lib/dashboard.mjs';

const BAR_COLS = ['#F2CD1A', '#9fb0ff', '#4ade80', '#fb923c', '#fbbf24', '#ff8a8a'];

export default function DashboardPage() {
  const { session, userId, perms, user, loading: authLoading } = useAuth();
  const router = useRouter();

  // Nothing seeds or fetches until perms are known AND grant podium_view (the dashboard's gate):
  // a cached figure must never show to someone whose rights have since narrowed. The token is read
  // at call time — the session this render closed over may have expired while the tab was hidden.
  // A failure THROWS (podiumopsGet, and the builders on a bad reply) — never cached, never a 0.
  const live = !!session && !!perms?.podium_view;
  const ids = cacheIdentities(perms?.podium_view ? userId : null); // null = no identity → no seed, no write
  const qUser = ids.departments;
  // Anything an earlier build cached for the people tiles is removed on mount.
  useEffect(() => {
    try { purgeLegacyPeopleCache(window.sessionStorage); } catch { /* storage blocked: nothing to purge */ }
  }, []);

  // The IST day the tiles are for. A render at or after IST midnight picks up the new day (new key → refresh,
  // via the effect below); `tick` forces that render — at the next IST midnight while mounted, and on a tab
  // return that crosses midnight. setTimeout/clearTimeout are called directly (decisions: Odo, 2026-11-14).
  const [tick, setTick] = useState(0);
  const day = istDate();
  const dayRef = useRef(day);
  dayRef.current = day;
  useEffect(() => {
    const t = setTimeout(() => setTick(n => n + 1), msUntilNextIstMidnight(Date.now()) + 1000);
    return () => clearTimeout(t);
  }, [tick]);

  const pKey = peopleKey(day);
  const peopleQ = useCachedQuery({ key: pKey, userId: ids.people, enabled: live,
    fetcher: async () => dashboardPeople(await podiumopsGet('getEmployees', { status: 'all', limit: 2000 }, await getValidSession()), Date.now()) });
  const deptQ = useCachedQuery({ key: DEPARTMENTS_KEY, userId: qUser, enabled: live,
    fetcher: async () => dashboardDepartments(await podiumopsGet('getDepartments', {}, await getValidSession())) });

  // O1: open candidate responses (caller's offers only) — candidate data, so fresh every time, never cached.
  // Gated on the same `live` as the cached sections: nothing is asked before perms are known.
  const [replies, setReplies] = useState([]);
  const [repliesErr, setRepliesErr] = useState(null);
  const loadReplies = useCallback(async () => {
    setRepliesErr(null);
    try {
      const r = await podiumopsGet('getOfferResponses', {}, await getValidSession());
      setReplies(Array.isArray(r) ? r : (r?.responses || []));
    } catch (e) { setRepliesErr(e); }
  }, []);

  const refreshAll = () => { peopleQ.refresh(); deptQ.refresh(); };
  useEffect(() => { if (live) refreshAll(); }, [userId, live, pKey]); // eslint-disable-line
  useEffect(() => { if (live) loadReplies(); }, [userId, live, loadReplies]);

  // Access revoked mid-tab: a refresh answered 403 (the worker's forbidden_podium_view). The cached tiles are
  // not this viewer's to see any more — take them off the screen and out of the cache (writeCache with no
  // value removes the key), rather than "Couldn't refresh — showing HH:MM" over them.
  const revoked = isForbidden(peopleQ.error) || isForbidden(deptQ.error);
  useEffect(() => {
    if (!revoked || !qUser) return;
    writeCache(qUser, DEPARTMENTS_KEY, undefined);
  }, [revoked, qUser]);

  // Back on the tab: the IST day changed while away → re-render for the new day (its key change refreshes,
  // whatever the 60 s rule says); otherwise after more than a minute away → one refresh of every section.
  const hiddenAt = useRef(null);
  useEffect(() => {
    if (!userId) return undefined;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt.current = Date.now(); return; }
      const wasHiddenAt = hiddenAt.current;
      hiddenAt.current = null;
      if (istDate() !== dayRef.current) { setTick(n => n + 1); if (live) loadReplies(); return; }
      if (shouldRefreshOnReturn(wasHiddenAt) && live) { refreshAll(); loadReplies(); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [userId, live]); // eslint-disable-line

  // getMe failed with no cached identity: AuthProvider has finished (not loading), holds a session, but has
  // neither perms nor a user — without this the sections would wait on perms for ever.
  if (session && !authLoading && !perms && !user) {
    return <LoadError message="Couldn't load your access." onRetry={() => window.location.reload()} />;
  }
  if ((perms && !perms.podium_view) || revoked) {
    return <div style={{ color: 'var(--t3)', fontSize: 14 }}>The dashboard needs People access. Your own record is under My Performance.</div>;
  }

  const fresh = freshness([peopleQ, deptQ]);
  const p = peopleQ.data;
  const dp = deptQ.data;
  const pFailed = !!peopleQ.error && p === undefined;
  const dFailed = !!deptQ.error && dp === undefined;
  const pTile = (label, render) => p !== undefined ? render() : pFailed ? <KpiError label={label} onRetry={peopleQ.refresh} /> : <KpiSkeleton />;

  return (
    <div>
      {/* J2: your own "Complete your profile" banner (self-scoped getMyProfile) — fresh, not cached. */}
      <ProfileBanner session={session} />
      <div aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, minHeight: 15, marginBottom: 8, color: fresh.warn ? 'var(--warn-fg)' : 'var(--t4)' }}>
        <span>{fresh.text}</span>
        {fresh.warn && <button type="button" onClick={refreshAll} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontSize: 11.5, textDecoration: 'underline' }}>Retry</button>}
      </div>
      {/* KPI rail */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {pTile('Headcount', () => <KpiTile label="Headcount" value={p.headcount} sub={p.newCount ? `+${p.newCount} this month` : 'steady'} subColor="var(--green-bright)" stripe />)}
        {dp !== undefined ? <KpiTile label="Departments" value={dp.count} sub={`${dp.activeCount} active`} />
          : dFailed ? <KpiError label="Departments" onRetry={deptQ.refresh} /> : <KpiSkeleton />}
        {pTile('On Leave', () => <KpiTile label="On Leave" value={p.onLeave} sub={p.onLeave ? 'currently away' : 'none'} subColor="var(--warn-fg)" />)}
        {pTile('Notice', () => <KpiTile label="Notice" value={p.notice} sub={p.notice ? 'serving notice' : 'none'} subColor="var(--bad-fg)" />)}
        {pTile('New · 30d', () => <KpiTile label="New · 30d" value={p.newCount} sub={p.newCount ? 'onboarding' : 'none'} subColor="var(--green-bright)" />)}
      </div>

      {/* Leave R1 (D15): requests the caller may decide (getMe's podium_leave_pending). */}
      {Number(perms?.podium_leave_pending) > 0 && (
        <div onClick={() => router.push('/leave')} style={{ ...card, marginBottom: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
          <CalendarDays size={16} style={{ color: 'var(--yellow)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>
            {Number(perms.podium_leave_pending)} leave {Number(perms.podium_leave_pending) === 1 ? 'request' : 'requests'} waiting for you
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--yellow)' }}>Review →</span>
        </div>
      )}

      {repliesErr && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={cardLabel}>Candidate responses</div>
          <LoadError message="Couldn't load candidate responses." onRetry={loadReplies} style={{ padding: 0 }} />
        </div>
      )}
      {replies.length > 0 && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={cardLabel}>Candidate responses</div>
          {replies.map(r => (
            <div key={r.id} onClick={() => router.push(`/hiring/offer/?id=${r.offer_id}`)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 13, cursor: 'pointer', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{r.candidate_name || r.offer_ref}</span>
              <span style={{ color: 'var(--t-body)' }}>{RESPONSE_KIND[r.kind] || r.kind}{r.reason ? ` · ${String(r.reason).replace(/_/g, ' ')}` : ''}</span>
              <span className="num" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--yellow)' }}>{fmtDateTime(r.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Card grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <div style={card}>
          <div style={cardLabel}>By Department</div>
          {dp === undefined ? (dFailed ? <LoadError message="Couldn't load departments." onRetry={deptQ.refresh} style={{ padding: 0 }} /> : <BarsSkeleton />)
            : dp.rows.length === 0 ? <Empty /> : dp.rows.map((d, i) => (
              <Bar key={d.id} label={d.name} value={d.value} pct={d.pct} color={BAR_COLS[i % BAR_COLS.length]} />
            ))}
        </div>

        <div style={card}>
          <div style={cardLabel}>Recent Joiners</div>
          {p === undefined ? <PeopleFallback failed={pFailed} onRetry={peopleQ.refresh} />
            : p.recent.length === 0 ? <Empty /> : p.recent.map(e => (
              <div key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '7px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                <Avatar name={e.full_name} photoUrl={e.photo_url} tintKey={e.id} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{e.full_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)' }}>{e.job_title || '—'}</div>
                </div>
                <span className="num" style={{ fontSize: 11.5, color: 'var(--yellow)' }}>{tenure(e.date_joined)}</span>
              </div>
            ))}
        </div>

        <div style={card}>
          <div style={cardLabel}>By Employment Type</div>
          {p === undefined ? (pFailed ? <PeopleFallback failed onRetry={peopleQ.refresh} /> : <BarsSkeleton />)
            : p.types.length === 0 ? <Empty /> : p.types.map((t, i) => (
              <Bar key={t.key} label={labelOf(EMPLOYMENT_TYPES, t.key)} value={t.value} pct={t.pct} color={BAR_COLS[(i + 1) % BAR_COLS.length]} />
            ))}
        </div>

        <div style={card}>
          <div style={cardLabel}>Upcoming Anniversaries</div>
          {p === undefined ? <PeopleFallback failed={pFailed} onRetry={peopleQ.refresh} />
            : p.anniversaries.length === 0 ? <Empty text="None in the next 30 days" /> : p.anniversaries.map(e => (
              <WhenRow key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)} name={e.full_name} title={e.job_title} when={e.when} />
            ))}
        </div>

        <div style={card}>
          <div style={cardLabel}>Upcoming Birthdays</div>
          {p === undefined ? <PeopleFallback failed={pFailed} onRetry={peopleQ.refresh} />
            : p.birthdays.length === 0 ? <Empty text="None in the next 30 days" /> : p.birthdays.map(e => (
              <WhenRow key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)} name={e.full_name} title={e.job_title} when={e.when} />
            ))}
        </div>
      </div>
    </div>
  );
}

// ── Loading / error states, laid out like what they stand in for ──
const tileFrame = { flex: '1 1 150px', minWidth: 150, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11, padding: '13px 16px' };
function KpiSkeleton() {
  return (
    <div aria-busy="true" style={tileFrame}>
      <Skeleton width="55%" height={9} />
      <Skeleton width="40%" height={25} style={{ margin: '6px 0 4px' }} />
      <Skeleton width="60%" height={10} />
    </div>
  );
}
function KpiError({ label, onRetry }) {
  return (
    <div style={tileFrame}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t4)' }}>{label}</div>
      <LoadError compact message="Couldn't load." onRetry={onRetry} style={{ marginTop: 10 }} />
    </div>
  );
}
function BarsSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'grid', gap: 14 }}>
      {Array.from({ length: 4 }, (_, i) => <div key={i}><Skeleton width="70%" height={11} style={{ marginBottom: 6 }} /><Skeleton height={5} /></div>)}
    </div>
  );
}
function RowsSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'grid', gap: 14, paddingTop: 7 }}>
      {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} width={i % 2 ? '70%' : '85%'} height={13} />)}
    </div>
  );
}
function PeopleFallback({ failed, onRetry }) {
  return failed ? <LoadError message="Couldn't load people." onRetry={onRetry} style={{ padding: 0 }} /> : <RowsSkeleton />;
}

function Bar({ label, value, pct, color }) {
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ color: 'var(--t-body)' }}>{label}</span>
        <span className="num" style={{ color: 'var(--t3)' }}>{value}</span>
      </div>
      <div style={{ height: 5, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}
function WhenRow({ name, title, when, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 13, cursor: 'pointer' }}>
      <span style={{ color: 'var(--t-body)' }}>{name}{title && <span style={{ color: 'var(--t4)', fontSize: 11, marginLeft: 6 }}>{title}</span>}</span>
      <span className="num" style={{ fontSize: 11.5, color: 'var(--yellow)' }}>{when}</span>
    </div>
  );
}
function Empty({ text = 'No data' }) { return <div style={{ color: 'var(--t3)', fontSize: 12, padding: '6px 0' }}>{text}</div>; }
