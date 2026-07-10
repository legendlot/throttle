'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, Combobox, useToast } from '@throttle/ui';
import { Plus, ChevronLeft } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { CYCLE_STATUS, LEVELS, anchorOptions } from '../../../../lib/okrs.js';
import { ObjectiveCard, Field, inp, miniBtn } from '../../../../components/OkrPanels.js';
import { pageTitle } from '../../../../components/ui.js';

const NEXT_STATUS = { draft: 'active', active: 'scoring', scoring: 'closed' };
const NEXT_LABEL = { draft: 'Open (activate)', active: 'Move to scoring', scoring: 'Close cycle' };

function CycleInner() {
  const { session } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const qId = useSearchParams().get('id');
  const [config, setConfig] = useState(null);
  const [cycleId, setCycleId] = useState(qId || '');
  const [data, setData] = useState(null);
  const [creatingCycle, setCreatingCycle] = useState(false);
  const [addingObj, setAddingObj] = useState(false);
  const [people, setPeople] = useState([]);
  const [depts, setDepts] = useState([]);

  const loadConfig = useCallback(() => {
    podiumopsGet('getOkrConfig', {}, session)
      .then(c => { setConfig(c); if (!cycleId) setCycleId(c.current?.id || ''); })
      .catch(() => setConfig(false));
  }, [session]); // eslint-disable-line
  useEffect(() => { if (session) loadConfig(); }, [session, loadConfig]);

  useEffect(() => {
    if (!session) return;
    podiumopsGet('getEmployees', {}, session).then(r => setPeople(r.employees || r || [])).catch(() => {});
    podiumopsGet('getDepartments', {}, session).then(r => setDepts(r.departments || r || [])).catch(() => {});
  }, [session]);

  const loadCycle = useCallback(() => {
    if (!session || !cycleId) { setData(null); return; }
    setData(null);
    podiumopsGet('getOkrCycle', { id: cycleId }, session).then(setData).catch(() => setData(false));
  }, [session, cycleId]);
  useEffect(() => { loadCycle(); }, [loadCycle]);

  if (config == null) return <Spinner />;
  if (config === false) return <EmptyState title="Couldn't load" />;
  if (!config.can_admin) return <EmptyState title="HR only" subtitle="OKR cycle management is limited to HR / admins." />;

  const cycles = config.cycles || [];
  const cycle = data?.cycle;

  async function transition() {
    const to = NEXT_STATUS[cycle.status];
    if (!to) return;
    await podiumopsPost('setOkrCycleStatus', { data: { cycle_id: cycle.id, status: to } }, session);
    toast?.success?.(`Cycle → ${CYCLE_STATUS[to]}`);
    loadCycle(); loadConfig();
  }

  return (
    <div style={{ maxWidth: 920 }}>
      <div onClick={() => router.push('/okrs')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--t3)', cursor: 'pointer', marginBottom: 12 }}>
        <ChevronLeft size={14} /> Back to OKRs
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={pageTitle}>Manage OKR cycles</div>
        <div style={{ flex: 1 }} />
        {cycles.length > 0 && (
          <select value={cycleId} onChange={e => setCycleId(e.target.value)} style={selStyle}>
            {cycles.map(c => <option key={c.id} value={c.id}>{c.name} · {CYCLE_STATUS[c.status] || c.status}</option>)}
          </select>
        )}
        <button onClick={() => setCreatingCycle(c => !c)} style={{ ...miniBtn, height: 36 }}><Plus size={13} /> New cycle</button>
      </div>

      {creatingCycle && <NewCycleForm session={session} onDone={(c) => { setCreatingCycle(false); loadConfig(); if (c?.id) setCycleId(c.id); }} />}

      {!cycleId ? <EmptyState title="No cycle selected" subtitle="Create one to begin." />
        : data == null ? <Spinner />
        : data === false ? <EmptyState title="Couldn't load cycle" />
        : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', marginBottom: 18, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{cycle.name}</div>
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>{cycle.period_start} → {cycle.period_end} · anchor {cycle.anchor_date}</div>
              </div>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--yellow)', background: 'rgba(242,205,26,0.1)', border: '1px solid var(--yellow)', borderRadius: 6, padding: '3px 9px' }}>{CYCLE_STATUS[cycle.status]}</span>
              <div style={{ flex: 1 }} />
              {NEXT_STATUS[cycle.status] && <button onClick={transition} style={{ ...miniBtn, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', height: 34 }}>{NEXT_LABEL[cycle.status]}</button>}
              {cycle.status === 'closed' && <span style={{ fontSize: 12, color: 'var(--t3)' }}>Cycle closed.</span>}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t2)' }}>Objectives · {(data.objectives || []).length}</div>
              <div style={{ flex: 1 }} />
              <button onClick={() => setAddingObj(a => !a)} style={miniBtn}><Plus size={13} /> Add objective</button>
            </div>

            {addingObj && (
              <NewObjectiveForm session={session} cycleId={cycle.id} people={people} depts={depts}
                objectives={data.objectives || []} onDone={() => { setAddingObj(false); loadCycle(); }} />
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {(data.objectives || []).length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No objectives yet — add company & department objectives to seed the cascade.</div>}
              {(data.objectives || []).map(o => <ObjectiveCard key={o.id} obj={o} onOpen={() => router.push(`/okrs/detail/?id=${o.id}`)} />)}
            </div>
          </>
        )}
    </div>
  );
}

function NewCycleForm({ session, onDone }) {
  const opts = anchorOptions();
  const [anchor, setAnchor] = useState(opts.find(o => o.value.endsWith('-04-01') && o.value.startsWith(String(new Date().getUTCFullYear())))?.value || opts[0].value);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const c = await podiumopsPost('createOkrCycle', { data: { anchor_date: anchor, name: name || undefined } }, session);
      onDone(c);
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 11, padding: 15, marginBottom: 18, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
      <Field label="Anchor (Apr 1 / Oct 1)" w={230}><select value={anchor} onChange={e => setAnchor(e.target.value)} style={inp}>{opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
      <Field label="Name (optional)" w={260}><input value={name} onChange={e => setName(e.target.value)} placeholder={'OKRs ' + anchor} style={inp} /></Field>
      <button disabled={busy} onClick={save} style={{ ...miniBtn, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', height: 34 }}>{busy ? '…' : 'Create cycle'}</button>
    </div>
  );
}

function NewObjectiveForm({ session, cycleId, people, depts, objectives, onDone }) {
  const [level, setLevel] = useState('company');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [deptId, setDeptId] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);

  // Alignment parents must be strictly higher level.
  const parentOpts = objectives.filter(o =>
    (level === 'individual' && (o.level === 'department' || o.level === 'company')) ||
    (level === 'department' && o.level === 'company')
  ).map(o => ({ value: o.id, label: `${LEVELS[o.level]}: ${o.title}` }));

  async function save() {
    if (!title.trim()) return alert('Title required');
    if (level === 'department' && !deptId) return alert('Pick a department');
    if (level === 'individual' && !ownerId) return alert('Pick an owner');
    setBusy(true);
    try {
      await podiumopsPost('createObjective', { data: {
        cycle_id: cycleId, level, title, description: description || null,
        owner_employee_id: (level === 'individual' ? ownerId : (ownerId || null)),
        department_id: level === 'department' ? deptId : null,
        parent_objective_id: parentId || null,
      } }, session);
      onDone();
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 11, padding: 15, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
      <Field label="Level" w={150}><select value={level} onChange={e => setLevel(e.target.value)} style={inp}>{Object.entries(LEVELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Objective" w={320}><input value={title} onChange={e => setTitle(e.target.value)} placeholder="Aspirational, qualitative" style={inp} /></Field>
      {level === 'department' && (
        <Field label="Department" w={220}><Combobox value={deptId} onChange={setDeptId} inputStyle={inp} placeholder="Search department…" options={depts.map(d => ({ value: d.id, label: d.name }))} /></Field>
      )}
      {(level === 'individual' || level === 'company') && (
        <Field label={level === 'company' ? 'Owner (optional)' : 'Owner'} w={220}><Combobox value={ownerId} onChange={setOwnerId} inputStyle={inp} placeholder="Search person…" options={people.map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} /></Field>
      )}
      {parentOpts.length > 0 && (
        <Field label="Aligns to (optional)" w={260}><Combobox value={parentId} onChange={setParentId} inputStyle={inp} placeholder="Parent objective…" options={parentOpts} /></Field>
      )}
      <Field label="Description (optional)" w={320}><input value={description} onChange={e => setDescription(e.target.value)} style={inp} /></Field>
      <button disabled={busy} onClick={save} style={{ ...miniBtn, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', height: 34 }}>{busy ? '…' : 'Add'}</button>
    </div>
  );
}

const selStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none' };

export default function OkrCyclePage() {
  return <Suspense fallback={<Spinner />}><CycleInner /></Suspense>;
}
