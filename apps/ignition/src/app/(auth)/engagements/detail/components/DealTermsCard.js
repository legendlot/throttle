'use client';
import { useEffect, useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { DEAL_TYPE_VALUES, DEAL_TYPE_LABELS, PAYMENT_TERMS, PAYMENT_TERMS_LABELS } from '../../../../../lib/dealTypes.js';
import { Card, LockedNote, KV } from './shared.js';
import { CostEdit } from './CostsCard.js';

// Deal Terms — editable since S309 (Reann, #bugs 2026-08-18 batch, items 2 + 3).
//
// Both gaps were UI-only; the worker already accepted every field here. `deal_type`,
// `payment_terms`, `payment_amount`, `affiliate_pct`, `commission_amount` AND
// `campaign_id` are all in ENGAGEMENT_FIELDS, so this saves in ONE updateEngagement
// call rather than a PATCH plus a separate assignEngagementToCampaign. That also
// matters for correctness, not just tidiness: updateEngagement calls recomputeCpm,
// and payment_amount feeds total_cost feeds CPM. Assigning the campaign through the
// dedicated endpoint would skip that.
//
// Campaign could always be set at deal CREATION, and removed/added from the campaign
// side at /campaigns/detail — but never from the deal itself, which is where Reann
// works. 295 of 335 deals carried no campaign when this shipped (measured 2026-08-25).
export function DealTermsCard({ e, paidTotal, canEdit, locked, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [campaigns, setCampaigns] = useState([]);
  const [f, setF] = useState({});

  // The picker's list loads ONLY when the card is opened for editing — the read view
  // does not need it, because getEngagement embeds `campaign:campaign_id(id,name)`.
  // Without that embed this would show "—" on every deal that HAS a campaign until
  // someone pressed Edit.
  useEffect(() => {
    if (!editing || !session) return;
    ignitionopsGet('getCampaigns', { status: 'active' }, session)
      .then(r => setCampaigns(r.campaigns || []))
      .catch(() => setCampaigns([]));
  }, [editing, session]);

  const campaignName = e.campaign?.name || campaigns.find(c => c.id === e.campaign_id)?.name || null;

  function startEdit() {
    setF({
      deal_type: e.deal_type || 'paid',
      // NOT defaulted to 'n_a'. payment_terms is NULL on 238 of 335 deals (measured
      // 2026-08-25) and NULL means "never recorded", which is not the same statement
      // as "N/A". Defaulting here would stamp a definite N_A onto every one of those
      // the first time someone opened this card to change something else entirely.
      payment_terms: e.payment_terms || '',
      payment_amount: e.payment_amount ?? '',
      affiliate_pct: e.affiliate_pct ?? '',
      commission_amount: e.commission_amount ?? '',
      campaign_id: e.campaign_id || '',
      // Reann #4 — ad rights. '' is the third state ("not recorded"), NOT a No; see the
      // column comment on ignition.engagements.ad_rights.
      ad_rights: e.ad_rights == null ? '' : (e.ad_rights ? 'yes' : 'no'),
      ad_rights_amount: e.ad_rights_amount ?? '',
      ad_rights_duration: e.ad_rights_duration || '',
    });
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
      await ignitionopsPost('updateEngagement', {
        engagement_id: e.id,
        deal_type: f.deal_type,
        payment_terms: f.payment_terms || null,
        payment_amount: numOrNull(f.payment_amount),
        affiliate_pct: numOrNull(f.affiliate_pct),
        commission_amount: numOrNull(f.commission_amount),
        // '' means "no campaign" — send null so the worker detaches rather than
        // failing the FK on an empty string.
        campaign_id: f.campaign_id || null,
        ad_rights: f.ad_rights === '' ? null : f.ad_rights === 'yes',
        ad_rights_amount: numOrNull(f.ad_rights_amount),
        ad_rights_duration: f.ad_rights_duration || null,
      }, session);
      toast('Deal terms updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const agreed = Number(e.payment_amount || 0);
  const paid = Number(paidTotal || 0);
  const done = agreed > 0 && paid >= agreed;

  return (
    <Card title="Deal terms" action={canEdit && !locked && !editing ? 'Edit' : null} onAction={startEdit}>
      {/* Engagement type stays read-only: video vs UGC drives a different pipeline
          (ugc_briefs, the /ugc board), so flipping it here would strand a deal. */}
      {locked && <LockedNote />}
      <KV label="Type" value={e.engagement_type === 'ugc' ? 'UGC' : 'Video'} />

      {editing && !locked ? (
        <>
          <SelectEdit label="Deal type" value={f.deal_type} onChange={v => setF(x => ({ ...x, deal_type: v }))}
            options={DEAL_TYPE_VALUES.map(v => ({ value: v, label: DEAL_TYPE_LABELS[v] }))} />
          <SelectEdit label="Payment terms" value={f.payment_terms} onChange={v => setF(x => ({ ...x, payment_terms: v }))}
            options={[{ value: '', label: '— Not set —' }, ...PAYMENT_TERMS.map(v => ({ value: v, label: PAYMENT_TERMS_LABELS[v] }))]} />
          <CostEdit label="Payment ₹" value={f.payment_amount} onChange={v => setF(x => ({ ...x, payment_amount: v }))} />
          <CostEdit label="Affiliate %" value={f.affiliate_pct} onChange={v => setF(x => ({ ...x, affiliate_pct: v }))} />
          <CostEdit label="Commission ₹" value={f.commission_amount} onChange={v => setF(x => ({ ...x, commission_amount: v }))} />
          <SelectEdit label="Campaign" value={f.campaign_id} onChange={v => setF(x => ({ ...x, campaign_id: v }))}
            options={[{ value: '', label: '— No campaign —' }, ...campaigns.map(c => ({ value: c.id, label: c.name }))]} />
          <SelectEdit label="Ad rights" value={f.ad_rights} onChange={v => setF(x => ({ ...x, ad_rights: v }))}
            options={[{ value: '', label: '— Not recorded —' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
          {f.ad_rights === 'yes' && (
            <>
              <CostEdit label="Ad rights ₹" value={f.ad_rights_amount} onChange={v => setF(x => ({ ...x, ad_rights_amount: v }))} />
              <SelectEdit label="Ad duration" value={f.ad_rights_duration} onChange={v => setF(x => ({ ...x, ad_rights_duration: v }))}
                options={[{ value: '', label: '— Not set —' }, ...AD_RIGHTS_DURATIONS.map(d => ({ value: d, label: d }))]} />
            </>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => setEditing(false)} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} className={busy ? undefined : 'ig-cta'} style={{ ...primaryBtn, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <>
          <KV label="Deal type" value={DEAL_TYPE_LABELS[e.deal_type] || e.deal_type} />
          <KV label="Payment terms" value={PAYMENT_TERMS_LABELS[e.payment_terms] || e.payment_terms || '—'} />
          <KV label="Payment amount" value={<span style={mono}>₹{agreed.toLocaleString()}</span>} />
          <KV label="Paid" value={
            <span style={{ ...mono, color: done ? 'var(--state-success-fg)' : paid > 0 ? 'var(--state-warning-fg)' : 'var(--text-4)', fontWeight: 600 }}>
              ₹{paid.toLocaleString()} of ₹{agreed.toLocaleString()}{done ? ' ✓' : ''}
            </span>
          } />
          {e.affiliate_pct != null && <KV label="Affiliate %" value={<span style={mono}>{e.affiliate_pct}%</span>} />}
          {e.commission_amount != null && <KV label="Commission" value={<span style={mono}>₹{Number(e.commission_amount).toLocaleString()}</span>} />}
          <KV label="Campaign" value={campaignName || <span style={{ color: 'var(--text-4)' }}>—</span>} />
          <KV label="Ad rights" value={
            e.ad_rights == null
              // "—" not "No": nobody has answered the question on this deal yet.
              ? <span style={{ color: 'var(--text-4)' }}>—</span>
              : e.ad_rights
                ? <span style={{ color: 'var(--state-success-fg)', fontWeight: 600 }}>Yes</span>
                : <span style={{ color: 'var(--text-3)' }}>No</span>
          } />
          {e.ad_rights && (
            <>
              <KV label="Ad rights ₹ (outside budget)" value={e.ad_rights_amount != null ? <span style={mono}>₹{Number(e.ad_rights_amount).toLocaleString('en-IN')}</span> : '—'} />
              <KV label="Ad duration" value={e.ad_rights_duration || '—'} />
            </>
          )}
        </>
      )}
    </Card>
  );
}

// Ad-rights durations (Reann #4). A fixed picker rather than a free-text box, because the
// product/variant columns on this same table are the standing demonstration of what free text
// does: 44 typed spellings for 22 products (measured 2026-08-27). Deliberately NOT a DB CHECK —
// a CHECK would make adding an option a three-layer edit (PATTERN-218) for no gain, since
// nothing branches on the value.
const AD_RIGHTS_DURATIONS = ['1 month', '3 months', '6 months', '12 months', 'Perpetual'];

function SelectEdit({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', alignItems: 'center', borderTop: '1px solid var(--row-divider)', fontSize: 14 }}>
      <span style={{ flexShrink: 0, color: 'var(--text-3)' }}>{label}</span>
      <select value={value} onChange={ev => onChange(ev.target.value)}
        style={{ width: '100%', maxWidth: 220, minWidth: 0, background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', padding: '7px 10px', fontFamily: 'var(--font-ui)', fontSize: 13, boxSizing: 'border-box' }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

const mono = { fontFamily: 'var(--font-mono)' };
const ghostBtn = { height: 36, padding: '0 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const primaryBtn = { height: 36, padding: '0 16px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700 };
