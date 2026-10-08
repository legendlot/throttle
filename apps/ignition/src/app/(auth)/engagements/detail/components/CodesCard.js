'use client';
import { useEffect, useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { Card, miniBtn } from './shared.js';

// Coupon registry + attribution per engagement (Batch B theme ②). Gift = internal
// 100%-off own-order record; affiliate = per-video code for the audience, multi-use,
// commission accrues only while the engagement is live. Codes are created on / retired
// from Shopify; "Sync" reconciles redemptions (net of refunds) onto the deal.
export function CodesCard({ engagementId, canManage, session }) {
  const { showToast: toast } = useToast();
  const [coupons, setCoupons] = useState(null);
  const [pct, setPct] = useState('');
  const [couponName, setCouponName] = useState('');   // optional affiliate vanity name (S313)
  const [busy, setBusy] = useState(false);

  function load() {
    if (!session || !engagementId) return;
    ignitionopsGet('getCouponsForEngagement', { engagement_id: engagementId }, session)
      .then(r => setCoupons(r.coupons || [])).catch(() => setCoupons([]));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [engagementId, session]);

  async function issue(kind) {
    setBusy(true);
    try {
      const body = { engagement_id: engagementId, kind };
      if (kind === 'affiliate') {
        const p = Number(pct);
        if (!p || p <= 0 || p > 100) { toast('Enter a discount % (1–100)', 'error'); setBusy(false); return; }
        body.discount_pct = p;
        // Optional vanity name, AFFILIATE ONLY. The worker already accepted `code` for affiliate
        // and always ignores it for gift; nothing here ever offers it on the gift path, because a
        // guessable gift code is a 100%-off order anyone can fluke (S217). Left blank, the worker
        // mints the name as before.
        const custom = couponName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (custom) {
          if (custom.length < 3) { toast('A code name needs at least 3 letters or digits', 'error'); setBusy(false); return; }
          body.code = custom;
        }
      }
      const res = await ignitionopsPost('issueCoupon', body, session);
      if (res.shopify === 'created') toast(`Code ${res.coupon.code} created on Shopify`, 'success');
      else toast(`Code ${res.coupon.code} reserved — Shopify pending (${res.note || 'add write_discounts'})`, 'info');
      setPct(""); setCouponName(""); load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }
  async function retire(id) {
    if (!window.confirm('Retire this code? It will be deactivated on Shopify; redemption history is kept.')) return;
    try { await ignitionopsPost('retireCoupon', { coupon_code_id: id }, session); toast('Code retired', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function sync(id) {
    try { const r = await ignitionopsPost('syncCouponRedemptions', { coupon_code_id: id }, session); toast(`Redemptions synced (${r.synced})`, 'success'); load(); }
    catch (e) { toast(e.message === 'shopify_not_configured' ? 'Shopify not connected' : e.message, 'error'); }
  }
  async function retry(id) {
    try {
      const r = await ignitionopsPost('retryCoupon', { coupon_code_id: id }, session);
      if (r.shopify === 'created' || r.already) toast('Code pushed live to Shopify', 'success');
      else toast(`Still pending — ${r.note || 'Shopify unavailable'}${r.scope_missing ? ' (add write_discounts)' : ''}`, 'info');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  const gift = (coupons || []).filter(c => c.kind === 'gift');
  const aff = (coupons || []).filter(c => c.kind === 'affiliate');

  return (
    <Card title="Codes & attribution">
      {coupons == null ? <div style={{ color: 'var(--text-3)' }}>Loading…</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={subhead}>Affiliate code — for the creator&apos;s audience</div>
            {aff.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>None yet.</div>
              : aff.map(c => <CodeRow key={c.id} c={c} canManage={canManage} onRetire={retire} onSync={sync} onRetry={retry} big />)}
            {canManage && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <input type="number" min="1" max="100" placeholder="% off" value={pct} onChange={e => setPct(e.target.value)} style={pctInp} />
                <input value={couponName} onChange={e => setCouponName(e.target.value)}
                  placeholder="Code name (optional)" title="Letters and numbers only. Leave blank to generate one."
                  style={{ ...pctInp, width: 190, textTransform: 'uppercase' }} />
                <button onClick={() => issue('affiliate')} disabled={busy} style={issueBtn}>Issue affiliate code</button>
              </div>
            )}
          </div>
          <div>
            <div style={subhead}>Gift code — internal, places the creator&apos;s free order (100% off)</div>
            {gift.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>None yet.</div>
              : gift.map(c => <CodeRow key={c.id} c={c} canManage={canManage} onRetire={retire} onSync={sync} onRetry={retry} />)}
            {canManage && <button onClick={() => issue('gift')} disabled={busy} style={{ ...issueBtn, marginTop: 8 }}>Issue gift code</button>}
          </div>
        </div>
      )}
    </Card>
  );
}

function CodeRow({ c, canManage, onRetire, onSync, onRetry, big }) {
  const retired = c.status === 'retired';
  const pending = c.status === 'pending_shopify';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: big ? 18 : 14, color: retired ? 'var(--text-3)' : '#FF6B00', textDecoration: retired ? 'line-through' : 'none', letterSpacing: '0.04em' }}>{c.code}</span>
      <span style={pill}>{c.discount_pct}% off</span>
      {pending && <span style={{ ...pill, color: '#F2CD1A', borderColor: '#F2CD1A' }}>Shopify pending</span>}
      {retired && <span style={{ ...pill, color: 'var(--text-3)' }}>retired</span>}
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        {/* No commission figure: affiliate codes are TRACKING-ONLY (Afshaan 2026-08-26), so the
            "₹0.00 commission" this used to print was reporting a debt that does not exist.
            See reference/decisions.md before re-adding it. */}
        {c.redemptions || 0} uses · ₹{Number(c.attributed_revenue_net || 0).toLocaleString()} net
      </span>
      {canManage && !retired && (
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {pending && onRetry && (
            <button onClick={() => onRetry(c.id)} style={{ ...miniBtn, background: '#FF6B00', color: '#fff', borderColor: '#FF6B00', fontWeight: 700 }}>Push to Shopify</button>
          )}
          <button onClick={() => onSync(c.id)} style={miniBtn}>Sync</button>
          <button onClick={() => onRetire(c.id)} style={miniBtn}>Retire</button>
        </span>
      )}
    </div>
  );
}

const subhead = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, fontWeight: 600 };
const pill = { fontSize: 10, color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const pctInp = { width: 90, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const issueBtn = { padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
