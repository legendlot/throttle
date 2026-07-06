'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { CheckSquare, ClipboardCheck, ChevronRight } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../lib/format.js';
import { ObservationsPanel, WinsPanel, OneOnOnesPanel } from '../../../components/PerformancePanels.js';
import MyCompensation from '../../../components/MyCompensation.js';
import MyPayouts from '../../../components/MyPayouts.js';

const TABS = [
  { id: 'wins',         label: 'My Wins' },
  { id: 'observations', label: 'Shared With Me' },
  { id: '1on1',         label: 'My 1:1s' },
];

export default function MyPerformancePage() {
  const { session } = useAuth();
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('wins');

  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getMyPerformance', {}, session).then(setMe).catch(() => setMe(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (me == null) return <Spinner />;
  if (me === false || !me.employee_id) {
    return (
      <div style={{ maxWidth: 840 }}>
        <div style={{ color: 'var(--t3)', fontSize: 14 }}>You don&apos;t have an employee profile linked to your login yet. Ask HR to set one up.</div>
      </div>
    );
  }

  const open = me.open_action_items || [];
  return (
    <div style={{ maxWidth: 840 }}>
      <AppraisalsBanner session={session} />

      <MyCompensation />
      <MyPayouts />

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

      {tab === 'wins' ? <WinsPanel employeeId={me.employee_id} session={session} />
        : tab === 'observations' ? <ObservationsPanel employeeId={me.employee_id} session={session} />
        : <OneOnOnesPanel employeeId={me.employee_id} session={session} />}
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
  const go = (id) => router.push(`/appraisals/detail/?id=${id}`);

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
