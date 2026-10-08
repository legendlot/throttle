'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { deriveMetrics, isMetricApplicable, unexplainedGaps, GAP_REASONS, REQUIRED_METRICS, missingRequiredMetrics, organicViews } from '../../../../../lib/metrics.js';
import { KV } from './shared.js';

// #13 — editable performance stats once the deal is live/completed.
// Reann 2026-08-10 #1 added saves / reposts / followers_gained / follower_count_at_post.
// Reann 2026-09-04 #7 made follower_count_at_post MANDATORY here — REQUIRED_METRICS in
// lib/metrics.js is the one list, so the label, the disabled Save and the refusal all agree.
//
// S351 (multiple videos, slice 3) — the metrics split in two.
// Per-VIDEO metrics are written with setEngagementVideo against one take; the matching column on
// `engagements` is a worker-owned ROLLUP of the takes and is no longer in ENGAGEMENT_FIELDS, so a
// PATCH of it here would be silently reverted by the next rollup.
// S373 (paid vs organic): `views` is the platform TOTAL; `paid_views` is the part an ad bought
// (typed here, or filled by the Meta sync when a synced ad sits on the take). ORGANIC = views −
// paid is DERIVED and shown under it — the stored `organic_views` column is no longer an input,
// because a typed organic next to a derived one would be two answers to one question.
const VIDEO_METRIC_FIELDS = [
  ['views', 'Views'], ['paid_views', 'Paid views'],
  ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'],
  ['reposts', 'Reposts'], ['saves', 'Saves'], ['followers_gained', 'Followers gained'],
  ['follower_count_at_post', 'Followers at post date'], ['impressions', 'Impressions'],
];
// …and the deal-level ones that are NOT per-video (still written with updateEngagement).
const DEAL_METRIC_FIELDS = [['sessions', 'Sessions'], ['orders', 'Orders'], ['conversions_value', 'Conversions ₹']];
// Per-take-only fields (no deal-level column). Empty since S373: `engagements.paid_views` is now
// a worker rollup like views. Kept so a future per-take-only field has somewhere to go.
const VIDEO_ONLY_FIELDS = new Set([]);
// Split of the views figure, not a ratio over followers — never demands followers-at-post and never
// takes a "why blank?" reason (blank paid views = no ad). Mirrors the worker's VIEW_SPLIT_FIELDS.
const VIEW_SPLIT_FIELDS = new Set(['paid_views']);
// "Organic views" line under Paid views, wherever a take or the deal totals are shown.
const organicLabel = (row) => {
  const o = organicViews(row.views, row.paid_views);
  return o == null ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>—</span> : o.toLocaleString();
};
const MAX_VIDEOS = 6;   // engagement_videos.seq CHECK (1..6) — the 7th insert 23514s; refuse here first

export function PerformanceCard({ e, videos, ads, canEdit, session, onSaved, platform, gapReasons }) {
  const { showToast: toast } = useToast();
  const takes = [...(videos || [])].sort((a, b) => Number(a.seq) - Number(b.seq));
  const [tab, setTab] = useState(takes[0]?.seq ?? 1);          // seq of the take being viewed
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [gaps, setGaps] = useState({});
  const [busy, setBusy] = useState(false);
  // Fall back to the primary, not to null: after a take is removed, `tab` still points at the seq
  // that just went away and the card read "No video on this deal yet." on a deal full of videos.
  const current = takes.find(t => Number(t.seq) === Number(tab)) || takes[0] || null;

  const applicable = ([k]) => isMetricApplicable(k, platform);
  const shown = VIDEO_METRIC_FIELDS.filter(applicable);
  const derived = deriveMetrics(e, platform);                   // deal-level ratios off the ROLLUP
  const unexplained = unexplainedGaps(e, platform);
  // Reann #7 — blank required metrics in what is currently typed, not in the saved row: the
  // message and the Save button have to clear the moment the number is entered. `form` carries
  // every shown VIDEO metric, so follower_count_at_post is read from the take being edited.
  // …and ONLY once a performance number is actually being entered. A take filed with just a link
  // and a post date (the normal state the day it goes live) has no ratios to protect, and blocking
  // it made the video unfileable until its numbers existed. Same rule as the server hard stop in
  // ignitionops-worker (VIDEO_METRICS_NEEDING_BASE).
  const anyMetricEntered = shown.some(([k]) => !REQUIRED_METRICS.includes(k) && !VIEW_SPLIT_FIELDS.has(k) && form[k] !== '' && form[k] != null);
  const missingRequired = editing && current && anyMetricEntered ? missingRequiredMetrics(form, platform) : [];
  // A take with a SYNCED ad has Meta-owned paid views: the next sync re-derives them, so a typed
  // figure would be silently overwritten. Shown read-only ("from Meta") and not sent on save.
  const paidFromMeta = !!current && (ads || []).some(a => a.video_id === current.id && a.meta_synced_at);
  // Paid views are a slice of views — the worker refuses paid > views; say so before Save. Only
  // when this edit CHANGES one of the two (same rule as the worker): an over-value already stored
  // must not block saving an unrelated field.
  const sameNum = (a, b) => ((a === '' || a == null) ? (b === '' || b == null) : (b !== '' && b != null && Number(a) === Number(b)));
  const splitChanged = !!current && (!sameNum(form.views, current.views) || (!paidFromMeta && !sameNum(form.paid_views, current.paid_views)));
  const paidOverViews = editing && splitChanged && form.paid_views !== '' && form.paid_views != null && form.views !== '' && form.views != null
    && Number(form.paid_views) > Number(form.views);
  const requiredLabels = missingRequired
    .map(k => (VIDEO_METRIC_FIELDS.find(([mk]) => mk === k) || [k, k])[1]);

  function startEdit() {
    if (!current) return;
    const f = { video_link: current.video_link ?? '', post_date: (current.post_date || '').slice(0, 10) };
    for (const [k] of shown) f[k] = current[k] ?? '';
    setForm(f); setGaps({ ...(current.metric_gaps || {}) }); setEditing(true);
  }
  async function saveTake() {
    // The hard stop, enforced twice on purpose: the Save button is disabled below, but a disabled
    // button is a hint — this is the gate. A metric_gaps reason deliberately does not clear it.
    if (missingRequired.length) {
      toast(`${requiredLabels.join(', ')} is required before performance can be saved`, 'error');
      return;
    }
    if (paidOverViews) { toast('Paid views cannot be more than views', 'error'); return; }
    setBusy(true);
    try {
      const patch = {
        engagement_id: e.id, seq: current.seq,
        video_link: form.video_link === '' ? null : form.video_link,
        post_date: form.post_date === '' ? null : form.post_date,
      };
      for (const [k] of shown) {
        if (k === 'paid_views' && paidFromMeta) continue;   // Meta-owned — the worker keeps the stored figure
        patch[k] = form[k] === '' ? null : Number(form[k]);
      }
      // Only keep a reason where the value is actually blank — a reason sitting behind a real
      // number is stale the moment someone fills it in, and would keep reading as "unknown".
      const cleaned = {};
      for (const [k] of shown) if (patch[k] == null && gaps[k]) cleaned[k] = gaps[k];
      patch.metric_gaps = cleaned;
      await ignitionopsPost('setEngagementVideo', patch, session);
      toast(`Video #${current.seq} updated`, 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function addTake() {
    if (takes.length >= MAX_VIDEOS) { toast(`A deal holds at most ${MAX_VIDEOS} videos`, 'error'); return; }
    setBusy(true);
    try {
      // No seq — the worker picks the lowest free one (deletions leave holes).
      const r = await ignitionopsPost('setEngagementVideo', { engagement_id: e.id }, session);
      toast(`Video #${r.video.seq} added`, 'success');
      setTab(r.video.seq); setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function removeTake() {
    // #1 is the primary: its link and date ARE the deal's, and the worker refuses to delete it
    // while other takes exist. Never offer it.
    if (!current || Number(current.seq) === 1) return;
    if (!window.confirm(`Remove video #${current.seq}? Its numbers leave the deal's totals.`)) return;
    setBusy(true);
    try {
      await ignitionopsPost('deleteEngagementVideo', { engagement_id: e.id, seq: current.seq }, session);
      toast(`Video #${current.seq} removed`, 'success');
      setTab(1); setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const tabStyle = (active) => ({
    padding: '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
    background: active ? 'var(--surface-3)' : 'transparent', color: active ? 'var(--text-1)' : 'var(--text-3)',
    border: '1px solid', borderColor: active ? 'var(--border-2)' : 'var(--border)', borderRadius: 'var(--radius-sm)',
  });

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Performance</h2>
        <div role="tablist" aria-label="Video takes" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {takes.map(t => (
            <button key={t.seq} role="tab" aria-selected={Number(t.seq) === Number(tab)} style={tabStyle(Number(t.seq) === Number(tab))}
              onClick={() => { setTab(t.seq); setEditing(false); }}>Video #{t.seq}</button>
          ))}
          {canEdit && takes.length < MAX_VIDEOS && (
            <button onClick={addTake} disabled={busy} style={tabStyle(false)} title="Add another take of this video">+ Add video</button>
          )}
        </div>
        {canEdit && current && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>

      {!current && <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No video on this deal yet.</div>}

      {current && !editing && (
        <>
          <KV label="Link" value={current.video_link
            ? <a href={current.video_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>{current.video_link}</a>
            : '—'} />
          <KV label="Posted" value={current.post_date || '—'} />
          {shown.map(([k, label]) => {
            const raw = current[k];
            const reason = (current.metric_gaps || {})[k];
            const val = (raw == null || raw === '')
              ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>{reason ? (GAP_REASONS[reason] || reason) : '—'}</span>
              : Number(raw).toLocaleString();
            if (k === 'paid_views') return [
              <KV key={k} label={label} value={paidFromMeta
                ? <span>{val} <span style={{ color: 'var(--text-3)', fontSize: 11 }}>from Meta</span></span>
                : val} />,
              <KV key="organic" label="Organic views" value={organicLabel(current)} />,
            ];
            return <KV key={k} label={label} value={val} />;
          })}
        </>
      )}

      {current && editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Link</span>
            <input value={form.video_link} onChange={ev => setForm(f => ({ ...f, video_link: ev.target.value }))}
              style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 13 }} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Posted</span>
            <input type="date" value={form.post_date} onChange={ev => setForm(f => ({ ...f, post_date: ev.target.value }))}
              style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 13 }} />
          </div>
          {shown.map(([k, label]) => {
          const required = REQUIRED_METRICS.includes(k);
          const blankRequired = required && missingRequired.includes(k);
          return (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 130, color: blankRequired ? 'var(--state-error-fg)' : 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {label}{required && <span style={{ color: 'var(--state-error-fg)' }}> *</span>}
              </span>
              {/* The required field is edited right here, in the same card — a hard stop that sent
                  you to another screen to clear it would be a dead end. Focus it when it is blank. */}
              <input type="number" min="0" value={form[k]} onChange={ev => setForm(f => ({ ...f, [k]: ev.target.value }))}
                autoFocus={blankRequired}
                readOnly={k === 'paid_views' && paidFromMeta}
                title={k === 'paid_views' && paidFromMeta ? 'Synced from Meta for the ad on this video — refreshed on every sync' : undefined}
                style={{ flex: 1, background: 'var(--surface-2)', color: (k === 'paid_views' && paidFromMeta) ? 'var(--text-3)' : 'var(--text-1)', border: `1px solid ${blankRequired ? 'var(--state-error-fg)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 13 }} />
              {/* A blank number gets a "why" picker — that is what separates a real 0 from unknown.
                  A REQUIRED metric gets none: it is not backfillable, so a reason would just record
                  that the number is lost. Capture it now or the deal has no ratios, ever. */}
              {!required && !VIEW_SPLIT_FIELDS.has(k) && (form[k] === '' || form[k] == null) && (
                <select value={gaps[k] || ''} onChange={ev => setGaps(g => ({ ...g, [k]: ev.target.value }))}
                  style={{ width: 150, background: 'var(--surface-2)', color: gaps[k] ? 'var(--text-1)' : 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  <option value="">why blank?</option>
                  {(gapReasons || []).map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              )}
              {k === 'paid_views' && (
                <span style={{ width: 150, fontSize: 11, color: paidOverViews ? 'var(--state-error-fg)' : 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                  {paidOverViews ? 'more than views'
                    : `${paidFromMeta ? 'from Meta · ' : ''}organic ${organicViews(form.views, form.paid_views)?.toLocaleString() ?? '—'}`}
                </span>
              )}
            </div>
          );
          })}
          {missingRequired.length > 0 && (
            <div style={{ padding: '8px 10px', background: 'var(--state-error-bg)', border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--text-1)', lineHeight: 1.5 }}>
              <strong>{requiredLabels.join(', ')} is required.</strong> This cannot be saved without it,
              and &ldquo;why blank?&rdquo; does not apply — the count on the day this posted cannot be
              recovered later, and every ratio on the deal depends on it. Enter it above.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            {Number(current.seq) !== 1 && (
              <button onClick={removeTake} disabled={busy}
                style={{ marginRight: 'auto', padding: '6px 12px', background: 'transparent', color: 'var(--state-error-fg)', border: '1px solid currentColor', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Remove video #{current.seq}</button>
            )}
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={saveTake} disabled={busy || missingRequired.length > 0 || paidOverViews}
              title={missingRequired.length > 0 ? `${requiredLabels.join(', ')} is required` : paidOverViews ? 'Paid views cannot be more than views' : undefined}
              style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: (busy || missingRequired.length > 0 || paidOverViews) ? 'not-allowed' : 'pointer', opacity: (busy || missingRequired.length > 0 || paidOverViews) ? 0.5 : 1 }}>{busy ? 'Saving…' : `Save video #${current.seq}`}</button>
          </div>
        </div>
      )}

      <DealTotals e={e} derived={derived} unexplained={unexplained} takes={takes}
        canEdit={canEdit} session={session} onSaved={onSaved} platform={platform} />
    </section>
  );
}

// The deal's own numbers, below the per-take tabs. The rolled-up metric columns are READ-ONLY —
// setEngagementVideo + recomputeVideoRollup are their only writer since S351, so an input here
// would be reverted by the next rollup. Sessions / Orders / Conversions ₹ are NOT per-video and
// are still edited here through updateEngagement, exactly as the old card did.
function DealTotals({ e, derived, unexplained, takes, canEdit, session, onSaved, platform }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  const applicable = ([k]) => isMetricApplicable(k, platform);
  const rolled = VIDEO_METRIC_FIELDS.filter(f => !VIDEO_ONLY_FIELDS.has(f[0])).filter(applicable);
  const shownDeal = DEAL_METRIC_FIELDS.filter(applicable);

  function startEdit() {
    const f = {};
    for (const [k] of shownDeal) f[k] = e[k] ?? '';
    setForm(f); setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      const patch = { engagement_id: e.id };
      for (const [k] of shownDeal) patch[k] = form[k] === '' ? null : Number(form[k]);
      await ignitionopsPost('updateEngagement', patch, session);
      toast('Deal totals updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const value = (raw, reason, isMoney) => (raw == null || raw === '')
    ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>{reason ? (GAP_REASONS[reason] || reason) : '—'}</span>
    : (isMoney ? `₹${Number(raw).toLocaleString()}` : Number(raw).toLocaleString());

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Deal totals ({takes.length} video{takes.length === 1 ? '' : 's'})
        </div>
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit totals</button>
        )}
      </div>

      {/* Summed across the takes by the worker — typed on a video tab, never here. */}
      {rolled.map(([k, label]) => k === 'paid_views'
        ? [<KV key={k} label={label} value={value(e[k], null, false)} />, <KV key="organic" label="Organic views" value={organicLabel(e)} />]
        : <KV key={k} label={label} value={value(e[k], (e.metric_gaps || {})[k], false)} />)}

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {shownDeal.map(([k, label]) => (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
              <input type="number" value={form[k]} onChange={ev => setForm(f => ({ ...f, [k]: ev.target.value }))}
                style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 13 }} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy}
              style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          {shownDeal.map(([k, label]) => (
            <KV key={k} label={label} value={value(e[k], (e.metric_gaps || {})[k], k === 'conversions_value')} />
          ))}
          {e.actual_roas != null && <KV label="Actual ROAS" value={Number(e.actual_roas).toFixed(2)} />}
        </>
      )}

      {/* Engagement ratios — every one divides by followers at post date (the seq-1 take's). */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
          Engagement ratios
        </div>
        {derived.missingDenominator ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
            Needs <strong style={{ color: 'var(--text-2)' }}>followers at post date</strong> before any
            ratio can be worked out. It is the follower count on the day this posted, not today&apos;s —
            using today&apos;s would understate a creator who has grown since. Add it on video #1 above.
          </div>
        ) : (
          derived.ratios.map(r => (
            <KV key={r.key} label={r.label}
              value={r.value == null
                ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>—</span>
                : (r.unit === 'x' ? `${r.value}x` : `${r.value}%`)} />
          ))
        )}
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
          Business
        </div>
        {derived.business.map(b => (
          <KV key={b.key} label={b.label}
            value={b.value == null
              ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>—</span>
              : `₹${Number(b.value).toLocaleString()}`} />
        ))}
      </div>

      {unexplained.length > 0 && (
        <div style={{ marginTop: 12, padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
          {unexplained.length} metric{unexplained.length > 1 ? 's' : ''} blank with no reason recorded.
          Edit a video above and pick why, so a gap can be told apart from a genuine zero.
        </div>
      )}
    </div>
  );
}
