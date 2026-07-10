# Odo — Carousel ad support in `metaCreateAd` (design)

> **Status:** design, 2026-07-10. For the Odo/Throttle session that owns `odoops-worker/src/index.js`.
> **Origin brief:** `~/Documents/Brand/ad-engine/lab/carousel-ad-support-brief.md` (Brand Ad Engine).
> **Blocks:** shadow-0003 Variant B — a 4-card carousel (`campaigns/shadow-0003/plan-carousel-B.json`)
> that cannot launch because `metaCreateAd` is single-image only.
> **Verified against live code** (odoops `src/index.js`, `metaCreateAd` at L3211; `f_dyno_board`
> `migrations/0011_dyno_v1.sql`; brand `scripts/odo-launch.mjs` L145-159) on 2026-07-10.
>
> **AS-BUILT (2026-07-10):** all three scoped pieces shipped — (1) carousel branch, (2) `format`
> persistence, (3) full Dyno metadata tagging (worker persists + `odo-launch.mjs` forwards +
> plans canonicalised + 3 live rows backfilled). odoops deployed `ed924020`; `05_Throttle` +
> `brand-content` pushed. Decisions in §9 were resolved YES (both format + full metadata).
> Remaining: Brand relaunches shadow-0003 Variant B; Fang needs new `lab_angles` slugs.

---

## 1. Summary

Add a **carousel branch** to the `metaCreateAd` worker action. A Meta carousel is a single ad
whose creative carries 2–10 swipeable cards (`object_story_spec.link_data.child_attachments[]`)
instead of one image (`link_data.image_hash`). Everything else — one ad object, budget on the ad
set, PAUSED-on-create, `adsGuardedWrite`, ceiling, ledger, `ads_managed` row, cron auto-kill, UTM,
activation via `metaSetStatus` — is **identical to today**. This is a creative-assembly change
inside one action, plus one small Odo-fit addition (§4).

Branch trigger: presence of **`ad.cards`** (array). Absent → existing single-image path, byte-for-byte
unchanged. Present → carousel path. Fully backward-compatible.

**Scope decision (beyond the brief, recommended):** also persist **`ads_managed.format`** on the ad
row (`'carousel'` vs `'static-image'`, derived in-worker), so a launched carousel is actually visible
as a carousel in the Dyno board/matrix. Without this the format A/B test — which is the *entire point*
of shadow-0003 Variant B — records `format=NULL`. See §4.

---

## 2. Ground truth (verified, not assumed)

The origin brief describes the flow from memory; these are the facts confirmed against the live code
that the implementation must respect.

### 2a. Real single-image flow — `case 'metaCreateAd'` (L3211-3246)
1. `canAdsWrite(P)` (= `sales_ads_write || salesops_admin`) else 403.
2. Require `plan_id`, `adset_id`, `ad.page_id`, `ad.link`, and (`image_base64` OR `image_hash`).
3. Build `redacted` request (base64 → `[N chars]`) for the ledger.
4. `adsGuardedWrite({ action, planId, request: redacted, fn })` — enforces the `ads_write_enabled`
   kill-switch, runs `fn`, writes the success/error ledger entry.
5. Inside `fn`:
   - **Idempotency:** if `ad.name` set, look up an existing non-deleted `ads_managed` ad for
     `(plan_id, name)` → return it (resumable, no duplicate). 
   - `adsLoadPlan(plan_id, 'approved')` — plan must be `approved`.
   - `metaAdAccount(plan.ad_account_id)` — resolve `act_<acct>`.
   - Upload image: `metaPost(env, 'act_<acct>/adimages', { bytes: image_base64 })`, then
     **`imageHash = Object.values(up.images || {})[0]?.hash`** — NOT a flat `up.hash`.
   - `metaPost(env, 'act_<acct>/adcreatives', { name, object_story_spec, url_tags })`.
   - `metaPost(env, 'act_<acct>/ads', { name, adset_id, creative:{creative_id}, status:'PAUSED' })`.
   - `managedUpsert({ entity_type:'ad', meta_id, parent_id:adset_id, plan_id, channel_id,
     ad_account_id, name, daily_budget_inr:0, status:'paused' })`.

### 2b. Helpers the carousel branch reuses unchanged
- `metaPost(env, path, params)` — form-encodes params; **objects are `JSON.stringify`'d** (so a nested
  `object_story_spec` with a `child_attachments` array serialises correctly); token in body; throws on
  non-2xx. `META_API_VER = 'v21.0'` (supports `child_attachments` / `multi_share_*`).
- `adsGuardedWrite`, `adsLoadPlan`, `metaAdAccount`, `managedUpsert` — reused verbatim.

### 2c. Brand side is already wired (coordination only — do not change)
`odo-launch.mjs` `cmdLaunch` (L145-159) builds the shared payload
`{ name, page_id, link, cta, primary_text, url_tags }` then, when `a.format === 'carousel' ||
Array.isArray(a.cards)`, sets `adPayload.cards = a.cards.map(c => ({ image_base64: b64(c.image),
headline?, description?, link? }))` and passes through `multi_share_optimized` / `multi_share_end_card`.
Single-image path (`headline` + `image_base64`) is untouched. `plan-carousel-B.json` is staged with
4 cards, baked-in copy (no per-card headline/description), `multi_share_*: false`, ₹1,400/day into the
existing shadow-0003 campaign `120246489477430384`.

---

## 3. The carousel branch

### 3a. Input contract (new fields on `ad`)
```jsonc
ad: {
  page_id, link, cta, primary_text, url_tags,   // shared, as today (link = default destination)
  cards: [                                       // NEW — 2..10, order preserved
    { image_base64 | image_hash,                 // per-card image (base64 bytes, or a cached hash)
      headline?,                                 // optional → child_attachment.name (usually omit)
      description?,                              // optional → child_attachment.description
      link? },                                  // optional per-card destination (defaults to ad.link)
    ...
  ],
  multi_share_optimized?: boolean,               // NEW, default FALSE (card order is a narrative)
  multi_share_end_card?:  boolean                // NEW, default FALSE (frame N is our CTA)
}
```
Copy is baked into the card images, so `headline`/`description` are normally omitted (else Meta prints
duplicate text under the card). Pass through only if present.

### 3b. Restructured validation (fixes the brief's blocking bug)
The current unconditional `image_base64 || image_hash` check (L3217) 422s a cards-only payload. Move it:

```js
const ad = d.ad || {};
if (!ad.page_id) return err('ad.page_id required', 422);
if (!ad.link)    return err('ad.link required', 422);
const isCarousel = Array.isArray(ad.cards);
if (isCarousel) {
  if (ad.cards.length < 2 || ad.cards.length > 10) return err('carousel needs 2–10 cards', 422);
  for (let i = 0; i < ad.cards.length; i++) {
    const c = ad.cards[i] || {};
    if (!c.image_base64 && !c.image_hash) return err(`card ${i + 1}: image_base64 or image_hash required`, 422);
  }
} else {
  if (!ad.image_base64 && !ad.image_hash) return err('ad.image_base64 or ad.image_hash required', 422);
}
```

### 3c. Redaction (carousel-aware)
The ledger must never store raw base64. Extend the existing `redacted` construction:
```js
const redactAd = isCarousel
  ? { ...ad, cards: ad.cards.map(c => ({ ...c, image_base64: c.image_base64 ? `[${c.image_base64.length} chars]` : undefined })) }
  : { ...ad, image_base64: ad.image_base64 ? `[${ad.image_base64.length} chars]` : undefined };
const redacted = { ...d, ad: redactAd };
```

### 3d. Build creative (inside `fn`, after the idempotency check + `adsLoadPlan` + `metaAdAccount`)
Resolve each card's hash with the **same** `adimages` call and the **same extraction** as the single
path, in a sequential loop, then assemble `child_attachments`:

```js
// helper: mirror the single-image extraction exactly
async function uploadHash(b64) {
  const up = await metaPost(env, `act_${acct}/adimages`, { bytes: b64 });
  const h = Object.values(up.images || {})[0]?.hash;
  if (!h) throw new Error('adimages upload returned no hash: ' + JSON.stringify(up).slice(0, 160));
  return h;
}

const child_attachments = [];
for (const c of ad.cards) {
  const hash = c.image_hash || await uploadHash(c.image_base64);
  child_attachments.push({
    link: c.link || ad.link,
    image_hash: hash,
    ...(c.headline ? { name: c.headline } : {}),
    ...(c.description ? { description: c.description } : {}),
    call_to_action: { type: ad.cta || 'SHOP_NOW', value: { link: c.link || ad.link } },
  });
}

const cre = await metaPost(env, `act_${acct}/adcreatives`, {
  name: ad.name ? `${ad.name} — creative` : 'LOT creative',
  object_story_spec: { page_id: ad.page_id, link_data: {
    link: ad.link,
    message: ad.primary_text || '',
    multi_share_optimized: ad.multi_share_optimized ?? false,
    multi_share_end_card:  ad.multi_share_end_card  ?? false,
    child_attachments,
  } },
  url_tags: ad.url_tags || undefined,
});
```
Loop is sequential (each `metaPost` is a subrequest; parallel `Promise.all` gives no wall-clock win
under the isolate and complicates the subreq accounting — keep it sequential).

### 3e. Create ad + persist row (shared with single path, one addition)
```js
const res = await metaPost(env, `act_${acct}/ads`, { name: ad.name || 'LOT ad', adset_id: d.adset_id, creative: { creative_id: cre.id }, status: 'PAUSED' });
await managedUpsert({ entity_type: 'ad', meta_id: res.id, parent_id: d.adset_id, plan_id: d.plan_id,
  channel_id: plan.channel_id, ad_account_id: acct, name: ad.name || null, daily_budget_inr: 0,
  status: 'paused',
  format: isCarousel ? 'carousel' : 'static-image' });   // §4 — the one Odo-fit addition
return { entity_type: 'ad', entity_id: res.id, meta_response: { ad_id: res.id, creative_id: cre.id, cards: child_attachments.length } };
```

The cleanest implementation shares steps 2b/2c between the two paths and only forks the
"resolve image(s) → build creative" block. `managedUpsert` gaining `format` applies to **both** paths
(single-image ads correctly record `format='static-image'`).

---

## 4. Why persist `format` (the Odo-fit gap the brief missed)

`f_dyno_board` (0011_dyno_v1.sql L110-116) sources `format`, `angle`, `audience_segment`, `headline`,
`primary_text`, `utm_content`, `psychology_pillar`, `asset_url`, `parent_meta_id` **from
`ads_managed` columns**, not from the plan JSON. But `metaCreateAd`'s `managedUpsert` writes **none**
of them today, so every engine-launched ad lands with `format=NULL` — and the Dyno board/matrix show
it as untagged (this is why the S203 matrix has a "data-hygiene banner" for untagged variants).

Carousel is the **Tier-2 FORMAT test variable** for shadow-0003 Variant B. Launching it with
`format=NULL` means the format experiment records no format — the measurement is lost. So persisting
`format` is not gold-plating; it is the minimum for the feature to be meaningful in Odo.

- **`format` is derivable in-worker** (`ad.cards ? 'carousel' : 'static-image'`) → **zero brand-side
  change**. Include it in this change.
- The **rest** of the Dyno §10 metadata (`angle`, `audience_segment`, `headline`, `primary_text`,
  `utm_content`) is NOT currently forwarded by `odo-launch.mjs` to `metaCreateAd` (it sends only
  `name/page_id/link/cta/primary_text/url_tags/cards`). Persisting those needs **both** an
  `odo-launch.mjs` change (forward `angle`/`segment`/`utm_content`) **and** a worker change
  (`managedUpsert` writes them). That is a bigger, cross-repo change → **out of scope here**, flagged as
  a follow-up (§9). `format` is the only piece derivable with no brand-side coordination, so it is the
  one addition folded into this change.

---

## 5. Meta API specifics / gotchas (v21.0)

- **`child_attachments`** is a JSON array on `link_data`; `metaPost` `JSON.stringify`s the whole
  `object_story_spec` value, so the nested array serialises fine — do not pre-stringify it yourself.
- **Per-card `call_to_action`** is set on each attachment (type from `ad.cta`, value.link = card link
  or `ad.link`). Valid with `multi_share_end_card:false`.
- **`name`** on a child attachment = the bold text under that card (our `headline`); **`description`**
  = the sub-line. Both omitted by default (copy is baked into the image).
- **`multi_share_end_card:false`** suppresses Meta's auto-generated Page end card (our frame N is the
  CTA). **`multi_share_optimized:false`** preserves our card order (it's a narrative, not
  performance-sorted).
- **`link_data.link`** (top-level default destination) is required and already provided as `ad.link`.
- Same page, same pixel, same `OUTCOME_SALES` objective, same ad-set targeting — the carousel creative
  slots into the identical working setup the single-image path already uses for this campaign. No
  `degrees_of_freedom_spec` or extra creative flags needed.

---

## 6. Budget & payload analysis (the brief hand-waves these — both are fine)

- **Cloudflare 50-subrequest ceiling:** per invocation a carousel does N `adimages` uploads +
  1 `adcreatives` + 1 `ads` = **N+2 Meta calls**, plus ~5 DB/ledger subrequests (JWT/perms,
  idempotency read, plan load, `managedUpsert`, ledger write). **4 cards ≈ 11 subrequests;
  10 cards ≈ 17.** Comfortably under 50. No batching needed.
- **Inbound payload:** brand base64-encodes each PNG in the single POST to the worker. 4×~1MB PNG →
  ~5.4MB base64 body — well within limits. Only a **10-card all-base64** payload (~13.5MB, transiently
  ~2× in memory during form-encoding) would approach Worker memory pressure; our carousels ship 4
  square 1080² frames. Non-blocking; document the 10-card ceiling.
- **`image_hash` shortcut:** a card may carry a cached `image_hash` instead of `image_base64` (skips
  its upload). Brand doesn't use it today but the contract supports it (cheap resumability).

---

## 7. Idempotency & resumability (stated honestly)

- The **`(plan_id, ad.name)`** check at the top of `fn` makes the whole action idempotent *once the ad
  row exists* — a re-run returns the existing ad, no duplicate. This is the primary guarantee (brief
  acceptance #4).
- A **mid-loop failure** (e.g. card 3 upload throws) creates **no partial ad** — the ad + creative are
  built only after all cards resolve. On retry the loop re-uploads cards 1–2; because Meta `adimages`
  is content-addressed (identical bytes → identical hash), re-upload is cheap and yields no duplicate
  images. So retry is safe; it just re-does uploads.
- The brief's "per-card `image_hash` passthrough lets a retry skip re-uploads" is **not achievable from
  `odo-launch.mjs`** — a failed action returns an error, not the partial hashes, so the CLI has nothing
  to cache. Acceptable (re-upload is idempotent). A future optimisation could return resolved hashes in
  the error body; not needed now.

---

## 8. What does NOT change

- **Guardrails / ceiling:** a carousel is one ad; budget is on the ad set. `adsGuardedWrite`, the
  `approved`-plan gate, `assertCeiling` (on ad-set activation) — untouched.
- **Ledger / `ads_managed`:** one ledger entry, one ad row (budget 0, paused). Same as today, plus the
  `format` column now populated.
- **Cron auto-kill (`adsAutoPause`), UTM (`url_tags`), activation (`metaSetStatus`), `mkt_fact_ad`
  reporting:** identical — Meta reports carousels at ad grain like any other ad, so Dyno's ROAS/CPA/CTR
  math and the auto-kill floor work with no change.
- **Single-image plans:** the branch triggers only on `ad.cards`; the single path is byte-for-byte
  unchanged (regression check, acceptance #3).

---

## 9. Open decisions / follow-ups

1. **Confirm the `format` addition** (§4) is in-scope for this change (recommended: yes — it's the
   difference between a measurable and an unmeasurable format test, at zero brand-side cost).
2. **Dyno §10 metadata persistence (separate follow-up).** Forward + persist `angle`,
   `audience_segment`, `utm_content`, `headline`, `psychology_pillar` on the ad row so ALL
   engine-launched ads (not just carousels) are fully tagged in Dyno. Needs an `odo-launch.mjs` change
   (forward the fields) + a `managedUpsert` extension. Backfill Variant A/existing rows separately.
   Track under `[odo]` in BACKLOG.
3. **`asset_url` pre-launch preview (Dyno §6, out of scope here).** For Dyno to render card thumbnails
   before launch, the engine would upload each PNG to the `lab-creatives` bucket and set `asset_url`.
   Not needed to *launch* a carousel; part of the staging workflow.
4. **Enforce square aspect ratio?** Brief says document, don't enforce. Recommend not enforcing (Meta
   rejects mixed ratios with a clear error; our renders are already 1:1). Optionally surface Meta's
   rejection message verbatim (the `catch` already returns `err(message, 422)`).

---

## 10. Acceptance criteria

1. A plan with an `ad.cards` array of 4 base64 images creates **one PAUSED carousel ad** with 4 cards
   in order, correct default destination + UTM, visible in Ads Manager.
2. `multi_share_end_card:false` → no Meta auto-generated end card (frame 4 is the CTA).
3. Existing single-image plans still create single-image ads — regression clean.
4. Re-running `launch` for the same plan is idempotent (no duplicate ad).
5. Ledger `request` has no raw base64 (each card redacted to `[N chars]`).
6. **(new)** The created ad row has `ads_managed.format = 'carousel'`; a single-image launch records
   `'static-image'`. The Dyno board/matrix show the carousel with format populated.
7. **(new)** A cards-only payload (no top-level `image_base64`) does **not** 422 on the moved
   image-required guard.

---

## 11. Test & rollout

1. Implement the branch + moved validation + carousel redaction + `format` on `managedUpsert`.
2. **Local reasoning check:** cards=1 and cards=11 → 422; single-image path unchanged (diff review).
3. Deploy odoops: `cd 05_Throttle/odoops-worker && npx wrangler deploy` (own worker — blast radius Odo
   only, not lotopsproxy). Commit + push first per the deploy sequence.
4. **Hand-off signal to Brand:** once deployed, Brand copies `plan-carousel-B.json` →
   `campaigns/shadow-0003/plan.json`, then `save → approve → launch → activate`. The carousel ad set
   joins the live shadow-0003 campaign at ₹1,400/day (committed 11,300 + 1,400 = 12,700 ≤ 13,000
   ceiling). Ad is PAUSED on create; `activate` flips campaign + ad set + ad to ACTIVE.
5. **Verify live:** ad visible in Ads Manager as a 4-card carousel; `ads_managed.format='carousel'`;
   the row appears on the Dyno board with format shown; ledger entry has redacted cards.

---

## 12. Files touched

- `05_Throttle/odoops-worker/src/index.js` — `case 'metaCreateAd'` (carousel branch + moved validation
  + carousel redaction + `format` on `managedUpsert`). **Single file, single action.**
- No migration (the `ads_managed.format` column already exists — 0011_dyno_v1.sql).
- No brand-repo change (already wired).
- No Dyno UI change (the board already selects `format`).
