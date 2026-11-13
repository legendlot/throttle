'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { ArrowLeft, Download, Plus, Check, X, Pencil, Save, Lock, UserPlus, UploadCloud, Keyboard } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../../../lib/format.js';
import {
  Card, KV, F, Row, Note, Timeline, ListBadge, ToneBadge, JdInput, jdProvided, submitJd,
  inp, comboInp, backBtn, primaryBtn, ghostBtn, dangerBtn, iconBtn, muted,
} from '../../../../../components/HiringBits.js';
import {
  OPENING_STATUSES, APP_STATUSES, BUDGET_STATUSES, SOURCES, HIRING_EMPLOYMENT_TYPES, ACTIVE_APP_STATUSES,
  JD_REQUIRED_MSG, OFFER_STATUSES, hiringError, labelFrom, formatINR, formatBand, numOrNull, idOf, listOf, fmtDateTime,
  sourceDetailHint, noticeLabel, CANDIDATE_DOC_ACCEPT, MAX_UPLOAD_BYTES,
} from '../../../../../lib/hiring.js';
import { putPendingFiles } from '../../../../../lib/cvHandoff.js';
import { RoundsCard, InterviewSummaryLine } from '../../../../../components/InterviewBits.js';

function OpeningDetailInner() {
  const { session, brandUser } = useAuth();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [emps, setEmps] = useState([]);
  const [levels, setLevels] = useState([]);

  const load = useCallback(() => {
    if (!session || !id) return;
    podiumopsGet('getOpening', { id }, session).then(setData).catch(() => setData(false));
  }, [session, id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (session) podiumopsGet('getHiringLookups', {}, session).then(d => { setEmps(d.employees || []); setLevels(d.levels || []); }).catch(() => {});
  }, [session]);

  if (data === false) return <div style={{ color: 'var(--text-3)' }}>Not found, or you don't have access to this opening.</div>;
  if (!data) return <Spinner />;

  const o = data.opening || {};
  const r = data.my_roles || {};
  // The worker sends the derived gates on my_roles; the raw-role fallback mirrors its rules.
  const canEdit = r.can_edit != null ? !!r.can_edit : !!(r.hiring || r.owner);
  const canManageApps = r.can_manage_apps != null ? !!r.can_manage_apps : !!(r.hiring || r.owner || r.manager);
  const canChangeChain = r.can_change_chain != null ? !!r.can_change_chain : !!r.hiring;
  const budgets = data.budgets || [];
  // Salary visibility is the worker's call: explicit flag, else "band fields came back".
  const canSeeSalary = r.can_see_salary != null ? !!r.can_see_salary : budgets.some(b => b.band_min != null);
  const hasJd = !!(o.current_jd_id || data.jd);
  const isOpen = o.status === 'open';

  async function setStatus(status) {
    let reason = null;
    if (status === 'cancelled' || status === 'on_hold') {
      reason = window.prompt(status === 'cancelled' ? 'Why is this opening cancelled?' : 'Why is it on hold?');
      if (reason == null) return;
    }
    try {
      await podiumopsPost('setOpeningStatus', { id: o.id, status, reason: reason || null }, session);
      showToast(`Opening ${labelFrom(OPENING_STATUSES, status).toLowerCase()}`, 'success'); load();
    } catch (e) { showToast(hiringError(e), 'error'); }
  }

  const statusActions = [];
  if (canEdit) {
    if ((o.status === 'draft' || o.status === 'on_hold') && hasJd) statusActions.push({ s: 'open', label: 'Open' });
    if (o.status === 'open') statusActions.push({ s: 'on_hold', label: 'Hold' });
    if (['open', 'on_hold'].includes(o.status)) statusActions.push({ s: 'filled', label: 'Mark filled' });
    if (['draft', 'open', 'on_hold'].includes(o.status)) statusActions.push({ s: 'cancelled', label: 'Cancel', danger: true });
    if (['filled', 'cancelled'].includes(o.status) && r.hiring) statusActions.push({ s: hasJd ? 'open' : 'on_hold', label: 'Reopen' });  // worker never sets draft; no JD → on hold
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <button onClick={() => router.push('/hiring/openings')} style={backBtn}><ArrowLeft size={15} /> Openings</button>

      <header style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '10px 0 16px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 24, fontWeight: 700, letterSpacing: '0.03em' }}>{o.designation}</h1>
            <ListBadge list={OPENING_STATUSES} status={o.status} />
            {!hasJd && <ToneBadge tone="warn" label="JD needed" />}
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
            <span style={{ color: 'var(--podium-accent)', fontWeight: 600 }}>{o.opening_code}</span>
            {(o.department?.name || o.department_name) && <> · {o.department?.name || o.department_name}</>}
            {o.level?.code && <> · {o.level.code} · {o.level.name}</>}
            {o.location_city && <> · {o.location_city}</>}
            {' · '}{labelFrom(HIRING_EMPLOYMENT_TYPES, o.employment_type)} · {o.headcount ?? 1} seat{Number(o.headcount) === 1 ? '' : 's'}
            {o.target_join_date && <> · join by {fmtDate(o.target_join_date)}</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {statusActions.map(a => (
            <button key={a.label} onClick={() => setStatus(a.s)} style={a.danger ? dangerBtn : ghostBtn}>{a.label}</button>
          ))}
        </div>
      </header>

      {!hasJd && <Note><Lock size={13} /> {JD_REQUIRED_MSG}</Note>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
        <JdCard data={data} canEdit={canEdit} session={session} onChanged={load} />
        <div style={{ display: 'grid', gap: 14 }}>
          <BandCard opening={o} budgets={budgets} canDecide={!!data.can_decide_pending} canEdit={canEdit} canSeeSalary={canSeeSalary} session={session} onChanged={load} />
          <TeamCard data={data} emps={emps} levels={levels} canEdit={canEdit} canChangeChain={canChangeChain} session={session} onChanged={load} />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <RoundsCard openingId={o.id} rounds={data.rounds || []} emps={emps} canEdit={canEdit} session={session} onChanged={load} />
      </div>

      <div style={{ marginTop: 14 }}>
        <CandidatesCard opening={o} applications={data.applications || []} hasJd={hasJd} isOpen={isOpen}
          canManage={canManageApps} canSeeSalary={canSeeSalary} emps={emps} session={session} onChanged={load} />
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title="Timeline"><Timeline events={data.events} /></Card>
      </div>
    </div>
  );
}

export default function OpeningDetailPage() {
  return <Suspense fallback={<Spinner />}><OpeningDetailInner /></Suspense>;
}

// ── JD: current version, history, add a new version ─────────────────────────
function JdCard({ data, canEdit, session, onChanged }) {
  const { showToast } = useToast();
  const [adding, setAdding] = useState(false);
  const [jd, setJd] = useState({ mode: 'text', text: '', file: null });
  const [busy, setBusy] = useState(false);
  const cur = data.jd || null;
  const versions = data.jd_versions || [];
  const hasRole = !!data.opening?.job_role_id;

  async function download(jdId) {
    try { const r = await podiumopsGet('getJdDownloadUrl', { jd_id: jdId }, session); window.open(r.url, '_blank'); }
    catch (e) { showToast(hiringError(e, 'Could not open'), 'error'); }
  }
  async function add() {
    if (!jdProvided(jd)) { showToast('Enter, upload or pick a JD first', 'error'); return; }
    setBusy(true);
    try {
      await submitJd(data.opening.id, jd, session);
      showToast('JD saved', 'success'); setAdding(false); setJd({ mode: 'text', text: '', file: null }); onChanged();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title={cur ? `JD · v${cur.version}` : 'JD'}
      right={canEdit && !adding && <button onClick={() => setAdding(true)} style={ghostBtn}><Plus size={13} /> {cur ? 'New version' : 'Add JD'}</button>}>
      {!cur ? <div style={muted}>No JD yet.</div> : (
        <div>
          {cur.jd_text && <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55, maxHeight: 380, overflowY: 'auto', color: 'var(--text-1)' }}>{cur.jd_text}</div>}
          {cur.storage_path && (
            <button onClick={() => download(cur.id)} style={{ ...ghostBtn, marginTop: cur.jd_text ? 10 : 0 }}><Download size={13} /> {cur.file_name || 'Download JD'}</button>
          )}
          <div style={{ ...muted, marginTop: 8 }}>{cur.source === 'job_role' ? "Copied from the role's JD" : cur.source === 'file' ? 'Uploaded file' : 'Pasted text'} · {fmtDateTime(cur.created_at)}</div>
        </div>
      )}
      {adding && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
          <JdInput value={jd} onChange={setJd} allowRole={hasRole} disabled={busy} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={() => setAdding(false)} style={ghostBtn} disabled={busy}>Cancel</button>
            <button onClick={add} style={primaryBtn} disabled={busy}><Save size={13} /> {busy ? 'Saving…' : 'Save JD'}</button>
          </div>
        </div>
      )}
      {versions.length > 1 && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 8 }}>
          <div style={{ ...muted, marginBottom: 4 }}>Version history</div>
          {versions.map(v => (
            <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 0' }}>
              <span>v{v.version} · {v.source === 'file' ? (v.file_name || 'file') : v.source === 'job_role' ? 'role JD' : 'text'}{v.id === cur?.id ? ' (current)' : ''}</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-3)' }}>
                {fmtDate(v.created_at)}
                {v.storage_path && <button onClick={() => download(v.id)} style={iconBtn} title="Download"><Download size={12} /></button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Band: approved + pending; approve/reject for the snapshotted approver; request a change ──
function BandCard({ opening, budgets, canDecide, canEdit, canSeeSalary, session, onChanged }) {
  const { showToast } = useToast();
  const [req, setReq] = useState(null);       // { band_min, band_max, note } while requesting
  const [busy, setBusy] = useState(false);
  const approved = budgets.find(b => b.id === opening.current_budget_id) || budgets.find(b => b.status === 'approved') || null;
  const pending = budgets.find(b => b.status === 'pending') || null;
  // canDecide = the worker's can_decide_pending (snapshotted approver or a founder, never the requester) —
  // the same rule decideBand enforces, so the buttons never show to someone the worker would refuse.

  async function decide(decision) {
    const note = window.prompt(decision === 'approve' ? 'Note (optional)' : 'Why is this band rejected?');
    if (note == null) return;
    setBusy(true);
    try {
      await podiumopsPost('decideBand', { budget_id: pending.id, decision, note: note || null }, session);
      showToast(decision === 'approve' ? 'Band approved' : 'Band rejected', 'success'); onChanged();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  async function submit() {
    const bmin = numOrNull(req.band_min), bmax = numOrNull(req.band_max);
    if (bmin == null || bmax == null) { showToast('Band min and max are required', 'error'); return; }
    if (bmax < bmin) { showToast('Band max must be ≥ band min', 'error'); return; }
    setBusy(true);
    try {
      await podiumopsPost('requestBandChange', { opening_id: opening.id, band_min: bmin, band_max: bmax, note: req.note || null }, session);
      showToast('Band change sent for approval', 'success'); setReq(null); onChanged();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  const band = (b) => canSeeSalary && b.band_min != null ? formatBand(b.band_min, b.band_max) : <span style={muted}><Lock size={11} /> hidden</span>;
  const who = (b, k) => b[k]?.full_name || b[`${k}_name`] || null;

  return (
    <Card title="Salary band (annual CTC)"
      right={canEdit && !req && <button onClick={() => setReq({ band_min: '', band_max: '', note: '' })} style={ghostBtn}><Pencil size={13} /> Request change</button>}>
      <KV k="Approved" v={approved ? <span className="num">{band(approved)} <span style={muted}>· v{approved.version}</span></span> : 'None yet'} />
      {pending && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13 }}><ListBadge list={BUDGET_STATUSES} status="pending" /> <span className="num" style={{ marginLeft: 6 }}>{band(pending)}</span></span>
            {canDecide && (
              <span style={{ display: 'flex', gap: 6 }}>
                <button disabled={busy} onClick={() => decide('approve')} style={primaryBtn}><Check size={13} /> Approve</button>
                <button disabled={busy} onClick={() => decide('reject')} style={dangerBtn}><X size={13} /> Reject</button>
              </span>
            )}
          </div>
          <div style={{ ...muted, marginTop: 4 }}>
            v{pending.version}{who(pending, 'requester') ? ` · requested by ${who(pending, 'requester')}` : ''}
            {who(pending, 'approver') ? ` · awaiting ${who(pending, 'approver')}` : ''} · {fmtDate(pending.created_at)}
          </div>
        </div>
      )}
      {!canSeeSalary && <div style={{ ...muted, marginTop: 6 }}>Band numbers are visible to the opening's chain and the salary allow-list.</div>}
      {req && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
          <Row>
            <F label="Band min"><input style={inp} inputMode="numeric" value={req.band_min} onChange={e => setReq(s => ({ ...s, band_min: e.target.value }))} /></F>
            <F label="Band max"><input style={inp} inputMode="numeric" value={req.band_max} onChange={e => setReq(s => ({ ...s, band_max: e.target.value }))} /></F>
          </Row>
          <F label="Note (no numbers needed — they're on the request)"><input style={inp} value={req.note} onChange={e => setReq(s => ({ ...s, note: e.target.value }))} /></F>
          {pending && <div style={{ ...muted, marginBottom: 8 }}>This replaces the pending request.</div>}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setReq(null)} style={ghostBtn} disabled={busy}>Cancel</button>
            <button onClick={submit} style={primaryBtn} disabled={busy}>{busy ? 'Sending…' : 'Send for approval'}</button>
          </div>
        </div>
      )}
      {budgets.filter(b => b !== pending && b !== approved).length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 6 }}>
          {budgets.filter(b => b !== pending && b !== approved).map(b => (
            <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: 'var(--text-3)' }}>
              <span>v{b.version} · {labelFrom(BUDGET_STATUSES, b.status)}{b.decision_note ? ` — ${b.decision_note}` : ''}</span>
              <span className="num">{band(b)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Team: owner / reporting manager / approver; details edit; chain change (podium_hiring) ──
function TeamCard({ data, emps, levels = [], canEdit, canChangeChain, session, onChanged }) {
  const { showToast } = useToast();
  const o = data.opening || {};
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const empOpts = emps.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code }));
  const name = (obj, idKey) => obj?.full_name || emps.find(e => e.id === o[idKey])?.full_name || null;

  function start() {
    setEdit({
      designation: o.designation || '', level_id: o.level_id || '', location_city: o.location_city || '', location_state: o.location_state || '',
      employment_type: o.employment_type || 'full_time', headcount: String(o.headcount ?? 1),
      target_join_date: o.target_join_date || '', notes: o.notes || '',
      reporting_manager_employee_id: o.reporting_manager_employee_id || '', hiring_owner_employee_id: o.hiring_owner_employee_id || '',
    });
  }
  async function save() {
    if (!edit.designation.trim()) { showToast('Designation is required', 'error'); return; }
    const body = {
      id: o.id, designation: edit.designation.trim(), level_id: edit.level_id || null, location_city: edit.location_city || null, location_state: edit.location_state || null,
      employment_type: edit.employment_type, headcount: Math.round(Number(edit.headcount) || 1),
      target_join_date: edit.target_join_date || null, notes: edit.notes || null,
    };
    // Chain fields only when they changed, and only for podium_hiring (worker enforces canChangeChain).
    if (canChangeChain) {
      if (edit.reporting_manager_employee_id && edit.reporting_manager_employee_id !== o.reporting_manager_employee_id) body.reporting_manager_employee_id = edit.reporting_manager_employee_id;
      if (edit.hiring_owner_employee_id && edit.hiring_owner_employee_id !== o.hiring_owner_employee_id) body.hiring_owner_employee_id = edit.hiring_owner_employee_id;
    }
    setBusy(true);
    try {
      const r = await podiumopsPost('updateOpening', body, session);
      if ((r?.data || r)?.level_not_saved) showToast('Saved, but the level did not save — set it again', 'error');
      else showToast(body.reporting_manager_employee_id ? 'Saved — the pending band was re-sent to the new approver' : 'Saved', 'success');
      setEdit(null); onChanged();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Team" right={canEdit && !edit && <button onClick={start} style={ghostBtn}><Pencil size={13} /> Edit</button>}>
      {!edit ? <>
        <KV k="Hiring owner" v={name(o.hiring_owner, 'hiring_owner_employee_id')} />
        <KV k="Reporting manager" v={name(o.reporting_manager, 'reporting_manager_employee_id')} />
        <KV k="Band approver" v={data.approver?.full_name || data.approver_name} />
        {o.notes && <div style={{ ...muted, marginTop: 8, whiteSpace: 'pre-wrap' }}>{o.notes}</div>}
      </> : (
        <div>
          <Row>
            <F label="Designation"><input style={inp} value={edit.designation} onChange={e => setEdit(s => ({ ...s, designation: e.target.value }))} /></F>
            <F label="Level">
              <select style={inp} value={edit.level_id} onChange={e => setEdit(s => ({ ...s, level_id: e.target.value }))}>
                <option value="">—</option>
                {levels.map(l => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
              </select>
            </F>
          </Row>
          <Row>
            <F label="City"><input style={inp} value={edit.location_city} onChange={e => setEdit(s => ({ ...s, location_city: e.target.value }))} /></F>
            <F label="State"><input style={inp} value={edit.location_state} onChange={e => setEdit(s => ({ ...s, location_state: e.target.value }))} /></F>
          </Row>
          <Row>
            <F label="Type">
              <select style={inp} value={edit.employment_type} onChange={e => setEdit(s => ({ ...s, employment_type: e.target.value }))}>
                {HIRING_EMPLOYMENT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </F>
            <F label="Headcount"><input type="number" min={1} max={100} style={inp} value={edit.headcount} onChange={e => setEdit(s => ({ ...s, headcount: e.target.value }))} /></F>
            <F label="Target join"><input type="date" style={inp} value={edit.target_join_date} onChange={e => setEdit(s => ({ ...s, target_join_date: e.target.value }))} /></F>
          </Row>
          <F label="Notes"><textarea rows={2} style={{ ...inp, resize: 'vertical' }} value={edit.notes} onChange={e => setEdit(s => ({ ...s, notes: e.target.value }))} /></F>
          {canChangeChain ? (
            <Row>
              <F label="Reporting manager"><Combobox value={edit.reporting_manager_employee_id} onChange={v => setEdit(s => ({ ...s, reporting_manager_employee_id: v }))} inputStyle={comboInp} options={empOpts} /></F>
              <F label="Hiring owner"><Combobox value={edit.hiring_owner_employee_id} onChange={v => setEdit(s => ({ ...s, hiring_owner_employee_id: v }))} inputStyle={comboInp} options={empOpts} /></F>
            </Row>
          ) : <div style={{ ...muted, marginBottom: 8 }}>Changing the reporting manager or hiring owner needs the Hiring permission.</div>}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setEdit(null)} style={ghostBtn} disabled={busy}>Cancel</button>
            <button onClick={save} style={primaryBtn} disabled={busy}><Save size={13} /> {busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Candidates on this opening + quick add (with duplicate check) ──────────────
const EMPTY_CAND = {
  full_name: '', email: '', phone: '', location: '', current_employer: '', current_title: '',
  total_experience_years: '', linkedin_url: '', source: 'other', referrer_employee_id: '', source_detail: '',
  notice_period_days: '', current_ctc: '', expected_ctc: '', notes: '',
};

function CandidatesCard({ opening, applications, hasJd, isOpen, canManage, canSeeSalary, emps, session, onChanged }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [form, setForm] = useState(null);
  const [mode, setMode] = useState(null);       // C5 D4: null | 'choose' | 'cv' (manual = form set)
  const [cv, setCv] = useState({ source: 'linkedin', referrer_employee_id: '', source_detail: '' });
  const cvNeedsReferrer = cv.source === 'referral' && !cv.referrer_employee_id && !cv.source_detail.trim();
  const [dupes, setDupes] = useState(null);     // { matches: [...] } | { count }
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('active');
  const set = (k, v) => setForm(s => ({ ...s, [k]: v }));
  const blocked = !hasJd ? 'Add the JD to this opening first' : !isOpen ? `Opening is ${labelFrom(OPENING_STATUSES, opening.status).toLowerCase()} — candidates can be added only while it is open` : null;

  const shown = applications.filter(a => filter === 'all' || (filter === 'active' ? ACTIVE_APP_STATUSES.includes(a.status) : !ACTIVE_APP_STATUSES.includes(a.status)));
  const order = APP_STATUSES.map(s => s.id);
  shown.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || String(b.created_at).localeCompare(String(a.created_at)));

  async function checkDupes() {
    const email = (form?.email || '').trim(), phone = (form?.phone || '').trim();
    if (!email && !phone) { setDupes(null); return; }
    try {
      const d = await podiumopsGet('findCandidateDuplicates', { email, phone }, session);
      const matches = listOf(d, 'matches');
      setDupes(matches.length ? { matches } : (d?.count ? { count: d.count } : null));
    } catch { setDupes(null); }
  }

  function appFields() {
    const b = {
      source: form.source || 'other',
      referrer_employee_id: form.source === 'referral' ? (form.referrer_employee_id || null) : null,
      source_detail: form.source_detail || null,
      notice_period_days: form.notice_period_days === '' ? null : Math.round(Number(form.notice_period_days)),
    };
    if (canSeeSalary) { b.current_ctc = numOrNull(form.current_ctc); b.expected_ctc = numOrNull(form.expected_ctc); }
    return b;
  }

  async function create() {
    if (!form.full_name.trim()) { showToast('Name is required', 'error'); return; }
    setBusy(true);
    try {
      const body = {
        opening_id: opening.id, full_name: form.full_name.trim(),
        email: form.email || null, phone: form.phone || null, location: form.location || null,
        current_employer: form.current_employer || null, current_title: form.current_title || null,
        total_experience_years: form.total_experience_years === '' ? null : Number(form.total_experience_years),
        linkedin_url: form.linkedin_url || null, notes: form.notes || null,
        ...appFields(),
      };
      const r = await podiumopsPost('createCandidate', body, session);
      const cid = idOf(r, 'candidate');
      showToast('Candidate added', 'success'); setForm(null); setDupes(null); onChanged();
      if (cid && window.confirm('Candidate added. Open their profile to upload the CV?')) router.push(`/hiring/detail/?id=${cid}`);
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  // Upload CV: a batch for THIS opening, the picked files handed to the batch page (lib/cvHandoff.js), which runs
  // them through its own drop-zone upload. Oversize files are dropped here with a toast, as the batch page does.
  async function startCvImport(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const ok = files.filter(f => f.size > 0 && f.size <= MAX_UPLOAD_BYTES);
    const tooBig = files.filter(f => f.size > MAX_UPLOAD_BYTES);
    const empty = files.filter(f => !f.size);
    if (tooBig.length) showToast(`Not uploaded (over 15 MB): ${tooBig.map(f => f.name).join(', ')}`, 'error');
    if (empty.length) showToast(`Skipped (empty file): ${empty.map(f => f.name).join(', ')}`, 'error');
    if (!ok.length) { showToast('No CV left to upload — pick PDF, Word or image files under 15 MB', 'error'); return; }
    if (cvNeedsReferrer) { showToast('Pick who referred them, or type the referrer\'s name', 'error'); return; }
    setBusy(true);
    try {
      const imp = await podiumopsPost('createCvImport', {
        opening_id: opening.id, source: cv.source, source_detail: cv.source_detail || null,
        referrer_employee_id: cv.source === 'referral' ? (cv.referrer_employee_id || null) : null,
      }, session);
      putPendingFiles(imp.id, ok);
      router.push(`/hiring/import/batch/?id=${imp.id}`);
    } catch (e) { showToast(e?.body?.message || hiringError(e), 'error'); setBusy(false); }
  }

  async function addExisting(m) {
    setBusy(true);
    try {
      await podiumopsPost('addApplication', { candidate_id: m.id, opening_id: opening.id, ...appFields() }, session);
      showToast(`${m.full_name} added to this opening`, 'success'); setForm(null); setDupes(null); onChanged();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title={`Candidates (${applications.length})`}
      right={canManage && !form && !mode && (
        <button onClick={() => !blocked && setMode('choose')} disabled={!!blocked} title={blocked || ''}
          style={{ ...primaryBtn, opacity: blocked ? 0.45 : 1, cursor: blocked ? 'not-allowed' : 'pointer' }}>
          <UserPlus size={13} /> Add candidate
        </button>
      )}>
      {canManage && blocked && !form && <div style={{ ...muted, marginBottom: 8, color: 'var(--warn-fg)' }}>{blocked}.</div>}

      {mode && !form && !blocked && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 12, background: 'var(--surface-2)' }}>
          {mode === 'choose' ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => setMode('cv')} style={primaryBtn}><UploadCloud size={13} /> Upload CV</button>
              <button onClick={() => { setMode(null); setForm({ ...EMPTY_CAND }); }} style={ghostBtn}><Keyboard size={13} /> Enter manually</button>
              <span style={muted}>AI reads the CV and fills the fields; you check them before anyone is added.</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setMode(null)} style={ghostBtn}>Cancel</button>
            </div>
          ) : (
            <>
              <Row>
                <F label="Source">
                  <select style={inp} value={cv.source} onChange={e => setCv(s => ({ ...s, source: e.target.value }))}>
                    {SOURCES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </F>
                {cv.source === 'referral' && (
                  <F label="Referred by"><Combobox value={cv.referrer_employee_id} onChange={v => setCv(s => ({ ...s, referrer_employee_id: v }))} inputStyle={comboInp} placeholder="Search people…"
                    options={emps.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code }))} /></F>
                )}
                <F label="Source detail"><input style={inp} value={cv.source_detail} maxLength={200} onChange={e => setCv(s => ({ ...s, source_detail: e.target.value }))} placeholder={sourceDetailHint(cv.source)} /></F>
              </Row>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                <span style={{ ...muted, marginRight: 'auto' }}>PDF, Word or image · up to 15 MB each · several at once is fine.</span>
                <button onClick={() => setMode('choose')} style={ghostBtn} disabled={busy}>Back</button>
                {cvNeedsReferrer && <span style={{ ...muted, color: 'var(--warn-fg)' }}>Pick who referred them, or type the referrer's name.</span>}
                <label title={cvNeedsReferrer ? 'Pick who referred them, or type the referrer\'s name' : ''}
                  style={{ ...primaryBtn, opacity: busy || cvNeedsReferrer ? 0.45 : 1, cursor: busy ? 'wait' : cvNeedsReferrer ? 'not-allowed' : 'pointer' }}>
                  <UploadCloud size={13} /> {busy ? 'Starting…' : 'Choose CV(s)'}
                  <input type="file" multiple accept={CANDIDATE_DOC_ACCEPT} disabled={busy || cvNeedsReferrer} style={{ display: 'none' }}
                    onChange={e => { const f = [...e.target.files]; e.target.value = ''; startCvImport(f); }} />
                </label>
              </div>
            </>
          )}
        </div>
      )}

      {form && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 12, background: 'var(--surface-2)' }}>
          <Row>
            <F label="Full name *"><input style={inp} value={form.full_name} onChange={e => set('full_name', e.target.value)} /></F>
            <F label="Email"><input style={inp} type="email" value={form.email} onChange={e => set('email', e.target.value)} onBlur={checkDupes} /></F>
            <F label="Phone"><input style={inp} value={form.phone} onChange={e => set('phone', e.target.value)} onBlur={checkDupes} /></F>
          </Row>
          {dupes?.matches && (
            <Note tone="warn">
              <div style={{ width: '100%' }}>
                <div style={{ marginBottom: 6 }}>Possible existing candidate{dupes.matches.length > 1 ? 's' : ''} — add them to this opening instead of creating a duplicate:</div>
                {dupes.matches.map(m => (
                  <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '3px 0', color: 'var(--text-1)' }}>
                    <span>{m.full_name} <span style={muted}>{m.candidate_code} · {m.email || '—'} · {m.phone || '—'} · {m.applications_count ?? 0} application(s)</span></span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button style={ghostBtn} onClick={() => router.push(`/hiring/detail/?id=${m.id}`)}>View</button>
                      <button style={primaryBtn} disabled={busy} onClick={() => addExisting(m)}>Add to opening</button>
                    </span>
                  </div>
                ))}
              </div>
            </Note>
          )}
          {dupes?.count && <Note tone="warn">A candidate with this email or phone already exists elsewhere. Ask HR before creating a new record.</Note>}
          <Row>
            <F label="Source">
              <select style={inp} value={form.source} onChange={e => set('source', e.target.value)}>
                {SOURCES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </F>
            {form.source === 'referral' && (
              <F label="Referred by"><Combobox value={form.referrer_employee_id} onChange={v => set('referrer_employee_id', v)} inputStyle={comboInp} placeholder="Search people…"
                options={emps.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code }))} /></F>
            )}
            <F label="Source detail"><input style={inp} value={form.source_detail} maxLength={200} onChange={e => set('source_detail', e.target.value)} placeholder={sourceDetailHint(form.source)} /></F>
          </Row>
          <Row>
            <F label="Notice (days)" style={{ maxWidth: 130 }}><input style={inp} inputMode="numeric" value={form.notice_period_days} onChange={e => set('notice_period_days', e.target.value)} /></F>
            {canSeeSalary && <>
              <F label="Current CTC (annual)"><input style={inp} inputMode="numeric" value={form.current_ctc} onChange={e => set('current_ctc', e.target.value)} /></F>
              <F label="Expected CTC (annual)"><input style={inp} inputMode="numeric" value={form.expected_ctc} onChange={e => set('expected_ctc', e.target.value)} /></F>
            </>}
          </Row>
          <Row>
            <F label="Current employer"><input style={inp} value={form.current_employer} onChange={e => set('current_employer', e.target.value)} /></F>
            <F label="Current title"><input style={inp} value={form.current_title} onChange={e => set('current_title', e.target.value)} /></F>
            <F label="Experience (yrs)" style={{ maxWidth: 130 }}><input style={inp} inputMode="decimal" value={form.total_experience_years} onChange={e => set('total_experience_years', e.target.value)} /></F>
          </Row>
          <Row>
            <F label="Location"><input style={inp} value={form.location} onChange={e => set('location', e.target.value)} /></F>
            <F label="LinkedIn"><input style={inp} value={form.linkedin_url} onChange={e => set('linkedin_url', e.target.value)} /></F>
          </Row>
          <F label="Notes"><textarea rows={2} style={{ ...inp, resize: 'vertical' }} value={form.notes} onChange={e => set('notes', e.target.value)} /></F>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => { setForm(null); setDupes(null); }} style={ghostBtn} disabled={busy}>Cancel</button>
            <button onClick={create} style={primaryBtn} disabled={busy}><Save size={13} /> {busy ? 'Adding…' : 'Add candidate'}</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[['active', 'Active'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ ...ghostBtn, padding: '4px 10px', ...(filter === k ? { color: 'var(--text-1)', borderColor: 'var(--podium-accent)' } : {}) }}>{l}</button>
        ))}
      </div>
      {shown.length === 0 ? <div style={muted}>No candidates{filter !== 'all' ? ` (${filter})` : ''}.</div> : shown.map(a => {
        const c = a.candidate || {};
        const cid = c.id || a.candidate_id;
        return (
          <div key={a.id} onClick={() => cid && router.push(`/hiring/detail/?id=${cid}`)}
            style={{ display: 'grid', gridTemplateColumns: '2fr 120px 110px 1.2fr 100px', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13, cursor: 'pointer' }}>
            <span style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{c.full_name || a.candidate_name || '—'}</div>
              <div style={{ ...muted, fontSize: 11 }}>{c.candidate_code || a.candidate_code || ''}</div>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
              <ListBadge list={APP_STATUSES} status={a.status} />
              {a.offer && <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{a.offer.offer_ref} r{a.offer.revision} · {labelFrom(OFFER_STATUSES, a.offer.status)}</span>}
              <InterviewSummaryLine s={a.interviews_summary} />
            </span>
            <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
              {labelFrom(SOURCES, a.source)}
              {noticeLabel(a.notice_period_days) && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{noticeLabel(a.notice_period_days)}</div>}
            </span>
            <span className="num" style={{ fontSize: 12, color: 'var(--text-2)' }}>
              {('expected_ctc' in a || 'current_ctc' in a) ? <>{formatINR(a.current_ctc, { compact: true })} → {formatINR(a.expected_ctc, { compact: true })}</> : null}
            </span>
            <span style={{ ...muted, textAlign: 'right' }}>{fmtDate(a.created_at)}</span>
          </div>
        );
      })}
    </Card>
  );
}
