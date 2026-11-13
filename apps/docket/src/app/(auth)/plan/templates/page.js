'use client';
// Plan templates (F9 R9a — spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §11). A template is a
// reusable set of milestones / results / tasks, each with a ROLE and a day OFFSET; applying it under an anchor
// (founders: an agreed theme; leads: an agreed milestone they own) creates every node through the normal
// create path in one transaction — all or nothing. Nothing is seeded: leads and founders write their own.
//   list    — getTemplates (only templates the caller may see; "New template" per can_create)
//   editor  — name, description, audience, the nested steps (shape rules = lib/templates.js = the save RPC)
//   preview — non-editors see node titles only (+ Apply)
//   apply   — anchor, anchor date, a person per role, every node with its date and person → applyTemplate
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { LayoutTemplate, Plus, ArrowLeft, ChevronUp, ChevronDown, Trash2, Archive, ArchiveRestore, Play, Pencil, Eye, CheckCircle2 } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { Button, IconButton, EmptyState, Pill } from '../../../../components/ui/index.js';
import { usePlanItems } from '../../../../components/plan/PlanPicker.js';
import { useChrome } from '../../../../lib/chrome.js';
import { istDate, shortDay } from '../../../../lib/weeks.js';
import { fmtPlanDate } from '../../../../lib/plan.js';
import {
  AUDIENCE_LABEL, KIND_LABEL, LIMITS, childKinds, orderedNodes, validateTemplate, addNode, removeNode, updateNode, moveNode,
  fromServerNodes, toSaveBody, templateRoles, applyPreview, applyBody, applySpaces, dayHint, spanText, templateErrorText, errorCodeText,
} from '../../../../lib/templates.js';

const changed = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:templates-changed')); };

export default function TemplatesPage() {
  const { session, perms } = useAuth();
  const isSuper = !!perms?.docket_plan_admin;
  const [list, setList] = useState(null);
  const [archived, setArchived] = useState(false);
  const [view, setView] = useState({ mode: 'list' });   // { mode: 'list' | 'edit' | 'preview' | 'apply', id?, audience? }

  const load = useCallback(async () => {
    if (!session) return;
    try { setList(await docketopsGet('getTemplates', { archived: archived ? '1' : '' }, session)); }
    catch (e) { setList({ error: templateErrorText(e) }); }
  }, [session, archived]);
  useEffect(() => { load(); }, [load]);
  const back = useCallback(() => { setView({ mode: 'list' }); load(); }, [load]);

  if (!list) return <div className="pl"><Spinner /></div>;
  if (list.error) return <div className="pl"><EmptyState icon={LayoutTemplate} title="Couldn’t load templates" body={list.error}
    action={<Button size="sm" onClick={() => { setList(null); load(); }}>Retry</Button>} /></div>;

  if (view.mode === 'edit') return <Editor id={view.id} audience={view.audience} canCreate={list.can_create || {}} session={session} onDone={back} />;
  if (view.mode === 'preview' || view.mode === 'apply') {
    return <ApplyView id={view.id} session={session} isSuper={isSuper} startApply={view.mode === 'apply'} onBack={back} />;
  }

  const templates = (list.templates || []).filter(Boolean);
  const cc = list.can_create || {};
  const canMake = cc.founders || cc.leads;
  return (
    <div className="pl tpl">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">Templates</h1>
          <p className="pl-lede">Reusable milestones, results and tasks — each with a role and a day offset. Apply one under an agreed item to create them all at once.</p>
        </div>
        <div className="pl-head-acts">
          {canMake && <Button variant="primary" icon={Plus} onClick={() => setView({ mode: 'edit', audience: cc.leads ? 'leads' : 'founders' })}>New template</Button>}
        </div>
      </div>
      {(canMake || templates.some(t => t.can_edit)) && (
        <label className="pl-check tpl-arch"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> Show archived</label>
      )}
      {templates.length === 0 ? (
        <EmptyState icon={LayoutTemplate} title="No templates yet"
          body={canMake ? 'Write the first one — a launch, a hiring round, a monthly close — and apply it whenever it comes round.' : 'Templates you can use will show up here.'}
          action={canMake ? <Button variant="primary" icon={Plus} onClick={() => setView({ mode: 'edit', audience: cc.leads ? 'leads' : 'founders' })}>New template</Button> : null} />
      ) : (
        <div className="tpl-list">
          {templates.map(t => (
            <article key={t.id} className={'tpl-card' + (t.archived ? ' pl-dim' : '')}>
              <div className="tpl-card-h">
                <span className="tpl-name">{t.name}</span>
                <Pill>{t.audience === 'founders' ? 'Founders' : 'Leads'}</Pill>
                {t.archived && <Pill>Archived</Pill>}
              </div>
              {t.description && <p className="tpl-desc">{t.description}</p>}
              <div className="tpl-meta">
                <span>{t.node_count} step{t.node_count === 1 ? '' : 's'}</span>
                {spanText(t.span) && <span>{spanText(t.span)}</span>}
                <span>roles: {(t.roles || []).join(', ') || '—'}</span>
                <span>by {t.mine ? 'you' : (t.created_by_name || 'someone')}</span>
              </div>
              <div className="tpl-acts">
                {!t.archived && <Button size="sm" variant="primary" icon={Play} onClick={() => setView({ mode: 'apply', id: t.id })}>Apply</Button>}
                {t.can_edit
                  ? <Button size="sm" variant="neutral" icon={Pencil} onClick={() => setView({ mode: 'edit', id: t.id })}>Edit</Button>
                  : <Button size="sm" variant="ghost" icon={Eye} onClick={() => setView({ mode: 'preview', id: t.id })}>Preview</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ── editor ───────────────────────────────────────────────────────────────────
function Editor({ id, audience: newAudience, canCreate, session, onDone }) {
  const { showToast } = useToast();
  const [t, setT] = useState(id ? null : { name: '', description: '', audience: newAudience || 'leads', nodes: [] });
  const [meta, setMeta] = useState(null);       // the list row (archived, can_edit)
  const [serverErr, setServerErr] = useState(null);   // { key?, text }
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!id || !session) return;
    docketopsGet('getTemplate', { id }, session).then(d => {
      setMeta(d?.template || null);
      setT({ id, name: d?.template?.name || '', description: d?.template?.description || '', audience: d?.template?.audience || 'leads', nodes: fromServerNodes(d?.nodes) });
    }).catch(e => { showToast(templateErrorText(e), 'error'); onDone(); });
  }, [id, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = useMemo(() => (t ? validateTemplate(t) : { ok: false, form: [], nodes: {} }), [t]);
  if (!t) return <div className="pl"><Spinner /></div>;
  const readOnly = !!meta?.archived;
  const set = (patch) => { setT(x => ({ ...x, ...patch })); setServerErr(null); };
  const setNodes = (fn) => set({ nodes: fn(t.nodes) });
  const ordered = orderedNodes(t.nodes);
  const titleOf = (key) => t.nodes.find(n => n.key === key)?.title || '';
  const formErr = (field) => (tried ? v.form.find(f => f.field === field) : null);
  // Only a super admin may pick (or change to) founders; a new lead template is leads.
  const audienceOpts = ['leads', 'founders'].filter(a => a === t.audience || (a === 'founders' ? canCreate.founders : (canCreate.leads || canCreate.founders)));

  async function save() {
    setTried(true);
    if (!v.ok) { showToast('Fix the highlighted steps first.', 'error'); return; }
    setSaving(true);
    try {
      await docketopsPost('saveTemplate', { template: toSaveBody(t) }, session);
      showToast('Template saved', 'success'); changed(); onDone();
    } catch (e) {
      setServerErr({ key: e?.detail?.key || null, text: templateErrorText(e, { nodeTitle: titleOf }) });
      showToast(templateErrorText(e, { nodeTitle: titleOf }), 'error');
    } finally { setSaving(false); }
  }
  async function archive(flag) {
    setSaving(true);
    try { await docketopsPost('archiveTemplate', { id, archive: flag }, session); showToast(flag ? 'Archived' : 'Restored', 'success'); changed(); onDone(); }
    catch (e) { showToast(templateErrorText(e), 'error'); }
    finally { setSaving(false); }
  }

  return (
    <div className="pl tpl">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">{id ? 'Edit template' : 'New template'}</h1>
          <p className="pl-lede">{AUDIENCE_LABEL[t.audience]}. Days count from the date you pick when applying it.</p>
        </div>
        <div className="pl-head-acts">
          <Button variant="ghost" icon={ArrowLeft} onClick={onDone} disabled={saving}>Templates</Button>
          {id && (meta?.archived
            ? <Button variant="neutral" icon={ArchiveRestore} onClick={() => archive(false)} loading={saving}>Unarchive</Button>
            : <Button variant="neutral" icon={Archive} onClick={() => archive(true)} disabled={saving}>Archive</Button>)}
          {!readOnly && <Button variant="primary" onClick={save} loading={saving}>Save</Button>}
        </div>
      </div>
      {readOnly && <div className="pw-ok">This template is archived — unarchive it to change or apply it.</div>}

      <fieldset className="tpl-form" disabled={readOnly || saving}>
        <label className="pl-field"><span className="pl-lbl">Name</span>
          <input className="pl-input" value={t.name} maxLength={LIMITS.name + 20} onChange={e => set({ name: e.target.value })} />
          {formErr('name') && <span className="tpl-err">{errorCodeText(formErr('name').code)}</span>}</label>
        <label className="pl-field"><span className="pl-lbl">Description (optional)</span>
          <textarea className="pl-input pl-ta" value={t.description} onChange={e => set({ description: e.target.value })} />
          {formErr('description') && <span className="tpl-err">{errorCodeText(formErr('description').code)}</span>}</label>
        <label className="pl-field"><span className="pl-lbl">For</span>
          <select className="tk-fp-sel" value={t.audience} disabled={audienceOpts.length < 2} onChange={e => set({ audience: e.target.value })}>
            {audienceOpts.map(a => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
          </select></label>
        {formErr('nodes') && <span className="tpl-err">{errorCodeText(formErr('nodes').code)}</span>}

        <div className="tpl-nodes">
          <div className="pl-lbl">Steps</div>
          {ordered.length === 0 && <p className="rv-none">No steps yet — add the first {childKinds(t.audience, null).map(k => KIND_LABEL[k].toLowerCase()).join(' or ')}.</p>}
          {ordered.map(({ node: n, depth }) => {
            const errs = [...(tried ? (v.nodes[n.key] || []) : []), ...(serverErr?.key === n.key ? ['__server'] : [])];
            const needsDone = n.kind === 'result' || (n.kind === 'milestone' && t.nodes.some(x => x.parent_key === n.key));
            return (
              <div key={n.key} className={'tpl-node' + (errs.length ? ' bad' : '')} style={{ marginLeft: Math.min(depth, 3) * 16 }}>
                <div className="tpl-node-h">
                  <span className="ptr-kind">{KIND_LABEL[n.kind] || n.kind}</span>
                  <input className="pl-input tpl-node-t" value={n.title} placeholder="Title" aria-label="Step title" maxLength={LIMITS.title + 20}
                    onChange={e => setNodes(ns => updateNode(ns, n.key, { title: e.target.value }))} />
                  <span className="tpl-node-acts">
                    <IconButton icon={ChevronUp} size="sm" label="Move up" onClick={() => setNodes(ns => moveNode(ns, n.key, -1))} />
                    <IconButton icon={ChevronDown} size="sm" label="Move down" onClick={() => setNodes(ns => moveNode(ns, n.key, 1))} />
                    <IconButton icon={Trash2} size="sm" label="Remove step" onClick={() => setNodes(ns => removeNode(ns, n.key))} />
                  </span>
                </div>
                <div className="tpl-node-f">
                  <label className="tpl-mini"><span className="pl-lbl">Role</span>
                    <input className="pl-input" value={n.role_label} placeholder="e.g. Lead" maxLength={LIMITS.role + 10}
                      onChange={e => setNodes(ns => updateNode(ns, n.key, { role_label: e.target.value }))} /></label>
                  <label className="tpl-mini"><span className="pl-lbl">Day</span>
                    <input className="pl-input" type="number" inputMode="numeric" step="1" min={LIMITS.offset_min} max={LIMITS.offset_max} value={n.offset_days}
                      onChange={e => setNodes(ns => updateNode(ns, n.key, { offset_days: e.target.value === '' ? '' : Number(e.target.value) }))} />
                    <span className="pl-hint">{dayHint(n.offset_days)}</span></label>
                </div>
                {(needsDone || n.kind === 'milestone' || n.done_when) && n.kind !== 'task' && (
                  <label className="pl-field"><span className="pl-lbl">Done when{needsDone ? '' : ' (optional — without it the milestone is created proposed)'}</span>
                    <textarea className="pl-input pl-ta" value={n.done_when} onChange={e => setNodes(ns => updateNode(ns, n.key, { done_when: e.target.value }))} /></label>
                )}
                {errs.length > 0 && <div className="tpl-err">{errs.map(c => (c === '__server' ? serverErr.text : errorCodeText(c))).join(' ')}</div>}
                {childKinds(t.audience, n.kind).length > 0 && (
                  <div className="tpl-add">
                    {childKinds(t.audience, n.kind).map(k => (
                      <Button key={k} size="sm" variant="ghost" icon={Plus} onClick={() => setNodes(ns => addNode(ns, n.key, k))}>{KIND_LABEL[k]}</Button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="tpl-add">
            {childKinds(t.audience, null).map(k => (
              <Button key={k} size="sm" variant="neutral" icon={Plus} onClick={() => setNodes(ns => addNode(ns, null, k))}>{KIND_LABEL[k]}</Button>
            ))}
          </div>
        </div>
      </fieldset>
      {serverErr && !serverErr.key && <div className="tpl-err">{serverErr.text}</div>}
    </div>
  );
}

// ── preview + apply ──────────────────────────────────────────────────────────
function ApplyView({ id, session, isSuper, startApply, onBack }) {
  const { showToast } = useToast();
  const { myEmployeeId, myDepartmentId, spaces } = useChrome();
  const planItems = usePlanItems(session);
  const [d, setD] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [applying, setApplying] = useState(startApply);
  const [anchorId, setAnchorId] = useState('');
  const [anchorDate, setAnchorDate] = useState(istDate(Date.now()));
  const [roles, setRoles] = useState({});
  const [spaceId, setSpaceId] = useState('');   // '' = the default below until the caller picks
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  useEffect(() => {
    if (!session) return;
    docketopsGet('getTemplate', { id }, session).then(setD).catch(e => { showToast(templateErrorText(e), 'error'); onBack(); });
    docketopsGet('getEmployees', {}, session).then(e => setEmployees(Array.isArray(e) ? e : [])).catch(() => {});
  }, [id, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const tpl = d?.template;
  const nodes = useMemo(() => (d?.nodes || []).filter(Boolean), [d]);
  const labels = tpl?.roles?.length ? tpl.roles : templateRoles(nodes);
  const kind = tpl?.can_apply_kind || (tpl?.audience === 'founders' ? 'theme' : 'milestone');
  // Anchors (§C): founders → agreed themes; leads → the caller's agreed milestones (a super admin: any).
  const anchors = useMemo(() => (planItems || []).filter(i => i.kind === kind && i.state === 'agreed' && i.level !== 'L'
    && (kind === 'theme' || isSuper || (myEmployeeId && i.owner_employee_id === myEmployeeId)))
    .map(i => ({ value: i.id, label: [i.code, i.title].filter(Boolean).join(' · ') })), [planItems, kind, isSuper, myEmployeeId]);
  const people = useMemo(() => employees.map(e => ({ value: e.id, label: e.full_name })), [employees]);
  const preview = useMemo(() => applyPreview(nodes, anchorDate, roles, employees), [nodes, anchorDate, roles, employees]);
  const spaceOpts = useMemo(() => applySpaces(spaces, myDepartmentId), [spaces, myDepartmentId]);
  const pickedSpace = spaceId || spaceOpts.defaultId;
  const body = applyBody(id, { anchorId, anchorDate, roles, labels, spaceId: pickedSpace });

  async function apply() {
    if (!body) return;
    setBusy(true); setErr('');
    try {
      const r = await docketopsPost('applyTemplate', body, session);
      setDone(r || { items: [], tasks: [] });
      showToast('Template applied', 'success');
    } catch (e) {
      const t = templateErrorText(e, { nodeTitle: (k) => nodes.find(n => n.id === k)?.title || '' });
      setErr(t); showToast(t, 'error');
    } finally { setBusy(false); }
  }

  if (!d) return <div className="pl"><Spinner /></div>;
  if (done) {
    return (
      <div className="pl tpl">
        <div className="pl-head"><div className="pl-head-tx">
          <h1 className="pl-title"><CheckCircle2 size={18} className="tpl-ok" aria-hidden /> Applied “{tpl?.name}”</h1>
          <p className="pl-lede">{(done.items || []).length} plan item{(done.items || []).length === 1 ? '' : 's'} and {(done.tasks || []).length} task{(done.tasks || []).length === 1 ? '' : 's'} created.</p>
        </div><div className="pl-head-acts">
          <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Templates</Button>
          <Link href="/plan" className="ui-btn ui-btn-neutral ui-btn-md">Open the plan</Link>
        </div></div>
        <div className="tpl-done">
          {(done.items || []).map(i => (
            <Link key={i.id} href="/plan" className="rv-row ho-row"><span className="ptr-kind">{KIND_LABEL[i.kind] || i.kind}</span>
              <span className="pl-code">{i.code}</span><span className="rv-meta">{i.state === 'agreed' ? 'agreed' : 'proposed'}</span></Link>
          ))}
          {(done.tasks || []).map(t => (
            <Link key={t.id} href={'/tasks?task=' + t.id} className="rv-row ho-row"><span className="ptr-kind">Task</span><span className="pl-code">{t.task_no}</span></Link>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="pl tpl">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">{tpl?.name}</h1>
          <p className="pl-lede">{tpl?.description || AUDIENCE_LABEL[tpl?.audience] || ''}</p>
        </div>
        <div className="pl-head-acts">
          <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Templates</Button>
          {!applying && !tpl?.archived && <Button variant="primary" icon={Play} onClick={() => setApplying(true)}>Apply</Button>}
        </div>
      </div>

      {applying && (
        <section className="tpl-apply">
          <label className="pl-field"><span className="pl-lbl">Apply under {kind === 'theme' ? 'the theme' : 'the milestone'}</span>
            {anchors.length === 0
              ? <span className="rv-none">{kind === 'theme' ? 'No agreed themes yet.' : 'You don’t own an agreed milestone to apply it under.'}</span>
              : <Combobox value={anchorId} options={anchors} placeholder={kind === 'theme' ? 'Pick a theme…' : 'Pick a milestone…'} onChange={(v) => setAnchorId(v || '')} style={{ width: '100%' }} />}</label>
          <label className="pl-field"><span className="pl-lbl">Put the tasks in</span>
            <Combobox value={pickedSpace} options={spaceOpts.options} placeholder="Pick a space…" onChange={(v) => setSpaceId(v || '')} style={{ width: '100%' }} />
            {kind === 'theme' && <span className="rv-hidden">Under a restricted theme they go to the Founders’ space instead.</span>}</label>
          <label className="pl-field"><span className="pl-lbl">Anchor date (day 0)</span>
            <input type="date" className="pl-input" value={anchorDate} onChange={e => setAnchorDate(e.target.value)} /></label>
          {labels.length > 0 && <div className="pl-field"><span className="pl-lbl">Who plays each role</span>
            {labels.map(l => (
              <div key={l} className="tpl-role"><span className="tpl-role-l">{l}</span>
                <Combobox value={roles[l] || ''} options={people} placeholder="Pick a person…" onChange={(v) => setRoles(r => ({ ...r, [l]: v || '' }))} style={{ width: '100%' }} />
              </div>
            ))}</div>}
        </section>
      )}

      <section className="tpl-prev" aria-label="Steps">
        <div className="pl-lbl">{applying ? 'What will be created' : 'Steps'}</div>
        {preview.length === 0 && <p className="rv-none">This template has no steps.</p>}
        {preview.map(p => (
          <div key={p.key} className="rv-row tpl-prev-row" style={{ paddingLeft: 6 + Math.min(p.depth, 3) * 16 }}>
            <span className="ptr-kind">{KIND_LABEL[p.kind] || p.kind}</span>
            <span className="rv-t">{p.title}</span>
            {(p.date || p.role_label) && <span className="rv-meta">
              {p.date ? (p.kind === 'task' ? shortDay(p.date) : fmtPlanDate(p.date)) : ''}{p.role_label ? ` · ${p.person || p.role_label}` : ''}</span>}
          </div>
        ))}
      </section>

      {applying && <>
        {err && <div className="tpl-err">{err}</div>}
        <div className="pl-save tpl-save">
          <span className="rv-hidden">{body ? 'All or nothing — if any step fails, nothing is created.' : 'Pick the anchor, a date and a person for every role.'}</span>
          <Button variant="primary" icon={Play} onClick={apply} loading={busy} disabled={!body}>Apply</Button>
        </div>
      </>}
    </div>
  );
}
