import test from 'node:test';
import assert from 'node:assert/strict';
import { pickExistingInfluencer, igHandleOf, phone10 } from '../src/index.js';

const IN925 = { id: 'a', influencer_code: 'IN925', channel_name: 'nanvish_stories', channel_link: 'https://www.instagram.com/nanvish_stories/', contact_number: '+918088709720', email: 'Nanditha.anu5@gmail.com', list_status: 'master', created_at: '2026-05-28' };
const IN882 = { id: 'b', influencer_code: 'IN882', channel_name: 'unknown_rider_up32', channel_link: 'https://www.instagram.com/unknown_rider_up32/reels/', contact_number: '+918707795109', email: null, list_status: 'master', created_at: '2026-05-28' };

test('handle helpers', () => {
  assert.equal(igHandleOf('https://www.instagram.com/Nanvish_Stories/reels/'), 'nanvish_stories');
  assert.equal(igHandleOf('(9) Instagram'), null);
  assert.equal(phone10('+91 87077-95109'), '8707795109');
  assert.equal(phone10('12345'), null);
});

test('the two S412 duplicates would have linked', () => {
  assert.equal(pickExistingInfluencer([IN925, IN882], { handle: 'nanvish_stories' }).influencer.influencer_code, 'IN925');
  assert.equal(pickExistingInfluencer([IN925, IN882], { handle: '@Unknown_Rider_UP32' }).influencer.influencer_code, 'IN882');
});

test('ilike wildcard over-match is rejected in JS (`_` matches any char; prefix links)', () => {
  const lookalike = { ...IN925, id: 'c', influencer_code: 'IN9', channel_name: 'nanvishXstories', channel_link: 'https://instagram.com/nanvish_storiesxyz' };
  assert.equal(pickExistingInfluencer([lookalike], { handle: 'nanvish_stories' }), null);
});

test('phone and email match; more signals beat fewer, then oldest', () => {
  const newer = { ...IN882, id: 'd', influencer_code: 'IN1272', channel_link: 'https://instagram.com/unknown_rider_up32', contact_number: null, created_at: '2026-07-15' };
  const m = pickExistingInfluencer([newer, IN882], { handle: 'unknown_rider_up32', phone: '8707795109' });
  assert.equal(m.influencer.influencer_code, 'IN882');
  assert.deepEqual(m.matched_on, ['handle', 'phone']);
  assert.equal(m.candidates, 2);
  assert.equal(pickExistingInfluencer([IN925], { email: 'NANDITHA.anu5@gmail.com' }).influencer.influencer_code, 'IN925');
});

test('archived never matches; junk input never matches', () => {
  assert.equal(pickExistingInfluencer([{ ...IN925, list_status: 'archived' }], { handle: 'nanvish_stories' }), null);
  assert.equal(pickExistingInfluencer([IN925], { handle: 'a,b)', email: 'x),or(y@z.com' }), null);
});

test('ties on signals go to the more filled-in row, not just the oldest', () => {
  const emptyOld = { id: 'e', influencer_code: 'IN575', channel_name: 'petrol_hunter', channel_link: 'https://www.instagram.com/petrol_hunter/reels/', contact_number: null, email: null, list_status: 'master', created_at: '2026-05-28', quality_rating: 'unrated' };
  const fullNew = { id: 'f', influencer_code: 'IN1368', channel_name: 'petrol_hunter', channel_link: 'https://www.instagram.com/petrol_hunter/', contact_number: '8113022820', email: 'x@y.com', reach: 2000000, influencer_type: 'macro', list_status: 'master', created_at: '2026-08-11', quality_rating: 'green' };
  assert.equal(pickExistingInfluencer([emptyOld, fullNew], { handle: 'petrol_hunter' }).influencer.influencer_code, 'IN1368');
});

test('a phone stored with separators matches on digits', () => {
  assert.equal(pickExistingInfluencer([{ ...IN882, contact_number: '+91 87077-95109' }], { phone: '8707795109' }).influencer.influencer_code, 'IN882');
});
