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
import { Avatar, FilterChip } from '../../../components/ui.js';

const KINDS = [
  { id: 'all',         label: 'All' },
  { id: 'observation', label: 'Observations' },
  { id: 'win',         label: 'Wins' },
  { id: 'one_on_one',  label: '1:1s' },
];
const KIND_META = {
  observation: { label: 'Observation', fg: 'var(--blue-soft)' },
  win:         { label: 'Win',         fg: 'var(--green-bright)' },
  one_on_one:  { label: '1:1',         fg: 'var(--t2)' },
};

export default function TeamFeedPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('all');
  const [person, setPerson] = useState('');
  const [logFor, setLogFor] = useState('');

  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getTeamActivity', {}, session).then(setData).catch(() => setData({ activity: [], team: [] }));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (data == null) return <Spinner />;
  const team = data.team || [];
  if (team.length === 0) {
    return (
      <div style={{ maxWidth: 880 }}>
        <div style={{ color: 'var(--t3)', fontSize: 14 }}>You don&apos;t manage anyone yet. People who report to you (directly or indirectly) show up here.</div>
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
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {KINDS.map(k => <FilterChip key={k.id} active={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</FilterChip>)}
        <div style={{ width: 190, marginLeft: 4 }}>
          <Combobox value={person} onChange={v => setPerson(v)} inputStyle={comboInp} placeholder="Everyone"
            options={team.map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} />
        </div>
        <span style={{ flex: 1 }} />
        {!logFor && (
          <div style={{ width: 220 }}>
            <Combobox value="" onChange={v => v && setLogFor(v)} allowClear={false}
              inputStyle={{ ...comboInp, background: 'var(--yellow)', color: '#1b1b1e', fontWeight: 600, border: '1px solid var(--yellow)' }}
              placeholder="＋ Log observation for…"
              options={team.map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} />
          </div>
        )}
      </div>

      {logFor && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11, padding: 14, marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <MessageSquarePlus size={15} color="var(--yellow)" />
            <span style={{ fontWeight: 600, color: 'var(--t1)' }}>Observations · {team.find(p => p.id === logFor)?.full_name}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { setLogFor(''); load(); }} style={closeBtn}><X size={14} /></button>
          </div>
          <ObservationsPanel employeeId={logFor} session={session} />
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ color: 'var(--t3)', fontSize: 14 }}>No activity yet.</div>
      ) : items.map(it => (
        <ActivityCard key={`${it.kind}-${it.id}`} it={it} person={personOf(it)} onOpen={() => personOf(it).id && router.push(`/people/detail/?id=${personOf(it).id}`)} />
      ))}
    </div>
  );
}

function ActivityCard({ it, person, onOpen }) {
  const km = KIND_META[it.kind] || { label: it.kind, fg: 'var(--t2)' };
  const sm = it.kind === 'observation' ? sentimentMeta(it.sentiment) : null;
  return (
    <div onClick={onOpen} className="pd-card-hover" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11, padding: '13px 16px', marginBottom: 9, cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Avatar name={person.full_name} photoUrl={person.photo_url} tintKey={person.id} size={30} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{person.full_name || '—'}</span>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: km.fg }}>{km.label}</span>
        {sm && <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 'var(--r-full)', color: sm.color, background: sm.bg }}>{sm.label}</span>}
        <span style={{ flex: 1 }} />
        <span className="num" style={{ fontSize: 12, color: 'var(--t4)' }}>{fmtDate(it.date)}</span>
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--t-body)', lineHeight: 1.5, paddingLeft: 40, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
        {it.kind === 'observation' && it.body}
        {it.kind === 'win' && <><strong>{it.title}</strong>{it.description ? ` — ${it.description}` : ''}</>}
        {it.kind === 'one_on_one' && (it.shared_notes || (it._private_hidden ? <em style={{ color: 'var(--t3)' }}>Private 1:1</em> : '—'))}
      </div>
    </div>
  );
}

const comboInp = { fontFamily: 'var(--font-ui)', fontSize: 13, padding: '7px 10px' };
const closeBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'var(--bg)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', cursor: 'pointer' };
