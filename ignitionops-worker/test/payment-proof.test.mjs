// S373 hostile review — deal payments had the same unscoped proof_path delete as ad payments (F5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentProofPathOk } from '../src/index.js';

const EID = '882bc20a-0d39-48f4-a8e4-62d78f47cb7c';

test('paymentProofPathOk accepts only this deal\'s own upload path', () => {
  assert.equal(paymentProofPathOk(`${EID}/1757570000000_shot.png`, EID), true);
  for (const bad of [
    `ad-payments/${EID}/1_shot.png`,              // an ad payment's proof
    `other-deal/1_shot.png`,                      // another deal's
    `${EID}/`, `${EID}`,                          // the folder itself
    `${EID}/../other-deal/1_shot.png`,            // dot-segments
    `${EID}/./x.png`, `${EID}//x.png`,
    '', null, 42,
  ]) assert.equal(paymentProofPathOk(bad, EID), false, String(bad));
  assert.equal(paymentProofPathOk(`${EID}/x.png`, ''), false, 'no deal id, no pass');
});
