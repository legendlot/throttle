'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { istToday } from '../../../../../lib/istDate.js';
import { Card, LockedNote, KV } from './shared.js';
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

  // README §Engagement detail: an expected date that has passed with nothing posted reads red.
  // String compare is safe — both are YYYY-MM-DD, and today is the IST calendar day.
  const expected = (e.expected_post_date || '').slice(0, 10);
  const overdue = !!expected && !e.post_date && expected < istToday();

  return (
    <Card title="Post-live" action={editable && !editing ? 'Edit' : null} onAction={startEdit}>
      {locked && <LockedNote />}
      <KV label="Expected post" value={expected
        ? <span title={overdue ? 'Overdue — nothing posted yet' : undefined} style={{ fontFamily: 'var(--font-mono)', color: overdue ? 'var(--state-error-fg)' : 'var(--text-1)' }}>{e.expected_post_date}</span>
        : '—'} />
      {isEditing ? (
        <div style={editRow}>
          <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>Actual post</span>
          <input type="date" value={postDate} onChange={ev => setPostDate(ev.target.value)} style={inp} />
        </div>
      ) : (
        <KV label="Actual post" value={e.post_date ? <span style={{ fontFamily: 'var(--font-mono)' }}>{e.post_date}</span> : '—'} />
      )}
      <KV label="Video link" value={e.video_link ? <a href={e.video_link} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-hi)' }}>{e.video_link.slice(0, 40)}… ↗</a> : '—'} />
      <TrackingLinkRow e={e} canEdit={editable} session={session} onSaved={onSaved} />
      {isEditing && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-4)', margin: '8px 0 2px', lineHeight: 1.45 }}>
            Setting the posting date counts this video's views toward that month's target.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={() => setEditing(false)} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ ...primaryBtn, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      )}
    </Card>
  );
}

const editRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '7px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 };
const inp = { width: '100%', maxWidth: 200, boxSizing: 'border-box', background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const primaryBtn = { height: 36, padding: '0 16px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700 };
const ghostBtn = { height: 36, padding: '0 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
