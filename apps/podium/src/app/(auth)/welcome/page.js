'use client';
// J2 — /welcome: your profile (one-time completion for everyone; onboarding for joiners). Self-serve for any
// logged-in employee, including a joiner with no Podium role: getMyProfile / saveMyProfile /
// createMyDocumentUploadUrl / recordMyDocument / acknowledgePolicy / getPolicyFile all self-scope in the worker.
// A change to a PAN / bank field that is already filled becomes a request HR approves (shown as awaiting approval).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Save, UploadCloud, FileText, Check, ClipboardList } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import { fmtDate, GENDER_OPTIONS, BLOOD_GROUPS } from '../../../lib/format.js';
import { PROFILE_SECTIONS, DOC_TYPE_LABELS, CHANGE_FIELD_LABELS, CHANGE_GROUP_LABELS, PROTECTED_FIELDS, groupOf, obError } from '../../../lib/onboarding.js';
import { Card, F, Note, ToneBadge, signedUpload, inp, primaryBtn, ghostBtn, muted } from '../../../components/HiringBits.js';
import { OnboardingLines } from '../../../components/OnboardingBits.js';

const ALL_FIELDS = PROFILE_SECTIONS.flatMap(s => s.fields);

export default function WelcomePage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getMyProfile', {}, session).then(r => {
      setD(r);
      if (r.employee) {
        const f = {};
        for (const x of ALL_FIELDS) {
          const v = x.src === 'private' ? r.private?.[x.key] : r.employee?.[x.key];
          f[x.key] = v == null ? '' : String(v);
        }
        setForm(f);
      }
    }).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  const original = useMemo(() => {
    if (!d?.employee) return {};
    const f = {};
    for (const x of ALL_FIELDS) { const v = x.src === 'private' ? d.private?.[x.key] : d.employee?.[x.key]; f[x.key] = v == null ? '' : String(v); }
    return f;
  }, [d]);

  if (d === false) return <div style={{ color: 'var(--t3)' }}>Could not load your profile.</div>;
  if (!d) return <Spinner />;
  if (!d.employee) return <div style={{ color: 'var(--t3)', fontSize: 14, maxWidth: 640 }}>Your login is not linked to an employee profile yet. Ask HR to set one up.</div>;

  const missingKeys = new Set(d.missing.map(m => m.key));
  const pending = (d.change_requests || []).filter(c => c.status === 'pending');
  const pendingBy = Object.fromEntries(pending.map(c => [c.field, c]));
  const changed = Object.keys(form).filter(k => (form[k] || '') !== (original[k] || ''));
  const pendingGroups = [...new Set(pending.map(c => groupOf(c.field)))];

  async function withdraw(group) {
    if (!window.confirm(`Withdraw your pending ${CHANGE_GROUP_LABELS[group]} change? The current value stays.`)) return;
    setBusy(true);
    try { await podiumopsPost('withdrawMyChangeRequest', { group }, session); showToast('Withdrawn', 'success'); load(); }
    catch (e) { showToast(obError(e), 'error'); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!changed.length) return;
    // Only what changed.
    const fields = Object.fromEntries(changed.map(k => [k, form[k]]));
    setBusy(true); setErrors({});
    try {
      const r = await podiumopsPost('saveMyProfile', { fields }, session);
      const req = r?.change_requests || [];
      showToast(req.length ? `Saved — ${req.map(f => CHANGE_FIELD_LABELS[f] || f).join(', ')} sent to HR for approval` : 'Saved', 'success');
      load();
    } catch (e) {
      const errs = e.body?.errors;
      if (Array.isArray(errs) && errs.length) setErrors(Object.fromEntries(errs.map(x => [x.field, x.message])));
      showToast(obError(e), 'error');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--t1)' }}>Welcome{d.employee.preferred_name || d.employee.full_name ? `, ${d.employee.preferred_name || d.employee.full_name}` : ''}</div>
        <div style={muted}>Fill your details once — HR and payroll use them. {d.missing.length
          ? <>Still needed: <b>{d.missing.length}</b> item{d.missing.length === 1 ? '' : 's'} ({d.completion_pct}% complete).</>
          : <>Your profile is complete.</>}</div>
      </div>

      {pendingGroups.map(g => (
        <Note key={g} tone="info">
          <span style={{ flex: 1 }}>Awaiting HR approval: {CHANGE_GROUP_LABELS[g]} ({pending.filter(c => groupOf(c.field) === g).map(c => CHANGE_FIELD_LABELS[c.field] || c.field).join(', ')}). The current value stays until HR approves.</span>
          <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11 }} disabled={busy} onClick={() => withdraw(g)}>Withdraw</button>
        </Note>
      ))}

      {d.onboarding && (
        <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ClipboardList size={13} /> Your first weeks</span>}
          right={d.onboarding.progress ? <span style={muted}>{d.onboarding.progress.done}/{d.onboarding.progress.required} done</span> : null}>
          <div style={{ ...muted, marginBottom: 4 }}>What happens around your joining and who does it. Your lines tick themselves as you complete this page.</div>
          <OnboardingLines items={d.onboarding.items} />
        </Card>
      )}

      {PROFILE_SECTIONS.map(sec => (
        <Card key={sec.id} title={sec.title}>
          {sec.salary && <div style={{ ...muted, marginBottom: 8 }}>Only if you changed jobs this financial year (April–March). Seen by you and the payroll team only.</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 12px' }}>
            {sec.fields.map(x => (
              <FieldInput key={x.key} x={x} value={form[x.key] ?? ''} missing={missingKeys.has(x.key)} error={errors[x.key]}
                pending={pendingBy[x.key]} locked={PROTECTED_FIELDS.includes(x.key) && !!original[x.key]}
                onChange={v => setForm(f => ({ ...f, [x.key]: v }))} />
            ))}
          </div>
        </Card>
      ))}

      <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg)', padding: '10px 0', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        {changed.length > 0 && <span style={{ ...muted, alignSelf: 'center' }}>{changed.length} unsaved change{changed.length === 1 ? '' : 's'}</span>}
        <button style={{ ...primaryBtn, opacity: changed.length ? 1 : 0.5 }} disabled={busy || !changed.length} onClick={save}><Save size={13} /> {busy ? 'Saving…' : 'Save'}</button>
      </div>

      <MyDocuments d={d} session={session} onUploaded={load} />
      <MyPolicies d={d} session={session} onChanged={load} />
    </div>
  );
}

function FieldInput({ x, value, missing, error, pending, locked, onChange }) {
  const label = <>{x.label}{x.required ? ' *' : ''}{missing && <span style={{ color: 'var(--warn-fg)' }}> · needed</span>}</>;
  const style = { ...inp, borderColor: error ? 'var(--bad-fg)' : undefined, fontFamily: x.type === 'textarea' ? 'var(--font-ui)' : inp.fontFamily };
  let el;
  if (x.type === 'gender') el = (
    <select style={style} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">—</option>{GENDER_OPTIONS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
    </select>);
  else if (x.type === 'blood') el = (
    <select style={style} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">—</option>{BLOOD_GROUPS.map(b => <option key={b} value={b}>{b}</option>)}
    </select>);
  else if (x.type === 'textarea') el = <textarea style={{ ...style, minHeight: 60 }} value={value} onChange={e => onChange(e.target.value)} />;
  else el = <input style={style} type={x.type === 'date' ? 'date' : x.type === 'email' ? 'email' : 'text'}
    inputMode={x.type === 'tel' || x.type === 'amount' ? 'numeric' : undefined} placeholder={x.placeholder || ''} value={value}
    onChange={e => onChange(x.upper ? e.target.value.toUpperCase() : e.target.value)} />;
  return (
    <F label={label}>
      {el}
      {error && <div style={{ fontSize: 11, color: 'var(--bad-fg)', marginTop: 3 }}>{error}</div>}
      {pending && <div style={{ fontSize: 11, color: 'var(--blue-soft)', marginTop: 3 }}>Change to “{pending.new_value}” awaiting HR approval</div>}
      {locked && !pending && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>Changing this sends it to HR for approval</div>}
    </F>
  );
}

function MyDocuments({ d, session, onUploaded }) {
  const { showToast } = useToast();
  const [docType, setDocType] = useState(d.required_doc_types.find(t => !d.documents.some(x => x.doc_type === t)) || d.self_doc_types[0]);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file) { showToast('Pick a file first', 'error'); return; }
    setBusy(true);
    try {
      const meta = await signedUpload('createMyDocumentUploadUrl', { doc_type: docType, file_size: file.size }, file, session);
      await podiumopsPost('recordMyDocument', { doc_type: docType, title: DOC_TYPE_LABELS[docType] || file.name, ...meta }, session);
      showToast('Uploaded', 'success'); setFile(null); onUploaded();
    } catch (e) { showToast(obError(e), 'error'); }
    finally { setBusy(false); }
  }
  const have = new Set(d.documents.map(x => x.doc_type));
  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileText size={13} /> Documents</span>}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {d.required_doc_types.map(t => <ToneBadge key={t} tone={have.has(t) ? 'ok' : 'warn'} label={`${DOC_TYPE_LABELS[t] || t}${have.has(t) ? ' ✓' : ''}`} />)}
      </div>
      {d.documents.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {d.documents.map(x => (
            <div key={x.id} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
              <span style={{ flex: 1 }}>{x.title || x.file_name}</span>
              <span style={muted}>{DOC_TYPE_LABELS[x.doc_type] || x.doc_type.replace(/_/g, ' ')} · {fmtDate(x.uploaded_at)}{x.self_uploaded ? '' : ' · from HR'}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={{ ...inp, width: 260 }} value={docType} onChange={e => setDocType(e.target.value)}>
          {d.self_doc_types.map(t => <option key={t} value={t}>{DOC_TYPE_LABELS[t] || t}</option>)}
        </select>
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={e => setFile(e.target.files?.[0] || null)} style={{ fontSize: 12, color: 'var(--text-2)' }} />
        <button style={primaryBtn} disabled={busy || !file} onClick={upload}><UploadCloud size={13} /> {busy ? 'Uploading…' : 'Upload'}</button>
      </div>
      <div style={{ ...muted, marginTop: 6 }}>PDF or a photo, up to 15 MB. Uploads are private: you and HR only.</div>
    </Card>
  );
}

function MyPolicies({ d, session, onChanged }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(null);
  if (!d.policies.length) return null;
  async function open(p) {
    try { const r = await podiumopsGet('getPolicyFile', { policy_id: p.id }, session); window.open(r.url, '_blank', 'noopener'); }
    catch (e) { showToast(obError(e), 'error'); }
  }
  async function ack(p) {
    setBusy(p.id);
    try { await podiumopsPost('acknowledgePolicy', { policy_id: p.id, version: p.version }, session); showToast('Acknowledged', 'success'); onChanged(); }
    catch (e) { showToast(obError(e), 'error'); }
    finally { setBusy(null); }
  }
  return (
    <Card title="Policies to read">
      {d.policies.map(p => (
        <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
          <span style={{ flex: 1 }}>{p.title} <span style={muted}>v{p.version} · {fmtDate(p.published_at)}</span></span>
          <button style={{ ...ghostBtn, padding: '4px 10px' }} onClick={() => open(p)}><FileText size={12} /> Read</button>
          {p.acknowledged ? <ToneBadge tone="ok" label="Acknowledged" />
            : <button style={{ ...primaryBtn, padding: '4px 10px' }} disabled={busy === p.id} onClick={() => ack(p)}><Check size={12} /> I have read this</button>}
        </div>
      ))}
    </Card>
  );
}
