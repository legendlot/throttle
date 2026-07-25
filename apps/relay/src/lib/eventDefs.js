// eventDefs — THE single client-side source for the event pickers (S233).
//
// Before this, segments/page.js, journeys/page.js and journey-canvas/NodeDrawer.js each
// carried their own hardcoded EVENT_SUGGEST array (10 / 7 / 10 entries, mutually
// inconsistent). 24 of 34 registered events were unreachable in the segment builder — the
// whole courier lifecycle, payment_link_*, segment_entered, whatsapp_*, shopflo_* — while
// the list DID offer `email_clicked`, which S189 renamed to `link_clicked` and which could
// therefore never match a row.
//
// Now: the worker's getEventDefinitions serves comms.event_registry() (active definitions +
// `category` + live usage). Registering an event = INSERT one row with a category; it then
// appears, grouped, in every picker with no code change here.
//
// GROUP_META only supplies display ORDER + LABEL for the slugs we know. It is deliberately
// NOT a whitelist: an unrecognised category still renders (auto-labelled, sorted last), so a
// future family can never be silently hidden — the failure mode this module exists to kill.

// Display order + human label for the known category slugs. Order = author intent:
// commerce lifecycle first (what journeys mostly trigger on), channel engagement after.
const GROUP_META = {
  cart:       { label: 'Cart & browsing',   order: 10 },
  order:      { label: 'Orders & delivery', order: 20 },
  payment:    { label: 'Payments',          order: 30 },
  whatsapp:   { label: 'WhatsApp',          order: 40 },
  email:      { label: 'Email',             order: 50 },
  engagement: { label: 'Engagement',        order: 60 },
  audience:   { label: 'Audience & consent', order: 70 },
  support:    { label: 'Support & service', order: 80 },
};
const UNKNOWN_GROUP_ORDER = 900;   // unknown slugs sort after every known group, never hidden

// slug -> "Nice Label" when GROUP_META has no entry (e.g. a brand-new category).
function autoLabel(slug) {
  return String(slug || 'other')
    .split(/[_\-\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Other';
}

export function groupMeta(slug) {
  return GROUP_META[slug] || { label: autoLabel(slug), order: UNKNOWN_GROUP_ORDER };
}

// Last-resort list, used ONLY when getEventDefinitions fails (network/permission). Kept
// deliberately short — the live registry is the source of truth; this exists so a picker
// degrades to something usable rather than empty. Categories mirror the DB slugs.
export const FALLBACK_EVENT_DEFS = [
  { name: 'add_to_cart',        category: 'cart'  },
  { name: 'checkout_started',   category: 'cart'  },
  { name: 'checkout_abandoned', category: 'cart'  },
  { name: 'order_placed',       category: 'order' },
  { name: 'order_fulfilled',    category: 'order' },
  { name: 'order_delivered',    category: 'order' },
  { name: 'order_cancelled',    category: 'order' },
].map((d) => ({ description: null, recent_count: null, last_seen_at: null, ...d }));

// Normalize whatever the worker returned into the shape the pickers expect, and sort by
// (group order, name) so groups are CONTIGUOUS — the Combobox renders a header whenever the
// group changes between adjacent options, so contiguity is load-bearing, not cosmetic.
export function normalizeEventDefs(raw) {
  const list = Array.isArray(raw) && raw.length ? raw : null;
  const defs = (list || FALLBACK_EVENT_DEFS).map((d) => {
    const category = d.category || 'other';
    return {
      name: d.name,
      description: d.description || '',
      category,
      groupLabel: groupMeta(category).label,
      recent_count: d.recent_count == null ? null : Number(d.recent_count),
      last_seen_at: d.last_seen_at || null,
    };
  }).filter((d) => d.name);
  return defs.sort((a, b) => {
    const ga = groupMeta(a.category).order, gb = groupMeta(b.category).order;
    if (ga !== gb) return ga - gb;
    if (a.groupLabel !== b.groupLabel) return a.groupLabel.localeCompare(b.groupLabel);
    return a.name.localeCompare(b.name);
  });
}

// Fetch + normalize. Non-fatal by contract: a failed call resolves to the fallback rather
// than rejecting, so a suggestion list can never break a page load.
export async function loadEventDefs(garageFetch, session) {
  try {
    const raw = await garageFetch('getEventDefinitions', {}, session);
    return normalizeEventDefs(raw);
  } catch {
    return normalizeEventDefs(null);
  }
}

// Combobox options with `group` set — the Combobox renders a header row on each group
// change. `hint` shows the usage signal so an author sees "never fired" BEFORE building on
// it; falls back to the description when usage isn't available.
export function eventComboOptions(defs) {
  return (defs || []).map((d) => ({
    value: d.name,
    label: d.name,
    group: d.groupLabel,
    hint: usageHint(d),
    // Matched but never rendered — lets "cart"/"whatsapp"/"delivered" find the right row
    // even though the visible label is only the raw event name.
    search: `${d.category} ${d.groupLabel} ${d.description}`,
  }));
}

// Short right-aligned usage signal. null recent_count = usage unknown (fallback list).
export function usageHint(d) {
  if (!d) return '';
  if (d.recent_count == null) return d.description ? truncate(d.description, 48) : '';
  if (d.recent_count === 0) return 'never fired (30d)';
  return `${formatCount(d.recent_count)} / 30d`;
}

function formatCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}

function truncate(s, max) {
  const t = String(s || '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
