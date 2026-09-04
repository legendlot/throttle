// Shopify customer TAG re-pull (S352, 2026-09-04).
//
// THE PROBLEM, AND WHY THE FIX IS A PULL RATHER THAN A MAPPER CHANGE. Shopify customer tags in
// comms.profiles have been frozen since the 2026-06-30 backfill — measured 2026-09-04, ALL 8,400
// tagged Shopify-mirrored profiles were created in one 3-hour window that day, and not a single
// tag has been written in the 66 days since (denominator: 91,801 profiles carrying
// attributes->>'shopify_created_at').
//
// It is NOT that customer webhooks stopped arriving, and it is NOT a parsing bug — both were
// filed as hypotheses and both are dead. 31,055 comms.consent rows with source='shopify_webhook'
// were created after their profile, the most recent on 2026-09-04, and those rows are written by
// the SAME function that writes tags — mapCustomerRest, the REST WEBHOOK mapper (grep it in shopify.js — line numbers omitted on purpose, they rot). NOT mapCustomer, which is the GraphQL importer and
// stamps source='shopify_import'. So the mapper runs on every live
// customer webhook and writes no tags, which leaves exactly one explanation: `tags` is absent
// from the REST webhook payload. No change to the mapper can conjure a field the payload does
// not carry. The June backfill had tags because it asked GraphQL for them — so does this.
//
// WHAT IT DOES. Asks Shopify for customers matching a search query, oldest-updated first, and
// re-applies each through the existing comms.shopify_apply_customers path. Two callers:
//   - the cron, with `updated_at:>=<watermark>` — the standing fix
//   - POST /internal/shopify-tag-pull, with any query — e.g. `tag:back-in-stock`, which is the
//     one-off extraction of the incumbent PDP form's back-in-stock requests. That is a SEPARATE
//     backlog item and this is deliberately the same code path: one pull, pointed twice.
//
// RE-APPLYING IS SAFE FOR ATTRIBUTES, AND CONSENT IS NOT RE-APPLIED AT ALL.
// Profile attributes shallow-merge (`attributes || incoming`), so a tag write cannot clobber
// event-derived fields.
// ⛔ **CORRECTED 2026-09-04 (S352 hostile review). This header previously claimed "consent is
// protected twice over" and that was WRONG — it cost 7 real customers their opt-out.** Both
// guards it cited (the RPC's `unknown` skip, and `captured_at` ordering) defend against an OLD
// Shopify state losing to a newer local one. The actual failure is the MIRROR IMAGE: Shopify's
// `consentUpdatedAt` is frequently NEWER than a Shopflo checkout opt-out, an `opted_in` is
// inserted unconditionally, and `captured_at DESC` then makes the stale Shopify row win. Seven
// profiles were made marketable again on this job's first run. **The fix is that syncByQuery now
// strips the consent block entirely — see the comment at the applyMapped call.**
// ⚠️ If anyone ever re-adds consent to this path, they must first solve "a newer Shopify opt-in
// must not outrank an older non-Shopify opt-out", which nothing in the stack does today.
const A = require('./auth.js');
const SHOP = require('./shopify.js');

// Page cap per RUN, not per query. 25 x 100 = 2,500 customers, which is far above the real
// incremental volume (~100-300 customers/day are touched in Shopify) while still bounding a
// single isolate's work and Shopify API cost if a bulk re-tag ever lands.
const MAX_PAGES = 25;
const PAGE_SIZE = 100;

// How stale the watermark must be before the cron does anything. The cron ticks every 5 minutes;
// tags do not need that resolution and each run costs Shopify API budget.
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

// Overlap subtracted from the watermark on each run. Shopify's updated_at and our clock are not
// the same clock, and a customer updated DURING a run would otherwise fall in the gap between
// "rows I read" and "the time I stamp". Re-reading a few minutes twice is free (idempotent);
// missing a row is not, and would be invisible.
const OVERLAP_MS = 10 * 60 * 1000;

// Shopify's search grammar wants `updated_at:>='2026-09-04T10:00:00Z'`.
function updatedSinceQuery(iso) { return `updated_at:>='${iso}'`; }

// Page a search query, applying each page. Returns what it did, including whether it stopped
// early — the caller needs `truncated` to decide how far the watermark may advance.
async function syncByQuery(env, { query, maxPages = MAX_PAGES, pageSize = PAGE_SIZE } = {}) {
  let after = null, pages = 0, customers = 0, profiles = 0, consent = 0;
  let lastUpdatedAt = null, hasNext = true;

  while (hasNext && pages < maxPages) {
    const page = await SHOP.fetchCustomerPageByQuery(env, { first: pageSize, after, query });
    pages++;
    const nodes = page.customers || [];
    if (nodes.length) {
      // ⛔ CONSENT IS STRIPPED. THIS IS THE MOST IMPORTANT LINE IN THE FILE.
      //
      // `applyNodes` = `applyMapped(nodes.map(mapCustomer))`, and `mapCustomer` emits a consent
      // block alongside the attributes. Re-delivering that from a TAG sync resurrects dead
      // opt-outs: Shopify's `consentUpdatedAt` is often NEWER than a Shopflo checkout opt-out,
      // `comms.shopify_apply_customers` guards only `state='unknown'` (an `opted_in` inserts
      // unconditionally), and `consent.js` resolves the effective state by
      // `ORDER BY captured_at DESC` — so a stale Shopify `opted_in` outranks a real, later
      // opt-out and the customer becomes marketable again.
      //
      // ⚠️ NOT HYPOTHETICAL — the first run of this job did exactly that to **7 profiles**
      // (2026-09-04, S352, all 7 verified `opted_out` beforehand with no webhook opt-in, so the
      // live path had never delivered these; rows snapshotted to
      // `store.safety_relay_consent_optout_resurrect_2026_09_04` and deleted). The module header
      // claimed "consent is protected twice over" and it was wrong: both guards defend against an
      // OLD Shopify state losing, and this is the mirror image — a NEWER Shopify state winning.
      //
      // This job exists to carry TAGS. It has no business writing consent at all, so it doesn't.
      // The customer webhook path (`mapCustomerRest`) remains the consent feed and is untouched.
      const mapped = nodes.map((n) => { const m = SHOP.mapCustomer(n); delete m.consent; return m; });
      const res = await SHOP.applyMapped(env, mapped);
      customers += nodes.length;
      profiles += res.profiles || 0;
      consent += res.consent || 0;
      // Ascending sort means the last node of the last page is the high-water mark.
      const last = nodes[nodes.length - 1];
      if (last && last.updatedAt) lastUpdatedAt = last.updatedAt;
    }
    hasNext = page.hasNext;
    after = page.cursor;
    if (!after) break;
  }

  // ⚠️ `truncated` is `hasNext` ALONE, deliberately — NOT `hasNext && pages >= maxPages`.
  // The loop has TWO exits: the page cap, and `if (!after) break` on a null cursor. Shopify can
  // return `hasNextPage:true` with a null/empty `endCursor` (an empty filtered page), and the
  // old `pages >= maxPages` conjunction then evaluated FALSE on page 1 — so the run reported
  // itself complete, `runTagSync` advanced the watermark to run-start, and every unread row in
  // the window was skipped **permanently and silently**. That is the exact outcome the advance
  // rules below say they prevent. A run that stopped while Shopify still had more is truncated,
  // whatever made it stop. (S352 hostile review; the old test asserted only `pages === 1` here
  // and would have passed with the bug — see the tests.)
  return { pages, customers, profiles, consent, lastUpdatedAt, truncated: hasNext };
}

// Read the singleton settings row. Returns null on a failed read so the caller can fail closed
// rather than treat "could not read" as "never synced".
async function readWatermark(env) {
  const r = await A.sbComms('/rest/v1/settings?id=eq.1&select=shopify_tag_sync_at', env);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return null;
  return { at: r.data[0].shopify_tag_sync_at || null };
}

async function writeWatermark(env, iso) {
  return A.sbComms('/rest/v1/settings?id=eq.1', env,
    { method: 'PATCH', body: JSON.stringify({ shopify_tag_sync_at: iso }) });
}

// The cron entry point. Best-effort and self-gating; never throws at the scheduler.
async function runTagSync(env, now = Date.now()) {
  // Use shopify.js's own predicate, never a local copy — see isConfigured there for why.
  if (!SHOP.isConfigured(env)) return { skipped: 'shopify_not_configured' };

  const wm = await readWatermark(env);
  // FAIL CLOSED on a failed read — do not fall through to "never synced" and re-pull everything.
  if (!wm) return { skipped: 'settings_read_failed' };
  // FAIL CLOSED when unset. An operator arms this once; see migration 0066 for why an unset
  // watermark must never mean "from the beginning of time".
  if (!wm.at) return { skipped: 'not_armed' };

  const since = new Date(wm.at).getTime();
  if (!Number.isFinite(since)) return { skipped: 'bad_watermark' };
  if (now - since < SYNC_INTERVAL_MS) return { skipped: 'too_soon' };

  const fromIso = new Date(Math.max(0, since - OVERLAP_MS)).toISOString();
  const runStartIso = new Date(now).toISOString();

  const res = await syncByQuery(env, { query: updatedSinceQuery(fromIso) });

  // WATERMARK ADVANCE — the one subtle bit. A run that drained everything may stamp the time the
  // run STARTED (not the last row seen): anything updated after that instant is by definition not
  // covered and must be picked up next time. A run that hit the page cap has NOT covered the
  // window, so it may only advance to the last row it actually applied — and if it applied
  // nothing, it must not advance at all, or the unread remainder is skipped for good.
  let advancedTo = null;
  if (!res.truncated) {
    advancedTo = runStartIso;
  } else if (res.lastUpdatedAt) {
    advancedTo = new Date(res.lastUpdatedAt).toISOString();
  }
  if (advancedTo) await writeWatermark(env, advancedTo);

  return { ...res, from: fromIso, advanced_to: advancedTo };
}

module.exports = {
  runTagSync, syncByQuery, updatedSinceQuery, readWatermark, writeWatermark,
  MAX_PAGES, PAGE_SIZE, SYNC_INTERVAL_MS, OVERLAP_MS,
};
