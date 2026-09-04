'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../lib/ignitionopsFetch.js';
import ProductLinesEditor, { emptyLine, linesToPayload, linesAreValid } from './ProductLinesEditor.js';
import PocSelect from './PocSelect.js';
import SelectedInfluencerCard from './SelectedInfluencerCard.js';

// Quick-add deal (engagement). Essentials only — influencer, type, deal terms,
// product, expected post date (feeds the Schedule). Lands on the new deal to
// fill metrics/links later. `presetInfluencer` prefills when launched from a
// specific influencer.
export function NewDealModal({ open, onClose, session, presetInfluencer, onCreated }) {
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(presetInfluencer || null);
  const [lines, setLines] = useState([emptyLine()]);
  const [productsValid, setProductsValid] = useState(true);
  const [form, setForm] = useState({
    engagement_type: 'video_tracking', deal_type: 'paid',
    expected_post_date: '',
    campaign_id: '',
    payment_amount: '', payment_terms: 'advance', affiliate_pct: '',
    poc_user_id: null, poc_name: null,
  });
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isPaid      = form.deal_type === 'paid' || form.deal_type === 'paid_plus_affiliate';
  const isAffiliate = form.deal_type === 'affiliate' || form.deal_type === 'paid_plus_affiliate';

  useEffect(() => { setSelected(presetInfluencer || null); }, [presetInfluencer, open]);

  // Campaign list for the picker (Reann #3). Loaded once the modal opens rather than on mount,
  // so a page that never opens it pays nothing.
  const [campaigns, setCampaigns] = useState([]);
  useEffect(() => {
    if (!session || !open) return;
    ignitionopsGet('getCampaigns', { status: 'active' }, session)
      .then(r => setCampaigns(r.campaigns || []))
      .catch(() => setCampaigns([]));
  }, [session, open]);

  useEffect(() => {
    if (!session || search.length < 2) { setResults([]); return; }
    ignitionopsGet('getInfluencers', { search, limit: 8 }, session)
      .then(r => setResults(r.influencers || []))
      .catch(() => setResults([]));
  }, [search, session]);

  async function submit() {
    if (!selected) { setErr('Pick an influencer first'); return; }
    // Every product line must resolve to a real catalogue product (2026-09-04). Confirm is
    // disabled too — this is the guard that holds if a blur lands in the same tick as the click.
    if (!productsValid || !linesAreValid(lines)) { setErr('Pick a product from the list for every line'); return; }
    setBusy(true); setErr(null);
    try {
      const payload = { influencer_id: selected.id, ...form };
      if (!payload.expected_post_date) delete payload.expected_post_date;
      if (!payload.campaign_id) delete payload.campaign_id;
      // Compensation only applies to paid deals; affiliate % only to affiliate deals.
      if (isPaid && payload.payment_amount !== '') payload.payment_amount = Number(payload.payment_amount);
      else { delete payload.payment_amount; delete payload.payment_terms; }
      if (isAffiliate && payload.affiliate_pct !== '') payload.affiliate_pct = Number(payload.affiliate_pct);
      else delete payload.affiliate_pct;
      const products = linesToPayload(lines);
      if (products.length) payload.products = products;
      const res = await ignitionopsPost('createEngagement', payload, session);
      toast(`Created ${res.engagement_no}`, 'success');
      onClose?.();
      onCreated ? onCreated(res) : router.push(`/engagements/detail/?id=${res.id}`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Deal"
      confirmLabel={busy ? 'Creating…' : 'Create Deal'} confirmColor="#FF6B00"
      onConfirm={submit} confirmDisabled={!productsValid} loading={busy} error={err}>
      <div style={{ marginBottom: 14 }}>
        <div style={lbl}>Influencer *</div>
        {selected ? (
          <SelectedInfluencerCard
            influencer={selected}
            onChange={presetInfluencer ? null : () => setSelected(null)}
          />
        ) : (
          <>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search code, handle, name…" style={inp} />
            {results.length > 0 && (
              <div style={{ marginTop: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 180, overflowY: 'auto' }}>
                {results.map(r => (
                  <div key={r.id} onClick={() => { setSelected(r); setSearch(''); setResults([]); }}
                    style={{ padding: 9, cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.influencer_code}</span>
                    <span style={{ marginLeft: 8 }}>{r.channel_name || r.person_name || '—'}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-3)' }}>{r.influencer_type}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Engagement type">
          <select value={form.engagement_type} onChange={e => setField('engagement_type', e.target.value)} style={inp}>
            <option value="video_tracking">Video</option>
            <option value="ugc">UGC</option>
          </select>
        </Field>
        <Field label="Deal type">
          <select value={form.deal_type} onChange={e => setField('deal_type', e.target.value)} style={inp}>
            <option value="paid">Paid</option>
            <option value="barter">Barter</option>
            <option value="affiliate">Affiliate</option>
            <option value="paid_plus_affiliate">Paid + Affiliate</option>
          </select>
        </Field>
        {isPaid && (
          <>
            <Field label="Compensation (₹)">
              <input type="number" min="0" value={form.payment_amount}
                onChange={e => setField('payment_amount', e.target.value)} placeholder="e.g. 5000" style={inp} />
            </Field>
            <Field label="Payment terms">
              <select value={form.payment_terms} onChange={e => setField('payment_terms', e.target.value)} style={inp}>
                <option value="advance">Advance</option>
                <option value="on_draft">On Draft</option>
                <option value="on_release">On Release</option>
                <option value="n_a">N/A</option>
              </select>
            </Field>
          </>
        )}
        {isAffiliate && (
          <Field label="Affiliate % agreed">
            <input type="number" min="0" max="100" step="0.1" value={form.affiliate_pct}
              onChange={e => setField('affiliate_pct', e.target.value)} placeholder="e.g. 10" style={inp} />
          </Field>
        )}
        <Field label="POC">
          <PocSelect
            value={form.poc_user_id}
            onChange={({ poc_user_id, poc_name }) => setForm(f => ({ ...f, poc_user_id, poc_name }))}
            session={session}
            style={inp}
          />
        </Field>
        <Field label="Expected post date">
          <input type="date" value={form.expected_post_date} onChange={e => setField('expected_post_date', e.target.value)} style={inp} />
        </Field>
        {/* Reann #3 (S273) — a real campaign, not a typed tag. The free-text campaign_tag it
            replaced produced 4 spellings of 3 campaigns; picking from the list keeps one truth. */}
        <Field label="Campaign">
          <select value={form.campaign_id} onChange={e => setField('campaign_id', e.target.value)} style={inp}>
            <option value="">— none —</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name || c.campaign_no}</option>)}
          </select>
        </Field>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={lbl}>Products</div>
        <ProductLinesEditor value={lines} onChange={setLines} session={session} onValidityChange={setProductsValid} />
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={lbl}>{label}</div>
      {children}
    </div>
  );
}
const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const ghost = { padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
