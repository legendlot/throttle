'use client';
// Hiring J1 — the Work account card (candidate page), the create form (also used by People → "Create account
// without hiring") and the one-time password modal. Presentation only; every gate is the worker's
// (podiumops-worker: getWorkAccount / createWorkAccount / confirmJoining / markNoShow / suspendWorkAccount).
// The temp password lives only in component state until "I've noted it" — never stored, never logged.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@throttle/ui';
import { KeyRound, Copy, UserCheck, UserX, Ban, Check, RotateCcw } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { fmtDate } from '../lib/format.js';
import { ToneBadge, F, Row, inp, primaryBtn, ghostBtn, muted } from './HiringBits.js';
import { hiringError, fmtDateTime, istTodayIso, WORK_ACCOUNT_STATUSES, labelFrom } from '../lib/hiring.js';

const box = { marginTop: 8, padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' };
const boxTitle = { fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, flex: 1 };
const smallBtn = { ...ghostBtn, padding: '4px 10px' };
const GOOGLE_ADMINS_LINE = 'A Google admin (Afshaan, Vinay, Mohit) creates the account.';
const TAKEN_REASON = { in_podium: 'a Podium employee has it', podium_account: 'Podium is already creating it', google: 'exists in Google', google_unavailable: 'could not check Google' };

function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function Availability({ a }) {
  if (!a) return null;
  if (a.available === true) return <ToneBadge tone="ok" label="available" />;
  if (a.available === false) return <ToneBadge tone="bad" label={`taken — ${TAKEN_REASON[a.reason] || a.reason || 'in use'}`} />;
  return <ToneBadge tone="warn" label={TAKEN_REASON[a.reason] || 'unknown'} />;
}

// ── The one-time password ────────────────────────────────────────────────────
export function PasswordModal({ email, password, onClose }) {
  const { showToast } = useToast();
  async function copy() {
    try { await navigator.clipboard.writeText(password); showToast('Copied', 'success'); }
    catch { showToast('Copy failed — select it and copy by hand', 'error'); }
  }
  return (
    <div style={overlay}>
      <div style={modal} role="dialog" aria-modal="true" aria-label="Work account created">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, marginBottom: 12 }}><KeyRound size={16} /> Work account created</div>
        <F label="Email"><div style={{ ...inp, userSelect: 'all' }}>{email}</div></F>
        <F label="Temporary password">
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ ...inp, flex: 1, userSelect: 'all', letterSpacing: '0.08em' }}>{password}</div>
            <button onClick={copy} style={ghostBtn}><Copy size={13} /> Copy</button>
          </div>
        </F>
        <div style={{ ...muted, margin: '8px 0 14px' }}>Shown once — Podium does not keep it. They must change it at first sign-in.</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={primaryBtn}><Check size={13} /> I've noted it</button>
        </div>
      </div>
    </div>
  );
}

// ── Create form: names, address (proposal 1 / 2 / custom), OU ───────────────
// `form` = getWorkAccount's form block. applicationId null → the override path (reason required).
export function WorkAccountForm({ form, applicationId = null, workAccountId = null, session, onCreated, onCancel }) {
  const { showToast } = useToast();
  const proposals = form.proposals || [];
  const firstFree = proposals.find(p => p.available !== false);
  const [given, setGiven] = useState(form.given || '');
  const [family, setFamily] = useState(form.family || '');
  const [choice, setChoice] = useState(firstFree ? firstFree.local : 'custom');
  const [custom, setCustom] = useState('');
  const [customCheck, setCustomCheck] = useState(null);
  const [ou, setOu] = useState(form.default_ou || '/');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const domain = form.domain || 'legendoftoys.com';

  async function check() {
    const local = custom.trim().toLowerCase();
    if (!local) return;
    try { setCustomCheck(await podiumopsGet('checkWorkEmail', { local, work_account_id: workAccountId }, session)); }
    catch (e) { setCustomCheck(null); showToast(hiringError(e), 'error'); }
  }
  async function create() {
    const local = choice === 'custom' ? custom.trim().toLowerCase() : choice;
    if (!local) { showToast('Pick an address', 'error'); return; }
    if (!given.trim() || !family.trim()) { showToast('Given and family name are required', 'error'); return; }
    if (!applicationId && reason.trim().length < 10) { showToast('Say why (at least 10 characters)', 'error'); return; }
    if (!window.confirm(`Create ${local}@${domain} in Google now?`)) return;
    setBusy(true);
    try {
      const r = await podiumopsPost('createWorkAccount', {
        application_id: applicationId, override_reason: applicationId ? null : reason.trim(),
        local_part: local, given_name: given.trim(), family_name: family.trim(), org_unit_path: ou,
      }, session);
      onCreated(r);
    } catch (e) { showToast(hiringError(e, 'Could not create the account'), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <Row>
        <F label="Given name"><input style={inp} value={given} maxLength={60} onChange={e => setGiven(e.target.value)} /></F>
        <F label="Family name"><input style={inp} value={family} maxLength={60} onChange={e => setFamily(e.target.value)} /></F>
      </Row>
      <F label="Address">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {proposals.map(p => (
            <label key={p.local} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="radio" name={`wa-${applicationId || 'override'}`} checked={choice === p.local} onChange={() => setChoice(p.local)} disabled={p.available === false} />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{p.local}@{domain}</span> <Availability a={p} />
            </label>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
            <input type="radio" name={`wa-${applicationId || 'override'}`} checked={choice === 'custom'} onChange={() => setChoice('custom')} />
            Custom
            <input style={{ ...inp, width: 180 }} value={custom} placeholder="first.last" disabled={choice !== 'custom'}
              onChange={e => { setCustom(e.target.value); setCustomCheck(null); }} />
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>@{domain}</span>
            <button onClick={check} style={smallBtn} disabled={choice !== 'custom' || !custom.trim()}>Check</button>
            {choice === 'custom' && <Availability a={customCheck} />}
          </label>
        </div>
      </F>
      <F label="Org unit">
        <select style={inp} value={ou} onChange={e => setOu(e.target.value)}>
          {(form.ous || ['/']).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </F>
      {!applicationId && (
        <F label="Why without hiring? * (at least 10 characters)"><input style={inp} value={reason} onChange={e => setReason(e.target.value)} /></F>
      )}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {onCancel && <button onClick={onCancel} style={ghostBtn} disabled={busy}>Cancel</button>}
        <button onClick={create} style={primaryBtn} disabled={busy}><KeyRound size={13} /> {busy ? 'Creating…' : 'Create account'}</button>
      </div>
    </div>
  );
}

// ── The card on one application (accepted / joined / no_show / withdrawn with an account) ──
export const WORK_ACCOUNT_APP_STATUSES = ['accepted', 'joined', 'no_show', 'withdrawn'];

export function WorkAccountCard({ a, session, onChanged }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [d, setD] = useState(null);        // null = loading, false = nothing to show (no access / error)
  const [created, setCreated] = useState(null);   // { email, temp_password } — until "I've noted it"
  const [startDate, setStartDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsResolution, setNeedsResolution] = useState(false);   // from the confirmJoining result

  const load = useCallback(() => {
    if (!session || !a?.id) return;
    podiumopsGet('getWorkAccount', { application_id: a.id }, session)
      .then(r => { setD(r); setStartDate(s => s || r.today || istTodayIso()); })
      .catch(() => setD(false));
  }, [a?.id, a?.status, session]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  if (!d) return null;
  const wa = d.work_account;
  const live = !!wa && wa.status !== 'failed';
  if (a.status === 'withdrawn' && !live) return null;

  async function run(action, body, done) {
    setBusy(true);
    try { const r = await podiumopsPost(action, body, session); done(r); load(); onChanged && onChanged(); }
    catch (e) {
      // doc_copy_failed carries WHICH documents failed (title + type) after the code.
      const m = String(e?.message || '');
      showToast(m.startsWith('doc_copy_failed:') ? `Could not copy: ${m.slice('doc_copy_failed:'.length).trim()} — fix or remove them and retry` : hiringError(e), 'error');
    }
    finally { setBusy(false); }
  }
  function confirmJoining() {
    if (!startDate) { showToast('Pick the start date', 'error'); return; }
    if (!window.confirm(`Confirm they joined on ${fmtDate(startDate)}? This creates the employee record.`)) return;
    run('confirmJoining', { application_id: a.id, start_date: startDate }, r => {
      setNeedsResolution(!!r.opening_needs_resolution);
      showToast(`Joined — ${r.employee_code}${r.opening_filled ? ' · opening filled' : ''}`, 'success');
    });
  }
  function markNoShow() {
    const note = window.prompt('Mark as no-show? Optional note (only the salary chain sees it):', '');
    if (note === null) return;
    run('markNoShow', { application_id: a.id, note: note.trim() || null }, () => showToast('Marked no-show', 'success'));
  }
  function resetPassword() {
    if (!window.confirm(`Set a new temporary password for ${wa.email}? The old one stops working.`)) return;
    run('resetWorkAccountPassword', { work_account_id: wa.id }, r => setCreated({ email: r.email, password: r.temp_password }));
  }
  function suspend() {
    if (!window.confirm(`Suspend ${wa.email} in Google?`)) return;
    run('suspendWorkAccount', { work_account_id: wa.id }, () => showToast('Account suspended', 'success'));
  }

  let content;
  if (d.rehire) {
    content = <div style={muted}>This person was an employee before. Rehires are not supported yet — handle the account and the employee record by hand.</div>;
  } else if (a.status === 'joined') {
    content = d.employee
      ? <div style={{ fontSize: 13 }}>Joined as <a onClick={() => router.push(`/people/detail/?id=${d.employee.id}`)} style={{ color: 'var(--podium-accent)', cursor: 'pointer', fontWeight: 600 }}>{d.employee.employee_code} · {d.employee.full_name}</a>{wa && <span style={muted}> · {wa.email}</span>}</div>
      : <div style={muted}>Joined.</div>;
    if (needsResolution) content = <>{content}<div style={{ ...muted, color: 'var(--warn-fg)', marginTop: 6 }}>The opening has reached its headcount but other candidates are still active on it — close or move them, then mark the opening filled.</div></>;
  } else if (live && wa.status !== 'pending') {
    content = (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{wa.email}</span>
          <ToneBadge tone={wa.status === 'suspended' ? 'bad' : 'ok'} label={labelFrom(WORK_ACCOUNT_STATUSES, wa.status)} />
          <span style={muted}>{wa.org_unit_path} · created {d.requested_by_name ? `by ${d.requested_by_name} ` : ''}{fmtDateTime(wa.created_at)}</span>
        </div>
        {a.status === 'accepted' && d.can_confirm && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={muted}>Start date</span>
            <input type="date" style={{ ...inp, width: 160 }} value={startDate} max={d.today ? addDays(d.today, 7) : undefined}
              min={d.accepted_at || undefined} onChange={e => setStartDate(e.target.value)} />
            <button onClick={confirmJoining} style={{ ...primaryBtn, padding: '6px 12px' }} disabled={busy}><UserCheck size={13} /> Confirm joining</button>
            <button onClick={markNoShow} style={smallBtn} disabled={busy}><UserX size={13} /> Mark no-show</button>
          </div>
        )}
        {wa.status === 'created' && d.google_admin && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button onClick={resetPassword} style={smallBtn} disabled={busy}><RotateCcw size={13} /> Reset temp password</button>
            {['no_show', 'withdrawn'].includes(a.status) && <button onClick={suspend} style={smallBtn} disabled={busy}><Ban size={13} /> Suspend account</button>}
          </div>
        )}
      </>
    );
  } else if (a.status === 'accepted') {
    const failed = wa && wa.status === 'failed';
    const pending = wa && wa.status === 'pending';
    content = (
      <>
        {failed && <div style={{ ...muted, color: 'var(--bad-fg)', marginBottom: 6 }}>Last attempt for {wa.email} failed: {wa.last_error || 'unknown error'}</div>}
        {pending && <div style={{ ...muted, marginBottom: 6 }}>Creating {wa.email} did not finish — create it again to complete it (Podium links the account Google already made).</div>}
        {!d.offer_accepted ? <div style={muted}>The account is created once the offer is accepted.</div>
          : !d.google_admin ? <div style={muted}>{GOOGLE_ADMINS_LINE}</div>
          : d.form?.error ? <div style={muted}>Google could not be reached ({d.form.error.replace(/_/g, ' ')}) — try again shortly.</div>
          : d.form ? <WorkAccountForm form={d.form} applicationId={a.id} workAccountId={wa?.id || null} session={session}
              onCreated={r => setCreated({ email: r.email, password: r.temp_password })} />
          : null}
      </>
    );
  } else {
    return null;
  }

  return (
    <div style={box}>
      {created && <PasswordModal email={created.email} password={created.password} onClose={() => { setCreated(null); load(); onChanged && onChanged(); }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={boxTitle}>Work account</span>
        {d.start_date && a.status === 'accepted' && <span style={muted}>offer start {fmtDate(d.start_date)}</span>}
      </div>
      {content}
    </div>
  );
}

// ── People → "Create account without hiring" (Google admins; reason required) ──
export function OverrideAccountModal({ session, onClose }) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  async function prepare() {
    if (!name.trim()) { showToast('Enter the person\'s name', 'error'); return; }
    setBusy(true);
    try { const r = await podiumopsGet('getWorkAccount', { name: name.trim() }, session); setForm(r.form); }
    catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  if (created) return <PasswordModal email={created.email} password={created.password} onClose={() => { setCreated(null); onClose(); }} />;
  return (
    <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div style={{ ...modal, width: 'min(560px, 100%)' }} role="dialog" aria-modal="true" aria-label="Create account without hiring">
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Create a work account without hiring</div>
        <div style={{ ...muted, marginBottom: 12 }}>For someone who is not coming through an opening. No employee record is created — import them with Sync from Google once they start.</div>
        {!form ? (
          <>
            <F label="Full name"><input style={inp} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') prepare(); }} /></F>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={ghostBtn} disabled={busy}>Cancel</button>
              <button onClick={prepare} style={primaryBtn} disabled={busy}>{busy ? 'Checking…' : 'Next'}</button>
            </div>
          </>
        ) : (
          <WorkAccountForm form={form} applicationId={null} session={session} onCancel={onClose}
            onCreated={r => setCreated({ email: r.email, password: r.temp_password })} />
        )}
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 120, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '10vh 16px', overflow: 'auto' };
const modal = { width: 'min(460px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 18px', color: 'var(--text-1)' };
