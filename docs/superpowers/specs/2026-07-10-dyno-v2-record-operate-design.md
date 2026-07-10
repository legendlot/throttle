# Dyno V2 — Record & operate surface (verdict/decision UI + asset thumbnails)

> **Status:** design, 2026-07-10. For the Odo/Throttle session (`odoops-worker` + `apps/odo`).
> **Scope decided with Afshaan:** the **A+B** slice — capture the *why* (verdict/decision/angle) and
> show creative thumbnails in Odo. **Launches stay on the Brand engine** (`odo-launch.mjs`); the
> one-click Approve-&-Launch-from-Odo path (C) is explicitly **deferred** (its whole purpose is
> launching without the engine, which isn't needed — Afshaan launches from the engine).
> **Grounded in live code:** V1 `apps/odo/.../dyno/page.js`, `f_dyno_board` (0011_dyno_v1.sql),
> worker actions `getDynoBoard`/`adsSetVerdict`/`adsApprovePlan` (odoops `src/index.js`).

---

## 1. Why / what V1 already has

Dyno V1 is the live board + controls. Two gaps make it feel unfinished:
1. **The "why" is captured through raw `prompt()`/`confirm()` dialogs** — variant verdict works
   (`adsSetVerdict`), but there is no experiment-grain verdict, no decision-tree logging, and no way
   to maintain the angle playbook from Odo (angles are minted via SQL today — the Fang-slug gap).
2. **Thumbnails are always placeholders** — the board's `Thumb` renders `ads_managed.asset_url`, but
   nothing ever populates it, so every row shows the `—` placeholder.

V2 (A+B) closes both without touching the launch path, cron, ceiling, ledger, or guardrails.

---

## 2. Piece A — Verdict / decision / angle capture

### 2a. Worker actions (all in `sales` schema; no Meta calls; negligible subrequest cost)
| Action | Gate | Behaviour |
|---|---|---|
| `adsSetPlanVerdict({plan_id, verdict, reason?, concluded_at?})` **(new)** | `sales_ads_write` | Validate `verdict ∈ {winner,promising,killed,inconclusive,paused}`; PATCH `ads_plan.verdict/verdict_reason/concluded_at` (default `concluded_at = now()` when the verdict is terminal — winner/killed/inconclusive — else leave null unless passed); ledger `ok`. |
| `labAddDecision({plan_id?, variant_meta_id?, type, rationale?, spawned_meta_id?})` **(new)** | `sales_ads_write` | Validate `type ∈ {kill,scale,graduate,iterate,pause,hold,restore-budget}`; INSERT `lab_decisions` (`decided_by=userId`, `decided_at=now()`). At least one of `plan_id`/`variant_meta_id` required. |
| `labUpsertAngle({slug, name, description?, psychology_pillar?, hypothesis?, status?, evidence?})` **(new)** | `sales_ads_write` | Upsert `lab_angles` on `slug` (`status` defaults `candidate`, CHECK'd by the table). **Closes the Fang-slug gap — new angles minted from Odo, no SQL.** |
| `getAngles()` **(new)** | `canView` | `SELECT * FROM lab_angles ORDER BY slug` — for the Angle Library panel. |
| `getDecisions({plan_id})` **(new)** | `canView` | `SELECT * FROM lab_decisions WHERE plan_id=$1 ORDER BY decided_at DESC` — on-demand per expanded experiment. |
| `adsSetVerdict` **(exists)** | `sales_ads_write` | Variant verdict — reused unchanged. |

Reuse the existing `canAdsWrite(P)` / `canView(P)` gates and the `ledgerWrite` audit pattern the
sibling ads-write actions already use. Verdict/decision writes carry no `daily_delta_inr`.

### 2b. UI (in `apps/odo/.../dyno/page.js`, `@throttle/ui` `Modal`)
- **`VerdictModal`** — replaces the current `prompt()`/`confirm()` verdict + kill flow. Fields:
  verdict `<select>`, reason `<textarea>`, and an optional **"log as a decision"** block (decision
  `type` `<select>` + rationale). Submitting fires the relevant write(s):
  - Row **Verdict** button → `adsSetVerdict` (+ `labAddDecision` if the decision block is filled).
  - Row **Kill** button → `metaSetStatus PAUSED` + `adsSetVerdict{verdict:'killed'}` (+ optional
    decision). Same two-call sequence the current `kill()` already does, just through the modal.
  - Experiment-header **Conclude** button (new) → `adsSetPlanVerdict` (+ optional decision).
- **Decisions strip** — in the expanded experiment card, an on-demand `getDecisions(plan_id)` list
  (`type · rationale · who · when`) so the why-we-moved-next is visible (feeds the V3 tree later).
- **Angle Library** — a small section/panel (list from `getAngles`, add/edit row → `labUpsertAngle`):
  slug, name, psychology_pillar, status, hypothesis, evidence. Keeps the playbook maintainable in Odo.

Retire the `prompt()`/`confirm()` calls for verdict + kill (the Scale/Rename prompts can stay for now —
out of this slice). Reuse the existing `run()` busy/refresh wrapper.

---

## 3. Piece B — Asset thumbnails

### 3b-i. Persist the representative image in `metaCreateAd` (rides on the S-today change)
`metaCreateAd` already receives the image bytes. After the Meta upload + `managedUpsert`, also persist
a representative image to the **private** `lab-creatives` bucket and record its path:
- **Which image:** single-image → `ad.image_base64`; **carousel → card 1** (`ad.cards[0].image_base64`,
  the hook). If only a cached `image_hash` was passed (no bytes), skip — leave `asset_url` null.
- **Where:** `PUT ${SUPABASE_URL}/storage/v1/object/lab-creatives/<plan_id>/<ad_id>.png` with the
  service-key headers (mirror the `salesops-uploads` read at `src/index.js:2174`), `Content-Type:
  image/png`, `x-upsert: true`, body = the decoded PNG bytes (base64 → `Uint8Array`).
- **Record:** set `asset_url = '<plan_id>/<ad_id>.png'` (**the storage PATH, not a URL**) on the
  `managedUpsert` row (add to the `dynoMeta` object already there).
- **Failure is non-fatal:** wrap the bucket write in try/catch — a storage hiccup must NOT fail the
  ad launch (the ad + Meta creative are the real work; the thumbnail is cosmetic). Log + continue.
- **No `odo-launch.mjs` change** — the engine already sends the bytes.

### 3b-ii. Serve thumbnails via bulk-signed URLs in `getDynoBoard`
The bucket stays **private** (per the 0011 decision — no bucket ACL change). After `f_dyno_board`
returns the rows, collect the non-null `asset_url` paths and **bulk-sign in one subrequest**:
`POST ${SUPABASE_URL}/storage/v1/object/sign/lab-creatives` with `{ expiresIn: 3600, paths: [...] }`
(service-key headers) → array of `{path, signedURL}`. Map the signed URL back onto each row as
`asset_url` (overwrite the path with the browser-loadable signed URL). One subrequest regardless of
row count; the 60s board poll re-signs so URLs never go stale. The `Thumb` component already renders
whatever `asset_url` holds — no frontend change needed for rendering.

**Backfill:** existing/old ads have no bytes in the bucket → they keep placeholders. Only launches
from now on get thumbnails. Acceptable (we don't hold their source bytes).

---

## 4. Data model

No migration. All columns exist (0011_dyno_v1): `ads_plan.verdict/verdict_reason/concluded_at`,
`ads_managed.verdict/verdict_reason/asset_url`, `lab_angles`, `lab_decisions`. The `lab-creatives`
private bucket exists. Only new **worker actions** + **UI** + the `metaCreateAd` bucket write.

---

## 5. Subrequest budget

- **Verdict/decision/angle actions:** 1–2 sb calls each + a ledger write. Trivial.
- **`getDynoBoard`:** +1 subrequest (the bulk-sign call) on top of today's RPC + 3 settings reads. Fine.
- **`metaCreateAd`:** +1 subrequest (the bucket PUT) on the launch call. 4-card carousel was ~11; now
  ~12. Under 50.

---

## 6. What does NOT change

Launch orchestration (stays in the engine), `adsSavePlan` (no `staged` status — C-scope), the cron,
ceiling, ledger, guardrails, `metaSetStatus` activation, the Matrix view, `f_dyno_board`'s shape
(rows just carry a signed `asset_url`), and single-image/carousel launch behaviour (B only *adds* a
non-fatal bucket write).

---

## 7. Testing / acceptance

1. Row **Verdict** modal sets `ads_managed.verdict/verdict_reason`; **Kill** pauses + sets
   `verdict='killed'` + (if filled) writes a `lab_decisions` row. No raw `prompt()` remains for these.
2. Experiment **Conclude** sets `ads_plan.verdict/verdict_reason/concluded_at`; the header shows it.
3. **Angle Library** add/edit writes `lab_angles` (verify a new slug appears + is selectable) — mint
   the 2 Fang angle slugs this way as the live check.
4. `getDecisions(plan_id)` lists logged decisions in the expanded experiment.
5. A fresh single-image launch writes `lab-creatives/<plan_id>/<ad_id>.png`, sets `asset_url` to the
   path; the board shows a real thumbnail (signed URL loads). A carousel launch stores card 1.
6. A storage-write failure does **not** fail the launch (ad still created).
7. Regression: existing rows (no asset) still render the placeholder; board still loads under the
   subrequest budget.
8. Deploy odoops (`cd 05_Throttle/odoops-worker && npx wrangler deploy`); app via CI. Authenticated
   browser smoke on `odo.legendoftoys.com/dyno` (Afshaan) confirms the modal + thumbnails.

---

## 8. Files touched

- `05_Throttle/odoops-worker/src/index.js` — 5 new actions (`adsSetPlanVerdict`, `labAddDecision`,
  `labUpsertAngle`, `getAngles`, `getDecisions`) + bulk-sign in `getDynoBoard` + representative-image
  bucket write in `metaCreateAd`.
- `05_Throttle/apps/odo/src/app/(auth)/dyno/page.js` — `VerdictModal`, Conclude button, Decisions
  strip, Angle Library section; retire the verdict/kill `prompt()`/`confirm()`.
- No migration. No `odo-launch.mjs` change. No Matrix change.
