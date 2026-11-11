'use client';
// Hiring C3 — offer letter pieces shared by the offer form, the offer page and the template admin.
// The letter text + annexure arrive already rendered by the worker (src/offer-render.js renderOfferText),
// so the preview here is the same content the PDF prints. Presentation only; every gate is the worker's.
import { ToneBadge, muted } from './HiringBits.js';
import { BAND_CHECKS, OFFER_STATUSES, labelFrom } from '../lib/hiring.js';

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
