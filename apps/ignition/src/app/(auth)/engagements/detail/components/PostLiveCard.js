'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { LockedNote, KV } from './shared.js';
import { TrackingLinkRow } from './TrackingLinkRow.js';

// Post-live card — the actual posting date is editable so already-live deals whose
// post_date was never captured can be back-dated; getMonthlyTargets attributes a
// video's views to its post_date month, so setting it makes those views count
// toward the target (Reann #bugs 2026-07-16). Video link / UTM stay read-only here.
export function PostLiveCard({ e, canEdit, locked, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [postDate, setPostDate] = useState('');
  // Locked (S373): the whole card is read-only, the tracking-link mint included.
  const editable = canEdit && !locked;
  const isEditing = editing && !locked;

  function startEdit() {
    setPostDate((e.post_date || '').slice(0, 10));
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      await ignitionopsPost('updateEngagement', {
        engagement_id: e.id,
        post_date: postDate === '' ? null : postDate,
      }, session);
      toast('Posting date updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Post-live</h2>
        {editable && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      {locked && <LockedNote />}
      <KV label="Expected post" value={e.expected_post_date || '—'} />
      {isEditing ? (
        <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'center' }}>
          <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Actual post</span>
          <input type="date" value={postDate} onChange={ev => setPostDate(ev.target.value)}
            style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
        </div>
      ) : (
        <KV label="Actual post" value={e.post_date || '—'} />
      )}
      <KV label="Video link" value={e.video_link ? <a href={e.video_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>{e.video_link.slice(0, 40)}…</a> : '—'} />
      <TrackingLinkRow e={e} canEdit={editable} session={session} onSaved={onSaved} />
      {isEditing && (
        <>
          <div style={{ fontSize: 10, color: 'var(--text-3)', margin: '8px 0 2px', lineHeight: 1.4 }}>
            Setting the posting date counts this video's views toward that month's target.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      )}
    </section>
  );
}
