'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Combobox } from '@throttle/ui';
import { MessageSquarePlus, X } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../lib/format.js';
import { sentimentMeta } from '../../../lib/performance.js';
import { ObservationsPanel } from '../../../components/PerformancePanels.js';

const KINDS = [
  { id: 'all',         label: 'All' },
  { id: 'observation', label: 'Observations' },
  { id: 'win',         label: 'Wins' },
  { id: 'one_on_one',  label: '1:1s' },
];

export default function TeamFeedPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('all');
  const [person, setPerson] = useState('');     // employee id filter
  const [logFor, setLogFor] = useState('');      // employee id for inline quick-log

  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getTeamActivity', {}, session).then(setData).catch(() => setData({ activity: [], team: [] }));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (data == null) return <Spinner />;
  const team = data.team || [];
  if (team.length === 0) {
    return (
      <div style={{ maxWidth: 820 }}>
        <h1 style={h1}>Team</h1>
        <div style={{ color: 'var(--text-3)', fontSize: 14 }}>You don&apos;t manage anyone yet. People who report to you (directly or indirectly) show up here.</div>
      </div>
    );
  }

  const personOf = (it) => (it.subject || it.employee || it.report || {});
  const items = (data.activity || []).filter(it => {
    if (kind !== 'all' && it.kind !== kind) return false;
    if (person && personOf(it).id !== person) return false;
    return true;
  });

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 style={h1}>Team</h1>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <select value={kind} onChange={e => setKind(e.target.value)} style={sel(150)}>
          {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <Combobox value={person} onChange={v => setPerson(v)} style={{ width: 200 }} inputStyle={comboInp} placeholder="Everyone"
          options={team.map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} />
        <span style={{ flex: 1 }} />
        {!logFor && (
          <Combobox value="" onChange={v => v && setLogFor(v)} style={{ width: 220 }} allowClear={false}
            inputStyle={{ ...comboInp, background: 'var(--podium-accent)', color: '#1f1f1f', fontWeight: 600 }}
            placeholder="＋ Log observation for…"
            options={team.map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} />
        )}
      </div>

      {logFor && (
        <div style={logCard}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <MessageSquarePlus size={15} color="var(--podium-accent)" />
            <span style={{ fontWeight: 600 }}>Observations · {team.find(p => p.id === logFor)?.full_name}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { setLogFor(''); load(); }} style={closeBtn}><X size={14} /></button>
          </div>
          <ObservationsPanel employeeId={logFor} session={session} />
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 14 }}>No activity yet.</div>
      ) : items.map(it => (
        <ActivityCard key={`${it.kind}-${it.id}`} it={it} person={personOf(it)} onOpen={() => personOf(it).id && router.push(`/people/detail/?id=${personOf(it).id}`)} />
      ))}
    </div>
  );
}

function ActivityCard({ it, person, onOpen }) {
  const badge = it.kind === 'observation' ? { label: 'Observation', color: 'var(--brand-orange)' }
    : it.kind === 'win' ? { label: 'Win', color: 'var(--state-success-fg)' }
    : { label: '1:1', color: 'var(--text-2)' };
  return (
    <div style={card} onClick={onOpen}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span style={{ ...kindBadge, color: badge.color }}>{badge.label}</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{person.full_name || '—'}</span>
        {it.kind === 'observation' && <span style={{ ...chip, color: sentimentMeta(it.sentiment).color, background: sentimentMeta(it.sentiment).bg }}>{sentimentMeta(it.sentiment).label}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{fmtDate(it.date)}</span>
      </div>
      {it.kind === 'observation' && <div style={body}>{it.body}</div>}
      {it.kind === 'win' && <div style={body}><strong>{it.title}</strong>{it.description ? ` — ${it.description}` : ''}</div>}
      {it.kind === 'one_on_one' && <div style={body}>{it.shared_notes || (it._private_hidden ? <em style={{ color: 'var(--text-3)' }}>Private 1:1</em> : '—')}</div>}
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 24, fontWeight: 700, letterSpacing: '0.03em', marginBottom: 16 };
const sel = (w) => ({ background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 9px', fontSize: 13, width: w });
const comboInp = { fontSize: 13, padding: '7px 9px' };
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '11px 14px', marginBottom: 9, cursor: 'pointer' };
const logCard = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, marginBottom: 18 };
const kindBadge = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' };
const chip = { fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 'var(--radius-full)' };
const body = { fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-wrap', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' };
const closeBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'var(--surface)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
