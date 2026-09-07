// Ticket → conversation visibility tests (S354, 2026-09-07).
//
// These decide which of a customer's conversations an agent sees on a Support ticket. Real
// imports, not a mirror.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSupportVisible, partitionBySupport, supportVisibleClause } from './ticket-thread.js';

const SUPPORT = '1266501519877668';
const MARKETING = '1214557775075147';

test('a WhatsApp thread on the support number is visible', () => {
  assert.equal(isSupportVisible({ channel: 'whatsapp', waba_phone_number_id: SUPPORT }, SUPPORT), true);
});

test('a WhatsApp thread on the marketing or transactional number is hidden', () => {
  assert.equal(isSupportVisible({ channel: 'whatsapp', waba_phone_number_id: MARKETING }, SUPPORT), false);
});

test('a pre-Relay thread (NULL phone_number_id) counts as support — every one of those was on the support line', () => {
  assert.equal(isSupportVisible({ channel: 'whatsapp', waba_phone_number_id: null }, SUPPORT), true);
  assert.equal(isSupportVisible({ channel: 'whatsapp', waba_phone_number_id: '' }, SUPPORT), true);
});

test('non-WhatsApp channels are always visible — the number rule is a WhatsApp rule', () => {
  for (const channel of ['email', 'instagram', 'messenger', 'web']) {
    assert.equal(isSupportVisible({ channel, waba_phone_number_id: null }, SUPPORT), true, channel);
  }
});

test('a missing channel is treated as WhatsApp, not as "some other channel"', () => {
  assert.equal(isSupportVisible({ waba_phone_number_id: MARKETING }, SUPPORT), false);
});

test('the id comparison is by string — a numeric id from one side must not defeat the match', () => {
  assert.equal(isSupportVisible({ channel: 'whatsapp', waba_phone_number_id: 1266501519877668 }, SUPPORT), true);
});

test('partition keeps order and loses nothing', () => {
  const threads = [
    { id: 'a', channel: 'whatsapp', waba_phone_number_id: MARKETING },
    { id: 'b', channel: 'whatsapp', waba_phone_number_id: SUPPORT },
    { id: 'c', channel: 'email' },
    { id: 'd', channel: 'whatsapp', waba_phone_number_id: MARKETING },
  ];
  const { visible, hidden } = partitionBySupport(threads, SUPPORT);
  assert.deepEqual(visible.map((t) => t.id), ['b', 'c']);
  assert.deepEqual(hidden.map((t) => t.id), ['a', 'd']);
  assert.equal(visible.length + hidden.length, threads.length);
});

test('partition of nothing is two empty lists, not a throw', () => {
  assert.deepEqual(partitionBySupport(undefined, SUPPORT), { visible: [], hidden: [] });
});

test('the PostgREST clause expresses the same three-way rule', () => {
  assert.equal(
    supportVisibleClause(SUPPORT),
    `or=(channel.neq.whatsapp,waba_phone_number_id.is.null,waba_phone_number_id.eq.${SUPPORT})`,
  );
});
