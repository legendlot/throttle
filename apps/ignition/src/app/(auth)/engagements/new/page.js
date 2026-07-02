'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { useToast, Spinner } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import ProductLinesEditor, { emptyLine, linesToPayload } from '../../../../components/ProductLinesEditor.js';
import PocSelect from '../../../../components/PocSelect.js';

export default function NewEngagementPage() {
  const { session } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [influencerSearch, setInfluencerSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState([emptyLine()]);
  const [form, setForm] = useState({
    engagement_type: 'video_tracking',
    deal_type: 'paid',
    payment_terms: 'on_release',
    payment_amount: 0,
    directed_to: 'website',
    expected_post_date: '',
    poc_user_id: null,
    poc_name: null,
  });

  useEffect(() => {
    if (!session || influencerSearch.length < 2) { setSearchResults([]); return; }
    ignitionopsGet('getInfluencers', { search: influencerSearch, limit: 8 }, session)
      .then(r => setSearchResults(r.influencers || []))
      .catch(() => setSearchResults([]));
  }, [influencerSearch, session]);

  function setField(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function submit() {
    if (!selected) { toast('Pick an influencer', 'error'); return; }
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 12, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
            <div>
              <span style={{ color: '#FF6B00', fontWeight: 700 }}>{selected.influencer_code}</span>
              <span style={{ marginLeft: 12 }}>{selected.channel_name || selected.person_name}</span>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{selected.influencer_type} · {selected.location}</div>
            </div>
            <button onClick={() => setSelected(null)} style={btnGhost}>Change</button>
          </div>
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
        <ProductLinesEditor value={lines} onChange={setLines} session={session} />
      </section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={() => router.back()} style={btnGhost}>Cancel</button>
        <button onClick={submit} disabled={!selected || busy} style={{ ...btnPrimary, opacity: !selected || busy ? 0.5 : 1 }}>
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
