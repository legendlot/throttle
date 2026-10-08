'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@throttle/ui';
import { Modal } from './ui/Modal.js';
import { Segmented, Avatar } from './ui/index.js';
import ProductLinesEditor from './ProductLinesEditor.js';
import { useDealForm } from '../lib/useDealForm.js';
import PocSelect from './PocSelect.js';
import SelectedInfluencerCard from './SelectedInfluencerCard.js';

// Quick-add deal (engagement). Essentials only — influencer, type, deal terms,
// product, expected post date (feeds the Schedule). Lands on the new deal to
// fill metrics/links later. `presetInfluencer` prefills when launched from a
// specific influencer.
export function NewDealModal({ open, onClose, session, presetInfluencer, onCreated }) {
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [err, setErr] = useState(null);
  // P0.3 (S412) — state, search, campaigns, payload and create are shared with the New Deal page.
  // `active: open` keeps the campaign list unfetched until the modal is opened.
  const deal = useDealForm({ session, active: !!open, presetInfluencer });
  const {
    form, setForm, setField, isPaid, isAffiliate,
    selected, setSelected, search, setSearch, results, pick,
    lines, setLines, productsValid, setProductsValid,
    campaigns, busy,
  } = deal;

  useEffect(() => { setSelected(presetInfluencer || null); }, [presetInfluencer, open]);

  async function submit() {
    const why = deal.problem();
    if (why) { setErr(why); return; }
    setErr(null);
    try {
      const res = await deal.create();
      toast(`Created ${res.engagement_no}`, 'success');
      onClose?.();
      onCreated ? onCreated(res) : router.push(`/engagements/detail/?id=${res.id}`);
    } catch (e) { setErr(e.message); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Deal" size="lg"
      confirmLabel={busy ? 'Creating…' : 'Create Deal'} confirmColor="#FF6B00"
      onConfirm={submit} confirmDisabled={!productsValid} loading={busy} error={err}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={lbl}>Influencer *</div>
          {selected ? (
            <SelectedInfluencerCard
              influencer={selected}
              onChange={presetInfluencer ? null : () => setSelected(null)}
            />
          ) : (
            <>
              <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search code, handle, name…" style={ctl} />
              <InfluencerResults results={results} onPick={pick} maxHeight={180} />
            </>
          )}
        </div>

        <div>
          <div style={lbl}>Engagement type</div>
          <Segmented options={ENGAGEMENT_TYPE_OPTS} value={form.engagement_type}
            onChange={v => setField('engagement_type', v)} style={{ background: 'var(--bg)' }} />
        </div>

        <div>
          <div style={lbl}>Deal type</div>
          <DealTypeCards value={form.deal_type} onChange={v => setField('deal_type', v)} />
        </div>

        <div style={fieldGrid}>
          <DealField label="Compensation (₹)" off={!isPaid}>
            <input type="number" min="0" value={form.payment_amount}
              onChange={e => setField('payment_amount', e.target.value)} placeholder="e.g. 5000" style={ctlMono} />
          </DealField>
          <DealField label="Payment terms" off={!isPaid}>
            <select value={form.payment_terms} onChange={e => setField('payment_terms', e.target.value)} style={ctl}>
              <option value="advance">Advance</option>
              <option value="on_draft">On Draft</option>
              <option value="on_release">On Release</option>
              <option value="n_a">N/A</option>
            </select>
          </DealField>
          <DealField label="Affiliate % agreed" off={!isAffiliate}>
            <input type="number" min="0" max="100" step="0.1" value={form.affiliate_pct}
              onChange={e => setField('affiliate_pct', e.target.value)} placeholder="e.g. 10" style={ctlMono} />
          </DealField>
          <DealField label="POC">
            <PocSelect
              value={form.poc_user_id}
              onChange={({ poc_user_id, poc_name }) => setForm(f => ({ ...f, poc_user_id, poc_name }))}
              session={session}
              style={ctl}
            />
          </DealField>
          <DealField label="Expected post date">
            <input type="date" value={form.expected_post_date} onChange={e => setField('expected_post_date', e.target.value)} style={ctl} />
          </DealField>
          {/* Reann #3 (S273) — a real campaign, not a typed tag. The free-text campaign_tag it
              replaced produced 4 spellings of 3 campaigns; picking from the list keeps one truth. */}
          <DealField label="Campaign">
            <select value={form.campaign_id} onChange={e => setField('campaign_id', e.target.value)} style={ctl}>
              <option value="">— none —</option>
              {campaigns.map(c => <option key={c.id} value={c.id}>{c.name || c.campaign_no}</option>)}
            </select>
          </DealField>
        </div>

        <div>
          <div style={lbl}>Products</div>
          <ProductLinesEditor value={lines} onChange={setLines} session={session} onValidityChange={setProductsValid} />
        </div>
      </div>
    </Modal>
  );
}

// ── Pit Control pieces shared with the /engagements/new page (2026-10-08 redesign) ──────────────

export const ENGAGEMENT_TYPE_OPTS = [
  { value: 'video_tracking', label: 'Video' },
  { value: 'ugc', label: 'UGC' },
];

// Deal type cards: label + sub, the selected card's border and label take the deal-type colour
// (same colours as DealPill).
const DEAL_TYPE_CARDS = [
  { value: 'paid',                label: 'Paid',             sub: 'Flat fee',         color: 'var(--brand-yellow)' },
  { value: 'barter',              label: 'Barter',           sub: 'Product only',     color: 'var(--text-2)' },
  { value: 'affiliate',           label: 'Affiliate',        sub: 'Commission %',     color: 'var(--state-info-fg)' },
  { value: 'paid_plus_affiliate', label: 'Paid + Affiliate', sub: 'Fee + commission', color: 'var(--accent-hi)' },
];

export function DealTypeCards({ value, onChange }) {
  return (
    <div role="radiogroup" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
      {DEAL_TYPE_CARDS.map(t => {
        const on = t.value === value;
        return (
          <button key={t.value} type="button" role="radio" aria-checked={on}
            onClick={() => { if (!on) onChange(t.value); }}
            style={{
              textAlign: 'left', padding: '12px 14px', borderRadius: 'var(--r-btn)', cursor: 'pointer',
              border: `1px solid ${on ? t.color : 'var(--border-2)'}`,
              background: on ? 'rgba(255,255,255,.03)' : 'transparent',
              fontFamily: 'var(--font-ui)', transition: 'border-color 160ms, background 160ms',
            }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: on ? t.color : 'var(--text-1)' }}>{t.label}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{t.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

// A field cell. `off` = the field does not apply to the chosen deal type (D7: payment only on paid
// deals, affiliate % only on affiliate deals) — it renders the prototype's dimmed "—" in place of
// the control, so nothing can be entered there.
export function DealField({ label, off = false, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={lbl0}>{label}</span>
      {off ? <span style={offCell} aria-disabled="true">—</span> : children}
    </div>
  );
}

export function InfluencerResults({ results, onPick, maxHeight }) {
  if (!results.length) return null;
  return (
    <div style={{ marginTop: 8, background: 'var(--menu)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-row)',
      padding: 6, maxHeight, overflowY: maxHeight ? 'auto' : undefined }}>
      {results.map(r => {
        const name = r.channel_name || r.person_name || '—';
        return (
          <div key={r.id} onClick={() => onPick(r)} className="ig-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, cursor: 'pointer', minWidth: 0 }}>
            <Avatar name={name} seed={r.influencer_code || name} size={28} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>
              {name}{' '}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-hi)', fontWeight: 600 }}>{r.influencer_code}</span>
            </span>
            {r.influencer_type && <span style={{ fontSize: 12, color: 'var(--text-3)', textTransform: 'capitalize' }}>{r.influencer_type}</span>}
          </div>
        );
      })}
    </div>
  );
}

const lbl0 = { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' };
const lbl = { ...lbl0, display: 'block', marginBottom: 8 };
export const fieldGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 };
export const ctl = {
  width: '100%', boxSizing: 'border-box', height: 42, padding: '0 12px',
  background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)',
  fontFamily: 'var(--font-ui)', fontSize: 14, colorScheme: 'dark',
};
export const ctlMono = { ...ctl, fontFamily: 'var(--font-mono)' };
const offCell = { ...ctl, display: 'flex', alignItems: 'center', color: 'var(--text-4)', fontFamily: 'var(--font-mono)' };
