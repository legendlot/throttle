'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { ArrowLeft, Pencil, Save, Download, Trash2, UploadCloud, ArrowRightLeft, FileSignature } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../../lib/format.js';
import { Avatar } from '../../../../components/ui.js';
import {
  Card, KV, F, Row, Timeline, ListBadge, signedUpload,
  inp, comboInp, backBtn, primaryBtn, ghostBtn, iconBtn, muted,
} from '../../../../components/HiringBits.js';
import {
  APP_STATUSES, OPENING_STATUSES, SOURCES, CANDIDATE_DOC_TYPES, CANDIDATE_DOC_ACCEPT, REASON_REQUIRED, ACTIVE_APP_STATUSES, OUTCOME_REASONS,
  OFFER_OPEN_STATUSES, allowedTransitions, hiringError, labelFrom, formatINR, numOrNull, listOf, fmtDateTime,
} from '../../../../lib/hiring.js';
import { OfferStatusBadge } from '../../../../components/OfferBits.js';
import { WorkAccountCard, WORK_ACCOUNT_APP_STATUSES } from '../../../../components/WorkAccountBits.js';
import { InterviewsBlock } from '../../../../components/InterviewBits.js';

// Salary fields on an application: the worker's flag, else "the fields came back".
const appSeesSalary = (a) => (a.can_see_salary != null ? !!a.can_see_salary : ('expected_ctc' in a || 'current_ctc' in a));

function CandidateDetailInner() {
  const { session, brandUser } = useAuth();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const [data, setData] = useState(null);
  const [emps, setEmps] = useState([]);
  const [openOpenings, setOpenOpenings] = useState([]);

  const load = useCallback(() => {
    if (!session || !id) return;
    podiumopsGet('getCandidate', { id }, session).then(setData).catch(() => setData(false));
  }, [session, id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    podiumopsGet('getHiringLookups', {}, session).then(d => setEmps(d.employees || [])).catch(() => {});
    podiumopsGet('getOpenings', { status: 'open' }, session).then(d => setOpenOpenings(listOf(d, 'openings'))).catch(() => {});
  }, [session]);

  if (data === false) return <div style={{ color: 'var(--text-3)' }}>Not found, or you don't have access to this candidate.</div>;
  if (!data) return <Spinner />;

  const c = data.candidate || {};
  const apps = data.applications || [];
  const isHr = !!(brandUser?.tier?.hr || brandUser?.tier?.admin);
  const anyManage = apps.some(a => a.can_manage !== false);
  const canEdit = data.can_edit != null ? !!data.can_edit : (isHr || anyManage);
  const anySalary = apps.some(appSeesSalary);

  return (
    <div style={{ maxWidth: 1100 }}>
      <button onClick={() => router.back()} style={backBtn}><ArrowLeft size={15} /> Back</button>
      <header style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '10px 0 18px' }}>
        <Avatar name={c.full_name} tintKey={c.id} size={52} />
        <div style={{ flex: 1 }}>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 24, fontWeight: 700, letterSpacing: '0.03em' }}>{c.full_name}</h1>
          <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
            <span style={{ color: 'var(--podium-accent)', fontWeight: 600 }}>{c.candidate_code}</span>
            {c.current_title && <> · {c.current_title}</>}{c.current_employer && <> @ {c.current_employer}</>}
            {c.location && <> · {c.location}</>}
          </div>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
        <ProfileCard c={c} canEdit={canEdit} session={session} onChanged={load} />
        <DocumentsCard candidate={c} docs={data.documents || []} apps={apps} isHr={isHr} anySalary={anySalary} uploadTypes={data.can_upload_types}
          canUpload={canEdit} me={brandUser} session={session} onChanged={load} />
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={`Applications (${apps.length})`}>
          {apps.length === 0 ? <div style={muted}>No applications you can see.</div> :
            apps.map(a => <ApplicationRow key={a.id} a={a} emps={emps} openOpenings={openOpenings} session={session} onChanged={load} />)}
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title="Timeline"><Timeline events={data.events} /></Card>
      </div>
    </div>
  );
}

export default function CandidateDetailPage() {
  return <Suspense fallback={<Spinner />}><CandidateDetailInner /></Suspense>;
}

// ── Profile (the person; shared across their applications) ────────────────
const PROFILE_FIELDS = ['full_name', 'email', 'phone', 'location', 'current_employer', 'current_title', 'total_experience_years', 'education', 'linkedin_url', 'notes'];

function ProfileCard({ c, canEdit, session, onChanged }) {
  const { showToast } = useToast();
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);

  function start() {
    const e = {}; for (const k of PROFILE_FIELDS) e[k] = c[k] ?? '';
    e.skills = (c.skills || []).join(', ');
    setEdit(e);
  }
  async function save() {
    if (!String(edit.full_name).trim()) { showToast('Name is required', 'error'); return; }
    const body = { id: c.id };
    for (const k of PROFILE_FIELDS) body[k] = edit[k] === '' ? null : edit[k];
    body.full_name = String(edit.full_name).trim();
    body.total_experience_years = edit.total_experience_years === '' ? null : Number(edit.total_experience_years);
    body.skills = String(edit.skills || '').split(',').map(s => s.trim()).filter(Boolean);
    setBusy(true);
    try { await podiumopsPost('updateCandidate', body, session); showToast('Saved', 'success'); setEdit(null); onChanged(); }
    catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  const s = (k) => (v) => setEdit(x => ({ ...x, [k]: v }));

  if (edit) {
    return (
      <Card title="Profile">
        <F label="Full name *"><input style={inp} value={edit.full_name} onChange={e => s('full_name')(e.target.value)} /></F>
        <Row>
          <F label="Email"><input style={inp} value={edit.email} onChange={e => s('email')(e.target.value)} /></F>
          <F label="Phone"><input style={inp} value={edit.phone} onChange={e => s('phone')(e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Current employer"><input style={inp} value={edit.current_employer} onChange={e => s('current_employer')(e.target.value)} /></F>
          <F label="Current title"><input style={inp} value={edit.current_title} onChange={e => s('current_title')(e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Location"><input style={inp} value={edit.location} onChange={e => s('location')(e.target.value)} /></F>
          <F label="Experience (yrs)"><input style={inp} inputMode="decimal" value={edit.total_experience_years} onChange={e => s('total_experience_years')(e.target.value)} /></F>
        </Row>
        <F label="Skills (comma-separated)"><input style={inp} value={edit.skills} onChange={e => s('skills')(e.target.value)} /></F>
        <F label="Education"><input style={inp} value={edit.education} onChange={e => s('education')(e.target.value)} /></F>
        <F label="LinkedIn"><input style={inp} value={edit.linkedin_url} onChange={e => s('linkedin_url')(e.target.value)} /></F>
        <F label="Notes"><textarea rows={3} style={{ ...inp, resize: 'vertical' }} value={edit.notes} onChange={e => s('notes')(e.target.value)} /></F>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={() => setEdit(null)} style={ghostBtn} disabled={busy}>Cancel</button>
          <button onClick={save} style={primaryBtn} disabled={busy}><Save size={13} /> {busy ? 'Saving…' : 'Save'}</button>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Profile" right={canEdit && <button onClick={start} style={ghostBtn}><Pencil size={13} /> Edit</button>}>
      <KV k="Email" v={c.email} />
      <KV k="Phone" v={c.phone} />
      <KV k="Location" v={c.location} />
      <KV k="Employer" v={c.current_employer} />
      <KV k="Title" v={c.current_title} />
      <KV k="Experience" v={c.total_experience_years != null ? `${Number(c.total_experience_years)} yrs` : null} />
      <KV k="Skills" v={(c.skills || []).join(', ')} />
      <KV k="Education" v={c.education} />
      <KV k="LinkedIn" v={c.linkedin_url ? <a href={c.linkedin_url} target="_blank" rel="noreferrer" style={{ color: 'var(--podium-accent)' }}>profile</a> : null} />
      {c.retain_until && <KV k="Retain until" v={fmtDate(c.retain_until)} />}
      {c.notes && <div style={{ ...muted, marginTop: 8, whiteSpace: 'pre-wrap' }}>{c.notes}</div>}
    </Card>
  );
}

// ── One application: status move (allowed transitions only), CTC/source edit, move ──
function ApplicationRow({ a, emps, openOpenings, session, onChanged }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [next, setNext] = useState('');
  const [reason, setReason] = useState('');   // category code (OUTCOME_REASONS)
  const [note, setNote] = useState('');       // free text — the worker shows it to the salary chain only
  const [edit, setEdit] = useState(null);
  const [move, setMove] = useState(null);     // { to_opening_id, reason }
  const [busy, setBusy] = useState(false);
  const op = a.opening || {};
  const canManage = a.can_manage !== false;
  const seesSalary = appSeesSalary(a);
  const transitions = Array.isArray(a.allowed_transitions) ? a.allowed_transitions : allowedTransitions(a.status);
  const active = ACTIVE_APP_STATUSES.includes(a.status);
  const needsReason = REASON_REQUIRED.includes(next);

  async function applyStatus() {
    if (!next) return;
    if (needsReason && !reason) { showToast('Pick a reason', 'error'); return; }
    setBusy(true);
    try {
      await podiumopsPost('setApplicationStatus', { id: a.id, status: next, reason: needsReason ? reason : null, note: note.trim() || null }, session);
      showToast(`Moved to ${labelFrom(APP_STATUSES, next)}`, 'success'); setNext(''); setReason(''); setNote(''); onChanged();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  async function saveEdit() {
    const body = {
      id: a.id, source: edit.source, source_detail: edit.source_detail || null,
      referrer_employee_id: edit.source === 'referral' ? (edit.referrer_employee_id || null) : null,
      notice_period_days: edit.notice_period_days === '' ? null : Math.round(Number(edit.notice_period_days)),
    };
    if (seesSalary) { body.current_ctc = numOrNull(edit.current_ctc); body.expected_ctc = numOrNull(edit.expected_ctc); }
    setBusy(true);
    try { await podiumopsPost('updateApplication', body, session); showToast('Saved', 'success'); setEdit(null); onChanged(); }
    catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  async function doMove() {
    if (!move.to_opening_id) { showToast('Pick the opening to move to', 'error'); return; }
    if (!move.reason.trim()) { showToast('A reason is required', 'error'); return; }
    setBusy(true);
    try {
      await podiumopsPost('moveApplication', { id: a.id, to_opening_id: move.to_opening_id, reason: move.reason.trim() }, session);
      showToast('Moved — salary fields were not copied', 'success'); setMove(null); onChanged();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  const targets = openOpenings.filter(o => o.id !== a.opening_id && o.has_jd !== false);

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', minWidth: 0, cursor: 'pointer' }} onClick={() => a.opening_id && router.push(`/hiring/openings/detail/?id=${a.opening_id}`)}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{op.designation || a.designation || 'Opening'}</div>
          <div style={{ ...muted, fontSize: 11 }}>
            {op.opening_code || a.opening_code}{op.status && op.status !== 'open' ? ` · opening ${labelFrom(OPENING_STATUSES, op.status).toLowerCase()}` : ''}
            {' · '}{labelFrom(SOURCES, a.source)}{a.source_detail ? ` (${a.source_detail})` : ''} · applied {fmtDate(a.created_at)}
            {a.notice_period_days != null && ` · ${a.notice_period_days}d notice`}
          </div>
        </div>
        <ListBadge list={APP_STATUSES} status={a.status} />
        {seesSalary && (
          <span className="num" style={{ fontSize: 12, color: 'var(--text-2)' }}>
            CTC {formatINR(a.current_ctc, { compact: true })} → exp. {formatINR(a.expected_ctc, { compact: true })}
          </span>
        )}
        {canManage && active && transitions.length > 0 && (
          <select value={next} onChange={e => setNext(e.target.value)} style={{ ...inp, width: 150 }} disabled={busy}>
            <option value="">Move to…</option>
            {transitions.map(s => <option key={s} value={s}>{labelFrom(APP_STATUSES, s)}</option>)}
          </select>
        )}
        {canManage && !edit && <button onClick={() => setEdit({ source: a.source || 'other', source_detail: a.source_detail || '', referrer_employee_id: a.referrer_employee_id || '', notice_period_days: a.notice_period_days ?? '', current_ctc: a.current_ctc ?? '', expected_ctc: a.expected_ctc ?? '' })} style={iconBtn} title="Edit"><Pencil size={13} /></button>}
        {canManage && active && !move && <button onClick={() => setMove({ to_opening_id: '', reason: '' })} style={iconBtn} title="Move to another opening"><ArrowRightLeft size={13} /></button>}
      </div>

      {a.outcome_reason && !active && <div style={{ ...muted, marginTop: 4 }}>Reason: {labelFrom(OUTCOME_REASONS, a.outcome_reason)}</div>}

      <InterviewsBlock a={a} emps={emps} session={session} onChanged={onChanged} />

      <OffersBlock a={a} />

      {WORK_ACCOUNT_APP_STATUSES.includes(a.status) && <WorkAccountCard a={a} session={session} onChanged={onChanged} />}

      {next && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {needsReason && (
            <select style={{ ...inp, width: 180 }} value={reason} onChange={e => setReason(e.target.value)}>
              <option value="">Reason *</option>
              {OUTCOME_REASONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          )}
          <input style={{ ...inp, flex: '1 1 260px' }} value={note} onChange={e => setNote(e.target.value)}
            placeholder="Note (optional — only the opening's salary chain sees it)" />
          <button onClick={() => { setNext(''); setReason(''); setNote(''); }} style={ghostBtn} disabled={busy}>Cancel</button>
          <button onClick={applyStatus} style={primaryBtn} disabled={busy}>{busy ? 'Saving…' : `Move to ${labelFrom(APP_STATUSES, next)}`}</button>
        </div>
      )}

      {edit && (
        <div style={{ marginTop: 8, padding: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          <Row>
            <F label="Source">
              <select style={inp} value={edit.source} onChange={e => setEdit(s => ({ ...s, source: e.target.value }))}>
                {SOURCES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </F>
            {edit.source === 'referral' && (
              <F label="Referred by"><Combobox value={edit.referrer_employee_id} onChange={v => setEdit(s => ({ ...s, referrer_employee_id: v }))} inputStyle={comboInp}
                options={emps.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code }))} /></F>
            )}
            <F label="Source detail"><input style={inp} value={edit.source_detail} onChange={e => setEdit(s => ({ ...s, source_detail: e.target.value }))} /></F>
            <F label="Notice (days)"><input style={inp} inputMode="numeric" value={edit.notice_period_days} onChange={e => setEdit(s => ({ ...s, notice_period_days: e.target.value }))} /></F>
          </Row>
          {seesSalary && (
            <Row>
              <F label="Current CTC (annual)"><input style={inp} inputMode="numeric" value={edit.current_ctc} onChange={e => setEdit(s => ({ ...s, current_ctc: e.target.value }))} /></F>
              <F label="Expected CTC (annual)"><input style={inp} inputMode="numeric" value={edit.expected_ctc} onChange={e => setEdit(s => ({ ...s, expected_ctc: e.target.value }))} /></F>
            </Row>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setEdit(null)} style={ghostBtn} disabled={busy}>Cancel</button>
            <button onClick={saveEdit} style={primaryBtn} disabled={busy}><Save size={13} /> Save</button>
          </div>
        </div>
      )}

      {move && (
        <div style={{ marginTop: 8, padding: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          <Row>
            <F label="Move to opening (open, with a JD)">
              <Combobox value={move.to_opening_id} onChange={v => setMove(s => ({ ...s, to_opening_id: v }))} inputStyle={comboInp} placeholder="Search openings…"
                options={targets.map(o => ({ value: o.id, label: o.designation, hint: o.opening_code }))} />
            </F>
            <F label="Why move? * (only the salary chain sees this)"><input style={inp} value={move.reason} onChange={e => setMove(s => ({ ...s, reason: e.target.value }))} /></F>
          </Row>
          <div style={{ ...muted, marginBottom: 8 }}>This application closes as withdrawn and a new one starts at New. Salary fields are not copied.</div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setMove(null)} style={ghostBtn} disabled={busy}>Cancel</button>
            <button onClick={doMove} style={primaryBtn} disabled={busy}><ArrowRightLeft size={13} /> {busy ? 'Moving…' : 'Move'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Offers on one application (C3): revisions + create / continue / revise ──
const OFFER_FROM_APP = ['interviewing', 'offer', 'accepted'];
function OffersBlock({ a }) {
  const router = useRouter();
  const offers = a.offers || [];
  const open = offers.find(o => OFFER_OPEN_STATUSES.includes(o.status));
  const canCreate = a.can_offer && OFFER_FROM_APP.includes(a.status) && !open && a.opening?.status === 'open';
  if (!offers.length && !canCreate) return null;
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: offers.length ? 6 : 0 }}>
        <span style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, flex: 1 }}>Offers</span>
        {canCreate && (
          <button onClick={() => router.push(`/hiring/offer/new/?application_id=${a.id}${offers[0] ? `&from=${offers[0].id}` : ''}`)} style={{ ...ghostBtn, padding: '4px 10px' }}>
            <FileSignature size={13} /> {offers.length ? (a.status === 'accepted' ? 'Amend' : 'Revise') : 'Create offer'}
          </button>
        )}
        {a.can_offer && open && (
          <button onClick={() => router.push(`/hiring/offer/?id=${open.id}`)} style={{ ...ghostBtn, padding: '4px 10px' }}>Continue r{open.revision}</button>
        )}
      </div>
      {offers.map(o => (
        <div key={o.id} onClick={() => router.push(`/hiring/offer/?id=${o.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', fontSize: 12.5, cursor: 'pointer' }}>
          <span style={{ fontWeight: 600 }}>{o.offer_ref} · r{o.revision}</span>
          <OfferStatusBadge status={o.status} />
          {o.total_ctc != null && <span className="num" style={{ color: 'var(--text-2)' }}>{formatINR(o.total_ctc, { compact: true })} CTC</span>}
          <span style={{ ...muted, marginLeft: 'auto' }}>{o.sent_at ? `sent ${fmtDate(o.sent_at)}` : fmtDate(o.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Documents: list what the worker returned (already type-filtered), upload, download, delete ──
function DocumentsCard({ candidate, docs, apps, isHr, anySalary, uploadTypes, canUpload, me, session, onChanged }) {
  const { showToast } = useToast();
  // Only offer the types this caller can see: the worker's can_upload_types, else the local tier
  // mirror — the worker refuses the rest anyway.
  const types = Array.isArray(uploadTypes)
    ? CANDIDATE_DOC_TYPES.filter(t => uploadTypes.includes(t.id))
    : CANDIDATE_DOC_TYPES.filter(t => t.tier === 'open' || (t.tier === 'salary' && (anySalary || isHr)) || (t.tier === 'hr' && isHr));
  const [docType, setDocType] = useState('cv');
  const [appId, setAppId] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  async function upload() {
    if (!file) { showToast('Pick a file first', 'error'); return; }
    setBusy(true);
    try {
      const meta = await signedUpload('createCandidateDocUploadUrl', { candidate_id: candidate.id, doc_type: docType, application_id: appId || null }, file, session);
      await podiumopsPost('recordCandidateDocument', {
        candidate_id: candidate.id, application_id: appId || null, doc_type: docType, title: title || file.name, ...meta,
      }, session);
      showToast('Document uploaded', 'success');
      setFile(null); setTitle(''); setInputKey(k => k + 1); onChanged();
    } catch (e) { showToast(hiringError(e, 'Upload failed'), 'error'); }
    finally { setBusy(false); }
  }
  async function download(d) {
    try { const r = await podiumopsGet('getCandidateDocumentUrl', { id: d.id }, session); window.open(r.url, '_blank'); }
    catch (e) { showToast(hiringError(e, 'Could not open'), 'error'); }
  }
  async function del(d) {
    if (!window.confirm(`Delete "${d.title || d.file_name}"?`)) return;
    try { await podiumopsPost('deleteCandidateDocument', { id: d.id }, session); showToast('Deleted', 'success'); onChanged(); }
    catch (e) { showToast(hiringError(e, 'Delete failed'), 'error'); }
  }
  // HR, or the uploader within 24h (worker rule).
  const canDelete = (d) => isHr || (d.uploaded_by && d.uploaded_by === me?.userId && Date.now() - new Date(d.uploaded_at).getTime() < 86400000);

  return (
    <Card title={`Documents (${docs.length})`}>
      {docs.length === 0 ? <div style={muted}>No documents.</div> : docs.map(d => (
        <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid var(--border)' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title || d.file_name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{labelFrom(CANDIDATE_DOC_TYPES, d.doc_type)} · {fmtDateTime(d.uploaded_at)}</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => download(d)} style={iconBtn} title="Download"><Download size={14} /></button>
            {canDelete(d) && <button onClick={() => del(d)} style={iconBtn} title="Delete"><Trash2 size={14} /></button>}
          </div>
        </div>
      ))}
      {canUpload && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 10 }}>
          <Row>
            <F label="Type">
              <select value={docType} onChange={e => setDocType(e.target.value)} style={inp}>
                {types.map(t => <option key={t.id} value={t.id}>{t.label}{t.tier === 'hr' ? ' (HR only)' : t.tier === 'salary' ? ' (salary)' : ''}</option>)}
              </select>
            </F>
            {apps.length > 1 && (
              <F label="For application (optional)">
                <select value={appId} onChange={e => setAppId(e.target.value)} style={inp}>
                  <option value="">—</option>
                  {apps.map(a => <option key={a.id} value={a.id}>{a.opening?.opening_code || a.opening_code} · {a.opening?.designation || a.designation || ''}</option>)}
                </select>
              </F>
            )}
          </Row>
          <F label="Title (optional)"><input style={inp} value={title} onChange={e => setTitle(e.target.value)} /></F>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input key={inputKey} type="file" accept={CANDIDATE_DOC_ACCEPT} onChange={e => setFile(e.target.files?.[0] || null)} style={{ fontSize: 12, color: 'var(--text-2)', flex: 1 }} />
            <button onClick={upload} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}><UploadCloud size={14} /> {busy ? 'Uploading…' : 'Upload'}</button>
          </div>
          <div style={{ ...muted, marginTop: 6 }}>PDF, DOC/DOCX or an image, up to 15 MB.</div>
        </div>
      )}
    </Card>
  );
}
