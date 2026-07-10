# Dyno V2 (A+B) — Record & operate surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the team record the *why* (variant + experiment verdicts, decision-tree edges, angle-library edits) and see creative thumbnails on the Dyno board in Odo — without touching the launch path.

**Architecture:** 5 new read/write worker actions in the `sales` schema (no Meta calls) + a representative-image bucket write folded into `metaCreateAd` + bulk-signed thumbnail URLs in `getDynoBoard`; a `VerdictModal` and Angle-Library UI in the Dyno page replacing the raw `prompt()`/`confirm()` flow. No migration (all columns/bucket exist from `0011_dyno_v1`).

**Tech Stack:** Cloudflare Worker (`odoops-worker/src/index.js`, ES module, deployed via `wrangler`), Next.js static-export app (`apps/odo`, `@throttle/ui` `Modal`), Supabase Postgres/Storage (service-role via the worker). No worker test harness — verification is syntax-check → deploy → `execute_sql`/curl → `turbo build` → browser smoke.

**Spec:** `docs/superpowers/specs/2026-07-10-dyno-v2-record-operate-design.md`.

**Conventions (match existing code):** worker read = `case` gated by `canView(P)`; write = `canAdsWrite(P)`; `sbSales(path, {method, prefer, body})` for PostgREST; `rpcSales(fn, args)` for RPCs; `ok(x)`/`err(msg, code)`; `ledgerWrite({actor_user_id, action, entity_type, entity_id, daily_delta_inr, request, status})`; `nowISO()`, `num()`; `managedGet('ad', metaId)`/`managedPatch`. `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are module constants. App: `salesGet(action, params, session)` (GET) / `salesPost(action, body, session)` (POST); `Modal` from `@throttle/ui`.

---

## Task 1: Worker — verdict / decision / angle actions

**Files:**
- Modify: `05_Throttle/odoops-worker/src/index.js` (add 5 `case` blocks next to `adsSetVerdict` ~L3155)

- [ ] **Step 1: Add the 5 actions after the existing `adsSetVerdict` case**

Insert immediately after the `adsSetVerdict` case (closes at ~L3165):

```js
          case 'adsSetPlanVerdict': {   // Dyno — experiment-grain verdict (writer; no spend impact)
            if (!canAdsWrite(P)) return err('No permission', 403);
            if (!d.plan_id) return err('plan_id required');
            const VERDICTS = ['winner', 'promising', 'killed', 'inconclusive', 'paused'];
            if (!VERDICTS.includes(d.verdict)) return err(`verdict must be one of: ${VERDICTS.join(', ')}`);
            const TERMINAL = new Set(['winner', 'killed', 'inconclusive']);
            const patch = { verdict: d.verdict, verdict_reason: d.reason || null, updated_at: nowISO() };
            // Stamp conclusion when a terminal verdict lands (unless caller overrode it).
            patch.concluded_at = d.concluded_at || (TERMINAL.has(d.verdict) ? nowISO() : null);
            const r = await sbSales(`/rest/v1/ads_plan?id=eq.${d.plan_id}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(patch) });
            if (!r.ok || !Array.isArray(r.data) || !r.data[0]) return err('Plan not found or update failed: ' + JSON.stringify(r.data), 404);
            await ledgerWrite({ actor_user_id: userId, action: 'adsSetPlanVerdict', plan_id: d.plan_id, daily_delta_inr: 0, request: d, status: 'ok' });
            return ok(r.data[0]);
          }
          case 'labAddDecision': {   // Dyno — a decision-tree edge (writer; no spend impact)
            if (!canAdsWrite(P)) return err('No permission', 403);
            const TYPES = ['kill', 'scale', 'graduate', 'iterate', 'pause', 'hold', 'restore-budget'];
            if (!TYPES.includes(d.type)) return err(`type must be one of: ${TYPES.join(', ')}`);
            if (!d.plan_id && !d.variant_meta_id) return err('plan_id or variant_meta_id required', 422);
            const row = { plan_id: d.plan_id || null, variant_meta_id: d.variant_meta_id || null,
              type: d.type, rationale: d.rationale || null, spawned_meta_id: d.spawned_meta_id || null,
              decided_by: userId, decided_at: nowISO() };
            const r = await sbSales('/rest/v1/lab_decisions', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) });
            if (!r.ok) return err('Decision write failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'labUpsertAngle': {   // Dyno — maintain the angle playbook from Odo (writer)
            if (!canAdsWrite(P)) return err('No permission', 403);
            if (!d.slug || !d.name) return err('slug and name required', 422);
            const STATUS = ['candidate', 'testing', 'proven', 'retired'];
            if (d.status && !STATUS.includes(d.status)) return err(`status must be one of: ${STATUS.join(', ')}`);
            const row = { slug: String(d.slug).trim(), name: d.name, description: d.description || null,
              psychology_pillar: d.psychology_pillar || null, hypothesis: d.hypothesis || null,
              status: d.status || 'candidate', evidence: d.evidence || null, updated_at: nowISO() };
            const r = await sbSales('/rest/v1/lab_angles?on_conflict=slug', { method: 'POST',
              prefer: 'return=representation,resolution=merge-duplicates', body: JSON.stringify(row) });
            if (!r.ok) return err('Angle upsert failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'getAngles': {   // Dyno — the angle library
            if (!canView(P)) return err('No permission', 403);
            const r = await sbSales('/rest/v1/lab_angles?select=*&order=slug.asc');
            if (!r.ok) return err('Angles read failed: ' + JSON.stringify(r.data), 502);
            return ok({ angles: r.data || [] });
          }
          case 'getDecisions': {   // Dyno — decisions for one experiment (on-demand)
            if (!canView(P)) return err('No permission', 403);
            if (!qp('plan_id')) return err('plan_id required', 422);
            const r = await sbSales(`/rest/v1/lab_decisions?plan_id=eq.${encodeURIComponent(qp('plan_id'))}&select=*&order=decided_at.desc`);
            if (!r.ok) return err('Decisions read failed: ' + JSON.stringify(r.data), 502);
            return ok({ decisions: r.data || [] });
          }
```

Note: `getAngles`/`getDecisions` are GET actions → they read query params via `qp(...)` and are reachable through `salesGet`. `adsSetPlanVerdict`/`labAddDecision`/`labUpsertAngle` are POST actions reading `d.*`.

- [ ] **Step 2: Syntax-check the worker**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/odoops-worker && cp src/index.js /tmp/idx.mjs && node --check /tmp/idx.mjs && echo OK; rm -f /tmp/idx.mjs
```
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add odoops-worker/src/index.js
git commit -m "odo(dyno): plan-verdict / decision / angle worker actions (V2-A)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Worker — asset thumbnails (bucket write in `metaCreateAd` + bulk-sign in `getDynoBoard`)

**Files:**
- Modify: `05_Throttle/odoops-worker/src/index.js` (`metaCreateAd` ~L3211; `getDynoBoard` ~L2528)

- [ ] **Step 1: Add a base64→bytes + bucket-store helper near the other storage code**

Add a module-scope helper (place it beside `managedUpsert`/`metaPost`, ~L1855):

```js
// Store one base64 image into the private lab-creatives bucket (best-effort — never throws).
// Returns the storage path on success, null on failure. Used for Dyno board thumbnails.
async function storeLabCreative(planId, adId, imageBase64) {
  try {
    if (!imageBase64) return null;
    const bin = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
    const path = `${planId}/${adId}.png`;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/lab-creatives/${path}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'image/png', 'x-upsert': 'true' },
      body: bin });
    if (!res.ok) { console.error('lab-creatives store failed', res.status, (await res.text()).slice(0, 160)); return null; }
    return path;
  } catch (e) { console.error('storeLabCreative error:', e?.message || e); return null; }
}
```

- [ ] **Step 2: Persist the representative image inside `metaCreateAd`, after the ad is created**

In the `metaCreateAd` `fn` (the carousel-capable version), **after** `const res = await metaPost(env, `act_${acct}/ads`, …)` and **before** the `managedUpsert(...)` call, add:

```js
                // Best-effort thumbnail: single-image → its bytes; carousel → card 1 (the hook).
                const thumbB64 = isCarousel ? (ad.cards[0] && ad.cards[0].image_base64) : ad.image_base64;
                const assetPath = thumbB64 ? await storeLabCreative(d.plan_id, res.id, thumbB64) : null;
```

Then add `asset_url: assetPath` to the `managedUpsert` call so it lands on the row:

```js
                await managedUpsert({ entity_type: 'ad', meta_id: res.id, parent_id: d.adset_id, plan_id: d.plan_id, channel_id: plan.channel_id, ad_account_id: acct, name: ad.name || null, daily_budget_inr: 0, status: 'paused', ...dynoMeta, asset_url: assetPath });
```

(The `...dynoMeta` already carries `format`/`angle`/etc.; `asset_url` is added explicitly so a null from a hash-only launch doesn't clobber an existing thumbnail — a re-run with bytes re-stores it.)

- [ ] **Step 3: Bulk-sign asset paths in `getDynoBoard`**

Replace the `getDynoBoard` return (`return ok({ rows: r.data || [], … })`) with a version that signs the paths first:

```js
            const rows = r.data || [];
            // Board thumbnails live in the private lab-creatives bucket → bulk-sign all paths in ONE
            // subrequest so the browser can load them; the 60s poll re-signs before expiry.
            const paths = [...new Set(rows.map(x => x.asset_url).filter(Boolean))];
            if (paths.length) {
              try {
                const sg = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/lab-creatives`, {
                  method: 'POST', headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ expiresIn: 3600, paths }) });
                if (sg.ok) {
                  const signed = await sg.json();   // [{ path, signedURL }]
                  const byPath = {}; for (const s of signed) byPath[s.path] = `${SUPABASE_URL}/storage/v1${s.signedURL}`;
                  for (const x of rows) if (x.asset_url && byPath[x.asset_url]) x.asset_url = byPath[x.asset_url];
                }
              } catch (e) { console.error('lab-creatives sign failed:', e?.message || e); }   // non-fatal — thumbnails just fall back to placeholders
            }
            return ok({ rows, recent_days: recentDays,
              committed_daily_inr: await adsCommittedDailyInr(), ceiling_inr: await adsCeilingInr(),
              write_enabled: await adsWriteEnabled() });
```

(The Supabase sign endpoint returns `signedURL` as a path beginning `/object/sign/...`; prefix with `${SUPABASE_URL}/storage/v1` to make it absolute. A row whose sign failed keeps its raw storage path, which the `<img>` can't load → the `Thumb` placeholder shows, which is fine.)

- [ ] **Step 4: Syntax-check**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/odoops-worker && cp src/index.js /tmp/idx.mjs && node --check /tmp/idx.mjs && echo OK; rm -f /tmp/idx.mjs
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add odoops-worker/src/index.js
git commit -m "odo(dyno): persist representative creative to lab-creatives + bulk-signed board thumbnails (V2-B)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Deploy the worker + DB-verify the new actions

**Files:** none (deploy + verify)

- [ ] **Step 1: Push then deploy** (commit-before-deploy per the LOT rule)

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && git pull --rebase && git push
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/odoops-worker && npx wrangler deploy
```
Expected: `Deployed odoops` + a new `Current Version ID`.

- [ ] **Step 2: Verify the angle-library round-trip via a live write (mint the 2 Fang slugs — doubles as the acceptance check)**

Use `execute_sql` (project `jkxcnjabmrkteanzoofj`) to confirm the actions wrote correctly AFTER exercising them from the UI in Task 6 — but first sanity-check the tables are reachable:
```sql
select count(*) from sales.lab_angles;
select count(*) from sales.lab_decisions;
```
Expected: counts return (11 angles seeded, N decisions).

- [ ] **Step 3: Confirm the bucket exists + is private**

```sql
select id, public from storage.buckets where id = 'lab-creatives';
```
Expected: one row, `public = false`.

(No commit — deploy/verify only.)

---

## Task 4: App — `VerdictModal` + wire Verdict / Kill / Conclude

**Files:**
- Modify: `05_Throttle/apps/odo/src/app/(auth)/dyno/page.js`

- [ ] **Step 1: Import `Modal` and add decision/verdict vocab**

At the top imports, add `Modal`:
```js
import { Spinner, Modal } from '@throttle/ui';
```
Below the existing `const VERDICTS = [...]` (~L31) add:
```js
const DECISION_TYPES = ['kill', 'scale', 'graduate', 'iterate', 'pause', 'hold', 'restore-budget'];
```

- [ ] **Step 2: Add the `VerdictModal` component (bottom of the file, beside `BtnMini`)**

```js
// One modal for both grains. mode='variant' → adsSetVerdict(meta_id); mode='plan' → adsSetPlanVerdict(plan_id).
// Optionally also logs a lab_decisions edge when a decision type is chosen.
function VerdictModal({ open, mode, target, session, onClose, onDone }) {
  const [verdict, setVerdict] = useState(target?.verdict || '');
  const [reason, setReason] = useState(target?.verdict_reason || '');
  const [decType, setDecType] = useState('');
  const [decWhy, setDecWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');
  useEffect(() => { if (open) { setVerdict(target?.verdict || ''); setReason(target?.verdict_reason || ''); setDecType(''); setDecWhy(''); setE(''); } }, [open, target]);
  if (!open) return null;
  const submit = async () => {
    if (!verdict) { setE('Pick a verdict.'); return; }
    setBusy(true); setE('');
    try {
      if (mode === 'plan') await salesPost('adsSetPlanVerdict', { plan_id: target.plan_id, verdict, reason }, session);
      else await salesPost('adsSetVerdict', { meta_id: target.meta_id, verdict, reason }, session);
      if (decType) await salesPost('labAddDecision', {
        plan_id: target.plan_id, variant_meta_id: mode === 'variant' ? target.meta_id : null,
        type: decType, rationale: decWhy }, session);
      onDone();
    } catch (err) { setE(String(err?.message || err)); setBusy(false); }
  };
  const title = mode === 'plan' ? `Conclude ${target.product} · ${target.batch}` : `Verdict — ${target.ad_name}`;
  return (
    <Modal open onClose={onClose} title={title}>
      <div style={{ display: 'grid', gap: 12, minWidth: 340 }}>
        <label style={{ fontSize: 12, color: 'var(--t2)' }}>Verdict
          <select value={verdict} onChange={ev => setVerdict(ev.target.value)} style={{ width: '100%', marginTop: 4, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }}>
            <option value="">— choose —</option>{VERDICTS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--t2)' }}>Reason / why
          <textarea value={reason} onChange={ev => setReason(ev.target.value)} rows={3} style={{ width: '100%', marginTop: 4, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)', resize: 'vertical' }} />
        </label>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 6 }}>Optionally log a decision (feeds the decision tree)</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={decType} onChange={ev => setDecType(ev.target.value)} style={{ flex: '0 0 150px', padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }}>
              <option value="">— no decision —</option>{DECISION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input value={decWhy} onChange={ev => setDecWhy(ev.target.value)} placeholder="rationale" disabled={!decType} style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }} />
          </div>
        </div>
        {e && <div style={{ color: 'var(--red)', fontSize: 12 }}>{e}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="so-btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="so-btn" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: Add modal state + open helpers in `DynoPage`, replace the `prompt`-based `setVerdict`/`kill`**

Add state near the other `useState`s (~L81):
```js
  const [vModal, setVModal] = useState(null);   // { mode:'variant'|'plan', target }
```
Replace the existing `setVerdict` function (~L153-159) with:
```js
  const openVerdict = (r) => setVModal({ mode: 'variant', target: r });
  const openConclude = (plan) => setVModal({ mode: 'plan', target: plan });
```
Replace the existing `kill` function (~L131-138) with a modal-first kill (pause immediately, then verdict via modal):
```js
  const kill = (r) => setVModal({ mode: 'variant', target: { ...r, verdict: 'killed' }, alsoPause: true });
```
And in `VerdictModal`'s `submit`, pause first when `alsoPause` — extend the `submit` in the modal to accept it: change the `mode === 'variant'` branch to:
```js
      else {
        if (target.alsoPause) await salesPost('metaSetStatus', { entity_type: 'ad', meta_id: target.meta_id, status: 'PAUSED', plan_id: target.plan_id }, session);
        await salesPost('adsSetVerdict', { meta_id: target.meta_id, verdict, reason }, session);
      }
```

- [ ] **Step 4: Wire the buttons + render the modal**

Row actions (~L294-297): the **Kill** and **Verdict** buttons call `kill(r)` / `openVerdict(r)` (already do after Step 3's rename — `openVerdict` replaces `setVerdict`). Update the Verdict button:
```js
                              <BtnMini onClick={() => openVerdict(r)} disabled={isBusy}>Verdict</BtnMini>
```
Experiment header (~after the Approve&Launch button block, inside the header flex ~L230): add a Conclude button (writer-gated):
```js
                {canWrite && !staged && (
                  <button className="so-btn ghost" style={{ marginLeft: staged ? 0 : 'auto' }} onClick={() => openConclude(plan)}>Conclude</button>
                )}
```
At the end of `DynoPage`'s returned JSX (just before the closing `</div>` at ~L310), render the modal:
```js
      {vModal && (
        <VerdictModal open mode={vModal.mode} target={vModal.target} session={session}
          onClose={() => setVModal(null)}
          onDone={() => { setVModal(null); load(true); }} />
      )}
```

- [ ] **Step 5: Build the app**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=odo
```
Expected: build succeeds, 0 errors (static export).

- [ ] **Step 6: Commit**

```bash
git add apps/odo/src/app/\(auth\)/dyno/page.js
git commit -m "odo(dyno): VerdictModal — variant + plan verdict + decision logging, replace prompts (V2-A)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: App — Decisions strip + Angle Library

**Files:**
- Modify: `05_Throttle/apps/odo/src/app/(auth)/dyno/page.js`

- [ ] **Step 1: Decisions strip in the expanded experiment**

Add state + a loader in `DynoPage`:
```js
  const [decisions, setDecisions] = useState({});   // plan_id → rows
  const loadDecisions = useCallback(async (planId) => {
    if (decisions[planId]) return;
    try { const r = await salesGet('getDecisions', { plan_id: planId }, session); setDecisions(x => ({ ...x, [planId]: r.decisions || [] })); }
    catch { /* non-fatal */ }
  }, [decisions, session]);
```
In the experiment header, after the hypothesis/verdict lines (~L233), add a toggle that loads + shows decisions:
```js
              <DecisionStrip planId={plan.plan_id} rows={decisions[plan.plan_id]} onOpen={() => loadDecisions(plan.plan_id)} />
```
Add the component (beside `VerdictModal`):
```js
function DecisionStrip({ planId, rows, onOpen }) {
  const [open, setOpen] = useState(false);
  const toggle = () => { const n = !open; setOpen(n); if (n) onOpen(); };
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={toggle} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
        {open ? 'hide decisions' : 'decisions'}
      </button>
      {open && (
        <div style={{ marginTop: 5, display: 'grid', gap: 3 }}>
          {!rows && <div style={{ fontSize: 11, color: 'var(--t3)' }}>loading…</div>}
          {rows && rows.length === 0 && <div style={{ fontSize: 11, color: 'var(--t3)' }}>No decisions logged.</div>}
          {rows && rows.map(dc => (
            <div key={dc.id} style={{ fontSize: 11, color: 'var(--t2)' }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--t1)' }}>{dc.type}</span>
              {dc.rationale ? ` — ${dc.rationale}` : ''} <span style={{ color: 'var(--t3)' }}>· {new Date(dc.decided_at).toLocaleDateString('en-IN')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Angle Library — collapsible section above the experiment list**

Add state + loader in `DynoPage`:
```js
  const [angles, setAngles] = useState(null);
  const [showAngles, setShowAngles] = useState(false);
  const loadAngles = useCallback(async () => {
    try { const r = await salesGet('getAngles', {}, session); setAngles(r.angles || []); }
    catch (er) { setErr(String(er?.message || er)); }
  }, [session]);
  useEffect(() => { if (showAngles && angles == null) loadAngles(); }, [showAngles, angles, loadAngles]);
```
Add the toggle button in the filter row (~L204, after the SegmentedToggle):
```js
        <button className="so-btn ghost" onClick={() => setShowAngles(s => !s)}>{showAngles ? 'Hide' : 'Angle library'}</button>
```
Render the panel just below the filter row (before the experiment groups map ~L213), passing the writer flag:
```js
      {showAngles && <AngleLibrary angles={angles} canWrite={canWrite} session={session} onSaved={loadAngles} />}
```
Add the component:
```js
const ANGLE_STATUS = ['candidate', 'testing', 'proven', 'retired'];
function AngleLibrary({ angles, canWrite, session, onSaved }) {
  const [draft, setDraft] = useState(null);   // { slug, name, psychology_pillar, status, hypothesis, evidence }
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');
  const blank = { slug: '', name: '', psychology_pillar: '', status: 'candidate', hypothesis: '', evidence: '' };
  const save = async () => {
    if (!draft.slug.trim() || !draft.name.trim()) { setE('slug and name required'); return; }
    setBusy(true); setE('');
    try { await salesPost('labUpsertAngle', draft, session); setDraft(null); await onSaved(); }
    catch (er) { setE(String(er?.message || er)); } finally { setBusy(false); }
  };
  return (
    <div className="so-card" style={{ padding: 14, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <b style={{ fontFamily: 'var(--cond)', fontSize: 14 }}>Angle library</b>
        {canWrite && !draft && <button className="so-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setDraft(blank)}>+ New angle</button>}
      </div>
      {angles == null && <Spinner />}
      {angles && (
        <div style={{ display: 'grid', gap: 4 }}>
          {angles.map(a => (
            <div key={a.slug} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--t1)', minWidth: 190 }}>{a.slug}</span>
              <span style={{ color: 'var(--t2)', flex: 1 }}>{a.name}</span>
              <Tag tone="var(--t3)">{a.status}</Tag>
              {canWrite && <button onClick={() => setDraft({ slug: a.slug, name: a.name, psychology_pillar: a.psychology_pillar || '', status: a.status, hypothesis: a.hypothesis || '', evidence: a.evidence || '' })} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>edit</button>}
            </div>
          ))}
        </div>
      )}
      {draft && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={draft.slug} onChange={ev => setDraft({ ...draft, slug: ev.target.value })} placeholder="slug (e.g. working-machine)" style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }} />
            <input value={draft.name} onChange={ev => setDraft({ ...draft, name: ev.target.value })} placeholder="name" style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }} />
            <select value={draft.status} onChange={ev => setDraft({ ...draft, status: ev.target.value })} style={{ flex: '0 0 130px', padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }}>{ANGLE_STATUS.map(s => <option key={s} value={s}>{s}</option>)}</select>
          </div>
          <input value={draft.psychology_pillar} onChange={ev => setDraft({ ...draft, psychology_pillar: ev.target.value })} placeholder="psychology_pillar (optional)" style={{ padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }} />
          <textarea value={draft.hypothesis} onChange={ev => setDraft({ ...draft, hypothesis: ev.target.value })} rows={2} placeholder="hypothesis (optional)" style={{ padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)', resize: 'vertical' }} />
          {e && <div style={{ color: 'var(--red)', fontSize: 12 }}>{e}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="so-btn ghost" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
            <button className="so-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save angle'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build the app**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=odo
```
Expected: build succeeds, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/odo/src/app/\(auth\)/dyno/page.js
git commit -m "odo(dyno): Decisions strip + Angle library UI (V2-A)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Push, verify, hand off browser smoke

**Files:** none

- [ ] **Step 1: Push (app auto-deploys via CI; worker already deployed in Task 3)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && git pull --rebase && git push
```
Expected: pushed; CI builds + deploys `apps/odo` (3–4 min).

- [ ] **Step 2: DB-verify the write actions landed (after exercising them, or via a direct curl)**

After using the UI (or a curl with a super-admin JWT), confirm rows wrote:
```sql
select id, plan_id, variant_meta_id, type, rationale, decided_at from sales.lab_decisions order by decided_at desc limit 5;
select slug, name, status from sales.lab_angles where slug in ('working-machine','future-engineer');
select id, verdict, verdict_reason, concluded_at from sales.ads_plan where verdict is not null order by concluded_at desc nulls last limit 5;
```
Expected: decision rows present; the 2 Fang angle slugs exist (if minted); plan verdicts present.

- [ ] **Step 3: Update knowledge files**

- `systems/odo.md`: prepend a dated entry — "Dyno V2 (A+B): plan-verdict/decision/angle actions + VerdictModal + Angle Library + board thumbnails (lab-creatives bucket write in metaCreateAd + bulk-signed URLs). Launch-from-Odo (C) still deferred."
- `BACKLOG.md` `[odo]` Dyno V2 item: mark (b) asset upload/thumbnails + (d) verdict/decision UI **DONE**; leave (c) one-click Approve&Launch + `adsSavePlan` staged-status as the remaining V2/C. Update the "Tag the still-NULL Dyno rows" item — Fang slugs can now be minted from the Angle Library UI.
Commit + push root.

- [ ] **Step 4: Hand off the authenticated browser smoke to Afshaan**

Post the check list: sign in to `odo.legendoftoys.com/dyno` → (1) Verdict modal on a row saves verdict+reason; (2) Kill pauses + records `killed`; (3) Conclude sets an experiment verdict; (4) Angle library lists 11 + "+ New angle" mints one (mint `working-machine`, `future-engineer` for Fang); (5) after the next engine launch, a real thumbnail renders. (Thumbnails only appear for ads launched after this ships.)

---

## Self-review notes

- **Spec coverage:** §2a five actions → Task 1; §2b modal/decisions/angle UI → Tasks 4–5; §3b-i bucket write → Task 2 Step 2; §3b-ii bulk-sign → Task 2 Step 3; §7 acceptance → Tasks 3/6 verification. All covered.
- **Type consistency:** `asset_url` holds a storage path on write (Task 2 Step 2) and is overwritten with a signed URL on read (Task 2 Step 3) — `Thumb` renders whichever; consistent. `VerdictModal` prop `mode` is `'variant'|'plan'` throughout. `salesGet`/`salesPost` signatures match `lib/api.js`.
- **No migration** — all columns/bucket pre-exist (verified live: `lab_angles` 11 rows, `lab-creatives` bucket private).
