// sanitizeRich — the review-box HTML whitelist (S396). Stored HTML is rendered with innerHTML.
import test from 'node:test';
import assert from 'node:assert';
import { sanitizeRich } from '../src/richtext.mjs';

test('keeps the whitelisted formatting tags', () => {
  const html = '<p>Hi <strong>there</strong> <em>you</em></p><ul><li>one</li><li>two</li></ul><ol><li>a</li></ol><br>';
  assert.strictEqual(sanitizeRich(html), html);
});
test('drops every attribute, including event handlers and styles', () => {
  assert.strictEqual(sanitizeRich('<p onclick="x()" style="color:red">a</p>'), '<p>a</p>');
  assert.strictEqual(sanitizeRich('<b class="x" onmouseover=alert(1)>b</b>'), '<b>b</b>');
});
test('removes script/style blocks with their content, and non-whitelisted tags', () => {
  assert.strictEqual(sanitizeRich('<p>a</p><script>alert(1)</script><style>p{}</style>'), '<p>a</p>');
  assert.strictEqual(sanitizeRich('<img src=x onerror=alert(1)><a href="javascript:x">l</a>'), 'l');
  assert.strictEqual(sanitizeRich('<SCRIPT >alert(1)</SCRIPT >ok'), 'ok');
  assert.strictEqual(sanitizeRich('<p/onclick=x>a'), '<p>a');
  assert.strictEqual(sanitizeRich('<svg><script>alert(1)</script></svg>t'), 't');
});
test('escapes stray angle brackets in text', () => {
  assert.strictEqual(sanitizeRich('<p>a < b and c > d</p>'), '<p>a &lt; b and c &gt; d</p>');
  assert.strictEqual(sanitizeRich('<p>x<img src=x onerror=alert(1)'), '<p>x&lt;img src=x onerror=alert(1)');
});
test('an unclosed script tag leaves only inert text', () => {
  assert.strictEqual(sanitizeRich('<script>alert(1)'), 'alert(1)');
});
test('comments are removed; entities pass through', () => {
  assert.strictEqual(sanitizeRich('<p>a<!-- <script>x</script> -->&amp;&nbsp;</p>'), '<p>a&amp;&nbsp;</p>');
});
