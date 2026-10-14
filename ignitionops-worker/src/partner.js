// ── External partner mode (§S419-ClearshotPartner, 2026-10-14) ───────────────────────────────
// An external partner (first: Clearshot) signs in with their OWN email and holds an INACTIVE
// users_profile, which every other LOT worker refuses — that is the isolation. ignitionops admits
// them only when their Ignition role carries `ignition_external: true`, and then everything here
// applies. Enforcement lives in the worker, not the UI: a partner's JWT can call any action
// directly, so the allowlist and the field strip are the controls; the app only hides things.
//
// Pure functions only (no fetch) so they are unit-tested in test/partner.test.mjs.

// Roster = not archived AND ≥1 engagement in one of these stages (the app's Roster page). ONE
// definition: getRoster's SQL filter and every partner scope check read this list.
export const ROSTER_STAGES = ['shipped', 'delivered', 'scheduled', 'posting', 'live'];

// Per-role switches an admin may flip on a partner role (setIgnitionRolePermission). Each one is
// read by name below or by the handler it unlocks — `ignition_reports_view` / `ignition_connects`
// are the SAME keys staff roles use, so the handlers' own requirePerm gates honour them as-is.
export const PARTNER_TOGGLES = [
  'partner_money', 'partner_contacts', 'partner_campaigns',
  'partner_all_influencers', 'ignition_reports_view', 'ignition_connects',
];

// Deny-by-default GET allowlist. `true` = always open to a partner; a string = open only while the
// partner role carries that toggle. An action missing from this map is refused — so a NEW endpoint
// is closed to partners until someone adds it here on purpose.
export const PARTNER_GET_ACTIONS = {
  getMe: true,
  getCatalogs: true,
  getLocations: true,
  getRoster: true,
  getInfluencer: true,
  getInfluencerMetrics: true,
  getEngagements: true,
  getEngagement: true,
  getEngagementVideos: true,
  getCampaigns: 'partner_campaigns',
  getCampaign: 'partner_campaigns',
  getReports: 'ignition_reports_view',
  getConnects: 'ignition_connects',       // Pitstop→Ignition chats — OFF by default (Afshaan)
  getConnect: 'ignition_connects',
  getInfluencers: 'partner_all_influencers',
  getInfluencerCounts: 'partner_all_influencers',
  searchAll: 'partner_all_influencers',
};

export const isPartner = auth => !!auth?.permissions?.ignition_external;

// Partners see only the Roster unless the role carries partner_all_influencers.
export const partnerScoped = auth => isPartner(auth) && !auth.permissions.partner_all_influencers;

// null = allowed; otherwise the 403 error code.
export function partnerGetRefusal(action, perms = {}) {
  const rule = Object.prototype.hasOwnProperty.call(PARTNER_GET_ACTIONS, action) ? PARTNER_GET_ACTIONS[action] : undefined;
  if (rule === true) return null;
  if (typeof rule === 'string' && perms[rule]) return null;
  return 'partner_forbidden';
}

// Partner query values must not carry URL syntax. Several handlers interpolate params into the
// PostgREST URL; a decoded `&`/`=` there adds a second `select=` (PostgREST takes the first) and walks
// out of the Roster scope (S419 hostile review, getEngagements date_from). Refusing the class here
// covers every partner-reachable handler, toggle-gated ones included, without auditing each param.
const PARTNER_PARAM_BAD = /[&=?#\u0000-\u001f]/;
export function partnerParamRefusal(searchParams) {
  for (const [k, v] of searchParams) {
    if (PARTNER_PARAM_BAD.test(k) || PARTNER_PARAM_BAD.test(v)) return 'partner_bad_param';
  }
  return null;
}

// ── Response field strip — the last line of defence ─────────────────────────────────────────
// Applied by the dispatcher to EVERY partner JSON response except getMe (which only echoes the
// caller's own identity — stripping its `email` would break the watermark). Keys are deleted at
// any depth, so an embed (engagement → influencer(*)) cannot smuggle a field past it.

// Never shown to a partner, whatever the toggles: who on LOT's staff did what, internal notes,
// and private storage paths.
export const PARTNER_ALWAYS_STRIP = [
  'created_by', 'poc_user_id', 'poc_name', 'approved_by', 'approved_by_name', 'unlocked_by',
  'unlocked_by_name', 'decided_by', 'disabled_by', 'assigned_by', 'actor', 'actor_name',
  'note', 'decision_note', 'proof_path', 'brief_path', 'brief_name', 'brief_mime',
];

// Influencer contact + shipping/courier identifiers — stripped unless partner_contacts.
export const PARTNER_CONTACT_KEYS = [
  'contact_number', 'email', 'address', 'contact_poc_name', 'contact_poc_type', 'rating_notes',
  'do_not_ship_reason', 'legacy_sheet_ref',
  'phone', 'whatsapp', 'customer_phone', 'customer_email', 'external_user_id', 'shipping_address',
  'shipping_order_id', 'tracking_id', 'tracking_url', 'tracking_number', 'tracking_link',
  'shopify_order_name', 'order_key', 'cs_ticket_no',
];

// Fees, costs, rates, revenue and returns — stripped unless partner_money. Enumerated from
// ignition.engagements / engagement_products / engagement_ads / campaigns / payments and from the
// computed keys getEngagement, campaignRollup and getReports emit.
export const PARTNER_MONEY_KEYS = [
  // engagements
  'payment_amount', 'payment_terms', 'affiliate_pct', 'commission_amount', 'commission_rate',
  'commission_earned', 'commission_paid', 'ad_spend', 'goodies_cost', 'shipping_cost', 'return_cost',
  'cpm', 'conversions_value', 'roas_on_ad_spend', 'actual_roas', 'creator_fee_status',
  'creator_fee_paid_date', 'ad_rights_amount', 'total_cost',
  // engagement_products / engagement_ads / payments / campaigns
  'cogs_inr', 'meta_spend', 'amount', 'paid_on', 'agreed_total', 'budget_amount',
  // computed (getEngagement, campaignRollup, getReports)
  'paid_total', 'payments', 'ad_payments', 'spend', 'budget', 'budget_remaining', 'budget_pct',
  'budget_consumed', 'roas', 'avg_cpm', 'avg_roas', 'roas_distribution', 'cpm_distribution',
];

export function partnerStripSet(perms = {}) {
  const s = new Set(PARTNER_ALWAYS_STRIP);
  if (!perms.partner_contacts) for (const k of PARTNER_CONTACT_KEYS) s.add(k);
  if (!perms.partner_money) for (const k of PARTNER_MONEY_KEYS) s.add(k);
  return s;
}

// Returns a NEW value with every key in `strip` removed at any depth.
export function stripPartnerFields(value, perms = {}, strip = partnerStripSet(perms)) {
  if (Array.isArray(value)) return value.map(v => stripPartnerFields(v, perms, strip));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (strip.has(k)) continue;
      out[k] = stripPartnerFields(v, perms, strip);
    }
    return out;
  }
  return value;
}

// getEngagement sections a partner never gets, whatever the toggles (brief item 3): the audit
// trail, internal notes, files, the payment ledgers, UGC briefs and named-staff actor maps.
export const PARTNER_ENGAGEMENT_DROP = [
  'history', 'notes', 'attachments', 'payments', 'ad_payments', 'ugc_briefs',
  'approved_by_name', 'unlocked_by_name',
];

export function partnerEngagementView(out) {
  const v = { ...out };
  for (const k of PARTNER_ENGAGEMENT_DROP) delete v[k];
  v.allowed_next = [];   // read-only: nothing to advance to
  return v;
}

// invitePartner: an @legendoftoys.com address is a staff Google login, never a partner.
export function partnerEmailRefusal(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@,()"'*\\]+@[^\s@,()"'*\\]+\.[a-z]{2,}$/.test(e)) return 'valid email required';
  if (e.endsWith('@legendoftoys.com')) return 'legendoftoys.com addresses are staff — grant them a staff role instead';
  return null;
}

// expires_at from the admin form: a bare YYYY-MM-DD means "through the end of that day, IST".
// Returns { iso } or { error }. Must be in the future.
export function partnerExpiry(raw, now = Date.now()) {
  if (raw == null || raw === '') return { error: 'expires_at required' };
  const s = String(raw).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59+05:30` : s;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { error: 'expires_at is not a date' };
  if (t <= now) return { error: 'expires_at must be in the future' };
  // Partner access is time-boxed: at most a year out, so a typo like 9999-12-31 can't mean "forever".
  if (t > now + 366 * 86400000) return { error: 'expires_at must be within a year — renew it then' };
  return { iso: new Date(t).toISOString() };
}
