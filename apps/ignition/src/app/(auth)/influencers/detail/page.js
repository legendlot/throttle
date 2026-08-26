'use client';
import { useEffect, useState, Fragment } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, Trash2, Plus } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import { channelLinkError, normalizeChannelLink } from '../../../../lib/channelLink.js';
import { NewDealModal } from '../../../../components/NewDealModal.js';
import RatingBadge from '../../../../components/RatingBadge.js';
import StageBadge from '../../../../components/StageBadge.js';
import DealTypeBadge from '../../../../components/DealTypeBadge.js';

export default function InfluencerDetailPage() {
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
        location: form.location.trim() || null,
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

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!data) return <Spinner />;
  const inf = data.influencer;

  return (
    <div style={{ maxWidth: 1400 }}>
      <button onClick={() => router.back()} style={backBtn}>
        <ArrowLeft size={14} strokeWidth={2} /> Back
      </button>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ color: '#FF6B00', fontWeight: 700, fontSize: 18 }}>{inf.influencer_code}</span>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {inf.channel_name || inf.person_name || '(no name)'}
        </h1>
        <RatingBadge rating={inf.quality_rating} />
        {inf.do_not_ship && (
          <span title={inf.do_not_ship_reason || 'Do not ship'} style={{ fontSize: 11, color: 'var(--state-error-fg)', border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Do not ship</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {['green','yellow','red','unrated'].map(r => (
            <button key={r} onClick={() => setRating(r)} style={ratingBtn}>{r}</button>
          ))}
          {canManage && (
            <button onClick={() => setShowDeal(true)} title="Create a deal for this influencer" style={newDealBtn}>
              <Plus size={13} strokeWidth={2.4} /> New deal
            </button>
          )}
          {canManage && (
            <button onClick={removeInfluencer} title="Delete influencer" style={deleteBtn}>
              <Trash2 size={13} strokeWidth={2} /> Delete
            </button>
          )}
        </div>
      </div>

      {canManage && (
        <NewDealModal
          open={showDeal}
          onClose={() => setShowDeal(false)}
          session={session}
          presetInfluencer={inf}
          onCreated={() => { setShowDeal(false); reload(); }}
        />
      )}

      {/* Two-column: narrow left (identity/contact), wide right (engagements/shopify).
          flex-wrap stacks them on narrow viewports so it never breaks on a laptop. */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 300px', minWidth: 280, maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title="Identity" action={
            editing
              ? <span style={{ display: 'flex', gap: 6 }}>
                  <button onClick={saveEdit} disabled={saving} style={saveBtn}>{saving ? 'Saving…' : 'Save'}</button>
                  <button onClick={() => setEditing(false)} disabled={saving} style={editBtn}>Cancel</button>
                </span>
              : (canManage ? <button onClick={startEdit} style={editBtn}>Edit</button> : null)
          }>
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
                          style={{ padding: '4px 10px', cursor: 'pointer', background: on ? 'rgba(255,107,0,0.12)' : 'var(--surface-2)', color: on ? '#FF6B00' : 'var(--text-2)', border: `1px solid ${on ? '#FF6B00' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{o}</button>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Type"><select style={editInput} value={form.influencer_type} onChange={e => setF('influencer_type', e.target.value)}><option value="">—</option>{['nano', 'micro', 'macro', 'brand', 'store'].map(o => <option key={o} value={o}>{o}</option>)}</select></Field>
                <Field label="Content tags"><TagPicker options={catalogs?.category_options?.format || []} value={form.categories || []} onChange={v => setF('categories', v)} onAdd={lbl => addCatOption('format', lbl)} /></Field>
                <Field label="Audience niche"><TagPicker options={catalogs?.category_options?.niche || []} value={form.audience_niches || []} onChange={v => setF('audience_niches', v)} onAdd={lbl => addCatOption('niche', lbl)} /></Field>
                <Field label="Reach"><input style={editInput} type="number" value={form.reach} onChange={e => setF('reach', e.target.value)} /></Field>
                <Field label="Follower count"><input style={editInput} type="number" value={form.follower_count} onChange={e => setF('follower_count', e.target.value)} /></Field>
                <Field label="Audience notes"><input style={editInput} value={form.audience} onChange={e => setF('audience', e.target.value)} placeholder="free-form notes" /></Field>
                <Field label="Audience age"><select style={editInput} value={form.age_range} onChange={e => setF('age_range', e.target.value)}><option value="">—</option>{(catalogs?.age_ranges || []).map(o => <option key={o} value={o}>{o}</option>)}</select></Field>
                <Field label="Gender majority"><select style={editInput} value={form.gender_majority} onChange={e => setF('gender_majority', e.target.value)}><option value="">—</option>{(catalogs?.gender_majorities || []).map(o => <option key={o} value={o}>{GENDER_LABELS[o] || o}</option>)}</select></Field>
                <Field label="Location"><input style={editInput} value={form.location} onChange={e => setF('location', e.target.value)} /></Field>
              </>
            ) : (
              <>
                <KV label="Channel link" value={inf.channel_link ? <a href={inf.channel_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>{inf.channel_link}</a> : '—'} />
                <KV label="Platforms" value={(inf.channel_platforms?.length ? inf.channel_platforms.join(', ') : inf.channel_platform) || '—'} />
                <KV label="Type" value={inf.influencer_type || '—'} />
                <KV label="Content tags" value={(inf.categories || []).join(', ') || '—'} />
                <KV label="Audience niche" value={(inf.audience_niches || []).join(', ') || '—'} />
                <KV label="Reach" value={inf.reach?.toLocaleString() || '—'} />
                <KV label="Followers" value={inf.follower_count?.toLocaleString() || '—'} />
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

          <Card title="Contact">
            {editing ? (
              <>
                <Field label="POC type"><select style={editInput} value={form.contact_poc_type} onChange={e => setF('contact_poc_type', e.target.value)}><option value="">—</option>{['manager', 'influencer', 'agency'].map(o => <option key={o} value={o}>{o}</option>)}</select></Field>
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
            <Card title="Rating notes">
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{inf.rating_notes}</div>
            </Card>
          )}

          <AttributionCard inf={inf} session={session} />
        </div>

        <div style={{ flex: '3 1 460px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title={`Engagements (${data.engagements.length})`}>
            {data.engagements.length === 0 ? (
              <div style={{ color: 'var(--text-3)' }}>No engagements yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                    <th style={th}>Engagement #</th><th style={th}>Type</th><th style={th}>Stage</th>
                    <th style={th}>Deal</th><th style={th}>Post date</th><th style={th}>Post</th><th style={th}>Total cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.engagements.map(e => (
                    <tr key={e.id} onClick={() => router.push(`/engagements/detail/?id=${e.id}`)}
                      style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                      <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{e.engagement_no}</span></td>
                      <td style={td}>{e.engagement_type}</td>
                      <td style={td}><StageBadge stage={e.stage} /></td>
                      <td style={td}><DealTypeBadge dealType={e.deal_type} /></td>
                      <td style={td}>{e.post_date || (e.expected_post_date ? <span style={{ color: 'var(--text-3)' }}>{`~${e.expected_post_date}`}</span> : '—')}</td>
                      <td style={td}>
                        {e.video_link
                          ? <a href={e.video_link} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()} style={{ color: '#FF6B00', display: 'inline-flex', alignItems: 'center', gap: 3 }}>View <ExternalLink size={12} strokeWidth={2} /></a>
                          : <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </td>
                      <td style={td}>₹{Number(e.total_cost || 0).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <GrowthCard inf={inf} session={session} canManage={canManage} onChanged={reload} />

          <ShopifyCard inf={inf} session={session} />
        </div>
      </div>
    </div>
  );
}

// Business driven (theme ②) — Σ net attributed revenue + commission across all this
// creator's affiliate codes. The "how much has this creator sent us" number.
function AttributionCard({ inf, session }) {
  const [att, setAtt] = useState(null);
  useEffect(() => {
    if (!session || !inf?.id) return;
    ignitionopsGet('getInfluencerAttribution', { influencer_id: inf.id }, session)
      .then(setAtt).catch(() => setAtt(null));
  }, [inf?.id, session]);
  if (!att || (att.codes || 0) === 0) return null;
  return (
    <Card title="Business driven">
      <KV label="Net revenue" value={<strong style={{ color: '#FF6B00' }}>₹{Number(att.net_revenue || 0).toLocaleString()}</strong>} />
      <KV label="Redemptions" value={(att.redemptions || 0).toLocaleString()} />
      <KV label="Commission" value={`₹${Number(att.commission || 0).toLocaleString()}`} />
      <KV label="Affiliate codes" value={att.codes || 0} />
    </Card>
  );
}

// Slice C — manual reach/growth history. Sparkline + dated snapshots + add form.
function GrowthCard({ inf, session, canManage, onChanged }) {
  const { showToast: toast } = useToast();
  const [metrics, setMetrics] = useState(null);
  const [form, setForm] = useState({ captured_on: '', reach: '', note: '' });
  const [busy, setBusy] = useState(false);

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
  const first = withReach[0]?.reach;
  const last = withReach[withReach.length - 1]?.reach;
  const growthPct = (first != null && last != null && first > 0) ? Math.round(((last - first) / first) * 100) : null;

  return (
    <Card title="Growth (reach over time)">
      {metrics == null ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          {withReach.length >= 2 ? (
            <>
              <Sparkline points={withReach.map(m => Number(m.reach))} />
              <div style={{ display: 'flex', gap: 16, margin: '8px 0 4px', fontSize: 12, color: 'var(--text-3)' }}>
                <span>From <b style={{ color: 'var(--text-1)' }}>{first.toLocaleString()}</b> → <b style={{ color: 'var(--text-1)' }}>{last.toLocaleString()}</b></span>
                {growthPct != null && (
                  <span style={{ color: growthPct >= 0 ? 'var(--state-success-fg)' : 'var(--state-error-fg)', fontWeight: 700 }}>
                    {growthPct >= 0 ? '▲' : '▼'} {Math.abs(growthPct)}%
                  </span>
                )}
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 8 }}>
              {withReach.length === 1 ? 'One snapshot so far — add another to see the trend.' : 'No snapshots yet.'}
            </div>
          )}

          {rows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  <th style={th}>Date</th><th style={{ ...th, textAlign: 'right' }}>Reach</th>
                  <th style={{ ...th, textAlign: 'right' }}>Δ</th><th style={th}>Note</th><th style={th} />
                </tr>
              </thead>
              <tbody>
                {rows.map((m, i) => {
                  const prev = i > 0 ? rows[i - 1].reach : null;
                  const delta = (m.reach != null && prev != null) ? m.reach - prev : null;
                  return (
                    <tr key={m.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{m.captured_on}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{m.reach != null ? m.reach.toLocaleString() : '—'}</td>
                      <td style={{ ...td, textAlign: 'right', color: delta == null ? 'var(--text-3)' : delta >= 0 ? 'var(--state-success-fg)' : 'var(--state-error-fg)' }}>
                        {delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`}
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
          )}

          {canManage && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
              <input type="date" value={form.captured_on} onChange={e => setForm(f => ({ ...f, captured_on: e.target.value }))} style={growthInp(140)} title="Snapshot date" />
              <input type="number" placeholder="Reach" value={form.reach} onChange={e => setForm(f => ({ ...f, reach: e.target.value }))} style={growthInp(110)} />
              <input placeholder="Note (optional)" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} style={growthInp(150)} />
              <button onClick={add} disabled={busy} style={saveBtn}>{busy ? 'Saving…' : 'Add snapshot'}</button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// Minimal hand-rolled SVG line chart (no chart lib) for the reach series.
function Sparkline({ points }) {
  const W = 320, H = 48, pad = 4;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const stepX = points.length > 1 ? (W - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((v, i) => {
    const x = pad + i * stepX;
    const y = H - pad - ((v - min) / span) * (H - pad * 2);
    return [x, y];
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <path d={line} fill="none" stroke="#FF6B00" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {coords.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.5" fill="#FF6B00" />)}
    </svg>
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
    <Card title="Shopify">
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ color: 'var(--text-1)', fontSize: 15, fontWeight: 700 }}>{state.customer.name || '(no name)'}</span>
            {state.matched_by && (
              <span style={{ fontSize: 10, color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  <th style={th}>Order</th><th style={th}>Date</th><th style={th}>Status</th><th style={th}>Total</th>
                </tr>
              </thead>
              <tbody>
                {state.recent_orders.map(o => (
                  <Fragment key={o.order_no}>
                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{o.order_no}</span></td>
                      <td style={td}>{o.created_at ? new Date(o.created_at).toLocaleDateString() : '—'}</td>
                      <td style={td}>{o.financial}/{o.fulfillment}</td>
                      <td style={td}>{o.total != null ? `${Number(o.total).toLocaleString()} ${o.currency || ''}`.trim() : '—'}</td>
                    </tr>
                    {o.line_items?.length > 0 && (
                      <tr>
                        <td style={{ padding: '0 10px 8px 10px' }} colSpan={4}>
                          {o.line_items.map((li, i) => (
                            <div key={i} style={{ color: 'var(--text-2)', fontSize: 12, paddingLeft: 12 }}>
                              <span style={{ color: 'var(--text-3)' }}>{li.quantity} ×</span>{' '}
                              {li.title}
                              {li.variant && li.variant !== 'Default Title' ? ` — ${li.variant}` : ''}
                              {li.sku ? <span style={{ color: 'var(--text-3)' }}>{`  (${li.sku})`}</span> : ''}
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {!loading && !state && (
        <button type="button" onClick={lookup} style={ratingBtn}>Look up Shopify</button>
      )}
    </Card>
  );
}

function Card({ title, children, action }) {
  return (
    <section style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
        <h2 style={{
          fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em',
          textTransform: 'uppercase', margin: 0,
        }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '4px 0', alignItems: 'center' }}>
      <span style={{ width: 140, color: 'var(--text-3)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ flex: 1 }}>{children}</span>
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
          <button type="button" key={o} onClick={() => toggle(o)}
            style={{ padding: '4px 10px', cursor: 'pointer', background: on ? 'rgba(255,107,0,0.12)' : 'var(--surface-2)', color: on ? '#FF6B00' : 'var(--text-2)', border: `1px solid ${on ? '#FF6B00' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{o}</button>
        );
      })}
      <input value={adding} onChange={e => setAdding(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } }}
        onBlur={commitAdd} placeholder="+ add"
        style={{ ...editInput, width: 80, padding: '4px 8px' }} />
    </div>
  );
}

const editInput = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' };
const editBtn = { padding: '4px 10px', background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const saveBtn = { ...editBtn, background: '#FF6B00', color: '#fff', border: '1px solid #FF6B00' };

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
      <span style={{ width: 140, color: 'var(--text-3)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--text-1)', fontSize: 13, flex: 1 }}>{value}</span>
    </div>
  );
}

const backBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14,
  background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '6px 12px',
  fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
};
const ratingBtn = {
  padding: '4px 8px', background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const deleteBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 8,
  padding: '4px 10px', background: 'transparent', color: 'var(--state-error-fg, #e5484d)',
  border: '1px solid var(--state-error-fg, #e5484d)', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const newDealBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 8,
  padding: '4px 12px', background: '#FF6B00', color: '#fff',
  border: 'none', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const th = { padding: '8px 10px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '8px 10px' };
const growthInp = (w) => ({ background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13, width: w, boxSizing: 'border-box' });
