const { test } = require('node:test');
const assert = require('node:assert');
const { assetPath, signToUrls } = require('../src/email-assets.js');

test('assetPath sanitizes filename, keeps extension, namespaces under email/', () => {
  assert.strictEqual(assetPath('My Logo (final).PNG', 1700000000000), 'email/1700000000000_my-logo-final-.png');
});
test('assetPath falls back to upload when empty', () => {
  assert.strictEqual(assetPath('', 1700000000000), 'email/1700000000000_upload');
});
test('assetPath strips path separators (no traversal)', () => {
  assert.strictEqual(assetPath('../../etc/passwd', 1700000000000), 'email/1700000000000_passwd');
});
test('signToUrls extracts the token and builds the public URL', () => {
  const env = { SUPABASE_URL: 'https://x.supabase.co' };
  const out = signToUrls(env, 'relay-email-assets', 'email/1_a.png',
    { url: '/object/upload/sign/relay-email-assets/email/1_a.png?token=abc.def' });
  assert.strictEqual(out.storage_path, 'email/1_a.png');
  assert.strictEqual(out.token, 'abc.def');
  assert.strictEqual(out.public_url, 'https://x.supabase.co/storage/v1/object/public/relay-email-assets/email/1_a.png');
});
test('signToUrls returns null token when absent', () => {
  const out = signToUrls({ SUPABASE_URL: 'https://x.supabase.co' }, 'relay-email-assets', 'email/1_a.png', { url: '/nope' });
  assert.strictEqual(out.token, null);
});
