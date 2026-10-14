import test from 'node:test';
import assert from 'node:assert/strict';
import { partnerRouteAllowed, watermarkDataUrl, defaultPartnerExpiry, PARTNER_TOGGLE_LABELS } from '../src/lib/partner.js';

// §S419-ClearshotPartner — partner chrome. Cosmetic (the worker is the control), but a route the
// app offers and the worker refuses is a page of errors, so the two sets are pinned here.
const P = { ignition_view: true, ignition_external: true };

test('partner routes: Roster + Engagements + their detail pages, nothing else by default', () => {
  for (const r of ['/roster', '/roster/', '/engagements/', '/engagements/detail/', '/influencers/detail/']) {
    assert.ok(partnerRouteAllowed(r, P), r);
  }
  for (const r of ['/', '/dashboard/', '/engagements/new/', '/influencers/', '/payments/', '/admin/users/',
    '/connects/', '/reports/', '/campaigns/', '/manual/', '/blist/']) {
    assert.ok(!partnerRouteAllowed(r, P), r);
  }
});

test('partner routes: each toggle opens exactly its pages', () => {
  assert.ok(partnerRouteAllowed('/campaigns/detail/', { ...P, partner_campaigns: true }));
  assert.ok(partnerRouteAllowed('/reports/', { ...P, ignition_reports_view: true }));
  assert.ok(partnerRouteAllowed('/connects/', { ...P, ignition_connects: true }));
  assert.ok(partnerRouteAllowed('/influencers/', { ...P, partner_all_influencers: true }));
  assert.ok(!partnerRouteAllowed('/engagements/new/', { ...P, partner_all_influencers: true, partner_money: true }));
});

test('watermark: the email is escaped and URL-encoded into the SVG', () => {
  const u = watermarkDataUrl(`a'b"<x>&@c.in · 2026-10-14`);
  assert.ok(u.startsWith('url("data:image/svg+xml;charset=utf-8,'));
  const svg = decodeURIComponent(u.slice('url("data:image/svg+xml;charset=utf-8,'.length, -2));
  assert.ok(svg.includes('a&apos;b&quot;&lt;x&gt;&amp;@c.in'));
  assert.ok(!u.slice(5, -2).includes('"'), 'no raw quote can close the CSS url()');
});

test('invite expiry defaults to today + 90 days (IST)', () => {
  assert.equal(defaultPartnerExpiry(Date.parse('2026-10-14T20:00:00Z')), '2027-01-13');   // already 15 Oct IST
  assert.equal(defaultPartnerExpiry(Date.parse('2026-10-14T06:00:00Z')), '2027-01-12');
});

test('admin toggles match the worker PARTNER_TOGGLES', async () => {
  const { PARTNER_TOGGLES } = await import('../../../ignitionops-worker/src/partner.js');
  assert.deepEqual(PARTNER_TOGGLE_LABELS.map(t => t.key), PARTNER_TOGGLES);
});
