'use client';
// Shared pieces for the Hiring screens (openings + candidates). Presentation + the signed-upload
// helper; every gate is the worker's.
import { useState } from 'react';
import { supabase } from '@throttle/db';
import { FileText, UploadCloud, Briefcase } from 'lucide-react';
import { podiumopsPost } from '../lib/podiumopsFetch.js';
import { TONES, fmtDateTime, labelFrom, APP_STATUSES, OUTCOME_REASONS, MAX_UPLOAD_BYTES, JD_ACCEPT } from '../lib/hiring.js';

const DOC_BUCKET = 'podium-documents';

// Dot-pill in a semantic tone (StatusBadge look, hiring vocabularies).
export function ToneBadge({ tone = 'neutral', label }) {
  const m = TONES[tone] || TONES.neutral;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
      fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', padding: '3px 8px', borderRadius: 5,
      color: m.fg, background: m.bg, border: `1px solid ${m.bd}`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.fg }} />
      {label}
    </span>
  );
}
export function ListBadge({ list, status }) {
  const meta = list.find(x => x.id === status);
  return <ToneBadge tone={meta?.tone || 'neutral'} label={meta?.label || labelFrom(list, status)} />;
}

export function Card({ title, right, children, style }) {
  return (
    <div style={{ ...cardStyle, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={cardTitle}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
export function KV({ k, v }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 13 }}><span style={{ color: 'var(--text-3)' }}>{k}</span><span style={{ textAlign: 'right' }}>{v || '—'}</span></div>;
}
export function F({ label, children, style }) {
  return <label style={{ display: 'block', marginBottom: 10, flex: 1, minWidth: 0, ...style }}><div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>{label}</div>{children}</label>;
}
export function Row({ children }) { return <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{children}</div>; }
export function Note({ children, tone = 'warn' }) {
  const m = TONES[tone] || TONES.warn;
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: m.bg, color: m.fg, border: `1px solid ${m.bd}`, borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 12, marginBottom: 12 }}>{children}</div>;
}

// Timeline of application_events. `reason` is a category code; `detail.note` (free text) arrives only
// for viewers on the opening's salary chain — the worker strips it for everyone else.
export function Timeline({ events }) {
  const rows = events || [];
  if (rows.length === 0) return <div style={muted}>No activity yet.</div>;
  return (
    <div>
      {rows.map((ev, i) => (
        <div key={ev.id || i} style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 12.5 }}>
          <span style={{ color: 'var(--text-3)', fontSize: 11, minWidth: 130, flex: 'none' }}>{fmtDateTime(ev.created_at)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600 }}>{eventLabel(ev)}</span>
            {ev.reason && <span style={{ color: 'var(--text-2)' }}> — {labelFrom(OUTCOME_REASONS, ev.reason)}</span>}
            {ev.detail?.note && <span style={{ color: 'var(--text-2)' }}> · “{ev.detail.note}”</span>}
            {(ev.actor_name || ev.actor?.full_name) && <span style={{ color: 'var(--text-3)' }}> · {ev.actor_name || ev.actor.full_name}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
function eventLabel(ev) {
  const base = String(ev.event_type || 'event').replace(/_/g, ' ');
  if (ev.from_status || ev.to_status) {
    return `${base}: ${ev.from_status ? labelFrom(APP_STATUSES, ev.from_status) : '—'} → ${ev.to_status ? labelFrom(APP_STATUSES, ev.to_status) : '—'}`;
  }
  return base;
}

// Signed upload: worker mints {storage_path, token} → browser PUTs straight to the private bucket.
// Returns the metadata the record action needs.
export async function signedUpload(mintAction, mintBody, file, session) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File is over 15 MB');
  const { storage_path, token } = await podiumopsPost(mintAction, { ...mintBody, file_name: file.name }, session);
  if (!token) throw new Error('no upload token');
  const { error } = await supabase.storage.from(DOC_BUCKET).uploadToSignedUrl(storage_path, token, file);
  if (error) throw error;
  return { storage_path, file_name: file.name, mime_type: file.type || null, file_size: file.size || null };
}

// JD source picker: paste text, upload a PDF/DOCX, or use the job role's JD. Controlled:
// value = { mode: 'none'|'text'|'file'|'role', text, file }.
export function JdInput({ value, onChange, allowRole = true, allowNone = false, disabled }) {
  const v = value || { mode: allowNone ? 'none' : 'text', text: '', file: null };
  const set = (patch) => onChange({ ...v, ...patch });
  const modes = [
    ...(allowNone ? [{ id: 'none', label: 'Later', icon: null }] : []),
    { id: 'text', label: 'Paste', icon: FileText },
    { id: 'file', label: 'Upload', icon: UploadCloud },
    ...(allowRole ? [{ id: 'role', label: "Role's JD", icon: Briefcase }] : []),
  ];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {modes.map(m => {
          const on = v.mode === m.id; const Ic = m.icon;
          return (
            <button key={m.id} type="button" disabled={disabled} onClick={() => set({ mode: m.id })} style={{ ...segBtn, ...(on ? segOn : {}) }}>
              {Ic && <Ic size={13} />} {m.label}
            </button>
          );
        })}
      </div>
      {v.mode === 'text' && (
        <textarea rows={8} disabled={disabled} value={v.text || ''} onChange={e => set({ text: e.target.value })}
          placeholder="Paste the job description…" style={{ ...inp, resize: 'vertical' }} />
      )}
      {v.mode === 'file' && (
        <input type="file" accept={JD_ACCEPT} disabled={disabled} onChange={e => set({ file: e.target.files?.[0] || null })} style={{ fontSize: 12, color: 'var(--text-2)' }} />
      )}
      {v.mode === 'role' && <div style={muted}>The job role's current JD text is copied into this opening as a new version.</div>}
      {v.mode === 'none' && <div style={muted}>Without a JD the opening stays a draft and no CVs can be added.</div>}
    </div>
  );
}
// Whether a JdInput value carries a JD to submit.
export function jdProvided(v) {
  if (!v) return false;
  if (v.mode === 'text') return !!(v.text || '').trim();
  if (v.mode === 'file') return !!v.file;
  return v.mode === 'role';
}

// Add a JD version to an existing opening from a JdInput value (file → signed upload first).
export async function submitJd(openingId, v, session) {
  if (v.mode === 'file') {
    const meta = await signedUpload('createJdUploadUrl', { opening_id: openingId }, v.file, session);
    return podiumopsPost('addOpeningJd', { opening_id: openingId, ...meta }, session);
  }
  if (v.mode === 'role') return podiumopsPost('addOpeningJd', { opening_id: openingId, use_role_jd: true }, session);
  return podiumopsPost('addOpeningJd', { opening_id: openingId, jd_text: v.text.trim() }, session);
}

export const cardStyle ={ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '14px 16px' };
export const cardTitle = { fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
export const muted = { color: 'var(--text-3)', fontSize: 12 };
export const inp = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
export const comboInp = { fontFamily: 'var(--font-mono)', fontSize: 13, padding: '7px 10px' };
export const backBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontSize: 12, cursor: 'pointer' };
export const primaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-accent)', color: '#1f1f1f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 16px', fontWeight: 700, fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
export const ghostBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontSize: 12, cursor: 'pointer' };
export const dangerBtn = { ...ghostBtn, color: 'var(--state-error-fg)', borderColor: 'var(--state-error)' };
export const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', flex: 'none' };
const segBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 11px', fontSize: 12, cursor: 'pointer' };
const segOn = { background: 'var(--podium-accent)', color: '#1f1f1f', borderColor: 'var(--podium-accent)', fontWeight: 700 };
