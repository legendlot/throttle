'use client';
import { useEffect, useState } from 'react';
import { useToast } from '@throttle/ui';
import { Modal } from '../../../../../components/ui/Modal.js';
import { Banner } from '../../../../../components/ui/index.js';
import { ignitionopsGet, ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { Card, KV, miniBtn } from './shared.js';

// Deal contract (Reann #1). Sits beside the Shipping lock: the worker enforces everything here, this
// only says where the deal stands. Video deals only, and the page does not render it for partners.
const STATUS_WORDS = {
  sending: 'Sending',
  sent: 'Sent, waiting for the creator',
  accepted: 'Accepted by the creator',
  accepted_by_hand: 'Accepted, recorded by hand',
};
const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const ctl = { width: '100%', boxSizing: 'border-box', background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)', padding: '9px 12px', fontFamily: 'var(--font-ui)', fontSize: 14 };
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 };

export function ContractCard({ e, contract, canManage, canAdmin, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [sendOpen, setSendOpen] = useState(false);
  const [handOpen, setHandOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (contract === null) {
    return <Card title="Contract"><div style={{ fontSize: 14, color: 'var(--state-error-fg)' }}>Could not load the contract for this deal.</div></Card>;
  }
  if (!contract) return null;

  const c = contract;
  const published = !!c.settings_published;
  const hasContract = !!c.status;

  async function openInvoice(id) {
    try {
      const r = await ignitionopsGet('getDealInvoiceUrl', { id }, session);
      if (r?.url) window.open(r.url, '_blank', 'noopener');
    } catch (err) { toast(err.message, 'error'); }
  }
  async function allowBank() {
    if (!window.confirm('Let the creator change their bank details through their link for the next 7 days?')) return;
    setBusy(true);
    try {
      await ignitionopsPost('allowBankUpdate', { influencer_id: e.influencer_id, engagement_id: e.id }, session);
      toast('Open for 7 days', 'success');
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const bankOpen = c.bank_editable_until && Date.parse(c.bank_editable_until) > Date.now();
  return (
    <Card title="Contract">
      {!published && (
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
          The contract wording has not been published, so sending and the Shipping lock are off.{' '}
          {canAdmin && <a href="/admin/contract/" style={{ color: 'var(--accent-hi)' }}>Open the wording</a>}
        </div>
      )}
      {published && !c.required && !c.accepted && (
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 8 }}>This deal moved on before the lock, so it can ship without a contract.</div>
      )}
      <KV label="Status" value={STATUS_WORDS[c.status] || 'Not sent'} />
      {c.to_email && <KV label="Sent to" value={c.to_email} />}
      {c.sent_at && <KV label="Sent" value={`${fmt(c.sent_at)}${c.sent_by_name ? ` by ${c.sent_by_name}` : ''}`} />}
      {c.status === 'accepted' && <KV label="Accepted" value={fmt(c.accepted_at)} />}
      {c.status === 'accepted_by_hand' && (
        <KV label="Recorded" value={`${fmt(c.accepted_at)}${c.by_hand_by_name ? ` by ${c.by_hand_by_name}` : ''}: ${c.by_hand_reason || ''}`} />
      )}
      {c.last_failed && <KV label="Last send failed" value={<span style={{ color: 'var(--state-error-fg)' }}>{c.last_failed.error}</span>} />}
      {c.needs_payment && (
        <KV label="Bank" value={c.bank?.received
          ? `Received, ending ${c.bank.account_last4}${bankOpen ? ', open for changes' : ''}`
          : <span style={{ color: 'var(--text-4)' }}>Not yet</span>} />
      )}
      {c.needs_payment && (
        <KV label="Invoices" value={(c.invoices || []).length === 0
          ? <span style={{ color: 'var(--text-4)' }}>None yet</span>
          : (c.invoices.map(i => (
            <button key={i.id} type="button" onClick={() => openInvoice(i.id)} style={{ display: 'block', marginLeft: 'auto', background: 'none', border: 'none', padding: 0, color: 'var(--accent-hi)', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 14, textAlign: 'right', overflowWrap: 'anywhere' }}>{i.file_name}</button>
          )))} />
      )}
      {canManage && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button type="button" onClick={() => setSendOpen(true)} disabled={!published} className="ig-ghost-btn" style={{ ...miniBtn, opacity: published ? 1 : 0.5, cursor: published ? 'pointer' : 'not-allowed' }}>
            {hasContract ? 'Resend' : 'Send contract'}
          </button>
          {!c.accepted && <button type="button" onClick={() => setHandOpen(true)} className="ig-ghost-btn" style={miniBtn}>Mark accepted by hand</button>}
          {c.needs_payment && c.bank?.received && <button type="button" onClick={allowBank} disabled={busy} className="ig-ghost-btn" style={miniBtn}>Allow bank details update</button>}
        </div>
      )}
      {sendOpen && <SendModal e={e} accepted={c.resend_clears_acceptance} session={session} onClose={() => setSendOpen(false)} onSent={() => { setSendOpen(false); onSaved?.(); }} />}
      {handOpen && <HandModal e={e} session={session} onClose={() => setHandOpen(false)} onDone={() => { setHandOpen(false); onSaved?.(); }} />}
    </Card>
  );
}

function SendModal({ e, accepted, session, onClose, onSent }) {
  const { showToast: toast } = useToast();
  const [draft, setDraft] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [saveEmail, setSaveEmail] = useState(false);
  const [force, setForce] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Once per open: the modal is mounted fresh each time, and a token refresh must not overwrite edits.
  useEffect(() => {
    ignitionopsGet('getDealContractDraft', { engagement_id: e.id }, session)
      .then(d => { setDraft(d); setTo(d.to || ''); setSubject(d.subject || ''); setBody(d.body || ''); })
      .catch(err => setLoadErr(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.id]);

  // The email blocker follows what is typed in To, not the one on file: To is editable here, and the
  // worker re-checks the address actually being sent to.
  const onFileEmailBlocker = /email address/;
  const emailOk = /^[^\s@,;:<>()"'*\\]+@[^\s@,;:<>()"'*\\]+\.[a-z]{2,}$/i.test(to.trim());
  const blockers = (draft?.blockers || []).filter(b => !onFileEmailBlocker.test(b));
  if (draft && !emailOk) blockers.push('There is no valid email address to send this to.');
  const canSend = !!draft && blockers.length === 0 && subject.trim() && body.trim() && (!accepted || (force && note.trim()));

  async function send() {
    setBusy(true); setError('');
    try {
      await ignitionopsPost('sendDealContract', {
        engagement_id: e.id, to: to.trim(), subject, body, save_email: saveEmail,
        ...(accepted ? { force_resend: true, note: note.trim() } : {}),
      }, session);
      toast(`Contract sent to ${to.trim()}`, 'success');
      onSent();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open size="lg" title="Send contract" onClose={onClose} onConfirm={send} confirmLabel="Send"
      confirmDisabled={!canSend} loading={busy} error={error} dismissOnBackdrop={false}>
      {loadErr && <Banner tone="error" lead="Could not load the draft.">{loadErr}</Banner>}
      {!draft && !loadErr && <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading…</div>}
      {draft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {blockers.length > 0 && (
            <Banner tone="error" lead="This cannot be sent yet.">
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>{blockers.map(b => <li key={b}>{b}</li>)}</ul>
            </Banner>
          )}
          {(draft.warnings || []).length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--state-warning-fg)', lineHeight: 1.6 }}>
              {draft.warnings.map(w => <li key={w}>{w}</li>)}
            </ul>
          )}
          {accepted && (
            <Banner tone="warning" lead="This contract is already accepted.">
              Resending clears that, and the creator has to accept again before this deal can ship.
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <input type="checkbox" checked={force} onChange={ev => setForce(ev.target.checked)} /> Resend anyway
              </label>
              {force && <input value={note} onChange={ev => setNote(ev.target.value)} placeholder="Why? This goes in the history" style={{ ...ctl, marginTop: 8 }} />}
            </Banner>
          )}
          <div>
            <label style={lbl}>To</label>
            <input value={to} onChange={ev => setTo(ev.target.value)} style={ctl} autoComplete="off" />
            {to.trim() !== (draft.to || '') && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-2)', marginTop: 6 }}>
                <input type="checkbox" checked={saveEmail} onChange={ev => setSaveEmail(ev.target.checked)} /> Save this email on the influencer
              </label>
            )}
          </div>
          <div>
            <label style={lbl}>Subject</label>
            <input value={subject} onChange={ev => setSubject(ev.target.value)} style={ctl} />
          </div>
          <div>
            <label style={lbl}>Body</label>
            <textarea value={body} onChange={ev => setBody(ev.target.value)} rows={16} style={{ ...ctl, resize: 'vertical', lineHeight: 1.5 }} />
            <div style={{ fontSize: 12, color: 'var(--text-4)', marginTop: 4 }}>The accept link is added automatically below this text. It goes from partners@legendoftoys.com, and replies land there.</div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function HandModal({ e, session, onClose, onDone }) {
  const { showToast: toast } = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      await ignitionopsPost('markContractAcceptedByHand', { engagement_id: e.id, reason: reason.trim() }, session);
      toast('Acceptance recorded', 'success');
      onDone();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <Modal open title="Mark accepted by hand" onClose={onClose} onConfirm={save} confirmLabel="Record acceptance"
      confirmDisabled={!reason.trim()} loading={busy} error={error}>
      <label style={lbl}>Why? This goes in the history</label>
      <textarea value={reason} onChange={ev => setReason(ev.target.value)} rows={3} autoFocus style={{ ...ctl, resize: 'vertical' }}
        placeholder="e.g. Creator accepted over WhatsApp on 5 Nov" />
    </Modal>
  );
}
