// S355 — resume redraw never leaks customer_message rows (spec §6②). Run: node test/web-resume.test.js
const assert = require('assert');
const BW = require('../src/bot-web.js');
const rows = [
  { id: 1, step_type: 'open', result: null },
  { id: 2, step_type: 'bot_message', result: { text: 'Hi', buttons: [{ id: 'a', label: 'A' }], style: 'buttons' } },
  { id: 3, step_type: 'customer_message', result: { text: '9876543210' } },
  { id: 4, step_type: 'agent_reply', result: { text: 'Hello from Sunitha', agent_name: 'Sunitha' } },
];
assert.deepEqual(BW.resumeHistory(rows), [
  { id: 2, who: 'bot', text: 'Hi', buttons: [{ id: 'a', label: 'A' }], style: 'buttons', agent_name: null },
  { id: 4, who: 'agent', text: 'Hello from Sunitha', buttons: null, style: null, agent_name: 'Sunitha' },
]);
assert.equal(BW.isResumable({ status: 'active', last_activity_at: new Date().toISOString() }), true);
assert.equal(BW.isResumable({ status: 'active', last_activity_at: new Date(Date.now() - 7 * 3600e3).toISOString() }), false);
assert.equal(BW.isResumable({ status: 'handed_off', last_activity_at: new Date().toISOString() }), true);   // agent replies still poll
assert.equal(BW.isResumable({ status: 'ended', last_activity_at: new Date().toISOString() }), false);
console.log('web-resume ok');
