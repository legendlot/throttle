// Global search (top bar) — maps the worker's searchAll response to Typeahead groups. Pure, so the
// shape is unit-tested (test/globalSearch.test.mjs). components/shell/GlobalSearch.js adds the avatars/pills.
// A group the worker failed to read arrives as null → { error: true } ("Couldn't load deals"), never
// silently empty. A row with nothing to show as its name is dropped (no placeholder names — plan §2.8).

const TYPE_LABELS = { nano: 'Nano', micro: 'Micro', macro: 'Macro', brand: 'Brand', store: 'Store' };
const join = (parts) => parts.filter(Boolean).join(' · ');
const enc = (id) => encodeURIComponent(String(id));

export function influencerHref(id) { return `/influencers/detail/?id=${enc(id)}`; }
export function dealHref(row) {
  return row.engagement_type === 'ugc' ? `/ugc/detail/?id=${enc(row.id)}` : `/engagements/detail/?id=${enc(row.id)}`;
}
export function campaignHref(id) { return `/campaigns/detail/?id=${enc(id)}`; }

export function searchAllGroups(d) {
  const out = [];
  const add = (group, rows, map) => {
    if (rows === null) { out.push({ group, error: true }); return; }
    if (!Array.isArray(rows)) return;
    const items = rows.filter((r) => r && r.id).map(map).filter(Boolean);
    if (items.length) out.push({ group, items });
  };

  add('Influencers', d?.influencers, (r) => {
    const name = r.channel_name || r.person_name || r.influencer_code;
    if (!name) return null;
    return {
      kind: 'influencer', id: r.id, href: influencerHref(r.id),
      primary: name,
      secondary: join([
        r.person_name && r.person_name !== name ? r.person_name : null,
        r.influencer_code !== name ? r.influencer_code : null,
        TYPE_LABELS[r.influencer_type] || null,
        r.list_status === 'b_list' ? 'B-List' : null,
      ]),
      rating: r.quality_rating || null,
    };
  });

  add('Deals', d?.engagements, (r) => {
    const inf = r.influencer || {};
    if (!r.engagement_no) return null;
    return {
      kind: 'deal', id: r.id, href: dealHref(r),
      primary: r.engagement_no,
      secondary: join([inf.channel_name || inf.person_name, inf.influencer_code]),
      stage: r.stage || null,
      ugc: r.engagement_type === 'ugc',
    };
  });

  add('Campaigns', d?.campaigns, (r) => (r.name ? {
    kind: 'campaign', id: r.id, href: campaignHref(r.id),
    primary: r.name,
    status: r.status || null,
  } : null));

  return out;
}
