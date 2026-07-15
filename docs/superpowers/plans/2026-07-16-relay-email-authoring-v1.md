# Relay Email Authoring v1 — Implementation Plan (rev. 2 — post-spike + review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Relay's raw `subject + html textarea` email template editor with a self-hosted GrapesJS + MJML drag-drop visual builder embedded in `/templates`, so the marketing team gets BiteSpeed-parity authoring and can migrate off BiteSpeed.

**Architecture:** Client-side only. Relay is a Next.js **static export** — GrapesJS runs in the browser as an `ssr:false` dynamic-imported component (same pattern as the `@xyflow/react` `/journeys` canvas). MJML→responsive-HTML compilation happens in-browser via `mjml-browser`. Each template stores `content.html_body` (compiled, editor-agnostic **send artifact**), `content.text_body` (auto-derived plaintext), `content.design_json` (GrapesJS project state, re-edit only), plus the existing top-level `variables` column. The send spine, gate, TEST MODE, and approval lifecycle are **untouched**. The only new backend surface is one commsops action that mints a signed upload URL into a new public Supabase bucket for email images.

**Tech Stack:** grapesjs 0.22.16 + grapesjs-mjml 1.0.8 + mjml-browser 4.18.0 (client libs, code-split into `@throttle/relay`); commsops Cloudflare Worker (`node:test`); Supabase Storage (public bucket, service-role signed uploads mirroring lotops `part-photos`).

**Spec:** `05_Throttle/docs/superpowers/specs/2026-07-15-relay-email-authoring-v1-design.md`
**v1 cut line (Afshaan, 2026-07-16):** ship the editor core (blocks + merge-tags + preview + test-send + image upload + create-from-scratch + saved-templates browse). The **curated LOT-branded starter library is a fast-follow**, NOT in this plan. Journey-rebuild starter templates are WhatsApp (Phase 2 / WS-B) — out of scope here.

---

## Spike results folded into this plan (do NOT re-verify — proven live 2026-07-16)

A throwaway `/spike-email` route was built and run in a real browser + a real static-export build. Proven:
- **C1 export contract:** `editor.getHtml()` returns **MJML** (`<mjml>…`); `mjml-browser`'s default export `mjml2html(mjml, {validationLevel:'soft'})` compiles it in-browser to a full responsive `<!doctype html>` document; **merge tokens `{first}` survive compilation** (so `render.js` binds them at send); `editor.getProjectData()` returns valid design JSON (keys `dataSources,assets,styles,pages,symbols`).
- **C2 bundling:** `npx turbo build --filter=relay` (static export) succeeds with the three libs present — **no webpack Node-builtin errors, no `resolve.fallback` needed**. `mjml-browser` is a single prebundled browser UMD (references `window`, no `fs`/`path`). Heavy libs code-split behind the `ssr:false` dynamic import (spike route first-load = 89 kB).
- **Plugin form:** `grapesjs.init({ plugins:[grapesjsMjml] })` with **no** `pluginsOpts` works (the earlier `pluginsOpts:{[grapesjsMjml]:{}}` idea was a bug — do not use it).
- **Seeding:** `editor.setComponents('<mjml>…')` renders the scaffold into the canvas; `editor.loadProjectData(json)` restores a saved design.
- **CSS:** `import 'grapesjs/dist/css/grapes.min.css'` inside the client component builds fine under App Router.
- **Deps are already installed** (in `node_modules` + `apps/relay/package.json` + `package-lock.json`, currently uncommitted) — Task 1 just commits them.
- **`mjml-browser` cannot be `require`d in Node** (needs `window`) → it is imported ONLY inside the `ssr:false` client component, never in SSR/prerender or a Node test.

## Established codebase facts (verified — do not re-derive)

- **`comms.templates`:** `content jsonb` (default `{}`) + top-level **`variables jsonb`** (default `[]`). `design_json` goes **inside `content`** → NO migration.
- **`saveTemplate`** (commsops `src/index.js:249`) stores `content` verbatim, bumps `version` on edit → storing the new `content` keys needs **zero worker change**.
- **`sendTest`** (commsops `src/index.js:274`) accepts in-memory `template:{content,variables}` → in-editor test-send reuses it.
- **workerFetch** sends flat `{action, ...body}` (verified `packages/db/workerFetch.js`) → commsops reads `body.file_name` (FLAT — commsops convention; do NOT nest under `data`, that's a lotopsproxy-only pattern).
- **Proven browser upload path** (Garage `apps/garage/.../library/parts/page.js:205`): `supabase.storage.from(bucket).uploadToSignedUrl(storage_path, token, file)` using the shared client `import { supabase } from '@throttle/db'` (verified exported). **Do NOT hand-roll a `fetch` PUT.**
- **Unsubscribe:** `send.js` always mints `sys.unsubscribe_url` and the email adapter always sets the `List-Unsubscribe` **header** for marketing (compliance floor met even without a body link); the visible in-body link requires the template to contain `{unsubscribe_url}`.
- **commsops auth** (`src/auth.js`): `sbComms`, `canTemplate` (=`template_manage`), `canBuild` (=`campaign_build`), service-role headers via `SUPABASE_SERVICE_ROLE_KEY`. Worker `type: commonjs`; POST routes on `body.action`.
- **relay app:** npm workspaces, root `package-lock.json`; global CSS `globals.css`+`redesign.css` in `layout.js`; `@/` alias → `src/`; root layout has NO auth gate (that's `(auth)/layout.js`). **No `type:module`** → app `.js` files are ESM only via webpack, NOT runnable under `node --test`.
- **Build:** `npx turbo build --filter=relay` (from `05_Throttle/`); relay auto-deploys on push to `main`. commsops: `cd 05_Throttle/commsops-worker && npx wrangler deploy`.

## Testing approach (read before starting)

- **`node --test`** ONLY for the commsops storage helper (Task 3) — worker is CommonJS with a real harness (`commsops-worker/test/*.test.js`).
- **NO app-side `node --test`** — the relay app is ESM-in-a-non-module-package; `.js` files can't run under `node --test` and we are NOT adding jest/vitest. App logic is verified by **build-green** + **browser smoke** (the spec's real acceptance test). `htmlToPlain` is simple string ops verified via the browser test-send.
- **Build-green gate** (`npx turbo build --filter=relay`, zero errors) closes every front-end task that adds an imported module.
- **Live dev-server verification** using the proven spike pattern (preview `relay` launch config already added → `http://localhost:3010`) for the merge-tag insert (Task 7) and the final smoke (Task 10). Authenticated Google-login flows are Afshaan's.

---

## File structure

**commsops-worker:** `src/email-assets.js` (pure `assetPath`+`signToUrls`) + `test/email-assets.test.js`; modify `src/index.js` (`createEmailAssetUploadUrl`).
**Supabase:** public bucket `relay-email-assets`.
**relay app:** `src/components/email-editor/{htmlToPlain.js, exportEmail.js, blankScaffold.js, mergeTags.js, EmailEditor.js}`; modify `src/app/(auth)/templates/page.js`; deps in `package.json`.

---

## Task 1: Commit the (already-installed, spike-proven) editor deps

**Files:** `apps/relay/package.json`, `package-lock.json` (already modified by the spike install).

- [ ] **Step 1: Confirm the deps are present and pinned**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git status --short   # expect: M apps/relay/package.json, M package-lock.json
grep -E 'grapesjs|mjml-browser' apps/relay/package.json
```
Expected: `grapesjs`, `grapesjs-mjml`, `mjml-browser` present in `apps/relay/package.json`.

- [ ] **Step 2: Confirm the build still passes (sanity)**

```bash
npx turbo build --filter=relay
```
Expected: zero errors (already proven in the spike; this is a clean-tree re-check).

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add apps/relay/package.json package-lock.json
git -C 05_Throttle commit -m "relay: add grapesjs + grapesjs-mjml + mjml-browser for email authoring v1 (spike-proven)"
```

---

## Task 2: Create the `relay-email-assets` public storage bucket

**Files:** none (Supabase via SQL).

- [ ] **Step 1: Create the bucket (idempotent)** — via `execute_sql` on `jkxcnjabmrkteanzoofj`:

```sql
insert into storage.buckets (id, name, public)
values ('relay-email-assets', 'relay-email-assets', true)
on conflict (id) do update set public = true;
```

- [ ] **Step 2: Verify**

```sql
select id, name, public from storage.buckets where id = 'relay-email-assets';
```
Expected: one row, `public = true`.

---

## Task 3: commsops storage helpers (pure) — TDD

**Files:** Create `commsops-worker/src/email-assets.js`; Test `commsops-worker/test/email-assets.test.js`.

> The client uploads via `uploadToSignedUrl(storage_path, token, file)`, so the worker returns `{storage_path, token, public_url}` (NO hand-built upload URL).

- [ ] **Step 1: Write the failing test** — create `commsops-worker/test/email-assets.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { assetPath, signToUrls } = require('../src/email-assets.js');

test('assetPath sanitizes filename, keeps extension, namespaces under email/', () => {
  assert.strictEqual(assetPath('My Logo (final).PNG', 1700000000000), 'email/1700000000000_my-logo-final-.png');
});
test('assetPath falls back to upload when empty', () => {
  assert.strictEqual(assetPath('', 1700000000000), 'email/1700000000000_upload');
});
test('assetPath strips path separators (no traversal)', () => {
  assert.strictEqual(assetPath('../../etc/passwd', 1700000000000), 'email/1700000000000_passwd');
});
test('signToUrls extracts the token and builds the public URL', () => {
  const env = { SUPABASE_URL: 'https://x.supabase.co' };
  const out = signToUrls(env, 'relay-email-assets', 'email/1_a.png',
    { url: '/object/upload/sign/relay-email-assets/email/1_a.png?token=abc.def' });
  assert.strictEqual(out.storage_path, 'email/1_a.png');
  assert.strictEqual(out.token, 'abc.def');
  assert.strictEqual(out.public_url, 'https://x.supabase.co/storage/v1/object/public/relay-email-assets/email/1_a.png');
});
test('signToUrls returns null token when absent', () => {
  const out = signToUrls({ SUPABASE_URL: 'https://x.supabase.co' }, 'relay-email-assets', 'email/1_a.png', { url: '/nope' });
  assert.strictEqual(out.token, null);
});
```

Note: `assetPath('../../etc/passwd')` → the basename after splitting on `/` is `passwd` → `email/…_passwd` (traversal segments dropped by taking the last path segment).

- [ ] **Step 2: Run to verify it fails** — from `commsops-worker/`:
```bash
node --test test/email-assets.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `commsops-worker/src/email-assets.js`:

```js
// Pure helpers for the relay-email-assets image bucket. No I/O — unit-testable.
function safeSeg(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'upload';
}
function assetPath(fileName, nowMs) {
  return `email/${nowMs}_${safeSeg(fileName)}`;
}
// Client uploads with supabase.storage.uploadToSignedUrl(storage_path, token, file),
// so we return storage_path + token + the public URL for the asset manager.
function signToUrls(env, bucket, path, signData) {
  const rel = String(signData?.url || '');
  const m = rel.match(/token=([^&]+)/);
  return {
    storage_path: path,
    token: m ? decodeURIComponent(m[1]) : null,
    public_url: `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`,
  };
}
module.exports = { safeSeg, assetPath, signToUrls };
```

- [ ] **Step 4: Run to verify it passes** — from `commsops-worker/`:
```bash
node --test test/email-assets.test.js
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**
```bash
git -C 05_Throttle add commsops-worker/src/email-assets.js commsops-worker/test/email-assets.test.js
git -C 05_Throttle commit -m "relay(commsops): pure email-assets path + signed-url helpers + tests"
```

---

## Task 4: commsops `createEmailAssetUploadUrl` action + deploy

**Files:** Modify `commsops-worker/src/index.js`.

- [ ] **Step 1: Require the helper** — near the other requires (~line 15), add:
```js
const EA = require('./email-assets.js');
```

- [ ] **Step 2: Add the POST action** — immediately after `case 'saveTemplate': { ... }` (ends ~line 272):
```js
    case 'createEmailAssetUploadUrl': {   // email authoring v1 — signed upload into the public relay-email-assets bucket
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const fileName = body.file_name;
      if (!fileName) return err('file_name_required', 400);
      const bucket = 'relay-email-assets';
      const path = EA.assetPath(fileName, Date.now());
      const sr = await fetch(`${env.SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${enc2(path)}`, {
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

Where `enc2` encodes each path segment but preserves `/` (define it once near the top of `index.js` if not present):
```js
const enc2 = (p) => String(p).split('/').map(encodeURIComponent).join('/');
```

- [ ] **Step 3: Dry-run the bundle** — from `commsops-worker/`:
```bash
npx wrangler deploy --dry-run
```
Expected: bundles, no errors.

- [ ] **Step 4: Commit, push, deploy**
```bash
git -C 05_Throttle add commsops-worker/src/index.js
git -C 05_Throttle commit -m "relay(commsops): createEmailAssetUploadUrl — signed upload into relay-email-assets"
git -C 05_Throttle push
cd 05_Throttle/commsops-worker && npx wrangler deploy
```
Expected: deploy succeeds; record the version id.

- [ ] **Step 5: Confirm the route is wired** (full auth'd upload is smoked in Task 10):
```bash
curl -s -X POST https://commsops.afshaan.workers.dev/?action=createEmailAssetUploadUrl -H 'Content-Type: application/json' -d '{"action":"createEmailAssetUploadUrl","file_name":"x.png"}' | head -c 200
```
Expected: an auth/forbidden error (NOT `Unknown action`).

---

## Task 5: Plaintext deriver (pure, ESM — verified via build + browser)

**Files:** Create `apps/relay/src/components/email-editor/htmlToPlain.js`.

> Auto-strip is the v1 decision (spec §9). ESM to match the app; NO `node --test` (app has no harness) — verified by the Task 10 test-send arriving with sane plaintext.

- [ ] **Step 1: Create the module**
```js
// Derive a plaintext fallback from compiled email HTML. Pure string ops (no DOM).
const BLOCK = /<\/(p|div|h[1-6]|tr|table|li|ul|ol|section|header|footer)\s*>|<br\s*\/?>/gi;
export function htmlToPlain(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(BLOCK, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n');
  return s.trim();
}
```

- [ ] **Step 2: Commit**
```bash
git -C 05_Throttle add "apps/relay/src/components/email-editor/htmlToPlain.js"
git -C 05_Throttle commit -m "relay: htmlToPlain email plaintext deriver"
```

---

## Task 6: MJML export helper + blank scaffold

**Files:** Create `exportEmail.js` + `blankScaffold.js` under `apps/relay/src/components/email-editor/`.

- [ ] **Step 1: exportEmail.js**
```js
// grapesjs-mjml keeps the canvas as MJML components (proven: editor.getHtml() -> MJML),
// compiled to responsive HTML with mjml-browser directly (no plugin-internal command).
import mjml2html from 'mjml-browser';
import { htmlToPlain } from './htmlToPlain.js';

export function exportEmail(editor) {
  const mjml = editor.getHtml();
  const compile = mjml2html.default || mjml2html;
  const { html, errors } = compile(mjml, { validationLevel: 'soft', minify: false });
  if (errors && errors.length) console.warn('[email-editor] MJML warnings', errors);
  return {
    mjml,
    html: html || '',
    text: htmlToPlain(html || ''),
    design: editor.getProjectData(),
  };
}
```

- [ ] **Step 2: blankScaffold.js**
```js
// Loaded for create-from-scratch, and for re-editing a legacy template with no
// design_json (its stored html_body still SENDS fine — only visual re-edit needs a rebuild).
export const BLANK_MJML = `<mjml>
  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="20px" font-weight="700" color="#282828">Heading</mj-text>
        <mj-text font-size="14px" line-height="1.6" color="#282828">Write your email here. Insert merge tags from the toolbar above.</mj-text>
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
git -C 05_Throttle commit -m "relay: email-editor MJML export helper + branded blank scaffold"
```

---

## Task 7: Merge-tag inserter (robust: chip strip above the canvas + clipboard fallback)

**Files:** Create `apps/relay/src/components/email-editor/mergeTags.js`.

> The GrapesJS in-cursor RTE API was NOT spiked, so v1 uses a mechanism we're confident in: a chip strip rendered by the parent (Task 8/9) that inserts into the currently-selected text component, falling back to clipboard copy. This helper holds the pure insert logic so it can be reasoned about in isolation.

- [ ] **Step 1: Create the helper**
```js
// Insert a {token} into the editor. Preferred: append to the selected text component's
// content. Fallback: copy to clipboard so the author can paste into any text block.
// Returns 'inserted' | 'copied' | 'noop'.
export async function insertMergeTag(editor, token) {
  if (!editor || !token) return 'noop';
  const tag = `{${token}}`;
  const sel = editor.getSelected();
  // grapesjs-mjml text components are editable text types; append to their content.
  if (sel && (sel.is && (sel.is('mj-text') || sel.is('mj-button') || sel.is('text')))) {
    const cur = sel.get('content') || '';
    sel.set('content', `${cur}${tag}`);
    editor.trigger('change:canvasOffset'); // nudge canvas refresh
    return 'inserted';
  }
  try { await navigator.clipboard.writeText(tag); return 'copied'; }
  catch { return 'noop'; }
}
```

- [ ] **Step 2: Live-verify the insert path** (uses the proven spike pattern — do this during execution, not as a guess): with the editor mounted (Task 8 done), run the dev server (`preview_start name:relay` → `localhost:3010/templates`), select a text block, click a chip, and confirm `{token}` appears in the block and in the exported HTML. If `sel.set('content', …)` does not visually update mid-edit, the clipboard fallback still ships a usable feature; note the finding and refine.

- [ ] **Step 3: Commit**
```bash
git -C 05_Throttle add "apps/relay/src/components/email-editor/mergeTags.js"
git -C 05_Throttle commit -m "relay: email-editor merge-tag insert helper (selected-component insert + clipboard fallback)"
```

---

## Task 8: The `EmailEditor` client component

**Files:** Create `apps/relay/src/components/email-editor/EmailEditor.js`.

- [ ] **Step 1: Write the component**
```js
'use client';
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import grapesjs from 'grapesjs';
import grapesjsMjml from 'grapesjs-mjml';
import 'grapesjs/dist/css/grapes.min.css';
import { supabase, workerFetch } from '@throttle/db';
import { exportEmail } from './exportEmail.js';
import { BLANK_MJML } from './blankScaffold.js';

const BUCKET = 'relay-email-assets';
const MAX_BYTES = 5 * 1024 * 1024;

// Uploads a File via the commsops signed-URL action + the proven uploadToSignedUrl path.
async function uploadAsset(file, session) {
  if (!file.type || !file.type.startsWith('image/')) throw new Error('not an image');
  if (file.size > MAX_BYTES) throw new Error('image too large (max 5MB)');
  const r = await workerFetch('createEmailAssetUploadUrl', { file_name: file.name, mime_type: file.type }, session);
  const d = r?.data;
  if (!d?.token || !d?.storage_path) throw new Error(r?.error || 'sign failed');
  const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(d.storage_path, d.token, file);
  if (up.error) throw up.error;
  return d.public_url;
}

// Props: initialDesign (content.design_json | null), session, canEdit.
// Ref: export() -> {mjml,html,text,design}; setDevice(name); getEditor().
const EmailEditor = forwardRef(function EmailEditor({ initialDesign, session, canEdit }, ref) {
  const holderRef = useRef(null);
  const edRef = useRef(null);

  useImperativeHandle(ref, () => ({
    export: () => (edRef.current ? exportEmail(edRef.current) : { mjml: '', html: '', text: '', design: null }),
    setDevice: (name) => { if (edRef.current) edRef.current.setDevice(name); },
    getEditor: () => edRef.current,
  }), []);

  useEffect(() => {
    if (!holderRef.current) return undefined;
    const editor = grapesjs.init({
      container: holderRef.current,
      height: '640px',
      fromElement: false,
      storageManager: false,
      plugins: [grapesjsMjml],          // proven form — no pluginsOpts
      assetManager: {
        uploadFile: async (e) => {
          const files = e.dataTransfer ? e.dataTransfer.files : e.target.files;
          for (const f of files) {
            try { editor.AssetManager.add(await uploadAsset(f, session)); }
            catch (err) { console.error('[email-editor] upload', err && err.message || err); }
          }
        },
      },
    });
    if (initialDesign && Object.keys(initialDesign).length) editor.loadProjectData(initialDesign);
    else editor.setComponents(BLANK_MJML);
    edRef.current = editor;
    return () => { try { editor.destroy(); } catch (_) {} edRef.current = null; };
    // Init once per mount; the parent controls remounts via a stable editorKey (NOT template id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={holderRef} className="email-gjs" />;
});

export default EmailEditor;
```

- [ ] **Step 2: Build-green** — this file is imported in Task 9, so its build check lives there. Here, just lint-read it for obvious errors (the real compile happens in Task 9 Step 8).

- [ ] **Step 3: Commit**
```bash
git -C 05_Throttle add "apps/relay/src/components/email-editor/EmailEditor.js"
git -C 05_Throttle commit -m "relay: EmailEditor GrapesJS+MJML client component (image upload, load/export, device preview)"
```

---

## Task 9: Wire the editor into `/templates`

**Files:** Modify `apps/relay/src/app/(auth)/templates/page.js` + append CSS to `apps/relay/src/app/globals.css`.

- [ ] **Step 1: Imports + dynamic editor + merge-tag helper**

At the top of `page.js`, after existing imports, add:
```js
import dynamic from 'next/dynamic';
import { useRef } from 'react';
import { htmlToPlain } from '@/components/email-editor/htmlToPlain.js';
import { insertMergeTag } from '@/components/email-editor/mergeTags.js';

const EmailEditor = dynamic(() => import('@/components/email-editor/EmailEditor.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });
```

- [ ] **Step 2: State — design_json + a STABLE editorKey (fixes the save-blank remount)**

In `emptyTemplate()` add `design_json: null`. In `startEdit(r)` add `design_json: c.design_json || null` to the `setT({...})`. Add refs/state near the other `useState`s:
```js
  const edRef = useRef(null);
  const [editorKey, setEditorKey] = useState('new');   // changes only when a DIFFERENT template is opened
```
In `startNew()` set `setEditorKey('new-' + Date.now());` and in `startEdit(r)` set `setEditorKey('t-' + r.id);` — so opening another template remounts the editor, but **saving does not** (id changes don't touch editorKey).

- [ ] **Step 3: Clean buildPayload (email pulls compiled content from the live editor)**
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
    let content;
    if (t.channel === 'email' && edRef.current) {
      const ex = edRef.current.export();   // {mjml, html, text, design}
      content = { subject: t.subject, html_body: ex.html, text_body: ex.text || htmlToPlain(ex.html), design_json: ex.design };
    } else {
      content = { subject: t.subject, html_body: t.html_body, text_body: t.text_body, design_json: t.design_json || null };
    }
    return {
      channel: t.channel, name: t.name.trim(), purpose: t.purpose, language: t.language || 'en',
      status: t.status, content, variables,
    };
  }
```

- [ ] **Step 4: save() — persist design_json back into state (so a post-save remount, if any, reloads the real design) + unsubscribe lint**
```js
  async function save() {
    if (!t.name.trim()) { showToast('Name required', 'error'); return; }
    const payload = buildPayload();
    if (t.channel === 'email' && t.purpose === 'marketing'
        && !(payload.content.html_body || '').includes('{unsubscribe_url}')) {
      showToast('Marketing emails should include {unsubscribe_url} in the footer', 'error');
      // warn-only: do not block (List-Unsubscribe header is still set server-side)
    }
    setSaving(true);
    try {
      if (t.id) payload.id = t.id;
      const r = await workerFetch('saveTemplate', payload, session);
      const saved = r?.data;
      set('design_json', payload.content.design_json || null);
      showToast(t.id ? 'Template saved (new version)' : 'Template created', 'success');
      if (saved?.id && !t.id) set('id', saved.id);
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }
```

- [ ] **Step 5: Replace the Content panel for email** — swap the existing `<Panel title="Content" pad> … </Panel>` block for:
```jsx
        <Panel title="Content" pad
          action={t.channel === 'email' ? (
            <span style={{ display: 'flex', gap: 6 }}>
              <Btn onClick={() => edRef.current && edRef.current.setDevice('Desktop')}>Desktop</Btn>
              <Btn onClick={() => edRef.current && edRef.current.setDevice('Mobile portrait')}>Mobile</Btn>
            </span>
          ) : null}>
          <div className="ff" style={{ marginBottom: 14 }}>
            <div className="kv-k">Subject</div>
            <input className="f-inp" value={t.subject} onChange={(e) => set('subject', e.target.value)}
              placeholder="We miss you, {first} — 10% inside" disabled={saving || !canEdit} />
          </div>
          {t.channel === 'email' ? (
            <>
              {canEdit && t.variables.some((v) => v.token) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  <span className="dim" style={{ fontSize: 12, alignSelf: 'center' }}>Merge tags:</span>
                  {t.variables.filter((v) => v.token).map((v) => (
                    <button key={v.token} type="button" className="chip"
                      onClick={async () => {
                        const res = await insertMergeTag(edRef.current && edRef.current.getEditor(), v.token);
                        showToast(res === 'inserted' ? `Inserted {${v.token}}` : res === 'copied' ? `Copied {${v.token}} — paste into a text block` : 'Select a text block first', res === 'noop' ? 'error' : 'success');
                      }}>{`{${v.token}}`}</button>
                  ))}
                </div>
              )}
              <EmailEditor key={editorKey} ref={edRef} initialDesign={t.design_json} session={session} canEdit={canEdit} />
            </>
          ) : (
            <>
              <div className="ff" style={{ marginBottom: 14 }}><div className="kv-k">HTML body</div>
                <textarea className="f-inp mono" rows={12} value={t.html_body} onChange={(e) => set('html_body', e.target.value)} disabled={saving || !canEdit} />
              </div>
              <div className="ff"><div className="kv-k">Plain-text body</div>
                <textarea className="f-inp mono" rows={5} value={t.text_body} onChange={(e) => set('text_body', e.target.value)} disabled={saving || !canEdit} />
              </div>
            </>
          )}
          <div className="tw-note" style={{ marginTop: 10 }}>
            Insert <code>{'{token}'}</code> merge tags from the chips above (or type them). Marketing sends auto-expose <code>{'{unsubscribe_url}'}</code>.
          </div>
        </Panel>
```

- [ ] **Step 6: Test-send already uses buildPayload** — confirm `sendTest()` calls `buildPayload()` (it does) so the test email uses the freshly-compiled email content. No change beyond reading it.

- [ ] **Step 7: CSS** — append to `apps/relay/src/app/globals.css`:
```css
.email-gjs { border: 1px solid var(--border, #e5e5e5); border-radius: 8px; overflow: hidden; }
.email-gjs .gjs-cv-canvas { background: #f4f4f4; }
.chip { font-family: var(--mono, monospace); font-size: 12px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--surface, #fafafa); cursor: pointer; }
```

- [ ] **Step 8: Build-green gate** — from `05_Throttle/`:
```bash
npx turbo build --filter=relay
```
Expected: zero errors (this is the first real compile of EmailEditor.js).

- [ ] **Step 9: Commit**
```bash
git -C 05_Throttle add "apps/relay/src/app/(auth)/templates/page.js" apps/relay/src/app/globals.css
git -C 05_Throttle commit -m "relay: embed GrapesJS+MJML editor in /templates (subject + merge-tag chips + preview + export->save + design_json re-edit + unsubscribe lint)"
```

---

## Task 10: Build, push, and browser smoke

**Files:** none.

- [ ] **Step 1: Full build** — `npx turbo build --filter=relay` → zero errors.
- [ ] **Step 2: Push** — `git -C 05_Throttle push` (relay auto-deploys; commsops already deployed Task 4).
- [ ] **Step 3: Local dev-server smoke of the merge-tag insert (Task 7 Step 2)** — via `preview_start name:relay` → `localhost:3010/templates`. This route is auth-gated; if the local session can't authenticate, defer the interactive check to Step 4 and confirm the editor at least mounts (canvas + toolbar visible) on a public harness if needed.
- [ ] **Step 4: Authenticated smoke — HAND TO AFSHAAN (Google login):**
  1. `/templates` → New template (email) → canvas loads the branded scaffold; drag Text/Button/Image.
  2. Upload an image → it renders (served from `relay-email-assets`); confirm a >5MB or non-image file is rejected with a toast.
  3. Add variable `first` → click the `{first}` chip → inserts into the selected text block (or copies with a toast).
  4. Toggle Desktop/Mobile.
  5. Send test to `afshaan@legendoftoys.com` with `{"first":"Afshaan"}` → arrives responsive, `{first}` resolved, unsubscribe link present, plaintext sane. (TEST MODE ON.)
  6. Save → reopen → canvas reloads from `design_json` (re-editable); `content.html_body` is the compiled MJML.
  7. Save WITHOUT a footer `{unsubscribe_url}` on a marketing template → the warn toast fires (send still allowed; header covers compliance).
  8. Open a legacy raw template → opens on the blank scaffold (no design_json); its html_body still sends. Confirm acceptable.
- [ ] **Step 5: Report** — commsops version id, relay deploy status, smoke results; note deferrals (starter library; WhatsApp/commerce blocks Phase 2; no asset-delete path; merge tags insert into text components only).

---

## Task 11: Knowledge-file updates (session-wrap)

**Files:** `systems/relay.md`, `BACKLOG.md`.

- [ ] **Step 1: `systems/relay.md`** — add "Email authoring v1 (GrapesJS+MJML) LIVE": editor in `/templates`, `content.design_json` (re-edit) + `content.html_body` (send artifact), `relay-email-assets` public bucket + `createEmailAssetUploadUrl`, plaintext auto-derived, merge-tag chips bound to `variables`, send/gate/TEST MODE unchanged. **Correct the versioning language:** templates are a single row with a version COUNTER (no per-version content snapshot) — editing a template changes what all future sends (incl. in-flight journeys) use at next send; only journeys pin versions. Bump `Last updated`.
- [ ] **Step 2: `BACKLOG.md`** — move `[relay] Email authoring v1` from `[ ]` to `[~]` shipped (browser smoke = Afshaan); add fast-follows: curated LOT-branded starter library; WhatsApp visual builder + commerce blocks (Phase 2); optional asset-delete/cleanup; merge-tag in-cursor insert refinement.
- [ ] **Step 3: Commit + push** (root repo).

---

## Self-review (v2, against spec + review findings)

- **Spec coverage:** editor (T8–9), MJML export (T6, spike-proven), blocks = grapesjs-mjml defaults (branded Logo/Header/Footer blocks explicitly deferred to starter-library), merge tags (T7/T9, robust w/ fallback), preview (T9 S5), test-send (T9 S6), image upload → our bucket w/ guards (T3/T4/T8), design_json no-migration (T2 none), composer unchanged, saved/create-from-scratch (existing list + editorKey). Starter library deferred per cut line.
- **Review findings folded:** C1/C2 proven (spike block); C3 uploadToSignedUrl + `{storage_path,token,public_url}`; C4 no app node-test (worker test kept); H1 stable `editorKey` + design_json write-back; H2 clean `buildPayload`; H3 `plugins:[grapesjsMjml]`; H4 build-green in T9 where the import lands; M1 chip strip + clipboard fallback + live-verify; M2 unsubscribe lint; M3 block-set note; M4 no fake readOnly (canEdit only hides Save); M5 CSS import proven; L1 versioning corrected in T11; L3 image type/size guard; L4 no-delete-path noted.
- **Placeholder scan:** all code steps complete; no unspiked API asserted as certain (merge-tag insert has a guaranteed clipboard fallback + a live-verify step).
- **Type consistency:** `assetPath`/`signToUrls`→`{storage_path,token,public_url}` (T3) match the action (T4) and `uploadAsset` (T8); `export()`→`{mjml,html,text,design}` matches `buildPayload` (T9); `insertMergeTag(editor, token)` matches the chip onClick via `getEditor()` (T9); `htmlToPlain` consistent T5/T6/T9.
