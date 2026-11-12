'use client';
// Hiring C3 — offer letter pieces shared by the offer form, the offer page and the template admin.
// The letter text + annexure arrive already rendered by the worker (src/offer-render.js renderOfferText),
// so the preview here is the same content the PDF prints. Presentation only; every gate is the worker's.
import { ToneBadge, Card, KV, muted, ghostBtn } from './HiringBits.js';
import { BAND_CHECKS, OFFER_STATUSES, labelFrom, fmtDateTime } from '../lib/hiring.js';
import { fmtDate } from '../lib/format.js';
import { joiningRows, bankView, emailChecking, docTypeLabel } from '../lib/offerLink.js';

export function OfferStatusBadge({ status }) {
  const m = OFFER_STATUSES.find(s => s.id === status);
  return <ToneBadge tone={m?.tone || 'neutral'} label={m?.label || labelFrom(OFFER_STATUSES, status)} />;
}
export function BandCheckBadge({ check }) {
  if (!check) return null;
  const m = BAND_CHECKS.find(s => s.id === check);
  return <ToneBadge tone={m?.tone || 'neutral'} label={m?.label || check} />;
}

const WARNING_COPY = {
  pt_state_unknown: "No Professional Tax rule for the opening's work state — PT is shown as 0",
  pt_rule_unknown: 'The Professional Tax rule for this state is not understood — PT is shown as 0',
  headcount_full: 'Accepted offers now fill the opening\'s headcount',
  headcount_exceeded: 'Accepted offers now exceed the opening\'s headcount',
};
export function warningText(w) { return WARNING_COPY[w] || String(w).replace(/_/g, ' '); }

// The letter (renderOfferText view): letterhead, title, paragraphs, closing, footer.
export function LetterPreview({ view }) {
  if (!view) return null;
  const lh = view.letterhead || {};
  return (
    <div style={paper}>
      <div style={{ textAlign: 'right', marginBottom: 18 }}>
        {lh.entity_name && <div style={{ fontWeight: 700, fontSize: 13 }}>{lh.entity_name}</div>}
        {(lh.address_lines || []).map((l, i) => <div key={i} style={{ fontSize: 11.5, color: '#666' }}>{l}</div>)}
        {lh.phone && <div style={{ fontSize: 11.5, color: '#666' }}>{lh.phone}</div>}
      </div>
      <div style={{ textAlign: 'center', fontSize: 17, fontWeight: 600, marginBottom: 16 }}>{view.title}</div>
      {(view.paragraphs || []).map((p, i) => (
        <p key={i} style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.55 }}>
          {p.map((l, j) => <span key={j}>{j > 0 && <br />}{l}</span>)}
        </p>
      ))}
      <div style={{ marginTop: 14, fontSize: 13 }}>
        <div>{view.closing?.salutation}</div>
        {view.closing?.name && <div style={{ fontWeight: 700 }}>{view.closing.name}</div>}
        {view.closing?.title && <div style={{ color: '#666', fontSize: 12 }}>{view.closing.title}</div>}
      </div>
      {view.footer && <div style={{ textAlign: 'center', fontSize: 10.5, color: '#888', marginTop: 20 }}>{view.footer}</div>}
    </div>
  );
}

// Annexure I (renderOfferText view.annexure): table + notes + deductions → in-hand.
export function AnnexureTable({ annexure }) {
  if (!annexure) return null;
  const strong = (k) => k === 'subtotal' || k === 'total';
  return (
    <div style={paper}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>{annexure.heading}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr>{(annexure.columns || []).map((c, i) => <th key={i} style={{ ...th, textAlign: i ? 'right' : 'left' }}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {(annexure.rows || []).map((r, i) => (
            <tr key={i} style={{ fontWeight: strong(r.kind) ? 700 : 400, borderTop: r.kind === 'total' ? '1px solid #bbb' : 'none' }}>
              {r.cells.map((c, j) => <td key={j} style={{ ...td, textAlign: j ? 'right' : 'left' }} className={j ? 'num' : undefined}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {(annexure.notes || []).map((n, i) => <div key={i} style={{ fontSize: 11.5, color: '#666', marginTop: i ? 2 : 8 }}>{n}</div>)}
      {(annexure.deductions?.length > 0 || annexure.in_hand) && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Deductions and estimated monthly in-hand</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              {(annexure.deductions || []).map((d, i) => (
                <tr key={i}><td style={td}>{d.label}</td><td style={{ ...td, textAlign: 'right' }} className="num">{d.value}</td></tr>
              ))}
              {annexure.in_hand && (
                <tr style={{ fontWeight: 700, borderTop: '1px solid #bbb' }}>
                  <td style={td}>{annexure.in_hand.label}</td><td style={{ ...td, textAlign: 'right' }} className="num">{annexure.in_hand.value}</td>
                </tr>
              )}
            </tbody>
          </table>
          {annexure.in_hand?.note && <div style={{ fontSize: 11.5, color: '#666', marginTop: 4 }}>{annexure.in_hand.note}</div>}
        </div>
      )}
    </div>
  );
}

export function Warnings({ list }) {
  if (!list?.length) return null;
  return <div style={{ ...muted, color: 'var(--warn-fg)', marginTop: 6 }}>{list.map(warningText).join(' · ')}</div>;
}

// Letter paper: light, like the PDF, in both themes.
const paper = { background: '#fcfcfa', color: '#1a1a1a', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '22px 26px', fontFamily: 'Helvetica, Arial, sans-serif' };
const th = { padding: '5px 4px', borderBottom: '1px solid #bbb', fontWeight: 700 };
const td = { padding: '4px 4px' };

// ── Podium O1: the offer link, as the staff see it. Field names (getOffer.emails/responses/acceptance/
// joining/bank) are read here and in lib/offerLink.js only. ──
const EMAIL_TONE = { sent: 'ok', failed: 'bad', sending: 'warn', unknown: 'warn' };
const KIND_LABEL = { offer: 'Offer', confirmation: 'Confirmation', alert: 'Alert' };
export const RESPONSE_KIND = { decline: 'Declined', question: 'Question', accept_blocked: 'Accept blocked (headcount full)' };

export function EmailsCard({ emails }) {
  const rows = emails || [];
  if (!rows.length) return null;
  return (
    <Card title="Emails">
      {rows.map((e, i) => (
        <div key={e.id || i} style={{ padding: '7px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 12.5 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{KIND_LABEL[e.kind] || e.kind}</b>
            <ToneBadge tone={EMAIL_TONE[e.status] || 'neutral'} label={emailChecking(e) ? 'checking…' : e.status} />
            {e.kind === 'offer' && e.has_link && <span style={muted}>{e.link_live ? 'link live' : 'link closed'}</span>}
            <span style={{ ...muted, marginLeft: 'auto' }}>{fmtDateTime(e.sent_at || e.created_at)}</span>
          </div>
          <div style={muted}>to {e.to_email}{e.cc_emails?.length ? ` · cc ${e.cc_emails.join(', ')}` : ''}</div>
          {e.error && <div style={{ color: 'var(--bad-fg)', fontSize: 11.5 }}>{e.error}</div>}
        </div>
      ))}
    </Card>
  );
}

export function ResponsesCard({ responses, canManage, onSeen, busy }) {
  const rows = responses || [];
  if (!rows.length) return null;
  return (
    <Card title="Candidate responses">
      {rows.map((r, i) => (
        <div key={r.id || i} style={{ padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 12.5 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{RESPONSE_KIND[r.kind] || r.kind}</b>
            {r.reason && <span style={muted}>{String(r.reason).replace(/_/g, ' ')}</span>}
            <span style={{ ...muted, marginLeft: 'auto' }}>{fmtDateTime(r.created_at)}</span>
          </div>
          {r.text && <div style={{ marginTop: 3, whiteSpace: 'pre-wrap' }}>{r.text}</div>}
          {r.proposed_join_date && <div style={muted}>Proposed joining date: {fmtDate(r.proposed_join_date)}</div>}
          <div style={{ marginTop: 5 }}>
            {r.seen_at ? <span style={muted}>Seen {fmtDateTime(r.seen_at)}</span>
              : canManage && <button style={{ ...ghostBtn, padding: '4px 10px' }} disabled={busy} onClick={() => onSeen(r.id)}>Mark seen</button>}
          </div>
        </div>
      ))}
    </Card>
  );
}

export function AcceptanceCard({ acceptance }) {
  if (!acceptance) return null;
  const a = acceptance;
  return (
    <Card title="Acceptance evidence">
      <KV k="Typed name" v={a.typed_name} />
      <KV k="Accepted at" v={a.accepted_at ? fmtDateTime(a.accepted_at) : null} />
      <KV k="Confirmed joining" v={a.confirmed_join_date ? fmtDate(a.confirmed_join_date) : null} />
      <KV k="IP" v={a.ip} />
      {a.user_agent && <div style={{ ...muted, marginTop: 4, wordBreak: 'break-all', fontSize: 10.5 }}>{a.user_agent}</div>}
    </Card>
  );
}

export function JoiningCard({ joining, canVerify, onVerify, busy }) {
  const rows = joiningRows(joining);
  if (!rows.some(r => r.uploaded)) return null;
  return (
    <Card title="Joining documents">
      {rows.map((r, i) => (
        <div key={r.doc_type} style={{ padding: '6px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 12.5 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ color: r.uploaded ? (r.verified ? 'var(--green-bright)' : 'var(--text-2)') : 'var(--text-3)', width: 16 }}>{r.uploaded ? '✓' : '○'}</span>
            <span style={{ flex: 1 }}>{r.label}{r.required && <span style={{ color: 'var(--bad-fg)' }}> *</span>}</span>
            <span style={muted}>{!r.uploaded ? 'missing' : r.verified ? 'verified' : `${r.count} uploaded`}</span>
          </div>
          {r.docs.map(d => (
            <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: 24, marginTop: 3 }}>
              <span style={{ ...muted, flex: 1, minWidth: 0 }}>{d.title || d.file_name || docTypeLabel(r.doc_type)}{(d.verified || d.verified_at) ? ' · verified' : ''}</span>
              {canVerify && d.id && <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11 }} disabled={busy}
                onClick={() => onVerify(d.id, !(d.verified || d.verified_at))}>{(d.verified || d.verified_at) ? 'Unverify' : 'Verify'}</button>}
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

export function BankCard({ bank, revealed, canAllow, canReveal, onAllow, onReveal, onHide, busy }) {
  const b = bankView(bank);
  if (!b) return null;
  return (
    <Card title="Bank details (from the candidate)">
      <KV k="Account name" v={b.name} />
      <KV k="Bank" v={b.bank} />
      <KV k="Account" v={<span style={{ fontFamily: 'var(--font-mono)' }}>{revealed || b.account}</span>} />
      <KV k="IFSC" v={b.ifsc} />
      <div style={{ ...muted, marginTop: 4 }}>{b.editable ? 'The candidate may change these once.' : 'Locked — the candidate cannot change these.'}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {canAllow && !b.editable && <button style={ghostBtn} disabled={busy} onClick={onAllow}>Allow update</button>}
        {canReveal && (revealed
          ? <button style={ghostBtn} onClick={onHide}>Hide</button>
          : <button style={ghostBtn} disabled={busy} onClick={onReveal}>Reveal</button>)}
      </div>
    </Card>
  );
}
