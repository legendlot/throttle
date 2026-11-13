'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { CheckSquare, ClipboardCheck, ChevronRight } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../lib/format.js';
import { ObservationsPanel, WinsPanel, OneOnOnesPanel } from '../../../components/PerformancePanels.js';
import MyCompensation from '../../../components/MyCompensation.js';
import MyPayouts from '../../../components/MyPayouts.js';
import MyOkrsBlock from '../../../components/MyOkrsBlock.js';
import { MyExitBlock } from '../../../components/ExitBits.js';
import { ProfileBanner } from '../../../components/OnboardingBits.js';
import { LoadError } from '../../../components/LoadError.js';
import { decideLink } from '../../../lib/myLink.mjs';

const TABS = [
  { id: 'wins',         label: 'My Wins' },
  { id: 'observations', label: 'Shared With Me' },
  { id: '1on1',         label: 'My 1:1s' },
];

export default function MyPerformancePage() {
  const { session, brandUser } = useAuth();
  const [tab, setTab] = useState('wins');

  // getMyPerformance feeds only the open 1:1 action items here (and confirms the employee link) — a
  // panel-level call, not a gate: the page mounts as soon as the caller's employee id is known, and
  // every panel (Wins included, via its own getAccomplishments) fetches in parallel with it.
  const [perf, setPerf] = useState(null);
  const [perfErr, setPerfErr] = useState(null);
  const seq = useRef(0);
  const loadPerf = useCallback(() => {
    if (!session) return;
    const mine = ++seq.current;
    setPerfErr(null);
    podiumopsGet('getMyPerformance', {}, session)
      .then(d => { if (mine === seq.current) setPerf(d); })
      .catch(e => { if (mine === seq.current) setPerfErr(e); });
  }, [session]);
  useEffect(() => { loadPerf(); }, [loadPerf]);

  // The auth context's id mounts the panels optimistically; this page's own getMyPerformance is the
  // authority — its id wins, and only its successful "no employee" shows "no profile" (lib/myLink.mjs).
  const link = decideLink({
    contextId: brandUser?.employee_id || null,
    perfStatus: perf ? 'ok' : perfErr ? 'error' : 'loading',
    perfId: perf?.employee_id || null,
  });
  const employeeId = link.employeeId;

  if (link.state === 'noProfile') {
    return (
      <div style={{ maxWidth: 840 }}>
        <div style={{ color: 'var(--t3)', fontSize: 14 }}>You don&apos;t have an employee profile linked to your login yet. Ask HR to set one up.</div>
      </div>
    );
  }
  if (link.state !== 'panels') {
    return (
      <div style={{ maxWidth: 840 }}>
        {link.state === 'error' ? <LoadError message="Couldn't load your performance page." onRetry={loadPerf} /> : <Spinner />}
      </div>
    );
  }

  const open = perf?.open_action_items || [];
  return (
    <div style={{ maxWidth: 840 }}>
      {/* J2: "Complete your profile — N items left" while the campaign is on (or a joiner's onboarding is open). */}
      <ProfileBanner session={session} />
      <AppraisalsBanner session={session} />

      <MyCompensation />
      <MyPayouts />
      <MyOkrsBlock session={session} employeeId={employeeId} />
      {/* X1: Resign / your own exit, and your reports' exits — most managers hold no podium_view, so this is
          their only way in (getExit / getMyTeamExits / startExit / updateExitItem are self-serve). */}
      <MyExitBlock employeeId={employeeId} session={session} />

      {link.perfError && <LoadError compact message="Couldn't load your open 1:1 action items." onRetry={loadPerf} style={{ marginBottom: 18 }} />}
      {open.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11, padding: '13px 16px', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--t1)', marginBottom: 8 }}>
            <CheckSquare size={15} color="var(--blue-soft)" /> Open action items · {open.length}
          </div>
          {open.map((a, i) => (
            <div key={i} style={{ fontSize: 13, padding: '3px 0', color: 'var(--t2)' }}>
              • {a.text} <span style={{ color: 'var(--t4)', fontSize: 11 }}>· from 1:1 {fmtDate(a.met_on)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        {TABS.map(t => (
          <div key={t.id} className={'pd-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>{t.label}</div>
        ))}
      </div>

      {tab === 'wins' ? <WinsPanel employeeId={employeeId} session={session} />
        : tab === 'observations' ? <ObservationsPanel employeeId={employeeId} session={session} />
        : <OneOnOnesPanel employeeId={employeeId} session={session} />}
    </div>
  );
}

function AppraisalsBanner({ session }) {
  const router = useRouter();
  const [d, setD] = useState(null);
  useEffect(() => { podiumopsGet('getMyAppraisals', {}, session).then(setD).catch(() => setD(false)); }, [session]);
  if (!d || d === false) return null;
  const mine = (d.appraisals || []).filter(a => ['self_review', 'manager_review', 'shared'].includes(a.status));
  const toReview = (d.to_review || []).filter(r => !r.done);
  if (!mine.length && !toReview.length) return null;
  const go = (id) => router.push(`/reviews/review/?id=${id}`);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
      {mine.map(a => (
        <div key={a.id} style={banner}>
          <ClipboardCheck size={18} color="var(--yellow)" style={{ flex: 'none' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{a.cycle?.name} — {a.status === 'shared' ? 'your result is ready' : a.self_submitted_at ? 'self-review submitted (editable)' : 'start your self-review'}</div>
            {a.cycle?.period_end && <div style={{ fontSize: 12, color: 'var(--t2)' }}>Window closes {fmtDate(a.cycle.period_end)}.</div>}
          </div>
          <div onClick={() => go(a.id)} style={bannerBtn}>{a.status === 'shared' ? 'View' : 'Open'}</div>
        </div>
      ))}
      {toReview.map(r => (
        <div key={r.id} style={banner}>
          <ClipboardCheck size={18} color="var(--yellow)" style={{ flex: 'none' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>Review {r.employee?.full_name}</div>
            <div style={{ fontSize: 12, color: 'var(--t2)' }}>{r.cycle?.name}</div>
          </div>
          <div onClick={() => go(r.id)} style={{ ...bannerBtn, display: 'inline-flex', alignItems: 'center', gap: 5 }}>Review <ChevronRight size={14} /></div>
        </div>
      ))}
    </div>
  );
}

const banner = { display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(242,205,26,0.07)', border: '1px solid var(--yellow)', borderRadius: 11, padding: '14px 18px' };
const bannerBtn = { background: 'var(--yellow)', color: '#1b1b1e', borderRadius: 6, padding: '7px 14px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
