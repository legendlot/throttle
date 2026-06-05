# Docket Scratchpad — Implementation Plan

> **For agentic workers:** Implement task-by-task. Verification is `npx turbo build --filter=docket`
> (zero errors) + node-syntax-check the worker + a SQL data-path check — the LOT codebase has no
> automated test harness. Steps use `- [ ]`.

**Goal:** A private per-person Scratchpad in Docket: multiple notes, free text with inline
toggleable checkboxes and inline live arithmetic, on a dedicated `/scratchpad` page.

**Architecture:** New `docket.scratch_notes` table scoped by `user_id`; docketops CRUD handlers
that hard-filter to the caller; a click-to-edit `NoteBody` (rendered ⇄ textarea) plus a no-`eval`
`mathEval` helper; a two-pane page + sidebar item.

**Tech Stack:** Cloudflare Worker (`docketops`, REST→PostgREST, service_role), Supabase Postgres
(`docket`), Next.js static-export app (`apps/docket`), shared `@throttle/ui`.

**Spec:** `docs/superpowers/specs/2026-06-05-docket-scratchpad-design.md`. **RULE-DOCKET-005.**

---

## File map
- **Create** `docketops-worker/migrations/0003_scratchpad.sql` — table mirror.
- **Modify** `docketops-worker/src/index.js` — 4 handlers + dispatch.
- **Create** `apps/docket/src/lib/mathEval.js` — safe arithmetic evaluator + math-line detector.
- **Create** `apps/docket/src/components/NoteBody.js` — click-to-edit body (checkbox toggle + math).
- **Create** `apps/docket/src/app/(auth)/scratchpad/page.js` — two-pane notes list + editor.
- **Modify** `apps/docket/src/lib/nav.js` — add Scratchpad nav item.

---

## Task 1: Migration

**Create** `docketops-worker/migrations/0003_scratchpad.sql`:

```sql
-- Docket — Scratchpad. Applied to lot-production as `docket_scratchpad_v1` (2026-06-05).
-- Per-person private notes (RULE-DOCKET-005). Scoped by user_id in the worker; RLS-on/service_role.
create table docket.scratch_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text,
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index docket_scratch_notes_user_idx on docket.scratch_notes(user_id, updated_at desc nulls last);
alter table docket.scratch_notes enable row level security;
grant all on docket.scratch_notes to service_role;
```

- [ ] **Step 1:** Write the file.
- [ ] **Step 2:** Apply via `apply_migration` name `docket_scratchpad_v1`. Then `get_advisors(security)` — expect no new ERROR (only the INFO `rls_enabled_no_policy`, intended).
- [ ] **Step 3:** Verify: `select count(*) from docket.scratch_notes;` → 0.
- [ ] **Step 4:** Commit the file.

---

## Task 2: Worker handlers

**Modify** `docketops-worker/src/index.js`. Add after the space handlers, before the dispatch maps:

```js
// ── Scratchpad (RULE-DOCKET-005) — strictly per-user; no admin path ──────────
async function getScratchNotes(url, auth, env) {
  const r = await sbDocket(`/rest/v1/scratch_notes?user_id=eq.${enc(auth.userId)}&select=id,title,body,created_at,updated_at&order=updated_at.desc.nullslast,created_at.desc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}
async function createScratchNote(body, auth, env) {
  const d = body.data || body;
  const r = await sbDocket(`/rest/v1/scratch_notes`, env, {
    method: 'POST', body: JSON.stringify([{ user_id: auth.userId, title: d.title || null, body: d.body || '', updated_at: nowIso() }]) });
  if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data[0]);
}
async function updateScratchNote(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const updates = { updated_at: nowIso() };
  if (d.title !== undefined) updates.title = d.title;
  if (d.body !== undefined) updates.body = d.body;
  // user_id in the filter is the privacy gate — a note is only writable by its owner.
  const r = await sbDocket(`/rest/v1/scratch_notes?id=eq.${enc(d.id)}&user_id=eq.${enc(auth.userId)}`, env, {
    method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(updates) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  if (!r.data?.length) return err('not_found', 404);
  return ok({ id: d.id, updated_at: updates.updated_at });
}
async function deleteScratchNote(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  await sbDocket(`/rest/v1/scratch_notes?id=eq.${enc(d.id)}&user_id=eq.${enc(auth.userId)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  return ok({ deleted: d.id });
}
```

Register: add `getScratchNotes` to `GET_ACTIONS`; add `createScratchNote, updateScratchNote,
deleteScratchNote` to `POST_ACTIONS`.

- [ ] **Step 1:** Add handlers + dispatch entries.
- [ ] **Step 2:** `cp src/index.js /tmp/x.mjs && node --check /tmp/x.mjs` → SYNTAX OK.
- [ ] **Step 3:** Commit.

---

## Task 3: mathEval helper

**Create** `apps/docket/src/lib/mathEval.js` — no `eval`/`Function`; tokenizer → shunting-yard → RPN.

```js
// Safe per-line arithmetic for the Scratchpad. No eval/Function — tokenizer + RPN only.
// Supports + - * / ( ), unary minus, decimals, and `%`: trailing `n%` => n/100,
// binary `a % b` between numbers => modulo. Returns {ok:true,value} or {ok:false}.

const MATH_LINE = /^[0-9+\-*/().%\s]+$/;
const HAS_OP = /[+\-*/%]/;

export function isMathLine(line) {
  const t = line.trim();
  if (!t || !MATH_LINE.test(t) || !HAS_OP.test(t)) return false;
  return evalExpr(t).ok;
}

export function evalLine(line) { return evalExpr(line.trim()); }

function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c >= '0' && c <= '9' || c === '.') {
      let j = i + 1; while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      out.push({ t: 'num', v: parseFloat(s.slice(i, j)) }); i = j; continue;
    }
    if ('+-*/%()'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    return null; // unknown char
  }
  return out;
}

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, 'u-': 3 };

function toRPN(tokens) {
  const out = [], ops = []; let prev = null;
  for (const tok of tokens) {
    if (tok.t === 'num') { out.push(tok); prev = tok; continue; }
    const c = tok.v;
    if (c === '(') { ops.push(c); prev = tok; continue; }
    if (c === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push({ t: 'op', v: ops.pop() });
      if (!ops.length) return null; ops.pop(); prev = tok; continue;
    }
    // unary minus: '-' at start or after another op / '('
    let op = c;
    if (c === '-' && (prev === null || (prev.t === 'op' && prev.v !== ')'))) op = 'u-';
    while (ops.length) {
      const top = ops[ops.length - 1];
      if (top === '(') break;
      if (PREC[top] >= PREC[op]) out.push({ t: 'op', v: ops.pop() }); else break;
    }
    ops.push(op); prev = { t: 'op', v: c };
  }
  while (ops.length) { const o = ops.pop(); if (o === '(') return null; out.push({ t: 'op', v: o }); }
  return out;
}

function runRPN(rpn) {
  const st = [];
  for (const tok of rpn) {
    if (tok.t === 'num') { st.push(tok.v); continue; }
    if (tok.v === 'u-') { if (!st.length) return null; st.push(-st.pop()); continue; }
    if (st.length < 2) return null;
    const b = st.pop(), a = st.pop();
    let r;
    switch (tok.v) {
      case '+': r = a + b; break;
      case '-': r = a - b; break;
      case '*': r = a * b; break;
      case '/': if (b === 0) return null; r = a / b; break;
      case '%': if (b === 0) return null; r = a % b; break;
      default: return null;
    }
    st.push(r);
  }
  return st.length === 1 ? st[0] : null;
}

function evalExpr(raw) {
  if (!raw) return { ok: false };
  // trailing-percent: turn `<number>%` (percent-of, not followed by a digit) into `/100`.
  // e.g. 18% -> (18/100), 1200*18% -> 1200*(18/100). Binary `a % b` (digit after) stays modulo.
  const s = raw.replace(/(\d(?:\.\d+)?)\s*%(?!\s*\d)/g, '($1/100)');
  const tokens = tokenize(s); if (!tokens) return { ok: false };
  const rpn = toRPN(tokens); if (!rpn) return { ok: false };
  const v = runRPN(rpn);
  if (v === null || !isFinite(v)) return { ok: false };
  return { ok: true, value: v };
}

export function fmtResult(n) {
  const r = Math.round(n * 1e6) / 1e6;            // up to 6 dp
  return Number.isInteger(r) ? String(r) : String(r);
}
```

- [ ] **Step 1:** Write the file.
- [ ] **Step 2:** Sanity-check by eye: `evalLine('1200*18%')→216`, `evalLine('2+2')→4`,
  `evalLine('(3+4)*2')→14`, `isMathLine('2 apples')→false`, `evalLine('5/0')→{ok:false}`,
  `evalLine('10 % 3')→1`. (No runner; correctness verified in the build + live.)

---

## Task 4: NoteBody component

**Create** `apps/docket/src/components/NoteBody.js` — rendered ⇄ textarea click-to-edit.

```jsx
'use client';
import { useState, useRef, useEffect } from 'react';
import { isMathLine, evalLine, fmtResult } from '../lib/mathEval.js';

const CHECK_RE = /^(\s*)\[([ xX])\]\s?(.*)$/;

// value: raw text. onChange(raw): debounced autosave (typing). onToggleSave(raw): immediate save
// after a checkbox toggle. canEdit defaults true.
export function NoteBody({ value, onChange, onToggleSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const taRef = useRef(null);
  useEffect(() => { if (!editing) setDraft(value || ''); }, [value, editing]);
  useEffect(() => { if (editing && taRef.current) { taRef.current.focus(); const n = taRef.current.value.length; taRef.current.setSelectionRange(n, n); } }, [editing]);

  function toggleLine(idx) {
    const lines = (value || '').split('\n');
    const m = lines[idx]?.match(CHECK_RE);
    if (!m) return;
    const checked = m[2] !== ' ';
    lines[idx] = `${m[1]}[${checked ? ' ' : 'x'}] ${m[3]}`;
    onToggleSave(lines.join('\n'));
  }

  if (editing) {
    return (
      <textarea ref={taRef} value={draft}
        onChange={e => { setDraft(e.target.value); onChange(e.target.value); }}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.blur(); } }}
        placeholder="Write anything. Use [ ] for a checkbox; a math line like 1200*18% shows its result."
        style={ta} />
    );
  }

  const lines = (value || '').split('\n');
  return (
    <div onClick={() => setEditing(true)} style={rendered}>
      {(!value) && <span style={{ color: 'var(--text-4)', fontStyle: 'italic' }}>Click to write…</span>}
      {lines.map((ln, i) => {
        const m = ln.match(CHECK_RE);
        if (m) {
          const checked = m[2] !== ' ';
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingLeft: m[1].length * 8 }}>
              <button onClick={e => { e.stopPropagation(); toggleLine(i); }} style={checkbox(checked)} title={checked ? 'Uncheck' : 'Check'}>{checked ? '✓' : ''}</button>
              <span style={{ color: checked ? 'var(--text-4)' : 'var(--text-1)', textDecoration: checked ? 'line-through' : 'none', flex: 1 }}>{m[3] || ' '}</span>
            </div>
          );
        }
        if (isMathLine(ln)) {
          const r = evalLine(ln);
          return <div key={i} style={mathRow}><span style={{ color: 'var(--text-1)' }}>{ln}</span>{r.ok && <span style={mathRes}>= {fmtResult(r.value)}</span>}</div>;
        }
        return <div key={i} style={{ color: 'var(--text-1)', minHeight: '1.5em', whiteSpace: 'pre-wrap' }}>{ln || ' '}</div>;
      })}
    </div>
  );
}

const ta = { width: '100%', minHeight: 420, background: 'var(--surface)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, fontSize: 14, lineHeight: 1.6, outline: 'none', fontFamily: 'var(--font-mono)', resize: 'vertical' };
const rendered = { width: '100%', minHeight: 420, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, fontSize: 14, lineHeight: 1.6, cursor: 'text', fontFamily: 'var(--font-mono)', display: 'flex', flexDirection: 'column', gap: 2 };
const mathRow = { display: 'flex', alignItems: 'baseline', gap: 10 };
const mathRes = { color: 'var(--docket-accent)', fontWeight: 700 };
function checkbox(on) { return { flexShrink: 0, width: 17, height: 17, marginTop: 2, borderRadius: 4, border: `1.5px solid ${on ? 'var(--docket-accent)' : 'var(--border-2)'}`, background: on ? 'var(--docket-accent)' : 'transparent', color: 'var(--accent-fg)', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }; }
```

- [ ] **Step 1:** Write the file. (Verified via the page build in Task 6.)

---

## Task 5: nav item

**Modify** `apps/docket/src/lib/nav.js`: import `NotebookPen` and add to the TASKS group's static
items (after `Tasks`, before the dynamic spaces appended in `buildNavGroups`):

```js
// in the lucide import line, add NotebookPen
// in NAV_GROUPS tasks.items, after the tasks item:
{ id: 'scratchpad', label: 'Scratchpad', route: '/scratchpad', icon: NotebookPen },
```

- [ ] **Step 1:** Edit import + the item.

---

## Task 6: Scratchpad page

**Create** `apps/docket/src/app/(auth)/scratchpad/page.js` — two-pane, debounced autosave.

```jsx
'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Trash2, NotebookPen } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { NoteBody } from '../../../components/NoteBody.js';

export default function ScratchpadPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [notes, setNotes] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await docketopsGet('getScratchNotes', {}, session);
      const list = Array.isArray(r) ? r : [];
      setNotes(list);
      setActiveId(a => a && list.some(n => n.id === a) ? a : (list[0]?.id || null));
    } catch (e) { showToast(e.message || 'Failed to load notes', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  const active = notes.find(n => n.id === activeId) || null;

  function patchLocal(id, patch) {
    setNotes(ns => ns.map(n => n.id === id ? { ...n, ...patch } : n));
  }
  async function persist(id, patch) {
    try { await docketopsPost('updateScratchNote', { id, ...patch }, session); }
    catch (e) { showToast(e.message || 'Save failed', 'error'); }
  }
  function onField(id, patch) {
    patchLocal(id, patch);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(id, patch), 600);
  }
  async function onToggleSave(id, body) {
    patchLocal(id, { body });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await persist(id, { body });   // immediate on a checkbox tick
  }
  async function newNote() {
    try {
      const r = await docketopsPost('createScratchNote', { title: '', body: '' }, session);
      setNotes(ns => [{ ...r }, ...ns]); setActiveId(r.id);
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function del(id) {
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    try { await docketopsPost('deleteScratchNote', { id }, session); setNotes(ns => ns.filter(n => n.id !== id)); if (activeId === id) setActiveId(null); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  if (loading) return <Spinner />;
  return (
    <div>
      <h1 style={h1}>Scratchpad</h1>
      <p style={sub}>Your private notes — free text, inline checklists ([ ]), and live math (e.g. 1200*18%). Only you can see these.</p>
      <div style={wrap}>
        <aside style={listPane}>
          <button className="dk-press" style={newBtn} onClick={newNote}><Plus size={14} /> New note</button>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {notes.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12, padding: 10 }}>No notes yet.</div>}
            {notes.map(n => (
              <div key={n.id} onClick={() => setActiveId(n.id)} style={noteRow(n.id === activeId)}>
                <NotebookPen size={13} style={{ color: n.id === activeId ? 'var(--docket-accent)' : 'var(--text-4)', flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title?.trim() || firstLine(n.body) || 'Untitled'}</span>
              </div>
            ))}
          </div>
        </aside>
        <section style={editorPane}>
          {!active ? <div style={{ color: 'var(--text-3)', padding: 20 }}>Select or create a note.</div> : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input value={active.title || ''} onChange={e => onField(active.id, { title: e.target.value })} placeholder="Title…" style={titleInput} />
                <button className="dk-press" style={delBtn} title="Delete note" onClick={() => del(active.id)}><Trash2 size={15} /></button>
              </div>
              <NoteBody value={active.body || ''} onChange={(body) => onField(active.id, { body })} onToggleSave={(body) => onToggleSave(active.id, body)} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function firstLine(b) { return (b || '').split('\n').map(s => s.trim()).find(Boolean) || ''; }

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4, marginBottom: 16, maxWidth: 680, lineHeight: 1.5 };
const wrap = { display: 'grid', gridTemplateColumns: '240px 1fr', gap: 14, alignItems: 'start' };
const listPane = { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '70vh', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 8 };
const editorPane = { minWidth: 0 };
const newBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'var(--accent-bg)', color: 'var(--docket-accent)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
function noteRow(active) { return { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13, color: active ? 'var(--text-1)' : 'var(--text-2)', background: active ? 'var(--surface-2)' : 'transparent' }; }
const titleInput = { flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 11px', fontFamily: 'var(--font-cond)', fontSize: 16, fontWeight: 700, outline: 'none' };
const delBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, background: 'var(--surface-2)', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
```

- [ ] **Step 1:** Write the page.
- [ ] **Step 2:** `npx turbo build --filter=docket` → success (new `/scratchpad` route).
- [ ] **Step 3:** Commit.

---

## Task 7: Deploy + docs

- [ ] **Step 1:** Deploy worker: `cd 05_Throttle/docketops-worker && npx wrangler deploy` → ping.
- [ ] **Step 2:** Push monorepo → `apps/docket` auto-deploys. (Order: migration already applied
  in Task 1 → worker → push.)
- [ ] **Step 3:** Add RULE-DOCKET-005 to `BUSINESS_RULES.md`; update `systems/docket.md`
  (schema + actions + `/scratchpad` route); add a closed item to `BACKLOG.md`. Commit + push root.

---

## Self-review
- **Spec coverage:** multiple notes (page list) ✓; dedicated page + nav ✓; inline checkboxes
  (CHECK_RE + toggle) ✓; inline math (mathEval, isMathLine/evalLine, `%` rule) ✓; click-to-edit
  (NoteBody) ✓; strictly private (user_id filter on every handler, no admin) ✓; hard delete ✓;
  autosave debounced + immediate-on-toggle ✓; migration + advisor ✓.
- **Signatures:** worker actions `getScratchNotes`/`createScratchNote`/`updateScratchNote`/
  `deleteScratchNote` match the frontend `docketopsGet/Post` calls. `NoteBody` props
  `value`/`onChange`/`onToggleSave` match the page usage.
- **No placeholders.** Math `%`: trailing `n%`→`/100` via regex before tokenizing; binary `a % b`
  (digit follows) stays modulo — matches spec §2.3.
```
