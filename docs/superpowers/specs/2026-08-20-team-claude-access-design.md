# Giving the LOT team Claude access to internal systems — exploration + findings

> **Status: EXPLORED, NOT DESIGNED-TO-BUILD, NOT STARTED.** Afshaan 2026-08-20, explicitly
> exploratory ("don't jump to build"). This file exists so the next session picks up the
> gathered facts instead of re-deriving them.
> **Every measurement below was taken 2026-08-20 against `lot-production`. Re-derive before
> sizing anything off it** — the standing rule for numbers written into the knowledge layer.

---

## 1. The ask

Team members each have their own Claude access. They want to use it against internal LOT
systems for analysis and insight. Afshaan's own framing of the need, verbatim in substance:

1. **Investigations** — store team chasing GRN history, long multi-step analyses
2. **Summaries in a given format** — sales data, channel-wise updates
3. **Sentiment analysis on CS data** — what are the complaints
4. **Docket task management merged with outside context** — e.g. consume context from
   Neosapiens, merge it, then **update their own task list on Docket**
5. **Snorkel reconciliation** — how many POs, which exact POs, amounts vs paid
6. **Ads + performance analysis**
7. **Podium is out completely — no access for anyone**

**Constraints as stated:**
- Access goes to **part of leadership only**; the mapping of who is **not done yet**.
- **Podium files not readable by anyone.** Rationale given: another person's salary is always
  out of scope.
- Customer info and order info are **already available to the team through Shopify etc.**, so
  that class of data is not a new exposure.

---

## 2. Findings — verified against the live DB, 2026-08-20

### 2.1 ⚠️ `jarvis_ro` is NOT a Postgres role

CORE.md describes it as "a LEGITIMATE least-privilege READ principal … holds read-only roles
in six per-system permission stores". That is accurate but easy to misread as a **database**
role. It is not: `SELECT rolname FROM pg_roles WHERE rolname ILIKE '%jarvis%'` returns **zero
rows**. It exists only as an application-level principal inside LOT's own permission tables.

**Consequence: there is no existing DB-layer read principal to extend.** A read-only Postgres
role would be built from scratch. Do not plan on inheriting one.

### 2.2 Authorization lives in worker code, not in the database

RLS is enabled on every table but as a **backstop** — the posture is service_role-only, and the
worker is the only general DB client. The real permission model is 8+ independent layers:

`store.snorkel_roles` · `store.podium_roles` · `store.docket_roles` · `store.salesops_roles` ·
`store.relayops_roles` · `manifest.manifest_roles` · `ignition` roles (RULE-IGN-008) ·
`users_profile.role` (LOT Ops cluster only)

**So any direct-to-database route must either re-implement all of that or ignore it.**
Re-implementing creates a second source of truth for permissions, which is precisely the
incident class (S76→S80) that produced the per-system layers in the first place.

### 2.3 The schema is not analysis-ready

| Schema | Tables |
|---|---|
| store | **412** |
| public | 62 |
| comms | 61 |
| sales | 55 |
| podium | 33 |
| manifest | 23 |
| ignition | 21 |
| docket | 20 |
| brand | 17 |

**704 total.** Within `store`: **253 are `safety_*` snapshots**, 159 are real tables, 11 are
views. **61% of the biggest schema is snapshot debris** — a by-product of the
snapshot-before-bulk-mutation discipline.

⚠️ **This is a correctness hazard, not just noise.** Pointed at raw `store`, an assistant will
happily join `safety_bumble_sweep_2026_08_05` believing it is live data. Any SQL surface must
hide `safety_*` by construction.

### 2.4 Podium containment — what "no Podium" actually has to cover

**Views: clean.** Zero views outside `podium` reference it (checked across all schemas).

**Functions: three families outside `podium` read it.** Revoking the `podium` schema alone does
NOT close these, because they live elsewhere and run as their definer:

| Object | Reads | Verdict |
|---|---|---|
| `public.f_factory_cost_daily` / `_monthly` / `_series` (+ helpers `public._factory_costinputs`, `public._factory_daycost`) | `podium.factory_pay` etc. | **Aggregate-only BY DESIGN** — RULE-COST-001: salaries never leave Podium, the floor reads aggregates. Exposes no individual's pay. |
| `docket.dashboard_stats` | `podium.employees` / `departments` | **Names and teams, not pay.** Docket cannot function without it. |
| `sales.f_podium_salary_run(p_month date) → numeric` | (stub) | ⚠️ **Currently a STUB returning `0`.** Its own comment says that when live it returns the monthly company-wide SG&A salary total, gated on `sales.settings.pnl_sga_source='podium'`. **It sits in the `sales` schema**, which the ads/sales users would have. Single aggregate, not per-person — but it is the one to watch. |

⚠️ **The distinction that needs an explicit decision: "no individual's salary" is NOT the same
rule as "no number derived from payroll."** Factory cost per unit and a single SG&A total
expose nobody's pay and are needed for unit economics and P&L. Recommendation: those stay,
per-person compensation never appears. **Afshaan has not ruled on this yet.**

### 2.5 Volume + the traps that make raw SQL risky

- `comms.messages` — **260,571 rows**
- `store.issue_register` — **44,930 rows** across 1,627 issues
- `store.return_units` — 6,517 · `store.grn_summary` — 1,512 · `comms.templates` — 101

⚠️ **PostgREST caps EVERY response at `db-max-rows` = 5,000, including RPCs, with no error and
no header** (CORE.md). Any analytical surface must page and must signal truncation loudly.

**Columns that do not mean what they are called** — the real risk is confidently-wrong
analysis, not leakage. A non-exhaustive list already documented in BUSINESS_RULES /
`reference/decisions.md`:

- `sales_fact.gross_value` is gross; **RULE-SALES-001 says NET ex-GST is *the* metric** and the
  business never works off gross. Someone querying the obvious column gets the wrong number.
- `courier_scan_captures.applied = false` means **no-op**, not failure.
- `comms.segment_members.added_at` is a **rebuild timestamp**, not when a profile joined.
- `public.scans` has **no `created_at`** — its column is `timestamp` (reserved word, must quote).
- `store.return_units` has **no `created_at`** — `logged_at` / `intake_at` only (RULE-RET-001).
- `stock_ledger.product` is `''` for cross-product parts while `material_master.product` is
  `'Universal'` — **join on `part_code` alone** (RULE-003).

### 2.6 Indexing is tuned for the apps, not for analysis

Found while building the template-usage pill the same day: `comms.messages` had **no index on
`template_id`**, so a per-template count was a 260k-row seq scan at ~125 ms. Across 101
templates that blew the statement timeout outright (fixed: `messages_template_status_idx`,
timeout → 238 ms).

⚠️ **Expect more of these.** Analytical access hits column combinations the apps never query.
Budget for index work, and set a statement timeout on the analytical role so a bad query
degrades one person's session instead of the production database.

---

## 3. The structural read — four shapes, not one need

The seven use cases are **four different tool shapes**. This is the main design conclusion.

| Shape | Cases | What it needs |
|---|---|---|
| **A · Open investigation** | 1 store/GRN, 5 Snorkel recon | Real SQL. Cannot be pre-canned — the point is the question is unknown in advance |
| **B · Recurring summaries** | 2 sales/channel, 6 ads | **Fixed semantics.** Same question twice = same number, and it must match Odo |
| **C · Text + judgement** | 3 CS sentiment | Bulk text retrieval with sampling/pre-aggregation. Not aggregation at all; will blow context if naive |
| **D · Read + write, one system** | 4 Docket | Narrow writes through the existing permission layer |

**One MCP server, four tool families — not one generic SQL pipe.** One server because the
value is composition across shapes: *"reconcile these POs and open a Docket task for each
mismatch"* spans cases 5 and 4 in a single conversation.

---

## 4. Recommended architecture (not yet approved)

1. **Enforce the Podium exclusion at the Postgres role, not in MCP code.** A read-only role
   with zero grants on `podium` is a wall; enforcement in tool descriptions or server logic is
   only a guardrail. It is the one hard constraint, so put it where it cannot be argued with.
   Also revoke/hide `safety_*` (§2.3) and decide §2.4's aggregate question.

2. **Reuse the existing per-system role tables for identity — never fork them.** Google auth is
   already domain-restricted (RULE-010). Resolve each person to their existing
   `snorkel_user_roles` / `docket_user_roles` / `salesops_user_roles` rows and gate **which
   schemas the SQL tool can see** off those. Coarse, but honest, and it matches how the team is
   already segmented. One source of truth for permissions.

3. **For Shape B, expose the RPCs Odo already calls** — `sales.f_order_rollup`,
   `f_mkt_rollup`, `f_mkt_product_rollup` — rather than authoring new views. They already
   encode net-vs-gross correctly, so **the numbers match Odo by construction and cannot
   drift.** Cheaper than a semantic layer, not more expensive, and it closes §2.5's
   confidently-wrong-analysis risk for the highest-traffic questions.

4. **Writes stay narrow and proxied.** Docket writes go through `docketops` with the user's own
   JWT so `docket_roles` applies and `task_history` records who did it. **Never a generic SQL
   write tool** — a mistake should be a bad task, not a bad table.

5. **Truncation must be loud, and the role must have a statement timeout.**

6. **Audit who ran what.** Small N and leadership-only, but it is cheap now and impossible
   retroactively.

---

## 5. Open questions — none of these are decided

- **Who, exactly.** Afshaan has not mapped people → systems yet. Much of it should fall out of
  the existing role tables rather than being new mapping work.
- **§2.4: are payroll-derived AGGREGATES in or out?** (factory cost/unit, SG&A total).
  Blocks the grant list.
- **Cases 2 and 6 may not need this vehicle at all.** Odo already computes channel-wise sales
  and ads performance including ROAS/ACOS/TACOS at SKU grain. **Establish whether the gap is
  capability or format/delivery** — if the latter, a scheduled Slack digest is cheaper,
  consistent, and gives everyone the same number. Do this before building.
- **Case 3 shape:** ad-hoc theme-finding, or a recurring "top complaints this week"? The
  recurring version is better solved by structured tagging in Pitstop than by re-deriving
  themes from raw text every time.
- **Claude.ai Team/Enterprise vs Claude Code** — admin-installed org-wide connector versus
  per-person `claude mcp add`. Different deployment paths.
- **Explicitly NOT recommended: handing out the Supabase MCP as-is.** It carries
  `apply_migration`, write-capable `execute_sql` and `deploy_edge_function`, and bypasses RLS.
  That is admin access, not analyst access.

---

## 6. One caution to keep on the record

"The team already has customer data via Shopify" is **true but not equivalent**. Shopify serves
it through a UI with its own audit trail and natural friction. SQL over `comms` would allow
bulk export of 260,571 messages plus consent and suppression state in a single query. The
*kind* of data is the same; the *volume and ease* are not. Not a reason to block anything —
recorded so the decision is made knowingly rather than inherited.

---

## 7. Suggested next step

Map the seven use cases onto the specific tables, RPCs and existing role keys each would need.
That converts this from architecture into a scoped build, and — the working expectation — will
show **considerably more "expose what already exists" than "new build"**, particularly for
cases 2, 5 and 6.
