'use client';
import { Avatar } from './Avatar.js';
import { RatingDot } from './RatingDot.js';
import { StagePill } from './StagePill.js';

// The row look shared by every typeahead that lists influencers / deals / campaigns (global search,
// the /engagements and /influencers page boxes): lib/globalSearch.js maps the data, this adds the
// avatar, rating dot, stage pill and campaign status.

// ignition.campaigns.status CHECK: active | completed | cancelled (same tones as the Campaigns grid).
const CAMPAIGN_TONE = { active: 'var(--state-success-fg)', completed: '#8ea2ff', cancelled: 'var(--text-3)' };

export function decorateSearchGroups(groups) {
  return groups.map((g) => (g.error ? g : {
    ...g,
    items: g.items.map((it) => {
      if (it.kind === 'influencer') {
        return { ...it, lead: <Avatar name={it.primary} seed={it.id} size={28} />,
          meta: it.rating ? <RatingDot rating={it.rating} showLabel={false} /> : null };
      }
      if (it.kind === 'deal') {
        return { ...it, meta: <>
          {it.ugc && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '.06em' }}>UGC</span>}
          <StagePill stage={it.stage} ugc={it.ugc} />
        </> };
      }
      return { ...it, meta: it.status ? (
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
          color: CAMPAIGN_TONE[it.status] || 'var(--text-3)' }}>{it.status}</span>
      ) : null };
    }),
  }));
}
