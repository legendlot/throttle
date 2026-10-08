'use client';
import { useEffect, useMemo, useState, Fragment } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, Trash2, Plus, ChevronDown } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import { channelLinkError, normalizeChannelLink } from '../../../../lib/channelLink.js';
import { NewDealModal } from '../../../../components/NewDealModal.js';
import LocationInput from '../../../../components/LocationInput.js';
import { canonicalLocation } from '../../../../lib/locations.js';
import { organicViews } from '../../../../lib/metrics.js';
import { STAGE_LABELS } from '../../../../lib/stages.js';
import {
  Card, SectionTitle, Segmented, StagePill, DealPill, RatingDot, RATING_COLORS, Tile, FilterSelect, Row, Avatar,
} from '../../../../components/ui/index.js';

// Mirrors SPEND_EXCLUDED_STAGES on the Engagements list and in ignitionops: a CANCELLED deal was
// called off before anything was spent, so it stays out of the spend, views and CPM tiles. The
// deal COUNT still includes it.
const SPEND_EXCLUDED_STAGES = new Set(['cancelled']);

// Engagements grid. No per-deal Verdict column — dropped by §S411-IgnitionRedesignScope (D8).
const ENG_COLS = '150px 70px 130px 120px 100px 70px minmax(90px, 1fr)';

// Keyed by the record id: global search (⌘K) can move from one record to another on this same route,
// and Next keeps the page mounted across a ?id= change — without the key, open edit forms, typed
// notes and the loaded record would carry over to the next record (typeahead S3 review).
export default function InfluencerDetailPage() {
  const sp = useSearchParams();
  return <InfluencerDetailPageBody key={sp.get('id') || `code:${sp.get('code') || ''}`} />;
}

function InfluencerDetailPageBody() {
  const sp = useSearchParams();
  const router = useRouter();
  const id = sp.get('id');
  const code = sp.get('code');
  const { session, perms } = useAuth();
  const canManage = !!perms?.ignition_manage;
  const { showToast: toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({});
  const [catalogs, setCatalogs] = useState(null);
  const [showDeal, setShowDeal] = useState(false);   // ④ — add deal from profile

  function reload() {
    if (!session || (!id && !code)) return;
    const params = id ? { id } : { code };
    ignitionopsGet('getInfluencer', params, session).then(setData).catch(e => setErr(e.message));
  }
  useEffect(reload, [id, code, session]);

  // Category-option lists + demographic enums for the edit pickers.
  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getCatalogs', {}, session).then(setCatalogs).catch(() => setCatalogs(null));
  }, [session]);

  // "Add more" on either category axis — persists + extends the in-memory list.
  async function addCatOption(axis, label) {
    try {
      const opt = await ignitionopsPost('addCategoryOption', { axis, label }, session);
      const lbl = opt?.label || label;
      setCatalogs(c => {
        if (!c) return c;
        const key = axis === 'niche' ? 'niche' : 'format';
        const cur = c.category_options?.[key] || [];
        if (cur.some(x => x.toLowerCase() === lbl.toLowerCase())) return c;
        return { ...c, category_options: { ...c.category_options, [key]: [...cur, lbl] } };
      });
      return lbl;
    } catch (e) { toast(e.message, 'error'); return null; }
  }

  // Sends NO rating_notes on purpose: since B1 (S412) the worker only touches the stored notes when
  // the caller sends the key, so a colour click keeps the reason intact (except the overdue auto-flag note, cleared on leaving red).
  async function setRating(rating) {
    try {
      await ignitionopsPost('setRating', { influencer_id: data.influencer.id, rating }, session);
      toast(`Rating set to ${rating}`, 'success');
      reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function removeInfluencer() {
    const engCount = data?.engagements?.length || 0;
    if (engCount > 0) {
      if (!window.confirm(`${inf.influencer_code} has ${engCount} engagement${engCount === 1 ? '' : 's'} and can't be deleted (history is kept). Archive it instead?`)) return;
      try {
        await ignitionopsPost('updateInfluencer', { influencer_id: data.influencer.id, list_status: 'archived' }, session);
        toast('Influencer archived', 'success');
        router.push('/influencers');
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (!window.confirm(`Permanently delete ${inf.influencer_code}? This cannot be undone.`)) return;
    try {
      await ignitionopsPost('deleteInfluencer', { id: data.influencer.id }, session);
      toast('Influencer deleted', 'success');
      router.push('/influencers');
    } catch (e) {
      toast(e.message === 'has_engagements' ? "Can't delete — this influencer has engagements. Archive instead." : e.message, 'error');
    }
  }

  function startEdit() {
    const i = data.influencer;
    setForm({
      channel_name: i.channel_name || '', person_name: i.person_name || '',
      channel_link: i.channel_link || '',
      channel_platforms: i.channel_platforms || (i.channel_platform ? [i.channel_platform] : []),
      influencer_type: i.influencer_type || '', categories: i.categories || [],
      audience_niches: i.audience_niches || [],
      age_range: i.age_range || '', gender_majority: i.gender_majority || '',
      reach: i.reach ?? '', follower_count: i.follower_count ?? '',
      audience: i.audience || '', location: i.location || '',
      contact_poc_type: i.contact_poc_type || '', contact_poc_name: i.contact_poc_name || '',
      contact_number: i.contact_number || '', email: i.email || '', address: i.address || '',
    });
    setEditing(true);
  }
  function setF(k, v) { setForm(s => ({ ...s, [k]: v })); }
  async function saveEdit() {
    // Refuse a pasted tab title at the form rather than storing it — see lib/channelLink.js.
    const linkErr = channelLinkError(form.channel_link);
    if (linkErr) { toast(linkErr, 'error'); return; }
    setSaving(true);
    try {
      const rn = Number(form.reach);
      const fc = Number(form.follower_count);
      const payload = {
        influencer_id: data.influencer.id,
        channel_name: form.channel_name.trim() || null,
        person_name: form.person_name.trim() || null,
        channel_link: normalizeChannelLink(form.channel_link) || null,
        channel_platforms: form.channel_platforms,   // worker derives channel_platform from [0]
        influencer_type: form.influencer_type || null,
        categories: form.categories || [],
        audience_niches: form.audience_niches || [],
        age_range: form.age_range || null,
        gender_majority: form.gender_majority || null,
        reach: (form.reach === '' || isNaN(rn)) ? null : Math.round(rn),
        follower_count: (form.follower_count === '' || isNaN(fc)) ? null : Math.round(fc),
        audience: form.audience.trim() || null,
        location: canonicalLocation(form.location) || null,
        contact_poc_type: form.contact_poc_type || null,
        contact_poc_name: form.contact_poc_name.trim() || null,
        contact_number: form.contact_number.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
      };
      await ignitionopsPost('updateInfluencer', payload, session);
      toast('Identity updated', 'success');
      setEditing(false);
      reload();
    } catch (e) { toast(e.message, 'error'); }
    finally { setSaving(false); }
  }

  // Summary tiles — from the engagements getInfluencer already returns; same rules as the
  // Engagements list tiles (organic views = views − paid; CPM only over deals with views).
  const summary = useMemo(() => {
    const engs = data?.engagements || [];
    let cost = 0, views = 0, costOfViewed = 0, cancelled = 0;
    const byStage = {};
    for (const e of engs) {
      byStage[e.stage] = (byStage[e.stage] || 0) + 1;
      if (SPEND_EXCLUDED_STAGES.has(e.stage)) { cancelled += 1; continue; }
      cost += Number(e.total_cost || 0);
      const v = organicViews(e.views, e.paid_views) ?? 0;
      views += v;
      if (v > 0) costOfViewed += Number(e.total_cost || 0);
    }
    const breakdown = Object.entries(byStage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, n]) => `${n} ${(STAGE_LABELS[s] || s || '—').toLowerCase()}`)
      .join(' · ');
    return { deals: engs.length, breakdown, cost, views, cpm: views > 0 ? (costOfViewed / views) * 1000 : null, cancelled };
  }, [data]);

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!data) return <Spinner />;
  const inf = data.influencer;
  const rating = RATING_COLORS[inf.quality_rating] ? inf.quality_rating : 'unrated';
  const name = inf.channel_name || inf.person_name || '(no name)';
  const subline = [inf.person_name && inf.person_name !== name ? inf.person_name : null, inf.influencer_type, inf.location]
    .filter(Boolean).join(' · ');

  return (
    <div style={{ maxWidth: 1400, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button onClick={() => router.back()} className="ig-card-action" style={{ ...backBtn, fontSize: 13 }}>
        <ArrowLeft size={14} strokeWidth={2} /> Back
      </button>

      <header className="ig-up" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Avatar name={name} seed={inf.influencer_code} size={64} ring={RATING_COLORS[rating]} />
        <div style={{ minWidth: 0, flex: '1 1 220px' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', fontWeight: 700, color: 'var(--accent-hi)' }}>{inf.influencer_code}</span>
            {inf.channel_link && (
              <a href={inf.channel_link} target="_blank" rel="noreferrer"
                style={{ fontSize: 12, color: 'var(--accent-hi)', borderBottom: '1px dotted var(--accent-hi)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {inf.channel_link.replace(/^https?:\/\/(www\.)?/, '')} ↗
              </a>
            )}
          </div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6, lineHeight: 1.15, overflowWrap: 'anywhere' }}>
            {name}
          </h1>
          {subline && <div style={{ fontSize: 14, color: 'var(--text-3)', marginTop: 2 }}>{subline}</div>}
          {inf.do_not_ship && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <span title={inf.do_not_ship_reason || 'Do not ship'} style={{ fontSize: 12, fontWeight: 700, color: 'var(--state-error-fg)', border: '1px solid var(--state-error-fg)', borderRadius: 99, padding: '3px 10px' }}>Do not ship</span>
              {inf.do_not_ship_reason && <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{inf.do_not_ship_reason}</span>}
            </div>
          )}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {canManage ? (
            <Segmented
              value={rating}
              onChange={setRating}
              options={['green', 'yellow', 'red', 'unrated'].map(r => ({
                value: r,
                label: <RatingDot rating={r} style={{ color: 'inherit', fontSize: 13, textTransform: 'capitalize' }} />,
              }))}
            />
          ) : (
            <RatingDot rating={rating} />
          )}
          {canManage && (
            <button onClick={() => setShowDeal(true)} title="Create a deal for this influencer" className="ig-cta" style={newDealBtn}>
              <Plus size={15} strokeWidth={2.4} /> New deal
            </button>
          )}
          {canManage && (
            <button onClick={removeInfluencer} title="Delete influencer" style={deleteBtn}>
              <Trash2 size={14} strokeWidth={2} /> Delete
            </button>
          )}
        </div>
      </header>

      {canManage && (
        <NewDealModal
          open={showDeal}
          onClose={() => setShowDeal(false)}
          session={session}
          presetInfluencer={inf}
          onCreated={() => { setShowDeal(false); reload(); }}
        />
      )}

      <div className="ig-up" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: 12, animationDelay: '60ms' }}>
        <Tile label="Deals" value={summary.deals.toLocaleString('en-IN')} hint={summary.breakdown || undefined} />
        <Tile label="Lifetime spend" color="var(--accent-hi)" value={`₹${Math.round(summary.cost).toLocaleString('en-IN')}`}
          hint={summary.cancelled ? `${summary.cancelled} cancelled deal${summary.cancelled === 1 ? '' : 's'} excluded` : undefined} />
        <Tile label="Organic views" value={summary.views.toLocaleString('en-IN')} />
        {/* No "team avg" hint — dropped by §S411-IgnitionRedesignScope (W10). */}
        <Tile label="Blended CPM" value={summary.cpm == null ? '—' : `₹${summary.cpm.toFixed(0)}`} />
      </div>

      {/* Two-column: narrow left (identity/contact), wide right (engagements/reach/shopify).
          flex-wrap stacks them on narrow viewports so it never breaks on a laptop. */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 300px', minWidth: 'min(280px, 100%)', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card className="ig-up" style={{ animationDelay: '100ms' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <SectionTitle size={15} style={{ marginBottom: 0 }}>Identity</SectionTitle>
              {editing
                ? <span style={{ display: 'flex', gap: 6 }}>
                    <button onClick={saveEdit} disabled={saving} style={saveBtn}>{saving ? 'Saving…' : 'Save'}</button>
                    <button onClick={() => setEditing(false)} disabled={saving} className="ig-ghost-btn" style={editBtn}>Cancel</button>
                  </span>
                : (canManage ? <button type="button" onClick={startEdit} className="ig-card-action">Edit</button> : null)}
            </div>
            {editing ? (
              <>
                <Field label="Name"><input style={editInput} value={form.channel_name} onChange={e => setF('channel_name', e.target.value)} placeholder="Channel name" /></Field>
                <Field label="Person"><input style={editInput} value={form.person_name} onChange={e => setF('person_name', e.target.value)} /></Field>
                <Field label="Channel link"><input style={editInput} value={form.channel_link} onChange={e => setF('channel_link', e.target.value)} /></Field>
                <Field label="Platforms">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {['instagram', 'youtube', 'facebook', 'twitter', 'tiktok', 'other'].map(o => {
                      const on = (form.channel_platforms || []).includes(o);
                      return (
                        <button type="button" key={o}
                          onClick={() => setF('channel_platforms', on ? form.channel_platforms.filter(x => x !== o) : [...(form.channel_platforms || []), o])}
                          style={chip(on)}>{o}</button>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Type"><FilterSelect width="100%" value={form.influencer_type} onChange={e => setF('influencer_type', e.target.value)}><option value="">—</option>{['nano', 'micro', 'macro', 'brand', 'store'].map(o => <option key={o} value={o}>{o}</option>)}</FilterSelect></Field>
                <Field label="Content tags"><TagPicker options={catalogs?.category_options?.format || []} value={form.categories || []} onChange={v => setF('categories', v)} onAdd={lbl => addCatOption('format', lbl)} /></Field>
                <Field label="Audience niche"><TagPicker options={catalogs?.category_options?.niche || []} value={form.audience_niches || []} onChange={v => setF('audience_niches', v)} onAdd={lbl => addCatOption('niche', lbl)} /></Field>
                <Field label="Reach"><input style={editInput} type="number" value={form.reach} onChange={e => setF('reach', e.target.value)} /></Field>
                <Field label="Follower count"><input style={editInput} type="number" value={form.follower_count} onChange={e => setF('follower_count', e.target.value)} /></Field>
                <Field label="Audience notes"><input style={editInput} value={form.audience} onChange={e => setF('audience', e.target.value)} placeholder="free-form notes" /></Field>
                <Field label="Audience age"><FilterSelect width="100%" value={form.age_range} onChange={e => setF('age_range', e.target.value)}><option value="">—</option>{(catalogs?.age_ranges || []).map(o => <option key={o} value={o}>{o}</option>)}</FilterSelect></Field>
                <Field label="Gender majority"><FilterSelect width="100%" value={form.gender_majority} onChange={e => setF('gender_majority', e.target.value)}><option value="">—</option>{(catalogs?.gender_majorities || []).map(o => <option key={o} value={o}>{GENDER_LABELS[o] || o}</option>)}</FilterSelect></Field>
                <Field label="Location"><LocationInput style={editInput} value={form.location} onChange={v => setF('location', v)} /></Field>
              </>
            ) : (
              <>
                <KV label="Channel link" value={inf.channel_link ? <a href={inf.channel_link} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-hi)', overflowWrap: 'anywhere' }}>{inf.channel_link}</a> : '—'} />
                <KV label="Platforms" value={(inf.channel_platforms?.length ? inf.channel_platforms.join(', ') : inf.channel_platform) || '—'} />
                <KV label="Type" value={inf.influencer_type || '—'} />
                <KV label="Content tags" value={(inf.categories || []).join(', ') || '—'} />
                <KV label="Audience niche" value={(inf.audience_niches || []).join(', ') || '—'} />
                <KV label="Reach" value={inf.reach != null ? Number(inf.reach).toLocaleString() : '—'} />
                <KV label="Followers" value={inf.follower_count != null ? Number(inf.follower_count).toLocaleString() : '—'} />
                <KV label="Audience age" value={inf.age_range || '—'} />
                <KV label="Gender" value={inf.gender_majority ? (GENDER_LABELS[inf.gender_majority] || inf.gender_majority) : '—'} />
                <KV label="Audience notes" value={inf.audience || '—'} />
                <KV label="Location" value={inf.location || '—'} />
                <KV label="Onboarded" value={
                  inf.onboarded === true ? `Yes${inf.onboarded_at ? ` · ${inf.onboarded_at}` : ''}`
                  : inf.onboarded === false ? 'No' : '—'
                } />
              </>
            )}
          </Card>

          <Card className="ig-up" style={{ animationDelay: '150ms' }}>
            <SectionTitle size={15} style={{ marginBottom: 8 }}>Contact</SectionTitle>
            {editing ? (
              <>
                <Field label="POC type"><FilterSelect width="100%" value={form.contact_poc_type} onChange={e => setF('contact_poc_type', e.target.value)}><option value="">—</option>{['manager', 'influencer', 'agency'].map(o => <option key={o} value={o}>{o}</option>)}</FilterSelect></Field>
                <Field label="POC name"><input style={editInput} value={form.contact_poc_name} onChange={e => setF('contact_poc_name', e.target.value)} /></Field>
                <Field label="Phone"><input style={editInput} value={form.contact_number} onChange={e => setF('contact_number', e.target.value)} /></Field>
                <Field label="Email"><input style={editInput} value={form.email} onChange={e => setF('email', e.target.value)} /></Field>
                <Field label="Address"><input style={editInput} value={form.address} onChange={e => setF('address', e.target.value)} /></Field>
              </>
            ) : (
              <>
                <KV label="POC type" value={inf.contact_poc_type || '—'} />
                <KV label="POC name" value={inf.contact_poc_name || '—'} />
                <KV label="Phone" value={inf.contact_number || '—'} />
                <KV label="Email" value={inf.email || '—'} />
                <KV label="Address" value={inf.address || '—'} />
                <KV label="First invite" value={inf.first_invite_sent_at ? new Date(inf.first_invite_sent_at).toLocaleDateString() : 'Not sent'} />
              </>
            )}
          </Card>

          {inf.rating_notes && (
            <Card className="ig-up" style={{ animationDelay: '200ms' }}>
              <SectionTitle size={15} style={{ marginBottom: 8 }}>Rating notes</SectionTitle>
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-2)', fontSize: 14, borderTop: '1px solid var(--row-divider)', paddingTop: 8 }}>{inf.rating_notes}</div>
            </Card>
          )}

          <AttributionCard inf={inf} session={session} />
        </div>

        <div style={{ flex: '3 1 460px', minWidth: 'min(320px, 100%)', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card className="ig-up" padding="0" style={{ overflow: 'hidden', animationDelay: '140ms' }}>
            <SectionTitle size={15} style={{ padding: '16px 20px 0', marginBottom: 12 }}>{`Engagements (${data.engagements.length})`}</SectionTitle>
            {data.engagements.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: 14, padding: '0 20px 18px' }}>No engagements yet.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <div style={{ minWidth: 860 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: ENG_COLS, gap: 12, padding: '10px 20px', fontSize: 12, fontWeight: 600, color: 'var(--text-4)', borderTop: '1px solid var(--border)' }}>
                    <span>Engagement #</span><span>Type</span><span>Stage</span><span>Deal</span><span>Post date</span><span>Post</span><span style={{ textAlign: 'right' }}>Total cost</span>
                  </div>
                  {data.engagements.map((e, i) => (
                    <Row key={e.id} columns={ENG_COLS} index={i} animate
                      onClick={() => router.push(`/engagements/detail/?id=${e.id}`)}
                      style={{ padding: '10px 20px' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent-hi)' }}>{e.engagement_no}</span>
                      <span style={{ color: 'var(--text-2)' }}>{e.engagement_type}</span>
                      <span><StagePill stage={e.stage} /></span>
                      <span><DealPill type={e.deal_type} /></span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-2)' }}>
                        {e.post_date || (e.expected_post_date ? <span style={{ color: 'var(--text-4)' }}>{`~${e.expected_post_date}`}</span> : '—')}
                      </span>
                      <span>
                        {e.video_link
                          ? <a href={e.video_link} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()} style={{ color: 'var(--accent-hi)', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 13 }}>View <ExternalLink size={12} strokeWidth={2} /></a>
                          : <span style={{ color: 'var(--text-4)' }}>—</span>}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, textAlign: 'right' }}>₹{Number(e.total_cost || 0).toLocaleString()}</span>
                    </Row>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 14, alignItems: 'start' }}>
            <GrowthCard inf={inf} session={session} canManage={canManage} onChanged={reload} />
            <ShopifyCard inf={inf} session={session} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Business driven (theme ②) — Σ net attributed revenue across all this creator's affiliate
// codes. The "how much has this creator sent us" number.
//
// ⚠️ COMMISSION IS DELIBERATELY NOT SHOWN (Afshaan, 2026-08-26). LOT's affiliate codes are
// TRACKING-ONLY: they attribute revenue, they do not earn the creator a cut. The card used to
// render a commission line that was ₹0.00 on every one of the 65 active codes against
// ₹2,26,161.81 of attributed revenue — which reads as an unpaid debt rather than as "this
// concept does not apply here". Do NOT restore it, and do NOT "fix" the zero by backfilling
// affiliate_pct: the rate is absent because no such rate was ever agreed.
// UGC creator commission (engagements.commission_earned/_paid) is a SEPARATE, real thing —
// leave that alone. See reference/decisions.md.
function AttributionCard({ inf, session }) {
  const [att, setAtt] = useState(null);
  useEffect(() => {
    if (!session || !inf?.id) return;
    ignitionopsGet('getInfluencerAttribution', { influencer_id: inf.id }, session)
      .then(setAtt).catch(() => setAtt(null));
  }, [inf?.id, session]);
  if (!att || (att.codes || 0) === 0) return null;
  return (
    <Card className="ig-up" style={{ animationDelay: '250ms' }}>
      <SectionTitle size={15} style={{ marginBottom: 8 }}>Business driven</SectionTitle>
      <KV label="Net revenue" value={<strong style={{ color: 'var(--accent-hi)', fontFamily: 'var(--font-mono)' }}>₹{Number(att.net_revenue || 0).toLocaleString()}</strong>} />
      <KV label="Redemptions" value={Number(att.redemptions || 0).toLocaleString()} />
      <KV label="Affiliate codes" value={att.codes || 0} />
    </Card>
  );
}

// Slice C — manual reach/growth history. Bar chart up top; the dated snapshots, per-row delete and
// the add form sit in a disclosure (collapsed by default — "+ Log reach" opens it).
function GrowthCard({ inf, session, canManage, onChanged }) {
  const { showToast: toast } = useToast();
  const [metrics, setMetrics] = useState(null);
  const [form, setForm] = useState({ captured_on: '', reach: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  function load() {
    if (!session || !inf?.id) return;
    ignitionopsGet('getInfluencerMetrics', { id: inf.id }, session)
      .then(r => setMetrics(r.metrics || [])).catch(() => setMetrics([]));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [inf?.id, session]);

  async function add() {
    if (!form.captured_on) { toast('Pick a date', 'error'); return; }
    if (form.reach === '' || isNaN(Number(form.reach))) { toast('Enter a reach number', 'error'); return; }
    setBusy(true);
    try {
      await ignitionopsPost('addMetricSnapshot', {
        influencer_id: inf.id,
        captured_on: form.captured_on,
        reach: Number(form.reach),
        note: form.note || undefined,
      }, session);
      toast('Snapshot saved', 'success');
      setForm({ captured_on: '', reach: '', note: '' });
      load();
      onChanged && onChanged();   // refresh parent so current reach updates
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function remove(id) {
    if (!window.confirm('Delete this snapshot?')) return;
    try {
      await ignitionopsPost('deleteMetricSnapshot', { id }, session);
      toast('Snapshot removed', 'success'); load(); onChanged && onChanged();
    } catch (e) { toast(e.message, 'error'); }
  }

  const rows = metrics || [];
  const withReach = rows.filter(m => m.reach != null);
  const first = withReach.length ? Number(withReach[0].reach) : null;
  const last = withReach.length ? Number(withReach[withReach.length - 1].reach) : null;
  const growthPct = (first != null && last != null && first > 0) ? Math.round(((last - first) / first) * 100) : null;
  const delta = (first != null && last != null) ? last - first : null;
  // The chart shows the latest 12 snapshots; the full list stays in the disclosure.
  const bars = withReach.slice(-12).map(m => ({ ...m, reach: Number(m.reach) }));
  const lo = bars.length ? Math.min(...bars.map(b => b.reach)) : 0;
  const hi = bars.length ? Math.max(...bars.map(b => b.reach)) : 0;
  const barH = (v) => hi === lo ? 100 : 15 + ((v - lo) / (hi - lo)) * 85;   // floor so the lowest bar still shows
  const monthOf = (d) => { const t = d ? new Date(`${d}T00:00:00`) : null; return t && !isNaN(t) ? t.toLocaleString('en-IN', { month: 'short' }) : ''; };
  const sinceLabel = withReach[0]?.captured_on ? (() => {
    const t = new Date(`${withReach[0].captured_on}T00:00:00`);
    return isNaN(t) ? withReach[0].captured_on : t.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  })() : '';

  return (
    <Card className="ig-up" style={{ animationDelay: '200ms' }}>
      <SectionTitle size={15} action={canManage ? '+ Log reach' : undefined} onAction={() => setOpen(true)}>Reach history</SectionTitle>
      {metrics == null ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          {withReach.length >= 2 ? (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 96 }}>
                {bars.map((b, i) => (
                  <div key={b.id} title={`${b.captured_on} · ${b.reach.toLocaleString()}`}
                    style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
                    <div className="ig-growy" style={{
                      width: '100%', height: `${barH(b.reach)}%`, borderRadius: '6px 6px 2px 2px',
                      background: i === bars.length - 1 ? 'var(--accent)' : 'var(--border-2)', animationDelay: `${260 + i * 40}ms`,
                    }} />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-4)' }}>{monthOf(b.captured_on).slice(0, 1)}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 12, fontSize: 13 }}>
                <span style={{ color: 'var(--text-3)' }}>Now <b style={{ color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>{last.toLocaleString()}</b></span>
                {delta != null && (
                  <span style={{ fontFamily: 'var(--font-mono)', color: delta >= 0 ? 'var(--state-success-fg)' : 'var(--state-error-fg)' }}>
                    {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toLocaleString()}{growthPct != null ? ` (${Math.abs(growthPct)}%)` : ''} since {sinceLabel}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
              {withReach.length === 1 ? 'One snapshot so far — add another to see the trend.' : 'No snapshots yet.'}
            </div>
          )}

          {(rows.length > 0 || canManage) && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--row-divider)', paddingTop: 10 }}>
              <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="ig-card-action"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }} />
                {`Snapshots (${rows.length})`}
              </button>
              {open && (
                <div className="ig-fade" style={{ marginTop: 10 }}>
                  {rows.length > 0 && (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ textAlign: 'left' }}>
                            <th style={th}>Date</th><th style={{ ...th, textAlign: 'right' }}>Reach</th>
                            <th style={{ ...th, textAlign: 'right' }}>Δ</th><th style={th}>Note</th><th style={th} />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((m, i) => {
                            const prev = i > 0 ? rows[i - 1].reach : null;
                            const d = (m.reach != null && prev != null) ? Number(m.reach) - Number(prev) : null;
                            return (
                              <tr key={m.id} style={{ borderTop: '1px solid var(--row-divider)' }}>
                                <td style={{ ...td, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>{m.captured_on}</td>
                                <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{m.reach != null ? Number(m.reach).toLocaleString() : '—'}</td>
                                <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: d == null ? 'var(--text-4)' : d >= 0 ? 'var(--state-success-fg)' : 'var(--state-error-fg)' }}>
                                  {d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toLocaleString()}`}
                                </td>
                                <td style={{ ...td, color: 'var(--text-3)' }}>{m.note || '—'}</td>
                                <td style={{ ...td, textAlign: 'right' }}>
                                  {canManage && (
                                    <button onClick={() => remove(m.id)} title="Remove" style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>
                                      <Trash2 size={13} />
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {canManage && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
                      <input type="date" value={form.captured_on} onChange={e => setForm(f => ({ ...f, captured_on: e.target.value }))} style={growthInp(140)} title="Snapshot date" />
                      <input type="number" placeholder="Reach" value={form.reach} onChange={e => setForm(f => ({ ...f, reach: e.target.value }))} style={growthInp(110)} />
                      <input placeholder="Note (optional)" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} style={growthInp(150)} />
                      <button onClick={add} disabled={busy} style={saveBtn}>{busy ? 'Saving…' : 'Add snapshot'}</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// Shopify customer match — resolves the influencer's phone/email to a Shopify
// customer + recent orders via the ignitionops getInfluencerShopify action.
// Auto-loads on open (mirrors Pitstop's ShopifyPanel autoLoad). Inert/graceful
// until the SHOPIFY_* secrets are set on the worker (configured:false).
function ShopifyCard({ inf, session }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);

  function lookup() {
    if (!session || !inf) return;
    setLoading(true);
    const params = inf.id ? { id: inf.id } : { code: inf.influencer_code };
    ignitionopsGet('getInfluencerShopify', params, session)
      .then(setState)
      .catch(e => setState({ error: e.message }))
      .finally(() => setLoading(false));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(lookup, [inf?.id, session]);

  const noContact = !inf.contact_number && !inf.email;

  return (
    <Card className="ig-up" style={{ animationDelay: '240ms' }}>
      <SectionTitle size={15} style={{ marginBottom: 8 }}>Shopify orders</SectionTitle>
      {loading && <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Looking up customer…</div>}
      {!loading && state?.error && (
        <div style={{ color: 'var(--state-error-fg)', fontSize: 13 }}>{state.error}</div>
      )}
      {!loading && state && state.configured === false && (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Shopify not connected yet.</div>
      )}
      {!loading && state && state.configured && !state.found && !state.error && (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
          {noContact
            ? 'No phone or email on file — nothing to match against Shopify.'
            : 'No Shopify customer matched this influencer’s phone or email.'}
        </div>
      )}
      {!loading && state?.found && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ color: 'var(--text-1)', fontSize: 15, fontWeight: 700 }}>{state.customer.name || '(no name)'}</span>
            {state.matched_by && (
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-deal)', padding: '2px 8px' }}>
                matched by {state.matched_by}
              </span>
            )}
          </div>
          <KV label="Email" value={state.customer.email || '—'} />
          <KV label="Phone" value={state.customer.phone || '—'} />
          <KV label="Orders" value={state.customer.orders_count ?? '—'} />
          <KV label="Total spent" value={
            state.customer.total_spent != null
              ? `${Number(state.customer.total_spent).toLocaleString()} ${state.customer.currency || ''}`.trim()
              : '—'
          } />
          {state.recent_orders?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {state.recent_orders.map(o => (
                <Fragment key={o.order_no}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 12, padding: '8px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14, alignItems: 'center' }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent-hi)' }}>{o.order_no}</span>{' '}
                      <span style={{ color: 'var(--text-4)', fontSize: 12 }}>{o.created_at ? new Date(o.created_at).toLocaleDateString() : '—'}</span>
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: String(o.fulfillment || '').toUpperCase() === 'FULFILLED' ? 'var(--state-success-fg)' : 'var(--text-3)' }}>{o.financial}/{o.fulfillment}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{o.total != null ? `${Number(o.total).toLocaleString()} ${o.currency || ''}`.trim() : '—'}</span>
                  </div>
                  {o.line_items?.length > 0 && (
                    <div style={{ padding: '0 0 8px 12px' }}>
                      {o.line_items.map((li, i) => (
                        <div key={i} style={{ color: 'var(--text-2)', fontSize: 12 }}>
                          <span style={{ color: 'var(--text-4)' }}>{li.quantity} ×</span>{' '}
                          {li.title}
                          {li.variant && li.variant !== 'Default Title' ? ` — ${li.variant}` : ''}
                          {li.sku ? <span style={{ color: 'var(--text-4)' }}>{`  (${li.sku})`}</span> : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
      {!loading && !state && (
        <button type="button" onClick={lookup} className="ig-ghost-btn" style={editBtn}>Look up Shopify</button>
      )}
    </Card>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '6px 0', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--row-divider)' }}>
      <span style={{ width: 120, flexShrink: 0, color: 'var(--text-3)', fontSize: 13 }}>{label}</span>
      <span style={{ flex: '1 1 160px', minWidth: 0 }}>{children}</span>
    </div>
  );
}

const GENDER_LABELS = { male: 'Male-majority', female: 'Female-majority', balanced: 'Balanced' };

// Multi-select chip picker for a category axis, with an inline "add" that persists
// a new option via onAdd (returns the saved label) and selects it.
function TagPicker({ options, value, onChange, onAdd }) {
  const [adding, setAdding] = useState('');
  const sel = value || [];
  const toggle = (o) => onChange(sel.includes(o) ? sel.filter(x => x !== o) : [...sel, o]);
  // include any already-selected legacy values not in the managed list
  const all = [...options];
  sel.forEach(v => { if (!all.includes(v)) all.push(v); });
  async function commitAdd() {
    const label = adding.trim();
    if (!label) return;
    const lbl = await onAdd(label);
    if (lbl && !sel.includes(lbl)) onChange([...sel, lbl]);
    setAdding('');
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {all.map(o => {
        const on = sel.includes(o);
        return (
          <button type="button" key={o} onClick={() => toggle(o)} style={chip(on)}>{o}</button>
        );
      })}
      <input value={adding} onChange={e => setAdding(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } }}
        onBlur={commitAdd} placeholder="+ add"
        style={{ ...editInput, width: 80, height: 30, padding: '4px 8px' }} />
    </div>
  );
}

// Inputs styled like the Filter select (40px, --input, --border-2, radius --r-ctl).
const editInput = { width: '100%', height: 40, background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)', padding: '0 12px', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' };
const editBtn = { padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const saveBtn = { ...editBtn, background: 'var(--accent)', color: 'var(--accent-fg)', border: '1px solid var(--accent)', fontWeight: 700 };
const chip = (on) => ({
  padding: '4px 10px', cursor: 'pointer', background: on ? 'var(--accent-bg)' : 'var(--chip-neutral)',
  color: on ? 'var(--accent-hi)' : 'var(--text-2)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border-2)'}`,
  borderRadius: 'var(--r-deal)', fontSize: 12, fontWeight: 600,
});

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 }}>
      <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text-1)', textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

const backBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, width: 'max-content' };
const deleteBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 42, padding: '0 14px',
  background: 'transparent', color: 'var(--state-error-fg)', border: '1px solid rgba(255,123,123,.4)',
  borderRadius: 'var(--r-btn)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const newDealBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 42, padding: '0 16px',
  background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-btn)',
  fontSize: 14, fontWeight: 700, cursor: 'pointer',
};
const th = { padding: '8px 10px', fontSize: 12, color: 'var(--text-4)', fontWeight: 600 };
const td = { padding: '8px 10px' };
const growthInp = (w) => ({ height: 36, background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)', padding: '0 10px', fontFamily: 'var(--font-mono)', fontSize: 13, width: w, boxSizing: 'border-box' });
