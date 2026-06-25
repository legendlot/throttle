# Snorkel Sales Credit Notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GST sales credit notes to Snorkel Offline Sales — line-item documents raised against an invoiced sales order that reduce the partner's net receivable and output GST, printable to PDF.

**Architecture:** Two new `store` tables (`sales_credit_notes` + `_lines`) mirroring the invoice shape + a `credit_total` rollup on `sales_orders`. New snorkelops worker actions (reads + draft→issue→cancel writes) reusing the existing invoice GST-split + sequence patterns. New `apps/snorkel` `/sales/credit-notes` pages + a printable doc cloned from the invoice template. AR recompute nets credits.

**Tech Stack:** Cloudflare Worker (`snorkelops`, plain JS), Supabase Postgres (`store` schema, service_role, RLS), Next.js static-export app (`apps/snorkel`), `@throttle/db` (`garageFetch` GET / `workerFetch` POST), `@throttle/auth`.

**Spec:** `docs/superpowers/specs/2026-06-25-snorkel-sales-credit-notes-design.md`

**Verification model (no unit-test harness in this repo):**
- DB: `apply_migration` via Supabase MCP → `get_advisors` (security/perf) must be clean → `execute_sql` data-path assertions.
- Worker: edit → commit → push → `cd 05_Throttle/snorkelops-worker && npx wrangler deploy` → verify via `execute_sql` (writes land correctly) and/or authed `curl` of the read actions.
- App: `npx turbo build --filter=snorkel` must be zero-error → commit → auto-deploys (gh-pages).
- Project (`jkxcnjabmrkteanzoofj`), schema `store`, all numerics read back as strings → `Number()`; integer inserts → `Math.round()`.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| Supabase migration `snorkel_sales_credit_notes_v1` | 2 tables + `sales_orders.credit_total` + grants + RLS + indexes | create |
| `05_Throttle/snorkelops-worker/src/index.js` | helpers + perm gate + 3 reads + 5 writes + net AR recompute | modify |
| `05_Throttle/apps/snorkel/src/lib/sales.js` | credit-note reasons + helpers | modify |
| `05_Throttle/apps/snorkel/src/lib/nav.js` | Credit Notes nav entry | modify |
| `05_Throttle/apps/snorkel/src/app/(auth)/sales/credit-notes/page.js` | list + KPIs + CSV | create |
| `05_Throttle/apps/snorkel/src/app/(auth)/sales/credit-notes/new/page.js` | create form (pick invoiced SO → capped lines) | create |
| `05_Throttle/apps/snorkel/src/app/(auth)/sales/credit-notes/detail/page.js` | view / edit-draft / issue / cancel | create |
| `05_Throttle/apps/snorkel/src/app/(auth)/sales/credit-notes/print/page.js` | printable CREDIT NOTE (clone of invoice) | create |
| `05_Throttle/apps/snorkel/src/app/(auth)/sales/orders/detail/page.js` | Credit Notes panel + net due | modify |
| `05_Throttle/apps/snorkel/src/app/(auth)/admin/roles/page.js` | `sales_credit_note` in PERM_DEFS | modify |
| `systems/snorkel.md`, `CORE.md` | RULE-SNORKEL-004 #9 + schema map | modify |

---

## Task 1: Migration — tables, rollup column, grants, RLS, indexes

**Files:** Supabase migration `snorkel_sales_credit_notes_v1` (via MCP `apply_migration`).

- [ ] **Step 1: Verify the base tables before changing them**

Run (MCP `execute_sql`, project `jkxcnjabmrkteanzoofj`):
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='store' AND table_name='sales_orders' AND column_name='credit_total';
```
Expected: 0 rows (column not yet present).

- [ ] **Step 2: Apply the migration**

MCP `apply_migration`, name `snorkel_sales_credit_notes_v1`:
```sql
ALTER TABLE store.sales_orders ADD COLUMN IF NOT EXISTS credit_total numeric NOT NULL DEFAULT 0;

CREATE TABLE store.sales_credit_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cn_no           text,
  order_id        uuid NOT NULL REFERENCES store.sales_orders(id),
  partner_id      uuid NOT NULL REFERENCES store.sales_partners(id),
  invoice_no      text NOT NULL,
  invoice_date    date,
  cn_date         date NOT NULL DEFAULT CURRENT_DATE,
  reason          text NOT NULL CHECK (reason IN ('under_supply','transit_loss_damage','sales_return','price_drop','other')),
  reason_note     text,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
  place_of_supply text,
  subtotal        numeric NOT NULL DEFAULT 0,
  tax_total       numeric NOT NULL DEFAULT 0,
  grand_total     numeric NOT NULL DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  issued_by       uuid,
  issued_at       timestamptz,
  cancelled_by    uuid,
  cancelled_at    timestamptz,
  cancel_reason   text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store.sales_credit_note_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id uuid NOT NULL REFERENCES store.sales_credit_notes(id) ON DELETE CASCADE,
  order_line_id  uuid REFERENCES store.sales_order_lines(id),
  product        text,
  model          text,
  color          text,
  sku            text,
  hsn_code       text,
  description    text,
  qty            integer NOT NULL DEFAULT 0,
  rate           numeric NOT NULL DEFAULT 0,
  discount_pct   numeric NOT NULL DEFAULT 0,
  gst_pct        numeric NOT NULL DEFAULT 0,
  taxable_value  numeric NOT NULL DEFAULT 0,
  gst_amount     numeric NOT NULL DEFAULT 0,
  line_total     numeric NOT NULL DEFAULT 0,
  sort_order     integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX sales_credit_notes_cn_no_uq ON store.sales_credit_notes(cn_no) WHERE cn_no IS NOT NULL;
CREATE INDEX sales_credit_notes_order_idx   ON store.sales_credit_notes(order_id);
CREATE INDEX sales_credit_notes_partner_idx ON store.sales_credit_notes(partner_id);
CREATE INDEX sales_credit_notes_status_idx  ON store.sales_credit_notes(status);
CREATE INDEX sales_credit_note_lines_cn_idx ON store.sales_credit_note_lines(credit_note_id);

ALTER TABLE store.sales_credit_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE store.sales_credit_note_lines ENABLE ROW LEVEL SECURITY;
GRANT ALL ON store.sales_credit_notes      TO service_role;
GRANT ALL ON store.sales_credit_note_lines TO service_role;
```

- [ ] **Step 3: Verify structure + RLS + advisors**

Run (`execute_sql`):
```sql
SELECT relname, relrowsecurity FROM pg_class
WHERE relnamespace='store'::regnamespace AND relname IN ('sales_credit_notes','sales_credit_note_lines');
```
Expected: both rows `relrowsecurity = true`.

Then MCP `get_advisors` type `security` → expect no new `rls_disabled_in_public`/exposed findings for these tables.

- [ ] **Step 4: No git commit** (migrations live in Supabase, not the repo). Proceed to Task 2.

---

## Task 2: Worker — helpers, perm gate, reads, writes, AR recompute

**Files:** Modify `05_Throttle/snorkelops-worker/src/index.js`.

All new code reuses existing helpers in this file: `query`, `queryPublic`, `insert`, `update`, `sb`, `rpc`, `ok`, `err`, `todayISO`, `fyLabel`, `nextSeq4`, `computeSalesLine`, `recomputeSalesPayment`, and auth locals `P`, `userId`, `authResult.fullName`.

- [ ] **Step 1: Add the perm gate** next to the other sales gates (after line ~54, the `canSalesPartner` line):

```js
const canSalesCreditNote = p => !!p.sales_credit_note; // raise/edit/issue/cancel credit notes
```

- [ ] **Step 2: Add the credit-note helpers** immediately after `nextInvoiceNo` (after line ~208):

```js
// GST-continuous credit-note no per FY: LOT/CN/<fy>/NNNN (same lazy-seq pattern as nextInvoiceNo).
async function nextCreditNoteNo(dateISO) {
  const fy = fyLabel(dateISO);
  const key = 'sales_credit_note_' + fy;
  await sb('/rest/v1/sequences', {
    method: 'POST', body: JSON.stringify({ name: key, current_val: 0 }), prefer: 'return=minimal',
  });
  const r = await rpc('next_seq', { seq_name: key });
  if (!r.ok || r.data == null) throw new Error('Credit-note seq error: ' + JSON.stringify(r.data));
  return `LOT/CN/${fy}/${String(r.data).padStart(4, '0')}`;
}

// Roll up ISSUED credit notes onto the order, then net the payment status.
async function recomputeOrderCredit(orderId) {
  const [oR, cR, pR] = await Promise.all([
    query('sales_orders', `?id=eq.${encodeURIComponent(orderId)}&select=grand_total&limit=1`),
    query('sales_credit_notes', `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.issued&select=grand_total`),
    query('sales_payments', `?order_id=eq.${encodeURIComponent(orderId)}&select=amount`),
  ]);
  const grand  = oR.ok ? Number(oR.data?.[0]?.grand_total) || 0 : 0;
  const credit = cR.ok ? (cR.data || []).reduce((s, c) => s + (Number(c.grand_total) || 0), 0) : 0;
  const recv   = pR.ok ? (pR.data || []).reduce((s, p) => s + (Number(p.amount) || 0), 0) : 0;
  const net    = +(grand - credit).toFixed(2);
  const status = (recv > 0 && recv >= net - 0.005) ? 'paid' : recv > 0 ? 'partial' : 'unpaid';
  await update('sales_orders',
    { credit_total: +credit.toFixed(2), amount_received: +recv.toFixed(2),
      payment_status: status, updated_at: new Date().toISOString() },
    `id=eq.${encodeURIComponent(orderId)}`);
}

// Per-line GST split for intra vs inter (same logic getSalesInvoiceData uses).
function splitGstLine(l, intra) {
  const gstAmt = Number(l.gst_amount) || 0, gstPct = Number(l.gst_pct) || 0;
  return { ...l,
    cgst_pct: intra ? gstPct / 2 : 0, sgst_pct: intra ? gstPct / 2 : 0, igst_pct: intra ? 0 : gstPct,
    cgst_amount: intra ? +(gstAmt / 2).toFixed(2) : 0,
    sgst_amount: intra ? +(gstAmt / 2).toFixed(2) : 0,
    igst_amount: intra ? 0 : +gstAmt.toFixed(2) };
}
```

- [ ] **Step 3: Update `recomputeSalesPayment` to net credits** (replace the body at lines ~350-361):

```js
async function recomputeSalesPayment(orderId) {
  const [oR, pR] = await Promise.all([
    query('sales_orders', `?id=eq.${encodeURIComponent(orderId)}&select=grand_total,credit_total&limit=1`),
    query('sales_payments', `?order_id=eq.${encodeURIComponent(orderId)}&select=amount`),
  ]);
  const grand  = oR.ok ? Number(oR.data?.[0]?.grand_total) || 0 : 0;
  const credit = oR.ok ? Number(oR.data?.[0]?.credit_total) || 0 : 0;
  const net    = +(grand - credit).toFixed(2);
  const recv   = pR.ok ? (pR.data || []).reduce((s, p) => s + (Number(p.amount) || 0), 0) : 0;
  const status = (recv > 0 && recv >= net - 0.005) ? 'paid' : recv > 0 ? 'partial' : 'unpaid';
  await update('sales_orders',
    { amount_received: +recv.toFixed(2), payment_status: status, updated_at: new Date().toISOString() },
    `id=eq.${encodeURIComponent(orderId)}`);
}
```

- [ ] **Step 4: Add the three READ actions** inside the GET `switch(action)` block, after the `getSalesInvoiceData` case (after line ~1091):

```js
          case 'getCreditNotes': {
            if (!canSalesView(P)) return err('No permission', 403);
            let params = '?order=created_at.desc&select=*,sales_partners(name)';
            const st = url.searchParams.get('status');
            const pid = url.searchParams.get('partner_id');
            const oid = url.searchParams.get('order_id');
            if (st)  params += `&status=eq.${encodeURIComponent(st)}`;
            if (pid) params += `&partner_id=eq.${encodeURIComponent(pid)}`;
            if (oid) params += `&order_id=eq.${encodeURIComponent(oid)}`;
            const r = await query('sales_credit_notes', params);
            if (!r.ok) return err(r.data);
            const rows = (r.data || []).map(c => ({ ...c, partner_name: c.sales_partners?.name || null, sales_partners: undefined }));
            return ok(rows);
          }

          case 'getCreditNote': {
            if (!canSalesView(P)) return err('No permission', 403);
            const id = url.searchParams.get('id');
            if (!id) return err('id required');
            const r = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(id)}&select=*,sales_partners(*)&limit=1`);
            if (!r.ok) return err(r.data);
            const cn = r.data?.[0];
            if (!cn) return err('Credit note not found', 404);
            const [linesR, orderR, sellerR] = await Promise.all([
              query('sales_credit_note_lines', `?credit_note_id=eq.${encodeURIComponent(id)}&order=sort_order.asc`),
              query('sales_orders', `?id=eq.${encodeURIComponent(cn.order_id)}&select=order_no,grand_total,credit_total,amount_received&limit=1`),
              query('company_addresses', '?is_registered_office=eq.true&active=eq.true&select=*&limit=1'),
            ]);
            const seller = sellerR.ok ? sellerR.data?.[0] || null : null;
            const intra = !!(seller?.state && cn.place_of_supply &&
                           seller.state.trim().toLowerCase() === cn.place_of_supply.trim().toLowerCase());
            const lines = (linesR.ok ? linesR.data : []).map(l => splitGstLine(l, intra));
            return ok({ cn: { ...cn, sales_partners: undefined }, partner: cn.sales_partners || null,
              order: orderR.ok ? orderR.data?.[0] || null : null, seller, intra, lines });
          }

          case 'getOrderForCreditNote': {
            if (!canSalesView(P)) return err('No permission', 403);
            const id = url.searchParams.get('order_id');
            if (!id) return err('order_id required');
            const r = await query('sales_orders', `?id=eq.${encodeURIComponent(id)}&select=*,sales_partners(*)&limit=1`);
            if (!r.ok) return err(r.data);
            const o = r.data?.[0];
            if (!o) return err('Order not found', 404);
            if (!o.invoice_generated) return err('Order has no invoice — cannot raise a credit note', 422);
            const [linesR, cnR] = await Promise.all([
              query('sales_order_lines', `?order_id=eq.${encodeURIComponent(id)}&order=sort_order.asc`),
              query('sales_credit_notes', `?order_id=eq.${encodeURIComponent(id)}&status=in.(draft,issued)&select=id,grand_total`),
            ]);
            const cnIds = (cnR.ok ? cnR.data : []).map(c => c.id);
            let creditedByLine = {};
            if (cnIds.length) {
              const clR = await query('sales_credit_note_lines',
                `?credit_note_id=in.(${cnIds.map(encodeURIComponent).join(',')})&select=order_line_id,qty`);
              (clR.ok ? clR.data : []).forEach(cl => {
                if (cl.order_line_id) creditedByLine[cl.order_line_id] = (creditedByLine[cl.order_line_id] || 0) + (Number(cl.qty) || 0);
              });
            }
            const existingCredit = (cnR.ok ? cnR.data : []).reduce((s, c) => s + (Number(c.grand_total) || 0), 0);
            const lines = (linesR.ok ? linesR.data : []).map(l => ({
              ...l, credited_qty: creditedByLine[l.id] || 0,
              remaining_qty: Math.max(0, (Number(l.qty) || 0) - (creditedByLine[l.id] || 0)),
            }));
            return ok({ order: { ...o, sales_partners: undefined }, partner: o.sales_partners || null,
              lines, existing_credit_total: +existingCredit.toFixed(2),
              remaining_value: +(Number(o.grand_total || 0) - existingCredit).toFixed(2) });
          }
```

- [ ] **Step 5: Add a shared CN-build helper** near the other helpers (after `splitGstLine`):

```js
// Build CN header totals + line rows from incoming lines (reuses computeSalesLine math).
function buildCreditNote(linesIn) {
  const lines = (linesIn || []).map(computeSalesLine);
  const subtotal    = +lines.reduce((s, l) => s + l.taxable_value, 0).toFixed(2);
  const tax_total   = +lines.reduce((s, l) => s + l.gst_amount, 0).toFixed(2);
  const grand_total = +(subtotal + tax_total).toFixed(2);
  return { lines, subtotal, tax_total, grand_total };
}
// Cap check: existing (draft+issued, excluding self) + this ≤ invoice grand_total.
async function creditCapRemaining(orderId, excludeCnId) {
  const oR = await query('sales_orders', `?id=eq.${encodeURIComponent(orderId)}&select=grand_total&limit=1`);
  const grand = oR.ok ? Number(oR.data?.[0]?.grand_total) || 0 : 0;
  let f = `?order_id=eq.${encodeURIComponent(orderId)}&status=in.(draft,issued)&select=grand_total`;
  const cR = await query('sales_credit_notes', f);
  let used = cR.ok ? (cR.data || []).reduce((s, c) => s + (Number(c.grand_total) || 0), 0) : 0;
  if (excludeCnId) {
    const selfR = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(excludeCnId)}&select=grand_total,status&limit=1`);
    const self = selfR.ok ? selfR.data?.[0] : null;
    if (self && ['draft','issued'].includes(self.status)) used -= Number(self.grand_total) || 0;
  }
  return +(grand - used).toFixed(2);
}
```

- [ ] **Step 6: Add the five WRITE actions** inside the POST `switch(body.action)` block, after the `deleteSalesPayment` case (after line ~2162):

```js
          case 'createCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.order_id) return err('order_id required');
            if (!d.reason) return err('reason required');
            if (!d.lines?.length) return err('At least one credit line required');
            const oR = await query('sales_orders',
              `?id=eq.${encodeURIComponent(d.order_id)}&select=*,sales_partners(id,state)&limit=1`);
            if (!oR.ok || !oR.data[0]) return err('Order not found', 404);
            const o = oR.data[0];
            if (!o.invoice_generated) return err('Order has no invoice — cannot raise a credit note', 422);
            const { lines, subtotal, tax_total, grand_total } = buildCreditNote(d.lines);
            if (!(grand_total > 0)) return err('Credit value must be greater than 0', 422);
            const remaining = await creditCapRemaining(d.order_id, null);
            if (grand_total > remaining + 0.005)
              return err(`Credit ${grand_total} exceeds remaining invoice value ${remaining}`, 422);
            const hdr = await insert('sales_credit_notes', {
              order_id: d.order_id, partner_id: o.partner_id, invoice_no: o.invoice_no,
              invoice_date: o.invoice_date, cn_date: d.cn_date || todayISO(),
              reason: d.reason, reason_note: d.reason_note || null, status: 'draft',
              place_of_supply: o.place_of_supply || o.sales_partners?.state || null,
              subtotal, tax_total, grand_total, created_by: userId,
            }, false);
            if (!hdr.ok) return err('Credit note insert failed: ' + JSON.stringify(hdr.data));
            const cn = Array.isArray(hdr.data) ? hdr.data[0] : hdr.data;
            const lineRows = lines.map((l, i) => ({
              ...l, credit_note_id: cn.id,
              order_line_id: d.lines[i]?.order_line_id || null, sort_order: l.sort_order || i,
            }));
            const li = await insert('sales_credit_note_lines', lineRows, false);
            if (!li.ok) return err('Credit line insert failed: ' + JSON.stringify(li.data));
            return ok({ id: cn.id });
          }

          case 'updateCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(d.id)}&select=status,order_id&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Credit note not found', 404);
            if (cur.data[0].status !== 'draft') return err('Only draft credit notes can be edited', 422);
            const updates = { updated_at: new Date().toISOString() };
            if (d.reason !== undefined) updates.reason = d.reason;
            if (d.reason_note !== undefined) updates.reason_note = d.reason_note || null;
            if (d.cn_date !== undefined) updates.cn_date = d.cn_date || todayISO();
            if (Array.isArray(d.lines)) {
              const { lines, subtotal, tax_total, grand_total } = buildCreditNote(d.lines);
              if (!(grand_total > 0)) return err('Credit value must be greater than 0', 422);
              const remaining = await creditCapRemaining(cur.data[0].order_id, d.id);
              if (grand_total > remaining + 0.005)
                return err(`Credit ${grand_total} exceeds remaining invoice value ${remaining}`, 422);
              updates.subtotal = subtotal; updates.tax_total = tax_total; updates.grand_total = grand_total;
              await sb(`/rest/v1/sales_credit_note_lines?credit_note_id=eq.${encodeURIComponent(d.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
              const lineRows = lines.map((l, i) => ({ ...l, credit_note_id: d.id, order_line_id: d.lines[i]?.order_line_id || null, sort_order: l.sort_order || i }));
              const li = await insert('sales_credit_note_lines', lineRows, false);
              if (!li.ok) return err('Credit line update failed: ' + JSON.stringify(li.data));
            }
            const r = await update('sales_credit_notes', updates, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ updated: d.id });
          }

          case 'issueCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(d.id)}&select=*&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Credit note not found', 404);
            const cn = cur.data[0];
            if (cn.status !== 'draft') return err('Only draft credit notes can be issued', 422);
            const remaining = await creditCapRemaining(cn.order_id, cn.id);
            if (Number(cn.grand_total) > remaining + 0.005)
              return err(`Credit ${cn.grand_total} exceeds remaining invoice value ${remaining}`, 422);
            const date = cn.cn_date || todayISO();
            const cn_no = await nextCreditNoteNo(date);
            const now = new Date().toISOString();
            const r = await update('sales_credit_notes',
              { cn_no, status: 'issued', cn_date: date, issued_by: userId, issued_at: now, updated_at: now },
              `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Issue failed: ' + JSON.stringify(r.data));
            await recomputeOrderCredit(cn.order_id);
            return ok({ cn_no });
          }

          case 'cancelCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            if (!d.reason) return err('reason required');
            const cur = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(d.id)}&select=status,order_id&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Credit note not found', 404);
            if (!['draft','issued'].includes(cur.data[0].status)) return err('Only draft/issued credit notes can be cancelled', 422);
            const now = new Date().toISOString();
            const r = await update('sales_credit_notes',
              { status: 'cancelled', cancelled_by: userId, cancelled_at: now, cancel_reason: d.reason, updated_at: now },
              `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Cancel failed: ' + JSON.stringify(r.data));
            await recomputeOrderCredit(cur.data[0].order_id);
            return ok({ cancelled: d.id });
          }

          case 'deleteCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(d.id)}&select=status&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Credit note not found', 404);
            if (cur.data[0].status !== 'draft') return err('Only draft credit notes can be deleted', 422);
            const del = await sb(`/rest/v1/sales_credit_notes?id=eq.${encodeURIComponent(d.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
            if (!del.ok) return err('Delete failed: ' + JSON.stringify(del.data));
            return ok({ deleted: d.id });
          }
```

- [ ] **Step 7: Commit + deploy**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add snorkelops-worker/src/index.js
git commit -m "snorkelops: sales credit notes — reads, writes, net AR recompute

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
cd snorkelops-worker && npx wrangler deploy
```
Expected: deploy succeeds, prints a new version id.

- [ ] **Step 8: Data-path verification** (see Task 9 for the full end-to-end; quick smoke here)

Run (`execute_sql`) to confirm the actions are reachable is done via the app; here just confirm the column + tables are writable by inserting a throwaway draft directly and rolling back:
```sql
SELECT count(*) FROM store.sales_credit_notes;        -- expect 0
SELECT count(*) FROM store.sales_credit_note_lines;   -- expect 0
```

---

## Task 3: Permissions — gate key in the matrix + seed roles

**Files:** Modify `05_Throttle/apps/snorkel/src/app/(auth)/admin/roles/page.js`; DB update via `execute_sql`.

- [ ] **Step 1: Add the key to PERM_DEFS** — in `admin/roles/page.js`, after the `sales_partner_manage` entry (line ~30):

```js
    { key: 'sales_credit_note',   label: 'Raise / issue / cancel credit notes' },
```

- [ ] **Step 2: Seed the key on `sales_manager` + `admin`** (`execute_sql`):

```sql
UPDATE store.snorkel_roles
SET permissions = permissions || '{"sales_credit_note": true}'::jsonb
WHERE role_key IN ('sales_manager','admin');
SELECT role_key, permissions->>'sales_credit_note' FROM store.snorkel_roles WHERE role_key IN ('sales_rep','sales_manager','admin');
```
Expected: `sales_manager` + `admin` → `true`; `sales_rep` → null (read-only via sales_view).

- [ ] **Step 3: Commit** (app file; deploy bundled in Task 8)

```bash
git add apps/snorkel/src/app/\(auth\)/admin/roles/page.js
git commit -m "snorkel: sales_credit_note perm key in roles matrix"
```

---

## Task 4: App lib + nav

**Files:** Modify `05_Throttle/apps/snorkel/src/lib/sales.js`, `05_Throttle/apps/snorkel/src/lib/nav.js`.

- [ ] **Step 1: Add reasons + status helpers to `sales.js`** (append near the other exports):

```js
export const CREDIT_NOTE_REASONS = [
  { key: 'under_supply',        label: 'Under-supply (billed > supplied)' },
  { key: 'sales_return',        label: 'Sales return (unsold inventory back)' },
  { key: 'price_drop',          label: 'Price drop after supply' },
  { key: 'transit_loss_damage', label: 'Transit loss / damage (our responsibility)' },
  { key: 'other',               label: 'Other adjustment' },
];
export function creditReasonLabel(k) { return (CREDIT_NOTE_REASONS.find(r => r.key === k) || {}).label || k || '—'; }
export const CN_STATUS_TONES = { draft: 'gray', issued: 'green', cancelled: 'red' };
export function cnStatusLabel(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'; }
```

- [ ] **Step 2: Add the nav entry to `nav.js`** — in the OFFLINE SALES group `items`, after the Collections entry (line ~36):

```js
      { id: 'sales-credit-notes', label: 'Credit Notes',  route: '/sales/credit-notes', icon: ReceiptText, requires: 'sales_view' },
```
Ensure `ReceiptText` is imported from `lucide-react` at the top of `nav.js` (add to the existing import list; if `ReceiptText` is unavailable in the installed lucide version, use `FileMinus`).

- [ ] **Step 3: Commit**

```bash
git add apps/snorkel/src/lib/sales.js apps/snorkel/src/lib/nav.js
git commit -m "snorkel: credit-note reasons + nav entry"
```

---

## Task 5: Credit Notes list page

**Files:** Create `05_Throttle/apps/snorkel/src/app/(auth)/sales/credit-notes/page.js`.

- [ ] **Step 1: Build the list page.** Clone the structure of the existing `sales/orders/page.js` (same imports: `useAuth`, `garageFetch`, local `PageHead`/`Kpi`/`Panel`/`Badge` from `@/components/ui`, `inr`/`fmtDate` from `@/lib/sales`). Replace its data + columns with:

```jsx
'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { PageHead, Kpi, Panel, Badge, Btn } from '@/components/ui';
import { inr, fmtDate, csvCell, creditReasonLabel, CN_STATUS_TONES, cnStatusLabel } from '@/lib/sales';

export default function CreditNotesPage() {
  const { session } = useAuth();
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getCreditNotes', status ? { status } : {}, session);
      setRows(r || []);
    } finally { setLoading(false); }
  }, [session, status]);
  useEffect(() => { load(); }, [load]);

  const issued = rows.filter(r => r.status === 'issued');
  const totVal = issued.reduce((s, r) => s + Number(r.grand_total || 0), 0);
  const totGst = issued.reduce((s, r) => s + Number(r.tax_total || 0), 0);

  function exportCsv() {
    const head = ['CN No','Status','Partner','Invoice No','CN Date','Reason','Taxable','GST','Total'];
    const body = rows.map(r => [r.cn_no || '(draft)', r.status, r.partner_name, r.invoice_no,
      fmtDate(r.cn_date), creditReasonLabel(r.reason), r.subtotal, r.tax_total, r.grand_total].map(csvCell).join(','));
    const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'credit-notes.csv'; a.click();
  }

  return (
    <div>
      <PageHead title="Credit Notes" subtitle="GST credit notes against sales invoices"
        actions={<Link href="/sales/credit-notes/new"><Btn>+ New credit note</Btn></Link>} />
      <div style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
        <Kpi label="Issued credit notes" value={issued.length} />
        <Kpi label="Total credited" value={inr(totVal)} />
        <Kpi label="GST credited" value={inr(totGst)} />
      </div>
      <Panel>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All statuses</option><option value="draft">Draft</option>
            <option value="issued">Issued</option><option value="cancelled">Cancelled</option>
          </select>
          <Btn onClick={exportCsv} variant="ghost">Export CSV</Btn>
        </div>
        {loading ? <Spinner /> : (
          <table className="dt"><thead><tr>
            <th>CN No</th><th>Status</th><th>Partner</th><th>Invoice</th><th>Date</th><th>Reason</th><th style={{textAlign:'right'}}>Total</th>
          </tr></thead><tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td><Link href={`/sales/credit-notes/detail?id=${r.id}`}>{r.cn_no || '(draft)'}</Link></td>
                <td><Badge tone={CN_STATUS_TONES[r.status]}>{cnStatusLabel(r.status)}</Badge></td>
                <td>{r.partner_name}</td><td>{r.invoice_no}</td><td>{fmtDate(r.cn_date)}</td>
                <td>{creditReasonLabel(r.reason)}</td><td style={{textAlign:'right'}}>{inr(r.grand_total)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} style={{ color: 'var(--t3)' }}>No credit notes yet.</td></tr>}
          </tbody></table>
        )}
      </Panel>
    </div>
  );
}
```
> Note: confirm the exact named exports of `@/components/ui` (`PageHead`/`Kpi`/`Panel`/`Badge`/`Btn`) by opening `apps/snorkel/src/components/ui.js`; adjust import names/props to match (the spec's component list came from systems/snorkel.md). If `Btn` takes `variant` differently, follow the existing usage in `sales/orders/page.js`.

- [ ] **Step 2: Build & commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
npx turbo build --filter=snorkel
```
Expected: build succeeds, 0 errors. Then:
```bash
git add apps/snorkel/src/app/\(auth\)/sales/credit-notes/page.js
git commit -m "snorkel: credit notes list page"
```

---

## Task 6: Credit Note create form

**Files:** Create `05_Throttle/apps/snorkel/src/app/(auth)/sales/credit-notes/new/page.js`.

- [ ] **Step 1: Build the form.** Pattern: read the existing `sales/orders/OrderForm.js` for the searchable `Combobox` usage and the lines-table layout, and reuse them. Flow:
  1. If `?order=<id>` present, skip the picker; else show a `Combobox` of **invoiced** orders (load via `garageFetch('getSalesOrders', {}, session)` and filter `o.invoice_generated`).
  2. On order select → `garageFetch('getOrderForCreditNote', { order_id }, session)`.
  3. Render one row per invoice line with: description (read-only), `remaining_qty` shown, a **credit qty** input (`max = remaining_qty`, default 0), a **rate** input (defaults to the line `rate`; for `price_drop` the user lowers it to the per-unit drop), HSN + gst_pct carried from the line. Compute taxable/gst live.
  4. Reason `<select>` from `CREDIT_NOTE_REASONS` + a note field; a "+ Add free-form line" button appends a blank line with `order_line_id=null` (product/description + qty + rate + gst_pct editable).
  5. Show live totals (taxable / GST split preview / grand) and the **remaining cap** (`remaining_value` from the read); block submit if grand > remaining.
  6. Submit → `workerFetch('createCreditNote', { order_id, reason, reason_note, cn_date, lines }, session)` where each line carries `{ order_line_id, product, model, color, sku, hsn_code, description, qty, rate, gst_pct }`; only include lines with `qty>0 && rate>0`. On success → `/sales/credit-notes/detail?id=<returned id>`.

Key submit handler (the rest is presentational, mirror OrderForm):
```jsx
const payloadLines = lines
  .filter(l => Number(l.qty) > 0 && Number(l.rate) > 0)
  .map(l => ({ order_line_id: l.order_line_id || null, product: l.product, model: l.model, color: l.color,
    sku: l.sku, hsn_code: l.hsn_code, description: l.description, qty: Math.round(Number(l.qty)),
    rate: Number(l.rate), gst_pct: Number(l.gst_pct) || 0 }));
if (!payloadLines.length) return toast('Add at least one credit line');
const res = await workerFetch('createCreditNote',
  { order_id: orderId, reason, reason_note: note, cn_date: cnDate, lines: payloadLines }, session);
if (res?.ok) router.push(`/sales/credit-notes/detail?id=${res.data.id}`);
else toast(res?.error || 'Failed');
```
Gate the whole page on `hasPermission(session, 'sales_credit_note')` (import `hasPermission` from `@throttle/auth`); show an Access-denied panel otherwise.

- [ ] **Step 2: Build & commit**

```bash
npx turbo build --filter=snorkel
git add apps/snorkel/src/app/\(auth\)/sales/credit-notes/new/page.js
git commit -m "snorkel: credit note create form"
```

---

## Task 7: Credit Note detail page

**Files:** Create `05_Throttle/apps/snorkel/src/app/(auth)/sales/credit-notes/detail/page.js`.

- [ ] **Step 1: Build it.** Load `garageFetch('getCreditNote', { id }, session)`. Render header (cn_no or "Draft", status Badge, partner, original invoice_no + date, reason, place of supply), the lines table (with CGST/SGST or IGST per `intra`), and totals. Buttons gated on `hasPermission(session,'sales_credit_note')`:
  - **draft:** `Edit` (→ `/sales/credit-notes/new?id=<id>` in edit mode, or inline), `Issue` (`workerFetch('issueCreditNote',{id})` → reload), `Delete` (`workerFetch('deleteCreditNote',{id})` → back to list).
  - **issued:** `Print` (`<Link href={`/sales/credit-notes/print?id=${id}`} target="_blank">`), `Cancel` (prompt for reason → `workerFetch('cancelCreditNote',{id,reason})`).
  - Show the linked order's net impact: `order.grand_total − order.credit_total − order.amount_received` as "Net due after credits".

- [ ] **Step 2: Build & commit**

```bash
npx turbo build --filter=snorkel
git add apps/snorkel/src/app/\(auth\)/sales/credit-notes/detail/page.js
git commit -m "snorkel: credit note detail (issue/cancel/print)"
```

---

## Task 8: Printable CREDIT NOTE document

**Files:** Create `05_Throttle/apps/snorkel/src/app/(auth)/sales/credit-notes/print/page.js`.

- [ ] **Step 1: Clone the invoice print page.** Copy `apps/snorkel/src/app/(auth)/sales/orders/invoice/page.js` verbatim, then change:
  - Data load: `garageFetch('getCreditNote', { id }, session)` → destructure `{ cn, partner, order, seller, intra, lines }` (instead of `{ order, partner, seller, intra, lines }`).
  - Guard: render only when `cn.status === 'issued'` (else "This credit note is not issued yet.").
  - Auto-print effect: fire when `cn?.status === 'issued'`.
  - Title text `TAX INVOICE` → `CREDIT NOTE`.
  - Header block fields: show `cn.cn_no` (CN No), `fmtDate(cn.cn_date)` (CN Date), **add** "Against Invoice" = `cn.invoice_no` + `fmtDate(cn.invoice_date)`, "Order No" = `order?.order_no`, "Place of Supply" = `cn.place_of_supply`, "Reason" = `creditReasonLabel(cn.reason)`.
  - Totals use `cn.subtotal`/`cn.tax_total`/`cn.grand_total`; grand label "Total Credit".
  - Add a line under the table: `This is a Credit Note issued against Tax Invoice {cn.invoice_no} dated {fmtDate(cn.invoice_date)}.`
  - Keep amount-in-words (`amountInWords(cn.grand_total)`), authorised-signatory, the same `@media print` CSS.

- [ ] **Step 2: Build & commit**

```bash
npx turbo build --filter=snorkel
git add apps/snorkel/src/app/\(auth\)/sales/credit-notes/print/page.js
git commit -m "snorkel: printable credit note document"
```

---

## Task 9: SO detail panel + collections net + full build/deploy

**Files:** Modify `05_Throttle/apps/snorkel/src/app/(auth)/sales/orders/detail/page.js`; check `sales/collections/page.js`.

- [ ] **Step 1: Add a Credit Notes panel to the SO detail page.** After the order loads, fetch `garageFetch('getCreditNotes', { order_id: id }, session)`. Render a panel listing each CN (cn_no/status/date/total, link to its detail) and a **"Raise credit note"** button → `/sales/credit-notes/new?order=${id}`, shown only when `order.invoice_generated` and `hasPermission(session,'sales_credit_note')`. Add a "Net due after credits" figure = `grand_total − credit_total − amount_received`.

- [ ] **Step 2: Collections page net** — open `sales/collections/page.js`; wherever it shows outstanding/balance, subtract `credit_total` (the field now arrives on each order from `getSalesOrders`/`getSalesCollections`). If the collections read is a separate worker action that doesn't select `credit_total`, confirm it uses `select=*` (it does — `getSalesOrders` uses `*`); no worker change needed.

- [ ] **Step 3: Build all monorepo apps** (shared nothing changed, but verify nothing broke):

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
npx turbo build --filter=snorkel
```
Expected: 0 errors. (No `packages/*` changed → other apps unaffected.)

- [ ] **Step 4: Commit + push (auto-deploys snorkel)**

```bash
git add apps/snorkel
git commit -m "snorkel: credit notes — SO detail panel + collections net due"
git push
```

---

## Task 10: End-to-end data-path verification

**Files:** none (verification only, via `execute_sql` + the live worker through the app, or authed curl).

- [ ] **Step 1: Pick a real invoiced order to test against** (`execute_sql`):
```sql
SELECT id, order_no, invoice_no, grand_total, credit_total, amount_received, payment_status
FROM store.sales_orders WHERE invoice_generated ORDER BY order_date DESC LIMIT 5;
```
Note one `id` (e.g. an SO with a known grand_total) for the manual app test.

- [ ] **Step 2: Through the app** (signed in as a `sales_manager`/`admin`): SO detail → Raise credit note → credit one line partially → save (draft) → Issue. Then verify (`execute_sql`):
```sql
SELECT cn_no, status, subtotal, tax_total, grand_total FROM store.sales_credit_notes ORDER BY created_at DESC LIMIT 1;
SELECT order_no, grand_total, credit_total, amount_received, payment_status FROM store.sales_orders WHERE id='<order id>';
```
Expected: `cn_no` like `LOT/CN/26-27/0001`; order `credit_total` = the CN grand_total; `payment_status` reflects net.

- [ ] **Step 3: Cap rejection** — try issuing/creating a CN whose value exceeds remaining invoice value; expect a 422 "exceeds remaining invoice value" in the UI toast.

- [ ] **Step 4: Cancel** the issued CN (reason) → verify order `credit_total` returns to its prior value and `payment_status` recomputes.

- [ ] **Step 5: Print** — open the issued CN's detail → Print → confirm the CREDIT NOTE renders with the original invoice reference and correct CGST/SGST (KA partner) or IGST (out-of-state partner) and that browser Save-as-PDF produces a clean one-page doc.

---

## Task 11: Documentation

**Files:** Modify `systems/snorkel.md`, `CORE.md` (workspace root). In-app manual chapter optional same-PR.

- [ ] **Step 1: Add RULE-SNORKEL-004 #9** to `systems/snorkel.md` (in the RULE-SNORKEL-004 block): credit notes — 1↔1 invoice, line-item magnitudes, cap ≤ invoice grand_total, `draft→issued→cancelled`, `LOT/CN/<FY>/NNNN` lazy per-FY seq (never merge-duplicates), reduces net AR (`grand_total − credit_total − amount_received`) + output GST, financial-only (no stock movement), GST split mirrors the invoice, perm key `sales_credit_note`. Note the Odo-returns feed is deferred.

- [ ] **Step 2: Update the schema map** in `CORE.md` (`store` bullet) + `systems/snorkel.md` Offline Sales section: add `store.sales_credit_notes` + `sales_credit_note_lines` + `sales_orders.credit_total`; bump each file's `Last updated`.

- [ ] **Step 3: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add CORE.md systems/snorkel.md
git commit -m "docs: Snorkel sales credit notes (RULE-SNORKEL-004 #9 + schema map)"
git push
```

---

## Self-review checklist (run before execution)
- Spec coverage: data model (T1), worker reads/writes/AR (T2), perms (T3), lib/nav (T4), list/new/detail/print/SO-panel (T5-T9), docs (T11), verification (T10) — all covered.
- Numbering reuses the invoice's lazy-seq pattern (`nextCreditNoteNo`); never merge-duplicates.
- AR: `recomputeOrderCredit` (on issue/cancel) AND `recomputeSalesPayment` (on payment) both net `grand_total − credit_total` — consistent.
- Caps enforced at create, update, and issue (`creditCapRemaining`).
- Sign convention: positive magnitudes stored everywhere; AR subtracts; doc presents as credit.
- Permission key `sales_credit_note` consistent across gate (`canSalesCreditNote`), PERM_DEFS, seeded roles, and page guards.
