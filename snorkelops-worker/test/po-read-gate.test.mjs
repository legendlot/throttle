// getPO / getPrintPOData were ungated: any Snorkel login could walk the sequential PO numbers and
// read every price and line. Both now require procurement_view, matching the PO pages' own
// on-screen guard (PODetailClient 'Access restricted', since 2026-06-02).
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/index.js'), 'utf8');
const route = c => { const i = src.indexOf(c); assert.ok(i >= 0, c); return src.slice(i, src.indexOf("case '", i + c.length)); };

for (const c of ["case 'getPO': {", "case 'getPrintPOData': {"]) {
  test(`${c} refuses without procurement_view, before reading the PO`, () => {
    const body = route(c);
    const g = body.indexOf("if (!canView(P)) return err('No permission', 403);");
    const h = body.indexOf("query('purchase_orders'");
    assert.ok(g > 0, 'gate present');
    assert.ok(h > g, 'gate runs before the PO read');
  });
}

test('the PO detail page guards on the same key the worker does', () => {
  const page = readFileSync(join(here, '../../apps/snorkel/src/app/(auth)/procurement/pos/[poNumber]/PODetailClient.js'), 'utf8');
  assert.ok(page.includes('perms && !perms.procurement_view'));
});

test('a request only offers "Open PO" to someone who can open it', () => {
  const page = readFileSync(join(here, '../../apps/snorkel/src/app/(auth)/requests/detail/page.js'), 'utf8');
  const btn = page.indexOf('Open PO');
  assert.ok(btn > 0);
  assert.ok(page.lastIndexOf('perms?.procurement_view', btn) > page.lastIndexOf('{linked && (', btn));
});
