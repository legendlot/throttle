// The send() spine — the single outbound gateway. Render → gate → adapter → log.
// Idempotent via dedup_key. On gate-fail writes a skipped/suppressed messages row
// (never a silent drop). Exposed to internal callers; Pitstop re-points here at WA cutover.
const A = require('./auth.js');
const { renderEmail, renderWhatsapp, renderSms, renderRcs } = require('./render.js');
const { tagLinks, resolveUtm } = require('./tracking.js');
const LINKS = require('./links.js');   // Phase-B /r/<code> minting for redirect-backed buttons
const { runGate } = require('./gate.js');
const emailAdapter = require('./adapters/email.js');
const whatsappAdapter = require('./adapters/whatsapp.js');
const smsAdapter = require('./adapters/sms.js');
const rcsAdapter = require('./adapters/rcs.js');

const ADAPTERS = { email: emailAdapter, whatsapp: whatsappAdapter, sms: smsAdapter, rcs: rcsAdapter };

// Is the WA customer-service window open for this recipient ON THIS SENDING NUMBER?
// (review H5 part 3) — Meta's 24h window is per (business number ↔ customer): a window opened
// by messaging SUPPORT must NOT open free-text sends from MARKETING/TXN. No phone_number_id
// context (e.g. template branch, or a sender with no metadata) → fail closed, no DB call.
async function waWindowOpen(env, to, phoneNumberId) {
  const id = whatsappAdapter.toWaId(to);
  if (!id || !phoneNumberId) return false;
  const r = await A.sbComms(
    `/rest/v1/wa_windows?identifier_value=eq.${A.enc(id)}` +
    `&phone_number_id=eq.${A.enc(phoneNumberId)}&select=last_inbound_at&limit=1`, env);
  const row = r.ok ? r.data?.[0] : null;
  if (!row?.last_inbound_at) return false;
  return (Date.now() - new Date(row.last_inbound_at).getTime()) < 24 * 3600 * 1000;
}
const nowIso = () => new Date().toISOString();
const rand = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.round(Math.random() * 1e9)}`);

// Pure sender selection over the channel's active senders (passed oldest-first).
// Priority: WABA scope → explicit senderId pin (within that scope) → exact purpose match →
// 'all'/wildcard sender → single-sender fallback → null. Returning null (no_active_sender) is
// deliberate when there are MULTIPLE active senders and none matches: refuse rather than
// silently pick the oldest (the pre-fix bug that would route txn/support sends out the wrong
// number). 'all' is the wildcard purpose the live email sender uses; null/'' treated the same.
function pickSender(rows, { purpose, senderId, wabaId } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const channelCount = rows.length;              // pre-filter count — fallback is judged on THIS

  // WhatsApp templates are WABA-SCOPED: a template approved on WABA A simply does not exist
  // on WABA B, so sending it from a number on B is rejected by Meta as an unknown template.
  // This outranks EVERYTHING including an explicit senderId pin (review H5 part 1) — a stale
  // pin naming a sender on the wrong WABA would otherwise POST a template Meta doesn't have
  // there. Compare as strings (review H5 part 4): the waba_id lives in two independently
  // authored jsonb blobs (sender_identities.metadata, templates.content) and a number-vs-string
  // mismatch in either must not zero out the sender set via strict ===.
  if (wabaId) {
    const key = String(wabaId);
    const onWaba = rows.filter((s) => String(s.metadata?.waba_id ?? '') === key);
    if (!onWaba.length) return null;
    rows = onWaba;
  }

  if (senderId) return rows.find((s) => s.id === senderId) || null;   // pin, WITHIN the WABA scope

  const isWild = (p) => p == null || p === '' || p === 'all';
  if (purpose) {
    const exact = rows.find((s) => s.purpose === purpose);
    if (exact) return exact;                                          // oldest exact-purpose sender
  }
  const wild = rows.find((s) => isWild(s.purpose));
  if (wild) return wild;                                              // oldest wildcard sender

  // Genuinely single sender on the whole channel — unchanged (review H5 part 2 kept this
  // judged on the PRE-filter count, not the WABA-narrowed one).
  if (channelCount === 1) return rows[0];

  // WABA-narrowed to EXACTLY ONE active sender → route it, with one carve-out below.
  //
  // WHY (2026-07-28): the old rule refused here, and that refusal fired on essentially every
  // WABA-pinned template ever tested from the UI — `no_sender_on_waba` on a sender that was
  // active, correctly pinned, and the ONLY number Meta would accept. The purpose vocabularies
  // simply don't line up: templates + journey send-steps carry Meta's category (`utility`),
  // while sender rows carry a routing label (`transactional`), so the exact-match and wildcard
  // branches both miss and the pre-filter count is >1 whenever more than one number exists.
  //
  // A WABA-scoped set of one is unambiguous BY CONSTRUCTION: WhatsApp templates are WABA-scoped,
  // so that sender is the only number that can possibly send this template. There is no second
  // candidate to mis-route to — refusing doesn't prevent a wrong send, it prevents ALL sends.
  //
  // THE CARVE-OUT — the MARKETING BOUNDARY, refused in BOTH directions (H5 part 2 protected
  // both and still does). Marketing must not leave a number designated for order updates
  // (someone who opted into transactional must not be marketed to from it), and transactional
  // must not leave the marketing number (it reads as marketing to the recipient and muddies
  // that number's quality rating). So: if exactly ONE side is 'marketing', refuse.
  //
  // Everything else — `utility` vs `transactional` — is a VOCABULARY artifact, not a real
  // distinction: both are non-marketing, Meta bills both as utility, and our own templates and
  // sender rows just happen to label them differently. That mismatch is what was breaking every
  // send, and it is now allowed through.
  if (wabaId && rows.length === 1) {
    const only = rows[0];
    const sendIsMkt = purpose === 'marketing';
    const senderIsMkt = only.purpose === 'marketing';
    if (!isWild(only.purpose) && sendIsMkt !== senderIsMkt) return null;   // crosses the marketing boundary
    return only;
  }
  return null;
}

// Route to the right sender for (channel, purpose), honoring an explicit opts.senderId.
// Fetches ALL active senders for the channel (tiny set) ordered oldest-first, then picks.
async function getActiveSender(env, channel, purpose, senderId, wabaId, phoneNumberId) {
  const r = await A.sbComms(
    `/rest/v1/sender_identities?channel=eq.${A.enc(channel)}&status=eq.active&select=*&order=created_at.asc`, env);
  const rows = (r.ok && r.data) || [];
  // REPLY-ON-THE-SAME-NUMBER (S245). An agent answering an inbound message must send from the
  // number the customer actually wrote to, and this outranks purpose/WABA scoring because it is
  // not a preference — it is the only correct answer, for two independent reasons:
  //   1. the 24h window is keyed on (recipient, phone_number_id), so replying from any other
  //      number is outside the window and the gate refuses it;
  //   2. the customer would get an answer from a number they never messaged.
  // This is what makes replies to the MARKETING and TRANSACTIONAL numbers answerable at all —
  // by purpose alone they would resolve to the support sender and fail closed.
  if (phoneNumberId) {
    const exact = rows.find((s) => String(s.metadata?.phone_number_id || '') === String(phoneNumberId));
    // ⚠️ Must NOT override WABA scope. Templates are WABA-scoped, so honouring the pin blindly
    // would send a support template from, say, the marketing number — Meta then rejects it with an
    // opaque "template does not exist", replacing the clear `no_sender_on_waba` this used to give.
    // Free-text replies are unaffected: an inline template carries no waba_id, so wabaId is null
    // and the pin applies exactly as intended. When the two genuinely conflict, fall through and
    // let the WABA rule win — failing loudly beats sending something Meta will refuse.
    if (exact && (!wabaId || String(exact.metadata?.waba_id || '') === String(wabaId))) return exact;
  }
  return pickSender(rows, { purpose, senderId, wabaId });
}

async function getTemplate(env, templateId) {
  const r = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(templateId)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}

async function getProfile(env, profileId) {
  if (!profileId) return null;
  const r = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}

// Mint/reuse an unsubscribe token on the latest marketing-consent row for the profile.
async function unsubscribeUrl(env, profileId, channel) {
  if (!profileId) return null;
  const r = await A.sbComms(
    `/rest/v1/consent?profile_id=eq.${A.enc(profileId)}&channel=eq.${A.enc(channel)}` +
    `&purpose=eq.marketing&select=id,unsubscribe_token&order=captured_at.desc&limit=1`, env);
  let row = r.ok ? r.data?.[0] : null;
  let token = row?.unsubscribe_token;
  // review H6: the PATCH result used to be unchecked, so a failed persist still embedded the
  // (unsaved) token in the email — a dead one-click unsubscribe link. Now: PATCH is conditional
  // on the token still being null (`unsubscribe_token=is.null`) so two concurrent sends minting
  // at once can't clobber each other; a PATCH failure fails closed (no dead links in live mail);
  // and losing the mint race (0 rows updated) adopts the winner's token so THIS email's link
  // still resolves, rather than silently going out linkless.
  if (row && !token) {
    token = rand();
    const w = await A.sbComms(
      `/rest/v1/consent?id=eq.${A.enc(row.id)}&unsubscribe_token=is.null`, env,
      { method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ unsubscribe_token: token }) });
    if (!w.ok) return null;                                   // fail closed: no dead links in live mail
    if (!Array.isArray(w.data) || w.data.length === 0) {
      // lost a mint race — adopt the winner's token so THIS email's link resolves
      const re = await A.sbComms(`/rest/v1/consent?id=eq.${A.enc(row.id)}&select=unsubscribe_token&limit=1`, env);
      token = (re.ok && re.data?.[0]?.unsubscribe_token) || null;
      if (!token) return null;
    }
  }
  // No row at all (profile has never captured marketing consent on this channel) — unchanged
  // posture: return null and let the caller degrade gracefully (send.js:189-190 only sets
  // sys.unsubscribe_url when truthy; it never crashes on null). This function's job is to make
  // the MINTING step race-safe/fail-closed, not to change what happens when there's no row.
  if (!token) return null;
  const base = (env.SUPABASE_URL && 'https://commsops.afshaan.workers.dev') || 'https://commsops.afshaan.workers.dev';
  return `${base}/unsubscribe?token=${token}`;
}

async function logMessage(env, row) {
  const r = await A.sbComms('/rest/v1/messages', env, {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
  });
  return (r.ok && r.data?.[0]) || null;
}

// send(env, opts) — opts: {channel, purpose, profileId?, to, templateId, constants?, recipient?, eventContext?, source, dedupKey?}
async function send(env, opts) {
  const channel = opts.channel || 'email';
  const purpose = opts.purpose || 'marketing';
  const adapter = ADAPTERS[channel];
  if (!adapter) return { status: 'failed', reason: 'no_adapter' };

  // dedup reserve — dedup on SUCCESS, not on attempt. A prior sent-like row (or a fresh
  // in-flight queued row) dedups; a prior skipped/failed/suppressed/stale-queued row is
  // ADOPTED so the retry can run. Review 2026-07-21 finding C1: burning the key on any
  // outcome turned every transient failure into a silent permanent loss.
  const SENT_LIKE = new Set(['sent', 'delivered', 'opened', 'clicked', 'bounced']);
  const IN_FLIGHT_MS = 10 * 60 * 1000;
  if (opts.dedupKey) {
    const reserve = await A.sbComms('/rest/v1/messages?on_conflict=dedup_key', env, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        profile_id: opts.profileId || null, channel, purpose, status: 'queued',
        source: opts.source || null, dedup_key: opts.dedupKey, to_address: opts.to || null,
      }),
    });
    if (reserve.ok && Array.isArray(reserve.data) && reserve.data.length === 0) {
      const ex = await A.sbComms(
        `/rest/v1/messages?dedup_key=eq.${A.enc(opts.dedupKey)}&select=id,status,queued_at&limit=1`, env);
      const row = ex.ok ? ex.data?.[0] : null;
      const inFlight = row && row.status === 'queued'
        && (Date.now() - new Date(row.queued_at).getTime()) < IN_FLIGHT_MS;
      // Unknown state (lookup failed / row vanished) → dedup: fail-safe against double-send.
      if (!row || SENT_LIKE.has(row.status) || inFlight) return { status: 'deduped', deduped: true };
      opts._reservedId = row.id;   // adopt the failed/skipped/stale row — this attempt owns it now
    } else {
      opts._reservedId = reserve.data?.[0]?.id || null;
    }
  }

  // Template BEFORE sender: on WhatsApp the template's WABA constrains which senders are even
  // valid (pickSender), so we cannot choose a number until we know which WABA the template is on.
  const template = opts.template || await getTemplate(env, opts.templateId);
  if (!template) return await finalize(env, opts, { status: 'failed', reason: 'template_not_found' }, null, channel, purpose);

  const wabaId = channel === 'whatsapp' ? ((template.content && template.content.waba_id) || null) : null;
  const sender = await getActiveSender(env, channel, purpose, opts.senderId, wabaId, opts.phoneNumberId);
  if (!sender) return await finalize(env, opts,
    // Name the WABA in the reason — "no active sender" would send someone hunting the wrong problem.
    { status: 'failed', reason: wabaId ? `no_sender_on_waba:${wabaId}` : 'no_active_sender' },
    null, channel, purpose);

  const profile = await getProfile(env, opts.profileId);
  const to = opts.to || null;

  // TEST SENDS ONLY — accept a variable's TOKEN as an alias for its source FIELD.
  //
  // An event-sourced variable resolves on `field` (render.js resolveVar), but the Test-values
  // box shows the author the TOKEN, and the failure names the TOKEN too. Where the two differ
  // — e.g. token `order_total` reading field `total` — the error points at a key that does not
  // work, so you retype the name it just gave you and it fails again. That misdirection has
  // cost two people a round each (2026-07-28), which is two more than it should.
  //
  // Test-only on purpose: a real send's event is the true wire payload and must keep failing
  // loudly when a field is genuinely absent. This only widens what a human may type by hand.
  if (opts.isTest && opts.eventContext && typeof opts.eventContext === 'object') {
    const ev = { ...opts.eventContext };
    for (const v of (Array.isArray(template.variables) ? template.variables : [])) {
      const field = v.field || v.token;
      if (field !== v.token && ev[field] === undefined && ev[v.token] !== undefined) {
        ev[field] = ev[v.token];
      }
    }
    opts = { ...opts, eventContext: ev };
  }

  // Account-wide UTM defaults. Read ONLY for marketing sends, because nothing else is tagged —
  // so transactional/utility pay nothing for this. The gate loads the same settings row but runs
  // AFTER render, so it cannot be reused here without reordering the send path.
  // Fail-soft: no column / unreadable settings ⇒ null ⇒ the auto-derived values still apply, so
  // a send is never lost over an attribution nicety.
  let utmDefaults = null;
  if (purpose === 'marketing') {
    try {
      const s = await A.sbComms('/rest/v1/settings?id=eq.1&select=utm_defaults&limit=1', env);
      utmDefaults = (s.ok && s.data?.[0]?.utm_defaults) || null;
    } catch { utmDefaults = null; }
  }

  // render — channel-branched. Both share the variable engine + unresolved-token discipline.
  let rendered;
  let waMeta = null;   // {mode, window_open, hasTemplate} — WA-only gate inputs
  try {
    if (channel === 'whatsapp') {
      const isTemplate = !!(template.content && template.content.meta_name);
      // Window is scoped to the SENDING sender's phone_number_id (review H5 part 3) —
      // a window opened on SUPPORT's number must not leak into a MARKETING/TXN free-text
      // send just because it's the same customer. Template sends never need the lookup.
      const senderPhoneId = sender.metadata?.phone_number_id || null;
      const windowOpen = isTemplate ? false : await waWindowOpen(env, to, senderPhoneId);
      const body = renderWhatsapp(template, {
        profile, event: opts.eventContext, constants: opts.constants,
        recipient: opts.recipient, system: {},
        // Interactive reply-buttons ride on the CALL, not the template — they are declared on
        // the journey send step. Only meaningful for a non-template (session) send.
        interactiveButtons: isTemplate ? null : (opts.interactiveButtons || null),
      });
      // UTM-tag LOT-owned links on MARKETING sends. Until now this happened on the EMAIL path
      // only, so 100% of real volume (WhatsApp) went out untagged — 2,985 marketing sends in the
      // 30d before this shipped, none attributable in GA4/Odo.
      //
      // WhatsApp needs a different treatment from email: a TEMPLATE send transmits variable
      // VALUES, not prose, so there is no body to rewrite — the URL lives inside a parameter
      // (e.g. the cart link passed as a body variable). So tag per-parameter for template mode,
      // and tag the free-text body for session modes (text/interactive/media).
      //
      // ⚠️ BUTTON parameters are deliberately EXCLUDED. A WA url-button's base URL is fixed at
      // Meta approval and the variable is only a SUFFIX appended to it, so a button param is
      // usually a bare id/path fragment, not a URL — appending utm_* there would either no-op or
      // corrupt the resolved link. Buttons need the Phase-B `/r/<code>` redirect (or template
      // re-approval), not this. `tagLinks` is safe on non-URL values (returns them unchanged),
      // but excluding buttons keeps the intent explicit rather than relying on that.
      if (purpose === 'marketing') {
        const utm = resolveUtm({ channel, tracking: opts.tracking, template, defaults: utmDefaults });
        const tagText = (v) => (typeof v === 'string' ? tagLinks(v, { params: utm, mode: 'text' }) : v);
        if (body.mode === 'template' && body.template?.components) {
          for (const comp of body.template.components) {
            if (comp.type === 'button') continue;          // see note above
            for (const p of comp.parameters || []) if (p.type === 'text') p.text = tagText(p.text);
          }
        } else if (typeof body.text === 'string') {
          body.text = tagText(body.text);
        }
      }

      // ── Phase-B: redirect-backed URL buttons ────────────────────────────────────────────
      // The block above still cannot touch buttons, and never will — but a button whose template
      // declares `target_base` has been re-approved at Meta as `https://<host>/r/{{1}}`, so its
      // parameter is no longer a suffix, it is a CODE we mint here.
      //
      // ⚠️ Runs for EVERY purpose, unlike the marketing-only UTM tagging above. Utility templates
      // have buttons too (Order Placed's "Order Details", the Shipment-Update tracking button), and
      // once one of those is approved in the `/r/{{1}}` form, skipping the mint would send the raw
      // suffix as the code — i.e. a dead link on an order notification. UTM stays marketing-only:
      // what is minted is the link, what is tagged is the attribution.
      //
      // Zero cost until a template opts in: the settings read only happens when a button on THIS
      // template actually carries `target_base`.
      // ⚠️ The line that used to end this comment — "so today it never fires at all" — was TRUE
      // when written and is long stale (corrected 2026-08-14). It fires constantly: 9 templates
      // are opted in, 9,124 recipient links minted and 2,070 clicks recorded all time, and every
      // live journey carrying a url button is on a tracked template. The gap is CAMPAIGNS, which
      // were never migrated — "Freedom to Play Sale_14 Aug" went out on a raw
      // legendoftoys.com/collections/all button and recorded 0 clicks and 0 attributed revenue.
      if (body.mode === 'template' && body.template?.components
          && (template.content?.buttons || []).some((b) => b?.target_base)) {
        const linkBase = await LINKS.getLinkBaseUrl(env);
        if (linkBase) {
          const utm = purpose === 'marketing'
            ? resolveUtm({ channel, tracking: opts.tracking, template, defaults: utmDefaults })
            : null;
          // opts._reservedId is set by the dedup reserve above; null for a send without a dedup
          // key (test sends). message_id is for attribution, not integrity, so null is fine.
          await LINKS.applyButtonRedirects(body.template.components, {
            template, baseUrl: linkBase,
            mint: (target) => LINKS.mintLink(env, {
              baseUrl: linkBase, target, utm,
              messageId: opts._reservedId || null, profileId: opts.profileId || null, channel,
            }),
          });
        }
      }
      rendered = {
        ...body, to,
        phone_number_id: senderPhoneId,
        window_open: windowOpen,
      };
      waMeta = { mode: body.mode, window_open: windowOpen, hasTemplate: isTemplate };
    } else if (channel === 'sms') {
      // SMS is its own branch, NOT the email fallthrough. The vendor takes a DLT template id +
      // positional pr1..pr5, so the adapter needs {sender, purpose, provider_template_id,
      // template_type, var_order, vars, body} — none of which renderEmail produces.
      //
      // ⚠️ NO UTM TAGGING HERE, deliberately. `isdesturl` rewrites urls in the outgoing body, and
      // DLT matches delivered content against the registered template — appending utm_* to a url
      // inside a {#var#} changes the value the carrier sees. Attribution for SMS waits for the
      // Phase-B `/r/<code>` redirect, exactly as WA url-buttons do (see the WA button note above).
      const body = renderSms(template, {
        profile, event: opts.eventContext, constants: opts.constants,
        recipient: opts.recipient, system: {},
      });
      rendered = { ...body, to, sender: sender.address, purpose };
    } else if (channel === 'rcs') {
      // D6 — RCS is marketing-only: the one provisioned bot is registered `promotional` with
      // the vi hub, so a transactional RCS message cannot exist on this account. Refuse loudly
      // rather than letting the vendor reject it with a less useful error.
      if (purpose !== 'marketing') throw new Error('rcs_is_marketing_only');
      const ctx = {
        profile, event: opts.eventContext, constants: opts.constants,
        recipient: opts.recipient, system: {},
      };
      const body = renderRcs(template, ctx);

      // The mandatory SMS fallback leg (with_fallback is the ONLY vendor send path) is resolved
      // BY REFERENCE from the RCS template's content — a comms.templates id, not inline copy —
      // so the leg is always a real, DLT-registered SMS template rendered with the same context.
      if (!body.sms_fallback_template_id) throw new Error('missing_sms_fallback_template');
      const fbTemplate = await getTemplate(env, body.sms_fallback_template_id);
      if (!fbTemplate || fbTemplate.channel !== 'sms') throw new Error('fallback_template_not_found');
      // D7 — the fallback rides route='promotional' (pinned in the adapter), and the DLT
      // category must agree: an `implicit` (service) template on the promotional route is
      // exactly the mismatch assertBindable exists to stop on the SMS channel. Enforced here
      // because the SMS adapter never sees this send.
      if ((fbTemplate.content?.template_type || '') !== 'explicit')
        throw new Error('fallback_template_not_explicit');
      const fb = renderSms(fbTemplate, ctx);   // throws on unfilled {#var#} / arity — fail closed
      const smsSender = await getActiveSender(env, 'sms', 'marketing');
      if (!smsSender) throw new Error('no_sms_fallback_sender');

      rendered = {
        ...body, to, purpose,
        sms_fallback: {
          sender: smsSender.address,
          message: fb.body,
          template_id: fb.provider_template_id,
          route: 'promotional',
        },
      };
    } else {
      const sys = {};
      if (purpose === 'marketing') {
        let u = await unsubscribeUrl(env, opts.profileId, channel);
        // Test sends carry no profileId, so every test email shipped the literal
        // "{unsubscribe_url}" as a dead footer link (found 2026-08-16, Mishica's builder
        // report). Try the test recipient's own profile so internal testers see the real
        // flow; failing that, a preview link — the invalid-token page — so the footer
        // renders exactly as it will in a live send. Live sends are unchanged: no token,
        // no link, same fail-closed posture as before.
        if (!u && opts.isTest) {
          const idr = await A.sbComms(
            `/rest/v1/identifiers?type=eq.email&value=eq.${A.enc(String(to).trim().toLowerCase())}` +
            `&select=profile_id&limit=1`, env);
          const pid = idr.ok ? idr.data?.[0]?.profile_id : null;
          if (pid) u = await unsubscribeUrl(env, pid, channel);
          if (!u) u = 'https://commsops.afshaan.workers.dev/unsubscribe?token=test-preview';
        }
        if (u) sys.unsubscribe_url = u;
      }
      const body = renderEmail(template, {
        profile, event: opts.eventContext, constants: opts.constants,
        recipient: opts.recipient, system: sys,
      });
      // UTM-tag LOT-owned links on MARKETING sends → GA4 attributes the landing session
      // → Odo /funnel by-source. Transactional/utility left untouched (keeps attribution clean).
      if (purpose === 'marketing') {
        // Same resolver as the WhatsApp path above — one precedence chain for every channel.
        const utm = resolveUtm({ channel, tracking: opts.tracking, template, defaults: utmDefaults });
        const skip = sys.unsubscribe_url ? [sys.unsubscribe_url] : [];
        body.html = tagLinks(body.html, { params: utm, skip, mode: 'html' });
        body.text = tagLinks(body.text, { params: utm, skip, mode: 'text' });
      }
      const fromName = sender.metadata?.from_name || 'Legend of Toys';
      rendered = { ...body, to, from: `${fromName} <${sender.address}>`, unsubscribe_url: sys.unsubscribe_url };
    }
  } catch (e) {
    // FAILED, not skipped. 'skipped' means the gate deliberately withheld the message
    // (suppression / consent / quiet hours / freq cap / test mode) — the system working as
    // intended. Reaching here means rendering broke: an unresolved variable, a bad template, a
    // transient lookup. That is a defect, and filing it under 'skipped' both understates the
    // failure rate in campaign analytics (where skipped and failed are deliberately separate
    // columns) and sends the reader hunting consent settings for a missing constant.
    return await finalize(env, opts, { status: 'failed', reason: e.message }, sender, channel, purpose, template);
  }

  // gate
  const g = await runGate(env, { profileId: opts.profileId, channel, purpose, to, wa: waMeta, isTest: opts.isTest === true });
  if (!g.pass) {
    const st = g.reason === 'suppressed' ? 'suppressed' : 'skipped';
    return await finalize(env, opts, { status: st, reason: g.reason }, sender, channel, purpose, template);
  }

  // adapter send
  const res = await adapter.send(rendered, env);
  return await finalize(env, opts, res, sender, channel, purpose, template, true);
}

// write/update the messages row and return a compact result
async function finalize(env, opts, res, sender, channel, purpose, template, sent) {
  const row = {
    profile_id: opts.profileId || null, channel, purpose,
    sender_identity_id: sender?.id || null,
    template_id: template?.id || null, template_version: template?.version || null,
    // A/B arm (S272). Stamped for EVERY outcome — a skipped or failed message still belongs to
    // an arm, and the per-arm failure-asymmetry check in ab-stats.js depends on those rows.
    variant_id: opts.variantId || null,
    source: opts.source || null, provider: sender?.provider || 'resend',
    provider_message_id: res.provider_message_id || null,
    status: res.status, provider_status: res.status, reason: res.reason || null,
    // Non-sent outcomes FREE the key (dedup-on-success). 'sent' keeps it so redeliveries dedup.
    dedup_key: res.status === 'sent' ? (opts.dedupKey || null) : null,
    to_address: opts.to || null,
    sent_at: sent && res.status === 'sent' ? nowIso() : null,
  };
  // SMS parks the vendor's charge in `pricing`, NOT in `cost`.
  // `comms.messages.cost` is a billable-MESSAGE COUNT — ₹ is derived at read time via
  // comms.message_cost_inr() × channel_rate_card. TrustSignal's `sms_cost` is a CREDIT figure
  // (fractional values occur), so writing it to `cost` would feed a different unit into that
  // multiplication and produce plausible-but-wrong ₹ on /analytics. Reconcile the credit against
  // /v1/sms/stats before it is trusted in reporting (spec F11); until then it is recorded, not used.
  //
  // ⚠️ Scoped to SMS on purpose. For WhatsApp, `pricing` is Meta's authoritative per-message
  // verdict written by wa-webhooks.js (with pricing_category + billable), so a generic send-time
  // write here would clobber the one trustworthy billing signal the moment a WA adapter started
  // returning a cost. Any new channel must make the same call deliberately.
  // RCS makes the same call deliberately (per the note above): its credit is the same vendor
  // unit as SMS's, and the fallback flip (webhooks.js) overwrites it with the SMS leg's credit
  // when the RCS leg does not deliver (F4).
  if ((channel === 'sms' || channel === 'rcs') && res.cost != null && Number.isFinite(Number(res.cost))) {
    row.pricing = { provider_credit: Number(res.cost), provider: sender?.provider || null };
  }
  let msg;
  if (opts._reservedId) {
    const r = await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(opts._reservedId)}`, env,
      { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    msg = (r.ok && r.data?.[0]) || null;
  } else {
    msg = await logMessage(env, row);
  }
  return { status: res.status, reason: res.reason || null, message_id: msg?.id || null,
           provider_message_id: res.provider_message_id || null };
}

module.exports = { send, getActiveSender, pickSender, waWindowOpen };
