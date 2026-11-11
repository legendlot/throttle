# Docket — Checklists v2: register view, adherence, and record checklists (F8)

> 2026-11-11 · Status: **✅ SETTLED 2026-11-11 — C1–C7 + C9 accepted; C8 = P1 (register) first. P1 BUILT 2026-11-11.** · Builds on RULE-DOCKET-008 (S124 flat recurring
> tasks) and RULE-DOCKET-009 (S127 checklist templates). Replaces nothing that has data; reshapes a layer that has none.

## 1. What Afshaan asked for (2026-11-11)

Three checklist shapes:

1. **Register view (new).** The paper chart on a washroom wall. Items run down the left, dates or cycles run
   across the top, and each cell holds a tick. Reading across a row shows how consistently that item gets done;
   reading down a column shows how complete that day was.
2. **Today view (exists).** The list of items due today, each with a box to tick.
   **1 and 2 are two views of the same checklist.** You toggle between them, and you can look back at
   adherence over past days.
3. **Record checklists (new).** A slowly changing **template** (e.g. *Product launch*: listing images, product
   sourcing, raw material, new tooling, D2C / Amazon / Flipkart readiness, content, ads). For each product the
   team makes a **copy**, ticks items once (not every day) and keeps the copy as the record. The template stays
   editable as the process grows. A copy links to a task ("Launch: Badger — 6/11"), and any open item can
   become a task.

## 2. What exists today (measured 2026-11-11)

| Layer | Shape | Use |
|---|---|---|
| **Flat recurring tasks** (S124, RULE-DOCKET-008) | A `docket.tasks` row with `is_recurring` + `recurrence`; one tick per day in `checklist_completions (task_id, occurrence_date)`. Per person. `/checklist` → *My day*, with past-day back-fill (S250, past only). | **22 live, 11 owners, 0 ticks in the last 30 days.** ~7% adherence when last measured (S250, July). |
| **Checklist templates** (S127, RULE-DOCKET-009) | 6 tables: `checklist_templates` (recurrence, no time) → `_sections` (`due_time`) → `_items` (tags); `_assignments` (template → person); `_item_completions (item, employee, date)`; `_section_comments`. UI: `ChecklistTemplateEditor`, `ChecklistRun`, `OversightPanel`; *Manage* and *Oversight* tabs. | **0 templates, 0 ticks, ever.** |
| Worker | `getChecklist`, `getChecklistTemplates`/`getChecklistTemplate`, `saveChecklistTemplate`, `archiveChecklistTemplate`, `assign`/`unassignChecklistTemplate`, `toggleChecklistItem`, `toggleChecklistOccurrence`, `getChecklistOversight`, `createRecurringTask`, `updateRecurrence` | |

**Consequence:** the S127 template layer already has shape 1/2's data model: a named checklist, its items, a
cadence, and per-date ticks. It is unused, so it can be reshaped freely with no data to migrate. We **extend it
rather than build a third system** next to it. Flat recurring tasks stay as they are and get the register view too.

## 3. The model

One concept, **a checklist template**, now with a `kind`:

| `kind` | Is | Ticks are | Views |
|---|---|---|---|
| `routine` (= every S127 template) | a recurring checklist (daily / weekly / monthly) assigned to people | per **occurrence date** | **Today** · **Register** |
| `record` (new) | a template that is **copied per subject** (a product, a launch, an event) | **once**, on the copy | **Record** page · progress on linked tasks |

### 3.1 Routine checklists: shapes 1 and 2

- **Same data, two views.** Today = the existing *My day* run (`ChecklistRun`). Register = a grid with
  **rows = items** (grouped by section) and **columns = occurrences**, from the same `checklist_item_completions`.
- **Columns = the dates something was due** (as built, P1): a daily chart shows every day, a Monday-only
  weekly chart shows Mondays. Within a column, a row not due that day shows a dot. Window 7D / 14D / 30D
  (opens on 14D — the Today view is the toggle beside it), ‹ › to page back, never past today.
- **Cells:**
  - ✓ done
  - ✓ amber: done late (after the section's `due_time`, as R2 already computes)
  - ✗ red: due and not done (past only)
  - blank: today or future
  - dot: not due that day
  - Hover shows who ticked and when.
- **Adherence:** done ÷ due occurrences, at the end of every row (per item), at the foot of every column (per
  day), and overall for the window. **Today counts only once ticked** (the day isn't over) — so for TODAY
  the register and Oversight differ by design (Oversight counts today's unticked items as due).
- **Ticking in the register:** click a cell. **Past only**, the S250 rule: ticking a future date would make
  adherence unauditable. A past-day back-fill is stamped with the date it was actually made, and a back-filled
  tick shows as a hollow ✓ so the chart tells the truth (decision C2).
- **Flat recurring tasks get the same register.** For one person: rows = their recurring tasks, cells from
  `checklist_completions`. No migration.
- **Shared vs per-person runs (new, decision C1).** S127 keys every tick to an employee, so each assignee gets
  their own chart. A washroom chart is **one chart, whoever cleans**. Add `checklist_templates.run_scope`:
  `per_person` (S127 behaviour) or `shared` (one run per date, any assignee ticks, the tick records who). For
  `shared`, `checklist_item_completions.employee_id` becomes the ticker and uniqueness moves to `(item, date)`.

### 3.2 Record checklists: shape 3

**Template.** The same tables: `kind='record'`, no recurrence, no assignments. It gains a `version int`, bumped
whenever items are added, removed, renamed or reordered, and every edit is logged in template history.

**Copy (a "record").** New tables (migration `0014_checklist_records.sql`):

```
docket.checklist_records
  id, template_id → checklist_templates, template_version int,
  title text          -- "Launch: Badger"
  product text null   -- a public.product_master family name (product_master has no id; `product` is the key used everywhere)
  space_id → spaces   -- visibility = the space's, exactly like a task
  owner_employee_id, status ('open' | 'complete' | 'archived'),
  created_by_user_id, created_at, completed_at, archived_at

docket.checklist_record_items
  id, record_id → records on delete cascade,
  source_item_id uuid null   -- the template item it came from (null = added only to this copy)
  section_title text, title text, help_text text, sort_order int,
  state ('open' | 'done' | 'na'), na_reason text,
  done_by_user_id, done_at, note text,
  task_id uuid null → tasks  -- the task spun out of this item, if any

docket.task_checklist_links      -- a record ↔ many tasks (the launch task, the Amazon-listing task…)
  task_id → tasks, record_id → records, unique (task_id, record_id)
```

- **The copy snapshots the template** at creation, so later template edits never rewrite history.
- **Pulling template updates (decision C3).** An open record shows "Template has 2 new items — add them?".
  Accepting copies only the items it is missing, matched by `source_item_id`. It never removes or un-ticks
  anything. An item deleted from the template stays on old records, labelled *no longer in template*.
- **Item states:** `open`, `done`, or `na` (*not applicable*, e.g. "no new tooling needed"). `na` needs a short
  reason and counts as complete. Progress = (done + na) / all, shown as "6/11 (1 N/A)".
- **Item → task:** an open item has a **Create task** button. It opens the capture line prefilled with
  "*\<item\>* — *\<record title\>*" in the record's space, sets `record_item.task_id`, and links the task to the
  record. The item then shows that task's DKT number, owner and status. When the task is done, the item gets
  a one-click "DKT-123 is done — tick this?" (decision C4).
- **The record finishes itself:** when every item is done or N/A, status becomes `complete`, logged.
  Re-opening an item re-opens the record.
- **Product (decision C5):** `title` is required, and `product` is optional, picked from `product_master`.
  **Launches usually start before the product is in the catalog** (Badger isn't there yet), so the record
  can't wait for one. Link the product later, when it exists. Filter records by product.
- **Who can tick (decision C6):** anyone who can see the record. A launch is cross-team: content ticks content,
  ops ticks sourcing. Every item shows who ticked and when, and every change goes to record history. Editing
  the record's title, owner or product, or archiving it, is limited to the owner, the creator or an admin
  (RULE-DOCKET-009 pattern).

### 3.3 Screens

- **`/checklist`** keeps one page and gains a top switch:
  - **Routines:** *Today* | *Register* toggle, the person selector (as now), and the existing Oversight tab.
  - **Records:** a list of records with progress bars, filtered by template, product, status and owner, plus
    **+ New record** (pick a template, a title and optionally a product).
  - **Manage:** templates of both kinds. The existing `ChecklistTemplateEditor` gains the kind switch, and the
    `record` kind hides cadence and assignment.
- **Record page** `/checklist/record?id=`: sections → items. Each item has a state control (✓ / N/A), shows
  who ticked and when, and has a note, a Create task button and a linked-task chip. The header shows the
  title, product, owner, progress, template version and the pull-updates banner, plus a **Linked tasks** list.
- **Task view:** a **Checklists** strip under Dependencies, reading "Launch: Badger · 6/11 (1 N/A) →", plus
  **+ Link checklist** (search records). The list row gets no new icon in v1. Progress lives on the task
  page, so the row stays clean.
- **⌘K:** records are searchable by title and product.

### 3.4 Worker (`docketops-worker`)

- **`getChecklistRegister`** `?template_id=&employee_id=&from=&to=` (or `?recurring_of=<employee>` for flat
  tasks) returns `{ rows:[{id, section, title}], cols:[{date, due}], cells:{ "<row>|<date>": {by, at, late,
  backfilled} }, adherence:{ rows, cols, overall } }`. One call, no per-row loop. Same person gate as
  `getChecklist`.
- **`toggleChecklistItem`** / **`toggleChecklistOccurrence`**: unchanged contract, plus `shared` run scope
  and the back-fill stamp.
- **Records:**
  - `getChecklistRecords` (list with filters, progress counts)
  - `getChecklistRecord` (record + items + linked tasks + `template_has_updates`)
  - `createChecklistRecord`
  - `updateChecklistRecord`
  - `setRecordItemState {item_id, state, na_reason?, note?}`
  - `addRecordItem`
  - `pullTemplateUpdates`
  - `createTaskFromRecordItem`
  - `linkTaskChecklist` / `unlinkTaskChecklist`
- **`getTask`** adds `checklists: [{record_id, title, done, na, total}]`, behind the same visibility gate as
  `task_cards` (a record in a space you can't open shows as "1 checklist you can't see", the F7 rule).
- **MCP (`lotmcp` gateway):** read-only `docket_checklists` (records + progress, register adherence). A
  follow-up, not v1.

## 4. Deliberately not in v1

| Not built | Why |
|---|---|
| Reminders / notifications when a routine is missed | S309 declined notifications. The register's red ✗ is the signal. |
| Photo proof on a tick | Links-only stance (no file storage). Revisit with file uploads. |
| Checklist adherence on the main Dashboard | Oversight + Register cover it. Add only if someone actually reads the register for a month. |
| Auto-creating a record when a "launch" task is created | No task types in Docket. Linking is one click. |
| Record templates with recurrence / nested records | Not needed for launches. |

## 5. Adoption — the risk this spec can't build away

The flat checklists have 22 live items and **zero ticks in 30 days**. The S127 template layer has **never been
used**. Better screens won't fix that on their own. What would:

1. **Pilot one real routine and one real record** with named people. For example, one washroom or floor
   routine (shared run, supervisor ticks) and the next product launch as a record.
2. **Someone reads the register weekly.** Adherence nobody looks at is decoration. Name the reader.
3. **Measure at 2 weeks:** routine adherence %, and whether the launch record was kept current. If either is
   near zero, stop investing and say so.
4. **The 22 dead recurring tasks.** Ask each owner to keep or stop theirs (or stop them all, as with the
   stale-task cleanup) **before** the pilot, so the register doesn't open on a wall of red.
   **Breakdown (2026-11-11):**
   - **3 tasks owned by people who have left** (Ankit DKT-411, Anusha DKT-241, Jyothi DKT-398): stop.
   - **5 of Tanya's weekly sales reviews** (DKT-332..336): the one real success. 64, 64, 37, 36 and 11 ticks
     from June to 9 Oct, then nothing. Ask her whether to keep them; they are evidence that a weekly
     review-shaped checklist works.
   - **11 production-floor routines** (Karthik, Kishan, Mrudula, Padam, Sagar: line flush, calibration,
     material verification, manpower setup…): 0–2 ticks ever. These are the natural **routine pilot**. They
     should be rebuilt as one shared floor register (C1, C7) rather than 11 solo items.
   - **Adnan DKT-1021** (0 ticks) and **Afshaan DKT-135** (2 ticks, last 15 Jun): owner's call.

## 6. Size and phasing

| Phase | Contents | Size |
|---|---|---|
| **P1: Register + adherence** | `run_scope` + backfill stamp (small migration), `getChecklistRegister`, Register grid + Today/Register toggle, flat-task register, manual chapter | ~1 session |
| **P2: Records** | migration 0014 (3 tables + `kind`/`version`), 10 handlers, Records list, Record page, task strip, ⌘K, manual | ~1.5–2 sessions |

P1 and P2 are independent. P2 can ship first if the launch checklist is the more pressing need.

## 7. Decisions — ✅ recommendations accepted 2026-11-11 (C8 still open)

- **C1: Shared runs.** Add `run_scope` (`per_person` | `shared`) so a washroom chart is one chart whoever
  cleans? Recommended **yes**.
- **C2: Back-fill honesty.** Allow past-day ticks (as S250 does), but show back-filled ticks as a hollow ✓
  and keep them in adherence. Recommended **yes, with no time limit**. The alternative is a 7-day back-fill
  window.
- **C3: Template edits.** Apply to new copies only, with a "pull updates" banner on open copies. Recommended
  **yes**.
- **C4: Spun-out task done → item.** Suggest the tick (one click), or tick it automatically? Recommended
  **suggest**. The item is a claim about readiness and the task is one way of getting there; a person
  confirms.
- **C5: Product.** Free-text title required, optional link to a `product_master` product. Recommended **yes**.
  The catalog usually lags the launch.
- **C6: Who ticks a record.** Anyone who can see it, with every tick attributed. Recommended **yes**. The
  alternative is owner + collaborators only.
- **C7: Who ticks a floor routine** when the doer has no Docket login (housekeeping, floor staff)?
  Recommended: **the assigned supervisor ticks on their behalf**. The tick records who ticked, and an optional
  "done by" note names the doer. A shared tablet login is the alternative.
- **C8: Phase order.** ✅ **P1 (register) first** (Afshaan, 2026-11-11). P1 (register) first, or P2 (launch records) first? This is your call: it depends on
  which is used first.
- **C9: The 22 inactive recurring tasks.** Clean up before the pilot (§5.4). Recommended **yes**: send each
  owner a keep/stop list.

Sources: Afshaan's brief (2026-11-11). Live counts from `docket.tasks`, `checklist_completions`,
`checklist_templates`, `checklist_item_completions` and `public.product_master` (65 products) on 2026-11-11.
`systems/docket.md` §Checklists (S124, S127, S250).

## 8. P1 as built — review-driven rules (2026-11-11)

Hostile review + Codex pass on the P1 diff; each became a rule, enforced in code:
- **A recorded tick is never dropped.** A tick on a day the CURRENT schedule skips still shows and counts
  (schedules change: DKT-334/335 went Tue/Thu → Mon/Wed/Fri with 6 real ticks on the old days).
- **Due only while it applied:** a row is due from its start (task created / item added / assigned) and only
  inside assignment periods (shared = the union of all assignees'), cut at the day a template was switched
  off or archived. Inactive templates take no ticks.
- **One shared tick per (item, date), enforced by the DB** (`checklist_item_completions_shared_uq`); a
  second simultaneous tick gets a 409 and the first stands.
- **A shared tick is a record:** only the person who made it, the template's creator or an admin can clear it.
- **Chart type is locked once ticked** (`run_scope_locked`): switching would re-read every past tick.
- **Private spaces:** a viewer only sees someone's recurring tasks in spaces they can open (also fixed in
  `getChecklist`, which had the same gap).
- **Future and off-schedule ticks are refused server-side** (`future_date`, `not_due` — untick is always allowed).
- Arithmetic lives in `docketops-worker/src/register-core.mjs`, tested by `docketops-worker/test/register-core.test.mjs`.
