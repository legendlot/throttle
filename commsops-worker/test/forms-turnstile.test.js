// test/forms-turnstile.test.js — the bot gate on the public capture surface (S331 SP1).
// ⚠️ EVERY failure path must return false. A challenge that fails OPEN is not a challenge.
const assert = require('assert');
const { verifyTurnstile } = require('../src/forms.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const origFetch = globalThis.fetch;
const ENV = { TURNSTILE_SECRET: 's3cret' };

(async () => {
  await t('a valid token passes', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), true);
  });

  await t('an invalid token fails', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: false }) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('an absent token fails without calling out', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ success: true }) }; };
    assert.equal(await verifyTurnstile(ENV, '', '1.2.3.4'), false);
    assert.equal(called, false, 'must not call siteverify with an empty token');
  });

  await t('a network error fails CLOSED', async () => {
    globalThis.fetch = async () => { throw new Error('boom'); };
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('a non-200 from siteverify fails CLOSED', async () => {
    // ⚠️ The body deliberately says success:true. If the `!r.ok` guard were deleted, this
    // would return TRUE — which is exactly the regression this test exists to catch. A mock
    // returning {} passes with or without the guard and therefore proves nothing.
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('an unconfigured secret fails CLOSED, never open', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile({}, 'tok', '1.2.3.4'), false);
  });

  // -- F6: the widget must never resend a SPENT turnstile token -----------------
  // /!\ A Turnstile token is SINGLE-USE. The widget captured it once and never reset it, so a
  // customer who mistyped their email, read `bad_email`, corrected it and pressed Notify me
  // again resent the spent token and got `challenge_failed` -- forever, until a full page
  // reload. The typo bricked the widget. Reset after EVERY response, success or failure.
  const { formWidgetJs } = require('../src/form-widget.js');

  // A DOM small enough to run the generated IIFE and nothing more.
  function mountWidget(responses) {
    const state = { resets: 0, renders: 0, sent: [], render: null, script: null };
    const button = { disabled: false };
    const form = {
      email: { value: 'a@b.com' }, website: { value: '' },
      phone: { value: '', style: {} }, wa: { checked: false, addEventListener() {} },
      addEventListener(type, h) { if (type === 'submit') state.submit = h; },
      querySelector: (sel) => (sel === 'button' ? button : null),
    };
    const msg = { textContent: '' };
    // ⚠️ `getAttribute` must answer BOTH keys: `data-product` (the payload) and, since S342,
    // `data-lotf-init` (the once-only guard). Returning a truthy value for every attribute would
    // make the widget think it was already initialised and silently render nothing.
    const hostAttrs = { 'data-product': 'GH-PB-49' };
    const host = {
      innerHTML: '',
      getAttribute: (k) => (k in hostAttrs ? hostAttrs[k] : null),
      setAttribute: (k, v) => { hostAttrs[k] = v; },
      querySelector: (sel) => (sel === 'form' ? form : sel === '.lotf-msg' ? msg : { id: 'ts-box' }),
    };
    const documentStub = {
      // S342: the widget initialises EVERY host, so it selects with querySelectorAll now.
      querySelectorAll: () => [host],
      querySelector: () => host,
      createElement: () => (state.script = { onload: null }),
      head: { appendChild() {} },
    };
    const windowStub = {
      turnstile: {
        render(_el, opts) { state.renders++; state.render = opts; },
        reset() { state.resets++; },
      },
    };
    const fetchStub = (url, init) => {
      state.sent.push(JSON.parse(init.body));
      const r = responses[state.sent.length - 1];
      if (r === 'network_error') return Promise.reject(new Error('offline'));
      return Promise.resolve({ json: () => Promise.resolve(r) });
    };
    const src = formWidgetJs('back-in-stock', 'https://w.dev', 'SITEKEY');
    new Function('window', 'document', 'location', 'fetch', src)(
      windowStub, documentStub, { href: 'https://shop/p/1' }, fetchStub);
    state.script.onload();                 // Turnstile's api.js arrives
    return { state, button, msg, form,
      solve: (t) => state.render.callback(t),
      submit: async () => { state.submit({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 0)); } };
  }

  await t('after a FAILED submit the token is reset, so the retry cannot resend a spent one', async () => {
    const w = mountWidget([{ ok: false, error: 'bad_email' }, { ok: true }]);
    w.solve('T1');
    await w.submit();
    assert.equal(w.state.sent[0].turnstile_token, 'T1');
    assert.equal(w.state.resets, 1, 'window.turnstile.reset() must run after every response');
    assert.equal(w.button.disabled, false, 'a failed submit must stay retryable');
    // The corrected retry, BEFORE Turnstile has handed back a new token.
    await w.submit();
    assert.notEqual(w.state.sent[1].turnstile_token, 'T1',
      'resending the spent token is challenge_failed forever until a full page reload');
    assert.equal(w.state.sent[1].turnstile_token, '');
    // ...and once Turnstile re-solves, the fresh token is what goes out.
    w.solve('T2');
    await w.submit();
    assert.equal(w.state.sent[2].turnstile_token, 'T2');
  });

  await t('a SUCCESSFUL submit also resets the challenge, and only then disables the button', async () => {
    const w = mountWidget([{ ok: true }]);
    w.solve('T1');
    await w.submit();
    assert.equal(w.state.resets, 1);
    assert.equal(w.button.disabled, true, 'disabled ONLY on genuine success');
  });

  await t('a network failure resets the challenge too, and the retry is not spent', async () => {
    const w = mountWidget(['network_error', { ok: true }]);
    w.solve('T1');
    await w.submit();
    assert.equal(w.state.resets, 1, 'the catch branch must reset as well - the token was still spent');
    assert.equal(w.button.disabled, false);
    w.solve('T2');
    await w.submit();
    assert.equal(w.state.sent[1].turnstile_token, 'T2');
  });

  globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
