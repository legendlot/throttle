'use client';
import { useState } from 'react';
import { Modal } from '@throttle/ui';
import { STAGE_LABELS, allowedTransitions, HAPPY_PATH } from '../lib/stages.js';

const fieldStyle = {
  width: '100%', marginTop: 6, padding: '8px 10px',
  background: 'var(--surface-2)', color: 'var(--text-1)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 13,
};
const lblStyle = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' };

export default function AdvanceModal({ open, engagement, onClose, onAdvance }) {
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [videoLink, setVideoLink] = useState('');
  const [postDate, setPostDate] = useState('');             // ② — required at live (non-UGC)
  const [trackChoice, setTrackChoice] = useState('on_track'); // on_track | delayed (#10)
  const [revisedDate, setRevisedDate] = useState('');
  const [rating, setRating] = useState('');                  // ⑤ — required at live
  const [ratingNotes, setRatingNotes] = useState('');
  const [shipOrderId, setShipOrderId] = useState('');        // #7 — required for shipped
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!engagement) return null;

  const isUgc          = engagement.engagement_type === 'ugc';
  const options = allowedTransitions(engagement.stage);
  const isLive         = target === 'live';                 // ⑤ terminal success (video)
  const needsVideoLink = isLive;                            // #4
  const isSchedule     = target === 'scheduled';            // #10
  const isShipped      = target === 'shipped';              // #7
  const existingLink   = (engagement.video_link || '').trim();
  const existingPost   = (engagement.post_date || '').toString().trim();
  const existingRating = (engagement.influencer?.quality_rating || '').trim();
  const isRated        = ['green', 'yellow', 'red'].includes(existingRating);
  const existingOrder  = (engagement.shipping_order_id || '').trim();
  const isDelayed      = isSchedule && trackChoice === 'delayed';

  // ② — a video post date is mandatory at go-live (drives monthly-target views);
  // only prompt when one isn't already on the deal. UGC uses live_at — exempt.
  const needsPostDate  = isLive && !isUgc && !existingPost;
  // ⑤ — going live requires a colour rating (video deals); only prompt if unrated.
  const needsRating    = isLive && !isUgc && !isRated;
  // #7 — only prompt for an order id when one isn't already on the deal.
  const needsOrderId   = isShipped && !existingOrder;

  // B11 — soft skip-stage warning (transitions are free by design; this only nudges).
  const _fromIdx = HAPPY_PATH.indexOf(engagement.stage);
  const _toIdx   = HAPPY_PATH.indexOf(target);
  const skipped  = (_fromIdx >= 0 && _toIdx > _fromIdx + 1) ? HAPPY_PATH.slice(_fromIdx + 1, _toIdx) : [];

  const missingVideo    = needsVideoLink && !(videoLink.trim() || existingLink);
  const missingPostDate = needsPostDate && !postDate;
  const missingRevised  = isDelayed && !revisedDate;
  const missingRating   = needsRating && !rating;
  const missingOrderId  = needsOrderId && !shipOrderId.trim();
  const canSubmit = !!target && !busy && !missingVideo && !missingPostDate && !missingRevised && !missingRating && !missingOrderId;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setErr('');
    try {
      let to_stage = target;
      let outNote = note;
      const extra = {};
      if (needsVideoLink) extra.video_link = (videoLink.trim() || existingLink);
      if (needsPostDate && postDate) extra.post_date = postDate;
      if (needsRating && rating) {
        extra.rating = rating;
        if (ratingNotes.trim()) extra.rating_notes = ratingNotes.trim();
      }
      if (needsOrderId && shipOrderId.trim()) extra.shipping_order_id = shipOrderId.trim();
      if (isDelayed) {
        // "Delayed" routes to the delayed stage with a revised post date; the
        // original is preserved in the history note (#10, no new column).
        to_stage = 'delayed';
        extra.expected_post_date = revisedDate;
        const orig = engagement.expected_post_date ? ` (was ${engagement.expected_post_date})` : '';
        outNote = `Delayed — revised post date ${revisedDate}${orig}${note ? ` — ${note}` : ''}`;
      }
      await onAdvance({ to_stage, note: outNote || undefined, ...extra });
      onClose();
    } catch (e) {
      // Surface the worker's guard reasons inline so the operator can fill in
      // the missing field and resubmit (mirrors the video-link prompt).
      const m = e?.message || '';
      if (/rating_required_for_live/.test(m)) setErr('Rate the influencer (green / yellow / red) to mark this live.');
      else if (/post_date_required_for_live/.test(m)) setErr('A video posting date is required to mark this live.');
      else if (/shipping_order_id_required_for_shipped/.test(m)) setErr('A Shopify order ID is required to mark this shipped.');
      else if (/video_link_required_for_live/.test(m)) setErr('A video link is required to mark this live.');
      else setErr(m || 'Could not advance');
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Advance ${engagement.engagement_no}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 360 }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          Current stage: <strong style={{ color: 'var(--text-1)' }}>{STAGE_LABELS[engagement.stage]}</strong>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Move to
          </label>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{
              width: '100%', marginTop: 6, padding: '8px 10px',
              background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 13,
            }}
          >
            <option value="">— select —</option>
            {options.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </div>

        {/* B11 — soft nudge when skipping happy-path stages (still allowed) */}
        {skipped.length > 0 && (
          <div style={{ fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid #fbbf24', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
            ⚠ Skipping {skipped.map(s => STAGE_LABELS[s] || s).join(', ')}. You can still advance if that&apos;s intended.
          </div>
        )}

        {/* #4 — going live requires a video link */}
        {needsVideoLink && (
          <div>
            <label style={lblStyle}>Video link *</label>
            <input
              value={videoLink || existingLink}
              onChange={(e) => setVideoLink(e.target.value)}
              placeholder="https://…"
              style={fieldStyle}
            />
            {missingVideo && <div style={{ fontSize: 11, color: 'var(--state-error-fg)', marginTop: 4 }}>Required to mark live</div>}
          </div>
        )}

        {/* ② — going live requires the video posting date (feeds the monthly target) */}
        {needsPostDate && (
          <div>
            <label style={lblStyle}>Video posting date *</label>
            <input type="date" value={postDate} onChange={(e) => setPostDate(e.target.value)} style={fieldStyle} />
            {missingPostDate
              ? <div style={{ fontSize: 11, color: 'var(--state-error-fg)', marginTop: 4 }}>Required to mark live — views count toward this month&apos;s target</div>
              : <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Views attribute to the month the video posted.</div>}
          </div>
        )}

        {/* ⑤ — going live requires a colour rating if not already rated */}
        {needsRating && (
          <div>
            <label style={lblStyle}>Rating *</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              {[['green', 'Green'], ['yellow', 'Yellow'], ['red', 'Red']].map(([v, label]) => {
                const on = rating === v;
                const color = v === 'green' ? '#4ade80' : v === 'yellow' ? '#fbbf24' : '#ff7070';
                return (
                  <button type="button" key={v} onClick={() => setRating(v)}
                    style={{
                      flex: 1, padding: '8px 10px', cursor: 'pointer',
                      background: on ? `${color}22` : 'var(--surface-2)',
                      color: on ? color : 'var(--text-2)',
                      border: `1px solid ${on ? color : 'var(--border)'}`,
                      borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: on ? 700 : 600,
                    }}>{label}</button>
                );
              })}
            </div>
            {missingRating && <div style={{ fontSize: 11, color: 'var(--state-error-fg)', marginTop: 4 }}>Required to mark live</div>}
            <input
              value={ratingNotes}
              onChange={(e) => setRatingNotes(e.target.value)}
              placeholder="Rating notes (optional)"
              style={{ ...fieldStyle, marginTop: 8 }}
            />
          </div>
        )}

        {/* #7 — marking shipped requires a Shopify order ID if none on the deal */}
        {needsOrderId && (
          <div>
            <label style={lblStyle}>Shopify order ID *</label>
            <input
              value={shipOrderId}
              onChange={(e) => setShipOrderId(e.target.value)}
              placeholder="e.g. #1234 or 1234"
              style={fieldStyle}
            />
            {missingOrderId && <div style={{ fontSize: 11, color: 'var(--state-error-fg)', marginTop: 4 }}>Required to mark shipped</div>}
          </div>
        )}

        {/* #10 — scheduling: confirm on-track vs delayed */}
        {isSchedule && (
          <div>
            <label style={lblStyle}>Is it on track?</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              {[['on_track', 'On track'], ['delayed', 'Delayed']].map(([v, label]) => {
                const on = trackChoice === v;
                return (
                  <button type="button" key={v} onClick={() => setTrackChoice(v)}
                    style={{
                      flex: 1, padding: '8px 10px', cursor: 'pointer',
                      background: on ? 'rgba(255,107,0,0.12)' : 'var(--surface-2)',
                      color: on ? '#FF6B00' : 'var(--text-2)',
                      border: `1px solid ${on ? '#FF6B00' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12,
                    }}>{label}</button>
                );
              })}
            </div>
            {isDelayed && (
              <div style={{ marginTop: 10 }}>
                <label style={lblStyle}>Revised post date *</label>
                <input type="date" value={revisedDate} onChange={(e) => setRevisedDate(e.target.value)} style={fieldStyle} />
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Moves the deal to <strong>Delayed</strong>; original date kept in history.</div>
              </div>
            )}
          </div>
        )}

        <div>
          <label style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Note (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            style={{
              width: '100%', marginTop: 6, padding: '8px 10px',
              background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 13, resize: 'vertical',
            }}
          />
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--state-error-fg)' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 14px', background: 'transparent', color: 'var(--text-2)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            style={{
              padding: '8px 14px', background: '#FF6B00', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.5,
            }}
          >{busy ? 'Advancing…' : 'Advance'}</button>
        </div>
      </div>
    </Modal>
  );
}
