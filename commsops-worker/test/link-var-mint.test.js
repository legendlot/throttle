// mintLinkVariable (S290) — per-recipient /r/ minting for a template's link variable.
// Run: node test/link-var-mint.test.js
const assert = require('assert');
const LINKS = require('../src/links.js');
const { mintLinkVariable } = require('../src/send.js');

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); }
                            catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const origBase = LINKS.getLinkBaseUrl;
const origMint = LINKS.mintLink;
function stub({ base = 'https://lottoys.in', code = 'AbC123xY' } = {}) {
  const calls = [];
  LINKS.getLinkBaseUrl = async () => base;
  LINKS.mintLink = async (env, opts) => { calls.push(opts); return code; };
  return calls;
}

const TPL = {
  content: { link_param: 'link', link_target_base: 'https://www.legendoftoys.com/sale' },
  variables: [{ token: 'link', source: 'constant', fallback: 'https://lottoys.in/r/sale-rcs' }],
};

(async () => {
  await t('mints per send and injects the full /r/ url under the constants key', async () => {
    const calls = stub({});
    const ctx = { constants: { code: 'FREEDOM5' }, event: {} };
    await mintLinkVariable({}, TPL, ctx, { _reservedId: 'm1', profileId: 'p1' }, 'rcs', 'marketing', {});
    assert.strictEqual(ctx.constants.link, 'https://lottoys.in/r/AbC123xY');
    assert.strictEqual(ctx.constants.code, 'FREEDOM5');       // other constants untouched
    assert.strictEqual(calls[0].messageId, 'm1');
    assert.strictEqual(calls[0].profileId, 'p1');
    assert.strictEqual(calls[0].target, 'https://www.legendoftoys.com/sale');
  });

  await t('an event-sourced link variable also gets the event field injected', async () => {
    stub({});
    const tpl = { content: TPL.content,
      variables: [{ token: 'link', source: 'event', field: 'checkout_url' }] };
    const ctx = { constants: {}, event: {} };
    await mintLinkVariable({}, tpl, ctx, {}, 'sms', 'marketing', {});
    assert.strictEqual(ctx.event.checkout_url, 'https://lottoys.in/r/AbC123xY');
  });

  await t('no link_param configured → no mint, ctx untouched', async () => {
    const calls = stub({});
    const ctx = { constants: {}, event: {} };
    await mintLinkVariable({}, { content: {}, variables: [] }, ctx, {}, 'sms', 'marketing', {});
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(ctx.constants, {});
  });

  await t('mint failure is best-effort: ctx untouched, nothing thrown (fallback still renders)', async () => {
    LINKS.getLinkBaseUrl = async () => 'https://lottoys.in';
    LINKS.mintLink = async () => { throw new Error('link_mint_failed:boom'); };
    const ctx = { constants: {}, event: {} };
    await mintLinkVariable({}, TPL, ctx, {}, 'rcs', 'marketing', {});
    assert.strictEqual(ctx.constants.link, undefined);
  });

  await t('no link base configured (feature off) → no mint', async () => {
    LINKS.getLinkBaseUrl = async () => null;
    const calls = [];
    LINKS.mintLink = async (env, o) => { calls.push(o); return 'x'; };
    const ctx = { constants: {}, event: {} };
    await mintLinkVariable({}, TPL, ctx, {}, 'sms', 'marketing', {});
    assert.strictEqual(calls.length, 0);
  });

  LINKS.getLinkBaseUrl = origBase; LINKS.mintLink = origMint;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
