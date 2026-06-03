'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { CheckSquare, ClipboardCheck, ChevronRight } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../lib/format.js';
import { ObservationsPanel, WinsPanel, OneOnOnesPanel } from '../../../components/PerformancePanels.js';

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
      <div style={{ maxWidth: 760 }}>
        <h1 style={h1}>My Performance</h1>
        <div style={empty}>You don&apos;t have an employee profile linked to your login yet. Ask HR to set one up.</div>
      </div>
    );
  }

  const open = me.open_action_items || [];
  return (
    <div style={{ maxWidth: 820 }}>
      <h1 style={h1}>My Performance</h1>

      <AppraisalsBlock session={session} />

      {open.length > 0 && (
        <div style={banner}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, marginBottom: 6 }}>
            <CheckSquare size={15} /> Open action items ({open.length})
          </div>
          {open.map((a, i) => (
            <div key={i} style={{ fontSize: 13, padding: '2px 0', color: 'var(--text-2)' }}>
              • {a.text} <span style={{ color: 'var(--text-3)', fontSize: 11 }}>· from 1:1 {fmtDate(a.met_on)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={tabBar}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...tabBtn, ...(tab === t.id ? tabBtnActive : {}) }}>{t.label}</button>
        ))}
      </div>

      {tab === 'wins' ? <WinsPanel employeeId={me.employee_id} session={session} />
        : tab === 'observations' ? <ObservationsPanel employeeId={me.employee_id} session={session} />
        : <OneOnOnesPanel employeeId={me.employee_id} session={session} />}
    </div>
  );
}

function AppraisalsBlock({ session }) {
  const router = useRouter();
  const [d, setD] = useState(null);
  useEffect(() => { podiumopsGet('getMyAppraisals', {}, session).then(setD).catch(() => setD(false)); }, [session]);
  if (!d || d === false) return null;
  const mine = (d.appraisals || []).filter(a => ['self_review', 'manager_review', 'shared'].includes(a.status));
  const toReview = (d.to_review || []).filter(r => !r.done);
  if (!mine.length && !toReview.length) return null;
  const go = (id) => router.push(`/appraisals/detail/?id=${id}`);
  return (
    <div style={apBox}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, marginBottom: 8, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-2)' }}>
        <ClipboardCheck size={15} /> Appraisals
      </div>
      {mine.map(a => (
        <div key={a.id} onClick={() => go(a.id)} style={apRow}>
          <span>{a.cycle?.name} — {a.status === 'shared' ? 'your result is ready' : a.self_submitted_at ? 'self-review submitted (editable)' : 'start your self-review'}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--podium-accent)' }}>{a.status === 'shared' ? 'View' : 'Open'} <ChevronRight size={14} /></span>
        </div>
      ))}
      {toReview.map(r => (
        <div key={r.id} onClick={() => go(r.id)} style={apRow}>
          <span>Review <b>{r.employee?.full_name}</b> <span style={{ color: 'var(--text-3)', fontSize: 12 }}>· {r.cycle?.name}</span></span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--podium-accent)' }}>Review <ChevronRight size={14} /></span>
        </div>
      ))}
    </div>
  );
}

const apBox = { background: 'var(--accent-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px 14px', marginBottom: 16 };
const apRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13, marginTop: 6 };
const h1 = { fontFamily: 'var(--font-cond)', fontSize: 24, fontWeight: 700, letterSpacing: '0.03em', marginBottom: 16 };
const empty = { color: 'var(--text-3)', fontSize: 14 };
const banner = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px 14px', marginBottom: 16 };
const tabBar = { display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 };
const tabBtn = { background: 'transparent', color: 'var(--text-3)', border: 'none', borderBottom: '2px solid transparent', padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: -1 };
const tabBtnActive = { color: 'var(--text-1)', borderBottomColor: 'var(--podium-accent)' };
