'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Pencil, Download, Trash2, Lock } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import EmployeeForm from '../../../../components/EmployeeForm.js';
import DocumentUploader from '../../../../components/DocumentUploader.js';
import StatusBadge from '../../../../components/StatusBadge.js';
import { ObservationsPanel, WinsPanel, OneOnOnesPanel } from '../../../../components/PerformancePanels.js';
import { fmtDate, fmtMoney, tenure, labelOf, EMPLOYMENT_TYPES, DOC_TYPES, GENDER_LABELS } from '../../../../lib/format.js';

const TABS = [
  { id: 'profile',      label: 'Profile' },
  { id: 'observations', label: 'Observations' },
  { id: 'wins',         label: 'Wins' },
  { id: '1on1',         label: '1:1s' },
];

export default function PersonDetailPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState('profile');

  const load = useCallback(() => {
    if (!session || !id) return;
    podiumopsGet('getEmployee', { id }, session).then(setData).catch(() => setData(false));
  }, [session, id]);
  useEffect(() => { load(); }, [load]);

  if (data === false) return <div style={{ color: 'var(--text-3)' }}>Not found.</div>;
  if (!data) return <Spinner />;
  const e = data.employee;
  const canEdit = !!perms?.podium_hr;
  const full = data.can_see_full;

  return (
    <div style={{ maxWidth: 1040 }}>
      <button onClick={() => router.back()} style={backBtn}><ArrowLeft size={15} /> Back</button>

      <header style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '10px 0 18px' }}>
        <Avatar emp={e} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 24, fontWeight: 700, letterSpacing: '0.03em' }}>{e.full_name}</h1>
            <StatusBadge status={e.status} />
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
            <span style={{ color: 'var(--podium-accent)', fontWeight: 600 }}>{e.employee_code}</span>
            {e.job_title && <> · {e.job_title}</>}
            {e.department?.name && <> · {e.department.name}</>}
          </div>
        </div>
        {canEdit && !editing && <button onClick={() => setEditing(true)} style={editBtn}><Pencil size={14} /> Edit</button>}
      </header>

      {!full && <div style={notice}><Lock size={13} /> Limited view — full profile is visible to HR, the person, and their managers.</div>}

      <div style={tabBar}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...tabBtn, ...(tab === t.id ? tabBtnActive : {}) }}>{t.label}</button>
        ))}
      </div>

      {tab === 'profile' ? (
        editing ? (
        <div style={card}>
          <EmployeeForm session={session} initial={e} onSaved={() => { setEditing(false); load(); }} onCancel={() => setEditing(false)} />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignItems: 'start' }}>
          <Card title="Employment">
            <KV k="Job role" v={e.job_role?.title} />
            <KV k="Manager" v={e.manager?.full_name} />
            <KV k="Type" v={labelOf(EMPLOYMENT_TYPES, e.employment_type)} />
            <KV k="Legal entity" v={e.legal_entity} />
            <KV k="Location" v={e.work_location} />
            <KV k="Joined" v={fmtDate(e.date_joined)} />
            <KV k="Tenure" v={tenure(e.date_joined)} />
            {full && <>
              <KV k="Probation ends" v={fmtDate(e.probation_end_date)} />
              <KV k="Confirmed" v={fmtDate(e.confirmed_at)} />
              {e.status === 'exited' && <><KV k="Exited" v={fmtDate(e.date_exited)} /><KV k="Exit reason" v={e.exit_reason} /></>}
            </>}
          </Card>

          {full && (
            <Card title="Personal">
              <KV k="Work email" v={e.work_email} />
              <KV k="Personal email" v={e.personal_email} />
              <KV k="Phone" v={e.phone} />
              <KV k="Date of birth" v={fmtDate(e.date_of_birth)} />
              <KV k="Gender" v={GENDER_LABELS[e.gender] || e.gender} />
              <KV k="Blood group" v={e.blood_group} />
              <KV k="Emergency" v={e.emergency_contact_name ? `${e.emergency_contact_name} · ${e.emergency_contact_phone || ''}` : null} />
              {'pan_number' in e && <KV k="PAN" v={e.pan_number} />}
            </Card>
          )}

          {(data.reports || []).length > 0 && (
            <Card title={`Team (${data.reports.length})`}>
              {data.reports.map(r => (
                <div key={r.id} onClick={() => router.push(`/people/detail/?id=${r.id}`)} style={reportRow}>
                  <span>{r.full_name}</span>
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{r.job_title || ''}</span>
                </div>
              ))}
            </Card>
          )}

          {full && <DocumentsCard employeeId={e.id} session={session} canManage={canEdit} />}
          {data.can_see_comp && <CompCard employeeId={e.id} session={session} canManage={!!(perms?.podium_comp || perms?.podium_admin)} />}
        </div>
        )
      ) : tab === 'observations' ? (
        <ObservationsPanel employeeId={e.id} session={session} />
      ) : tab === 'wins' ? (
        <WinsPanel employeeId={e.id} session={session} />
      ) : (
        <OneOnOnesPanel employeeId={e.id} session={session} />
      )}
    </div>
  );
}

function DocumentsCard({ employeeId, session, canManage }) {
  const { showToast } = useToast();
  const [docs, setDocs] = useState(null);
  const load = useCallback(() => {
    podiumopsGet('getDocuments', { employee_id: employeeId }, session).then(r => setDocs(r.documents || [])).catch(() => setDocs([]));
  }, [employeeId, session]);
  useEffect(() => { load(); }, [load]);

  async function download(d) {
    try {
      const r = await podiumopsGet('getDocumentDownloadUrl', { id: d.id }, session);
      window.open(r.url, '_blank');
    } catch (e) { showToast(e.message || 'Could not open', 'error'); }
  }
  async function del(d) {
    if (!confirm(`Delete "${d.title || d.file_name}"?`)) return;
    try { await podiumopsPost('deleteDocument', { id: d.id }, session); showToast('Deleted', 'success'); load(); }
    catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  return (
    <Card title="Documents">
      {docs == null ? <div style={{ color: 'var(--text-3)', fontSize: 12 }}>Loading…</div> :
        docs.length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: 12 }}>No documents.</div> :
        docs.map(d => (
          <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--border)' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title || d.file_name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{labelOf(DOC_TYPES, d.doc_type)}{d.expires_at && ` · expires ${fmtDate(d.expires_at)}`}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => download(d)} style={iconBtn} title="Download"><Download size={14} /></button>
              {canManage && <button onClick={() => del(d)} style={iconBtn} title="Delete"><Trash2 size={14} /></button>}
            </div>
          </div>
        ))}
      {canManage && <DocumentUploader employeeId={employeeId} session={session} onUploaded={load} />}
    </Card>
  );
}

function CompCard({ employeeId, session, canManage }) {
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ event_type: 'increment', increment_pct: '', amount: '', effective_date: '', reason: '' });
  const load = useCallback(() => {
    podiumopsGet('getCompensation', { employee_id: employeeId }, session).then(setData).catch(() => setData({ events: [] }));
  }, [employeeId, session]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    setForm(f => ({ ...f }));
    try {
      const body = { employee_id: employeeId, event_type: form.event_type, reason: form.reason || null };
      if (form.increment_pct !== '') body.increment_pct = Number(form.increment_pct);
      if (form.amount !== '') body.amount = Number(form.amount);
      if (form.effective_date) body.effective_date = form.effective_date;
      await podiumopsPost('addCompensationEvent', body, session);
      showToast('Recorded', 'success');
      setForm({ event_type: 'increment', increment_pct: '', amount: '', effective_date: '', reason: '' });
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  return (
    <Card title="Compensation">
      {!data ? <div style={{ color: 'var(--text-3)', fontSize: 12 }}>Loading…</div> : <>
        {!data.comp_vault_enabled && (
          <div style={{ ...notice, marginBottom: 10 }}><Lock size={13} /> Salary vault disabled — increments &amp; bonuses only (absolute CTC enabled after Phase&nbsp;5 hardening).</div>
        )}
        <KV k="Current CTC" v={data.comp_vault_enabled ? fmtMoney(data.current_ctc) : '— (vault off)'} />
        <div style={{ marginTop: 8 }}>
          {(data.events || []).length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: 12 }}>No events.</div> :
            (data.events || []).map(ev => (
              <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
                <span>{fmtDate(ev.effective_date)} · {ev.event_type.replace(/_/g, ' ')}</span>
                <span style={{ fontWeight: 600, color: 'var(--podium-accent)' }}>
                  {ev.increment_pct != null ? `+${ev.increment_pct}%` : ''}{ev.amount != null ? ` ${fmtMoney(ev.amount, ev.currency)}` : ''}
                </span>
              </div>
            ))}
        </div>
        {canManage && (
          <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <select value={form.event_type} onChange={e => setForm(f => ({ ...f, event_type: e.target.value }))} style={cinp(130)}>
                <option value="increment">Increment</option>
                <option value="one_time_bonus">One-time bonus</option>
                <option value="revision">Revision</option>
                <option value="correction">Correction</option>
                <option value="initial">Initial</option>
              </select>
              <input placeholder="Incr %" value={form.increment_pct} onChange={e => setForm(f => ({ ...f, increment_pct: e.target.value }))} style={cinp(80)} />
              <input placeholder="Bonus ₹" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={cinp(100)} />
              <input type="date" value={form.effective_date} onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))} style={cinp(140)} />
              <input placeholder="Reason" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} style={cinp(160)} />
              <button onClick={add} style={{ ...editBtn, background: 'var(--podium-accent)', color: '#1f1f1f', border: 'none' }}>Add</button>
            </div>
          </div>
        )}
      </>}
    </Card>
  );
}

function Avatar({ emp }) {
  const initials = (emp.full_name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{ width: 56, height: 56, borderRadius: 'var(--radius-full)', overflow: 'hidden', background: 'var(--surface-3)', color: 'var(--podium-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, flex: '0 0 auto' }}>
      {emp.photo_url ? <img src={emp.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials}
    </div>
  );
}
function Card({ title, children }) {
  return <div style={card}><div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>{title}</div>{children}</div>;
}
function KV({ k, v }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 13 }}><span style={{ color: 'var(--text-3)' }}>{k}</span><span style={{ textAlign: 'right' }}>{v || '—'}</span></div>;
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '14px 16px' };
const backBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontSize: 12, cursor: 'pointer' };
const editBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
const reportRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13, cursor: 'pointer' };
const notice = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--state-warning-bg)', color: 'var(--state-warning-fg)', border: '1px solid var(--state-warning)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 12, marginBottom: 14 };
const tabBar = { display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 };
const tabBtn = { background: 'transparent', color: 'var(--text-3)', border: 'none', borderBottom: '2px solid transparent', padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: -1 };
const tabBtnActive = { color: 'var(--text-1)', borderBottomColor: 'var(--podium-accent)' };
const cinp = (w) => ({ background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 12, width: w });
