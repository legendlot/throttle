// linkify — bot text → text/link parts, the same rule as the storefront widget. Run from apps/relay:
//   node src/lib/linkify.test.mjs
import assert from 'node:assert/strict';
import { splitLinks, trimUrl } from './linkify.js';

const kinds = (parts) => parts.map((p) => (p.url ? 'a' : 't'));
const urls = (parts) => parts.filter((p) => p.url).map((p) => p.url);

// Pruthvi's WA Bot message: several links across lines, the text around them intact
const pr = splitLinks('👻 Ghost → https://youtu.be/fc4PU865J9O?si=abc\n🌍 Shadow → https://youtu.be/_WUPq7JZ5k?si=Yr8');
assert.deepEqual(kinds(pr), ['t', 'a', 't', 'a']);
assert.deepEqual(urls(pr), ['https://youtu.be/fc4PU865J9O?si=abc', 'https://youtu.be/_WUPq7JZ5k?si=Yr8']);
assert.equal(pr[2].text, '\n🌍 Shadow → ');

// trailing punctuation stays outside; a balanced `)` stays inside
assert.deepEqual(urls(splitLinks('See https://legendoftoys.com/track.')), ['https://legendoftoys.com/track']);
assert.deepEqual(urls(splitLinks('(https://en.wikipedia.org/wiki/Foo_(bar))')), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
assert.equal(trimUrl('https://x.com/a)'), 'https://x.com/a');
assert.equal(trimUrl('https://x.com/?q=1!?.'), 'https://x.com/?q=1');
// WhatsApp formatting marks around a URL stay out of the href
assert.deepEqual(urls(splitLinks('*https://x.com/p*')), ['https://x.com/p']);
// emoji / unicode punctuation right after a URL are never part of it
assert.deepEqual(urls(splitLinks('https://x.com🏎️ go')), ['https://x.com']);
assert.deepEqual(urls(splitLinks('open https://x.com/a…')), ['https://x.com/a']);
// scheme is case-insensitive
assert.deepEqual(urls(splitLinks('HTTPS://X.COM/A')), ['HTTPS://X.COM/A']);

// never a link: other schemes, markup, a bare scheme; null-safe
assert.deepEqual(kinds(splitLinks('javascript:alert(1)')), ['t']);
assert.deepEqual(urls(splitLinks('<a href="https://x.com">y</a>')), ['https://x.com']);
assert.ok(urls(splitLinks('data:text/html,<b>x</b>')).length === 0);
assert.deepEqual(kinds(splitLinks('https://...')), ['t']);
assert.deepEqual(splitLinks(null), []);
assert.deepEqual(splitLinks(42), [{ text: '42' }]);
// nothing is lost: the parts rebuild the original string
const src = 'a https://x.com/b). c https://y.org d';
assert.equal(splitLinks(src).map((p) => p.url || p.text).join(''), src);

// linear on adversarial input (the old trim regex took ~4 s at 100k)
const t0 = Date.now();
splitLinks('https://' + '.'.repeat(100000) + 'x');
splitLinks('https://x.com/' + ')'.repeat(100000));
assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms`);

console.log('linkify: all assertions passed');
