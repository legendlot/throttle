'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { useToast, Spinner } from '@throttle/ui';
import { ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import ProductLinesEditor from '../../../../components/ProductLinesEditor.js';
import { useDealForm } from '../../../../lib/useDealForm.js';
import PocSelect from '../../../../components/PocSelect.js';
import SelectedInfluencerCard from '../../../../components/SelectedInfluencerCard.js';

export default function NewEngagementPage() {
  const { session } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  // P0.3 (S412) — state, search, campaigns, payload and create are shared with NewDealModal.
  const deal = useDealForm({ session, initial: { directed_to: 'website' } });
  const {
    form, setForm, setField, isPaid, isAffiliate,
    selected, setSelected, search: influencerSearch, setSearch: setInfluencerSearch, results: searchResults, pick,
    lines, setLines, productsValid, setProductsValid,
    campaigns: campaignOpts, loadCampaigns, busy,
  } = deal;

  const [newCampaign, setNewCampaign] = useState('');
  const [creatingCampaign, setCreatingCampaign] = useState(false);

  // Deal-time creation is kept on purpose: the field this replaced was free text precisely so a
  // campaign could be named as the deal is struck. Forcing a trip to /campaigns first is what
  // makes people leave it blank.
  async function createCampaignInline() {
    const nm = newCampaign.trim();
    if (!nm) return;
    setCreatingCampaign(true);
    try {
      const c = await ignitionopsPost('createCampaign', { name: nm }, session);
      setNewCampaign('');
      loadCampaigns();
      if (c?.id) setField('campaign_id', c.id);
    } catch (e) { toast(e.message, 'error'); }
    finally { setCreatingCampaign(false); }
  }

  async function submit() {
    const why = deal.problem();
    if (why) { toast(why, 'error'); return; }
    try {
      const res = await deal.create();
      toast(`Created ${res.engagement_no}`, 'success');
      router.push(`/engagements/detail/?id=${res.id}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 16 }}>
        New Deal
      </h1>

      <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 12 }}>
        <h2 style={hd}>Influencer</h2>
        {selected ? (
          <SelectedInfluencerCard influencer={selected} onChange={() => setSelected(null)} />
        ) : (
          <>
            <input
              data-search-primary
              placeholder="Search code, handle, name…"
              value={influencerSearch}
              onChange={e => setInfluencerSearch(e.target.value)}
              style={inputStyle('100%')}
            />
            {searchResults.length > 0 && (
              <div style={{ marginTop: 8, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                {searchResults.map(r => (
                  <div key={r.id} onClick={() => pick(r)}
                    style={{ padding: 10, cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.influencer_code}</span>
                    <span style={{ marginLeft: 10 }}>{r.channel_name || r.person_name || '—'}</span>
                    <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--text-3)' }}>{r.influencer_type}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 12 }}>
        <h2 style={hd}>Deal Terms</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Engagement type">
            <select value={form.engagement_type} onChange={e => setField('engagement_type', e.target.value)} style={inputStyle('100%')}>
              <option value="video_tracking">Video</option>
              <option value="ugc">UGC</option>
            </select>
          </Field>
          <Field label="Deal type">
            <select value={form.deal_type} onChange={e => setField('deal_type', e.target.value)} style={inputStyle('100%')}>
              <option value="paid">Paid</option>
              <option value="barter">Barter</option>
              <option value="affiliate">Affiliate</option>
              <option value="paid_plus_affiliate">Paid + Affiliate</option>
            </select>
          </Field>
          {/* D7 (S412): the modal's rule — payment only for paid deals, affiliate % only for
              affiliate deals. This page used to show payment on every type, defaulting to on_release. */}
          {isPaid && (
            <>
              <Field label="Payment terms">
                <select value={form.payment_terms} onChange={e => setField('payment_terms', e.target.value)} style={inputStyle('100%')}>
                  <option value="advance">Advance</option>
                  <option value="on_draft">On Draft</option>
                  <option value="on_release">On Release</option>
                  <option value="n_a">N/A</option>
                </select>
              </Field>
              <Field label="Payment amount (₹)">
                <input type="number" min="0" value={form.payment_amount} onChange={e => setField('payment_amount', e.target.value)} placeholder="e.g. 5000" style={inputStyle('100%')} />
              </Field>
            </>
          )}
          {isAffiliate && (
            <Field label="Affiliate % agreed">
              <input type="number" min="0" max="100" step="0.1" value={form.affiliate_pct}
                onChange={e => setField('affiliate_pct', e.target.value)} placeholder="e.g. 10" style={inputStyle('100%')} />
            </Field>
          )}
          <Field label="Directed to">
            <select value={form.directed_to} onChange={e => setField('directed_to', e.target.value)} style={inputStyle('100%')}>
              <option value="website">Website</option>
              <option value="amazon">Amazon</option>
              <option value="flipkart">Flipkart</option>
            </select>
          </Field>
          <Field label="Campaign">
            <select value={form.campaign_id} onChange={e => setField('campaign_id', e.target.value)} style={inputStyle('100%')}>
              <option value="">— none —</option>
              {campaignOpts.map(c => <option key={c.id} value={c.id}>{c.name || c.campaign_no}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input value={newCampaign} onChange={e => setNewCampaign(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createCampaignInline(); } }}
                placeholder="or start a new campaign…" style={{ ...inputStyle('100%'), fontSize: 12 }} />
              <button type="button" onClick={createCampaignInline} disabled={!newCampaign.trim() || creatingCampaign}
                style={{ padding: '0 10px', fontSize: 12, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                         background: 'transparent', color: 'var(--text-2)', cursor: newCampaign.trim() ? 'pointer' : 'default',
                         opacity: newCampaign.trim() && !creatingCampaign ? 1 : 0.5, whiteSpace: 'nowrap' }}>
                {creatingCampaign ? 'Adding…' : 'Add'}
              </button>
            </div>
          </Field>
          <Field label="Expected post date">
            <input type="date" value={form.expected_post_date} onChange={e => setField('expected_post_date', e.target.value)} style={inputStyle('100%')} />
          </Field>
          <Field label="POC">
            <PocSelect
              value={form.poc_user_id}
              onChange={({ poc_user_id, poc_name }) => setForm(f => ({ ...f, poc_user_id, poc_name }))}
              session={session}
              style={inputStyle('100%')}
            />
          </Field>
        </div>
      </section>

      <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 12 }}>
        <h2 style={hd}>Products</h2>
        <ProductLinesEditor value={lines} onChange={setLines} session={session} onValidityChange={setProductsValid} />
      </section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={() => router.back()} style={btnGhost}>Cancel</button>
        <button onClick={submit} disabled={!selected || busy || !productsValid} style={{ ...btnPrimary, opacity: (!selected || busy || !productsValid) ? 0.5 : 1 }}>
          {busy ? 'Creating…' : 'Create Engagement'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const hd = { fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 };
function inputStyle(w) {
  return {
    background: 'var(--surface-2)', color: 'var(--text-1)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
    width: w,
  };
}
const btnPrimary = {
  padding: '10px 18px', background: '#FF6B00', color: '#fff',
  border: 'none', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
const btnGhost = {
  padding: '10px 18px', background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};
