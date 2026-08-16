// PRE-SUBMIT lint for WhatsApp templates — the gate that stops the resubmission loop.
//
// WHY THIS EXISTS. Every rejected submission costs far more than the submission itself: Meta
// allows ONE edit per active template per 24 hours (subcode 2388124), so a rejection or a
// wrong-first-time submit burns the day. Worse, Meta's rejection text is usually a bare
// "Invalid parameter" with the actionable detail buried in `error_user_title`/`error_user_msg`,
// so the author often cannot tell WHAT was wrong and iterates blind.
//
// The codebase already had a no-op-edit guard (`sameAsMeta`) and a POST-approval shape check
// (`waCheckTemplateShape`). It had no pre-submit validation at all — and `reference/bitespeed.md`
// wrongly claimed the trailing-placeholder rule was "caught locally by validateWaTemplate", a
// function that never existed. This is that function, for real.
//
// EVERY RULE BELOW IS ONE WE HAVE ALREADY PAID FOR, or a documented Meta limit. Adding a rule
// here is always cheaper than a review round-trip — when a rejection teaches us something new,
// encode it here first.
//
// Contract: lintWaTemplate(content) → { ok, errors[], warnings[] }.
//   errors   = Meta will reject, or the send will fail. Block the submit.
//   warnings = legal but very likely not what the author meant. Surface, don't block.

const MEDIA_HEADERS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
const VALID_CATEGORIES = new Set(['MARKETING', 'UTILITY', 'AUTHENTICATION']);

// Meta's published limits.
const LIMIT = { body: 1024, headerText: 60, footer: 60, buttonText: 25, name: 512 };

const placeholders = (s) => [...String(s || '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));

// The ONLY keys send.js ever puts in the `system` render context (src/send.js — `sys`), and it is
// empty entirely on the WhatsApp path. A `source:'system'` variable naming anything else can never
// resolve, on any recipient, so it is a guaranteed send failure rather than a risk.
const SYSTEM_FIELDS = new Set(['unsubscribe_url']);

// `variables` is OPTIONAL: pass the template row's variables to enable the mapping↔variable
// cross-check, omit it to lint `content` alone (what most callers and every older test do).
function lintWaTemplate(content = {}, variables) {
  const errors = [];
  const warnings = [];
  const err = (code, detail) => errors.push({ code, detail });
  const warn = (code, detail) => warnings.push({ code, detail });

  const body = String(content.body || '');
  const headerFormat = String(content.header_format || 'TEXT').toUpperCase();
  const mapping = Array.isArray(content.mapping) ? content.mapping : [];
  const buttons = Array.isArray(content.buttons) ? content.buttons : [];

  // ── identity ────────────────────────────────────────────────────────────────────────
  const name = String(content.meta_name || '');
  if (!name) err('name_missing', 'meta_name is required.');
  // Meta: lowercase letters, digits and underscores only. A capital or hyphen is rejected.
  else if (!/^[a-z0-9_]+$/.test(name)) {
    err('name_charset', `meta_name "${name}" must be lowercase a-z, 0-9 and underscore only — `
      + 'capitals, spaces and hyphens are rejected.');
  }
  if (name.length > LIMIT.name) err('name_too_long', `meta_name is ${name.length} chars (max ${LIMIT.name}).`);

  // `content.category` is OPTIONAL: waSubmitTemplate derives it from the template row's
  // `purpose` (marketing → MARKETING, else UTILITY) when unset, so demanding it here would
  // reject perfectly valid templates. Only validate the value when one IS given.
  const category = String(content.category || '').toUpperCase();
  if (category && !VALID_CATEGORIES.has(category)) {
    err('category_invalid', `category must be one of ${[...VALID_CATEGORIES].join('/')} — got "${category}".`);
  }
  // Templates are WABA-SCOPED and non-transferable. Submitting without a pin means it lands on
  // whatever the global default happens to be — the exact bug that put templates on the dead
  // marketing WABA in S232.
  if (!content.waba_id) {
    err('waba_unpinned', 'content.waba_id is not set. Templates are WABA-scoped; without a pin '
      + 'this can land on the wrong account and will not be sendable from the intended number.');
  }

  // ── body ────────────────────────────────────────────────────────────────────────────
  if (!body) err('body_missing', 'body is required.');
  if (body.length > LIMIT.body) err('body_too_long', `body is ${body.length} chars (max ${LIMIT.body}).`);

  const bodyVars = placeholders(body);

  // THE RULE THAT COST A ROUND-TRIP on lot_checkout_abandoned_02: Meta refuses a body that ENDS
  // with a placeholder, with a bare "Invalid parameter" and no explanation.
  if (/\{\{\d+\}\}\s*$/.test(body)) {
    err('body_ends_with_placeholder', 'Body ends with a {{n}} placeholder. Meta rejects this with '
      + 'an unexplained "Invalid parameter". Add a closing line after the last variable.');
  }
  // Same family, same opaque rejection.
  if (/^\s*\{\{\d+\}\}/.test(body)) {
    err('body_starts_with_placeholder', 'Body starts with a {{n}} placeholder. Meta rejects this. '
      + 'Lead with text (e.g. "Hi {{1}}," rather than "{{1}},").');
  }
  // Two placeholders with only whitespace between them read as one unresolvable slot to Meta.
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) {
    err('body_adjacent_placeholders', 'Two {{n}} placeholders sit next to each other with no text '
      + 'between them. Meta rejects this — separate them with literal text.');
  }
  // Placeholders must be 1..N with no gaps and no repeats-out-of-order.
  if (bodyVars.length) {
    const uniq = [...new Set(bodyVars)].sort((a, b) => a - b);
    const expected = Array.from({ length: uniq.length }, (_, i) => i + 1);
    if (JSON.stringify(uniq) !== JSON.stringify(expected)) {
      err('body_placeholder_sequence', `Body placeholders are {{${uniq.join('}}, {{')}}} — they must `
        + `be sequential from 1 with no gaps ({{${expected.join('}}, {{')}}}).`);
    }
  }

  // ── mapping ↔ placeholders ──────────────────────────────────────────────────────────
  // A mismatch here is not a Meta rejection — it is worse: the template is APPROVED and every
  // SEND then fails with #132000/#132018, which reads like the template is missing.
  const bodyMap = mapping.filter((m) => (m.component || 'body') === 'body');
  const uniqBodyVars = new Set(bodyVars);
  if (bodyMap.length !== uniqBodyVars.size) {
    err('mapping_count', `Body has ${uniqBodyVars.size} distinct placeholder(s) but ${bodyMap.length} `
      + 'mapping entr(ies). Every {{n}} needs exactly one mapping, or every send fails (#132000).');
  }
  for (const m of mapping) {
    if (!m.token) err('mapping_no_token', `A ${m.component || 'body'} mapping entry has no token.`);
    // Meta requires a sample value for every variable at submission.
    if (m.example === undefined || m.example === null || m.example === '') {
      err('mapping_no_example', `Mapping "${m.token}" has no example. Meta requires a sample value `
        + 'for every variable and rejects the submission without one.');
    }
  }
  const positions = bodyMap.map((m) => Number(m.pos)).sort((a, b) => a - b);
  const expectedPos = Array.from({ length: bodyMap.length }, (_, i) => i + 1);
  if (bodyMap.length && JSON.stringify(positions) !== JSON.stringify(expectedPos)) {
    err('mapping_positions', `Body mapping positions are [${positions.join(', ')}] — must be `
      + `[${expectedPos.join(', ')}] to line up with {{1}}…{{n}}.`);
  }

  // ── header ──────────────────────────────────────────────────────────────────────────
  if (MEDIA_HEADERS.has(headerFormat)) {
    const mapped = mapping.some((m) => m.component === 'header');
    if (!mapped && !content.header_media_url) {
      err('media_header_no_asset', 'Media header with neither a mapped header variable nor a static '
        + 'header_media_url — every send fails closed with media_header_missing_url.');
    }
  } else if (headerFormat === 'TEXT') {
    const h = String(content.header || '');
    if (h.length > LIMIT.headerText) err('header_too_long', `Header text is ${h.length} chars (max ${LIMIT.headerText}).`);
    // Meta rejects newlines/tabs anywhere in a text header.
    if (/[\n\r\t]/.test(h)) err('header_whitespace', 'Header text cannot contain newlines or tabs.');
    if (placeholders(h).length > 1) err('header_one_var', 'A TEXT header may contain at most one {{1}}.');
  }

  // ── footer ──────────────────────────────────────────────────────────────────────────
  const footer = String(content.footer || '');
  if (footer.length > LIMIT.footer) err('footer_too_long', `Footer is ${footer.length} chars (max ${LIMIT.footer}).`);
  // Footers are static by definition; a {{n}} there is silently undeliverable.
  if (placeholders(footer).length) {
    err('footer_has_placeholder', 'Footer cannot contain {{n}} placeholders — Meta does not accept '
      + 'footer parameters.');
  }

  // ── buttons ─────────────────────────────────────────────────────────────────────────
  if (buttons.length > 10) err('too_many_buttons', `${buttons.length} buttons (max 10).`);
  const urlButtons = buttons.filter((b) => String(b.type || '').toUpperCase() === 'URL');
  const phoneButtons = buttons.filter((b) => String(b.type || '').toUpperCase() === 'PHONE_NUMBER');
  if (urlButtons.length > 2) err('too_many_url_buttons', `${urlButtons.length} URL buttons (max 2).`);
  if (phoneButtons.length > 1) err('too_many_phone_buttons', `${phoneButtons.length} phone buttons (max 1).`);

  buttons.forEach((b, i) => {
    const text = String(b.text || '');
    if (!text) err('button_no_text', `Button ${i + 1} has no text.`);
    if (text.length > LIMIT.buttonText) {
      err('button_text_too_long', `Button ${i + 1} text is ${text.length} chars (max ${LIMIT.buttonText}).`);
    }
    if (String(b.type || '').toUpperCase() === 'URL') {
      const url = String(b.url || '');
      if (!url) { err('button_no_url', `URL button ${i + 1} has no url.`); return; }
      const vars = placeholders(url);
      if (vars.length > 1) {
        err('button_multi_var', `URL button ${i + 1} has ${vars.length} placeholders. Meta allows a `
          + 'static base plus at most ONE trailing {{1}}.');
      }
      // THE DOCUMENTED TRAP (shopflo.js): a URL button is "static base + ONE TRAILING {{1}}",
      // not a whole-URL slot. Binding a full URL to it yields …/cart/https://…/cart/… — a dead
      // link that still PASSES review, because Meta only ever sees the base.
      if (vars.length === 1 && !/\{\{1\}\}\s*$/.test(url)) {
        err('button_var_not_trailing', `URL button ${i + 1}: the {{1}} must be the LAST thing in the `
          + 'url (static base + trailing variable). Anything else produces a broken link that '
          + 'still passes review.');
      }
      // Ask the question the SUBMITTER will ask, not a narrower one. buildComponents()
      // (wa-templates.js) derives the sample url from `example_suffix`, else the matching
      // button mapping slot, else the literal 'sample' — and only falls back to the button's
      // own `example` when none of that applies. Linting `b.example` alone therefore blocked
      // templates that would have serialised perfectly well: a LOT Build template authored
      // with the suffix in its mapping slot (the shape the editor writes) was refused with a
      // bare `lint_failed` and could not be submitted at all (Pruthvi 2026-08-05).
      // Slot matching mirrors the serialiser EXACTLY, `s.index ?? 0` included, so lint and
      // submit can never disagree. NB that default collapses every `pos`-only slot onto
      // button 0 — harmless for the single-URL-button templates we author, and a real
      // multi-button mapping must carry an explicit `index` for either path to address it.
      const btnSlots = mapping.filter((m) => (m.component || 'body') === 'button');
      // NB there is no longer a "no example" error to raise: buildComponents() falls back to
      // DEFAULT_URL_EXAMPLE_SUFFIX for every {{n}} URL button, so an absent example is now
      // impossible by construction. Keeping the old check would block templates that serialise
      // perfectly well — the exact failure this block was rewritten to end (Pruthvi 2026-08-05).
      //
      // What IS still worth catching is the opposite mistake, because "example" reads like
      // "where the link goes": putting the DESTINATION url in the slot. The suffix is appended
      // to `https://<host>/r/`, so a full url yields the nested
      // `https://lottoys.in/r/https://www.legendoftoys.com/collections/all` — malformed, and a
      // needless rejection risk on a template that is otherwise correct. Found on
      // `Freedom to Play Sale_15Aug` (2026-08-14), authored the evening before the sale.
      const effSuffix = b.example_suffix
        ?? btnSlots.find((s) => Number(s.index ?? 0) === i)?.example
        ?? b.example;
      if (vars.length === 1 && effSuffix != null && String(effSuffix).includes('://')) {
        err('button_example_is_url', `URL button ${i + 1}'s example is a full url `
          + `("${String(effSuffix).slice(0, 60)}"). It is only the part that goes AFTER the static `
          + 'base, so a url here produces a nested, malformed sample. Use the code suffix alone.');
      }
      const mappedBtn = mapping.some((m) => m.component === 'button');
      // A mapping slot against a STATIC button is rejected at SEND time (the S241 finding).
      if (!vars.length && mappedBtn && urlButtons.length === 1) {
        err('button_mapped_but_static', `URL button ${i + 1} is static but a button mapping exists. `
          + 'Sending a parameter for a static button is rejected — drop the mapping or add {{1}}.');
      }
      // ⚠️ `target_base` is a SECOND, equally valid supplier of the {{1}} — added 2026-08-16 for
      // the static-URL clone wave, and without this exception that wave cannot be submitted at all.
      //
      // A redirect-backed button gets its suffix at SEND time: applyButtonRedirects mints a code
      // against `target_base` and writes it into the button component, synthesizing that component
      // when the template has no button mapping slot (links.js). A STATIC template being cloned to
      // `/r/{{1}}` has no per-recipient variable to map — the whole point is that the token always
      // resolves to the base — so demanding a mapping entry here would reject exactly the shape the
      // clone wave is built on, with a message telling the author to add a variable that has no
      // value to carry.
      //
      // The check still fires for a `{{1}}` button with NEITHER a mapping slot NOR `target_base`,
      // which remains a genuine dead link: nothing anywhere would supply the parameter.
      if (vars.length === 1 && !mappedBtn && !b.target_base) {
        err('button_var_unmapped', `URL button ${i + 1} carries {{1}} but nothing supplies it — no `
          + 'mapping entry and no target_base. Every send will fail to bind it. Either map a '
          + 'variable to the button, or set target_base so a tracked link is minted at send time.');
      }
    }
  });

  // ── mapping ↔ variables (only when the caller supplied variables) ───────────────────
  // render.js throws `unresolved_variables:<token>` and FAILS THE SEND for any mapping slot whose
  // token has no resolved value. That is invisible until the first send, and on a broadcast it is
  // invisible for every recipient at once — `Freedom to Play Sale_15Aug` would have failed 100% of
  // its sends on a button slot bound to token `first` declared `source:'system'`, which the
  // WhatsApp path always renders with an empty system context. Both checks below can only fire
  // where the send is already certain to throw.
  if (Array.isArray(variables)) {
    const byToken = new Map(variables.map((v) => [v.token, v]));
    for (const m of mapping) {
      if (!m.token) continue;
      const v = byToken.get(m.token);
      if (!v) {
        err('mapping_token_undeclared', `Mapping slot "${m.token}" has no matching variable, so it `
          + 'can never resolve — every send fails with unresolved_variables.');
        continue;
      }
      const hasFallback = v.fallback !== undefined && v.fallback !== null;
      if (v.source === 'system' && !SYSTEM_FIELDS.has(v.field || v.token) && !hasFallback) {
        err('variable_system_unknown', `Variable "${m.token}" is source:'system' with field `
          + `"${v.field || v.token}", which the send context never provides (only `
          + `${[...SYSTEM_FIELDS].join(', ')}). It can never resolve — every send fails.`);
      }
    }
  }

  // ── advisory ────────────────────────────────────────────────────────────────────────
  if (category === 'MARKETING' && !/stop|unsubscribe|opt.?out/i.test(footer + body)) {
    warn('marketing_no_optout', 'Marketing template with no opt-out wording. Not a Meta rejection, '
      + 'but every other LOT marketing template carries "Reply STOP to unsubscribe."');
  }
  if (body.length > 700) {
    warn('body_long', `Body is ${body.length} chars. Long bodies read poorly on mobile and raise the `
      + 'chance of a quality-based rejection.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { lintWaTemplate, LIMIT };
