'use client';
// F9 R3 — proposals (spec §4.5): "should be on the list and isn't". Anyone signed in proposes; the founders'
// Proposed queue accepts (a milestone — proposed or agreed — in a theme they pick) or declines with a reason
// the proposer sees. What comes back is decided by docket.plan_proposals_for: a proposer sees only their
// own, and an accepted item's code only when they can see the item.
import { useState } from 'react';
import { Combobox } from '@throttle/ui';
import { Check, X, Send, Lightbulb } from 'lucide-react';
import { docketopsPost } from '../../lib/docketopsFetch.js';
import { Button, Pill } from '../ui/index.js';
import { proposalFormError, proposalOutcome, planErrorText, fmtPlanDate, fmtPlanStamp, oneLine, PROPOSAL_KIND_LABEL } from '../../lib/plan.js';

const themeOpts = (themes) => themes.map(t => ({ value: t.id, label: `${t.code} · ${t.title}` }));
const STATUS_COLOR = { submitted: 'var(--st-blocked)', accepted: 'var(--st-done)', declined: 'var(--st-abandon)' };
const STATUS_LABEL = { submitted: 'Waiting', accepted: 'Accepted', declined: 'Declined' };

function Field({ label, children, hint }) {
  return <label className="pl-field"><span className="pl-lbl">{label}</span>{children}{hint && <small className="pl-hint">{hint}</small>}</label>;
}

// ── propose (anyone) ─────────────────────────────────────────────────────────
export function ProposeForm({ themes, session, showToast, onClose, onDone }) {
  const [f, setF] = useState({ title: '', why: '', kind_hint: 'milestone', suggested_theme_id: '', suggested_date: '' });
  const [busy, setBusy] = useState(false);
  const set = (p) => setF(x => ({ ...x, ...p }));
  const error = proposalFormError(f);
  async function send() {
    setBusy(true);
    try {
      const data = { title: f.title.trim(), why: f.why.trim(), kind_hint: f.kind_hint };
      if (f.suggested_theme_id) data.suggested_theme_id = f.suggested_theme_id;
      if (f.suggested_date) data.suggested_date = f.suggested_date;
      await docketopsPost('proposePlanItem', { data }, session);
      showToast('Proposal sent to the founders', 'success');
      onDone();
    } catch (e) { showToast(planErrorText(e), 'error'); }
    finally { setBusy(false); }
  }
  return (
    <>
      <div className="pl-panel-head">
        <span className="pl-panel-kind">Propose</span>
        <span className="pl-panel-sp">something that should be on the plan</span>
        <button type="button" className="pl-x" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="pl-panel-body">
        <Field label="What *"><input className="pl-input" autoFocus maxLength={200} value={f.title} onChange={e => set({ title: e.target.value })} /></Field>
        <Field label="Why it matters *" hint="The founders read this when they decide."><textarea className="pl-input pl-ta" maxLength={2000} value={f.why} onChange={e => set({ why: e.target.value })} /></Field>
        <Field label="It is a…">
          <select className="pl-input" value={f.kind_hint} onChange={e => set({ kind_hint: e.target.value })}>
            <option value="milestone">Milestone — something to deliver</option>
            <option value="risk">Risk — something that could go wrong</option>
          </select>
        </Field>
        {themes.length > 0 && <Field label="Theme (optional)">
          <Combobox value={f.suggested_theme_id} options={themeOpts(themes)} placeholder="Pick a theme…" allowClear portal
            onChange={v => set({ suggested_theme_id: v || '' })} style={{ width: '100%' }} />
        </Field>}
        <Field label="By when (optional)"><input type="date" className="pl-input" value={f.suggested_date} onChange={e => set({ suggested_date: e.target.value })} /></Field>
        <p className="pl-hint">You’ll see whether it was accepted or declined (and why) under “My proposals”.</p>
      </div>
      <div className="pl-panel-foot">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" icon={Send} loading={busy} disabled={!!error} onClick={send}>Send proposal</Button>
      </div>
    </>
  );
}

// ── decide (super admin) ─────────────────────────────────────────────────────
export function ProposalView({ proposal: p, themes, ownerOpts, session, showToast, onClose, onDone }) {
  const [mode, setMode] = useState(null);   // 'accept' | 'decline'
  const [f, setF] = useState({ title: p.title, theme_id: p.suggested_theme_id || '', owner_employee_id: p.suggested_owner_employee_id || '',
    due_date: p.suggested_date || '', done_when: '', state: 'proposed', note: '', create: p.kind_hint !== 'risk' });
  const [busy, setBusy] = useState(false);
  const set = (x) => setF(o => ({ ...o, ...x }));
  const decidable = p.status === 'submitted';
  const creates = mode === 'accept' && f.create;
  const ready = mode === 'decline' ? !!f.note.trim()
    : creates ? !!(f.theme_id && f.owner_employee_id && f.title.trim() && (f.state === 'proposed' || (f.due_date && f.done_when.trim())))
    : mode === 'accept' ? !!f.note.trim() : false;

  async function decide() {
    const data = { id: p.id, decision: mode, note: f.note.trim() || undefined };
    if (creates) Object.assign(data, { theme_id: f.theme_id, owner_employee_id: f.owner_employee_id, title: f.title.trim(),
      due_date: f.due_date || undefined, done_when: f.done_when.trim() || undefined, state: f.state });
    setBusy(true);
    try {
      const res = await docketopsPost('decideProposal', data, session);
      showToast(mode === 'decline' ? 'Declined — the proposer sees your reason' : `Accepted${res?.item_code ? ` as ${res.item_code}` : ''}`, 'success');
      onDone(res?.item_id || null);
    } catch (e) { showToast(planErrorText(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="pl-panel-head">
        <span className="pl-panel-kind">Proposal</span>
        <span className="pl-panel-sp"><Pill tone="status" color={STATUS_COLOR[p.status]}>{STATUS_LABEL[p.status] || p.status}</Pill>
          <Pill>{PROPOSAL_KIND_LABEL[p.kind_hint] || p.kind_hint}</Pill></span>
        <button type="button" className="pl-x" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="pl-panel-body">
        <Field label="What"><div className="pl-read">{p.title}</div></Field>
        <Field label="Why"><div className="pl-read">{p.why}</div></Field>
        <Field label="From"><div className="pl-read">{p.proposer_name || 'Someone'} · {fmtPlanStamp(p.created_at)} IST</div></Field>
        {(p.suggested_theme_title || p.suggested_owner_name || p.suggested_date) && (
          <Field label="Suggested"><div className="pl-read">{[p.suggested_theme_title, p.suggested_owner_name, p.suggested_date && fmtPlanDate(p.suggested_date)].filter(Boolean).join(' · ')}</div></Field>
        )}
        {!decidable && <Field label="Outcome"><div className="pl-read">{proposalOutcome(p)}{p.decided_by_name ? ` — ${p.decided_by_name}` : ''}</div></Field>}

        {decidable && (
          <div className="pl-acts">
            <div className="pl-acts-row">
              <Button size="sm" variant="neutral" icon={Check} aria-pressed={mode === 'accept'} onClick={() => setMode(mode === 'accept' ? null : 'accept')}>Accept</Button>
              <Button size="sm" variant="danger" aria-pressed={mode === 'decline'} onClick={() => setMode(mode === 'decline' ? null : 'decline')}>Decline</Button>
            </div>
            {mode && (
              <div className="pl-op">
                {mode === 'accept' && p.kind_hint === 'risk' && (
                  <label className="pl-check"><input type="checkbox" checked={f.create} onChange={e => set({ create: e.target.checked })} />
                    Create a milestone for it (otherwise it is noted, and a note is required)</label>
                )}
                {creates && <>
                  <Field label="Theme *"><Combobox value={f.theme_id} options={themeOpts(themes)} placeholder="Pick a theme…" allowClear={false} portal
                    onChange={v => set({ theme_id: v || '' })} style={{ width: '100%' }} /></Field>
                  <Field label="Milestone title *"><input className="pl-input" value={f.title} onChange={e => set({ title: e.target.value })} /></Field>
                  <Field label="Owner *"><Combobox value={f.owner_employee_id} options={ownerOpts} placeholder="Pick a person…" allowClear={false} portal
                    onChange={v => set({ owner_employee_id: v || '' })} style={{ width: '100%' }} /></Field>
                  <Field label={f.state === 'agreed' ? 'Due date * (locks on agree)' : 'Due date'}><input type="date" className="pl-input" value={f.due_date} onChange={e => set({ due_date: e.target.value })} /></Field>
                  <Field label={f.state === 'agreed' ? 'Done when *' : 'Done when'}><textarea className="pl-input pl-ta" value={f.done_when} onChange={e => set({ done_when: e.target.value })} /></Field>
                  <label className="pl-check"><input type="checkbox" checked={f.state === 'agreed'} onChange={e => set({ state: e.target.checked ? 'agreed' : 'proposed' })} />
                    Agreed now (the due date locks)</label>
                </>}
                <Field label={mode === 'decline' ? 'Reason * (the proposer sees it)' : creates ? 'Note (optional, founders only)' : 'Note *'}>
                  <textarea className="pl-input pl-ta" value={f.note} onChange={e => set({ note: e.target.value })} />
                </Field>
                <div className="pl-save">
                  <Button variant="ghost" size="sm" onClick={() => setMode(null)} disabled={busy}>Cancel</Button>
                  <Button variant={mode === 'decline' ? 'danger' : 'primary'} size="sm" loading={busy} disabled={!ready} onClick={decide}>
                    {mode === 'decline' ? 'Decline' : creates ? 'Accept and create' : 'Accept'}</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── the /plan sections ───────────────────────────────────────────────────────
function ProposalRow({ p, onOpen, showFrom }) {
  return (
    <div className="pl-row pl-prop" role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? () => onOpen(p) : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(p); } } : undefined}>
      <div className="pl-row-main">
        <div className="pl-row-l1"><span className="pl-row-t">{p.title}</span></div>
        <div className="pl-row-sub">{showFrom ? `${p.proposer_name || 'Someone'} · ${oneLine(p.why, 90)}` : proposalOutcome(p)}</div>
      </div>
      <Pill>{PROPOSAL_KIND_LABEL[p.kind_hint] || p.kind_hint}</Pill>
      <Pill tone="status" color={STATUS_COLOR[p.status]}>{STATUS_LABEL[p.status] || p.status}</Pill>
    </div>
  );
}

// Super admins: the Proposed queue (submitted first, then the last 30 days' decisions). Everyone: My proposals.
export function ProposalSections({ proposals, isSuper, onOpen }) {
  const list = proposals || [];
  const mine = list.filter(p => p.mine);
  const queue = isSuper ? list : [];
  const waiting = queue.filter(p => p.status === 'submitted');
  const decided = queue.filter(p => p.status !== 'submitted');
  return (
    <>
      {isSuper && (
        <section className="pl-theme">
          <div className="pl-theme-t"><Lightbulb size={13} aria-hidden /> Proposed {waiting.length > 0 && <span className="pl-count">{waiting.length}</span>}</div>
          {waiting.length === 0 && <div className="pl-none">Nothing waiting.</div>}
          {waiting.map(p => <ProposalRow key={p.id} p={p} onOpen={onOpen} showFrom />)}
          {decided.length > 0 && <div className="pl-none">Decided in the last 30 days</div>}
          {decided.map(p => <ProposalRow key={p.id} p={p} onOpen={onOpen} showFrom />)}
        </section>
      )}
      {!isSuper && mine.length > 0 && (
        <section className="pl-theme">
          <div className="pl-theme-t">My proposals</div>
          {mine.map(p => <ProposalRow key={p.id} p={p} />)}
        </section>
      )}
    </>
  );
}
