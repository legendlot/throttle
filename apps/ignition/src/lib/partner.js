// External partner mode (§S419-ClearshotPartner). `perms.ignition_external` comes from the
// partner's Ignition role via getMe. Everything here is presentation only — ignitionops refuses
// every partner POST and every GET outside its allowlist, and strips contact/money fields itself.

export const isPartnerPerms = perms => !!perms?.ignition_external;

export const PARTNER_LANDING = '/roster';

// Routes a partner may open. Mirrors the worker's PARTNER_GET_ACTIONS: a page whose reads the
// worker would refuse is not offered (it would only render errors).
export function partnerRoutes(perms) {
  const r = ['/roster', '/engagements', '/engagements/detail', '/influencers/detail'];
  if (perms?.partner_campaigns) r.push('/campaigns', '/campaigns/detail');
  if (perms?.ignition_reports_view) r.push('/reports');
  if (perms?.ignition_connects) r.push('/connects', '/connects/detail');
  if (perms?.partner_all_influencers) r.push('/influencers');
  return r;
}

export function partnerRouteAllowed(pathname, perms) {
  const p = String(pathname || '/').split('?')[0].replace(/\/+$/, '') || '/';
  return partnerRoutes(perms).includes(p);
}

// Watermark text: "<partner email> · <IST date>". A deterrent against screenshots, not a control.
export function watermarkText(email, today) {
  return `${email || 'partner'} · ${today}`;
}

// Escaped for an SVG <text> node inside a data: URL.
export function watermarkDataUrl(text) {
  const t = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='220'>`
    + `<text x='20' y='120' transform='rotate(-22 210 110)' fill='white' fill-opacity='0.07' `
    + `font-family='monospace' font-size='14'>${t}</text></svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

// Admin → Users: the per-role switches setIgnitionRolePermission accepts (worker PARTNER_TOGGLES).
export const PARTNER_TOGGLE_LABELS = [
  { key: 'partner_money',           label: 'Money',            hint: 'Fees, costs, CPM, ROAS, spend' },
  { key: 'partner_contacts',        label: 'Contacts',         hint: 'Phone, email, address, AWB / tracking' },
  { key: 'partner_campaigns',       label: 'Campaigns',        hint: 'Campaign list + detail' },
  { key: 'partner_all_influencers', label: 'All influencers',  hint: 'Beyond the Roster — every influencer AND every deal at any stage (incl. proposed/planning)' },
  { key: 'ignition_reports_view',   label: 'Reports',          hint: '⚠ Not Roster-scoped — totals + top performers across ALL deals' },
  { key: 'ignition_connects',       label: 'Pitstop chats',    hint: '⚠ Full chat text + customer handles; only phone/email fields are hidden' },
];

// Default expiry on the invite form: today + 90 days (IST date string).
export function defaultPartnerExpiry(now = Date.now()) {
  return new Date(now + 5.5 * 3600e3 + 90 * 86400e3).toISOString().slice(0, 10);
}
