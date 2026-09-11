// Web chat widget: bare http(s) URLs in bot/agent text render as clickable links (S372).
// linkify lives inside the widgetJs() template string, so the test pulls it out of the
// GENERATED script — which also proves the doubled backslashes survive the template.
//   node test/bot-widget-linkify.test.js
const assert = require('assert');
const { widgetJs } = require('../src/bot-widget.js');

const js = widgetJs('bot', 'https://x');
const start = js.indexOf('function linkify');
const end = js.indexOf('\n  }\n', start) + 4;
assert.ok(start > 0 && end > start, 'linkify is in the generated widget');
// eslint-disable-next-line no-new-func
const linkify = new Function('document', `${js.slice(start, end)}; return linkify;`)({
  createTextNode: (t) => ({ kind: 'text', t }),
  createElement: (tag) => ({ kind: tag, style: {} }),
});
const run = (text) => { const kids = []; linkify({ appendChild: (n) => kids.push(n) }, text); return kids; };

// two links in a multi-line bot message, text preserved around them
const k = run('Ghost → https://youtu.be/fc4PU865J9O?si=abc\nShadow → https://youtu.be/_WUPq7JZ5k');
assert.deepEqual(k.map((n) => n.kind), ['text', 'a', 'text', 'a']);
assert.equal(k[1].href, 'https://youtu.be/fc4PU865J9O?si=abc');
assert.equal(k[1].textContent, k[1].href);
assert.equal(k[1].target, '_blank');
assert.equal(k[1].rel, 'noopener noreferrer');
assert.equal(k[2].t, '\nShadow → ');
// trailing sentence punctuation stays outside the link
const p = run('See https://legendoftoys.com/track.');
assert.equal(p[1].href, 'https://legendoftoys.com/track');
assert.equal(p[2].t, '.');
// markup is never interpreted: a tag stays text and cannot become part of an href
const x = run('<img src=x onerror=alert(1)> https://a.b/c"onmouseover=1');
assert.equal(x[0].kind, 'text');
assert.equal(x[1].href, 'https://a.b/c');
// no URL / non-http scheme / null → plain text only, no loop
assert.deepEqual(run('hello').map((n) => n.kind), ['text']);
assert.deepEqual(run('javascript:alert(1)').map((n) => n.kind), ['text']);
assert.deepEqual(run(null), []);
console.log('bot-widget-linkify: all assertions passed');
