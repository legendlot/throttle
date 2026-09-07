# Relay Flow Bots (WhatsApp + Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Pruthvi's MVP WhatsApp flow bot live in staff-pilot mode on the support number, and finish the web bot's residuals, both on the one existing Relay engine with a shared FAQ sub-flow.

**Architecture:** The pure engine `bot-engine.js` gains list menus, keyword routing, collect fallback, an attempt-cap handoff and a one-level `subflow` step implemented as effects. A new `bot-wa.js` ingress hooks into the existing WhatsApp webhook before the Pitstop forward, sends through `send()`, and rides its replies on the forward so csops writes the transcript tagged `relay_bot` and drives a new `bot_active` thread rail. The builder UI on `/journeys?mode=bot` grows the new step options and an activate-gated pilot switch.

**Tech Stack:** Cloudflare Workers (CommonJS in commsops, ESM in csops), Supabase/PostgREST via `A.sbComms`/`A.sbStore`, Next.js 14 apps on gh-pages, Node `assert` tests run as plain scripts (commsops) and `node --test` `.mjs` (csops).

**Spec:** `05_Throttle/docs/superpowers/specs/2026-09-07-relay-flowbots-wa-web-design.md` (v2, hostile-reviewed). Read it before any task; every §-reference below points into it.

## Global Constraints

- Repo: `/Users/afshaansiddiqui/Documents/Claude/05_Throttle` (`legendlot/throttle`). Always `git -C` / absolute paths; **path-scoped `git add`**, never `-A`; check `git diff --cached --stat` before every commit.
- commsops tests: `cd 05_Throttle/commsops-worker && node test/<file>.test.js` (top-level `assert`, exits non-zero on failure). Full suite: `for f in test/*.test.js; do node "$f" >/dev/null 2>&1 || echo "RED: $f"; done` — must print nothing.
- csops tests: `cd 05_Throttle/csops-worker && node --test 'src/**/*.test.mjs'` — read the `fail` line.
- DB writes go through the Supabase MCP (`apply_migration` for DDL, project `jkxcnjabmrkteanzoofj`); `grep reference/db-schema.md` before any SQL; every migration that creates/alters a table the worker reads ends with `NOTIFY pgrst, 'reload schema';`.
- **Enum-ish CHECKs are widened in the same migration** as the value they must accept: `comms.bots.channel` (`= 'web'` today) and `store.cs_wa_threads.closed_reason` (nine values today).
- Deploy sequence per worker: edit → commit → **push (must succeed)** → `cd <worker-dir> && npx wrangler deploy`. Never deploy off an unpushed branch. Never `npx --prefix`.
- Apps: gh-pages via Actions; verify with `tools/wait-deploy.sh <app> <sha>` run ALONE in background and read its `VERDICT:` line.
- The web widget gate `if (!staff) return;` at `commsops-worker/src/bot-widget.js:18` is **not touched**.
- `bots.config.mode` / `pilot_numbers` are written ONLY by `setBotMode` (activate tier). Default mode is `pilot`.
- Bot outbound rows in `store.cs_wa_messages` ALWAYS carry `template_name='relay_bot'`, `sent_by_user_id NULL`, `sent_by_name='Relay (bot)'`; every row in a bulk insert carries the SAME key set.
- Wire ids on WhatsApp are `bot:<step_id>:<handle>`; `wa-webhooks.js` never emits `whatsapp_reply` for them.
- Nothing in this plan sends a Slack message; the reply to Pruthvi is drafted for Afshaan's go (Task 15).

---

## File map

| File | Responsibility |
|---|---|
| `commsops-worker/migrations/0068_comms_bots_channels.sql` | CHECK widen, session/frame/claim columns, indexes |
| `commsops-worker/src/bot-engine.js` | pure engine: list menus, keywords, collect fallback, cap→handoff, subflow effects, resume/expire, channel lint |
| `commsops-worker/src/journey-graph.js` | `HANDLES.collect` + `HANDLES.subflow` |
| `commsops-worker/src/bot-turn.js` (new) | channel-neutral effect loop: order lookups, subflow enter/return, def loading |
| `commsops-worker/src/bot-web.js` | uses bot-turn; resume support |
| `commsops-worker/src/bot-widget.js` | localStorage resume, list rendering |
| `commsops-worker/src/bot-wa.js` (new) | WhatsApp ingress: engage conditions, sessions, claim, send, forward payload |
| `commsops-worker/src/wa-webhooks.js` | hook + no `whatsapp_reply` for `bot:` ids |
| `commsops-worker/src/render.js`, `adapters/whatsapp.js`, `send.js`, `gate.js` | `list` mode at all four sites |
| `commsops-worker/src/bots.js`, `src/index.js` | `validateBotDef` options, `setBotMode`, `saveBot` strip, `/web/session` resume |
| `csops-worker/src/bot-forward.js` (new) | pure: bot rows + thread patch for a forwarded turn |
| `csops-worker/src/index.js` | relay-wa bot handling, relay-web tag + email handle, awaiting/stats/sweep exclusions |
| csops migration `cs_threads_bot_active_v1` (MCP) | `bot_active`, `closed_reason` widen, clear-on-human trigger |
| `apps/pitstop/src/app/(auth)/inbox/page.js` | Bot badge on `ThreadRow` |
| `apps/relay/src/components/journey-canvas/{JourneyCanvas,BotDrawer,graph,labels}.js`, `bot-builder/BotBuilder.js` | palette, drawers, settings, lint mirror, test panel sub-flow follow |

---

### Task 1: Migration 0068 — channels, frames, claims

**Files:**
- Create: `commsops-worker/migrations/0068_comms_bots_channels.sql`

**Interfaces:**
- Produces: `comms.bots.channel ∈ web|whatsapp|shared`; `comms.bot_sessions.{channel, wa_from, phone_number_id, sub_bot_id, sub_version, return_step}`; `comms.bot_session_steps.provider_message_id` (unique when not null); partial unique index on active WhatsApp sessions.

- [ ] **Step 1: Write the migration file**

```sql
-- 0068_comms_bots_channels.sql — S355 (spec 2026-09-07-relay-flowbots-wa-web-design.md §5.2)
-- bots.channel was CHECK (channel = 'web'); the first whatsapp/shared insert would 23514.
ALTER TABLE comms.bots DROP CONSTRAINT IF EXISTS bots_channel_check;
ALTER TABLE comms.bots ADD CONSTRAINT bots_channel_check CHECK (channel IN ('web','whatsapp','shared'));

ALTER TABLE comms.bot_sessions
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS wa_from text,
  ADD COLUMN IF NOT EXISTS phone_number_id text,
  ADD COLUMN IF NOT EXISTS sub_bot_id uuid REFERENCES comms.bots(id),
  ADD COLUMN IF NOT EXISTS sub_version integer,
  ADD COLUMN IF NOT EXISTS return_step text;
ALTER TABLE comms.bot_sessions DROP CONSTRAINT IF EXISTS bot_sessions_channel_check;
ALTER TABLE comms.bot_sessions ADD CONSTRAINT bot_sessions_channel_check CHECK (channel IN ('web','whatsapp'));
-- one live WhatsApp session per (customer, business number)
CREATE UNIQUE INDEX IF NOT EXISTS bot_sessions_wa_active_uq
  ON comms.bot_sessions (wa_from, phone_number_id)
  WHERE channel = 'whatsapp' AND status = 'active';

-- per-inbound-message claim: Meta redelivery / concurrent invocations must not double-advance
ALTER TABLE comms.bot_session_steps ADD COLUMN IF NOT EXISTS provider_message_id text;
CREATE UNIQUE INDEX IF NOT EXISTS bot_session_steps_pmid_uq
  ON comms.bot_session_steps (provider_message_id) WHERE provider_message_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply it via the Supabase MCP**

`apply_migration` with name `comms_bots_channels_0068` and the SQL above. Expected: success, no error.

- [ ] **Step 3: Verify live**

Run via `execute_sql`:
```sql
select pg_get_constraintdef(oid) from pg_constraint where conname='bots_channel_check';
select column_name from information_schema.columns where table_schema='comms' and table_name='bot_sessions' and column_name in ('channel','wa_from','phone_number_id','sub_bot_id','sub_version','return_step');
select indexname from pg_indexes where schemaname='comms' and indexname in ('bot_sessions_wa_active_uq','bot_session_steps_pmid_uq');
```
Expected: the CHECK reads `channel = ANY (ARRAY['web','whatsapp','shared'])`; 6 columns; 2 indexes.

- [ ] **Step 4: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/migrations/0068_comms_bots_channels.sql
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: migration 0068 — bots.channel CHECK widened (web|whatsapp|shared), bot_sessions channel/wa identity/sub-flow frame, per-message claim on bot_session_steps"
```

---

### Task 2: Engine — list-style menus

**Files:**
- Modify: `commsops-worker/src/bot-engine.js:18-21` (`renderStep`)
- Test: `commsops-worker/test/bot-engine.test.js` (append)

**Interfaces:**
- Produces: `renderStep(menu)` → `{ text, style: 'buttons'|'list', list_button, buttons: [{id, label, description}] }`. Consumers (Tasks 8, 9, 12) read `style` and `description`.

- [ ] **Step 1: Append the failing test**

```js
// ── S355: list-style menu renders rows with descriptions ──
{
  const LDEF = { entry: 'm', steps: {
    m: { type: 'menu', style: 'list', list_button: 'Topics', text: 'Pick a topic',
         buttons: [{ id: 'b_ship', label: 'Shipping', description: 'How long delivery takes' }, { id: 'b_war', label: 'Warranty' }],
         outcomes: { b_ship: 'e', b_war: 'e', fallback: 'e' } },
    e: { type: 'end', outcomes: {} },
  } };
  const r = E.advance(LDEF, fresh(), { kind: 'open' });
  assert.equal(r.replies[0].style, 'list');
  assert.equal(r.replies[0].list_button, 'Topics');
  assert.deepEqual(r.replies[0].buttons[0], { id: 'b_ship', label: 'Shipping', description: 'How long delivery takes' });
  assert.equal(r.replies[0].buttons[1].description, null);
  // default style is buttons, list_button null
  const BDEF = { entry: 'm', steps: { m: { type: 'menu', text: 'x', buttons: [{ id: 'a', label: 'A' }], outcomes: { a: 'e', fallback: 'e' } }, e: { type: 'end', outcomes: {} } } };
  assert.equal(E.advance(BDEF, fresh(), { kind: 'open' }).replies[0].style, 'buttons');
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/commsops-worker && node test/bot-engine.test.js`
Expected: AssertionError on `style` (`undefined !== 'list'`).

- [ ] **Step 3: Implement `renderStep`**

Replace lines 18-21 with:
```js
function renderStep(step) {
  if (step.type === 'menu') {
    return {
      text: step.text,
      style: step.style === 'list' ? 'list' : 'buttons',
      list_button: step.style === 'list' ? (step.list_button || 'Choose') : null,
      buttons: step.buttons.map((b) => ({ id: b.id, label: b.label, description: b.description || null })),
    };
  }
  return { text: step.text || step.prompt || '' };
}
```

- [ ] **Step 4: Run tests**

Run: `node test/bot-engine.test.js` — Expected: exits 0, no output. Also `node test/bot-order-status.test.js` — exit 0.

- [ ] **Step 5: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/bot-engine.js commsops-worker/test/bot-engine.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: bot engine — menu.style list with row descriptions (spec §3.1)"
```

---

### Task 3: Engine — keywords on the first message, collect fallback + miss cap

**Files:**
- Modify: `commsops-worker/src/bot-engine.js` (`advance`, new `matchKeyword`), `commsops-worker/src/journey-graph.js:~8` (`HANDLES`)
- Test: `commsops-worker/test/bot-keywords.test.js` (new)

**Interfaces:**
- Consumes: `G.resolveTarget(step, handle)`.
- Produces: `matchKeyword(def, text)` → step id | null (exported). `input.kind==='open'` accepts `text`. `collect` honours `outcomes.fallback` after `MAX_MENU_MISSES` failed validations; `state.context.collect_misses` counter.

- [ ] **Step 1: Check `HANDLES` in journey-graph.js**

Run: `grep -n "const HANDLES" -A 12 /Users/afshaansiddiqui/Documents/Claude/05_Throttle/commsops-worker/src/journey-graph.js`
Find the `collect` entry (bot mode). It reads `collect: ['next']` (or is absent and falls to `['next']`). Note the exact line for Step 4.

- [ ] **Step 2: Write the failing tests**

`commsops-worker/test/bot-keywords.test.js`:
```js
// S355 — keyword routing on the FIRST message and at a FAILED collect; collect fallback cap.
// Run: node test/bot-keywords.test.js
const assert = require('assert');
const E = require('../src/bot-engine.js');

const DEF = { entry: 'welcome', keywords: [
    { match: ['track', 'where is my order', 'status'], target: 'ask_order' },
    { match: ['agent', 'human'], target: 'handoff1' },
  ], steps: {
  welcome:   { type: 'menu', text: 'Hi! Pick one', buttons: [{ id: 'b_track', label: 'Track my order' }, { id: 'b_agent', label: 'Agent' }],
               outcomes: { b_track: 'ask_order', b_agent: 'handoff1', fallback: 'handoff1' } },
  ask_order: { type: 'collect', field: 'order_number', prompt: 'Order number?', outcomes: { next: 'status1', fallback: 'handoff1' } },
  status1:   { type: 'action', kind: 'order_status', outcomes: { found: 'done', not_found: 'handoff1' } },
  handoff1:  { type: 'handoff', outcomes: {} },
  done:      { type: 'end', outcomes: {} },
} };
const fresh = () => ({ current_step: null, status: 'active', context: {} });

// matchKeyword: case-insensitive, whole word / phrase, first rule wins
assert.equal(E.matchKeyword(DEF, 'Where IS my order please'), 'ask_order');
assert.equal(E.matchKeyword(DEF, 'I need a HUMAN'), 'handoff1');
assert.equal(E.matchKeyword(DEF, 'tracking'), null);            // 'track' is not a whole word here
assert.equal(E.matchKeyword(DEF, 'hi'), null);
assert.equal(E.matchKeyword({ steps: {} }, 'track'), null);      // no keywords declared

// open WITH text: keyword skips the greeting menu
let r = E.advance(DEF, fresh(), { kind: 'open', text: 'where is my order' });
assert.equal(r.state.current_step, 'ask_order');
assert.deepEqual(r.replies.map((x) => x.text), ['Order number?']);

// open with a non-keyword text or no text: greeting as before
r = E.advance(DEF, fresh(), { kind: 'open', text: 'hi' });
assert.equal(r.state.current_step, 'welcome');
r = E.advance(DEF, fresh(), { kind: 'open' });
assert.equal(r.state.current_step, 'welcome');

// keyword at a FAILED collect escapes; valid input ignores keywords
r = E.advance(DEF, { current_step: 'ask_order', status: 'active', context: {} }, { kind: 'text', text: 'agent' });
assert.equal(r.state.status, 'handed_off');
r = E.advance(DEF, { current_step: 'ask_order', status: 'active', context: {} }, { kind: 'text', text: '#LOT48622' });
assert.equal(r.state.current_step, 'status1');
assert.equal(r.state.context.order_number, '#LOT48622');

// collect miss cap: two non-keyword invalid inputs -> fallback (handoff)
let s = { current_step: 'ask_order', status: 'active', context: {} };
r = E.advance(DEF, s, { kind: 'text', text: 'zzz' });
assert.equal(r.state.current_step, 'ask_order'); assert.equal(r.state.context.collect_misses, 1);
r = E.advance(DEF, r.state, { kind: 'text', text: '' });     // media -> empty text counts as a miss
assert.equal(r.state.status, 'handed_off');

// keyword is NOT consulted at a menu — free text that is a keyword still counts as a miss
r = E.advance(DEF, { current_step: 'welcome', status: 'active', context: {} }, { kind: 'text', text: 'agent' });
assert.equal(r.state.current_step, 'welcome'); assert.equal(r.state.context.menu_misses, 1);

// lint: collect.fallback must be wired
const errs = E.validateBotDef({ entry: 'c', steps: { c: { type: 'collect', field: 'order_number', outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} } } });
assert.ok(errs.some((e) => e.code === 'fallback_unwired' && e.stepId === 'c'), JSON.stringify(errs));
// lint: keyword target must exist
const kerr = E.validateBotDef({ entry: 'e', keywords: [{ match: ['x'], target: 'nope' }], steps: { e: { type: 'end', outcomes: {} } } });
assert.ok(kerr.some((e) => e.code === 'keyword_target_missing'), JSON.stringify(kerr));
console.log('bot-keywords ok');
```

- [ ] **Step 3: Run to verify it fails**

Run: `node test/bot-keywords.test.js` — Expected: `TypeError: E.matchKeyword is not a function`.

- [ ] **Step 4: Implement**

In `journey-graph.js`, make the bot `collect` handle set `['next', 'fallback']` and add `subflow: ['next']` (Task 5 uses it) — edit the `HANDLES` object found in Step 1, e.g. `collect: ['next', 'fallback'], subflow: ['next'],`.

In `bot-engine.js`:

Add after `normPhone`:
```js
const MAX_KEYWORDS = 20;
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// First matching rule wins. Whole-word/phrase, case-insensitive. Checked ONLY on the opening
// message and at a FAILED collect (spec §3.3) — never at a menu, never on valid input.
function matchKeyword(def, text) {
  const rules = Array.isArray(def?.keywords) ? def.keywords.slice(0, MAX_KEYWORDS) : [];
  const t = String(text || '').toLowerCase();
  if (!t || !rules.length) return null;
  for (const r of rules) {
    for (const m of (r.match || [])) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(String(m).toLowerCase())}([^a-z0-9]|$)`);
      if (re.test(t)) return r.target || null;
    }
  }
  return null;
}
```

In `advance`, replace `if (input.kind === 'open') return walk(def, state, def.entry, replies, effects);` with:
```js
  if (input.kind === 'open') {
    const kw = matchKeyword(def, input.text);
    return walk(def, state, kw && def.steps[kw] ? kw : def.entry, replies, effects);
  }
```

Replace the `collect` branch with:
```js
  if (step.type === 'collect' && (input.kind === 'text' || input.kind === 'button')) {
    const raw = String(input.text || '').trim();
    let valid = true;
    if (step.field === 'phone_or_email') {
      const phone = PHONE_RE.test(raw) ? normPhone(raw) : null;
      const email = EMAIL_RE.test(raw) ? raw.toLowerCase() : null;
      if (!phone && !email) valid = false; else state.context.identity = phone ? { phone } : { email };
    } else if (step.field === 'order_number') {
      if (!ORDER_RE.test(raw)) valid = false;
      else state.context.order_number = `#${raw.replace(/^#/, '').toUpperCase()}`;
    } else { state.context[step.field] = raw; }
    if (valid) { state.context.collect_misses = 0; return walk(def, state, G.resolveTarget(step, 'next'), replies, effects); }
    // Invalid: a handoff/other keyword escapes first (spec §3.3b); then the miss cap (§3.4).
    const kw = matchKeyword(def, raw);
    if (kw && def.steps[kw]) return walk(def, state, kw, replies, effects);
    const misses = (state.context.collect_misses || 0) + 1;
    state.context.collect_misses = misses;
    if (misses >= MAX_MENU_MISSES) return walk(def, state, G.resolveTarget(step, 'fallback'), replies, effects);
    replies.push({ text: step.field === 'order_number'
      ? 'That does not look like an order number — it is on your confirmation, like #LOT48622.'
      : 'Please share a valid phone number or email so we can help.' });
    return { state, replies, effects };
  }
```

In `validateBotDef`, change the handles expression so `collect` yields `['next', 'fallback']`:
```js
    const handles = step.type === 'menu'
      ? [...(step.buttons || []).map((b) => b.id), 'fallback']
      : step.type === 'action' ? ['found', 'not_found']
      : step.type === 'collect' ? ['next', 'fallback']
      : (step.type === 'handoff' || step.type === 'end') ? []
      : ['next'];
```
and in the `!t` branch add `else if (step.type === 'collect' && h === 'fallback') errs.push({ code: 'fallback_unwired', stepId: id });` before the `dangling_target` fallthrough. After the step loop, before `return errs;`:
```js
  for (const [i, r] of (Array.isArray(def.keywords) ? def.keywords : []).entries()) {
    if (!r || !r.target || !def.steps[r.target]) errs.push({ code: 'keyword_target_missing', stepId: r?.target || `keyword_${i}` });
    if (!Array.isArray(r?.match) || !r.match.filter(Boolean).length) errs.push({ code: 'keyword_empty', stepId: `keyword_${i}` });
  }
```
Export `matchKeyword`.

- [ ] **Step 5: Run all bot tests**

Run: `node test/bot-keywords.test.js && node test/bot-engine.test.js && node test/bot-order-status.test.js && node test/journey-graph.test.js && node test/journeys-compile.test.js`
Expected: `bot-keywords ok`, all exit 0. ⚠️ If `bot-engine.test.js` fails on its existing "collect invalid → re-prompts" case, it is because the fixture's `ident` step has no `fallback` — that fixture stays valid because one miss still re-prompts; only the second miss walks `fallback` (null → walk emits nothing). Do not weaken the assertion; add `fallback: 'handoff1'` to the fixture's collect steps.

- [ ] **Step 6: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/bot-engine.js commsops-worker/src/journey-graph.js commsops-worker/test/bot-keywords.test.js commsops-worker/test/bot-engine.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: bot engine — keywords on the opening message + at a failed collect; collect fallback handle with a 2-miss cap (spec §3.3-3.4)"
```

---

### Task 4: Engine — order-attempt cap hands off; `expire` and `resume` inputs

**Files:**
- Modify: `commsops-worker/src/bot-engine.js` (`advance` action branch; new input kinds)
- Test: `commsops-worker/test/bot-engine.test.js` (append)

**Interfaces:**
- Produces: at `MAX_ORDER_ATTEMPTS` → reply `step.text_exhausted || HANDOFF_DEFAULT`, `status='handed_off'`, effect `{type:'handoff'}`. `input.kind==='expire'` → `status='ended'`, no replies. `input.kind==='resume'` with `from` → walks `resolveTarget(steps[from],'next')` (used by sub-flow return, Task 5).

- [ ] **Step 1: Append failing tests**

```js
// ── S355: attempt cap hands off (never "email support"); expire; resume ──
{
  const s = { current_step: 'status1', status: 'active', context: { order_attempts: E.MAX_ORDER_ATTEMPTS - 1, identity: { phone: '9876543210' }, order_number: '#LOT1' } };
  const r = E.advance(DEF, s, { kind: 'action_result', ok: false, data: {} });
  assert.equal(r.state.status, 'handed_off');
  assert.ok(r.effects.some((e) => e.type === 'handoff'));
  assert.ok(!/support@/.test(r.replies.map((x) => x.text).join(' ')));
  const DEF2 = JSON.parse(JSON.stringify(DEF)); DEF2.steps.status1.text_exhausted = 'Passing you to a person.';
  assert.equal(E.advance(DEF2, s, { kind: 'action_result', ok: false, data: {} }).replies[0].text, 'Passing you to a person.');
  // expire: ends silently
  const x = E.advance(DEF, { current_step: 'menu1', status: 'active', context: {} }, { kind: 'expire' });
  assert.equal(x.state.status, 'ended'); assert.equal(x.replies.length, 0);
  // resume from a step's next handle
  const y = E.advance(DEF, { current_step: 'welcome', status: 'active', context: {} }, { kind: 'resume', from: 'welcome' });
  assert.equal(y.state.current_step, 'ident');
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/bot-engine.test.js` — Expected: AssertionError `'ended' == 'handed_off'`.

- [ ] **Step 3: Implement**

Add near the top: `const HANDOFF_DEFAULT = 'Let me connect you to our support team — a human will reply right here as soon as one is available.';` and use it in the `handoff` branch of `walk` (replace the literal).

In `advance`, right after the `status !== 'active'` guard, add:
```js
  if (input.kind === 'expire') { state.status = 'ended'; return { state, replies, effects }; }
  if (input.kind === 'resume') {
    const from = def.steps[input.from];
    return walk(def, state, from ? G.resolveTarget(from, 'next') : def.entry, replies, effects);
  }
```
Replace the `attempts >= MAX_ORDER_ATTEMPTS` line with:
```js
    if (attempts >= MAX_ORDER_ATTEMPTS) {
      replies.push({ text: step.text_exhausted || HANDOFF_DEFAULT });
      state.status = 'handed_off'; effects.push({ type: 'handoff' });
      return { state, replies, effects };
    }
```
Export `HANDOFF_DEFAULT`.

- [ ] **Step 4: Run tests** — `node test/bot-engine.test.js && node test/bot-keywords.test.js` → exit 0.

- [ ] **Step 5: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/bot-engine.js commsops-worker/test/bot-engine.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: bot engine — order-attempt cap hands off (text_exhausted), expire + resume inputs (spec §3.5, §3.7)"
```

---

### Task 5: Engine — `subflow` step as effects, channel lint

**Files:**
- Modify: `commsops-worker/src/bot-engine.js` (`walk` subflow/end, `validateBotDef(def, opts)`)
- Test: `commsops-worker/test/bot-subflow.test.js` (new)

**Interfaces:**
- Produces: step `{type:'subflow', bot_id, outcomes:{next}}`. `walk` at a subflow: effect `{type:'subflow_enter', bot_id, return_step: <subflow step id>}` and returns. State carries `frame: {bot_id, version, return_step} | null`; when `state.frame` is set and an `end` step is reached: effect `{type:'subflow_return', return_step}`, `state.frame = null`, status stays `active`, returns (the route re-enters the parent with `{kind:'resume', from: return_step}`). `validateBotDef(def, { channel, isShared, sharedIds:Set })` adds the §3 lint codes: `subflow_target_invalid`, `shared_contains_subflow`, `wa_too_many_buttons`, `wa_button_label_long`, `wa_too_many_rows`, `wa_row_title_long`, `wa_row_description_long`, `wa_text_long`, `text_exhausted_long`.

- [ ] **Step 1: Write the failing tests**

`commsops-worker/test/bot-subflow.test.js`:
```js
// S355 — sub-flow enter/return as effects (spec §2), channel lint (spec §3).
// Run: node test/bot-subflow.test.js
const assert = require('assert');
const E = require('../src/bot-engine.js');
const FAQ_ID = '11111111-1111-1111-1111-111111111111';

const PARENT = { entry: 'menu', steps: {
  menu: { type: 'menu', text: 'Hi', buttons: [{ id: 'b_faq', label: 'FAQs' }, { id: 'b_agent', label: 'Agent' }],
          outcomes: { b_faq: 'faq', b_agent: 'h', fallback: 'h' } },
  faq:  { type: 'subflow', bot_id: FAQ_ID, outcomes: { next: 'menu' } },
  h:    { type: 'handoff', outcomes: {} },
} };
const SUB = { entry: 'list', steps: {
  list: { type: 'menu', style: 'list', text: 'Topics', buttons: [{ id: 'b_ship', label: 'Shipping' }], outcomes: { b_ship: 'a_ship', fallback: 'h' } },
  a_ship: { type: 'message', text: '3-5 days.', outcomes: { next: 'e' } },
  e: { type: 'end', outcomes: {} },
  h: { type: 'handoff', outcomes: {} },
} };
const fresh = () => ({ current_step: null, status: 'active', context: {}, frame: null });

// tap FAQs -> subflow_enter effect, no replies from the parent
let r = E.advance(PARENT, Object.assign(fresh(), { current_step: 'menu' }), { kind: 'button', buttonId: 'b_faq' });
assert.deepEqual(r.effects, [{ type: 'subflow_enter', bot_id: FAQ_ID, return_step: 'faq' }]);
assert.equal(r.replies.length, 0);
assert.equal(r.state.current_step, 'faq');

// route sets the frame and opens the sub-flow
let st = { ...r.state, frame: { bot_id: FAQ_ID, version: 1, return_step: 'faq' } };
r = E.advance(SUB, st, { kind: 'open' });
assert.equal(r.replies[0].style, 'list');
// pick a topic -> answer -> end -> subflow_return effect, frame cleared, still active
r = E.advance(SUB, r.state, { kind: 'button', buttonId: 'b_ship' });
assert.deepEqual(r.replies.map((x) => x.text), ['3-5 days.']);
assert.deepEqual(r.effects, [{ type: 'subflow_return', return_step: 'faq' }]);
assert.equal(r.state.frame, null); assert.equal(r.state.status, 'active');
// route resumes the parent from the subflow step's next -> greeting menu again
r = E.advance(PARENT, r.state, { kind: 'resume', from: 'faq' });
assert.equal(r.state.current_step, 'menu');

// handoff inside a sub-flow is terminal for the session
st = { current_step: 'list', status: 'active', context: {}, frame: { bot_id: FAQ_ID, version: 1, return_step: 'faq' } };
r = E.advance(SUB, st, { kind: 'text', text: 'x' }); r = E.advance(SUB, r.state, { kind: 'text', text: 'y' });
assert.equal(r.state.status, 'handed_off');

// an end WITHOUT a frame still ends the session
r = E.advance(SUB, { current_step: 'a_ship', status: 'active', context: {}, frame: null }, { kind: 'resume', from: 'a_ship' });
assert.equal(r.state.status, 'ended');

// ── lint ──
const okErrs = E.validateBotDef(PARENT, { channel: 'whatsapp', sharedIds: new Set([FAQ_ID]) });
assert.deepEqual(okErrs, []);
assert.ok(E.validateBotDef(PARENT, { channel: 'whatsapp', sharedIds: new Set() }).some((e) => e.code === 'subflow_target_invalid'));
assert.ok(E.validateBotDef(PARENT, { isShared: true, sharedIds: new Set([FAQ_ID]) }).some((e) => e.code === 'shared_contains_subflow'));
const WA = { entry: 'm', steps: { m: { type: 'menu', text: 'x', buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, label: 'A label that is far too long for Meta' })),
  outcomes: { b1: 'e', b2: 'e', b3: 'e', b4: 'e', fallback: 'e' } }, e: { type: 'end', outcomes: {} } } };
const waErrs = E.validateBotDef(WA, { channel: 'whatsapp' });
assert.ok(waErrs.some((e) => e.code === 'wa_too_many_buttons'));
assert.ok(waErrs.some((e) => e.code === 'wa_button_label_long'));
assert.deepEqual(E.validateBotDef(WA, { channel: 'web' }), []);   // web has no such limits
const LIST = { entry: 'm', steps: { m: { type: 'menu', style: 'list', text: 'x', buttons: Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, label: `R${i}`, description: 'd'.repeat(73) })),
  outcomes: Object.assign({ fallback: 'e' }, ...Array.from({ length: 11 }, (_, i) => ({ [`b${i}`]: 'e' }))) }, e: { type: 'end', outcomes: {} } } };
const lErrs = E.validateBotDef(LIST, { channel: 'whatsapp' });
assert.ok(lErrs.some((e) => e.code === 'wa_too_many_rows'));
assert.ok(lErrs.some((e) => e.code === 'wa_row_description_long'));
console.log('bot-subflow ok');
```

- [ ] **Step 2: Run to verify it fails** — `node test/bot-subflow.test.js` → AssertionError on `effects` (empty vs `subflow_enter`).

- [ ] **Step 3: Implement**

In `walk`, before the `break;` at the bottom of the type chain, add a subflow branch and change the `end` branch:
```js
    if (step.type === 'subflow') {
      effects.push({ type: 'subflow_enter', bot_id: step.bot_id, return_step: id });
      return { state, replies, effects };
    }
    if (step.type === 'end') {
      if (step.text) replies.push({ text: step.text });
      if (state.frame) {                                     // inside a shared sub-flow: hand back to the parent
        effects.push({ type: 'subflow_return', return_step: state.frame.return_step });
        state.frame = null;
        return { state, replies, effects };
      }
      state.status = 'ended'; return { state, replies, effects };
    }
```
(remove the old one-line `end` branch). In `advance`, carry the frame: `const state = { current_step: prev.current_step, status: prev.status, context: { ...(prev.context || {}) }, frame: prev.frame || null };`.

Add the channel lint. Constants near the top:
```js
const WA_MAX_BUTTONS = 3, WA_BUTTON_LABEL = 20, WA_MAX_ROWS = 10, WA_ROW_TITLE = 24, WA_ROW_DESC = 72, WA_BODY = 1024;
```
Change the signature to `function validateBotDef(def, opts = {})` and inside the step loop, after the handles check, add:
```js
    if (step.type === 'subflow') {
      if (opts.isShared) errs.push({ code: 'shared_contains_subflow', stepId: id });
      if (opts.sharedIds && !(step.bot_id && opts.sharedIds.has(step.bot_id))) errs.push({ code: 'subflow_target_invalid', stepId: id });
    }
    if (opts.channel === 'whatsapp') {
      if (step.type === 'menu') {
        const btns = step.buttons || [];
        if (step.style === 'list') {
          if (btns.length > WA_MAX_ROWS) errs.push({ code: 'wa_too_many_rows', stepId: id });
          if (btns.some((b) => String(b.label || '').length > WA_ROW_TITLE)) errs.push({ code: 'wa_row_title_long', stepId: id });
          if (btns.some((b) => String(b.description || '').length > WA_ROW_DESC)) errs.push({ code: 'wa_row_description_long', stepId: id });
        } else {
          if (btns.length > WA_MAX_BUTTONS) errs.push({ code: 'wa_too_many_buttons', stepId: id });
          if (btns.some((b) => String(b.label || '').length > WA_BUTTON_LABEL)) errs.push({ code: 'wa_button_label_long', stepId: id });
        }
      }
      const body = step.text || step.prompt || step.text_exhausted || '';
      if (String(body).length > WA_BODY) errs.push({ code: 'wa_text_long', stepId: id });
    }
    if (step.type === 'action' && String(step.text_exhausted || '').length > WA_BODY) errs.push({ code: 'text_exhausted_long', stepId: id });
```
The `handles` expression gains `: step.type === 'subflow' ? ['next']` (it already falls to `['next']` by default — fine, but be explicit). Export the `WA_*` constants.

- [ ] **Step 4: Run all bot tests** — `for f in test/bot-*.test.js test/journey-graph.test.js test/journeys-compile.test.js; do node $f || echo RED $f; done` → no RED.

- [ ] **Step 5: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/bot-engine.js commsops-worker/test/bot-subflow.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: bot engine — subflow enter/return as effects (depth 1), WhatsApp channel lint (spec §2, §3)"
```

---

### Task 6: `bot-turn.js` — the shared effect loop; `bot-web.js` uses it

**Files:**
- Create: `commsops-worker/src/bot-turn.js`
- Modify: `commsops-worker/src/bot-web.js:63-95` (`runTurn`)
- Test: `commsops-worker/test/bot-turn.test.js` (new)

**Interfaces:**
- Produces: `executeTurn(env, session, def, input, deps)` → `{ out: {state, replies, effects}, stepRows: [...], handoff: bool, frame: {bot_id, version, return_step}|null }`. `deps` = `{ lookupOrderStatus(env, effect), loadActiveShared(env, botId) → {version, definition}|null, loadDefinition(env, botId, version) }` — injectable for tests. Handles effects `order_lookup`, `subflow_enter`, `subflow_return`, `handoff` (flag only). `sessionDefinition(env, session)` → the definition to run this turn (the sub-flow's when `session.sub_bot_id` is set, else the bot's).
- `bot-web.js runTurn(env, session, def, input, inboundText)` keeps its signature and now delegates to `executeTurn`, then persists (including frame columns) and forwards as before.

- [ ] **Step 1: Write the failing test**

`commsops-worker/test/bot-turn.test.js`:
```js
// S355 — channel-neutral effect loop. Run: node test/bot-turn.test.js
const assert = require('assert');
const T = require('../src/bot-turn.js');
const FAQ_ID = '11111111-1111-1111-1111-111111111111';
const PARENT = { entry: 'menu', steps: {
  menu: { type: 'menu', text: 'Hi', buttons: [{ id: 'b_faq', label: 'FAQs' }], outcomes: { b_faq: 'faq', fallback: 'h' } },
  faq:  { type: 'subflow', bot_id: FAQ_ID, outcomes: { next: 'menu' } },
  h:    { type: 'handoff', outcomes: {} } } };
const SUB = { entry: 'a', steps: { a: { type: 'message', text: 'Answer.', outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} } } };
const deps = {
  loadActiveShared: async (env, id) => (id === FAQ_ID ? { version: 3, definition: SUB } : null),
  loadDefinition: async () => null,
  lookupOrderStatus: async () => ({ ok: false, reason: 'test' }),
};
(async () => {
  const session = { id: 's1', bot_id: 'p', bot_version: 1, current_step: 'menu', status: 'active', context: {}, sub_bot_id: null };
  // FAQ tap: enter sub-flow, walk it to its end, return, resume parent at the menu — ONE turn
  const r = await T.executeTurn({}, session, PARENT, { kind: 'button', buttonId: 'b_faq', text: 'FAQs' }, deps);
  assert.deepEqual(r.out.replies.map((x) => x.text), ['Answer.', 'Hi']);
  assert.equal(r.out.state.current_step, 'menu');
  assert.equal(r.frame, null);
  assert.equal(r.handoff, false);
  const types = r.stepRows.map((s) => s.step_type);
  assert.ok(types.includes('subflow_enter') && types.includes('subflow_return'), types.join(','));
  // a sub-flow that WAITS (menu) leaves the frame set for the next turn
  const SUB2 = { entry: 'm', steps: { m: { type: 'menu', text: 'Topics', buttons: [{ id: 'x', label: 'X' }], outcomes: { x: 'e', fallback: 'e' } }, e: { type: 'end', outcomes: {} } } };
  const deps2 = { ...deps, loadActiveShared: async () => ({ version: 5, definition: SUB2 }) };
  const r2 = await T.executeTurn({}, session, PARENT, { kind: 'button', buttonId: 'b_faq', text: 'FAQs' }, deps2);
  assert.deepEqual(r2.frame, { bot_id: FAQ_ID, version: 5, return_step: 'faq' });
  assert.equal(r2.out.state.current_step, 'm');
  // next turn on a session carrying the frame runs the SUB definition
  const s2 = { ...session, current_step: 'm', sub_bot_id: FAQ_ID, sub_version: 5, return_step: 'faq' };
  const defs = { loadDefinition: async (env, id, v) => (id === FAQ_ID && v === 5 ? SUB2 : null) };
  assert.deepEqual(await T.sessionDefinition({}, s2, defs), SUB2);
  // unknown shared bot: the turn hands off rather than stalling
  const r3 = await T.executeTurn({}, session, PARENT, { kind: 'button', buttonId: 'b_faq', text: 'FAQs' }, { ...deps, loadActiveShared: async () => null });
  assert.equal(r3.handoff, true);
  console.log('bot-turn ok');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails** — `node test/bot-turn.test.js` → `Cannot find module '../src/bot-turn.js'`.

- [ ] **Step 3: Implement `bot-turn.js`**

```js
// Channel-neutral turn runner (S355). Runs the pure engine, executes its EFFECTS
// (order lookup re-enters with action_result; subflow_enter loads the shared bot's active
// version and opens it; subflow_return resumes the parent), and returns replies + step rows.
// NO persistence and NO sending here — bot-web.js and bot-wa.js own those.
const A = require('./auth.js');
const E = require('./bot-engine.js');
const OS = require('./bot-order-status.js');

const MAX_EFFECT_LOOPS = 6;   // enter + walk + return + resume + one lookup, with slack

async function defaultLoadDefinition(env, botId, version) {
  const r = await A.sbComms(`/rest/v1/bot_versions?bot_id=eq.${A.enc(botId)}&version=eq.${version}&select=definition&limit=1`, env);
  return (r.ok && r.data?.[0]?.definition) || null;
}
async function defaultLoadActiveShared(env, botId) {
  const b = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(botId)}&channel=eq.shared&status=eq.active&select=active_version&limit=1`, env);
  const v = b.ok && b.data?.[0]?.active_version;
  if (!v) return null;
  const d = await defaultLoadDefinition(env, botId, v);
  return d ? { version: v, definition: d } : null;
}

// The definition THIS turn runs against: the sub-flow's when the session is inside one.
async function sessionDefinition(env, session, deps = {}) {
  const load = deps.loadDefinition || defaultLoadDefinition;
  if (session.sub_bot_id && session.sub_version) return load(env, session.sub_bot_id, session.sub_version);
  return load(env, session.bot_id, session.bot_version);
}

async function executeTurn(env, session, def, input, deps = {}) {
  const lookup = deps.lookupOrderStatus || ((e, fx) => OS.lookupOrderStatus(e, fx));
  const loadShared = deps.loadActiveShared || defaultLoadActiveShared;
  const prev = { current_step: session.current_step, status: session.status, context: session.context || {},
    frame: session.sub_bot_id ? { bot_id: session.sub_bot_id, version: session.sub_version, return_step: session.return_step } : null };
  let curDef = def;                 // definition the engine is currently walking
  let parentDef = prev.frame ? null : def;   // parent, needed to resume after a return
  const stepRows = [];
  let out = E.advance(curDef, prev, input);
  let replies = [...out.replies];
  let handoff = false;
  for (let guard = 0; guard < MAX_EFFECT_LOOPS; guard++) {
    const fx = out.effects || []; out.effects = [];
    let reentered = false;
    for (const e of fx) {
      if (e.type === 'order_lookup') {
        const r = await lookup(env, e);
        stepRows.push({ session_id: session.id, step_id: out.state.current_step, step_type: 'order_lookup', result: { ok: r.ok, reason: r.reason || null } });
        out = E.advance(curDef, out.state, { kind: 'action_result', ok: r.ok, data: r.ok ? { statusText: r.statusText } : {} });
        replies.push(...out.replies); reentered = true;
      } else if (e.type === 'subflow_enter') {
        const shared = await loadShared(env, e.bot_id);
        stepRows.push({ session_id: session.id, step_id: e.return_step, step_type: 'subflow_enter', result: { bot_id: e.bot_id, version: shared?.version || null } });
        if (!shared) {          // unpublished/missing shared bot: never stall the customer
          replies.push({ text: E.HANDOFF_DEFAULT }); out.state.status = 'handed_off'; handoff = true; continue;
        }
        parentDef = curDef; curDef = shared.definition;
        out.state.frame = { bot_id: e.bot_id, version: shared.version, return_step: e.return_step };
        out = E.advance(curDef, out.state, { kind: 'open' });
        replies.push(...out.replies); reentered = true;
      } else if (e.type === 'subflow_return') {
        stepRows.push({ session_id: session.id, step_id: e.return_step, step_type: 'subflow_return', result: null });
        if (!parentDef) parentDef = await sessionDefinition(env, { ...session, sub_bot_id: null }, deps);
        curDef = parentDef;
        out = E.advance(curDef, out.state, { kind: 'resume', from: e.return_step });
        replies.push(...out.replies); reentered = true;
      } else if (e.type === 'handoff') {
        handoff = true;
        stepRows.push({ session_id: session.id, step_id: out.state.current_step, step_type: 'handoff', result: null });
      }
    }
    if (!reentered) break;
  }
  for (const r of replies) stepRows.push({ session_id: session.id, step_id: out.state.current_step || 'entry', step_type: 'bot_message', result: { text: r.text, buttons: r.buttons || null, style: r.style || null } });
  out.replies = replies;
  return { out, stepRows, handoff, frame: out.state.frame || null };
}

module.exports = { executeTurn, sessionDefinition, defaultLoadDefinition, defaultLoadActiveShared };
```

- [ ] **Step 4: Run** — `node test/bot-turn.test.js` → `bot-turn ok`.

- [ ] **Step 5: Rewire `bot-web.js runTurn`**

Replace the body of `runTurn` (keep the signature and `forwardToCsops`/`persist`):
```js
async function runTurn(env, session, def, input, inboundText) {
  const stepRows = [{ session_id: session.id, step_id: session.current_step || 'entry', step_type: inboundText ? 'customer_message' : 'open', result: inboundText ? { text: inboundText } : null }];
  const t = await T.executeTurn(env, session, def, input);
  const out = t.out; stepRows.push(...t.stepRows);
  const ident = out.state.context.identity;
  if (ident && !session.profile_id && !out.state.context.profile_id) {
    const ids = ident.phone ? [{ type: 'phone', value: `+91${ident.phone}`, is_verified: false }]
                            : [{ type: 'email', value: ident.email, is_verified: false }];
    const rp = await A.sbComms('/rest/v1/rpc/resolve_identity', env, { method: 'POST',
      body: JSON.stringify({ p_identifiers: ids, p_source: 'web_bot' }) }).catch(() => ({ ok: false }));
    if (rp.ok && rp.data) out.state.context.profile_id = rp.data;
  }
  await persist(env, session, out, stepRows, t.frame);
  if (inboundText || t.handoff)
    await forwardToCsops(env, session, out.state.context.identity, inboundText, out.replies, t.handoff);
  return out;
}
```
Add `const T = require('./bot-turn.js');` and extend `persist` to write the frame:
```js
async function persist(env, session, out, stepRows, frame) {
  await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(session.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ current_step: out.state.current_step, status: out.state.status, context: out.state.context,
      profile_id: session.profile_id || out.state.context.profile_id || null,
      sub_bot_id: frame ? frame.bot_id : null, sub_version: frame ? frame.version : null, return_step: frame ? frame.return_step : null,
      last_activity_at: new Date().toISOString(), ended_at: out.state.status === 'ended' ? new Date().toISOString() : null }) });
  if (stepRows.length)
    await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(stepRows) });
}
```
Keep the ORIGINAL comments about identity (`is_verified:false ON PURPOSE`) and the forward-only-after-a-human-line rule above the new code. In `index.js` `/web/message`, replace `BW.loadDefinition(env, session.bot_id, session.bot_version)` with `T.sessionDefinition(env, session)` (add `const T = require('./bot-turn.js');` at the top of index.js near line 31). Also in `forwardToCsops`, the flattened options line: for `style==='list'` render rows the same numbered way (no change needed — `r.buttons` is present for both).

- [ ] **Step 6: Run the whole commsops suite** — `for f in test/*.test.js; do node "$f" >/dev/null 2>&1 || echo "RED: $f"; done` → nothing printed.

- [ ] **Step 7: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/bot-turn.js commsops-worker/src/bot-web.js commsops-worker/src/index.js commsops-worker/test/bot-turn.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: bot-turn.js — channel-neutral effect loop (order lookup, sub-flow enter/return); bot-web delegates to it and persists the sub-flow frame"
```

---

### Task 7: `bots.js` — publish lint options, `setBotMode`, `saveBot` strips pilot fields

**Files:**
- Modify: `commsops-worker/src/bots.js`, `commsops-worker/src/index.js:1070-1092`
- Test: `commsops-worker/test/bots-config.test.js` (new)

**Interfaces:**
- Produces: `saveBot(env, {id, name, draft_definition, config, channel}, userId)` — `config.mode`/`config.pilot_numbers` are stripped from what a builder saves (existing values preserved on update); `channel` is settable only while `active_version` is null (a bot never changes channel after first publish). `setBotMode(env, id, {mode, pilot_numbers})` (activate tier): validates `mode ∈ pilot|public`, normalises numbers to digits (10–15), merges into `config`. `publishBot` calls `E.validateBotDef(def, {channel, isShared: channel==='shared', sharedIds})`. New worker actions: `setBotMode` (POST, `canActivate`).

- [ ] **Step 1: Write the failing test**

`commsops-worker/test/bots-config.test.js`:
```js
// S355 — pilot switch is activate-tier only; saveBot cannot flip it. Run: node test/bots-config.test.js
const assert = require('assert');
const B = require('../src/bots.js');
assert.deepEqual(B.sanitizeBuilderConfig({ mode: 'public', pilot_numbers: ['1'], greeting_delay: 2 }, { mode: 'pilot', pilot_numbers: ['917709991011'] }),
  { mode: 'pilot', pilot_numbers: ['917709991011'], greeting_delay: 2 });
assert.deepEqual(B.sanitizeBuilderConfig({}, {}), { mode: 'pilot', pilot_numbers: [] });
assert.deepEqual(B.normalizeMode({ mode: 'public', pilot_numbers: ['+91 77099 91011', 'x', '12'] }), { mode: 'public', pilot_numbers: ['917709991011'] });
assert.deepEqual(B.normalizeMode({ mode: 'weird' }), null);
console.log('bots-config ok');
```

- [ ] **Step 2: Run to verify it fails** — `node test/bots-config.test.js` → `TypeError: B.sanitizeBuilderConfig is not a function`.

- [ ] **Step 3: Implement in `bots.js`**

Add:
```js
// The pilot switch is Afshaan's flip (spec §5.1.3): builders may edit anything in config EXCEPT
// mode/pilot_numbers, which only setBotMode (activate tier) writes. Existing values are kept.
function sanitizeBuilderConfig(incoming, existing) {
  const out = { ...(incoming || {}) };
  out.mode = (existing && existing.mode) || 'pilot';
  out.pilot_numbers = Array.isArray(existing?.pilot_numbers) ? existing.pilot_numbers : [];
  return out;
}
function normalizeMode(body) {
  const mode = body?.mode;
  if (mode !== 'pilot' && mode !== 'public') return null;
  const nums = (Array.isArray(body.pilot_numbers) ? body.pilot_numbers : [])
    .map((n) => String(n).replace(/\D/g, '')).filter((d) => d.length >= 10 && d.length <= 15);
  return { mode, pilot_numbers: [...new Set(nums)] };
}
async function setBotMode(env, id, body) {
  const m = normalizeMode(body);
  if (!m) return { ok: false, error: 'invalid_mode' };
  const cur = await getBot(env, id);
  if (!cur.ok) return cur;
  const config = { ...(cur.bot.config || {}), ...m };
  const u = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}`, env, { method: 'PATCH', body: JSON.stringify({ config, updated_at: new Date().toISOString() }) });
  return u.ok && u.data?.[0] ? { ok: true, bot: u.data[0] } : { ok: false, error: 'update_failed' };
}
```
Change `saveBot`:
```js
async function saveBot(env, { id, name, draft_definition, config, channel }, userId) {
  const existing = id ? await getBot(env, id) : null;
  const prevCfg = existing?.ok ? existing.bot.config : {};
  const body = { name, draft_definition: draft_definition || {}, config: sanitizeBuilderConfig(config, prevCfg), updated_at: new Date().toISOString() };
  const ch = ['web', 'whatsapp', 'shared'].includes(channel) ? channel : null;
  if (ch && (!existing?.ok || !existing.bot.active_version)) body.channel = ch;   // channel is fixed at first publish
  ...unchanged POST/PATCH...
}
```
Change `publishBot`:
```js
  const sh = await A.sbComms('/rest/v1/bots?channel=eq.shared&status=eq.active&active_version=not.is.null&select=id', env);
  const sharedIds = new Set((sh.ok ? sh.data : []).map((b) => b.id));
  const errs = E.validateBotDef(cur.bot.draft_definition, { channel: cur.bot.channel, isShared: cur.bot.channel === 'shared', sharedIds });
```
Export `sanitizeBuilderConfig, normalizeMode, setBotMode`. In `index.js` after the `pauseBot/resumeBot` case add:
```js
    case 'setBotMode': {   // pilot|public + allow-list — Afshaan's flip, activate tier ONLY (spec §5.1.3)
      if (!A.canActivate(auth.permissions)) return err('forbidden', 403);
      const r = await BOTS.setBotMode(env, body.id, body);
      return r.ok ? ok(r) : err(r.error, 400);
    }
```
In `listBots`, add `config` to the select so the UI can show the mode: `select=id,name,status,channel,active_version,config,updated_at`.

- [ ] **Step 4: Run** — `node test/bots-config.test.js` → `bots-config ok`; full suite loop → nothing printed.

- [ ] **Step 5: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/bots.js commsops-worker/src/index.js commsops-worker/test/bots-config.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: bots — publish lint carries channel + shared ids; setBotMode (activate tier) owns pilot/public; saveBot cannot flip it"
```

---

### Task 8: WhatsApp `list` mode at all four send-path sites

**Files:**
- Modify: `commsops-worker/src/render.js:175-185`, `commsops-worker/src/adapters/whatsapp.js` (new `list` branch; explicit `text` branch + unknown-mode failure), `commsops-worker/src/send.js:397-403`, `commsops-worker/src/gate.js:395`
- Test: `commsops-worker/test/wa-list.test.js` (new)

**Interfaces:**
- Consumes: `send(env, opts)` with new `opts.interactiveList = { button, rows:[{id,title,description}] }`.
- Produces: `renderWhatsapp` → `{mode:'list', text, button, rows}`; adapter payload `interactive.type='list'`; gate refuses `list` outside the window; adapter fails `unknown_render_mode` for anything unrecognised.

- [ ] **Step 1: Read the existing harness** — `sed -n '1,60p' test/wa.test.js` and the `interactive` case in `test/wa-interactive.test.js` to copy the `stubFetch` pattern exactly.

- [ ] **Step 2: Write the failing tests**

`commsops-worker/test/wa-list.test.js`:
```js
// S355 — WhatsApp interactive LIST mode at render, adapter, gate and send-ctx sites.
// Run: node test/wa-list.test.js
const assert = require('assert');
const wa = require('../src/adapters/whatsapp.js');
const { renderWhatsapp } = require('../src/render.js');
const { runGate, _clearSettingsCache } = require('../src/gate.js');
let pass = 0, fail = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ', name); }, (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); }); }
const realFetch = global.fetch;
(async () => {
  const tpl = { content: { text_body: 'Pick a topic' } };
  await t('render picks list mode when interactiveList is present', () => {
    const r = renderWhatsapp(tpl, { interactiveList: { button: 'Topics', rows: [{ id: 'bot:m:b_ship', title: 'Shipping', description: 'How long' }] } });
    assert.equal(r.mode, 'list'); assert.equal(r.button, 'Topics'); assert.equal(r.rows[0].id, 'bot:m:b_ship');
  });
  await t('render still prefers interactive buttons when both given', () => {
    const r = renderWhatsapp(tpl, { interactiveButtons: [{ id: 'a', text: 'A' }], interactiveList: { rows: [{ id: 'x', title: 'X' }] } });
    assert.equal(r.mode, 'interactive');
  });
  await t('adapter builds a Meta list payload with caps applied', async () => {
    let sent = null;
    global.fetch = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }); };
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `bot:m:b${i}`, title: 'T'.repeat(30), description: 'D'.repeat(80) }));
    const r = await wa.send({ mode: 'list', text: 'Pick', button: 'A very long button title indeed', rows, to: '919999999999', phone_number_id: 'P', window_open: true }, { WA_TOKEN: 'tok' });
    global.fetch = realFetch;
    assert.equal(r.status, 'sent');
    assert.equal(sent.type, 'interactive'); assert.equal(sent.interactive.type, 'list');
    assert.equal(sent.interactive.action.button.length, 20);
    const got = sent.interactive.action.sections[0].rows;
    assert.equal(got.length, 10); assert.equal(got[0].title.length, 24); assert.equal(got[0].description.length, 72);
  });
  await t('adapter refuses a list outside the window and with no rows', async () => {
    assert.equal((await wa.send({ mode: 'list', text: 'x', rows: [{ id: 'a', title: 'A' }], to: '9199', phone_number_id: 'P', window_open: false }, { WA_TOKEN: 't' })).reason, 'window_closed');
    assert.equal((await wa.send({ mode: 'list', text: 'x', rows: [], to: '9199', phone_number_id: 'P', window_open: true }, { WA_TOKEN: 't' })).reason, 'list_no_rows');
  });
  await t('adapter fails closed on an unknown render mode', async () => {
    assert.equal((await wa.send({ mode: 'carousel', text: 'x', to: '9199', phone_number_id: 'P', window_open: true }, { WA_TOKEN: 't' })).reason, 'unknown_render_mode');
  });
  await t('gate refuses an out-of-window list like text/interactive', async () => {
    _clearSettingsCache && _clearSettingsCache();
    const g = await runGate({ WA_SKIP_DB: '1' }, { channel: 'whatsapp', purpose: 'utility', to: '+919999999999', wa: { mode: 'list', window_open: false, hasTemplate: false }, profile: null });
    assert.equal(g.pass, false); assert.equal(g.reason, 'window_closed');
  });
  console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
})();
```
⚠️ The `runGate` call signature and any settings stub must be copied from how `test/wa.test.js` invokes `runGate` for its own `window_closed` case — read that case and mirror its env/arguments exactly; do not invent `WA_SKIP_DB`.

- [ ] **Step 3: Run to verify it fails** — `node test/wa-list.test.js` → the render case fails (`'text' == 'list'`).

- [ ] **Step 4: Implement**

`render.js` — before the `interactiveButtons` block's `return { mode:'text' }`, after the interactive block:
```js
  if (ctx?.interactiveList && Array.isArray(ctx.interactiveList.rows) && ctx.interactiveList.rows.length) {
    return {
      mode: 'list', text: body,
      button: applyTokens(String(ctx.interactiveList.button || 'Choose'), values),
      rows: ctx.interactiveList.rows.slice(0, 10).map((r, i) => ({
        id: String(r.id || `row_${i}`), title: applyTokens(String(r.title || r.label || ''), values),
        description: r.description ? applyTokens(String(r.description), values) : null })),
    };
  }
```
`adapters/whatsapp.js` — after the `media` branch:
```js
  } else if (rendered.mode === 'list') {
    // Interactive LIST (S355 bots). Session message: same 24h rule as text/interactive. Meta caps:
    // 10 rows, title 24, description 72, action button 20 — truncated, never rejected (a silent
    // 400 mid-conversation is worse than a clipped label). Row id echoes back on list_reply.id.
    if (rendered.window_open !== true) return { provider_message_id: null, status: 'skipped', reason: 'window_closed' };
    const rows = (Array.isArray(rendered.rows) ? rendered.rows : []).slice(0, 10);
    if (!rendered.text) return { provider_message_id: null, status: 'failed', reason: 'empty_text' };
    if (!rows.length) return { provider_message_id: null, status: 'failed', reason: 'list_no_rows' };
    payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'list', body: { text: String(rendered.text).slice(0, 1024) },
        action: { button: String(rendered.button || 'Choose').slice(0, 20),
          sections: [{ rows: rows.map((r, i) => ({ id: String(r.id || `row_${i}`).slice(0, 200), title: String(r.title || `Option ${i + 1}`).slice(0, 24),
            ...(r.description ? { description: String(r.description).slice(0, 72) } : {}) })) }] },
      },
    };
  } else if (rendered.mode === 'text' || rendered.mode == null) {
    // free-form text — only inside the 24h window (was the catch-all `else`; an unknown mode now
    // fails closed below instead of being sent as prose with its options silently dropped)
    ...existing text body unchanged...
  } else {
    return { provider_message_id: null, status: 'failed', reason: 'unknown_render_mode' };
  }
```
(Check every existing caller that sends with no `mode` still works: `grep -n "mode:" src/*.js | grep -v "mode: '"` — the `rendered.mode == null` clause keeps them.)
`send.js:402` — add `interactiveList: isTemplate ? null : (opts.interactiveList || null),` beside `interactiveButtons`. `gate.js:395` — `(wa.mode === 'text' || wa.mode === 'interactive' || wa.mode === 'media' || wa.mode === 'list')` and rewrite the comment above to say: *"an unlisted mode is NOT gated — every session mode must be listed here"*.

- [ ] **Step 5: Run** — `node test/wa-list.test.js && node test/wa.test.js && node test/wa-interactive.test.js && node test/gate-failclosed.test.js` → all pass; full suite loop → nothing.

- [ ] **Step 6: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/render.js commsops-worker/src/adapters/whatsapp.js commsops-worker/src/send.js commsops-worker/src/gate.js commsops-worker/test/wa-list.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: WhatsApp interactive list mode — render, adapter (caps, fail-closed on unknown mode), send ctx, gate window check (spec §4)"
```

---

### Task 9: `bot-wa.js` — the WhatsApp ingress, hooked into the webhook

**Files:**
- Create: `commsops-worker/src/bot-wa.js`
- Modify: `commsops-worker/src/wa-webhooks.js` (require; hook before `hostInboundMedia`; `whatsapp_reply` guard)
- Test: `commsops-worker/test/bot-wa.test.js` (new), `commsops-worker/test/wa.test.js` (append one webhook case)

**Interfaces:**
- Consumes: `T.executeTurn`, `T.sessionDefinition`, `send()` from `send.js`, `A.sbComms`, `A.sbStore`, `detectOptOut`.
- Produces: `maybeHandleInbound(env, m, ingestRes, deps)` → `null` (not engaged) | `{ handled:true, session_id, session_status, replies:[{text,buttons?,style?}], handoff }` | `{ handled:true, duplicate:true }`. `stripBotId(id)`. `BOT_ID_PREFIX = 'bot:'`. Each inbound `m` gets `m.bot = <that object>` so `forwardToCsops` carries it. Exposed constants `HUMAN_ACTIVE_MS = 12h`, `IDLE_EXPIRE_MS = 6h`.

- [ ] **Step 1: Write the failing tests (deps-injected, no network)**

`commsops-worker/test/bot-wa.test.js`:
```js
// S355 — WhatsApp bot ingress: engage conditions, claim, sends, forward payload.
// Run: node test/bot-wa.test.js
const assert = require('assert');
const W = require('../src/bot-wa.js');
const DEF = { entry: 'menu', keywords: [{ match: ['agent'], target: 'h' }], steps: {
  menu: { type: 'menu', style: 'list', text: 'Hi', buttons: [{ id: 'b_faq', label: 'FAQs' }], outcomes: { b_faq: 'a', fallback: 'h' } },
  a: { type: 'message', text: 'Answer', outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} }, h: { type: 'handoff', outcomes: {} } } };
const BOT = { id: 'bot1', active_version: 2, config: { mode: 'pilot', pilot_numbers: ['917709991011'] } };
function mk(over = {}) {
  const calls = { sends: [], claims: [], sessions: [] };
  const deps = {
    supportPhoneId: async () => 'PNID',
    activeWaBot: async () => BOT,
    threadLastOutbound: async () => ({ found: false }),
    hasActiveEnrolment: async () => false,
    findActiveSession: async () => null,
    createSession: async (env, row) => { calls.sessions.push(row); return { id: 'S1', ...row, status: 'active', current_step: null, context: {} }; },
    claimTurn: async (env, row) => { calls.claims.push(row); return true; },
    loadDefinition: async () => DEF,
    loadActiveShared: async () => null,
    lookupOrderStatus: async () => ({ ok: false }),
    send: async (env, opts) => { calls.sends.push(opts); return { status: 'sent' }; },
    persist: async () => {},
    ...over,
  };
  return { deps, calls };
}
const M = (o = {}) => ({ from: '917709991011', phone_number_id: 'PNID', type: 'text', text: 'hi', provider_message_id: 'wamid.1', ts: new Date().toISOString(), ...o });
const ING = { ok: true, profile_id: 'prof1' };
(async () => {
  // engages on a pilot number: opens a session, sends the greeting as a LIST, returns the forward payload
  let { deps, calls } = mk();
  let r = await W.maybeHandleInbound({}, M(), ING, deps);
  assert.equal(r.handled, true); assert.equal(r.session_status, 'active'); assert.equal(r.replies[0].text, 'Hi');
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].purpose, 'utility'); assert.equal(calls.sends[0].phoneNumberId, 'PNID'); assert.equal(calls.sends[0].to, '+917709991011');
  assert.equal(calls.sends[0].interactiveList.rows[0].id, 'bot:menu:b_faq');
  assert.equal(calls.sends[0].dedupKey, 'bot:S1:wamid.1:0');
  assert.equal(calls.claims[0].provider_message_id, 'wamid.1');
  assert.equal(calls.sessions[0].channel, 'whatsapp'); assert.equal(calls.sessions[0].wa_from, '917709991011'); assert.equal(calls.sessions[0].profile_id, 'prof1');
  // not on the support number / no active bot / non-pilot number / STOP / human active / mid-journey -> null
  assert.equal(await W.maybeHandleInbound({}, M({ phone_number_id: 'OTHER' }), ING, mk().deps), null);
  assert.equal(await W.maybeHandleInbound({}, M(), ING, mk({ activeWaBot: async () => null }).deps), null);
  assert.equal(await W.maybeHandleInbound({}, M({ from: '919999999999' }), ING, mk().deps), null);
  assert.equal(await W.maybeHandleInbound({}, M({ text: 'STOP' }), ING, mk().deps), null);
  assert.equal(await W.maybeHandleInbound({}, M(), ING, mk({ threadLastOutbound: async () => ({ found: true, last_outbound_at: new Date(Date.now() - 3600e3).toISOString() }) }).deps), null);
  assert.notEqual(await W.maybeHandleInbound({}, M(), ING, mk({ threadLastOutbound: async () => ({ found: true, last_outbound_at: new Date(Date.now() - 13 * 3600e3).toISOString() }) }).deps), null);
  assert.equal(await W.maybeHandleInbound({}, M(), ING, mk({ threadLastOutbound: async () => ({ error: true }) }).deps), null);   // read failed -> do not engage
  assert.equal(await W.maybeHandleInbound({}, M(), ING, mk({ hasActiveEnrolment: async () => true }).deps), null);
  // public mode ignores the allow-list
  ({ deps } = mk({ activeWaBot: async () => ({ ...BOT, config: { mode: 'public', pilot_numbers: [] } }) }));
  assert.equal((await W.maybeHandleInbound({}, M({ from: '919999999999' }), ING, deps)).handled, true);
  // duplicate claim -> handled but silent, nothing sent
  ({ deps, calls } = mk({ claimTurn: async () => false }));
  r = await W.maybeHandleInbound({}, M(), ING, deps);
  assert.deepEqual(r, { handled: true, duplicate: true }); assert.equal(calls.sends.length, 0);
  // list tap on an existing session: bot: prefix stripped, walks to the answer, ends -> session_status ended
  const sess = { id: 'S1', bot_id: 'bot1', bot_version: 2, channel: 'whatsapp', status: 'active', current_step: 'menu', context: {}, last_activity_at: new Date().toISOString() };
  ({ deps, calls } = mk({ findActiveSession: async () => sess }));
  r = await W.maybeHandleInbound({}, M({ type: 'interactive', text: 'FAQs', button_id: 'bot:menu:b_faq', provider_message_id: 'wamid.2' }), ING, deps);
  assert.equal(r.session_status, 'ended'); assert.deepEqual(r.replies.map((x) => x.text), ['Answer']);
  assert.equal(calls.sessions.length, 0);
  // idle > 6h: old session expired, new one opened with the greeting
  const stale = { ...sess, last_activity_at: new Date(Date.now() - 7 * 3600e3).toISOString() };
  const expired = [];
  ({ deps, calls } = mk({ findActiveSession: async () => stale, persist: async (env, s, patch) => { if (patch.status === 'ended') expired.push(s.id); } }));
  r = await W.maybeHandleInbound({}, M({ provider_message_id: 'wamid.3' }), ING, deps);
  assert.deepEqual(expired, ['S1']); assert.equal(calls.sessions.length, 1); assert.equal(r.replies[0].text, 'Hi');
  // keyword on the opening message -> straight to handoff
  ({ deps } = mk());
  r = await W.maybeHandleInbound({}, M({ text: 'I want an agent', provider_message_id: 'wamid.4' }), ING, deps);
  assert.equal(r.handoff, true); assert.equal(r.session_status, 'handed_off');
  assert.equal(W.stripBotId('bot:menu:b_faq'), 'b_faq'); assert.equal(W.stripBotId('confirm_yes'), 'confirm_yes');
  console.log('bot-wa ok');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails** — `node test/bot-wa.test.js` → `Cannot find module '../src/bot-wa.js'`.

- [ ] **Step 3: Implement `bot-wa.js`**

```js
// WhatsApp ingress for the Relay flow bot (S355, spec §5). Runs inside wa-webhooks.handleInbound
// AFTER the window upsert / ingest / STOP-START and BEFORE the Pitstop forward. Every condition
// fails CLOSED (silent bot, forward exactly as today). Sends go through send() like every other
// WhatsApp message. The forward payload (m.bot) is how the transcript reaches the inbox.
const A = require('./auth.js');
const E = require('./bot-engine.js');
const T = require('./bot-turn.js');
const { send } = require('./send.js');
const { detectOptOut } = require('./optout.js');

const BOT_ID_PREFIX = 'bot:';
const HUMAN_ACTIVE_MS = 12 * 3600 * 1000;   // csops's own human_active window
const IDLE_EXPIRE_MS = 6 * 3600 * 1000;
const stripBotId = (id) => String(id || '').replace(/^bot:[^:]+:/, '');
const wireId = (stepId, handle) => `${BOT_ID_PREFIX}${stepId}:${handle}`;

// ── default deps (real I/O) ──
let supportCache = { at: 0, id: null };
async function supportPhoneId(env) {
  if (Date.now() - supportCache.at < 60000) return supportCache.id;
  const r = await A.sbComms('/rest/v1/sender_identities?channel=eq.whatsapp&purpose=eq.utility&status=eq.active&select=metadata', env);
  const ids = (r.ok ? r.data : []).map((s) => s.metadata?.phone_number_id).filter(Boolean);
  supportCache = { at: Date.now(), id: ids.length === 1 ? String(ids[0]) : null };   // exactly one, else fail closed
  return supportCache.id;
}
async function activeWaBot(env) {
  const r = await A.sbComms('/rest/v1/bots?channel=eq.whatsapp&status=eq.active&active_version=not.is.null&select=id,active_version,config&limit=2', env);
  return r.ok && r.data?.length === 1 ? r.data[0] : null;
}
// ONE read: last_outbound_at is bumped only by human-ish rows (the trigger excludes tagged bot
// rows), so it IS the "human replied" signal. Thread not found = no human = engage (§5.1.5).
async function threadLastOutbound(env, from, phoneNumberId) {
  const r = await A.sbStore(`/rest/v1/cs_wa_threads?customer_phone=eq.${A.enc('+' + from)}&waba_phone_number_id=eq.${A.enc(phoneNumberId)}&select=last_outbound_at&limit=1`, env).catch(() => ({ ok: false }));
  if (!r.ok) return { error: true };
  return r.data?.[0] ? { found: true, last_outbound_at: r.data[0].last_outbound_at } : { found: false };
}
async function hasActiveEnrolment(env, profileId) {
  if (!profileId) return false;
  const r = await A.sbComms(`/rest/v1/enrolments?profile_id=eq.${A.enc(profileId)}&status=eq.active&select=id&limit=1`, env).catch(() => ({ ok: false }));
  return !r.ok || !!r.data?.[0];      // unreadable -> treat as enrolled (fail closed)
}
async function findActiveSession(env, from, phoneNumberId) {
  const r = await A.sbComms(`/rest/v1/bot_sessions?channel=eq.whatsapp&wa_from=eq.${A.enc(from)}&phone_number_id=eq.${A.enc(phoneNumberId)}&status=eq.active&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}
async function createSession(env, row) {
  const ins = await A.sbComms('/rest/v1/bot_sessions', env, { method: 'POST', body: JSON.stringify(row) });
  if (ins.ok && ins.data?.[0]) return ins.data[0];
  return findActiveSession(env, row.wa_from, row.phone_number_id);   // lost the unique-index race: adopt the winner
}
async function claimTurn(env, row) {
  const r = await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(row) });
  if (r.ok) return true;
  if (r.status === 409 || /23505|duplicate key/.test(JSON.stringify(r.data || ''))) return false;
  throw new Error('claim_failed:' + JSON.stringify(r.data).slice(0, 200));
}
async function persist(env, session, patch, stepRows) {
  await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(session.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
  if (stepRows?.length) await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(stepRows) });
}
const DEFAULTS = { supportPhoneId, activeWaBot, threadLastOutbound, hasActiveEnrolment, findActiveSession, createSession, claimTurn, persist, send,
  loadDefinition: T.defaultLoadDefinition, loadActiveShared: T.defaultLoadActiveShared, lookupOrderStatus: null };

function toSendOpts(sessionId, pmid, i, stepId, reply, from, phoneNumberId) {
  const base = { channel: 'whatsapp', purpose: 'utility', to: '+' + from, phoneNumberId,
    template: { content: { text_body: reply.text } }, dedupKey: `bot:${sessionId}:${pmid}:${i}`, source: 'relay_bot' };
  if (reply.buttons && reply.buttons.length) {
    if (reply.style === 'list' || reply.buttons.length > 3)
      base.interactiveList = { button: reply.list_button || 'Choose', rows: reply.buttons.map((b) => ({ id: wireId(stepId, b.id), title: b.label, description: b.description || null })) };
    else base.interactiveButtons = reply.buttons.map((b) => ({ id: wireId(stepId, b.id), text: b.label }));
  }
  return base;
}

async function maybeHandleInbound(env, m, ingestRes, depsIn) {
  const d = { ...DEFAULTS, ...(depsIn || {}) };
  if (!m?.from || !m.phone_number_id) return null;
  const pid = await d.supportPhoneId(env);
  if (!pid || String(m.phone_number_id) !== String(pid)) return null;                        // 1
  const bot = await d.activeWaBot(env); if (!bot) return null;                                // 2
  const cfg = bot.config || {};
  if ((cfg.mode || 'pilot') !== 'public' && !(cfg.pilot_numbers || []).includes(String(m.from))) return null;   // 3
  if (detectOptOut(m.text)) return null;                                                       // 4
  const lo = await d.threadLastOutbound(env, m.from, pid);                                     // 5
  if (lo.error) return null;
  if (lo.found && lo.last_outbound_at && Date.now() - new Date(lo.last_outbound_at).getTime() < HUMAN_ACTIVE_MS) return null;
  if (await d.hasActiveEnrolment(env, ingestRes?.profile_id)) return null;                     // 6
  const kindOk = ['text', 'interactive', 'button', 'image', 'video', 'audio', 'document', 'sticker'].includes(m.type || 'text');
  if (!kindOk) return null;                                                                    // 7
  const text = String(m.text || '').slice(0, 500);

  let session = await d.findActiveSession(env, m.from, pid);
  if (session && Date.now() - new Date(session.last_activity_at || session.started_at).getTime() > IDLE_EXPIRE_MS) {
    const ex = E.advance({ entry: null, steps: {} }, session, { kind: 'expire' });
    await d.persist(env, session, { status: ex.state.status, ended_at: new Date().toISOString() }, [{ session_id: session.id, step_id: session.current_step || 'entry', step_type: 'expire', result: null }]);
    session = null;
  }
  let opened = false;
  if (!session) {
    session = await d.createSession(env, { bot_id: bot.id, bot_version: bot.active_version, channel: 'whatsapp', wa_from: String(m.from), phone_number_id: pid,
      profile_id: ingestRes?.profile_id || null, context: { identity: { phone: E.normPhone(m.from) } } });
    if (!session) return null;
    opened = true;
  }
  // claim THIS message before advancing — redelivery / concurrent invocation = skip (spec §5.2)
  const claimed = await d.claimTurn(env, { session_id: session.id, step_id: session.current_step || 'entry', step_type: 'customer_message', result: { text, type: m.type || 'text', button_id: m.button_id || null }, provider_message_id: m.provider_message_id || null });
  if (!claimed) return { handled: true, duplicate: true };

  const def = await T.sessionDefinition(env, session, { loadDefinition: d.loadDefinition });
  if (!def) return null;
  const input = opened ? { kind: 'open', text }
    : m.button_id ? { kind: 'button', buttonId: stripBotId(m.button_id), text }
    : { kind: 'text', text };
  const t = await T.executeTurn(env, session, def, input, { loadActiveShared: d.loadActiveShared, loadDefinition: d.loadDefinition, ...(d.lookupOrderStatus ? { lookupOrderStatus: d.lookupOrderStatus } : {}) });
  const out = t.out;
  const sendRows = [];
  for (const [i, r] of out.replies.entries()) {
    const res = await d.send(env, toSendOpts(session.id, m.provider_message_id || 'nopmid', i, out.state.current_step || 'entry', r, m.from, pid)).catch((e) => ({ status: 'failed', reason: String(e?.message || e) }));
    if (res.status !== 'sent' && res.status !== 'deduped') sendRows.push({ session_id: session.id, step_id: out.state.current_step || 'entry', step_type: 'send_failed', result: { status: res.status, reason: res.reason || null } });
  }
  await d.persist(env, session, { current_step: out.state.current_step, status: out.state.status, context: out.state.context,
    sub_bot_id: t.frame ? t.frame.bot_id : null, sub_version: t.frame ? t.frame.version : null, return_step: t.frame ? t.frame.return_step : null,
    last_activity_at: new Date().toISOString(), ended_at: out.state.status === 'ended' ? new Date().toISOString() : null }, [...t.stepRows, ...sendRows]);
  return { handled: true, session_id: session.id, session_status: out.state.status,
    replies: out.replies.map((r) => ({ text: r.text, buttons: r.buttons || null, style: r.style || null })), handoff: t.handoff || out.state.status === 'handed_off' };
}

module.exports = { maybeHandleInbound, stripBotId, wireId, BOT_ID_PREFIX, HUMAN_ACTIVE_MS, IDLE_EXPIRE_MS, toSendOpts };
```

- [ ] **Step 4: Run** — `node test/bot-wa.test.js` → `bot-wa ok`.

- [ ] **Step 5: Hook into `wa-webhooks.js`**

Add `const BOTWA = require('./bot-wa.js');` to the requires. In `handleInbound`, change the reply-event guard `if (m.button_id) {` to:
```js
    // S355: a BOT menu tap must NOT wake a parked journey step — the matcher keys on the event
    // NAME, so emitting whatsapp_reply here would resolve a live C2P wait to no_reply (spec §4).
    if (m.button_id && !String(m.button_id).startsWith(BOTWA.BOT_ID_PREFIX)) {
```
Immediately after that whole `if` block (still inside the `for` loop, before its closing brace), add:
```js
    // 2e. S355 — the flow bot answers here, BEFORE the Pitstop forward, so the forward can carry
    // its replies. Every engage condition fails closed; an error is a silent bot, never a 500.
    try {
      const bot = await BOTWA.maybeHandleInbound(env, m, res);
      if (bot) m.bot = bot;
    } catch (e) { console.log('bot_wa_error', JSON.stringify({ reason: String(e?.message || e).slice(0, 160), provider_message_id: m.provider_message_id || null })); }
```
`forwardToCsops(env, inbound)` already serialises the `inbound` array — `m.bot` rides along; confirm by reading lines 58-77 (`body: JSON.stringify({ messages })` or similar). If the forward maps fields explicitly, add `bot: m.bot || null` to that mapping.

- [ ] **Step 6: Append a webhook-level test to `test/wa.test.js`**

Find the existing case that drives `waHook.handleWhatsappWebhook`/`handleInbound` with a button payload and stubbed fetch; add beside it:
```js
  await t('a bot: button tap emits whatsapp_inbound but NOT whatsapp_reply', async () => {
    const names = [];
    stubFetch(async (url, init) => {
      if (String(url).includes('/rest/v1/events')) names.push(JSON.parse(init.body).name);
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    // build the same inbound payload shape the neighbouring test uses, with
    // interactive.list_reply.id = 'bot:menu:b_faq'
    ...call the same entry point the neighbouring test calls...
    restoreFetch();
    assert.ok(names.includes('whatsapp_inbound'));
    assert.ok(!names.includes('whatsapp_reply'));
  });
```
Mirror the neighbouring test's payload/env exactly; if `ingest` in that harness is stubbed differently (e.g. via an RPC route), assert on the same channel the neighbouring test asserts on.

- [ ] **Step 7: Run the full commsops suite** — loop → nothing printed.

- [ ] **Step 8: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/bot-wa.js commsops-worker/src/wa-webhooks.js commsops-worker/test/bot-wa.test.js commsops-worker/test/wa.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: bot-wa.js — WhatsApp flow-bot ingress (7 fail-closed engage conditions, staff pilot, per-message claim, 6h expiry, sends via send()); webhook hook + no whatsapp_reply for bot: taps (spec §5)"
```

---

### Task 10: Web residuals — resume across navigation, email identity, widget list rendering

**Files:**
- Modify: `commsops-worker/src/index.js:3038-3050` (`/web/session`), `commsops-worker/src/bot-widget.js`
- Test: `commsops-worker/test/web-resume.test.js` (new — pure helper), manual widget check in Task 14

**Interfaces:**
- Produces: `POST /web/session {botId, resume?}` → when `resume` names an `active` session of that bot under `IDLE_EXPIRE_MS` idle: `{session_id, status, replies: [], history: [{who:'bot'|'agent', text, buttons, style, agent_name}]}`; else the existing new-session response. Helper `BW.resumeHistory(rows)` (pure) maps step rows to `history`.

- [ ] **Step 1: Write the failing test**

`commsops-worker/test/web-resume.test.js`:
```js
// S355 — resume redraw never leaks customer_message rows (spec §6②). Run: node test/web-resume.test.js
const assert = require('assert');
const BW = require('../src/bot-web.js');
const rows = [
  { id: 1, step_type: 'open', result: null },
  { id: 2, step_type: 'bot_message', result: { text: 'Hi', buttons: [{ id: 'a', label: 'A' }], style: 'buttons' } },
  { id: 3, step_type: 'customer_message', result: { text: '9876543210' } },
  { id: 4, step_type: 'agent_reply', result: { text: 'Hello from Sunitha', agent_name: 'Sunitha' } },
];
assert.deepEqual(BW.resumeHistory(rows), [
  { who: 'bot', text: 'Hi', buttons: [{ id: 'a', label: 'A' }], style: 'buttons', agent_name: null },
  { who: 'agent', text: 'Hello from Sunitha', buttons: null, style: null, agent_name: 'Sunitha' },
]);
assert.equal(BW.isResumable({ status: 'active', last_activity_at: new Date().toISOString() }), true);
assert.equal(BW.isResumable({ status: 'active', last_activity_at: new Date(Date.now() - 7 * 3600e3).toISOString() }), false);
assert.equal(BW.isResumable({ status: 'handed_off', last_activity_at: new Date().toISOString() }), true);   // agent replies still poll
assert.equal(BW.isResumable({ status: 'ended', last_activity_at: new Date().toISOString() }), false);
console.log('web-resume ok');
```

- [ ] **Step 2: Run to verify it fails** — `TypeError: BW.resumeHistory is not a function`.

- [ ] **Step 3: Implement**

In `bot-web.js`:
```js
const IDLE_EXPIRE_MS = 6 * 3600 * 1000;
function isResumable(s) {
  if (!s || (s.status !== 'active' && s.status !== 'handed_off')) return false;
  return Date.now() - new Date(s.last_activity_at || s.started_at || 0).getTime() < IDLE_EXPIRE_MS;
}
// Only what /web/poll already exposes plus the bot's own lines — NEVER customer_message rows.
function resumeHistory(rows) {
  return (rows || []).filter((r) => r.step_type === 'bot_message' || r.step_type === 'agent_reply').map((r) => ({
    who: r.step_type === 'agent_reply' ? 'agent' : 'bot', text: r.result?.text ?? '', buttons: r.result?.buttons || null,
    style: r.result?.style || null, agent_name: r.result?.agent_name || null }));
}
```
Export both + `IDLE_EXPIRE_MS`. In `index.js` `/web/session`, before the insert:
```js
        if (b.resume) {
          const s = await BW.loadSession(env, String(b.resume));
          if (s && s.bot_id === bot.id && BW.isResumable(s)) {
            const h = await A.sbComms(`/rest/v1/bot_session_steps?session_id=eq.${A.enc(s.id)}&step_type=in.(bot_message,agent_reply)&select=id,step_type,result&order=id.desc&limit=20`, env);
            return withCors(ok({ session_id: s.id, status: s.status, replies: [], history: BW.resumeHistory((h.ok ? h.data : []).reverse()) }));
          }
        }
```
In `bot-widget.js`: on start, read `localStorage.lot_chat_session` (`{session_id, bot_id}`), send `{ botId: BOT, resume: saved.session_id }`; on response, if `history` is present render each item (agent lines with the agent name, bot lines with buttons) and set `sessionId`; always write `{session_id: dd.session_id, bot_id: BOT}` back. When rendering bot buttons, if `style === 'list'` render them as a vertical stack of full-width buttons with the `description` under the label in smaller text. Keep line 18 exactly as it is.

In csops `handleRelayWebForward` (`index.js:6753-`), widen the thread select to `select=id,thread_state,customer_phone,customer_handle` and after the phone PATCH add:
```js
  if (thread && b.identity?.email && (!thread.customer_handle || thread.customer_handle === 'Web visitor')) {
    await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify({ customer_handle: String(b.identity.email).toLowerCase() }) }).catch(() => {});
  }
```
(csops is committed in Task 11 together with the rest of its changes.)

- [ ] **Step 4: Run** — `node test/web-resume.test.js && node test/web-cors-origin.test.js` → pass; full loop → nothing.

- [ ] **Step 5: Commit (commsops part)**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add commsops-worker/src/bot-web.js commsops-worker/src/index.js commsops-worker/src/bot-widget.js commsops-worker/test/web-resume.test.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: web bot — session resumes across navigation (bot/agent lines only), widget renders list menus; gate line untouched (spec §6)"
```

---

### Task 11: csops — `bot_active` rail, bot rows on the forward, exclusions

**Files:**
- Create: `csops-worker/src/bot-forward.js`
- Modify: `csops-worker/src/index.js` (`relayWaIngestInbound`, `handleRelayWebForward`, `getMessagingThreads:10338`, `getMessagingStats:10440+`, `retroAssignUnownedThreads:7848+`)
- Migration (MCP `apply_migration`): `cs_threads_bot_active_v1`
- Test: `csops-worker/src/bot-forward.test.mjs` (new)

**Interfaces:**
- Produces: `botOutboundRows({threadId, wabaPhoneNumberId, replies, now})` → uniform-key rows; `inboundRowKeys(row)` → the same row with `template_name: null` added (so the web bulk insert stays homogeneous); `botThreadPatch({session_status, handoff, thread, now})` → PATCH body. `store.cs_wa_threads.bot_active` + trigger `cs_wa_messages_clear_bot_active`. `closed_reason` accepts `bot_resolved`.

- [ ] **Step 1: Write the failing test**

`csops-worker/src/bot-forward.test.mjs`:
```js
// S355 — bot transcript rows + thread rail (spec §5.3, §5.5). Real imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botOutboundRows, botThreadPatch, flattenReply } from './bot-forward.js';

test('bot rows carry the relay_bot marker, no user, uniform keys, options flattened', () => {
  const rows = botOutboundRows({ threadId: 'T', wabaPhoneNumberId: 'PN', now: '2026-09-07T10:00:00.000Z',
    replies: [{ text: 'Hi', buttons: [{ id: 'a', label: 'Track' }, { id: 'b', label: 'Agent' }] }, { text: 'Bye', buttons: null }] });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.template_name, 'relay_bot'); assert.equal(r.sent_by_user_id, null); assert.equal(r.sent_by_name, 'Relay (bot)');
    assert.equal(r.direction, 'outbound'); assert.equal(r.status, 'sent'); assert.equal(r.waba_phone_number_id, 'PN'); assert.equal(r.is_internal, false);
    assert.deepEqual(Object.keys(r).sort(), Object.keys(rows[0]).sort());
  }
  assert.equal(rows[0].body, 'Hi\n1. Track\n2. Agent');
  assert.equal(flattenReply({ text: 'x', buttons: [] }), 'x');
});
test('thread patch: active -> bot_active; handoff -> open+unassigned; ended -> closed bot_resolved', () => {
  const now = '2026-09-07T10:00:00.000Z';
  assert.deepEqual(botThreadPatch({ session_status: 'active', handoff: false, thread: { thread_state: 'open' }, now }), { bot_active: true });
  const h = botThreadPatch({ session_status: 'handed_off', handoff: true, thread: { thread_state: 'closed' }, now });
  assert.equal(h.bot_active, false); assert.equal(h.thread_state, 'open'); assert.equal(h.closed_reason, null);
  const e = botThreadPatch({ session_status: 'ended', handoff: false, thread: { thread_state: 'open' }, now });
  assert.deepEqual(e, { bot_active: false, thread_state: 'closed', closed_at: now, closed_reason: 'bot_resolved', closed_by_user_id: null });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/csops-worker && node --test src/bot-forward.test.mjs` → fails on the missing module.

- [ ] **Step 3: Implement `bot-forward.js`**

```js
// Pure helpers for a bot-handled WhatsApp turn forwarded by commsops (S355, spec §5.3/§5.5).
// Kept out of index.js so the two load-bearing invariants are testable: the relay_bot marker
// (the awaiting-reply trigger reads it) and the bot_active rail (assignment + filters read it).
export function flattenReply(r) {
  const opts = Array.isArray(r?.buttons) && r.buttons.length ? '\n' + r.buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n') : '';
  return String(r?.text ?? '') + opts;
}
export function botOutboundRows({ threadId, wabaPhoneNumberId, replies, now }) {
  return (replies || []).map((r, i) => ({
    thread_id: threadId, direction: 'outbound', kind: 'text', body: flattenReply(r),
    template_name: 'relay_bot',              // THE marker: NOT-NULL template + NULL user = automated
    sent_by_user_id: null, sent_by_name: 'Relay (bot)', is_internal: false, status: 'sent',
    waba_phone_number_id: wabaPhoneNumberId || null,
    sent_at: new Date(new Date(now).getTime() + i + 1).toISOString(),   // strictly after the inbound
  }));
}
export function botThreadPatch({ session_status, handoff, thread, now }) {
  if (handoff || session_status === 'handed_off') {
    const p = { bot_active: false };
    if (thread?.thread_state && thread.thread_state !== 'open') Object.assign(p, { thread_state: 'open', closed_at: null, closed_by_user_id: null, snoozed_until: null, closed_reason: null, closed_note: null });
    return p;
  }
  if (session_status === 'ended') return { bot_active: false, thread_state: 'closed', closed_at: now, closed_reason: 'bot_resolved', closed_by_user_id: null };
  return { bot_active: true };
}
```

- [ ] **Step 4: Run** — `node --test src/bot-forward.test.mjs` → `pass 2`.

- [ ] **Step 5: Apply the csops migration via MCP**

Name `cs_threads_bot_active_v1`:
```sql
-- S355 — bot_active rail (spec §5.3). closed_reason CHECK widened in the SAME migration (CLAUDE.md enum rule).
ALTER TABLE store.cs_wa_threads ADD COLUMN IF NOT EXISTS bot_active boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS cs_wa_threads_bot_active_idx ON store.cs_wa_threads (bot_active) WHERE bot_active;
ALTER TABLE store.cs_wa_threads DROP CONSTRAINT IF EXISTS cs_wa_threads_closed_reason_check;
ALTER TABLE store.cs_wa_threads ADD CONSTRAINT cs_wa_threads_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN ('resolved','no_response','no_evidence','no_payment','duplicate','wrong_system','goodwill','no_action','other','bot_resolved'));
-- any human-authored outbound ends the bot's claim on the thread (every agent send path, one site)
CREATE OR REPLACE FUNCTION store.cs_clear_bot_active() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = store, public AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NEW.sent_by_user_id IS NOT NULL THEN
    UPDATE store.cs_wa_threads SET bot_active = false WHERE id = NEW.thread_id AND bot_active;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cs_wa_messages_clear_bot_active ON store.cs_wa_messages;
CREATE TRIGGER cs_wa_messages_clear_bot_active AFTER INSERT ON store.cs_wa_messages
  FOR EACH ROW EXECUTE FUNCTION store.cs_clear_bot_active();
NOTIFY pgrst, 'reload schema';
```
Verify: `select column_name from information_schema.columns where table_schema='store' and table_name='cs_wa_threads' and column_name='bot_active'; select pg_get_constraintdef(oid) from pg_constraint where conname='cs_wa_threads_closed_reason_check';` → column present, `bot_resolved` in the list.

- [ ] **Step 6: Wire `index.js`**

Add `import { botOutboundRows, botThreadPatch } from './bot-forward.js';` beside the other imports (~line 19-23).

In `relayWaIngestInbound`, immediately after the thread PATCH that sets `last_inbound_at`/`customer_window_until` and before the wrong-number redirect block, add:
```js
  // S355 — a bot-handled turn: write the bot's lines (tagged relay_bot), drive the bot_active rail,
  // and SKIP the redirect + out-of-hours auto-reply (the bot IS this inbound's auto-message).
  if (m?.bot?.handled) {
    if (!m.bot.duplicate) {
      const rows = botOutboundRows({ threadId: thread.id, wabaPhoneNumberId: m?.phone_number_id || thread.waba_phone_number_id || null, replies: m.bot.replies || [], now: ts });
      if (rows.length) {
        const bi = await sb('/rest/v1/cs_wa_messages', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
        if (!bi.ok) console.error('[relay-wa] bot rows insert failed', bi.status, JSON.stringify(bi.data)?.slice(0, 200));
      }
      const tp = botThreadPatch({ session_status: m.bot.session_status, handoff: !!m.bot.handoff, thread, now: ts });
      await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(tp) }).catch(() => {});
    }
    return { thread_id: thread.id, ticket_id: linkedTicketId, bot: true };
  }
```
⚠️ The early `return` skips the redirect, the OOO reply and the ticket-history note — deliberate (spec §5.5). Check the `ts`/`thread` variable names match the surrounding code (read 10 lines above).

In `handleRelayWebForward`, change the row mapping to add the marker with the SAME key on every row:
```js
    template_name: m.direction === 'outbound' ? 'relay_bot' : null,
```
(inside the existing `rows = b.messages.map(...)` object, next to `sent_by_name`).

In `getMessagingThreads` (line ~10338): `if (params.get('awaiting') === '1') q += `&awaiting_reply=is.true&bot_active=is.false`;`. In `getMessagingStats`: find every count that filters `awaiting_reply=is.true` (`grep -n "awaiting_reply" src/index.js` inside that function's range) and append `&bot_active=is.false` to each. In `retroAssignUnownedThreads` (~7855) add `+ \`&bot_active=is.false\`` to the query string after `assigned_agent_id=is.null`.

- [ ] **Step 7: Run the csops suite** — `node --test 'src/**/*.test.mjs' 2>&1 | grep -E '^ℹ (tests|pass|fail)'` → `fail 0`.

- [ ] **Step 8: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add csops-worker/src/bot-forward.js csops-worker/src/bot-forward.test.mjs csops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [pitstop]: relay-wa bot turns — relay_bot-tagged transcript rows, bot_active rail (active/handoff/ended→closed bot_resolved), redirect+OOO skipped; web forward tagged + email handle; awaiting/stats/retro-assign exclude bot_active (migration cs_threads_bot_active_v1)"
```

---

### Task 12: Pitstop inbox — Bot badge

**Files:**
- Modify: `apps/pitstop/src/app/(auth)/inbox/page.js:2888-2925` (`ThreadRow`)

- [ ] **Step 1: Add the badge**

In `ThreadRow`, in the badges row (`<div style={{ display: 'flex', gap: 5, marginTop: 4, flexWrap: 'wrap' }}>`), add as the first child:
```jsx
          {t.bot_active && <ToneBadge tone="mute" style={{ fontSize: 8.5 }} title="The Relay bot is handling this conversation">Bot</ToneBadge>}
```
`select=*` on the list query already returns `bot_active`.

- [ ] **Step 2: Build** — `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=@throttle/pitstop 2>&1 | tail -5` → `Tasks: 1 successful, 1 total`; grep the output for `Attempted import error` → none.

- [ ] **Step 3: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add "apps/pitstop/src/app/(auth)/inbox/page.js"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [pitstop]: inbox — Bot badge on bot_active threads"
```

---

### Task 13: Relay builder — palette, drawers, settings, lint mirror, test-panel sub-flow

**Files:**
- Modify: `apps/relay/src/components/journey-canvas/JourneyCanvas.js:168-175`, `journey-canvas/BotDrawer.js`, `journey-canvas/graph.js:30-42,124-135`, `journey-canvas/labels.js:24-26`, `bot-builder/BotBuilder.js`

**Interfaces:**
- Consumes: worker actions `listBots` (now with `config`), `saveBot` (accepts `channel`), `setBotMode`, `testBotTurn`, `getBot`.
- Produces: definitions saved with `keywords`, `menu.style/list_button/description`, `collect` `fallback` edge, `subflow.bot_id`, `action.text_exhausted`.

- [ ] **Step 1: Palette + labels + handles**

`JourneyCanvas.js` `BOT_NEW_STEP`: add `subflow: { type: 'subflow', bot_id: '' },` and change `menu` to `{ type: 'menu', style: 'buttons', text: '', buttons: [{ id: 'b_opt1', label: 'Option 1', description: '' }] }`. `labels.js`: add `subflow: 'Shared flow'` beside `menu/collect/handoff`. `graph.js` `handlesFor`: `if (cfg.type === 'collect') return ['next', 'fallback'];` and `if (cfg.type === 'subflow') return ['next'];` (before the `HANDLES[cfg.type]` fallback). Confirm `toDefinition`/`fromDefinition` carry unknown config keys through untouched (they spread `config`) — `grep -n "config" graph.js | head`.

- [ ] **Step 2: BotDrawer additions**

In the `menu` block add, above the options list:
```jsx
          <Field label="Show as">
            <select className="f-inp" value={c.style || 'buttons'} disabled={readOnly} onChange={(e) => set({ style: e.target.value })}>
              <option value="buttons">Buttons (WhatsApp: max 3, 20 chars)</option>
              <option value="list">List (WhatsApp: max 10 rows, 24-char titles)</option>
            </select>
          </Field>
          {c.style === 'list' && (
            <Field label="List button label"><input className="f-inp" value={c.list_button || ''} disabled={readOnly} placeholder="Choose" onChange={(e) => set({ list_button: e.target.value })} /></Field>
          )}
```
and inside each option row, when `c.style === 'list'`, a second input bound to `b.description` (add `setButtonDesc(i, description)` mirroring `setButton`). In the `collect` block, replace the hint with: *"Answers are validated — an invalid value re-asks once; a second miss follows the **Fallback** branch (wire it). Typing "agent" or another keyword at an invalid answer jumps to that keyword's step."* In the `action` block add:
```jsx
          <Field label="After 5 failed lookups, say (then hand to an agent)">
            <textarea className="f-inp" rows={2} value={c.text_exhausted || ''} disabled={readOnly} onChange={(e) => set({ text_exhausted: e.target.value })}
              placeholder="Let me connect you to our support team — a human will reply right here as soon as one is available." />
          </Field>
```
Add a `subflow` block: a `<select>` of shared bots — `BotDrawer` gains a `sharedBots` prop (`[{id,name,active_version}]`) passed from `BotBuilder` (`rows.filter((r) => r.channel === 'shared' && r.active_version)`); value `c.bot_id`; hint *"Jumps into a shared flow (published). When it ends, continues on this step's Next."* Update the `handoff` hint to: *"Ends the bot's part and places the conversation in the Pitstop inbox. The bot never speaks again in this conversation."*

- [ ] **Step 3: Bot settings in `BotBuilder.js`**

Add state `const [settings, setSettings] = useState(false);` and a `<Btn onClick={() => setSettings((s) => !s)}>Settings</Btn>` in the toolbar. When `settings` is true, the right panel shows a `BotSettings` component (same file):
```jsx
function BotSettings({ bot, setBot, sharedBots, canActivate, session, showToast }) {
  const def = bot.draft_definition || {};
  const keywords = Array.isArray(def.keywords) ? def.keywords : [];
  const setDef = (patch) => setBot((b) => ({ ...b, draft_definition: { ...(b.draft_definition || {}), ...patch } }));
  const [mode, setMode] = useState(bot.config?.mode || 'pilot');
  const [nums, setNums] = useState((bot.config?.pilot_numbers || []).join(', '));
  async function saveMode() {
    const r = await workerFetch('setBotMode', { id: bot.id, mode, pilot_numbers: nums.split(/[,\s]+/).filter(Boolean) }, session);
    const d = r?.data?.bot || r?.bot;
    if (d) { setBot((b) => ({ ...b, config: d.config })); showToast(mode === 'public' ? 'PUBLIC — every customer on the number will get the bot' : 'Pilot mode saved'); }
    else showToast(`Failed: ${r?.error || 'unknown'}`, 'error');
  }
  return (
    <div>
      <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">Channel</div>
        <select className="f-inp" value={bot.channel || 'web'} disabled={!!bot.active_version} onChange={(e) => setBot((b) => ({ ...b, channel: e.target.value }))}>
          <option value="web">Web widget</option><option value="whatsapp">WhatsApp (support number)</option><option value="shared">Shared flow (used by other bots)</option>
        </select>
        {bot.active_version && <div className="dim" style={{ fontSize: 12 }}>Fixed after first publish.</div>}
      </div>
      <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">Keywords (opening message, or an invalid answer) → step</div>
        {keywords.map((k, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input className="f-inp" placeholder="track, where is my order" value={(k.match || []).join(', ')}
              onChange={(e) => setDef({ keywords: keywords.map((x, j) => (j === i ? { ...x, match: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x)) })} />
            <input className="f-inp" style={{ maxWidth: 160 }} placeholder="step id" value={k.target || ''}
              onChange={(e) => setDef({ keywords: keywords.map((x, j) => (j === i ? { ...x, target: e.target.value.trim() } : x)) })} />
            <button className="btn" type="button" onClick={() => setDef({ keywords: keywords.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        {keywords.length < 20 && <button className="btn" type="button" onClick={() => setDef({ keywords: [...keywords, { match: [], target: '' }] })}>+ Add keyword</button>}
      </div>
      {bot.channel === 'whatsapp' && (
        <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">Rollout (activate permission)</div>
          <select className="f-inp" value={mode} disabled={!canActivate || !bot.id} onChange={(e) => setMode(e.target.value)}>
            <option value="pilot">Pilot — only the numbers below</option><option value="public">Public — every customer</option>
          </select>
          <input className="f-inp" style={{ marginTop: 6 }} placeholder="917709991011, 91..." value={nums} disabled={!canActivate || !bot.id} onChange={(e) => setNums(e.target.value)} />
          {canActivate && bot.id && <Btn onClick={saveMode} style={{ marginTop: 6 }}>Save rollout</Btn>}
          <div className="dim" style={{ fontSize: 12 }}>Answers on the support WhatsApp number. Public is Afshaan's call.</div>
        </div>
      )}
      {bot.channel === 'shared' && <div className="dim" style={{ fontSize: 12 }}>A shared flow has no customers of its own; other bots jump into it with a “Shared flow” step.</div>}
    </div>
  );
}
```
Keywords are part of the draft definition, so `currentDefinition()` must merge them: `return { ...toDefinition(nodes, edges), keywords: (bot?.draft_definition?.keywords || []).filter((k) => k.match?.length && k.target) };`. `save()` sends `channel: bot.channel`. `startNew()` seeds `channel: 'web'`. The list table already shows `channel`; add a `Badge label="pilot"/"public"` next to it for WhatsApp bots off `r.config?.mode`. `publishErrors` rendering: the code list is shown as-is (`wa_too_many_buttons` etc. are self-describing).

Test panel: in `TestPanel.turn`, after `setState(out.state)`, handle `subflow_enter`: if `out.effects?.some((e) => e.type === 'subflow_enter')`, fetch the shared bot via `garageFetch('getBot', { id: e.bot_id })`, then call `testBotTurn` again with `definition: shared.draft_definition`… ⚠️ `testBotTurn` on the worker runs ONE definition; to follow a sub-flow the panel passes `definition` = the shared bot's `draft_definition` on subsequent turns while a local `frameRef` is set, and on a `subflow_return` effect switches back and sends `{kind:'resume', from: e.return_step}` against the parent definition. Show a `sys` line `→ enters shared flow "<name>"` / `→ returns`. Keep the panel's transcript rendering of `buttons` as is; add `m.style === 'list'` → render buttons stacked.

- [ ] **Step 4: Client lint mirror (`graph.js localLint`)**

In the `mode === 'bot'` branch add:
```js
    for (const n of stepNodes) {
      const cfg = n.data?.config; if (cfg?.type !== 'menu') continue;
      const btns = cfg.buttons || [];
      if (cfg.style === 'list') { if (btns.length > 10) out.push(`${n.id}: a WhatsApp list holds at most 10 rows`); if (btns.some((b) => (b.label || '').length > 24)) out.push(`${n.id}: list row titles are max 24 characters on WhatsApp`); }
      else { if (btns.length > 3) out.push(`${n.id}: more than 3 buttons — switch this menu to a List`); if (btns.some((b) => (b.label || '').length > 20)) out.push(`${n.id}: button labels are max 20 characters on WhatsApp`); }
    }
```
(`localLint` has no channel; the warnings are advisory for every bot, the worker enforces per channel.)

- [ ] **Step 5: Build** — `npx turbo build --filter=@throttle/relay 2>&1 | tail -5` → `1 successful`; no `Attempted import error`.

- [ ] **Step 6: Commit**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add apps/relay/src/components/journey-canvas/JourneyCanvas.js apps/relay/src/components/journey-canvas/BotDrawer.js apps/relay/src/components/journey-canvas/graph.js apps/relay/src/components/journey-canvas/labels.js apps/relay/src/components/bot-builder/BotBuilder.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "S355 [relay]: builder — list menus, shared-flow step, collect fallback, text_exhausted, bot settings (channel, keywords, activate-gated rollout), WhatsApp lint mirror, test panel follows sub-flows (spec §7)"
```

---

### Task 14: Deploy, seed the bots, smoke

**Files:** none new. Uses MCP `execute_sql`, `tools/wait-deploy.sh`, the in-app browser.

- [ ] **Step 1: Push + deploy both workers (push must succeed first)**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/commsops-worker && npx wrangler deploy && npx wrangler deployments status | head -5
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/csops-worker && npx wrangler deploy && npx wrangler deployments status | head -5
```
Record both version ids.

- [ ] **Step 2: Wait for the two app deploys** (each ALONE, in background):
`tools/wait-deploy.sh relay <sha>` and `tools/wait-deploy.sh pitstop <sha>` — read each `VERDICT:` line; anything but exit 0 is not live.

- [ ] **Step 3: Seed the shared FAQ bot + the WhatsApp bot (SQL, mirrors publishBot)**

```sql
-- shared FAQ (structure only; copy is Pruthvi's)
with b as (
  insert into comms.bots (name, status, channel, draft_definition, config, created_by)
  values ('FAQ (shared)', 'draft', 'shared', '{}'::jsonb, '{}'::jsonb, 'S355') returning id)
select id from b;
```
Then with that id `<FAQ>` build the definition and publish:
```sql
update comms.bots set draft_definition = $${
 "entry":"topics","steps":{
  "topics":{"type":"menu","style":"list","list_button":"Topics","text":"What would you like to know?","buttons":[
    {"id":"b_ship","label":"Shipping time","description":"How long delivery takes"},
    {"id":"b_pay","label":"COD & payment","description":"Payment options and COD"},
    {"id":"b_war","label":"Warranty","description":"What is covered and for how long"},
    {"id":"b_ret","label":"Returns","description":"Return window and how to start one"},
    {"id":"b_play","label":"Playtime","description":"Battery life per charge"}],
   "outcomes":{"b_ship":"a_ship","b_pay":"a_pay","b_war":"a_war","b_ret":"a_ret","b_play":"a_play","fallback":"h"}},
  "a_ship":{"type":"message","text":"[Pruthvi: answer — shipping time]","outcomes":{"next":"e"}},
  "a_pay":{"type":"message","text":"[Pruthvi: answer — COD & payment options]","outcomes":{"next":"e"}},
  "a_war":{"type":"message","text":"[Pruthvi: answer — warranty]","outcomes":{"next":"e"}},
  "a_ret":{"type":"message","text":"[Pruthvi: answer — return window]","outcomes":{"next":"e"}},
  "a_play":{"type":"message","text":"[Pruthvi: answer — playtime]","outcomes":{"next":"e"}},
  "e":{"type":"end","outcomes":{}},
  "h":{"type":"handoff","outcomes":{}}}}$$::jsonb where id = '<FAQ>';
insert into comms.bot_versions (bot_id, version, definition, created_by) select id, 1, draft_definition, 'S355' from comms.bots where id='<FAQ>';
update comms.bots set active_version=1, status='active' where id='<FAQ>';
```
WhatsApp bot (`<WA>`), `pilot_numbers` = `917709991011` plus Pruthvi's number — read it from his Slack profile (`slack_read_user_profile U099BNH5PCZ`); if absent, seed Afshaan's only and note it in the wrap:
```sql
insert into comms.bots (name, status, channel, draft_definition, config, created_by) values ('Support assistant (WhatsApp)', 'draft', 'whatsapp', $${
 "entry":"greet","keywords":[
   {"match":["track","status","where is my order","tracking","delivery"],"target":"ask_order"},
   {"match":["cancel","return","refund","replace","agent","human","person"],"target":"h"}],
 "steps":{
  "greet":{"type":"menu","style":"buttons","text":"Hi! I'm the Legend of Toys assistant. How can I help?","buttons":[
    {"id":"b_track","label":"Track my order"},{"id":"b_faq","label":"FAQs"},{"id":"b_agent","label":"Chat with an agent"}],
   "outcomes":{"b_track":"ask_order","b_faq":"faq","b_agent":"h","fallback":"h"}},
  "ask_order":{"type":"collect","field":"order_number","prompt":"Please share your order number — it is on your confirmation, like #LOT48622.","outcomes":{"next":"status","fallback":"h"}},
  "status":{"type":"action","kind":"order_status","text_exhausted":"I could not verify that order. Let me connect you to our support team — a human will reply right here.","outcomes":{"found":"after","not_found":"retry"}},
  "retry":{"type":"menu","style":"buttons","text":"I could not find that order with this number. Try again, or talk to a person?","buttons":[
    {"id":"b_again","label":"Try again"},{"id":"b_agent2","label":"Chat with an agent"}],"outcomes":{"b_again":"ask_order","b_agent2":"h","fallback":"h"}},
  "after":{"type":"menu","style":"buttons","text":"Anything else?","buttons":[{"id":"b_faq2","label":"FAQs"},{"id":"b_agent3","label":"Chat with an agent"},{"id":"b_done","label":"No, thanks"}],
   "outcomes":{"b_faq2":"faq","b_agent3":"h","b_done":"bye","fallback":"bye"}},
  "faq":{"type":"subflow","bot_id":"<FAQ>","outcomes":{"next":"greet"}},
  "bye":{"type":"end","text":"Happy to help — just say hi any time.","outcomes":{}},
  "h":{"type":"handoff","text":"Connecting you to our support team — a human will reply right here as soon as one is available.","outcomes":{}}}}$$::jsonb,
 '{"mode":"pilot","pilot_numbers":["917709991011"]}'::jsonb, 'S355') returning id;
insert into comms.bot_versions (bot_id, version, definition, created_by) select id, 1, draft_definition, 'S355' from comms.bots where id='<WA>';
update comms.bots set active_version=1, status='active' where id='<WA>';
```
Then open `/journeys?mode=bot` in the in-app browser, open the WhatsApp bot and press **Publish** once — this runs the real `validateBotDef` with channel lint against the seed (expect v2, no errors). Add the FAQs button to the existing web bot via the builder (a `subflow` step to `<FAQ>` off its menu) — do NOT publish the web bot with placeholder copy; save as draft only.

- [ ] **Step 4: Smoke — WhatsApp, from Afshaan's number (7709991011) to +919880212323**

Precondition SQL: `select last_outbound_at, bot_active from store.cs_wa_threads where customer_phone='+917709991011' and waba_phone_number_id='1266501519877668';` — if `last_outbound_at` is within 12 h, the bot will not engage; note it and wait or close the gap (an agent must NOT reply). Then, message by message, checking after each:
1. `hi` → greeting with 3 buttons. SQL: one `bot_sessions` row `channel='whatsapp'`, `bot_session_steps` has `customer_message` with `provider_message_id`; `cs_wa_messages` has the inbound + 1 outbound `template_name='relay_bot'`; `cs_wa_threads.bot_active=true`, `awaiting_reply=true`, `last_outbound_at` unchanged.
2. tap **FAQs** → list of 5 topics (Meta list UI). Tap **Shipping time** → placeholder answer, then the greeting again. `bot_sessions.sub_bot_id` is NULL after the return; steps include `subflow_enter` + `subflow_return`.
3. tap **Track my order** → order prompt; send `#LOT49400` (the S312 smoke order, phone must match) → real status text; then **Anything else? → No, thanks** → goodbye. SQL: session `ended`, thread `thread_state='closed'`, `closed_reason='bot_resolved'`, `bot_active=false`.
4. `hi` again → new session (closed thread re-opened by the inbound). Send `zzz` at the order prompt twice → handoff copy. SQL: session `handed_off`; thread open, `bot_active=false`, unassigned, `awaiting_reply=true`. In Pitstop (in-app browser, STOP at a login wall and ask Afshaan): thread visible in **Unassigned** and **Awaiting**, no Bot badge, full transcript with `Relay (bot)` lines. Reply from the inbox → arrives on the phone; send `hi` → **no** bot reply (human active).
5. Re-send the step-1 webhook body to `POST https://commsops.afshaan.workers.dev/webhooks/whatsapp` with a valid signature is not practical — instead prove the claim path in SQL: `insert into comms.bot_session_steps (session_id, step_id, step_type, provider_message_id) values ('<session>', 'x', 'customer_message', '<pmid from step 1>')` must fail with 23505.
6. From a non-pilot number (ask Pruthvi to send `hi`, or use a second test SIM): no bot reply; normal behaviour. `STOP` from Afshaan's number → opt-out row written, no bot reply.
7. Retro-assign: wait one 10-minute tick with a fresh bot session active → the thread stays unassigned (`assigned_agent_id IS NULL`), Bot badge visible in the inbox list.

- [ ] **Step 5: Smoke — web** (`https://www.legendoftoys.com/?lotchat=1`, in-app browser): open chat → greeting → navigate to another product page → widget reopens with the same transcript (history) → send an email as identity → in Pitstop the thread's name is the email, not "Web visitor" → **Chat with an agent** → reply from Pitstop → appears in the widget. SQL: the web thread's bot rows carry `template_name='relay_bot'`.

- [ ] **Step 6: Record evidence** — session ids, message ids, the two worker version ids, the app shas, and any deviation, in the wrap notes (Task 15). If any step fails: fix → commit → push → redeploy → re-run that step; never mark the smoke passed from memory.

---

### Task 15: Knowledge layer + the reply to Pruthvi (draft only)

**Files:**
- Modify (root repo `/Users/afshaansiddiqui/Documents/Claude`): `systems/relay.md` §Bot builder (new sub-section "Two bots, one engine — S355"), `systems/pitstop.md` (bot_active rail + `bot_resolved`), `reference/db-schema.md` (new columns on `comms.bots/bot_sessions/bot_session_steps`, `store.cs_wa_threads.bot_active`, the `closed_reason` value, the trigger), `reference/decisions.md` (the `bot_resolved` close-on-self-serve call; `relay_bot` marker; pilot switch is activate-tier), `backlog/relay.md` (update the two items: the Web bot build item's ①② closed, ④ deferred with reason; the Pruthvi ask item → what is now owed), `archive/BACKLOG_ARCHIVE.md` if an item fully closes.

- [ ] **Step 1: Write the spoke + reference updates** with measured numbers stamped `(measured 2026-09-07)`, the worker version ids and shas from Task 14, and the residual list: hours-aware handoff copy deferred; `delay_ms` deferred; Pruthvi's answer copy pending; public flip pending (activate tier via Settings → Rollout, or `setBotMode`).

- [ ] **Step 2: Regenerate counts + commit root (path-scoped)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude && python3 tools/backlog-counts.py
git add systems/relay.md systems/pitstop.md reference/db-schema.md reference/decisions.md backlog/relay.md backlog/README.md
git diff --cached --stat   # account for every deletion before committing
git commit -m "S355 [relay]: two flow bots LIVE (WhatsApp staff pilot + web residuals) — spoke, schema, decisions, backlog"
git push
```

- [ ] **Step 3: Draft the Slack reply for Afshaan's go (do NOT send)**

Thread `#bugs` parent `1788433215.944179`. Draft, terse, per the team-comms memory:
> Both bots are built on one engine. WhatsApp: live on +919880212323 in pilot mode (staff numbers only) — greeting menu → Track my order / FAQs / Chat with an agent, keywords for track/cancel/agent, FAQ is a shared list both bots use. Web: same FAQ, session now survives page moves; still staff-only (`?lotchat=1`).
> From you: (1) the five FAQ answers — open Relay → Journeys → Bots → “FAQ (shared)”, edit the five answer steps, Publish. (2) Numbers for the pilot (yours + CS) — tell me, I add them. (3) Out of v1, as agreed: order changes, AI intent, Google Sheet, API-call node, auto-ticket on handoff (comes with the ticket redesign).
> Public rollout is Afshaan's call once you have run it on your number.

- [ ] **Step 4: Hostile review** — run `/hostile-review` over the session's diff (both repos, both migrations, the seed rows, the smoke claims) before wrap; fix and record findings.

---

## Self-review (done at plan-writing time)

**Spec coverage:** §1 CHECK → T1 · §2/§3.2 subflow → T5/T6 · §3.1 list → T2 · §3.3–3.4 → T3 · §3.5/§3.7 → T4 · §3 lint → T5/T7 · §4 four sites + `bot:` guard → T8/T9 · §5.1–5.4 → T9 · §5.5/§5.3 rail → T11 · §6 ①② → T10/T11 (④ deferred by spec) · §7 → T13 · §8 seed + smoke → T14 · §10 pinned tests → T11 (`bot-forward` covers the marker and the patch; the trigger itself is verified in T14 step 4 SQL) · Pitstop badge → T12. `bot_stats` channel filter from spec §7 is dropped: stats are per bot and a bot has one channel, so the list's channel column already answers it.

**Placeholders:** the `[Pruthvi: answer — …]` strings are deliberate content markers (spec §8). T9 step 6 and T8 step 2 tell the implementer to mirror a neighbouring test's harness rather than invent one; that is a real instruction, not a gap.

**Type consistency:** `executeTurn` returns `{out, stepRows, handoff, frame}` (T6) and is consumed with those names in T9 and T6 step 5; `sessionDefinition(env, session, deps)` in T6/T9; `maybeHandleInbound` → `{handled, session_id, session_status, replies, handoff}` (T9) consumed by `botOutboundRows/botThreadPatch` (T11) reading `m.bot.replies`, `m.bot.session_status`, `m.bot.handoff`, `m.bot.duplicate`; `setBotMode(env, id, body)` (T7) called from the UI as `workerFetch('setBotMode', {id, mode, pilot_numbers})` (T13); `renderStep` emits `style`/`list_button`/`description` (T2) read by `toSendOpts` (T9) and the widget (T10).
