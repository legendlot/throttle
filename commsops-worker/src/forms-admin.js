// Forms admin reads — the Relay /forms surface (2026-09-11).
//
// The `/f/*` capture widget (forms.js) has written `comms.form_submissions` since S331, and
// nothing in Relay could READ one. The back-in-stock form goes live on the storefront at the
// next theme flip while its journey stays DRAFT, so the only way to see who is signing up was
// SQL. These two reads close that: a list of forms with counts, and one form's sign-ups.
//
// ⚠️ PII. `getFormSubmissions` returns customer email + phone. It is gated in index.js exactly as
// the Contacts reads (getProfiles / getProfile) are — relay_view — because it exposes the same
// class of data those already do. There is deliberately NO export path here.
//
// COUNT STRATEGY — no migration, so no new view/RPC:
//   • Row counts (total / 7d / 30d / alerted) are PostgREST `Prefer: count=exact` on a HEAD, read
//     out of Content-Range via A.totalFromRange. Exact at any size; no rows cross the wire.
//     `null` means "count unavailable", never zero — the UI renders it as '—'.
//   • DISTINCT contacts, per-day, channel opt-ins and top products cannot come from a count
//     header, so they aggregate one BOUNDED select (newest SUMMARY_CAP rows, ordered with an id
//     tie-break). When the form holds more than that, the response says `sampled: true` so the
//     figure is never presented as the population. At 3 rows today this is exact.

const A = require('./auth.js');
const { MAX_ATTEMPTS } = require('./restock-events.js');

const sbSales = A.sbProfile('sales');

// PostgREST caps every response at db-max-rows (5,000 — measured, auth.js). Stay at it, not over.
const SUMMARY_CAP = 5000;
// IN-list chunk. 100 uuids ≈ 3.7 KB of query string — well inside any proxy's URL limit even for
// a 500-row page, and the chunks run in PARALLEL (never one await per row).
const IN_CHUNK = 100;
const BIS_SLUG = 'back-in-stock';
const DAY_MS = 86400000;
const IST_OFFSET_MS = 330 * 60000;

// ── pure helpers (unit-tested in test/forms-admin.test.js) ───────────────────────────────

function chunk(arr, n = IN_CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// A PostgREST `in.(…)` list. Values are double-quoted so a SKU or email carrying a comma or a
// paren cannot split the list, and percent-encoded so a `+` in an email is not read as a space.
function inList(values) {
  return `(${values.map((v) => `"${A.enc(String(v).replace(/["\\]/g, ''))}"`).join(',')})`;
}

// The IST calendar day (YYYY-MM-DD) of an instant. Days are IST everywhere in LOT; a UTC day
// would put every sign-up between 00:00 and 05:30 IST on the previous date.
function istDay(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// The last `n` IST calendar days, oldest first, ending on today (IST).
function lastIstDays(now, n = 30) {
  const today = Date.parse(istDay(new Date(now).toISOString()) + 'T00:00:00Z');
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(today - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

// One key per PERSON. A submission can arrive with no profile_id (the identity write is
// best-effort), so fall back to the address they typed — lower-cased email, digits-only phone —
// rather than counting every such row as a new contact.
function contactKey(s) {
  if (s?.profile_id) return `p:${s.profile_id}`;
  const p = s?.payload || {};
  const email = String(p.email || '').trim().toLowerCase();
  if (email) return `e:${email}`;
  const phone = String(p.phone || '').replace(/\D/g, '');
  if (phone) return `t:${phone}`;
  return s?.id ? `s:${s.id}` : null;
}

// The channels the customer CHOSE. Same rule as forms.js handleFormConfirm: the stored column
// when present, else (pre-0060 rows, channels = NULL) field presence.
function subChannels(s) {
  const stored = Array.isArray(s?.channels)
    ? s.channels.filter((c) => c === 'email' || c === 'whatsapp') : [];
  if (stored.length) return [...new Set(stored)];
  return [s?.payload?.email && 'email', s?.payload?.phone && 'whatsapp'].filter(Boolean);
}

// ⚠️ `variant_sku` ONLY. The two pre-SP3 test rows carry a Shopify VARIANT ID under
// `product_code` (see restock-events.js) — neither a SKU nor a LOT code — so they are counted as
// "no SKU" instead of being ranked as a product nobody can identify.
function subSku(s) {
  const v = s?.payload?.variant_sku;
  return v == null || String(v).trim() === '' ? null : String(v).trim();
}

// The restock ledger row → a status word. No row = the product has not flipped back in stock
// since this sign-up (or the journey is draft, which holds the queue closed — restock-events.js).
function alertStatus(n) {
  if (!n) return 'waiting';
  if (n.event_emitted_at) return 'alerted';
  if (Number(n.attempts) >= MAX_ATTEMPTS) return 'stuck';
  if (n.last_error) return 'retrying';
  return 'queued';
}

/**
 * Aggregate a bounded list of submissions into the summary block.
 * `rows` are newest-first; `total` is the exact population (or null when unknown).
 */
function summarise(rows, { now = Date.now(), total = null, skuToCode = {} } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const days = lastIstDays(now, 30);
  const perDay = Object.fromEntries(days.map((d) => [d, 0]));
  const contacts = new Set();
  const channels = { email: 0, whatsapp: 0 };
  const skus = new Map();
  let noSku = 0;
  for (const s of list) {
    const k = contactKey(s); if (k) contacts.add(k);
    const d = istDay(s.submitted_at); if (d && d in perDay) perDay[d] += 1;
    for (const c of subChannels(s)) channels[c] += 1;
    const sku = subSku(s);
    if (sku) skus.set(sku, (skus.get(sku) || 0) + 1); else noSku += 1;
  }
  const top = [...skus.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([sku, count]) => ({ sku, product_code: skuToCode[sku] || null, count }));
  const n = Number(total);
  return {
    distinct_contacts: contacts.size,
    per_day: days.map((day) => ({ day, count: perDay[day] })),
    channels,
    top_products: top,
    no_sku: noSku,
    rows_considered: list.length,
    // True when the aggregates above saw only the newest SUMMARY_CAP rows of a bigger form.
    sampled: (total != null && Number.isFinite(n) && n > list.length) || list.length >= SUMMARY_CAP,
  };
}

// Name / email / phone for one row. What the customer TYPED on this form wins — it is the
// address the alert goes to — with the profile's newest identifiers as the fallback.
function pickContact(sub, profile, idents) {
  const p = sub?.payload || {};
  const newest = (type) => (idents || []).find((i) => i.type === type)?.value || null;
  return {
    name: profile?.display_name || null,
    email: p.email || newest('email'),
    phone: p.phone || newest('phone'),
  };
}

// ── async reads ──────────────────────────────────────────────────────────────────────────

async function countRows(path, env, sb = A.sbComms) {
  const r = await sb(path, env, { method: 'HEAD', prefer: 'count=exact' });
  return r.ok ? A.totalFromRange(r.range) : null;
}

const since = (now, days) => new Date(now - days * DAY_MS).toISOString();

async function formCounts(env, form, now) {
  const base = `/rest/v1/form_submissions?form_id=eq.${A.enc(form.id)}`;
  const [latest, d7, d30, sample, alerted] = await Promise.all([
    // limit=1 newest row: gives last_submitted_at, and count=exact on it gives the total.
    A.sbComms(`${base}&select=submitted_at&order=submitted_at.desc,id.desc&limit=1`, env,
      { prefer: 'count=exact' }),
    countRows(`${base}&submitted_at=gte.${A.enc(since(now, 7))}&select=id`, env),
    countRows(`${base}&submitted_at=gte.${A.enc(since(now, 30))}&select=id`, env),
    A.sbComms(`${base}&select=id,profile_id,payload->>email,payload->>phone`
      + `&order=submitted_at.desc,id.desc&limit=${SUMMARY_CAP}`, env),
    // The restock ledger has no form_id: claim_restock_notifications hard-codes the
    // back-in-stock slug, so every ledger row belongs to that form and no other.
    form.slug === BIS_SLUG
      ? countRows('/rest/v1/restock_notifications?event_emitted_at=not.is.null&select=id', env)
      : Promise.resolve(null),
  ]);
  const total = latest.ok ? A.totalFromRange(latest.range) : null;
  const rows = sample.ok && Array.isArray(sample.data) ? sample.data : null;
  const contacts = rows
    ? new Set(rows.map((s) => contactKey({ id: s.id, profile_id: s.profile_id,
      payload: { email: s.email, phone: s.phone } })).filter(Boolean)).size
    : null;
  return {
    total,
    last_7_days: d7,
    last_30_days: d30,
    distinct_contacts: contacts,
    distinct_contacts_sampled: rows != null && ((total != null && total > rows.length) || rows.length >= SUMMARY_CAP),
    last_submitted_at: (latest.ok && latest.data?.[0]?.submitted_at) || null,
    alerted: form.slug === BIS_SLUG ? alerted : null,
  };
}

/** GET listForms → { forms: [{ id, slug, name, kind, active, requires_confirmation, created_at, counts }] } */
async function listForms(env, { now = Date.now() } = {}) {
  const r = await A.sbComms('/rest/v1/forms?select=id,slug,name,kind,active,requires_confirmation,'
    + 'created_at,updated_at&order=created_at.asc,id.asc', env);
  if (!r.ok) return { error: 'db_error', status: 500 };
  const forms = Array.isArray(r.data) ? r.data : [];
  const counts = await Promise.all(forms.map((f) => formCounts(env, f, now)));
  return { forms: forms.map((f, i) => ({ ...f, counts: counts[i] })) };
}

// Run one IN-filtered read per chunk, in parallel, and concatenate. A failed chunk degrades to
// no enrichment for those rows (the sign-up still lists) rather than failing the page.
async function inChunks(values, mkPath, env, sb = A.sbComms) {
  const uniq = [...new Set(values.filter((v) => v != null && v !== ''))];
  if (!uniq.length) return [];
  const res = await Promise.all(chunk(uniq).map((c) => sb(mkPath(inList(c)), env)));
  return res.flatMap((x) => (x.ok && Array.isArray(x.data) ? x.data : []));
}

/**
 * GET getFormSubmissions?form_id&limit&offset
 * → { form, rows, total, limit, offset, summary | null }
 * `summary` is computed on offset=0 only (the page keeps the first one while paging).
 */
async function getFormSubmissions(env, { formId, limit = 100, offset = 0, now = Date.now() } = {}) {
  if (!formId) return { error: 'form_id_required', status: 400 };
  // A non-uuid would reach PostgREST as a 22P02 and surface as a misleading db_error 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(formId)) {
    return { error: 'form_id_invalid', status: 400 };
  }
  const fr = await A.sbComms(`/rest/v1/forms?id=eq.${A.enc(formId)}`
    + '&select=id,slug,name,kind,active,requires_confirmation,created_at&limit=1', env);
  if (!fr.ok) return { error: 'db_error', status: 500 };
  const form = fr.data?.[0];
  if (!form) return { error: 'not_found', status: 404 };
  const isBis = form.slug === BIS_SLUG;
  const base = `/rest/v1/form_submissions?form_id=eq.${A.enc(form.id)}`;
  // ⚠️ id tie-break: submitted_at is not unique, and a non-unique sort drops/repeats rows
  // between pages (CORE.md paging rule).
  const order = 'order=submitted_at.desc,id.desc';

  const [page, sample, d7, d30, alerted] = await Promise.all([
    A.sbComms(`${base}&select=id,profile_id,payload,channels,submitted_at,confirmed_at,source_url`
      + `&${order}&limit=${limit}&offset=${offset}`, env, { prefer: 'count=exact' }),
    offset === 0
      ? A.sbComms(`${base}&select=id,profile_id,payload,channels,submitted_at&${order}&limit=${SUMMARY_CAP}`, env)
      : Promise.resolve(null),
    offset === 0 ? countRows(`${base}&submitted_at=gte.${A.enc(since(now, 7))}&select=id`, env) : null,
    offset === 0 ? countRows(`${base}&submitted_at=gte.${A.enc(since(now, 30))}&select=id`, env) : null,
    offset === 0 && isBis
      ? countRows('/rest/v1/restock_notifications?event_emitted_at=not.is.null&select=id', env)
      : null,
  ]);
  if (!page.ok) return { error: 'db_error', status: 500 };
  const subs = Array.isArray(page.data) ? page.data : [];
  const total = A.totalFromRange(page.range);
  const sampleRows = sample && sample.ok && Array.isArray(sample.data) ? sample.data : null;

  // Every SKU the response will label: this page's rows plus the summary's candidates.
  const skus = [...subs, ...(sampleRows || [])].map(subSku).filter(Boolean);
  const profileIds = subs.map((s) => s.profile_id);
  const [profiles, idents, alerts, skuRows] = await Promise.all([
    inChunks(profileIds, (l) => `/rest/v1/profiles?id=in.${l}&select=id,display_name`, env),
    inChunks(profileIds, (l) => `/rest/v1/identifiers?profile_id=in.${l}&type=in.(email,phone)`
      + '&select=profile_id,type,value,last_seen&order=last_seen.desc.nullslast', env),
    isBis
      ? inChunks(subs.map((s) => s.id), (l) => `/rest/v1/restock_notifications?submission_id=in.${l}`
        + '&select=submission_id,event_emitted_at,attempts,last_error,flipped_at,product_title,product_code', env)
      : [],
    isBis
      ? inChunks(skus, (l) => `/rest/v1/sku_map?channel_sku=in.${l}&select=channel_sku,product_code`, env, sbSales)
      : [],
  ]);

  const profById = Object.fromEntries(profiles.map((p) => [p.id, p]));
  const identsBy = {};
  for (const i of idents) (identsBy[i.profile_id] = identsBy[i.profile_id] || []).push(i);
  const alertBy = Object.fromEntries(alerts.map((n) => [n.submission_id, n]));
  const skuToCode = {};
  for (const m of skuRows) if (m.product_code && !skuToCode[m.channel_sku]) skuToCode[m.channel_sku] = m.product_code;

  const rows = subs.map((s) => {
    const n = alertBy[s.id] || null;
    const sku = subSku(s);
    return {
      id: s.id,
      submitted_at: s.submitted_at,
      confirmed_at: s.confirmed_at,
      profile_id: s.profile_id,
      ...pickContact(s, profById[s.profile_id], identsBy[s.profile_id]),
      variant_sku: sku,
      product_code: (n && n.product_code) || (sku && skuToCode[sku]) || null,
      product_title: (n && n.product_title) || null,
      payload: s.payload || {},
      channels: subChannels(s),
      source_url: s.source_url,
      alert: isBis ? {
        status: alertStatus(n),
        emitted_at: n?.event_emitted_at || null,
        flipped_at: n?.flipped_at || null,
        attempts: n ? Number(n.attempts) || 0 : 0,
        last_error: n?.last_error || null,
      } : null,
    };
  });

  let summary = null;
  if (offset === 0) {
    summary = {
      total,
      last_7_days: d7,
      last_30_days: d30,
      alerted: isBis ? alerted : null,
      ...(sampleRows ? summarise(sampleRows, { now, total, skuToCode })
        : { distinct_contacts: null, per_day: [], channels: null, top_products: [], sampled: false }),
    };
  }
  return { form, rows, total, limit, offset, summary };
}

module.exports = {
  listForms, getFormSubmissions,
  // pure — exported for tests
  chunk, inList, istDay, lastIstDays, contactKey, subChannels, subSku, alertStatus, summarise,
  pickContact, SUMMARY_CAP, IN_CHUNK,
};
