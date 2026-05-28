# Pitstop Phase B — Calls, Departments, Multi-MyOp, Sheet Import

> Plan date: 2026-05-28
> Driven by: Pruthvi's CS ops walkthrough + OG Product Complaints sheet
> Source transcript: Customer Support Operations Review & Pit Stop System Walkthrough.txt
> Source dataset: ~/Downloads/OG Product Complaints.xlsx (871 historic rows, Feb–May 2026)

**Goal:** Make Pitstop the single source of truth for everything CS — every call (incl. missed/outbound across multiple MyOp accounts) becomes a row; every agent works inside a department; every historic 2026 complaint lives as a closed ticket so the R&R sheet can be retired.

**Architecture:**
- DB: new `store.cs_calls`, `store.myop_accounts`, `store.cs_departments`; FKs from `cs_tickets` / `cs_calls` / `users_profile`; CHECK additions.
- Worker (`csops`): webhook splits `cs_calls` from `cs_tickets`; new actions for calls list/detail, dept management, multi-MyOp registry, sheet import.
- Frontend (`apps/pitstop`): new `/calls` route + tabs; dept switcher in topbar; admin `/admin/myop` + `/admin/departments`.
- Deploy: `csops` worker → `cd 05_Throttle/csops-worker && npx wrangler deploy`. App → push to `main` (auto deploy).

**Tech stack:** Cloudflare Worker (vanilla JS, no framework), Next.js 14 static-export (pitstop app), Supabase PostgREST + RPCs, Tailwind-style inline CSS modules (per pitstop conventions).

**Verification model:** No unit test suite in this codebase — verification is `npx turbo build --filter=pitstop` (zero errors), `npx wrangler deploy` (clean), live curl tests against worker, browser smoke at `pitstop.legendoftoys.com`.

---

## Pre-work — schema confirmations (already done at plan-write time, 2026-05-28)

- `store.cs_tickets`: 53 cols. Has `legacy_sheet_ref` (text, nullable) — reuse for SHEET-IMPORT idempotency.
- `cs_tickets_intake_channel_check`: `phone | whatsapp | email | marketplace | walkin | other` — need to add `sheet`.
- `cs_tickets_closed_reason_check`: `resolved | duplicate | no_response | wrong_system | goodwill | rejected | no_action` — need to add `historical_import`.
- `cs_tickets_platform_check`: `website | amazon | cred | blinkit | instamart | marketplace | offline | zepto | investor | swiggy | other` — need to add `flipkart`. (`Krazy Caterpillar` → map to `other`.)
- `cs_issue_catalog`: 12 categories. Categories match the OG sheet vocabulary exactly. Subcategory matching by exact name only; combo-strings ("X, Y") fall through to `issue_subcategory_custom`.
- `store.customer_repairs`: 0 rows (safe to DROP).
- `users_profile`: has `team` (freeform text) but no FK — add `cs_department_id uuid`.
- Roles with `cs_ticket_manage`: `cs_agent`, `cs_lead`, `admin`, `super_admin`. Views only: `production_manager`, `store_head`.

---

## Task 0 — Drop store.customer_repairs

**Files:** none (SQL only).

**Migration:** `2026_05_28_drop_customer_repairs`

```sql
-- Confirm 0 rows then drop. Safety window already past (1+ week empty).
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM store.customer_repairs) <> 0 THEN
    RAISE EXCEPTION 'customer_repairs not empty — abort';
  END IF;
END $$;

DROP TABLE store.customer_repairs;
```

**Verify:** `SELECT to_regclass('store.customer_repairs')` returns NULL.

**Commit:** `db: drop empty store.customer_repairs (PITSTOP-CR-DROP)`

---

## Task 1 — Multi-MyOp account infrastructure

**Goal:** Multiple MyOperator accounts (main / ABC / Confirmation / future) syndicate to one Pitstop. Each account has its own webhook secret, slug, and DID. Every call + ticket carries an `myop_account_id` FK.

### 1.1 — Schema

**Migration:** `2026_05_28_myop_accounts`

```sql
CREATE TABLE store.myop_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,                   -- 'main' | 'abc' | 'confirm' | ...
  name          text NOT NULL,                          -- 'Main Support', 'ABC Outbound', 'Call Confirmation'
  did           text,                                   -- primary DID/caller ID
  owner_email   text,                                   -- account owner for callbacks/admin
  is_active     boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON store.myop_accounts TO service_role;

-- Seed the existing live account
INSERT INTO store.myop_accounts (slug, name, did, is_active)
VALUES ('main', 'Main Support', NULL, true);

-- Add FK to cs_tickets (nullable for back-compat with non-call tickets)
ALTER TABLE store.cs_tickets
  ADD COLUMN myop_account_id uuid REFERENCES store.myop_accounts(id);

CREATE INDEX cs_tickets_myop_account_idx ON store.cs_tickets(myop_account_id);

-- Backfill existing call-derived tickets to 'main'
UPDATE store.cs_tickets
SET myop_account_id = (SELECT id FROM store.myop_accounts WHERE slug='main')
WHERE call_session_id IS NOT NULL;
```

### 1.2 — Worker secrets

Each account uses env var `MYOP_WEBHOOK_SECRET_<UPPER_SLUG>`. Existing single secret `MYOP_WEBHOOK_SECRET` becomes the fallback for slug=`main` only (back-compat).

```bash
# After deploy, set per-slug secrets as accounts are added:
cd 05_Throttle/csops-worker
npx wrangler secret put MYOP_WEBHOOK_SECRET_MAIN   # = current MYOP_WEBHOOK_SECRET value
# Future: npx wrangler secret put MYOP_WEBHOOK_SECRET_ABC, etc.
```

### 1.3 — Webhook URL change

Old: `POST /webhooks/myoperator` with `X-Webhook-Token`.

New: `POST /webhooks/myoperator?account=<slug>` with `X-Webhook-Token: <per-slug-secret>`.

- Missing `?account` parameter → treat as `account=main` (back-compat — MyOperator existing config stays working until we update it).
- Unknown slug → 404.
- Wrong secret for slug → 401.

**File:** `05_Throttle/csops-worker/src/index.js`

Replace `verifyWebhook()` + `handleMyOperatorWebhook()` with account-aware versions:

```javascript
async function resolveMyopAccount(slug, env) {
  const r = await sb(`/rest/v1/myop_accounts?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=*&limit=1`, env);
  return r.data?.[0] || null;
}

function expectedSecretForSlug(slug, env) {
  // MYOP_WEBHOOK_SECRET_<UPPER_SLUG>; fallback to legacy MYOP_WEBHOOK_SECRET when slug='main'
  const key = `MYOP_WEBHOOK_SECRET_${slug.toUpperCase().replace(/-/g, '_')}`;
  return env[key] || (slug === 'main' ? env.MYOP_WEBHOOK_SECRET : null);
}

async function handleMyOperatorWebhook(request, env) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('account') || 'main';
  const account = await resolveMyopAccount(slug, env);
  if (!account) return err(`Unknown MyOp account slug: ${slug}`, 404);

  const expected = expectedSecretForSlug(slug, env);
  const provided = url.searchParams.get('token') || request.headers.get('X-Webhook-Token');
  if (!expected || provided !== expected) return err('Invalid webhook signature', 401);

  let body = {};
  try { body = await request.json(); } catch { return err('Bad JSON', 400); }
  const type = body.event_type;
  console.log(`[myop:${slug}] ${type} session=${body.session_id || '?'} dir=${body.direction || '?'}`);

  if (type === 'call.answered' || type === 'call.responded') return webhookCallAnswered(body, env, account);
  if (type === 'call.end'      || type === 'call.ended')     return webhookCallEnd(body, env, account);
  if (type === 'call.summary')                                return webhookCallSummary(body, env, account);
  return json({ ok: true, ignored: type });
}
```

Every downstream webhook handler accepts `account` and writes `myop_account_id: account.id` to both `cs_calls` and `cs_tickets`.

### 1.4 — Worker actions

```javascript
case 'getMyopAccounts':   return getMyopAccounts(params, auth, env);  // GET, cs_ticket_view
case 'createMyopAccount': return createMyopAccount(body, auth, env);  // POST, cs_ticket_admin
case 'updateMyopAccount': return updateMyopAccount(body, auth, env);  // POST, cs_ticket_admin
```

Body shape for create/update: `{ slug, name, did?, owner_email?, is_active?, notes? }`. Slug validated as `^[a-z][a-z0-9_-]{1,30}$`.

### 1.5 — Frontend admin page

**File:** `05_Throttle/apps/pitstop/src/app/(auth)/admin/myop/page.js` (new)

- Table of accounts; columns: slug, name, did, owner_email, active, created.
- "+ New Account" modal with slug + name + did + owner_email.
- "Edit" inline; activate/deactivate toggle.
- After-create modal shows the webhook URL string to copy to MyOp config: `https://csops.afshaan.workers.dev/webhooks/myoperator?account=<slug>` and reminds to set `MYOP_WEBHOOK_SECRET_<UPPER_SLUG>` via wrangler.

Add to `nav.js` under an "Admin" group, gated to `cs_ticket_admin`.

**Commit:** `feat(pitstop): multi-MyOperator account registry + per-account webhooks`

---

## Task 2 — CS Departments

**Goal:** Inbound / Outbound (ABC) / Call Confirmation / Messaging as first-class entities. Each user belongs to one department; queue + calls views default-filter by it. Admin can switch.

### 2.1 — Schema

**Migration:** `2026_05_28_cs_departments`

```sql
CREATE TABLE store.cs_departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON store.cs_departments TO service_role;

INSERT INTO store.cs_departments (slug, name, sort_order) VALUES
  ('inbound',     'Inbound',            10),
  ('outbound',    'Outbound (ABC)',     20),
  ('confirm',     'Call Confirmation',  30),
  ('messaging',   'Messaging (WA/IG/Email)', 40);

-- users_profile gets a nullable FK; admins/super-admins may have NULL (cross-dept)
ALTER TABLE store.users_profile
  ADD COLUMN cs_department_id uuid REFERENCES store.cs_departments(id);

-- cs_tickets gets a nullable FK; auto-set on auto-creation per myop_account.default_department_id
ALTER TABLE store.cs_tickets
  ADD COLUMN cs_department_id uuid REFERENCES store.cs_departments(id);

-- myop_accounts get a default_department_id so call tickets land in the right dept
ALTER TABLE store.myop_accounts
  ADD COLUMN default_department_id uuid REFERENCES store.cs_departments(id);

-- Seed: main account → Inbound by default
UPDATE store.myop_accounts SET default_department_id =
  (SELECT id FROM store.cs_departments WHERE slug='inbound')
WHERE slug='main';

CREATE INDEX cs_tickets_dept_idx ON store.cs_tickets(cs_department_id);
CREATE INDEX users_profile_dept_idx ON store.users_profile(cs_department_id);
```

### 2.2 — Worker actions

```javascript
// Reads
case 'getDepartments':       return getDepartments(params, auth, env);  // cs_ticket_view
case 'getMyDepartment':      return ok(await fetchUserDept(auth, env));  // shorthand

// Writes — admin only
case 'createDepartment':     return createDepartment(body, auth, env);  // cs_ticket_admin
case 'updateDepartment':     return updateDepartment(body, auth, env);
case 'assignUserDepartment': return assignUserDepartment(body, auth, env); // body: { user_id, department_id }
```

Update `getTickets()` and the new `getCalls()`:
- Accept `department` query param (slug or id).
- When omitted AND user has `cs_department_id` AND user lacks `cs_ticket_admin`, auto-filter to user's department.
- When `department=all` (admin only), no filter.

Update `createTicket()` and `webhookCallAnswered()`:
- If body provides `cs_department_id`, use it; else fall back to `myop_account.default_department_id`; else NULL.

### 2.3 — Frontend

- **Topbar dept switcher** (`apps/pitstop/src/app/(auth)/layout.js`): visible to `cs_ticket_admin`. Pill with current dept + dropdown. Stored in `localStorage` as `pitstop.dept` (`<slug>` or `all`). For non-admins, switcher is hidden and dept is locked to their own.
- **Admin page** `apps/pitstop/src/app/(auth)/admin/departments/page.js` — list + create + assign-user.
- **User assign** lives on the same admin page: table of users with department dropdown.

**Lib helper:** `apps/pitstop/src/lib/department.js`

```javascript
const KEY = 'pitstop.dept';

export function getActiveDept(user) {
  // For admins: read localStorage. For others: locked to user.cs_department_slug
  if (user?.permissions?.cs_ticket_admin) {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(KEY) || null; // null = all
  }
  return user?.cs_department_slug || null;
}

export function setActiveDept(slug) {
  if (typeof window === 'undefined') return;
  if (!slug) window.localStorage.removeItem(KEY);
  else window.localStorage.setItem(KEY, slug);
}
```

Wire into `getTickets()` / `getCalls()` call sites — append `&department=<slug>` query param when non-null.

### 2.4 — `getMe` extension

Worker `verifyJWT()` already returns `permissions`. Extend the JWT verify to also return `cs_department_slug` (join via `users_profile.cs_department_id`):

```javascript
// In verifyJWT, after profile fetch:
let cs_department_slug = null;
if (profile.cs_department_id) {
  const d = await sb(`/rest/v1/cs_departments?id=eq.${profile.cs_department_id}&select=slug,name&limit=1`, env);
  cs_department_slug = d.data?.[0]?.slug || null;
}
return { ..., cs_department_id: profile.cs_department_id, cs_department_slug };
```

**Commit:** `feat(pitstop): CS departments + dept-scoped queues + topbar switcher`

---

## Task 3 — cs_calls table + webhook refactor

**Goal:** Every call event (answered, missed, abandoned, outbound) gets a `cs_calls` row. Tickets are still auto-created only for `duration > 0`. Missed calls live in cs_calls and surface in the Calls view's "Missed" tab.

### 3.1 — Schema

**Migration:** `2026_05_28_cs_calls`

```sql
CREATE TABLE store.cs_calls (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  myop_account_id          uuid REFERENCES store.myop_accounts(id),
  cs_department_id         uuid REFERENCES store.cs_departments(id),
  call_session_id          text NOT NULL,                  -- MyOp session id, idempotency key
  direction                text CHECK (direction IN ('incoming','outgoing')),
  did                      text,                            -- caller ID / DID
  customer_phone           text,                            -- normalized E.164
  customer_name            text,                            -- resolved later from ticket / shopify
  agent_user_id            uuid,                            -- assigned/handling agent (from call.summary)
  agent_name               text,
  status                   text NOT NULL CHECK (status IN ('answered','missed','abandoned','in_progress')),
  duration_seconds         integer,
  recording_filename       text,
  recording_url            text,
  started_at               timestamptz,                     -- call.answered timestamp
  ended_at                 timestamptz,                     -- call.end timestamp
  ticket_id                bigint REFERENCES store.cs_tickets(id),  -- nullable; set for answered + later for callback-converted
  called_back_at           timestamptz,                     -- for missed calls marked called-back
  called_back_by_user_id   uuid,
  called_back_note         text,
  myop_client_ref_id       text,
  raw_meta                 jsonb,                            -- diagnostic envelope dump (small)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (myop_account_id, call_session_id)
);
GRANT ALL ON store.cs_calls TO service_role;

CREATE INDEX cs_calls_status_idx        ON store.cs_calls(status);
CREATE INDEX cs_calls_direction_idx     ON store.cs_calls(direction);
CREATE INDEX cs_calls_started_at_idx    ON store.cs_calls(started_at DESC);
CREATE INDEX cs_calls_phone_idx         ON store.cs_calls(customer_phone);
CREATE INDEX cs_calls_agent_idx         ON store.cs_calls(agent_user_id);
CREATE INDEX cs_calls_dept_idx          ON store.cs_calls(cs_department_id);
CREATE INDEX cs_calls_ticket_idx        ON store.cs_calls(ticket_id);

-- updated_at autobump
CREATE TRIGGER cs_calls_updated_at
  BEFORE UPDATE ON store.cs_calls
  FOR EACH ROW EXECUTE FUNCTION store.set_updated_at();
```

(`store.set_updated_at` already exists — check via `SELECT proname FROM pg_proc WHERE proname='set_updated_at'`. If absent, use a generic trigger function.)

### 3.2 — Webhook refactor

**File:** `05_Throttle/csops-worker/src/index.js`

`webhookCallAnswered(body, env, account)` — now writes both `cs_calls` (status=`answered`) and `cs_tickets`:

```javascript
async function webhookCallAnswered(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return err('missing session_id', 400);

  // 1. Upsert cs_calls row (always — even before we know if ticket should exist)
  const phone = toE164(c.phone);
  const existingCall = await sb(
    `/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id,ticket_id&limit=1`,
    env);
  if (!existingCall.data?.[0]) {
    await sb(`/rest/v1/cs_calls`, env, {
      method: 'POST',
      body: JSON.stringify({
        myop_account_id: account.id,
        cs_department_id: account.default_department_id,
        call_session_id: c.session_id,
        direction: c.direction,
        did: c.did,
        customer_phone: phone,
        status: 'answered',
        started_at: c.timestamp || new Date().toISOString(),
        raw_meta: { event: 'answered' },
      }),
    });
  }

  // 2. Upsert ticket (existing behaviour, parameterised on account)
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id,ticket_no&limit=1`, env);
  if (existing.data?.[0]) return json({ ok: true, deduped: true, ticket_no: existing.data[0].ticket_no });

  const agentEmail = agentEmailFromLegs(c.legs);
  const [agent, shop] = await Promise.all([ resolveAgentByEmail(agentEmail, env), shopifyLookup({ phone }, env) ]);

  const year = String(new Date().getFullYear());
  const seqRes = await sb(`/rest/v1/rpc/next_cs_ticket_seq`, env, { method: 'POST', body: JSON.stringify({ p_year: year }) });
  if (!seqRes.ok) return err('seq failed', 500);
  const seq = Number(seqRes.data);
  if (!Number.isFinite(seq) || seq <= 0) return err('seq invalid', 500);
  const ticket_no = `CS-${year}-${String(seq).padStart(5, '0')}`;

  const ins = await sb(`/rest/v1/cs_tickets`, env, { method: 'POST', body: JSON.stringify({
    ticket_no, call_session_id: c.session_id, auto_created: true,
    myop_account_id: account.id,
    cs_department_id: account.default_department_id,
    created_by_user_id: null, created_by_name: 'MyOperator (auto)',
    intake_channel: 'phone', call_direction: c.direction, call_did: c.did,
    call_answered_at: c.timestamp || new Date().toISOString(),
    customer_name: shop.found ? shop.customer.name : (phone ? `Caller ${phone}` : 'Unknown caller'),
    customer_phone: phone, customer_email: shop.found ? shop.customer.email : null,
    disposition: 'pending', issue_description: '[Pending — auto-created from call]',
    due_at: new Date(Date.now() + (SLA_DAYS['pending'] ?? 7) * 24 * 60 * 60 * 1000).toISOString(),
    assigned_agent_id: agent.id, assigned_agent_name: agent.name,
    stage: 'intake',
  }) });
  if (!ins.ok) return err(`insert failed: ${JSON.stringify(ins.data)}`, ins.status);

  // 3. Backfill cs_calls.ticket_id
  await sb(`/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ ticket_id: ins.data[0].id, agent_user_id: agent.id, agent_name: agent.name, customer_name: shop.found ? shop.customer.name : null }),
  });

  await insertHistorySystem(ins.data[0].id, 'ticket_created', null, ticket_no, 'auto-created from call', env);
  return json({ ok: true, ticket_no });
}
```

`webhookCallEnd(body, env, account)` — patches cs_calls with duration/recording/end timestamp; only escalates to ticket if duration > 0:

```javascript
async function webhookCallEnd(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return err('missing session_id', 400);
  const answered = Number(c.duration) > 0;

  // 1. Upsert cs_calls (insert with status='missed' if no prior row, else patch)
  const existing = await sb(
    `/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id&limit=1`,
    env);

  const callPatch = {
    ended_at: c.timestamp || new Date().toISOString(),
    duration_seconds: c.duration,
    recording_filename: c.recording_filename,
    myop_client_ref_id: c.client_ref_id,
    status: answered ? 'answered' : 'missed',
  };

  if (!existing.data?.[0]) {
    // Out-of-order: call.end before call.answered. If answered=true we still create + (below) create ticket.
    await sb(`/rest/v1/cs_calls`, env, {
      method: 'POST',
      body: JSON.stringify({
        myop_account_id: account.id,
        cs_department_id: account.default_department_id,
        call_session_id: c.session_id,
        direction: c.direction,
        did: c.did,
        customer_phone: toE164(c.phone),
        ...callPatch,
        started_at: null,
        raw_meta: { event: 'end-no-answered' },
      }),
    });
  } else {
    await sb(`/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
      method: 'PATCH', body: JSON.stringify(callPatch),
    });
  }

  // 2. Ticket: patch if exists, create if answered + no existing
  const existingTicket = await sb(
    `/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id&limit=1`, env);
  const ticketPatch = {
    call_ended_at: c.timestamp || new Date().toISOString(),
    call_duration_seconds: c.duration,
    call_recording_filename: c.recording_filename,
    myop_client_ref_id: c.client_ref_id,
  };
  if (existingTicket.data?.[0]) {
    await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
      method: 'PATCH', body: JSON.stringify(ticketPatch),
    });
    return json({ ok: true, patched: true });
  }
  if (!answered) return json({ ok: true, skipped: 'unanswered — call row only, no ticket' });

  // Answered out-of-order: create ticket via answered handler, then patch end fields
  const created = await webhookCallAnswered(body, env, account);
  const createdData = await created.clone().json().catch(() => null);
  if (!createdData?.ok) return created;
  await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
    method: 'PATCH', body: JSON.stringify(ticketPatch),
  });
  return created;
}
```

`webhookCallSummary(body, env, account)` — backfill agent on both cs_calls and cs_tickets:

```javascript
async function webhookCallSummary(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return json({ ok: true, skipped: 'no session_id' });
  const agentEmail = agentEmailFromLegs(c.legs);
  if (!agentEmail) return json({ ok: true, skipped: 'no agent email' });
  const agent = await resolveAgentByEmail(agentEmail, env);
  if (!agent.id) return json({ ok: true, skipped: `agent email not matched: ${agentEmail}` });

  // Patch cs_calls
  await sb(`/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ agent_user_id: agent.id, agent_name: agent.name }),
  });

  // Patch ticket (if exists)
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id&limit=1`, env);
  const t = existing.data?.[0];
  if (t) {
    await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
      method: 'PATCH', body: JSON.stringify({ assigned_agent_id: agent.id, assigned_agent_name: agent.name }),
    });
    await insertHistorySystem(t.id, 'assigned_agent_name', null, agent.name, 'auto-assigned from call.summary', env);
  }
  return json({ ok: true, assigned: agent.name });
}
```

### 3.3 — Worker read actions

```javascript
case 'getCalls':       return getCalls(params, auth, env);       // list with filters
case 'getCall':        return getCall(params, auth, env);        // detail by id
case 'getCallsKpis':   return getCallsKpis(params, auth, env);   // tiles for Calls view header
```

`getCalls()` filters: `tab` (my/unassigned/missed/all), `direction`, `status`, `account` (slug), `department` (slug), `from`, `to`, `search`, `limit`, `offset`. Dept default-applied per Task 2.4 logic.

### 3.4 — Worker write actions

```javascript
case 'markCalledBack':     return markCalledBack(body, auth, env);   // body: { call_id, note? }
case 'createTicketFromCall': return createTicketFromCall(body, auth, env);  // body: { call_id, ...newTicketFields }
```

`markCalledBack`: stamps `called_back_at`, `called_back_by_user_id=auth.userId`, `called_back_note`. Idempotent (no error if already stamped, just updates note).

`createTicketFromCall`: thin wrapper. Loads call, prefills phone + call_session_id + direction + did + account, then runs the existing `createTicket()` logic. After ticket created, patches `cs_calls.ticket_id`.

**Commit:** `feat(pitstop): cs_calls table + webhook split (calls now independent of tickets)`

---

## Task 4 — `/calls` route — Calls view

**Goal:** Pruthvi's "My / Unassigned / All" mental model, plus a Missed tab. List view with row actions for callback / convert-to-ticket. Replaces the admin-only MyOp dashboard view of missed calls.

### 4.1 — Files

- Create: `apps/pitstop/src/app/(auth)/calls/page.js`
- Create: `apps/pitstop/src/app/(auth)/calls/detail/page.js`
- Modify: `apps/pitstop/src/lib/nav.js` (add Calls)
- Create: `apps/pitstop/src/components/CallStatusBadge.js`
- Create: `apps/pitstop/src/components/CallbackModal.js`

### 4.2 — `calls/page.js` UX spec

**Header tiles (from getCallsKpis):**
- Calls today (incoming + outgoing)
- Answered today | Missed today | Answer rate %
- My open calls (incoming missed assigned to me, OR answered with linked open ticket assigned to me)
- Unanswered awaiting callback (status=missed AND called_back_at IS NULL)

**Tabs:**
- My — `agent_user_id=me` OR `ticket_id` joins to a ticket where `assigned_agent_id=me`
- Unassigned — `agent_user_id IS NULL AND ticket_id IS NULL`
- Missed — `status='missed' AND called_back_at IS NULL`
- All — no preset

**Filters (above the table):**
- Date range (default last 7 days)
- Direction (in / out)
- Status (answered / missed / abandoned)
- MyOp account (multi-select)
- Department (single, admin-only)
- Search (phone / customer name)

**Table columns:**
- Time (started_at or ended_at)
- Direction icon (↓ in / ↑ out)
- Phone
- Customer (name if resolved, else `Caller +91XXXXXXXXXX`)
- Agent (assigned_agent_name)
- Duration (mm:ss or "—" for missed)
- Status badge
- Linked ticket (CS-2026-NNNNN or "—")
- Actions (kebab):
  - **Missed + no ticket:** "Create Ticket", "Mark Called Back"
  - **Answered:** "Open Ticket" (if linked) or "Create Ticket" (rare — answered without ticket because duration=0 edge case)

**Pagination:** 50 per page, "Load more" button.

**Polling:** Auto-refresh every 30s (visible-tab only). MyOp webhooks deliver near-real-time; 30s gives agents fresh state without thrash.

### 4.3 — `calls/detail/page.js` UX

Drawer-style page (query string `?id=<uuid>`):
- Header: phone, time, status badge, duration
- Caller card: name + Shopify enrichment if known
- Audio player: `recording_url` if resolved (deferred — placeholder for now)
- Timeline: started, ended, called back (if any), agent assigned (if any), ticket created (if any)
- Linked ticket button → `/queue/detail?ticket_no=...`
- Actions: Create Ticket / Mark Called Back / Reassign Agent

### 4.4 — CallStatusBadge component

```javascript
const STYLES = {
  answered:   { bg: 'rgba(34,197,94,0.15)',  color: '#16a34a', label: 'Answered' },
  missed:     { bg: 'rgba(239,68,68,0.15)',  color: '#dc2626', label: 'Missed' },
  abandoned:  { bg: 'rgba(245,158,11,0.15)', color: '#d97706', label: 'Abandoned' },
  in_progress:{ bg: 'rgba(99,102,241,0.15)', color: '#4f46e5', label: 'Live' },
};
export default function CallStatusBadge({ status }) {
  const s = STYLES[status] || STYLES.abandoned;
  return <span style={{ background: s.bg, color: s.color, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{s.label}</span>;
}
```

### 4.5 — Nav

`apps/pitstop/src/lib/nav.js` — insert after Queue:

```javascript
{ href: '/calls', label: 'Calls', perm: 'cs_ticket_view' },
```

**Commit:** `feat(pitstop): /calls view with My/Unassigned/Missed/All tabs + callback flow`

---

## Task 5 — Reports — Calls section

**Goal:** Surface call telemetry on `/reports` to drive ops coaching (answer rate, agent load, dept split, ABC vs Inbound).

### 5.1 — Worker

New action `getCallReports`:

```javascript
case 'getCallReports': {
  const g2 = require('cs_reports_view', auth); if (g2) return g2;
  return getCallReports(params, auth, env);
}
```

Implementation: single fetch on `cs_calls` within `from..to`, then aggregate in-memory (same pattern as `getReports`). Returned shape:

```javascript
{
  range: { from, to },
  totals: { total, answered, missed, abandoned, answer_rate_pct, avg_duration_seconds },
  daily: [{ date, in_total, in_answered, out_total, out_answered }],   // last 30 days max
  by_account: [{ slug, name, total, answered, missed, answer_rate_pct }],
  by_department: [{ slug, name, total, answered, missed, answer_rate_pct, avg_handle_seconds }],
  by_agent: [{ name, answered_calls, missed_returned, avg_handle_seconds, tickets_opened }],
  by_direction: { incoming: {...}, outgoing: {...} },
  hourly: [{ hour, count }],   // 0..23 stacked
}
```

### 5.2 — Frontend

Modify `apps/pitstop/src/app/(auth)/reports/page.js`:
- Add tab toggle: "Tickets" (current view) / "Calls" (new).
- New Calls panel renders:
  - 4 KPI tiles (Total, Answered, Missed, Answer Rate)
  - Daily stacked bar (Recharts — already in package.json? if not, simple flex-bar div approach to avoid new dep)
  - By Account table
  - By Department table
  - By Agent table
  - Hourly histogram (24 columns)

Use the same color palette + table style as Tickets panel for consistency.

**Commit:** `feat(pitstop): Calls section in reports — volume / answer rate / by agent + dept`

---

## Task 6 — PITSTOP-SHEET-IMPORT (871 historic rows)

**Goal:** Import every historic complaint as a closed `cs_tickets` row so the R&R sheet can be retired. Idempotent on `legacy_sheet_ref`. Run once locally, generate SQL, apply via `apply_migration`.

### 6.1 — CHECK constraint extensions

**Migration:** `2026_05_28_cs_tickets_check_extensions`

```sql
-- Drop and recreate to add new allowed values
ALTER TABLE store.cs_tickets DROP CONSTRAINT cs_tickets_intake_channel_check;
ALTER TABLE store.cs_tickets ADD CONSTRAINT cs_tickets_intake_channel_check
  CHECK (intake_channel = ANY (ARRAY['phone','whatsapp','email','marketplace','walkin','sheet','other']));

ALTER TABLE store.cs_tickets DROP CONSTRAINT cs_tickets_closed_reason_check;
ALTER TABLE store.cs_tickets ADD CONSTRAINT cs_tickets_closed_reason_check
  CHECK ((closed_reason IS NULL) OR (closed_reason = ANY (
    ARRAY['resolved','duplicate','no_response','wrong_system','goodwill','rejected','no_action','historical_import']
  )));

ALTER TABLE store.cs_tickets DROP CONSTRAINT cs_tickets_platform_check;
ALTER TABLE store.cs_tickets ADD CONSTRAINT cs_tickets_platform_check
  CHECK (platform = ANY (
    ARRAY['website','amazon','cred','blinkit','instamart','marketplace','offline','zepto','investor','swiggy','flipkart','other']
  ));
```

### 6.2 — Generator script

**File:** `05_Throttle/scripts/import-og-complaints.py` (new — one-shot script)

Steps it performs:
1. Read `~/Downloads/OG Product Complaints.xlsx` Complaints sheet (`header=3`).
2. Drop rows where `Order ID`, `Date`, or `Customer Name` are blank.
3. Build dedup key per row: `legacy_sheet_ref = SHA1(Order ID || '|' || Date || '|' || phone_e164)`.
4. Phone normalisation: digits-only; if len=10 prefix `+91`; if len=12 starts with `91` prefix `+`; else `+digits`.
5. Channel → platform map: `Website→website, Amazon→amazon, CRED→cred, Swiggy→swiggy, Zepto→zepto, Blinkit→blinkit, Flipkart→flipkart, Offline→offline, Instamart→instamart, Krazy Caterpillar→other`. Null → `other`.
6. Issue Category → `issue_category` (verbatim — all 12 already match catalog).
7. Issue Sub-Category:
   - If exact match in `cs_issue_catalog` for that category → `issue_subcategory` = value, `issue_subcategory_custom` = NULL.
   - Else (combo strings, custom values) → `issue_subcategory` = 'Other', `issue_subcategory_custom` = full sheet value.
8. Product → `product` (verbatim — already canonical: Shadow/Knox/Flare/etc.).
9. Product Category (LOT-DX, LOT-OR, ...) → `product_sku` (these are SKU prefixes).
10. Mint `ticket_no = CS-2026-NNNNN` from `store.next_cs_ticket_seq('2026')` — consume real sequence numbers (these ARE legit 2026 cases).
11. Build single multi-row INSERT (or 50-row batches to stay under PostgREST limits) with:
    ```
    ticket_no, created_at=<Date>T00:00:00Z, created_by_user_id=NULL,
    created_by_name='Sheet Import 2026-05-28', intake_channel='sheet',
    customer_name, customer_phone, customer_email, platform,
    external_order_id, product, product_sku,
    issue_category, issue_subcategory, issue_subcategory_custom,
    issue_description, disposition='no_action', stage='closed',
    stage_changed_at=<Date>T00:00:00Z, closed_at=<Date>T00:00:00Z,
    closed_reason='historical_import', auto_created=true,
    legacy_sheet_ref=<sha1>
    ```
12. Idempotency: before each batch, `SELECT legacy_sheet_ref FROM cs_tickets WHERE legacy_sheet_ref IN (...)` and skip already-present hashes.

Script output: a `.sql` file with the INSERT statements, ready to apply via `mcp__plugin_supabase_supabase__apply_migration`.

### 6.3 — Apply

Run the script locally; review the diff of generated SQL; apply via Supabase MCP `apply_migration` with name `2026_05_28_import_og_complaints_2026_h1`.

Post-apply validation:
```sql
SELECT COUNT(*), MIN(created_at)::date, MAX(created_at)::date
FROM store.cs_tickets
WHERE legacy_sheet_ref IS NOT NULL AND closed_reason='historical_import';
-- Expect ~870 rows, Feb 14 → May 27 2026
```

### 6.4 — UI consequences

- Queue list already supports `closed` tab — historic rows just show up there.
- Add a filter chip "Historic Imports" (intake_channel='sheet') to Queue for triage if needed.
- Reports `getReports` already aggregates by `disposition` and `issue_category` — historic rows automatically show as `no_action` disposition. Add a `intake_channel` breakdown in reports so historic vs live calls are visible distinctly. (Tiny — one extra aggregate object in the worker, one extra table in the UI panel.)

**Commit (DDL):** `db: extend cs_tickets CHECK constraints for sheet + historical_import + flipkart`
**Commit (import):** `data: bulk import 871 historic 2026 complaints from OG sheet`

---

## Task 7 — Knowledge files + final commit/push

After everything ships clean:

### 7.1 — systems/pitstop.md updates

Add sections:
- Stack: mention `csops` now writes to cs_calls in parallel with cs_tickets
- Database: document `myop_accounts`, `cs_departments`, `cs_calls`
- Roadmap: move Phase B from "Next" to "Live (S84)"; mark Phase C/D/E as Next
- Worker actions: list new actions
- Frontend routes: add `/calls`, `/calls/detail`, `/admin/myop`, `/admin/departments`
- Gotchas: new PATTERN entries

### 7.2 — BUSINESS_RULES.md additions

- **RULE-PITSTOP-008** — every MyOp call writes a `cs_calls` row; tickets only when `duration > 0`.
- **RULE-PITSTOP-009** — `cs_calls.UNIQUE(myop_account_id, call_session_id)` — session IDs only unique per account.
- **RULE-PITSTOP-010** — dept default-filter: non-admins always see only their dept's tickets+calls; admin sees all by default with a switcher.
- **RULE-PITSTOP-011** — webhook URL is `?account=<slug>`; missing slug defaults to `main` for back-compat.

### 7.3 — BACKLOG.md updates

- Remove from `[pitstop]`: PITSTOP-CR-DROP, Phase B call log, PITSTOP-SHEET-IMPORT
- Keep: Phase C (WhatsApp continuity), Phase D (was Teams/Roles — now partially done; remaining: Operator/TL/CS-Admin/Super-Admin formal role model), Phase E (impeccable sweep), PRODUCT/DESIGN.md, Recording-URL resolution
- Add: **Recording-URL CDR resolution** — same as before but now applies per-account
- Add: **Phase C — WhatsApp continuity** — pair with `awaiting_info` disposition
- Add: **Department-locked Queue tabs polish** — refine UX after first week of dept usage

### 7.4 — archive/SESSIONS.md

Append `## Session 84 — 2026-05-28` with the build narrative.

### 7.5 — Commit + push

```bash
# Pitstop app + worker repo (05_Throttle)
git -C 05_Throttle status
git -C 05_Throttle add -A
git -C 05_Throttle commit -m "feat(pitstop): Phase B — calls, departments, multi-MyOp, sheet import"
git -C 05_Throttle push

# Workspace root
git status
git add -A
git commit -m "session: S84 — Pitstop Phase B (calls/depts/multi-MyOp/sheet import)"
git push
```

**Commit:** `docs: knowledge updates for Pitstop Phase B (S84)`

---

## Verification gates (between tasks)

After each task:
- `cd 05_Throttle && npx turbo build --filter=pitstop` → 0 errors
- `cd 05_Throttle/csops-worker && npx wrangler deploy` → 0 errors (only after worker edits)
- Curl: `curl -s 'https://csops.afshaan.workers.dev/health' | jq` → `{ ok: true, service: 'csops' }`
- After Task 3: real test webhook with a fake answered + end pair via curl, confirm cs_calls row + cs_tickets row appear in DB
- After Task 4: open `pitstop.legendoftoys.com/calls` in browser (after auto-deploy), check tabs render, filter, action menu items work
- After Task 6: count of historic tickets matches sheet row count exactly

## Risk register

- **Multi-MyOp back-compat:** existing MyOperator config points to `/webhooks/myoperator` without `?account=`. Worker defaults to slug=`main`. Don't break it. Verified by leaving the legacy `MYOP_WEBHOOK_SECRET` env var in place (Task 1.2).
- **CHECK constraint changes:** drop+recreate is brief lock but blocks writes during. cs_tickets is small (193 rows) — fine.
- **Webhook out-of-order delivery:** call.end before call.answered handling already exists for tickets; cs_calls mirrors the same pattern (insert on `call.end` if no row, else patch).
- **Sequence consumption:** SHEET-IMPORT consumes ~871 `cs_ticket_2026` sequence numbers. After import, live tickets continue from where the import left off — that's intended (historic + live share one numbering space).
- **Phone collisions in import:** different orders from same customer share `customer_phone` but get different `legacy_sheet_ref` via Order ID + Date. Fine.

## Out of scope (per transcript)

- ByteSpeed integration / WhatsApp + Email + IG inbox unification (Phase C+)
- Self-serve return page on Shopify (separate Shopify project, not Pitstop)
- IVRS routing logic (lives in MyOp, not Pitstop)
- Operator/TL/CS-Admin formal role model beyond what cs_agent/cs_lead/admin already provide (Phase D refinement)
