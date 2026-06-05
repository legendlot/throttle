# Docket — Scratchpad (personal notes + inline checklists + inline math)

> Design spec · 2026-06-05 · System: Docket (Org Task Manager)
> A private, per-person notebook: free text with inline checkboxes and inline math,
> on a dedicated Scratchpad page.

## 1. Goal

Give every Docket user a **private scratchpad** for random notes:

- **Multiple notes per person** — a personal notebook (notes list + editor).
- **Free text with inline checklists** — checkbox items live *inline among prose*, line by
  line; the two are never exclusive (a checkbox is just a line you can mix anywhere).
- **Inline math** — a math line evaluates live and shows its result next to it (Soulver-style),
  pure per-line arithmetic.
- **Strictly private** — each person sees only their own notes; **not even `docket_admin`**.
  No sharing, no break-glass (contrast Spaces — this is personal scratch).

Non-goals (YAGNI): sharing/collaboration, rich text/images, folders/tags, per-note history,
named variables / running totals in math, real-time sync.

## 2. UX

### 2.1 Page
New **Scratchpad** item in the left sidebar under TASKS → `/scratchpad`. Two-pane layout:
- **Left:** the user's notes, most-recently-edited first; each row shows the note title (or
  "Untitled") + a faint updated-at. A **＋ New note** button at top. Clicking a row opens it.
- **Right:** the editor for the selected note — a title input + the body canvas (§2.2).
  A delete (trash) action on the open note.
- Empty state: "No notes yet — start a scratch note." New note auto-selects + focuses the body.

### 2.2 The body editor (one canvas, click-to-edit)
Each note = `title` + `body` (plain text). The body is a single surface with two modes:

- **Rendered mode (default).** The raw text is rendered line by line:
  - `[ ] text` → a clickable unchecked checkbox + text. `[x] text` (or `[X]`) → checked, text
    dimmed + strikethrough. Leading whitespace before `[ ]` is preserved (indented sub-items
    render indented). Clicking the checkbox toggles `[ ]`↔`[x]` **in the raw text and saves**,
    without entering edit mode.
  - A **math line** (the whole trimmed line matches the arithmetic grammar §2.3 and contains an
    operator) → renders the expression followed by a muted `= <result>`. Read-only annotation;
    the typed expression is unchanged in the raw text.
  - Any other line → plain text (blank lines preserved as spacing).
  - Clicking anywhere in the rendered body **except a checkbox** switches to edit mode, caret
    placed in the textarea.
- **Edit mode.** The body becomes a plain `<textarea>` showing the raw text (literal `[ ]`,
  raw math). Type freely. **Autosave** debounced ~600 ms while typing; on **blur** it saves and
  returns to rendered mode. `Esc` also blurs/renders.

This mixes prose + checkboxes + math with no rich-text-editor dependency (stack is plain React,
static export). Title autosaves the same way (debounced + blur).

### 2.3 Inline math (safe, pure arithmetic)
- A line is treated as math when, trimmed, it matches `^[0-9+\-*/().%\s]+$`, contains at least
  one operator, and parses cleanly. Otherwise it's plain text (so "2 apples" is never math).
- Evaluated by a small **shunting-yard evaluator** in `lib/mathEval.js` — supports `+ - * / ( )`,
  unary minus, `%` as "percent of the running value is ambiguous" → v1 treats `%` as **modulo**
  ONLY if between two numbers; a trailing `n%` is interpreted as `n/100` (so `18%` → 0.18,
  `1200*18%` → 216). Decimals supported. **No `eval`/`Function`** — tokenizer + RPN only.
  Division by zero / parse failure → no annotation shown (line stays plain).
- Result formatting: trim to a sensible precision (up to 6 decimals, strip trailing zeros),
  thousands separators off in v1.
- Results are **computed on render, never stored** (body holds only the raw expression).

## 3. Data model (`docket` schema)

### `docket.scratch_notes`
| col | type | notes |
|---|---|---|
| `id` | uuid PK (`gen_random_uuid()`) | |
| `user_id` | uuid NOT NULL | auth user; the privacy key. Indexed. |
| `title` | text | nullable; UI shows "Untitled" when empty |
| `body` | text NOT NULL default `''` | raw note text (prose + `[ ]` + math lines) |
| `created_at` | timestamptz NOT NULL default now() | |
| `updated_at` | timestamptz | bumped on every save |

- `create index docket_scratch_notes_user_idx on docket.scratch_notes(user_id, updated_at desc);`
- RLS **enabled**, `grant all … to service_role`, no anon grants (RULE-RLS-001). The worker
  (service_role) is the only client and filters by `user_id` on every call.

No new `store.sequences` (uuid keys). `docket` already on the exposed-schemas list.

## 4. Worker (`docketops`) actions

All gate on `verifyJWT` then scope strictly to `auth.userId` — a note is only ever readable/
writable by its owner (no admin path).

- **GET `getScratchNotes`** — `select id,title,body,created_at,updated_at from scratch_notes
  where user_id = caller order by updated_at desc`. (Bodies included; personal notes are small
  and the list+editor want them ready — one round trip.)
- **POST `createScratchNote`** — `{ title?, body? }` → insert with `user_id = caller`; returns the row.
- **POST `updateScratchNote`** — `{ id, title?, body? }` → update **only if** `user_id = caller`
  (where-clause scoped); set `updated_at = now()`. Returns `{ id }`. 404 if not owned.
- **POST `deleteScratchNote`** — `{ id }` → hard delete where `id = id AND user_id = caller`.

Register in `GET_ACTIONS` / `POST_ACTIONS`. No permission keys involved — every authenticated
user has their own scratchpad (like the baseline tier; no `docket_admin` needed).

## 5. Frontend (`apps/docket`)

- **`lib/mathEval.js`** — `evalLine(str) → { ok, value } | { ok:false }`; tokenizer + shunting-yard
  + RPN eval; the math-line detector. Pure, unit-testable by eye (no deps).
- **`components/NoteBody.js`** — the click-to-edit body: rendered line list (checkbox toggle +
  math annotation) ⇄ textarea; props `value`, `onChange(rawText)`, `onToggleSave(rawText)`.
  Checkbox toggle rewrites the specific line in the raw text and calls `onToggleSave`.
- **`app/(auth)/scratchpad/page.js`** — two-pane page: notes list (left) + title input + `NoteBody`
  (right) + delete. Debounced autosave (title + body) via `updateScratchNote`; new/delete via the
  respective actions; local optimistic update of the list (re-sort by updated_at).
- **`lib/nav.js`** — add `{ id:'scratchpad', label:'Scratchpad', route:'/scratchpad', icon: NotebookPen }`
  to the TASKS group (no `requires` — everyone gets it). Keep it after Tasks/spaces.
- Reuse the docket dark tokens; checkbox uses the accent; math `= result` in `--text-3`/mono.

## 6. Migration

One migration `docket_scratchpad_v1` (`0003_scratchpad.sql`): create `docket.scratch_notes`
(+ index, RLS on, service_role grant). No function/RPC changes. `get_advisors(security)` after.

## 7. Business rule

- **RULE-DOCKET-005 (Scratchpad):** per-person private notes (`docket.scratch_notes`, scoped by
  `user_id` in every worker handler — no admin/break-glass path, unlike Spaces). Body is raw text
  rendered line-by-line: `[ ]`/`[x]` → inline toggleable checkboxes, arithmetic-only lines → live
  `= result` (computed on render via a no-`eval` evaluator, never stored). Multiple notes/person,
  hard-deletable, no history. Dedicated `/scratchpad` page.

## 8. Edge cases

- Empty body → renders nothing (placeholder "Click to write…" in rendered mode when empty).
- A `[ ]` mid-sentence (not line-leading) is NOT a checkbox — only a line that starts with optional
  whitespace then `[ ]`/`[x]` becomes a checkbox (keeps prose with brackets intact).
- Concurrent edits across devices: last-write-wins on `body` (personal, single-user, acceptable).
- Very long notes: textarea grows; no pagination in v1.
- Toggling a checkbox while a debounced body save is pending: the toggle reads the latest raw text
  state (not a stale snapshot) before rewriting the line.

## 9. Out of scope / deferred

Named variables + running totals in math; markdown beyond checkboxes; sharing; folders/tags;
images/attachments; pin/reorder; full-text search across notes; per-note history.
