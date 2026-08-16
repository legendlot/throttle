// Vendor template write layer (S290 part 3) — validation + param derivation, no network.
// Run: node test/vendor-template-write.test.js
const assert = require('assert');
const RCSTPL = require('../src/rcs-templates.js');
const SMSTPL = require('../src/sms-templates.js');

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); }
                            catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

(async () => {
  await t('bracketParams: ordered by first appearance, deduped, across texts', () => {
    assert.deepStrictEqual(
      RCSTPL.bracketParams('Hey [name]! [offer] for [name]', 'Card [code]'),
      ['name', 'offer', 'code']);
  });

  await t('rcs create refuses a bad name (vendor rule: ≤20, alphanumeric+underscore)', async () => {
    const r = await RCSTPL.tsCreateRcsTemplate({}, { name: 'has spaces!', type: 'text_message', botId: 'b' });
    assert.match(r.error, /invalid_name/);
  });
  await t('rcs create refuses a suggestion without a postback (learned live on Freedom_Sale_Card)', async () => {
    const r = await RCSTPL.tsCreateRcsTemplate({}, {
      name: 'X', type: 'text_message', botId: 'b', textMessageContent: 'hi',
      suggestions: [{ suggestionType: 'url_action', displayText: 'Go', url: 'https://x', postback: '' }],
    });
    assert.strictEqual(r.error, 'suggestion_postback_required');
  });
  await t('rcs rich_card requires title + description + media', async () => {
    const r = await RCSTPL.tsCreateRcsTemplate({}, { name: 'X', type: 'rich_card', botId: 'b', standAlone: { cardTitle: 'T' } });
    assert.match(r.error, /card_title_and_description|media_url/);
  });
  await t('carousel is refused loudly, not half-supported', async () => {
    const r = await RCSTPL.tsCreateRcsTemplate({}, { name: 'X', type: 'carousel', botId: 'b' });
    assert.match(r.error, /type_not_yet_composable/);
  });

  await t('sms create refuses a non-19-digit DLT id (the portal id is the whole point)', async () => {
    const r = await SMSTPL.tsCreateSmsTemplate({}, { name: 'X', content: 'c', header: 'LGNDRC', template_type: 'explicit', dlt_template_id: '123' });
    assert.match(r.error, /dlt_template_id_required/);
  });
  await t('sms create refuses an unset consent type (assertBindable would refuse the send anyway)', async () => {
    const r = await SMSTPL.tsCreateSmsTemplate({}, { name: 'X', content: 'c', header: 'LGNDRC', template_type: '', dlt_template_id: '1'.repeat(19) });
    assert.match(r.error, /invalid_template_type/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
