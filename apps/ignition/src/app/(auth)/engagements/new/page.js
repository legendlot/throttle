'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { useToast, Spinner } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import ProductLinesEditor, { emptyLine, linesToPayload, linesAreValid } from '../../../../components/ProductLinesEditor.js';
import PocSelect from '../../../../components/PocSelect.js';
import SelectedInfluencerCard from '../../../../components/SelectedInfluencerCard.js';

export default function NewEngagementPage() {
  const { session } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [influencerSearch, setInfluencerSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState([emptyLine()]);
  const [productsValid, setProductsValid] = useState(true);
  const [form, setForm] = useState({
    engagement_type: 'video_tracking',
    deal_type: 'paid',
    payment_terms: 'on_release',
    payment_amount: 0,
    directed_to: 'website',
    campaign_id: '',
    expected_post_date: '',
    poc_user_id: null,
    poc_name: null,
  });

  // Reann #3 (S273) — real campaigns replace the free-text tag AND the category_options
  // 'campaign' axis that backed its suggestions (that axis is retired; it never had any rows).
  const [campaignOpts, setCampaignOpts] = useState([]);
  const [newCampaign, setNewCampaign] = useState('');
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  function loadCampaigns() {
    if (!session) return;
    ignitionopsGet('getCampaigns', { status: 'active' }, session)
      .then(r => setCampaignOpts(r.campaigns || []))
      .catch(() => setCampaignOpts([]));
  }
  useEffect(loadCampaigns, [session]);

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

  useEffect(() => {
    if (!session || influencerSearch.length < 2) { setSearchResults([]); return; }
    ignitionopsGet('getInfluencers', { search: influencerSearch, limit: 8 }, session)
      .then(r => setSearchResults(r.influencers || []))
      .catch(() => setSearchResults([]));
  }, [influencerSearch, session]);

  function setField(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function submit() {
    if (!selected) { toast('Pick an influencer', 'error'); return; }
    // Every product line must resolve to a real catalogue product (2026-09-04). The button is
    // disabled too — this is the guard that holds if a blur lands in the same tick as the click.
    if (!productsValid || !linesAreValid(lines)) { toast('Pick a product from the list for every line', 'error'); return; }
    setBusy(true);
    try {
      const products = linesToPayload(lines);
      const payload = {
        influencer_id: selected.id,
        ...form,
        payment_amount: Number(form.payment_amount) || 0,
        ...(products.length ? { products } : {}),
      };
      if (!payload.expected_post_date) delete payload.expected_post_date;
      if (!payload.campaign_id) delete payload.campaign_id;
      const res = await ignitionopsPost('createEngagement', payload, session);
      toast(`Created ${res.engagement_no}`, 'success');
      router.push(`/engagements/detail/?id=${res.id}`);
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
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
                  <div key={r.id} onClick={() => { setSelected(r); setInfluencerSearch(''); setSearchResults([]); }}
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
          <Field label="Payment terms">
            <select value={form.payment_terms} onChange={e => setField('payment_terms', e.target.value)} style={inputStyle('100%')}>
              <option value="advance">Advance</option>
              <option value="on_draft">On Draft</option>
              <option value="on_release">On Release</option>
              <option value="n_a">N/A</option>
            </select>
          </Field>
          <Field label="Payment amount (₹)">
            <input type="number" value={form.payment_amount} onChange={e => setField('payment_amount', e.target.value)} style={inputStyle('100%')} />
          </Field>
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
