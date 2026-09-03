# Snorkel — PO request LINE ITEMS (design)

> S340, 2026-09-03. Author: Snorkel burndown lane. Status: **plan, not started.**
> Decisions it implements → `reference/decisions.md` §"[snorkel] PO request lines: HSN/GST
> AUTO-FILLS, the requester never types it" (Afshaan, 2026-09-03).
> Backlog item → `backlog/snorkel.md` `[snorkel][build][MED] ⏳ JOSEPH`.

## 1. The problem

`requests/new` captures **one prose textarea** (`details`) plus **one request-level
`estimated_cost`** — a single guessed number for however many things are on the request. Procurement
reads the prose and hand-builds the PO, so the real detail keeps ending up in a parallel sheet.
Joseph's stated goal is to stop using sheets for this.

**Adoption (measured 2026-09-03):** `store.po_requests` = **6 rows ever, 5 in the last 30 days, one
raised today**, 4 distinct requesters, 4 of 6 became POs. Newly adopted, not dead — fix the form
before the "raise it in Snorkel, send the detail in a sheet" habit sets.

**Why the tax column matters:** **740 of 1,079 INR PO lines carry no HSN (69%, measured
2026-09-03)** — RULE-PO-001's own failure. Hand-entry is how that happened.

## 2. ⭐ The constraint that shapes the whole build

**`postRequest` deliberately has NO permission key** — `snorkelops:2637`, *"anyone with a
@legendoftoys.com login may file a request."* That is correct and must not change.

**But the data a client-side auto-fill needs is gated:**

| Handler | Guard | Line |
|---|---|---|
| `postRequest` | **none** — any logged-in employee | 2637 |
| `getHsnRates` | **none** | 1308 |
| `getPartHsnMap` | `canView(P)` — a Snorkel permission | 1703 |
| `getProductHsnMap` | `canSalesView(P)` — a **sales** permission | 1694 |

So a straight port of the PO page's client-side auto-fill **403s for exactly the people this form
exists for**: the non-Snorkel employee raising a request. Neither the backlog item nor the first
survey caught this.

⛔ **Do NOT fix it by relaxing `getPartHsnMap`** — it returns the whole part master.

### The resolution, and it is a better design than the port

**The worker resolves HSN and GST at write time; the client never needs the map to be correct.**

1. **Authority (server):** `postRequestLines` takes `part_code`, `qty`, `unit_price` per line and
   resolves `hsn_code` + `gst_percent` itself from `partHsnMasterAll()` at insert. The stored value
   is server-resolved, always, whatever the client sent.
2. **Display (client):** a new **narrow, unguarded** `getRequestItemOptions` returns only what the
   picker needs — `part_code`, `part_name`, `uom`, `hsn_code`, `gst_percent` — matching
   `postRequest`'s openness without exposing the part master's other columns. Purely advisory: it
   shows the requester the rate and lets totals compute as they type.
3. A line with **no part code** (a genuinely new item) stores `hsn_code = NULL` and is flagged
   `needs_hsn_review = true` for procurement to confirm. This is the only free-type path.

This is the strongest form of Afshaan's decision: the requester does not merely *avoid typing* the
tax — they are never the source of it at all.

## 3. Schema

```sql
CREATE TABLE store.po_request_lines (
  id                bigserial PRIMARY KEY,
  request_no        text NOT NULL REFERENCES store.po_requests(request_no) ON DELETE CASCADE,
  line_no           int  NOT NULL,
  part_code         text,                        -- NULL = free-text new item
  description       text NOT NULL,
  item_type         text NOT NULL DEFAULT 'Part',
  qty               numeric NOT NULL,
  unit              text NOT NULL DEFAULT 'pcs',
  unit_price        numeric,                     -- requester's estimate, not a quote
  hsn_code          text,                        -- SERVER-RESOLVED, never client-supplied
  gst_percent       numeric,                     -- SERVER-RESOLVED
  needs_hsn_review  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_no, line_no)
);
ALTER TABLE store.po_request_lines ENABLE ROW LEVEL SECURITY;  -- RLS on at creation (RULE-RLS-001)
GRANT ALL ON store.po_request_lines TO service_role;
GRANT USAGE, SELECT ON SEQUENCE store.po_request_lines_id_seq TO service_role;
NOTIFY pgrst, 'reload schema';   -- ⛔ REQUIRED: a new table in an exposed schema is invisible to
                                 -- PostgREST until reloaded, and it fails SILENTLY (CORE.md).
```

`estimated_cost` on `po_requests` stays, but becomes **derived** — the sum of `qty × unit_price` —
rather than typed. Keep the column (older rows depend on it); stop offering the input once lines
exist.

## 4. Tasks

| # | Task | Files | Test |
|---|---|---|---|
| 1 | Migration + PostgREST reload | migration | `select` the table through the API returns `[]`, not 404 |
| 2 | `getRequestItemOptions` (unguarded, narrow) | `snorkelops:~1310` | anonymous-ish role gets rows; no other part columns present |
| 3 | `postRequest` accepts `lines[]`, inserts them, **resolves HSN/GST server-side**, derives `estimated_cost` | `snorkelops:2637` | a line with a known part gets HSN+GST it never sent; one without gets `needs_hsn_review=true` |
| 4 | `getRequest` / `getRequests` return lines | `snorkelops:1538,1550` | detail returns `{request, lines, linked_po}` |
| 5 | Line editor on `requests/new` | `requests/new/page.js` | Combobox with **`portal`**; add/update/remove; live line + grand totals |
| 6 | Render lines on `requests/detail` (today it prints `details` as prose, `:121`) | `requests/detail/page.js` | table, not a paragraph |
| 7 | Carry lines into the PO when a request is accepted | accept path | request → PO keeps every line |

Tasks 1–4 are worker/DB and land together. 5–6 are the app. **7 is the one that delivers Joseph's
actual goal** — without it the lines are captured and then re-keyed anyway.

## 5. Traps

- ⚠️ **`getProductHsnMap` returns `gst_pct`; `getPartHsnMap` returns `gst_percent`** (verified
  2026-09-03, `snorkelops:1694` vs `:1703`). Same concept, two names. Copying one call site's
  destructure to the other silently yields `undefined`.
- ⚠️ **Combobox needs `portal`** inside a table cell or any `overflow` container, or the dropdown is
  clipped (CORE.md, PATTERN-160). The PO page passes `portal` + `commitOnTab` — copy both.
- ⛔ **Do not port the mould-line machinery** (`mould_no`, receiving explosion) — PO-only.
- ⛔ **Do not JSON-encode lines into `details`.** It is rendered as prose to humans and would be
  unqueryable — and the Tally purchase-side push (§6.2 of the Tally v2 spec) needs these as rows.
- `unit_price` here is the requester's **estimate**, not a quote. Do not let it flow into a PO as a
  committed price without procurement confirming it.

## 6. Out of scope

**Requester notification is NOT in this build.** "Get the raised PO back to the requester" is a
**Slack DM** (Afshaan, 2026-09-02 — explicitly not email, not a mailer in Snorkel), which is a
`[core]` reusable capability. Independent of this work; ships separately.

## 7. Sizing

Multi-session. Tasks 1–4 are one focused session; 5–6 another; 7 depends on how the accept path
builds a PO today (not yet surveyed).
