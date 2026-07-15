# Relay Email Authoring v1 — Design Spec

> 2026-07-15. Scopes the **team-facing email authoring surface** for Relay — the thing that
> actually lets the marketing team migrate off BiteSpeed. Part of the "Relay authoring &
> adoption parity" workstream (distinct from, and more adoption-critical than, the
> journey-rebuild backend track). **North star: consolidation + maximum data control + team
> adoption** — not cost-saving. Whatever BiteSpeed does well, replicate the *good* parts; skip
> the rest.
> **Owner:** Claude (build) + Afshaan (product calls). All behind TEST MODE; no send behavior changes.

## 1. Problem
Relay today authors email as a raw `subject + html_body + text_body` form with a variables list
(S174). That is **not** an experience the team will migrate *to* — BiteSpeed gives them a
drag-drop visual builder, a starter-template library, saved templates, live preview, and test-send.
Without parity on the authoring surface, the engine + cutover work doesn't matter — adoption fails.

## 2. Decision (recorded): self-host **GrapesJS + MJML**, NOT a SaaS editor
Evaluated SaaS-embed (Unlayer/BeeFree) vs self-hosted OSS (GrapesJS + MJML). **Chosen: self-hosted GrapesJS + MJML.** Rationale (Afshaan, 2026-07-15):
- **Editor cost is NOT per-email** — sending volume cost is the ESP (Resend), independent of editor. So the usual "grab the free SaaS tier" reason doesn't apply; the real SaaS risk is an external dependency + lock-in + designs/images routed through a vendor's runtime — all of which cut against the consolidation/data-control thesis.
- **Data control:** designs + images live entirely in our stack (Supabase storage), nothing through a third party.
- **No vendor lock-in, no recurring vendor cost, no volume-linked cost.**
- **Maintenance is low + a known profile:** a **client-side library bundled into the Relay app** — no server, no infra, nothing that scales with usage or needs uptime. Same class as `@xyflow/react` already powering `/journeys`. Maintenance = occasional `npm` bumps + owning custom blocks (which we'd build in either option). MJML solves the genuinely hard part (responsive HTML across Gmail/Outlook/Apple Mail) so we don't hand-solve client compatibility.
- **Tradeoff accepted:** more upfront polish/config work than Unlayer's out-of-box parity — a one-time cost, fully under our control.

### The reversibility contract (why this is low-stakes either direction)
Store two things per template:
- **`html_body` = the rendered, MJML-compiled responsive HTML — the actual send artifact, editor-agnostic + portable.**
- **`design_json` = the GrapesJS project state — re-edit state ONLY.**

Consequences: switching editors later (or dropping the editor) **never breaks sending or any past campaign** — the HTML is standard. The only thing that doesn't carry across an editor switch is drag-drop re-editability of *previously-authored* templates (their HTML still sends fine; you'd rebuild the design only to visually edit an old one). The coupling is isolated to `design_json`; nothing load-bearing depends on it. **Not a lock-in trap in either direction.**

## 3. Scope
**In (v1 — email):**
- GrapesJS + MJML visual email builder embedded in Relay `/templates` (email channel).
- Starter **template library** + **saved templates** + **create-from-scratch**.
- Standard block set (§6).
- **Merge tags** (variable insertion) bound to the template's declared variables → Relay's existing single-brace `{token}` render.
- **In-editor preview** (desktop/mobile) + **send-test** (reuse `sendTest`).
- Image uploads → **our own Supabase storage bucket** (our URLs).
- Composer unchanged — the existing Campaigns page picks the authored template.

**Out (later phases):**
- **Phase 2:** WhatsApp visual template builder; **commerce blocks** — Product Recommendation + Order Summary (dynamic Shopify product/order merge at send — a real render feature, not static HTML).
- **Later / skip:** SMS/RCS/Web-Push/App-Push builders (replicate only what's used); multi sending-domain + quality rotation (we run one subdomain; revisit as a deliverability/warm-up play).

**Non-goals:** changing the send spine, gate, TEST MODE, or approval lifecycle; server-side rendering (Relay is static-export — see §4).

## 4. Architecture
- **Runs client-side.** Relay is a Next.js **static export** (no server). GrapesJS is a client-side lib; **`grapesjs-mjml` compiles MJML→responsive HTML in the browser** (via `mjml-browser`) on export — so the browser produces the final `html_body`, no server-side compile step. Load the editor as a client-only component (dynamic import, `ssr:false`).
- **Data model** (reuse `comms.templates`; `content` is jsonb):
  - `content.subject` · `content.html_body` (compiled, sent) · `content.text_body` (auto-derived plaintext) · **`content.design_json`** (GrapesJS state, re-edit) · `content.variables` (existing declared-token list, drives the merge-tag menu).
  - **Template library:** a lightweight flag/kind to mark starter templates (e.g. `content.library=true` or a small `template_library` table of curated starters, LOT-branded). Saved templates = normal `comms.templates` rows (channel=email). *Confirm exact `comms.templates` columns before implementing.*
  - **Image assets:** a **public Supabase storage bucket** (e.g. `relay-email-assets`); uploads via a worker action minting a signed upload URL (mirror the lotops `part-photos` `createUploadUrl` → public-bucket pattern) → GrapesJS asset manager stores the returned public URL. No vendor storage.
- **Merge tags / variables:** the editor's merge-tag menu lists `content.variables`; inserting one drops a `{token}` into the MJML text. At send, Relay `render.js` (single-brace `{token}`, throws on unresolved-without-fallback) binds them — unchanged.
- **Send path unchanged:** the compiled `html_body` flows through the existing `send()` spine → gate → TEST MODE → Resend adapter. Nothing new on the sending side.
- **Versioning:** editing publishes a new template version (existing behavior); `design_json` travels with the version so re-edits fork cleanly.

## 5. Surfaces / UX
- **`/templates` (email):** list ↔ editor. Editor = GrapesJS canvas + left block palette + right style/settings panel + a subject-line field + **merge-tag inserter** + **device preview toggle (desktop/mobile)** + **Send test** + Save (publishes a version). Matches the conventions of the current admin pages (`useAuth`, `workerFetch`, `@/components/ui.js`). Gate: `template_manage` to edit, `campaign_build` to test-send.
- **Template library:** on "New email template" → **Template Library** (curated LOT-branded starters) + **Saved Templates** + **Create from scratch** (mirrors the BiteSpeed "Get started with templates" flow, minus the vendor).
- **Composer:** the existing Campaigns builder's template picker now shows these visually-authored templates — no composer rebuild needed for v1.

## 6. Block set (v1)
Standard MJML blocks: **Heading, Text/Paragraph, Image, Button, Divider, Spacer, Columns (1/2/3), Social icons, Menu, HTML (raw escape hatch), Logo/Header, Footer (with the required unsubscribe token).** Enforce an **unsubscribe link** in the footer (compliance — Relay already appends/《unsubscribe》 handling; keep it mandatory in the starter footer). **Commerce blocks (Product Recommendation, Order Summary) are Phase 2** — they need dynamic Shopify data merged at send.

## 7. Maintenance profile
Client-side lib only: no server, no scaling, no uptime dependency. Ongoing = periodic `npm` updates + our own custom blocks (phase 2). Same maintenance class as the React Flow canvas already in the app. Image storage is our existing Supabase storage (no new infra).

## 8. Build sequence (v1)
1. Confirm `comms.templates` columns; decide `design_json` in `content` vs a column (lean: in `content`, no migration).
2. Stand up the Supabase `relay-email-assets` public bucket + a `createEmailAssetUploadUrl` worker action (mirror part-photos).
3. Embed GrapesJS + `grapesjs-mjml` as an ssr:false client component in `/templates`; wire block palette + style panel.
4. Wire save: export MJML→HTML (client) → `saveTemplate` with `{subject, html_body, text_body, design_json, variables}`; load `design_json` back for re-edit.
5. Merge-tag inserter bound to `content.variables`; device preview; in-editor `sendTest`.
6. Template library (curated LOT starters) + saved-templates browse + create-from-scratch.
7. Author the 4 clean starter templates the journey-rebuild needs (Review, Shipment Update, Order Placed, Abandoned Cart) in the new builder → bind into the draft journeys.
8. Internal-team dogfood pass (adoption check) — the real acceptance test.

## 9. Open questions
- `comms.templates` exact schema (design_json placement; is there a `variables` field or is it in `content`).
- Starter-template curation: which LOT-branded starters ship in the library v1 (broadcast, product-launch, sale, abandoned-cart, review)?
- Plaintext (`text_body`) auto-derivation approach (strip HTML vs a maintained parallel) — auto-strip for v1.
- Does the team need image *editing* (crop/resize) in-editor, or upload-only for v1? (Lean upload-only.)

## 10. Cross-refs
- Relay foundation PRD: `docs/superpowers/specs/2026-06-25-relay-foundation-design.md`
- Journey-rebuild inventory: `docs/superpowers/plans/2026-07-15-relay-journey-rebuild-inventory.md`
- Part-photos upload pattern (image bucket precedent): lotops `createPartPhotoUploadUrl`/public `part-images` bucket.
- systems/relay.md "Self-serve UI (S174)" — the current `/templates` editor this replaces.
