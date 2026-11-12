'use client';
// C4 — bulk CV import UI pieces. The worker owns every rule; this only shows and edits the draft.
import { useState } from 'react';
import { ExternalLink, Check, SkipForward, Link2, Save } from 'lucide-react';
import { ToneBadge, inp, primaryBtn, ghostBtn, muted, F } from './HiringBits.js';
import { hiringError } from '../lib/hiring.js';

export function errText(e) { return e?.body?.message || hiringError(e); }

export const ITEM_STATUS = {
  uploaded:     { label: 'Waiting',       tone: 'neutral' },
  extracting:   { label: 'Reading…',      tone: 'info' },
  extracted:    { label: 'Check & accept', tone: 'warn' },
  needs_manual: { label: 'Enter by hand', tone: 'bad' },
  accepting:    { label: 'Saving…',       tone: 'info' },
  accepted:     { label: 'Accepted',      tone: 'ok' },
  skipped:      { label: 'Skipped',       tone: 'neutral' },
};

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export function AiSpendLine({ spend, ready }) {
  if (!ready) return <span style={{ ...muted, color: 'var(--bad-fg)' }}>AI reading not set up — CVs go to manual entry</span>;
  if (spend && spend.enabled === false) return <span style={muted}>AI reading is switched off</span>;
  return <span style={muted}>AI this month: {inr(spend?.spent_inr)} of {inr(spend?.cap_inr)} · {spend?.calls || 0} reads</span>;
}

// Fields shown per CV. CTC rows only when the caller may see salary on the opening.
const FIELDS = [
  ['full_name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['location', 'Location'],
  ['current_employer', 'Current employer'], ['current_title', 'Current title'],
  ['total_experience_years', 'Experience (yrs)', 'num'], ['notice_period_days', 'Notice (days)', 'num'],
  ['education', 'Education', 'wide'], ['linkedin_url', 'LinkedIn', 'wide'], ['skills', 'Skills (comma-separated)', 'wide'],
];
const CTC_FIELDS = [['current_ctc', 'Current CTC (₹/yr)', 'num'], ['expected_ctc', 'Expected CTC (₹/yr)', 'num']];

export function draftOf(item) {
  const d = { ...(item.extracted?.fields || {}), ...(item.final || {}) };
  return { ...d, skills: Array.isArray(d.skills) ? d.skills.join(', ') : (d.skills || '') };
}
export function draftPayload(d) {
  const out = { ...d };
  out.skills = String(d.skills || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const k of ['total_experience_years', 'notice_period_days', 'current_ctc', 'expected_ctc']) {
    if (k in out) out[k] = out[k] === '' || out[k] == null ? null : Number(out[k]);
  }
  return out;
}

// One CV: status, warnings, the editable fields, and the actions.
export function CvItemCard({ item, draft, onDraft, canSeeSalary, matches, batchDupe, busy, onOpen, onSave, onAccept, onAttach, onSkip }) {
  const st = ITEM_STATUS[item.status] || { label: item.status, tone: 'neutral' };
  const editable = ['extracted', 'needs_manual'].includes(item.status);
  const fields = canSeeSalary ? [...FIELDS, ...CTC_FIELDS] : FIELDS;
  const ev = item.extracted?.evidence || {};
  const [attachId, setAttachId] = useState('');
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px 14px', background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ToneBadge tone={st.tone} label={st.label} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{draft?.full_name || item.file_name}</span>
        <button onClick={onOpen} style={{ ...ghostBtn, padding: '3px 8px' }} title="Open the CV"><ExternalLink size={12} /> {item.file_name}</button>
        {item.extract_mode && item.extract_mode !== 'text' && <span style={muted}>{{ file: 'read from scan', image: 'read from image', cache: 'same file read before', manual: '' }[item.extract_mode]}</span>}
        <span style={{ flex: 1 }} />
        {item.status === 'accepted' && item.candidate_id && <a href={`/hiring/detail/?id=${item.candidate_id}`} style={{ fontSize: 12 }}>Open candidate →</a>}
      </div>

      {item.last_error && item.status !== 'accepted' && <div style={{ ...muted, color: 'var(--bad-fg)', marginTop: 6 }}>{item.last_error}</div>}
      {!!item.warnings?.length && editable && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--warn-fg)' }}>
          {item.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {batchDupe && editable && <div style={{ fontSize: 12, marginTop: 6, color: 'var(--warn-fg)' }}>Looks like the same person as another CV in this batch ({batchDupe}).</div>}
      {!!matches?.length && editable && (
        <div style={{ fontSize: 12, marginTop: 6 }}>
          Already in Podium: {matches.map(m => <a key={m.id} href={`/hiring/detail/?id=${m.id}`} style={{ marginRight: 8 }}>{m.full_name} ({m.candidate_code})</a>)}
        </div>
      )}

      {editable && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8, marginTop: 10 }}>
            {fields.map(([k, label, kind]) => (
              <F key={k} label={label} style={kind === 'wide' ? { gridColumn: '1 / -1' } : undefined}>
                <input value={draft?.[k] ?? ''} type={kind === 'num' ? 'number' : 'text'} style={inp}
                  onChange={e => onDraft({ ...draft, [k]: e.target.value })} />
                {k === 'total_experience_years' && ev.experience && <div style={evStyle}>“{ev.experience}”</div>}
                {k === 'notice_period_days' && ev.notice && <div style={evStyle}>“{ev.notice}”</div>}
                {k === 'current_ctc' && ev.current_ctc && <div style={evStyle}>“{ev.current_ctc}”</div>}
                {k === 'expected_ctc' && ev.expected_ctc && <div style={evStyle}>“{ev.expected_ctc}”</div>}
              </F>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button disabled={busy} onClick={onAccept} style={primaryBtn}><Check size={13} /> Accept as new candidate</button>
            {!!matches?.length && (
              <>
                <select value={attachId} onChange={e => setAttachId(e.target.value)} style={{ ...inp, width: 220 }}>
                  <option value="">Attach to existing…</option>
                  {matches.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.candidate_code})</option>)}
                </select>
                <button disabled={busy || !attachId} onClick={() => onAttach(attachId)} style={ghostBtn}><Link2 size={13} /> Attach</button>
              </>
            )}
            <button disabled={busy} onClick={onSave} style={ghostBtn}><Save size={13} /> Save</button>
            <button disabled={busy} onClick={onSkip} style={ghostBtn}><SkipForward size={13} /> Skip</button>
          </div>
        </>
      )}
      {item.status === 'uploaded' && item.last_error && <div style={muted}>Will try again shortly.</div>}
    </div>
  );
}

const evStyle = { fontSize: 11, color: 'var(--text-3)', marginTop: 3, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
