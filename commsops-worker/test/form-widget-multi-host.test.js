// test/form-widget-multi-host.test.js — S342.
// The widget must initialise EVERY host div, exactly once each.
//
// WHY: found by the storefront lane on the real Focal theme — the product form is rendered three
// times in the raw HTML (main + quick-buy drawer + quick-buy popover <template>s). Only one host is
// in the live DOM on a sold-out PDP today, so this is latent rather than live. But the old code did
// `document.querySelector(...)` (singular): a second instantiated host would inject a second copy of
// this script, and that copy would re-initialise the FIRST host — blowing away a customer's
// half-typed email and orphaning the Turnstile widget already rendered into it.
//
// This runs the GENERATED script against a minimal fake DOM, so it tests behaviour, not spelling.
const assert = require('assert');
const { formWidgetJs } = require('../src/form-widget.js');
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
  catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

// Minimal DOM: enough for the widget's own calls and nothing more.
function makeHost() {
  const attrs = {};
  return {
    _initCount: 0, _html: '',
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    set innerHTML(v) { this._html = v; this._initCount++; },
    get innerHTML() { return this._html; },
    querySelector: () => ({
      addEventListener() {}, style: {}, querySelector: () => ({ disabled: false }),
      email: { value: '' }, wa: { checked: false, addEventListener() {} },
      phone: { value: '', style: {} }, website: { value: '' },
    }),
  };
}
function run(hostCount, scriptCopies) {
  const hosts = Array.from({ length: hostCount }, makeHost);
  // ⚠️ SELECTOR-AWARE, deliberately. A stub that answers every selector with the same object is
  // how three separate suites broke this session: it silently satisfies code paths it was never
  // written for. `script[data-lotf-ts]` is the single-load guard and must start absent.
  let tsScript = null;
  const document = {
    querySelectorAll: () => hosts,
    querySelector: (sel) => (String(sel).includes('data-lotf-ts') ? tsScript : (hosts[0] || null)),
    createElement: () => ({ set onload(_) {}, style: {}, addEventListener() {},
      setAttribute() {}, getAttribute: () => null }),
    head: { appendChild(el) { tsScript = el; } }, body: { appendChild() {} },
  };
  const js = formWidgetJs('back-in-stock', 'https://x.workers.dev', 'KEY');
  const fn = new Function('document', 'window', 'location', 'fetch', js);
  for (let i = 0; i < scriptCopies; i++) {
    fn(document, { turnstile: null }, { href: 'https://www.legendoftoys.com/p/x' }, () => {});
  }
  return hosts;
}

(async () => {
  t('one host, one script copy → initialised exactly once', () => {
    const hosts = run(1, 1);
    assert.equal(hosts[0]._initCount, 1);
  });

  t('THREE hosts → ALL three initialised (the querySelector-singular bug)', () => {
    const hosts = run(3, 1);
    assert.deepEqual(hosts.map((h) => h._initCount), [1, 1, 1],
      'every host div must get its own form');
  });

  t('a SECOND copy of the script does NOT re-init an existing host', () => {
    // The real scenario: a quick-buy drawer injects both another host and another <script>.
    const hosts = run(2, 3);
    assert.deepEqual(hosts.map((h) => h._initCount), [1, 1],
      're-initialising would wipe a half-typed email and orphan the Turnstile widget');
  });

  t('no hosts → no crash, no work', () => {
    assert.doesNotThrow(() => run(0, 1));
  });

  t('generated script is syntactically valid', () => {
    assert.doesNotThrow(() => new Function(formWidgetJs('s', 'b', 'k')));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
