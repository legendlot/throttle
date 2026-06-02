'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { CheckSquare } from 'lucide-react';
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

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 24, fontWeight: 700, letterSpacing: '0.03em', marginBottom: 16 };
const empty = { color: 'var(--text-3)', fontSize: 14 };
const banner = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px 14px', marginBottom: 16 };
const tabBar = { display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 };
const tabBtn = { background: 'transparent', color: 'var(--text-3)', border: 'none', borderBottom: '2px solid transparent', padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: -1 };
const tabBtnActive = { color: 'var(--text-1)', borderBottomColor: 'var(--podium-accent)' };
