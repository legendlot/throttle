'use client';
// J2 — the shared onboarding pieces: the "Complete your profile" banner (/me + dashboard), the Onboarding card on a
// person's page (manager ticks manager lines, HR all), the HR private-details card (bank masked) and the line list.
// Presentation only; every gate is the worker's (getMyProfile / getOnboarding / updateOnboardingItem /
// startOnboarding / completeOnboarding / cancelOnboarding / getEmployeePrivate).
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@throttle/ui';
import { UserCheck, Check, Ban, RotateCcw, Lock, ChevronRight } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { fmtDate, fmtMoney } from '../lib/format.js';
import { OB_OWNERS, OB_AUTO_LABELS, OB_STATE, obError } from '../lib/onboarding.js';
import { ToneBadge, Card, KV, inp, primaryBtn, ghostBtn, muted } from './HiringBits.js';

const smallBtn = { ...ghostBtn, padding: '3px 9px', fontSize: 11 };

// "Complete your profile — N items left": while the campaign is launched (or they have an open onboarding) and the
// completion rule still lists something. Self-serve (getMyProfile), so it works for a joiner with no Podium role.
export function ProfileBanner({ session }) {
  const router = useRouter();
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!session) return;
    podiumopsGet('getMyProfile', {}, session).then(setD).catch(() => setD(false));
  }, [session]);
  if (!d || !d.employee || !d.show_banner) return null;
  const n = d.missing.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(242,205,26,0.07)', border: '1px solid var(--yellow)',
      borderRadius: 11, padding: '14px 18px', marginBottom: 16 }}>
      <UserCheck size={18} color="var(--yellow)" style={{ flex: 'none' }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>Complete your profile — {n} item{n === 1 ? '' : 's'} left</div>
        <div style={{ fontSize: 12, color: 'var(--t2)' }}>{d.missing.slice(0, 4).map(m => m.label).join(' · ')}{n > 4 ? ' …' : ''}</div>
      </div>
      <div onClick={() => router.push('/welcome/')} style={{ background: 'var(--yellow)', color: '#1b1b1e', borderRadius: 6, padding: '7px 14px',
        fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 5 }}>Open <ChevronRight size={14} /></div>
    </div>
  );
}

// The line list. `onSet(item, status, note)` is omitted for read-only views (/welcome).
export function OnboardingLines({ items, onSet, busy }) {
  const groups = OB_OWNERS.map(o => ({ ...o, items: (items || []).filter(i => i.owner === o.id) })).filter(g => g.items.length);
  if (!groups.length) return <div style={muted}>No lines.</div>;
  return (
    <div>
      {groups.map(g => (
        <div key={g.id} style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>{g.label}</div>
          {g.items.map(it => <LineRow key={it.id} it={it} onSet={onSet} busy={busy} />)}
        </div>
      ))}
    </div>
  );
}

function LineRow({ it, onSet, busy }) {
  const [mode, setMode] = useState(null);   // 'done' | 'na' while the note box is open
  const [note, setNote] = useState('');
  const st = OB_STATE[it.state] || OB_STATE.open;
  const can = !!onSet && it.can_set;
  const needsNote = (m) => m === 'na' || (m === 'done' && !!it.auto_source);
  function go(m) {
    if (needsNote(m) && !mode) { setMode(m); setNote(it.note || ''); return; }
    onSet(it, m, note); setMode(null);
  }
  return (
    <div style={{ padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <ToneBadge tone={st.tone} label={st.label} />
        <span style={{ flex: 1, minWidth: 160, color: it.required ? 'var(--text-1)' : 'var(--text-2)' }}>
          {it.title}{!it.required && <span style={muted}> (optional)</span>}
        </span>
        {it.due_date && <span style={{ ...muted, color: it.overdue ? 'var(--bad-fg)' : undefined, fontWeight: it.overdue ? 600 : 400 }}>
          {it.overdue ? 'Overdue · ' : 'Due '}{fmtDate(it.due_date)}</span>}
        {can && it.status === 'open' && (!it.auto_source || it.live === 'unverifiable') && <button style={smallBtn} disabled={busy} onClick={() => go('done')}><Check size={11} /> Done</button>}
        {can && it.status === 'open' && it.allow_na && <button style={smallBtn} disabled={busy} onClick={() => go('na')}><Ban size={11} /> N/A</button>}
        {can && it.status !== 'open' && <button style={smallBtn} disabled={busy} onClick={() => onSet(it, 'open', '')}><RotateCcw size={11} /> Reopen</button>}
      </div>
      {it.auto_source && <div style={{ ...muted, marginLeft: 4 }}>{OB_AUTO_LABELS[it.auto_source]}{it.live === 'unverifiable' ? ' — cannot be checked automatically (no LOT login linked); HR marks it with a note' : ''}</div>}
      {it.note && <div style={{ ...muted, marginLeft: 4 }}>“{it.note}”</div>}
      {mode && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input style={inp} autoFocus placeholder={mode === 'na' ? 'Why it does not apply' : 'How it was verified'} value={note} onChange={e => setNote(e.target.value)} />
          <button style={{ ...primaryBtn, padding: '4px 10px' }} disabled={busy || !note.trim()} onClick={() => go(mode)}>Save</button>
          <button style={smallBtn} onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// The Onboarding card on a person's page. Hidden when the caller has no role on this person's onboarding.
export function OnboardingCard({ employeeId, session }) {
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!session || !employeeId) return;
    podiumopsGet('getOnboarding', { employee_id: employeeId }, session).then(setD).catch(() => setD(false));
  }, [employeeId, session]);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  if (!d.onboarding && !d.can_start) return null;
  const ob = d.onboarding;
  const open = ob?.status === 'open';

  async function run(name, body, msg) {
    setBusy(true);
    try { await podiumopsPost(name, body, session); if (msg) showToast(msg, 'success'); load(); }
    catch (e) {
      const b = e.body?.blockers;
      showToast(b?.length ? `${obError(e)}: ${b.map(x => x.title).join(', ')}` : obError(e), 'error');
    } finally { setBusy(false); }
  }
  function cancel() {
    const reason = window.prompt('Cancel this onboarding? Reason:', '');
    if (reason === null) return;
    run('cancelOnboarding', { onboarding_id: ob.id, reason: reason.trim() }, 'Onboarding cancelled');
  }

  return (
    <Card title="Onboarding" style={{ gridColumn: '1 / -1' }}
      right={d.can_start ? <button style={primaryBtn} disabled={busy} onClick={() => run('startOnboarding', { employee_id: employeeId }, 'Onboarding started')}>Start onboarding</button> : null}>
      {!ob ? <div style={muted}>No onboarding recorded.{d.profile_missing?.length ? ` Profile: ${d.profile_missing.length} item(s) missing.` : ''}</div> : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, marginBottom: 6 }}>
            <ToneBadge tone={open ? 'warn' : ob.status === 'complete' ? 'ok' : 'neutral'} label={ob.status} />
            {d.progress && <span style={muted}>{d.progress.done}/{d.progress.required} required lines</span>}
            <span style={muted}>· started {fmtDate(ob.created_at)} {ob.started_via === 'joining' ? 'at joining' : 'by HR'}</span>
            {ob.status === 'cancelled' && <span style={muted}>· {ob.cancel_reason}</span>}
          </div>
          {d.profile_missing?.length > 0 && <div style={{ ...muted, marginBottom: 6 }}>Profile still missing: {d.profile_missing.join(', ')}</div>}
          <OnboardingLines items={d.items} busy={busy} onSet={open ? (it, status, note) => run('updateOnboardingItem', { item_id: it.id, status, note }, null) : undefined} />
          {open && d.can_manage && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <button style={ghostBtn} disabled={busy} onClick={cancel}><Ban size={13} /> Cancel</button>
              <button style={{ ...primaryBtn, opacity: d.blockers.length ? 0.5 : 1 }} disabled={busy || d.blockers.length > 0}
                onClick={() => run('completeOnboarding', { onboarding_id: ob.id }, 'Onboarding complete')}><Check size={13} /> Complete</button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// HR (bank masked) / comp (+ salary-tier fields, logged) view of a person's private details.
export function PrivateDetailsCard({ employeeId, session }) {
  const [d, setD] = useState(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!session || !employeeId || !show) return;
    podiumopsGet('getEmployeePrivate', { employee_id: employeeId }, session).then(setD).catch(() => setD(false));
  }, [employeeId, session, show]);
  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Lock size={12} /> Private details</span>}
      right={!show ? <button style={smallBtn} onClick={() => setShow(true)}>Show</button> : null}>
      {!show ? <div style={muted}>Bank, statutory and address details. Salary-tier figures are logged when viewed.</div>
        : d === null ? <div style={muted}>Loading…</div>
        : d === false ? <div style={muted}>Not available.</div>
        : <PrivateRows p={d.private || {}} tier={d.tier} />}
    </Card>
  );
}
function PrivateRows({ p, tier }) {
  return (
    <div>
      {(tier.hr || tier.self) && <>
        <KV k="Current address" v={p.current_address} />
        <KV k="Permanent address" v={p.permanent_address} />
        <KV k="Bank account" v={p.bank_account_number} />
        <KV k="IFSC" v={p.bank_ifsc} />
        <KV k="Name on account" v={p.bank_account_name} />
        <KV k="PF UAN" v={p.pf_uan} />
        <KV k="ESIC" v={p.esic_number} />
      </>}
      {(tier.comp || tier.self) && <>
        <div style={{ ...muted, marginTop: 8 }}>Previous employer {p.fy_label ? `(FY ${p.fy_label})` : ''}</div>
        <KV k="Taxable salary this FY outside XPayroll" v={p.cur_fy_taxable_outside != null ? fmtMoney(p.cur_fy_taxable_outside) : null} />
        <KV k="Exemptions this FY" v={p.cur_fy_exemptions != null ? fmtMoney(p.cur_fy_exemptions) : null} />
        <KV k="TDS this FY" v={p.cur_fy_tds != null ? fmtMoney(p.cur_fy_tds) : null} />
        <KV k="Past taxable salary" v={p.past_taxable_salary != null ? fmtMoney(p.past_taxable_salary) : null} />
        <KV k="Past TDS" v={p.past_tds != null ? fmtMoney(p.past_tds) : null} />
      </>}
    </div>
  );
}
