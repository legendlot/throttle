'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import ProductLinesEditor from '../../../../components/ProductLinesEditor.js';
import { useDealForm } from '../../../../lib/useDealForm.js';
import PocSelect from '../../../../components/PocSelect.js';
import SelectedInfluencerCard from '../../../../components/SelectedInfluencerCard.js';
import {
  DealTypeCards, DealField, InfluencerResults, ENGAGEMENT_TYPE_OPTS, fieldGrid, ctl, ctlMono,
} from '../../../../components/NewDealModal.js';
import { Card, Segmented } from '../../../../components/ui/index.js';

export default function NewEngagementPage() {
  const { session } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  // W9b (2026-10-08) — the Dashboard's Re-book links here with ?influencer=<id>.
  const presetId = sp.get('influencer');
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
  const [created, setCreated] = useState(null);
  // null = no preset in play · 'loading' · 'failed' (the picker shows, with a one-line note).
  const [presetState, setPresetState] = useState(null);
  const presetDone = useRef(null);
  const narrow = useNarrow();

  // Fetch the Re-book influencer ONCE per id and preselect it. A failure falls back to the
  // normal empty picker, with a visible note rather than a toast or a crash.
  useEffect(() => {
    if (!presetId || !session || presetDone.current === presetId) return;
    presetDone.current = presetId;
    setPresetState('loading');
    ignitionopsGet('getInfluencer', { id: presetId }, session)
      .then(r => {
        if (r?.influencer) { setSelected(r.influencer); setPresetState(null); }
        else setPresetState('failed');
      })
      .catch(() => setPresetState('failed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId, session]);

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
      setCreated(res.engagement_no || '');
      toast(`Created ${res.engagement_no}`, 'success');
      router.push(`/engagements/detail/?id=${res.id}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  // `created` keeps the button dead while router.push runs — a second click would create a duplicate deal.
  const blocked = !selected || busy || !productsValid || created != null;
  // Prototype action-bar summary — only what the form already holds: the fee on a paid deal (labelled
  // "Fee", not "Committed", which the Dashboard uses for total cost), and the lines linked to a product.
  const fee = isPaid ? Math.max(Number(form.payment_amount) || 0, 0) : 0;
  const lineCount = lines.filter(l => (l.product_code || '').trim() && (l.product_ref || l.__legacyFreeText)).length;

  return (
    <div style={{ maxWidth: 880, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <a href="/engagements/" onClick={e => { e.preventDefault(); router.push('/engagements/'); }}
        style={{ fontSize: 13, color: 'var(--text-3)', width: 'max-content' }}>← Engagements</a>
      <div className="ig-up">
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: 'var(--tracking-eyebrow)', color: 'var(--text-4)', textTransform: 'uppercase' }}>
          Starts at proposed · needs approval
        </div>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, margin: '6px 0 0', lineHeight: 1.15 }}>New deal</h1>
      </div>

      <Card hero className="ig-up" style={{ ...sectionCard, animationDelay: '60ms' }}>
        <StepTitle n={1}>Influencer</StepTitle>
        {selected ? (
          <SelectedInfluencerCard influencer={selected} onChange={() => setSelected(null)} />
        ) : presetState === 'loading' ? (
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Loading influencer…</div>
        ) : (
          <div>
            {presetState === 'failed' && (
              <div style={{ fontSize: 13, color: 'var(--state-warning-fg)', marginBottom: 8 }}>
                Couldn’t load that influencer — search for them below.
              </div>
            )}
            <input
              data-search-primary
              placeholder="Search code, handle, name…"
              value={influencerSearch}
              onChange={e => setInfluencerSearch(e.target.value)}
              style={ctl}
            />
            <InfluencerResults results={searchResults} onPick={pick} />
          </div>
        )}
      </Card>

      <Card hero className="ig-up" style={{ ...sectionCard, animationDelay: '120ms' }}>
        <StepTitle n={2}>Deal terms</StepTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={lbl}>Engagement type</span>
          <Segmented options={ENGAGEMENT_TYPE_OPTS} value={form.engagement_type}
            onChange={v => setField('engagement_type', v)} style={{ background: 'var(--bg)', alignSelf: 'flex-start' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={lbl}>Deal type</span>
          <DealTypeCards value={form.deal_type} onChange={v => setField('deal_type', v)} />
        </div>
        {/* D7 (S412): the modal's rule — payment only for paid deals, affiliate % only for
            affiliate deals. A field that doesn't apply shows the dimmed "—" (DealField `off`). */}
        <div style={fieldGrid}>
          <DealField label="Payment terms" off={!isPaid}>
            <select value={form.payment_terms} onChange={e => setField('payment_terms', e.target.value)} style={ctl}>
              <option value="advance">Advance</option>
              <option value="on_draft">On Draft</option>
              <option value="on_release">On Release</option>
              <option value="n_a">N/A</option>
            </select>
          </DealField>
          <DealField label="Payment amount (₹)" off={!isPaid}>
            <input type="number" min="0" value={form.payment_amount} onChange={e => setField('payment_amount', e.target.value)} placeholder="e.g. 5000" style={ctlMono} />
          </DealField>
          <DealField label="Affiliate % agreed" off={!isAffiliate}>
            <input type="number" min="0" max="100" step="0.1" value={form.affiliate_pct}
              onChange={e => setField('affiliate_pct', e.target.value)} placeholder="e.g. 10" style={ctlMono} />
          </DealField>
          <DealField label="Expected post date">
            <input type="date" value={form.expected_post_date} onChange={e => setField('expected_post_date', e.target.value)} style={ctl} />
          </DealField>
          <DealField label="Campaign">
            <select value={form.campaign_id} onChange={e => setField('campaign_id', e.target.value)} style={ctl}>
              <option value="">— none —</option>
              {campaignOpts.map(c => <option key={c.id} value={c.id}>{c.name || c.campaign_no}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={newCampaign} onChange={e => setNewCampaign(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createCampaignInline(); } }}
                placeholder="or start a new campaign…" style={{ ...ctl, height: 36, fontSize: 13, flex: 1, minWidth: 0 }} />
              <button type="button" onClick={createCampaignInline} disabled={!newCampaign.trim() || creatingCampaign}
                style={{ height: 36, padding: '0 12px', fontSize: 13, fontWeight: 700, borderRadius: 'var(--r-ctl)', border: 'none',
                         background: 'var(--text-1)', color: 'var(--bg)', fontFamily: 'var(--font-ui)',
                         cursor: newCampaign.trim() ? 'pointer' : 'default',
                         opacity: newCampaign.trim() && !creatingCampaign ? 1 : 0.5, whiteSpace: 'nowrap' }}>
                {creatingCampaign ? 'Adding…' : 'Add'}
              </button>
            </div>
          </DealField>
          <DealField label="POC">
            <PocSelect
              value={form.poc_user_id}
              onChange={({ poc_user_id, poc_name }) => setForm(f => ({ ...f, poc_user_id, poc_name }))}
              session={session}
              style={ctl}
            />
          </DealField>
          <DealField label="Directed to">
            <select value={form.directed_to} onChange={e => setField('directed_to', e.target.value)} style={ctl}>
              <option value="website">Website</option>
              <option value="amazon">Amazon</option>
              <option value="flipkart">Flipkart</option>
            </select>
          </DealField>
        </div>
      </Card>

      <Card hero className="ig-up" style={{ ...sectionCard, animationDelay: '180ms' }}>
        <StepTitle n={3}>Products</StepTitle>
        <ProductLinesEditor value={lines} onChange={setLines} session={session} onValidityChange={setProductsValid} />
      </Card>

      {/* Sticky action bar (prototype). On a phone it sits in the flow instead — the fixed tab bar
          owns the bottom of the viewport there. */}
      <div style={{
        position: narrow ? 'static' : 'sticky', bottom: 0, zIndex: 5,
        margin: narrow ? '0' : '0 -32px', padding: narrow ? '14px 0' : '14px 32px',
        background: 'var(--sticky-bar)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
      }}>
        <div style={{ flex: '1 1 220px', display: 'flex', gap: 24, rowGap: 4, fontSize: 13, color: 'var(--text-3)', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span>Fee <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-hi)', fontSize: 15 }}>
            ₹{fee.toLocaleString('en-IN')}</span></span>
          <span>{lineCount} product line{lineCount === 1 ? '' : 's'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <button type="button" onClick={() => router.back()}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', fontSize: 14, padding: '0 8px', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={blocked} className={blocked ? undefined : 'ig-cta'}
            style={{
              height: 44, padding: '0 22px', borderRadius: 'var(--r-btn)', border: 'none',
              background: created != null ? 'var(--state-success-fg)' : 'var(--accent)', color: 'var(--accent-fg)',
              fontFamily: 'var(--font-ui)', fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap',
              cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked && created == null ? 0.5 : 1,
              transition: 'background 200ms',
            }}>
            {created != null ? `✓ ${created} proposed` : busy ? 'Creating…' : 'Create deal'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StepTitle({ n, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{
        width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-fg)',
        fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{n}</span>
      <span style={{ fontFamily: 'var(--font-cond)', fontSize: 16, fontWeight: 700 }}>{children}</span>
    </div>
  );
}

// ≤767px = the mobile shell (same breakpoint as globals.css). Only the action bar reads it.
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

const sectionCard = { display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 22px' };
const lbl = { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' };
