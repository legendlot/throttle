import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAllGroups, dealHref } from '../src/lib/globalSearch.js';

test('searchAllGroups: maps all three groups, UGC deals open the UGC page', () => {
  const g = searchAllGroups({
    q: 'petrol',
    influencers: [{ id: 'i1', channel_name: 'petrol_hunter', person_name: 'Ravi', influencer_code: 'IN575', influencer_type: 'micro', quality_rating: 'green', list_status: 'b_list' }],
    engagements: [
      { id: 'e1', engagement_no: 'IGN-2026-0081', engagement_type: 'video_tracking', stage: 'live', influencer: { channel_name: 'petrol_hunter', influencer_code: 'IN575' } },
      { id: 'e2', engagement_no: 'IGN-2026-0090', engagement_type: 'ugc', stage: 'brief', influencer: null },
    ],
    campaigns: [{ id: 'c1', name: 'Petrol Diwali', status: 'active' }],
  });
  assert.deepEqual(g.map(x => x.group), ['Influencers', 'Deals', 'Campaigns']);
  assert.equal(g[0].items[0].secondary, 'Ravi · IN575 · Micro · B-List');
  assert.equal(g[0].items[0].href, '/influencers/detail/?id=i1');
  assert.equal(g[1].items[0].href, '/engagements/detail/?id=e1');
  assert.equal(g[1].items[1].href, '/ugc/detail/?id=e2');
  assert.equal(g[1].items[1].secondary, '');
  assert.equal(g[2].items[0].href, '/campaigns/detail/?id=c1');
});

test('searchAllGroups: a null group is an error group, an empty one is dropped, junk is ignored', () => {
  const g = searchAllGroups({ influencers: [], engagements: null, campaigns: [null, { name: 'no id' }] });
  assert.deepEqual(g, [{ group: 'Deals', error: true }]);
  assert.deepEqual(searchAllGroups(undefined), []);
});

test('searchAllGroups: person name is not repeated when it is the display name', () => {
  const g = searchAllGroups({ influencers: [{ id: 'i', person_name: 'Asha', influencer_code: 'IN1' }] });
  assert.equal(g[0].items[0].primary, 'Asha');
  assert.equal(g[0].items[0].secondary, 'IN1');
});

test('dealHref encodes the id', () => {
  assert.equal(dealHref({ id: 'a&b', engagement_type: 'ugc' }), '/ugc/detail/?id=a%26b');
});
