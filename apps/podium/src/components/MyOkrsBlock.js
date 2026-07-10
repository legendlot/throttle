'use client';
// My OKRs — shown on /me. My individual objectives (with inline check-in + open detail),
// a self-serve "New objective" for the current cycle, plus the company/dept objectives
// surfaced to me (read-only). Reachable by self-only users (getMyOkrs is self-scoped).
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Target, Plus, ChevronRight } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { CYCLE_STATUS } from '../lib/okrs.js';
import { ObjectiveCard, Field, inp, miniBtn } from './OkrPanels.js';

export default function MyOkrsBlock({ session, employeeId }) {
  const router = useRouter();
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    podiumopsGet('getMyOkrs', {}, session).then(setD).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (!d || d === false) return null;
  if (!d.cycle) return null; // no active OKR cycle — stay quiet

  const mine = d.my_objectives || [];
  const surfaced = d.surfaced || [];
  const canAdd = d.cycle.status !== 'closed';

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Target size={15} color="var(--yellow)" />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t1)' }}>My OKRs</span>
        <span style={{ fontSize: 11, color: 'var(--t4)' }}>{d.cycle.name} · {CYCLE_STATUS[d.cycle.status]}</span>
        <span style={{ flex: 1 }} />
        {canAdd && <button onClick={() => setAdding(a => !a)} style={miniBtn}><Plus size={13} /> New objective</button>}
      </div>

      {adding && <NewMineForm session={session} cycleId={d.cycle.id} ownerId={employeeId} onDone={() => { setAdding(false); load(); }} />}

      {mine.length === 0 && !adding && (
        <div style={{ fontSize: 13, color: 'var(--t3)', padding: '6px 0 12px' }}>You have no objectives this cycle{canAdd ? ' — add one above.' : '.'}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {mine.map(o => <ObjectiveCard key={o.id} obj={o} onOpen={() => router.push(`/okrs/detail/?id=${o.id}`)} />)}
      </div>

      {surfaced.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t4)', marginBottom: 8 }}>Company & department goals</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {surfaced.map(o => (
              <div key={o.id} onClick={() => router.push(`/okrs/detail/?id=${o.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: 'var(--t2)' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t4)' }}>{o.level === 'company' ? 'Co' : 'Dept'}</span>
                <span style={{ flex: 1, color: 'var(--t1)' }}>{o.title}</span>
                <ChevronRight size={14} color="var(--t4)" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NewMineForm({ session, cycleId, ownerId, onDone }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!title.trim()) return alert('Title required');
    setBusy(true);
    try {
      await podiumopsPost('createObjective', { data: { cycle_id: cycleId, level: 'individual', owner_employee_id: ownerId, title, description: description || null } }, session);
      onDone();
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 13, marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
      <Field label="Objective" w={300}><input value={title} onChange={e => setTitle(e.target.value)} placeholder="What will you achieve this cycle?" style={inp} /></Field>
      <Field label="Description (optional)" w={280}><input value={description} onChange={e => setDescription(e.target.value)} style={inp} /></Field>
      <button disabled={busy} onClick={save} style={{ ...miniBtn, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', height: 34 }}>{busy ? '…' : 'Create'}</button>
      <div style={{ fontSize: 11, color: 'var(--t4)', flexBasis: '100%' }}>Add key results after creating, from the objective page.</div>
    </div>
  );
}
