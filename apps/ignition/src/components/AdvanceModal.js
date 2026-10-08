'use client';
import { useEffect, useState } from 'react';
import { Modal } from './ui/Modal.js';
import { Banner } from './ui/Banner.js';
import { StagePill } from './ui/StagePill.js';
import { RATING_COLORS } from './ui/RatingDot.js';
import { STAGE_LABELS, STAGE_PALETTE, allowedTransitions, HAPPY_PATH } from '../lib/stages.js';
import { UGC_STAGE_VALUES, UGC_STAGE_LABELS, UGC_STAGE_PALETTE, UGC_HAPPY_PATH } from '../lib/ugcStages.js';

const fieldStyle = {
  width: '100%', marginTop: 6, height: 40, padding: '0 12px',
  background: 'var(--input)', color: 'var(--text-1)',
  border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)',
  fontFamily: 'var(--font-ui)', fontSize: 14,
};
const lblStyle = { fontSize: 12, fontWeight: 600, color: 'var(--text-3)' };
const errLine = { fontSize: 12, color: 'var(--state-error-fg)', marginTop: 4 };
const hintLine = { fontSize: 12, color: 'var(--text-4)', marginTop: 4 };
const ghostBtn = { height: 40, padding: '0 16px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const primaryBtn = { height: 40, padding: '0 18px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700 };
const choiceBtn = (on, color) => ({
  flex: 1, height: 40, padding: '0 10px', cursor: 'pointer',
  background: on ? `${color}22` : 'transparent',
  color: on ? color : 'var(--text-2)',
  border: `1px solid ${on ? color : 'var(--border-3)'}`,
  borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: on ? 700 : 600,
});

export default function AdvanceModal({ open, engagement, onClose, onAdvance }) {
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [videoLink, setVideoLink] = useState('');
  const [postDate, setPostDate] = useState('');             // ② — required at live (non-UGC)
  const [trackChoice, setTrackChoice] = useState('on_track'); // on_track | delayed (#10)
  const [revisedDate, setRevisedDate] = useState('');
  const [rating, setRating] = useState('');                  // ⑤ — required at live
  const [ratingNotes, setRatingNotes] = useState('');
  const [shipOrderId, setShipOrderId] = useState('');        // #7 — required for shipped (video deals)
  const [trackUrl, setTrackUrl] = useState('');              // C1 #2 — required for shipped (UGC)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Step 1 = the stage grid; step 2 = the per-stage input panel, only for a stage that needs one.
  const [step, setStep] = useState(1);
  useEffect(() => { if (open) setStep(1); }, [open]);
  if (!engagement) return null;

  const isUgc          = engagement.engagement_type === 'ugc';
  // ⚠️ The stage list MUST follow the deal's type. This modal already branched on `isUgc` for the
  // post-date, rating, order-id and tracking-url guards but not for the stages themselves, so it
  // offered the VIDEO vocabulary to a UGC deal. Moving one to planning/scheduled/posting/delayed/
  // on_hold left it uncountable and unfilterable on the /ugc board, which builds its count chips
  // and stage filter from UGC_STAGE_VALUES. The worker now refuses those transitions too — this
  // is the convenience half of the fix, not the gate. (S317 hostile review.)
  const stageLabels = isUgc ? UGC_STAGE_LABELS : STAGE_LABELS;
  const stagePalette = isUgc ? UGC_STAGE_PALETTE : STAGE_PALETTE;
  const happyPath   = isUgc ? UGC_HAPPY_PATH : HAPPY_PATH;
  const options = isUgc
    ? UGC_STAGE_VALUES.filter(s => s !== engagement.stage)
    : allowedTransitions(engagement.stage);
  const isLive         = target === 'live';                 // ⑤ terminal success (video)
  const needsVideoLink = isLive;                            // #4
  // #10 — the On-track/Delayed branch routes to the `delayed` stage, which is video-only. Scoped
  // to !isUgc so it can never fire for a UGC deal: 'scheduled' is no longer offered to one, and
  // if it were re-introduced this would otherwise quietly write an invalid stage again.
  const isSchedule     = !isUgc && target === 'scheduled';
  const isShipped      = target === 'shipped';              // #7
  const existingLink   = (engagement.video_link || '').trim();
  const existingPost   = (engagement.post_date || '').toString().trim();
  const existingRating = (engagement.influencer?.quality_rating || '').trim();
  const isRated        = ['green', 'yellow', 'red'].includes(existingRating);
  const existingOrder  = (engagement.shipping_order_id || '').trim();
  const existingTrack  = (engagement.tracking_url || '').trim();
  const isDelayed      = isSchedule && trackChoice === 'delayed';

  // ② — a video post date is mandatory at go-live (drives monthly-target views);
  // only prompt when one isn't already on the deal. UGC uses live_at — exempt.
  const needsPostDate  = isLive && !isUgc && !existingPost;
  // ⑤ — going live requires a colour rating (video deals); only prompt if unrated.
  const needsRating    = isLive && !isUgc && !isRated;
  // Shipped mirrors the worker's split guard (advanceStage): UGC needs a tracking
  // LINK, video deals need the Shopify order id. Only prompt when the deal doesn't
  // already carry the field. Prompting for the wrong one made the UGC deal
  // unadvanceable from this modal — the worker 422'd whatever was typed in.
  const needsOrderId   = isShipped && !isUgc && !existingOrder;
  const needsTrackUrl  = isShipped && isUgc && !existingTrack;

  // B11 — soft skip-stage warning (transitions are free by design; this only nudges).
  const _fromIdx = happyPath.indexOf(engagement.stage);
  const _toIdx   = happyPath.indexOf(target);
  const skipped  = (_fromIdx >= 0 && _toIdx > _fromIdx + 1) ? happyPath.slice(_fromIdx + 1, _toIdx) : [];

  const missingVideo    = needsVideoLink && !(videoLink.trim() || existingLink);
  const missingPostDate = needsPostDate && !postDate;
  const missingRevised  = isDelayed && !revisedDate;
  const missingRating   = needsRating && !rating;
  const missingOrderId  = needsOrderId && !shipOrderId.trim();
  const missingTrackUrl = needsTrackUrl && !trackUrl.trim();
  // Every per-stage prompt lives on step 2; a stage with none advances straight from step 1.
  const needsInputs = needsVideoLink || needsPostDate || needsRating || needsOrderId || needsTrackUrl || isSchedule;
  // An unapproved proposal can only be closed (ghosted/dropped/cancelled) — the worker 422s approval_required.
  const awaitingApproval = engagement.stage === 'proposed' && !engagement.approved_at;
  const nextStage = awaitingApproval ? undefined : _fromIdx >= 0 ? happyPath[_fromIdx + 1] : undefined;
  const canSubmit = !!target && !busy && !missingVideo && !missingPostDate && !missingRevised && !missingRating && !missingOrderId && !missingTrackUrl;

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
      if (needsTrackUrl && trackUrl.trim()) extra.tracking_url = trackUrl.trim();
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
      if (/approval_required/.test(m)) setErr('This deal needs approval before it can move forward.');
      else if (/rating_required_for_live/.test(m)) setErr('Rate the influencer (green / yellow / red) to mark this live.');
      else if (/post_date_required_for_live/.test(m)) setErr('A video posting date is required to mark this live.');
      else if (/shipping_order_id_required_for_shipped/.test(m)) setErr('A Shopify order ID is required to mark this shipped.');
      else if (/tracking_url_required_for_shipped/.test(m)) setErr('A tracking link is required to mark this shipped.');
      else if (/video_link_required_for_live/.test(m)) setErr('A video link is required to mark this live.');
      else setErr(m || 'Could not advance');
    } finally { setBusy(false); }
  }

  const curPal = stagePalette[engagement.stage] || { fg: 'var(--text-1)' };

  // B11 — soft nudge when skipping happy-path stages (still allowed)
  const skipBanner = skipped.length > 0 && (
    <Banner tone="warning" lead={`⚠ Skipping ${skipped.map(s => stageLabels[s] || s).join(', ')}.`}>
      You can still advance if that&apos;s intended.
    </Banner>
  );
  const errLineEl = err && <div style={{ fontSize: 13, color: 'var(--state-error-fg)' }}>{err}</div>;

  return (
    <Modal open={open} onClose={onClose} title="Move to…">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: 'var(--text-3)', marginTop: -12 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent-hi)' }}>{engagement.engagement_no}</span>
          {' · '}Currently <span style={{ color: curPal.fg, fontWeight: 600 }}>{stageLabels[engagement.stage] || engagement.stage}</span>. {awaitingApproval ? 'Needs approval before it can move forward.' : 'Any stage is allowed.'}
        </div>

        {step === 1 && (
          <>
            <div role="radiogroup" aria-label="Move to" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8 }}>
              {options.map(s => {
                const on = target === s;
                const isNext = s === nextStage;
                return (
                  <button type="button" role="radio" aria-checked={on} key={s} onClick={() => setTarget(s)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', minWidth: 0,
                      borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                      border: `1px solid ${on || isNext ? 'var(--accent)' : 'var(--border-2)'}`,
                      background: on ? 'var(--accent-bg)' : isNext ? 'var(--accent-bg-soft)' : 'transparent',
                      boxShadow: on ? 'inset 0 0 0 1px var(--accent)' : 'none',
                      color: 'var(--text-1)', fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600,
                      transition: 'border-color 140ms, background 140ms',
                    }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: (stagePalette[s] || {}).fg || 'var(--text-4)' }} />
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{stageLabels[s] || s}</span>
                    {isNext && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent-hi)', fontFamily: 'var(--font-mono)' }}>NEXT</span>}
                  </button>
                );
              })}
            </div>

            {skipBanner}

            <div>
              <label style={lblStyle}>Note (optional)</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                style={{ ...fieldStyle, height: 'auto', padding: '10px 12px', resize: 'vertical' }}
              />
            </div>
            {errLineEl}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={onClose} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
              {needsInputs ? (
                <button type="button" onClick={() => setStep(2)} disabled={!target}
                  className={target ? 'ig-cta' : undefined}
                  style={{ ...primaryBtn, cursor: target ? 'pointer' : 'not-allowed', opacity: target ? 1 : 0.5 }}
                >Continue →</button>
              ) : (
                <button type="button" onClick={submit} disabled={!canSubmit}
                  className={canSubmit ? 'ig-cta' : undefined}
                  style={{ ...primaryBtn, cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.5 }}
                >{busy ? 'Advancing…' : 'Advance'}</button>
              )}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>Moving to</span>
              <StagePill stage={target} ugc={isUgc} />
            </div>

            {skipBanner}

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
                {missingVideo && <div style={errLine}>Required to mark live</div>}
              </div>
            )}

            {/* ② — going live requires the video posting date (feeds the monthly target) */}
            {needsPostDate && (
              <div>
                <label style={lblStyle}>Video posting date *</label>
                <input type="date" value={postDate} onChange={(e) => setPostDate(e.target.value)} style={fieldStyle} />
                {missingPostDate
                  ? <div style={errLine}>Required to mark live — views count toward this month&apos;s target</div>
                  : <div style={hintLine}>Views attribute to the month the video posted.</div>}
              </div>
            )}

            {/* ⑤ — going live requires a colour rating if not already rated */}
            {needsRating && (
              <div>
                <label style={lblStyle}>Rating *</label>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  {[['green', 'Green'], ['yellow', 'Yellow'], ['red', 'Red']].map(([v, label]) => (
                    <button type="button" key={v} onClick={() => setRating(v)} style={choiceBtn(rating === v, RATING_COLORS[v])}>{label}</button>
                  ))}
                </div>
                {missingRating && <div style={errLine}>Required to mark live</div>}
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
                {missingOrderId && <div style={errLine}>Required to mark shipped</div>}
              </div>
            )}

            {/* C1 #2 — a UGC deal is marked shipped against a tracking link, not an order id */}
            {needsTrackUrl && (
              <div>
                <label style={lblStyle}>Tracking link *</label>
                <input
                  value={trackUrl}
                  onChange={(e) => setTrackUrl(e.target.value)}
                  placeholder="https://…"
                  style={fieldStyle}
                />
                {missingTrackUrl && <div style={errLine}>Required to mark shipped</div>}
              </div>
            )}

            {/* #10 — scheduling: confirm on-track vs delayed */}
            {isSchedule && (
              <div>
                <label style={lblStyle}>Is it on track?</label>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  {[['on_track', 'On track'], ['delayed', 'Delayed']].map(([v, label]) => (
                    <button type="button" key={v} onClick={() => setTrackChoice(v)} style={choiceBtn(trackChoice === v, '#FF6B00')}>{label}</button>
                  ))}
                </div>
                {isDelayed && (
                  <div style={{ marginTop: 10 }}>
                    <label style={lblStyle}>Revised post date *</label>
                    <input type="date" value={revisedDate} onChange={(e) => setRevisedDate(e.target.value)} style={fieldStyle} />
                    <div style={hintLine}>Moves the deal to <strong style={{ color: 'var(--text-2)' }}>Delayed</strong>; original date kept in history.</div>
                  </div>
                )}
              </div>
            )}

            {note.trim() && (
              <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
                Note: <span style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{note}</span>
              </div>
            )}
            {errLineEl}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setStep(1)} disabled={busy} className="ig-ghost-btn" style={ghostBtn}>← Back</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={onClose} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
                <button type="button" onClick={submit} disabled={!canSubmit}
                  className={canSubmit ? 'ig-cta' : undefined}
                  style={{ ...primaryBtn, cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.5 }}
                >{busy ? 'Advancing…' : 'Advance'}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
