# Relay Email Authoring v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Relay's raw `subject + html textarea` email template editor with a self-hosted GrapesJS + MJML drag-drop visual builder embedded in `/templates`, so the marketing team gets BiteSpeed-parity authoring and can migrate off BiteSpeed.

**Architecture:** Client-side only. Relay is a Next.js **static export** — GrapesJS runs in the browser as an `ssr:false` dynamic-imported component (same pattern as the existing `@xyflow/react` `/journeys` canvas). MJML→responsive-HTML compilation happens in-browser via `mjml-browser`. Each template stores `content.html_body` (the compiled, editor-agnostic **send artifact**), `content.text_body` (auto-derived plaintext), `content.design_json` (GrapesJS project state, re-edit only), plus the existing top-level `variables` column. The send spine, gate, TEST MODE, and approval lifecycle are **untouched** — the only new backend surface is one commsops action that mints a signed upload URL into a new public Supabase storage bucket for email images.

**Tech Stack:** GrapesJS + grapesjs-mjml + mjml-browser (client libs, bundled into `@throttle/relay`); commsops Cloudflare Worker (`node:test` unit tests); Supabase Storage (public bucket, service-role signed uploads mirroring the lotops `part-photos` pattern).

**Scope note (v1 cut line — confirmed by Afshaan 2026-07-16):** ship the editor core (blocks + merge-tags + preview + test-send + image upload + create-from-scratch + saved-templates browse). The **curated LOT-branded starter library is a fast-follow**, NOT part of this plan. The journey-rebuild starter templates (spec §8 step 7) are WhatsApp sends and belong to WhatsApp authoring (Phase 2 / WS-B), so they are out of scope here too.

**Spec:** `05_Throttle/docs/superpowers/specs/2026-07-15-relay-email-authoring-v1-design.md`

---

## Established facts (verified against the live codebase 2026-07-16 — do not re-derive)

- **`comms.templates` columns:** `id uuid`, `channel text`, `name text`, `purpose text`, `language text`, `status text`, `version int`, `provider_template_id text`, `approval_status text`, **`content jsonb` (default `{}`)**, **`variables jsonb` (default `[]`, TOP-LEVEL column)**, `created_by text`, `created_at`, `updated_at`. → `design_json` goes **inside `content`**; NO migration needed. `variables` stays the existing top-level column the page already reads.
- **`saveTemplate`** (commsops `src/index.js:249`) stores `content` verbatim and bumps `version` on edit — storing `content.design_json`/`html_body`/`text_body`/`subject` needs **zero worker change**.
- **`sendTest`** (commsops `src/index.js:274`) already accepts an in-memory `template:{content,variables}` — in-editor test-send reuses it as-is.
- **Current editor:** `apps/relay/src/app/(auth)/templates/page.js` — `content = {subject, html_body, text_body}`, a Variables builder writing the top-level `variables` array, and a test-send panel. Uses `useAuth()`, `garageFetch`/`workerFetch` (`@throttle/db`), and `@/components/ui.js` (`PageHead, Panel, Badge, Btn, EmptyState`).
- **Heavy client-dep pattern (mirror this):** `apps/relay/src/app/(auth)/journeys/page.js:14` — `const JourneyCanvas = dynamic(() => import('@/components/journey-canvas/JourneyCanvas.js'), { ssr:false, loading:()=><Spinner/> });`. Component lives under `src/components/<feature>/`.
- **Image-upload pattern to mirror:** lotops `createPartPhotoUploadUrl` (`01_worker/worker.js:17164`) — POST `/storage/v1/object/upload/sign/<bucket>/<path>` with service-role key → parse `token` from returned url → hand client a signed upload URL + public URL. commsops storage auth = same service-role headers as `sbComms` (`SUPABASE_SERVICE_ROLE_KEY`).
- **commsops auth helpers** (`src/auth.js`): `sbComms`/`sbStore` (profile-scoped fetch w/ service-role headers), `canTemplate` (=`template_manage`), `canBuild` (=`campaign_build`), `enc`. Worker is `type: commonjs`; POST routes on `body.action`; GET on `?action=`.
- **Monorepo:** npm workspaces, root `package-lock.json`. Build: `npx turbo build --filter=relay` (run from `05_Throttle/`). Relay auto-deploys on push to `main`. commsops deploys via `cd 05_Throttle/commsops-worker && npx wrangler deploy`.
- **Worker unit tests:** plain `node --test` files in `commsops-worker/test/*.test.js` (CommonJS, no framework).

## Testing approach (read before starting)

This build is ~80% front-end editor integration in a static-export Next app that has **no JS unit-test harness** (every prior Relay app milestone was verified by build-green + browser smoke, not app unit tests). Do **not** introduce jest/vitest into the app. Apply tests where the codebase already has a harness:

- **`node --test` unit tests** for the two genuinely pure/testable pieces: the commsops storage helper (Task 3) and the plaintext deriver (Task 5). These are plain CommonJS/ESM modules run directly with `node`.
- **Build-green gate** (`npx turbo build --filter=relay`, zero errors) at the end of every front-end task.
- **Browser smoke** (the spec's real acceptance test, §8 step 8) at the end — driven via the preview tools for what's reachable, with the authenticated Google-login flows handed to Afshaan.

---

## File structure

**commsops-worker (Relay backend):**
- Create `commsops-worker/src/email-assets.js` — pure helpers: `assetPath(fileName, nowMs)` (safe storage path) + `signToUrls(env, bucket, path, signData)` (shape the signed-upload + public URLs).
- Create `commsops-worker/test/email-assets.test.js` — `node --test`.
- Modify `commsops-worker/src/index.js` — add the `createEmailAssetUploadUrl` POST action (uses `email-assets.js` + a small storage fetch).

**Supabase:** new public bucket `relay-email-assets` (one SQL insert, Task 2).

**relay app (`apps/relay`):**
- Modify `apps/relay/package.json` — add `grapesjs`, `grapesjs-mjml`, `mjml-browser`.
- Create `apps/relay/src/components/email-editor/htmlToPlain.js` (+ `htmlToPlain.test.js`) — plaintext deriver.
- Create `apps/relay/src/components/email-editor/exportEmail.js` — pure: editor → `{mjml, html}` via mjml-browser.
- Create `apps/relay/src/components/email-editor/blankScaffold.js` — the starter MJML for create-from-scratch / legacy templates with no `design_json`.
- Create `apps/relay/src/components/email-editor/registerMergeTags.js` — GrapesJS RTE merge-tag dropdown.
- Create `apps/relay/src/components/email-editor/EmailEditor.js` — the `ssr:false` client GrapesJS component (init, MJML plugin, asset-upload handler → worker action, load/onChange/export, device preview).
- Modify `apps/relay/src/app/(auth)/templates/page.js` — swap the email Content panel for the dynamic-imported `EmailEditor`; wire subject + export → save payload; load `design_json` on edit; bind merge-tag menu to `variables`.

---

## Task 1: Add editor dependencies + pin the MJML compile path

**Files:**
- Modify: `apps/relay/package.json`

- [ ] **Step 1: Add the three client libraries to the relay app**

Edit `apps/relay/package.json` `dependencies` (keep alphabetical-ish, matching the existing style) to add:

```json
    "grapesjs": "^0.22.7",
    "grapesjs-mjml": "^1.0.6",
    "mjml-browser": "^4.15.3",
```

- [ ] **Step 2: Install at the workspace root**

Run (from `05_Throttle/`):
```bash
npm install
```
Expected: installs into the root `node_modules`, updates `package-lock.json`, exit 0. (npm workspaces hoists; the `--filter` build will resolve them.)

- [ ] **Step 3: Verify the MJML compile API is what the plan assumes**

The plan compiles the canvas output with `mjml-browser` directly (NOT a grapesjs-mjml internal command), so the only thing to confirm is that (a) grapesjs-mjml's `editor.getHtml()` returns MJML markup and (b) `mjml-browser` default-exports `mjml2html`. Confirm from the installed packages:
```bash
node -e "const m=require('mjml-browser'); console.log(typeof (m.default||m));"
```
Expected: `function` (the `mjml2html` compiler). Then skim `node_modules/grapesjs-mjml/README.md` for the "getHtml returns MJML" contract (it is the plugin's core behavior). If either differs, STOP and reconcile before Task 6 — do not guess.

- [ ] **Step 4: Confirm the build still passes with the deps present (unused so far)**

Run (from `05_Throttle/`):
```bash
npx turbo build --filter=relay
```
Expected: build succeeds, zero errors.

- [ ] **Step 5: Commit**

```bash
git -C 05_Throttle add apps/relay/package.json package-lock.json
git -C 05_Throttle commit -m "relay: add grapesjs + grapesjs-mjml + mjml-browser for email authoring v1"
```

---

## Task 2: Create the `relay-email-assets` public storage bucket

**Files:** none (Supabase storage config via SQL).

- [ ] **Step 1: Create the bucket (idempotent)**

Run this SQL against Supabase `lot-production` (`jkxcnjabmrkteanzoofj`) via `execute_sql` (INSERT — runs autonomously, not gated):

```sql
insert into storage.buckets (id, name, public)
values ('relay-email-assets', 'relay-email-assets', true)
on conflict (id) do update set public = true;
```

- [ ] **Step 2: Verify**

```sql
select id, name, public from storage.buckets where id = 'relay-email-assets';
```
Expected: one row, `public = true`. (Service-role signed uploads bypass storage RLS; `public=true` makes the object URLs world-readable for email `<img src>`.)

---

## Task 3: commsops storage helpers (pure) — TDD

**Files:**
- Create: `commsops-worker/src/email-assets.js`
- Test: `commsops-worker/test/email-assets.test.js`

- [ ] **Step 1: Write the failing test**

Create `commsops-worker/test/email-assets.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { assetPath, signToUrls } = require('../src/email-assets.js');

test('assetPath sanitizes the filename and namespaces under email/ with a timestamp', () => {
  const p = assetPath('My Logo (final).PNG', 1700000000000);
  assert.strictEqual(p, 'email/1700000000000_my-logo-final-.png');
});

test('assetPath falls back to a generic name when filename is empty', () => {
  const p = assetPath('', 1700000000000);
  assert.strictEqual(p, 'email/1700000000000_upload');
});

test('assetPath collapses runs and strips path separators (no traversal)', () => {
  const p = assetPath('../../etc/passwd', 1700000000000);
  assert.strictEqual(p, 'email/1700000000000_etc-passwd');
});

test('signToUrls extracts the token and builds absolute upload + public URLs', () => {
  const env = { SUPABASE_URL: 'https://x.supabase.co' };
  const signData = { url: '/object/upload/sign/relay-email-assets/email/1_a.png?token=abc.def' };
  const out = signToUrls(env, 'relay-email-assets', 'email/1_a.png', signData);
  assert.strictEqual(out.token, 'abc.def');
  assert.strictEqual(out.upload_url, 'https://x.supabase.co/storage/v1/object/upload/sign/relay-email-assets/email/1_a.png?token=abc.def');
  assert.strictEqual(out.public_url, 'https://x.supabase.co/storage/v1/object/public/relay-email-assets/email/1_a.png');
  assert.strictEqual(out.storage_path, 'email/1_a.png');
});

test('signToUrls returns null token when the sign url has none', () => {
  const env = { SUPABASE_URL: 'https://x.supabase.co' };
  const out = signToUrls(env, 'relay-email-assets', 'email/1_a.png', { url: '/nope' });
  assert.strictEqual(out.token, null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `commsops-worker/`):
```bash
node --test test/email-assets.test.js
```
Expected: FAIL — `Cannot find module '../src/email-assets.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `commsops-worker/src/email-assets.js`:

```js
// Pure helpers for the relay-email-assets image bucket. No I/O — unit-testable.

// Lowercase, strip anything but [a-z0-9.], collapse runs to a single dash,
// keep the extension. Removes path separators so there's no traversal.
function safeSeg(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'upload';
}

function assetPath(fileName, nowMs) {
  return `email/${nowMs}_${safeSeg(fileName)}`;
}

function signToUrls(env, bucket, path, signData) {
  const rel = String(signData?.url || '');
  const m = rel.match(/token=([^&]+)/);
  return {
    storage_path: path,
    token: m ? decodeURIComponent(m[1]) : null,
    upload_url: `${env.SUPABASE_URL}/storage/v1${rel}`,
    public_url: `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`,
  };
}

module.exports = { safeSeg, assetPath, signToUrls };
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `commsops-worker/`):
```bash
node --test test/email-assets.test.js
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C 05_Throttle add commsops-worker/src/email-assets.js commsops-worker/test/email-assets.test.js
git -C 05_Throttle commit -m "relay(commsops): pure email-assets storage-path + signed-url helpers + tests"
```

---

## Task 4: commsops `createEmailAssetUploadUrl` action + deploy

**Files:**
- Modify: `commsops-worker/src/index.js` (add the require + the POST action)

- [ ] **Step 1: Require the helper**

In `commsops-worker/src/index.js`, near the other top-of-file requires (after `const AL = require('./alerts.js');`, ~line 15), add:

```js
const EA = require('./email-assets.js');
```

- [ ] **Step 2: Add the POST action**

In the POST action switch, immediately after the `case 'saveTemplate': { ... }` block (ends ~line 272), add:

```js
    case 'createEmailAssetUploadUrl': {   // email authoring v1 — mint a signed upload URL into the public relay-email-assets bucket
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const fileName = body.file_name || body.fileName;
      if (!fileName) return err('file_name_required', 400);
      const bucket = 'relay-email-assets';
      const path = EA.assetPath(fileName, Date.now());
      // Service-role signed upload URL (bypasses storage RLS) — same shape as lotops createPartPhotoUploadUrl.
      const sr = await fetch(`${env.SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${path}`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
      });
      const st = await sr.text();
      let sd; try { sd = st ? JSON.parse(st) : null; } catch { sd = null; }
      if (!sr.ok || !sd?.url) return err(`sign_failed:${st}`, 502);
      return ok(EA.signToUrls(env, bucket, path, sd));
    }
```

- [ ] **Step 3: Dry-run the worker bundle**

Run (from `commsops-worker/`):
```bash
npx wrangler deploy --dry-run
```
Expected: bundles with no errors.

- [ ] **Step 4: Commit, push, deploy**

```bash
git -C 05_Throttle add commsops-worker/src/index.js
git -C 05_Throttle commit -m "relay(commsops): createEmailAssetUploadUrl — signed upload into relay-email-assets"
git -C 05_Throttle push
cd 05_Throttle/commsops-worker && npx wrangler deploy
```
Expected: deploy succeeds; note the Cloudflare version id.

- [ ] **Step 5: Live smoke the action (needs an INGEST-free authed call)**

The action is JWT-gated (`template_manage`), so smoke it end-to-end in the browser during Task 10 (upload an image in the editor). For a standalone check now, confirm the route exists and rejects an unauthenticated call:
```bash
curl -s -X POST https://commsops.afshaan.workers.dev/ -H 'Content-Type: application/json' -d '{"action":"createEmailAssetUploadUrl","file_name":"x.png"}' | head -c 300
```
Expected: an auth/forbidden error (not `Unknown action`) — confirms the action is wired.

---

## Task 5: Plaintext deriver (pure) — TDD

**Files:**
- Create: `apps/relay/src/components/email-editor/htmlToPlain.js`
- Test: `apps/relay/src/components/email-editor/htmlToPlain.test.js`

> Auto-strip is the v1 decision (spec §9). This module is plain ESM with no React/DOM, so it runs under `node --test` directly.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/src/components/email-editor/htmlToPlain.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { htmlToPlain } from './htmlToPlain.js';

test('strips tags and keeps visible text', () => {
  assert.strictEqual(htmlToPlain('<p>Hi <b>Afshaan</b></p>'), 'Hi Afshaan');
});

test('drops style/script blocks entirely', () => {
  const html = '<style>.x{color:red}</style><p>Hello</p><script>alert(1)</script>';
  assert.strictEqual(htmlToPlain(html), 'Hello');
});

test('turns block boundaries into single newlines and collapses whitespace', () => {
  const html = '<h1>Title</h1><p>Line one</p><p>Line two</p>';
  assert.strictEqual(htmlToPlain(html), 'Title\nLine one\nLine two');
});

test('decodes common entities and preserves merge tokens', () => {
  assert.strictEqual(htmlToPlain('<p>Save 10% &amp; more, {first}</p>'), 'Save 10% & more, {first}');
});

test('empty / nullish input returns empty string', () => {
  assert.strictEqual(htmlToPlain(''), '');
  assert.strictEqual(htmlToPlain(null), '');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `apps/relay/`):
```bash
node --test src/components/email-editor/htmlToPlain.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/relay/src/components/email-editor/htmlToPlain.js`:

```js
// Derive a plaintext fallback from compiled email HTML. Pure string ops (no DOM)
// so it runs identically in-browser and under node --test.
const BLOCK = /<\/(p|div|h[1-6]|tr|table|li|ul|ol|section|header|footer|br)\s*>|<br\s*\/?>/gi;

export function htmlToPlain(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '');   // drop style/script contents
  s = s.replace(BLOCK, '\n');                             // block ends -> newline
  s = s.replace(/<[^>]+>/g, '');                          // strip remaining tags
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
  s = s.replace(/[ \t]+/g, ' ');                          // collapse inline whitespace
  s = s.replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n'); // one newline per block boundary
  return s.trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/relay/`):
```bash
node --test src/components/email-editor/htmlToPlain.test.js
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C 05_Throttle add "apps/relay/src/components/email-editor/htmlToPlain.js" "apps/relay/src/components/email-editor/htmlToPlain.test.js"
git -C 05_Throttle commit -m "relay: htmlToPlain plaintext deriver for email templates + tests"
```

---

## Task 6: MJML export + blank scaffold (pure client modules)

**Files:**
- Create: `apps/relay/src/components/email-editor/exportEmail.js`
- Create: `apps/relay/src/components/email-editor/blankScaffold.js`

> These are browser modules (import `mjml-browser`), so they're covered by build-green + browser smoke, not `node --test`.

- [ ] **Step 1: Write the export helper**

Create `apps/relay/src/components/email-editor/exportEmail.js`:

```js
// grapesjs-mjml keeps the canvas as MJML components, so editor.getHtml() serializes
// to MJML markup. We compile that to responsive HTML with mjml-browser directly —
// this avoids depending on any grapesjs-mjml internal export command name.
import mjml2html from 'mjml-browser';
import { htmlToPlain } from './htmlToPlain.js';

// Returns { mjml, html, text } — html is the send artifact, mjml is for reference.
export function exportEmail(editor) {
  const mjml = editor.getHtml();               // MJML string (grapesjs-mjml contract)
  const { html, errors } = mjml2html(mjml, { validationLevel: 'soft', minify: false });
  if (errors && errors.length) console.warn('[email-editor] MJML compile warnings', errors);
  return { mjml, html: html || '', text: htmlToPlain(html || '') };
}
```

- [ ] **Step 2: Write the blank scaffold**

Create `apps/relay/src/components/email-editor/blankScaffold.js`:

```js
// Starter MJML loaded when creating from scratch, or when re-editing a legacy
// template that has no design_json (its stored html_body still SENDS fine — the
// reversibility contract; only visual re-edit needs a rebuilt canvas).
export const BLANK_MJML = `<mjml>
  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="20px" font-weight="700" color="#282828">Heading</mj-text>
        <mj-text font-size="14px" line-height="1.6" color="#282828">Write your email here. Insert merge tags from the toolbar.</mj-text>
        <mj-button background-color="#F2CD1A" color="#282828" href="https://legendoftoys.com">Shop now</mj-button>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" padding="0 24px 24px">
      <mj-column>
        <mj-text font-size="11px" color="#888888" align="center">
          Legend of Toys · <a href="{unsubscribe_url}" style="color:#888888">Unsubscribe</a>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
```

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add "apps/relay/src/components/email-editor/exportEmail.js" "apps/relay/src/components/email-editor/blankScaffold.js"
git -C 05_Throttle commit -m "relay: email-editor MJML export helper + blank starter scaffold"
```

---

## Task 7: Merge-tag RTE dropdown

**Files:**
- Create: `apps/relay/src/components/email-editor/registerMergeTags.js`

- [ ] **Step 1: Write the registration helper**

Create `apps/relay/src/components/email-editor/registerMergeTags.js`:

```js
// Adds a "merge tag" dropdown to GrapesJS's Rich Text Editor toolbar. Selecting a
// token inserts `{token}` at the cursor (GrapesJS single-brace render contract).
// `getTokens()` is called at open time so the list tracks the live Variables panel.
export function registerMergeTags(editor, getTokens) {
  editor.RichTextEditor.add('mergeTag', {
    icon: `<select class="gjs-field" style="max-width:130px">
             <option value="">↧ tag</option>
           </select>`,
    event: 'change',
    attributes: { title: 'Insert merge tag' },
    result: (rte, action) => {
      const sel = action.btn.firstChild;
      const val = sel && sel.value;
      if (val) rte.insertHTML(`{${val}}`, { select: true });
      if (sel) sel.value = '';
    },
    update: (rte, action) => {
      // Repopulate options each time the RTE toolbar renders.
      const sel = action.btn.firstChild;
      if (!sel) return;
      const tokens = (getTokens() || []).filter(Boolean);
      sel.innerHTML = '<option value="">↧ tag</option>'
        + tokens.map((t) => `<option value="${t}">{${t}}</option>`).join('');
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git -C 05_Throttle add "apps/relay/src/components/email-editor/registerMergeTags.js"
git -C 05_Throttle commit -m "relay: email-editor merge-tag RTE dropdown"
```

---

## Task 8: The `EmailEditor` client component

**Files:**
- Create: `apps/relay/src/components/email-editor/EmailEditor.js`

- [ ] **Step 1: Write the component**

Create `apps/relay/src/components/email-editor/EmailEditor.js`:

```js
'use client';
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import grapesjs from 'grapesjs';
import grapesjsMjml from 'grapesjs-mjml';
import 'grapesjs/dist/css/grapes.min.css';
import { workerFetch } from '@throttle/db';
import { exportEmail } from './exportEmail.js';
import { BLANK_MJML } from './blankScaffold.js';
import { registerMergeTags } from './registerMergeTags.js';

// Uploads a File to the relay-email-assets bucket via the commsops action and
// returns the public URL for GrapesJS's asset manager.
async function uploadAsset(file, session) {
  const r = await workerFetch('createEmailAssetUploadUrl',
    { file_name: file.name, mime_type: file.type || null }, session);
  const d = r?.data;
  if (!d?.upload_url) throw new Error('upload sign failed');
  const put = await fetch(d.upload_url, {
    method: 'PUT',
    headers: { 'x-upsert': 'true', ...(file.type ? { 'Content-Type': file.type } : {}) },
    body: file,
  });
  if (!put.ok) throw new Error('upload failed: ' + put.status);
  return d.public_url;
}

// Props:
//   initialDesign  : GrapesJS project data (content.design_json) or null
//   getTokens()    : () => string[]  (declared variable tokens, for the merge menu)
//   session, readOnly
// Ref API: export() -> { mjml, html, text }, setDevice(name)
const EmailEditor = forwardRef(function EmailEditor({ initialDesign, getTokens, session, readOnly }, ref) {
  const holderRef = useRef(null);
  const edRef = useRef(null);

  useImperativeHandle(ref, () => ({
    export: () => (edRef.current ? exportEmail(edRef.current) : { mjml: '', html: '', text: '' }),
    setDevice: (name) => { if (edRef.current) edRef.current.setDevice(name); },
  }), []);

  useEffect(() => {
    if (!holderRef.current) return undefined;
    const editor = grapesjs.init({
      container: holderRef.current,
      height: '640px',
      fromElement: false,
      storageManager: false,          // we persist via saveTemplate, not GrapesJS storage
      plugins: [grapesjsMjml],
      pluginsOpts: { [grapesjsMjml]: {} },
      assetManager: {
        // Custom upload: send bytes to our bucket, add the returned public URL.
        uploadFile: async (e) => {
          const files = e.dataTransfer ? e.dataTransfer.files : e.target.files;
          for (const f of files) {
            try {
              const url = await uploadAsset(f, session);
              editor.AssetManager.add(url);
            } catch (err) { console.error('[email-editor] asset upload', err); }
          }
        },
      },
    });
    registerMergeTags(editor, getTokens);

    // Seed the canvas: prior design if present, else the branded blank scaffold.
    if (initialDesign && Object.keys(initialDesign).length) editor.loadProjectData(initialDesign);
    else editor.setComponents(BLANK_MJML);

    if (readOnly) editor.getModel().set('dmode', 'absolute'); // best-effort; view-only users still can't save

    edRef.current = editor;
    return () => { editor.destroy(); edRef.current = null; };
    // Init once per mount; parent remounts (via key) to load a different template.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={holderRef} className="email-gjs" />;
});

export default EmailEditor;
```

- [ ] **Step 2: Build-green gate**

Run (from `05_Throttle/`):
```bash
npx turbo build --filter=relay
```
Expected: build succeeds, zero errors. (The component is imported only via `ssr:false` dynamic import in Task 9, but building now catches import/JSX errors early. If the build tries to SSR grapesjs here, it won't — the component isn't referenced yet; this step is a compile check of the new file.)

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add "apps/relay/src/components/email-editor/EmailEditor.js"
git -C 05_Throttle commit -m "relay: EmailEditor GrapesJS+MJML client component (asset upload, merge tags, project load/export)"
```

---

## Task 9: Wire the editor into `/templates`

**Files:**
- Modify: `apps/relay/src/app/(auth)/templates/page.js`

- [ ] **Step 1: Add imports + dynamic editor + a design_json ref**

At the top of `page.js`, after the existing imports, add:

```js
import dynamic from 'next/dynamic';
import { useRef } from 'react';
import { htmlToPlain } from '@/components/email-editor/htmlToPlain.js';

const EmailEditor = dynamic(() => import('@/components/email-editor/EmailEditor.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });
```

- [ ] **Step 2: Track design_json in template state**

In `emptyTemplate()` add `design_json: null` to the returned object. In `startEdit(r)`, add `design_json: c.design_json || null` to the `setT({...})` call (alongside `html_body`). Add an editor ref inside the component body (near the other `useState`s):

```js
  const edRef = useRef(null);
```

- [ ] **Step 3: Export from the editor into the save payload**

Replace `buildPayload()` so that for the email channel it pulls the compiled HTML/text/design from the live editor (falling back to state when the editor isn't mounted, e.g. a view-only render):

```js
  function buildPayload() {
    const variables = t.variables
      .filter((v) => v.token && v.token.trim())
      .map((v) => {
        const out = { token: v.token.trim(), source: v.source };
        if (v.field && v.field.trim()) out.field = v.field.trim();
        if (v.fallback !== '' && v.fallback != null) out.fallback = v.fallback;
        if (v.source === 'constant' && v.value != null && v.value !== '') out.value = v.value;
        return out;
      });
    let content = { subject: t.subject, html_body: t.html_body, text_body: t.text_body };
    if (t.channel === 'email' && edRef.current) {
      const ex = edRef.current.export();
      content = {
        subject: t.subject,
        html_body: ex.html,
        text_body: ex.text || htmlToPlain(ex.html),
        design_json: edRef.current ? undefined : t.design_json, // set below
      };
      // Capture the GrapesJS project state for re-edit.
      content.design_json = ex.design_json ?? t.design_json ?? null;
    }
    return {
      channel: t.channel, name: t.name.trim(), purpose: t.purpose, language: t.language || 'en',
      status: t.status, content, variables,
    };
  }
```

> Note: `export()` returns `{mjml, html, text}`. To also capture design_json, extend the ref API — see Step 4. Adjust `content.design_json = ex.design === undefined ? t.design_json : ex.design;` after Step 4.

- [ ] **Step 4: Extend the editor ref to also return design_json on export**

In `apps/relay/src/components/email-editor/EmailEditor.js`, change the `useImperativeHandle` `export` to include the project data:

```js
    export: () => {
      if (!edRef.current) return { mjml: '', html: '', text: '', design: null };
      const out = exportEmail(edRef.current);
      return { ...out, design: edRef.current.getProjectData() };
    },
```

And in `page.js` `buildPayload()`, set:

```js
      content.design_json = ex.design ?? t.design_json ?? null;
```

(Remove the earlier throwaway `design_json: undefined` line — final `content` for email = `{subject, html_body, text_body, design_json}`.)

- [ ] **Step 5: Replace the Content panel for email**

In the form view, replace the entire `<Panel title="Content" pad> ... </Panel>` block with: a subject input + a device-preview toggle + the editor for email, keeping the raw textareas ONLY as a fallback for any non-email channel (there are none in v1, but keep it defensive):

```jsx
        <Panel title="Content" pad
          action={t.channel === 'email' ? (
            <span style={{ display: 'flex', gap: 6 }}>
              <Btn onClick={() => edRef.current && edRef.current.setDevice('Desktop')}>Desktop</Btn>
              <Btn onClick={() => edRef.current && edRef.current.setDevice('Mobile portrait')}>Mobile</Btn>
            </span>
          ) : null}>
          <div className="ff" style={{ marginBottom: 14, padding: t.channel === 'email' ? 14 : 0 }}>
            <div className="kv-k">Subject</div>
            <input className="f-inp" value={t.subject} onChange={(e) => set('subject', e.target.value)}
              placeholder="We miss you, {first} — 10% inside" disabled={saving || !canEdit} />
          </div>
          {t.channel === 'email' ? (
            <EmailEditor
              key={t.id || 'new'}
              ref={edRef}
              initialDesign={t.design_json}
              getTokens={() => t.variables.map((v) => v.token).filter(Boolean)}
              session={session}
              readOnly={!canEdit}
            />
          ) : (
            <>
              <div className="ff" style={{ marginBottom: 14 }}><div className="kv-k">HTML body</div>
                <textarea className="f-inp mono" rows={12} value={t.html_body} onChange={(e) => set('html_body', e.target.value)} disabled={saving || !canEdit} />
              </div>
              <div className="ff"><div className="kv-k">Plain-text body (fallback)</div>
                <textarea className="f-inp mono" rows={5} value={t.text_body} onChange={(e) => set('text_body', e.target.value)} disabled={saving || !canEdit} />
              </div>
            </>
          )}
          <div className="tw-note" style={{ marginTop: 10 }}>
            Insert <code>{'{token}'}</code> merge tags from the editor toolbar; declare each below.
            Marketing sends auto-expose <code>{'{unsubscribe_url}'}</code>.
          </div>
        </Panel>
```

- [ ] **Step 6: Make test-send use the freshly-exported content**

In `sendTest()`, the payload already calls `buildPayload()` — which now returns the compiled email `content`. No change needed beyond confirming `buildPayload()` runs (it does). Verify by reading the function.

- [ ] **Step 7: Add minimal editor CSS so it sits inside the panel**

Append to `apps/relay/src/app/globals.css` (or the app's existing global stylesheet — confirm the filename with `ls apps/relay/src/app/*.css`):

```css
.email-gjs { border: 1px solid var(--border, #e5e5e5); border-radius: 8px; overflow: hidden; }
.email-gjs .gjs-cv-canvas { background: #f4f4f4; }
```

- [ ] **Step 8: Build-green gate**

Run (from `05_Throttle/`):
```bash
npx turbo build --filter=relay
```
Expected: build succeeds, zero errors.

- [ ] **Step 9: Commit**

```bash
git -C 05_Throttle add "apps/relay/src/app/(auth)/templates/page.js" apps/relay/src/components/email-editor/EmailEditor.js apps/relay/src/app/globals.css
git -C 05_Throttle commit -m "relay: embed GrapesJS+MJML editor in /templates (subject + preview + export->save + design_json re-edit)"
```

---

## Task 10: Full build, push, and browser smoke

**Files:** none (verification + deploy).

- [ ] **Step 1: Full monorepo build**

Run (from `05_Throttle/`):
```bash
npx turbo build --filter=relay
```
Expected: zero errors. If other apps import nothing new, no need to build them.

- [ ] **Step 2: Push (relay auto-deploys; commsops already deployed in Task 4)**

```bash
git -C 05_Throttle push
```
Expected: GitHub Actions builds relay → gh-pages (3–4 min).

- [ ] **Step 3: Browser smoke — reachable-without-auth checks**

Using the preview/browser tools, confirm the deployed asset action and public bucket work independent of the SPA login:
- The bucket is public: after Task 4's browser upload (Step 4 below), the returned `public_url` returns 200 with the image bytes.

- [ ] **Step 4: Browser smoke — authenticated editor flow (HAND TO AFSHAAN — needs Google login)**

Relay auth is Google/Supabase behind the access allow-list, so the authenticated smoke is Afshaan's. Provide this checklist:
1. Open `relay.legendoftoys.com/templates` → **New template** (channel=email).
2. The GrapesJS canvas loads with the branded blank scaffold; drag a Text + Button + Image block.
3. Upload an image via the Image block → it appears (served from `relay-email-assets`).
4. Add a variable `first` in the Variables panel → the editor toolbar's **merge-tag dropdown** lists `{first}`; insert it into a text block.
5. Toggle **Desktop/Mobile** preview.
6. **Send test** to `afshaan@legendoftoys.com` with `{"first":"Afshaan"}` → arrives, responsive, `{first}` resolved, unsubscribe link present. (TEST MODE stays ON — allowlisted only.)
7. **Save template** → reopen it → the canvas reloads from `design_json` (re-editable), and the saved `content.html_body` is the compiled MJML output.
8. Open a **legacy** raw-authored template → it opens on the blank scaffold (no design_json) but still shows its stored subject; saving rebuilds its design. Confirm this is acceptable (reversibility contract).

- [ ] **Step 5: Report**

Report the commsops version id (Task 4), the relay deploy status, and the smoke results. Note anything deferred (starter library = fast-follow; WhatsApp/commerce blocks = Phase 2).

---

## Task 11: Knowledge-file updates (session-wrap)

**Files:**
- Modify: `systems/relay.md`, `BACKLOG.md` (workspace root)

- [ ] **Step 1: Update `systems/relay.md`**

Add an "Email authoring v1 (GrapesJS+MJML) LIVE" entry under the authoring workstream: the editor embedded in `/templates`, `content.design_json` re-edit state + `content.html_body` send artifact, `relay-email-assets` public bucket + `createEmailAssetUploadUrl` (commsops), plaintext auto-derived, merge-tags bound to `variables`, send/gate/TEST MODE unchanged. Bump `Last updated`.

- [ ] **Step 2: Update `BACKLOG.md`**

Move the `[relay] [HIGH] Email authoring v1` item from `[ ]` "ready to build" to `[~]` "shipped; browser smoke = Afshaan", and add the fast-follows: curated LOT-branded starter library; WhatsApp visual builder + commerce blocks (Product Recommendation/Order Summary) = Phase 2.

- [ ] **Step 3: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude add systems/relay.md BACKLOG.md
git -C /Users/afshaansiddiqui/Documents/Claude commit -m "relay: knowledge — email authoring v1 shipped; starter library + WA builder fast-follows"
git -C /Users/afshaansiddiqui/Documents/Claude push
```

---

## Self-review (completed against the spec)

- **§3 In-scope:** editor in `/templates` (T8–9), block set (grapesjs-mjml default MJML blocks, T1), merge tags (T7/T9), preview desktop/mobile (T9 Step 5), send-test (T9 Step 6, reuses `sendTest`), image upload → our bucket (T2–4, T8), composer unchanged (untouched). Saved templates + create-from-scratch = existing list + `key`-remount editor (T9). **Starter library deliberately deferred** per the confirmed v1 cut line (documented at top + T11).
- **§4 Architecture:** ssr:false client component (T8), design_json in `content` no-migration (verified; T9), MJML→HTML in-browser via mjml-browser (T6), signed upload mirror of part-photos (T4), send path unchanged, versioning via existing `saveTemplate` (T9).
- **§9 Open questions:** design_json placement — resolved (in `content`, no migration). Starter curation — deferred (fast-follow). Plaintext — auto-strip (T5). Image editing — upload-only (T8, no crop/resize). All resolved or explicitly deferred.
- **Placeholder scan:** every code step has complete code; the one external-API assumption (grapesjs-mjml `getHtml()`→MJML + `mjml-browser` compile) is pinned in T1 Step 3 before first use.
- **Type consistency:** `assetPath`/`signToUrls` (T3) match their call in T4; `createEmailAssetUploadUrl` return shape (`upload_url`/`public_url`) matches `uploadAsset` in T8; editor ref `export()`→`{mjml,html,text,design}` matches `buildPayload()` usage in T9; `htmlToPlain` signature consistent T5/T6/T9.
