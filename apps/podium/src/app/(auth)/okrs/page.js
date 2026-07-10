'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState } from '@throttle/ui';
import { Target, Settings2 } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { CYCLE_STATUS } from '../../../lib/okrs.js';
import { ObjectiveCard } from '../../../components/OkrPanels.js';
import { pageTitle } from '../../../components/ui.js';

export default function OkrsPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [config, setConfig] = useState(null);
  const [cycleId, setCycleId] = useState('');
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!session) return;
    podiumopsGet('getOkrConfig', {}, session)
      .then(c => { setConfig(c); setCycleId(c.current?.id || ''); })
      .catch(() => setConfig(false));
  }, [session]);

  const loadCycle = useCallback(() => {
    if (!session || !cycleId) { setData(null); return; }
    setData(null);
    podiumopsGet('getOkrCycle', { id: cycleId }, session).then(setData).catch(() => setData(false));
  }, [session, cycleId]);
  useEffect(() => { loadCycle(); }, [loadCycle]);

  if (config == null) return <Spinner />;
  if (config === false) return <EmptyState title="Couldn't load OKRs" subtitle="Try again shortly." />;

  const cycles = config.cycles || [];
  const groups = groupObjectives(data?.objectives || []);

  return (
    <div style={{ maxWidth: 920 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ ...pageTitle, display: 'flex', alignItems: 'center', gap: 8 }}><Target size={17} /> OKRs</div>
        <div style={{ flex: 1 }} />
        {cycles.length > 0 && (
          <select value={cycleId} onChange={e => setCycleId(e.target.value)} style={selStyle}>
            {cycles.map(c => <option key={c.id} value={c.id}>{c.name} · {CYCLE_STATUS[c.status] || c.status}</option>)}
          </select>
        )}
        {config.can_admin && (
          <button onClick={() => router.push('/okrs/cycle' + (cycleId ? `/?id=${cycleId}` : ''))} style={manageBtn}>
            <Settings2 size={13} /> Manage cycles
          </button>
        )}
      </div>

      {cycles.length === 0 ? (
        <EmptyState title="No OKR cycle yet"
          subtitle={config.can_admin ? 'Create the first cycle from Manage cycles.' : 'HR hasn’t opened an OKR cycle yet.'} />
      ) : data == null ? <Spinner />
        : data === false ? <EmptyState title="Couldn't load this cycle" />
        : (data.objectives || []).length === 0 ? (
          <EmptyState title="No objectives yet"
            subtitle={data.can_admin ? 'Seed company & department objectives from Manage cycles.' : 'Nothing has been set for this cycle yet.'} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {['company', 'department', 'individual'].map(level => groups[level].length > 0 && (
              <Section key={level} title={SECTION_TITLES[level]} objs={groups[level]}
                allById={groups.byId} onOpen={o => router.push(`/okrs/detail/?id=${o.id}`)} />
            ))}
          </div>
        )}
    </div>
  );
}

const SECTION_TITLES = { company: 'Company objectives', department: 'Department objectives', individual: 'Individual objectives' };

function Section({ title, objs, allById, onOpen }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 10 }}>{title} · {objs.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {objs.map(o => (
          <div key={o.id}>
            <ObjectiveCard obj={o} onOpen={() => onOpen(o)} />
            {o.parent_objective_id && allById[o.parent_objective_id] && (
              <div style={{ fontSize: 11, color: 'var(--t4)', margin: '4px 0 0 14px' }}>↳ aligns to “{allById[o.parent_objective_id].title}”</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function groupObjectives(objs) {
  const byId = {};
  for (const o of objs) byId[o.id] = o;
  return {
    company: objs.filter(o => o.level === 'company'),
    department: objs.filter(o => o.level === 'department'),
    individual: objs.filter(o => o.level === 'individual'),
    byId,
  };
}

const selStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none' };
const manageBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer' };
