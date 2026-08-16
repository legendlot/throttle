const A = require('./auth.js');
const G = require('./gate.js');
// Workflow class must be a named export of the entry module (wrangler class_name).
export { JourneyWorkflow } from './journey-workflow.js';
const { ingest } = require('./ingest.js');
const { recordConsent } = require('./consent.js');
const { send } = require('./send.js');
const { handleResendWebhook, handleUnsubscribe, handleTrustsignalSms, handleTrustsignalRcs } = require('./webhooks.js');
const TSC = require('./trustsignal-client.js');
const SMSTPL = require('./sms-templates.js');
const { handleWhatsappWebhook, verifyWhatsappWebhook } = require('./wa-webhooks.js');
const WATPL = require('./wa-templates.js');
const SEG = require('./segment-entry.js');
const CAMP = require('./campaigns.js');
const J = require('./journeys.js');
const SHOP = require('./shopify.js');
const SHOPWH = require('./shopify-webhooks.js');
const SUB = require('./subscribe.js');
const SHOPFLO = require('./shopflo-webhooks.js');
const CF = require('./cashfree.js');
const CFWH = require('./cashfree-webhooks.js');
const AL = require('./alerts.js');
const EA = require('./email-assets.js');
const OPTOUT = require('./optout.js');
const SHIPEV = require('./shipment-events.js');
const RTOEV = require('./rto-stages.js');   // RTO stages 2+3, scan-code-driven (not lifecycle)
const LINKS = require('./links.js');        // Phase-B /r/<code> first-party redirect
const WAQ = require('./wa-quality.js');     // Meta per-number quality PULL (webhook only pushes on change)
const AB = require('./ab-stats.js');        // A/B verdict computation (S272)
const QR = require('./queue-route.js');     // queue routing contract — unknown kinds THROW (§9.11)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ok  = (data) => json({ ok: true, data });
// `extra` merges alongside the error string for the cases where a refusal is only actionable with
// its numbers (e.g. audience_exceeds_budget carries sendable/remaining). Optional and additive —
// every existing two-arg caller serialises byte-identically.
const err = (msg, status = 400, extra) => json({ ok: false, error: msg, ...(extra || {}) }, status);
const nowIso = () => new Date().toISOString();

// ── Segment-definition guards (S268) ────────────────────────────────────────────
// These exist because a CLIENT-SIDE fix cannot protect a static-export app: the
// segment builder's fix shipped at 12:35 IST and a browser still running the
// pre-fix bundle re-saved the broken shape at 13:01 IST, silently turning a
// 4,193-person audience back into 0. Anything that guards data integrity has to
// live behind the API, where a cached tab cannot reach it.
//
// Two different treatments, on purpose:
//   • AMBIGUOUS  → reject 422. A consent leaf with no `purpose` is not defaultable;
//     guessing "marketing" could mail people who only consented to transactional.
//     eval_segment_node matches NOBODY for it, which reads as a real empty audience.
//   • UNAMBIGUOUS → normalise. A bare `within: "120"` can only mean 120 days to an
//     author, but Postgres reads a bare interval number as SECONDS (= 2 minutes).
function walkSegmentLeaves(node, fn) {
  if (!node || typeof node !== 'object') return;
  for (const g of ['all', 'any', 'none']) {
    if (Array.isArray(node[g])) { node[g].forEach((c) => walkSegmentLeaves(c, fn)); return; }
  }
  fn(node);
}
function validateSegmentDef(def) {
  let problem = null;
  walkSegmentLeaves(def, (leaf) => {
    if (problem) return;
    if (leaf && 'consent' in leaf) {
      for (const k of ['channel', 'purpose', 'state']) {
        if (!leaf[k]) { problem = `consent condition is missing "${k}" — reload the page and re-pick it (a consent rule without all three matches nobody)`; return; }
      }
    }
    if (leaf && leaf.event != null && leaf.where) {
      if (!leaf.where.prop || leaf.where.value == null || leaf.where.value === '') {
        problem = 'event property filter needs both a property and a value';
      }
    }
    // An ATTR leaf is the SAME hole one branch down, and it was left open when the event
    // `where` was closed. The UI walks straight into it: `addLeaf()` appends a BLANK attr
    // row, so an author who clicks "add condition" and then fills a different row leaves
    // {attr:'', op:'eq', value:''} behind. eval_segment_node dispatches on key PRESENCE,
    // so that row still takes the attr branch, comms._attr(p,'') is NULL for every profile,
    // and the INTERSECT wipes the whole set.
    //
    // Measured 2026-08-09 on "High Speed Browsers_Mishica" (#bugs 1786261584.104239, the
    // follow-up to the product-filter fix): product_viewed alone 13,235 profiles, the blank
    // row 0, the two ANDed 0 — a real audience reported as empty, PATTERN-277 exactly.
    //
    // Rejects rather than dropping the row. Silently discarding an empty condition is the
    // OTHER harmful direction: the author gets a bigger audience than the rule they think
    // they saved, which on a marketing send means messaging people they excluded.
    if (leaf && 'attr' in leaf) {
      const v = leaf.value;
      const emptyValue = v == null || v === ''
        || (Array.isArray(v) && (v.length === 0 || v.every((x) => String(x).trim() === '')));
      if (!String(leaf.attr || '').trim()) {
        problem = 'a condition row is empty — pick an attribute or remove the row (an empty condition matches nobody)';
      } else if (emptyValue) {
        problem = `the "${leaf.attr}" condition has no value — fill it in or remove the row (it matches nobody as it stands)`;
      }
    }
  });
  return problem;
}
function normalizeSegmentDef(def) {
  if (!def || typeof def !== 'object') return def;
  const copy = JSON.parse(JSON.stringify(def));
  walkSegmentLeaves(copy, (leaf) => {
    if (leaf && leaf.event != null && typeof leaf.within === 'string' && /^\d+$/.test(leaf.within.trim())) {
      leaf.within = `${leaf.within.trim()} days`;
    }
  });
  return copy;
}

// Order-independent JSON for change detection. A plain JSON.stringify compares KEY ORDER, and
// the template editor rebuilds `content`/`variables` from form state on every render — so the
// same data serialises differently between loads and every save would look like a change,
// which is the bug this exists to kill. Arrays keep their order (slot order is load-bearing).
function stableJson(v) {
  const norm = (x) => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      return Object.keys(x).sort().reduce((o, k) => { o[k] = norm(x[k]); return o; }, {});
    }
    return x;
  };
  return JSON.stringify(norm(v ?? null));
}
const enc2 = (p) => String(p).split('/').map(encodeURIComponent).join('/');

// Snapshot a template row into comms.template_versions (S241). Templates were UPDATEd in
// place with only a `version` counter to show for it, while comms.messages stamped
// `template_version` on every send — so that number pointed at content nobody had kept, and
// "what did this customer actually receive?" was unanswerable. This is the journey_versions
// pattern applied to templates: one immutable row per version.
//
// Identity fields ride along, not just `content`: a template can be renamed or re-pointed to
// a different WABA between versions, and silent `content.waba_id` drift is precisely the
// regression this is meant to make visible (S241 — a stale editor tab re-pinned a template
// to the BiteSpeed WABA and every send failed with a misleading Meta permissions error).
//
// NON-FATAL by design: a failed archive write must not fail the author's save. It returns a
// boolean that rides back on the response so a silent archiving failure is visible rather
// than assumed-fine — the exact trap that made the missing history hard to notice at all.
async function archiveTemplateVersion(env, row, userId) {
  if (!row?.id) return false;
  try {
    const r = await A.sbComms('/rest/v1/template_versions', env, {
      method: 'POST',
      // ignore-duplicates makes a re-archive of the same (template_id, version) a no-op
      // rather than a 409 — the UNIQUE is the idempotency guard, not an error path.
      prefer: 'resolution=ignore-duplicates,return=minimal',
      body: JSON.stringify({
        template_id: row.id,
        version: row.version ?? 1,
        channel: row.channel,
        name: row.name,
        purpose: row.purpose,
        language: row.language,
        status: row.status,
        approval_status: row.approval_status,
        provider_template_id: row.provider_template_id,
        content: row.content || {},
        variables: row.variables || [],
        created_by: userId || null,
      }),
    });
    return !!r.ok;
  } catch { return false; }
}

// Per-arm stats + verdict for one campaign. Shared by getVariantStats (recomputed on every
// view) and recordExperimentLearning (frozen into verdict_snapshot at the moment of decision —
// see the comment there for why the snapshot has to exist at all). Returns null on RPC failure.
async function computeVariantStats(env, campaignId) {
  const rpc = await A.sbComms('/rest/v1/rpc/campaign_variant_stats', env,
    { method: 'POST', body: JSON.stringify({ p_campaign_id: campaignId }) });
  if (!rpc.ok) return null;
  const rows = Array.isArray(rpc.data) ? rpc.data : [];
  // ⚠️ PostgREST returns numerics as STRINGS. ab-stats coerces internally, but hoursSinceSent
  // is computed here, outside that coercion, so it must be explicit.
  const last = rows.map((r) => r.last_sent_at).filter(Boolean).sort().pop() || null;
  const hoursSinceSent = last ? (Date.now() - new Date(last).getTime()) / 3600000 : 0;
  const v = AB.verdict(rows, { hoursSinceSent });
  return { arms: rows, verdict: v };
}

// ── GET actions ──────────────────────────────────────────────────────────────
async function handleGet(url, auth, env) {
  const action = url.searchParams.get('action');
  switch (action) {
    case 'getMe':
      return ok({ userId: auth.userId, email: auth.email, fullName: auth.fullName,
                  relayRole: auth.relayRole, permissions: auth.permissions });

    case 'getRoles': {                 // role builder — list (M2)
      // Listing is read-only and feeds the /admin/users grant flow, which only needs
      // relay_admin (saveRole — actually EDITING a role's permission set — stays
      // super_admin-gated below; verified untouched). Review M11.
      if (!A.canAdmin(auth.permissions)) return err('forbidden', 403);
      const r = await A.sbStore('/rest/v1/relayops_roles?select=*&order=role_key.asc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getUserRoles': {             // assigned relay roles, enriched with name+email+role label (M2)
      if (!A.canAdmin(auth.permissions)) return err('forbidden', 403);
      const r = await A.sbStore('/rest/v1/relayops_user_roles?select=*&order=assigned_at.desc', env);
      if (!r.ok) return err('db_error', 500);
      const rows = Array.isArray(r.data) ? r.data : [];
      const ids = [...new Set(rows.map(a => a.user_id).filter(Boolean))];
      // Resolve full_name + email from auth.users (not PostgREST-reachable → RPC)
      // and role labels from relayops_roles, so the UI shows people not UUIDs.
      const [dirR, rolesR] = await Promise.all([
        ids.length
          ? A.sbStore('/rest/v1/rpc/lot_users_by_ids', env, { method: 'POST', body: JSON.stringify({ p_ids: ids }) })
          : Promise.resolve({ ok: true, data: [] }),
        A.sbStore('/rest/v1/relayops_roles?select=role_key,label', env),
      ]);
      const dir = {}; (dirR.ok ? dirR.data : []).forEach(u => { dir[u.id] = u; });
      const roleLabel = {}; (rolesR.ok ? rolesR.data : []).forEach(r2 => { roleLabel[r2.role_key] = r2.label; });
      const enriched = rows.map(a => ({
        ...a,
        full_name: dir[a.user_id]?.full_name || null,
        email: dir[a.user_id]?.email || null,
        role_label: roleLabel[a.role_key] || a.role_key,
      }));
      return ok(enriched);
    }
    case 'searchUsers': {              // searchable LOT-people directory for the grant picker
      if (!A.canAdmin(auth.permissions)) return err('forbidden', 403);
      const q = url.searchParams.get('q') || '';
      const r = await A.sbStore('/rest/v1/rpc/search_lot_users', env,
        { method: 'POST', body: JSON.stringify({ p_q: q }) });
      return r.ok ? ok({ rows: r.data || [] }) : err('search_failed', 502);
    }
    case 'getRelaySettings': {
      const r = await A.sbComms('/rest/v1/settings?id=eq.1&select=*&limit=1', env);
      return r.ok ? ok(r.data?.[0] || null) : err('db_error', 500);
    }
    case 'getChannelQuietHours': {     // S268 — per-channel marketing quiet windows
      const r = await A.sbComms('/rest/v1/channel_quiet_hours?select=*&order=channel.asc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getSenderIdentities': {
      const r = await A.sbComms('/rest/v1/sender_identities?select=*&order=channel.asc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getEventFeed': {
      // Activity page (S232) — the Shopflo abandoned-checkout list over our own events,
      // plus messaged/recovered. Event name is allow-listed: this is a PII feed (same
      // relay_view exposure class as Contacts), not an arbitrary event browser.
      const MONITORABLE = new Set(['checkout_abandoned', 'checkout_started', 'add_to_cart',
        'product_viewed', 'order_placed', 'order_cancelled']);
      const ev = url.searchParams.get('event') || 'checkout_abandoned';
      if (!MONITORABLE.has(ev)) return err('event_not_monitorable', 400);
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
        return err('from_to_required', 400);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const [rows, stats] = await Promise.all([
        A.sbComms('/rest/v1/rpc/event_feed', env, { method: 'POST',
          body: JSON.stringify({ p_event: ev, p_from: from, p_to: to, p_limit: limit, p_offset: offset }) }),
        offset === 0 ? A.sbComms('/rest/v1/rpc/event_feed_stats', env, { method: 'POST',
          body: JSON.stringify({ p_event: ev, p_from: from, p_to: to }) }) : Promise.resolve({ ok: true, data: null }),
      ]);
      if (!rows.ok) return err('db_error', 500);
      return ok({ rows: rows.data || [], stats: stats.ok ? stats.data : null });
    }

    case 'getProfiles': {              // contacts list (M3; +consent S231; +channels/search S251)
      // Set-based RPC. Returns each profile's contactable identifiers (email/phone) and
      // its effective marketing consent per channel ({channel: state}), which together
      // drive the per-channel opt-in icons.
      //
      // `include_anonymous` defaults FALSE. 25,154 of 154,937 profiles are pixel-created
      // browser sessions with no email and no phone, and because they are the NEWEST rows
      // they sorted straight to the top: 102 of the 200 rows this page rendered were
      // unreachable noise (measured 2026-07-31). They are hidden, never deleted — 1,399
      // of them have already been promoted into real contacts by identity resolution, so
      // deleting them would break the very pipeline that makes them worth keeping.
      const limit = Number(url.searchParams.get('limit')) || 100;
      const includeAnon = url.searchParams.get('include_anonymous') === 'true';
      const q = url.searchParams.get('q') || null;
      const r = await A.sbComms('/rest/v1/rpc/profiles_list', env,
        { method: 'POST', body: JSON.stringify({
          p_limit: limit, p_include_anonymous: includeAnon, p_q: q }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getProfileCounts': {         // contacts header tiles (S251, widened S252)
      // Its OWN call, deliberately. These are whole-table aggregates over 155k profiles and
      // 270k consent rows (~1.0s), while the list itself renders in ~18ms. Bundling them
      // would make every page load wait a second for numbers that are a header, not the
      // content. The UI fetches this after the table paints and never blocks on it.
      //
      // Now backed by comms.contact_stats() rather than the old profiles_counts(): it
      // returns strictly more AND is faster (~1.0s vs ~2.5s), because `anonymous` falls out
      // as total − contactable instead of needing its own whole-table anti-join.
      const r = await A.sbComms('/rest/v1/rpc/contact_stats', env,
        { method: 'POST', body: '{}' });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getProfile': {               // contact detail: identifiers + consent + recent events (M3)
      const id = url.searchParams.get('id');
      if (!id) return err('id_required', 400);
      const [p, ids, cons, evs] = await Promise.all([
        A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(id)}&select=*&limit=1`, env),
        A.sbComms(`/rest/v1/identifiers?profile_id=eq.${A.enc(id)}&select=*&order=first_seen.asc`, env),
        A.sbComms(`/rest/v1/consent?profile_id=eq.${A.enc(id)}&select=*&order=captured_at.desc`, env),
        A.sbComms(`/rest/v1/events?profile_id=eq.${A.enc(id)}&select=*&order=occurred_at.desc&limit=50`, env),
      ]);
      return ok({ profile: p.data?.[0] || null, identifiers: ids.data || [],
                  consent: cons.data || [], events: evs.data || [] });
    }

    case 'getTemplates': {             // M5 (+usage S252)
      const r = await A.sbComms('/rest/v1/templates?select=*&order=updated_at.desc', env);
      if (!r.ok) return err('db_error', 500);
      // Usage rides along only when asked for: it scans every journey version's definition
      // as text. The library list wants it (to gate Archive/Delete); the journey picker,
      // which calls this on every open, does not.
      if (url.searchParams.get('with_usage') !== 'true') return ok(r.data);
      const ur = await A.sbComms('/rest/v1/rpc/template_usage', env, { method: 'POST', body: '{}' });
      const u = (ur.ok && ur.data) || {};
      return ok((r.data || []).map((t) => ({ ...t, usage: u[String(t.id)] || null })));
    }

    case 'getCourierEmitImpact': {     // S254 — "how many messages does moving this release?"
      // Answers the question that makes the courier watermark safe to edit. Moving it
      // FORWARD is harmless (fewer rows qualify); moving it BACKWARD makes previously-skipped
      // shipments newly eligible — measured 2026-07-31, dropping it 7 days would release
      // 185 real customer messages (114 rto / 52 in_transit / 19 delivered). Nobody should
      // make that change without seeing the number first.
      const from = url.searchParams.get('from');
      if (!from || Number.isNaN(Date.parse(from))) return err('from_required', 400);
      const r = await A.sbComms('/rest/v1/rpc/courier_emit_impact', env, {
        method: 'POST', body: JSON.stringify({ p_from: new Date(Date.parse(from)).toISOString() }),
      });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    // ── Links (S261) — the campaign/QR half of comms.links ──────────────────────────────
    // Scoped to kind='campaign' on purpose. Recipient links are one-per-message machine exhaust
    // (they will run to millions) and each one maps to a single customer's cart — listing them in
    // a UI would be both useless and a privacy surface. They are visible on the MESSAGE, not here.
    case 'getLinks': {
      const q = (url.searchParams.get('q') || '').trim();
      let path = '/rest/v1/links?kind=eq.campaign&select=*&order=created_at.desc&limit=500';
      if (q) path += `&or=(code.ilike.*${A.enc(q)}*,title.ilike.*${A.enc(q)}*,target_url.ilike.*${A.enc(q)}*)`;
      const r = await A.sbComms(path, env);
      return r.ok ? ok(r.data || []) : err('db_error', 500);
    }

    case 'getLink': {
      const code = (url.searchParams.get('code') || '').trim();
      if (!code) return err('code_required', 400);
      const [link, daily, changes, stats] = await Promise.all([
        A.sbComms(`/rest/v1/links?code=eq.${A.enc(code)}&kind=eq.campaign&select=*&limit=1`, env),
        // 90 days of the rollup — enough to see a print run land, bounded enough to send whole.
        A.sbComms(`/rest/v1/link_click_daily?code=eq.${A.enc(code)}&select=day,clicks&order=day.desc&limit=90`, env),
        A.sbComms(`/rest/v1/link_changes?code=eq.${A.enc(code)}&select=*&order=changed_at.desc&limit=50`, env),
        // Breakdowns (0042). Aggregated in Postgres — a printed QR can hold thousands of click rows
        // and this is a modal someone opens casually. Fail-soft: the detail table is the NEWEST part
        // of this page, so an error reading it must degrade the panel, never 500 the whole thing.
        A.sbComms('/rest/v1/rpc/link_click_stats', env, {
          method: 'POST', body: JSON.stringify({ p_code: code, p_days: 90 }),
        }).catch(() => ({ ok: false })),
      ]);
      const row = (link.ok && link.data?.[0]) || null;
      if (!row) return err('not_found', 404);
      return ok({
        link: row,
        daily: (daily.ok && daily.data) || [],
        changes: (changes.ok && changes.data) || [],
        stats: (stats.ok && stats.data) || null,
      });
    }

    case 'getSuppressions': {          // S253 — the hardest gate finally has a read path
      // `comms.suppressions` is step ① of the send gate and blocks EVERY purpose, including
      // transactional — a suppressed customer stops receiving order and shipping messages,
      // not just marketing. Until now it was written by webhooks (Shopify customer-redact,
      // Resend hard-bounce/complaint) and readable by nothing, so "why did this customer
      // never get their order confirmation?" had no answer short of SQL.
      //
      // Two query shapes, because there are two real questions:
      //   ?values=a,b   — "is THIS contact blocked?" (contact detail)
      //   ?q=foo        — "who is blocked?"          (admin list)
      // Matching is on VALUE, never profile_id: the Shopify redact path writes rows with no
      // profile_id at all, so a profile_id-keyed lookup would silently miss exactly the
      // suppressions that matter most.
      const values = (url.searchParams.get('values') || '').split(',').map((v) => v.trim()).filter(Boolean);
      const q = (url.searchParams.get('q') || '').trim();
      let path = '/rest/v1/suppressions?select=*&order=created_at.desc&limit=500';
      if (values.length) {
        path += `&value=in.(${values.map((v) => `"${v.replace(/"/g, '')}"`).join(',')})`;
      } else if (q) {
        path += `&value=ilike.*${A.enc(q)}*`;
      }
      const r = await A.sbComms(path, env);
      if (!r.ok) return err('db_error', 500);
      // Recent lifts ride along so the contact detail can show "this WAS blocked and was
      // lifted", which is otherwise invisible once the suppression row is gone.
      const lr = await A.sbComms(
        '/rest/v1/suppression_lifts?select=*&order=lifted_at.desc&limit=100', env);
      return ok({ suppressions: r.data || [], lifts: (lr.ok && lr.data) || [] });
    }

    case 'getMediaLibrary': {          // S251 — the shared image library
      // Reads the relay-email-assets bucket directly rather than keeping a side table of
      // uploads. Two reasons: the 28 images already uploaded since 2026-07-16 appear
      // immediately (a new table would have started EMPTY and quietly implied there were
      // no images to pick), and a bucket cannot drift out of sync with itself.
      //
      // Same bucket the email editor and the WhatsApp header have always uploaded into —
      // this is a way to SEE what was already there, not a new store.
      const bucket = 'relay-email-assets';
      const lr = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prefix: 'email/',
          limit: Math.min(Number(url.searchParams.get('limit')) || 200, 500),
          offset: 0,
          sortBy: { column: 'created_at', order: 'desc' },
        }),
      });
      const lt = await lr.text();
      let ld; try { ld = lt ? JSON.parse(lt) : null; } catch { ld = null; }
      if (!lr.ok || !Array.isArray(ld)) return err(`list_failed:${lt}`.slice(0, 300), 502);
      // Which templates point at each image. Requested only when asked for (the picker
      // modal does not need it) — it scans every template's content as text.
      let usage = {};
      if (url.searchParams.get('with_usage') === 'true') {
        const ur = await A.sbComms('/rest/v1/rpc/media_usage', env, { method: 'POST', body: '{}' });
        if (ur.ok && ur.data && typeof ur.data === 'object') usage = ur.data;
      }
      const assets = ld
        // The list API emits a zero-byte placeholder row for the folder itself. It carries
        // no metadata and is not an image; rendering it would put a broken tile in the picker.
        .filter((o) => o && o.name && o.metadata)
        .map((o) => ({
          name: o.name,
          path: `email/${o.name}`,
          url: `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/email/${encodeURIComponent(o.name)}`,
          size: o.metadata?.size ?? null,
          mime: o.metadata?.mimetype || null,
          created_at: o.created_at || o.updated_at || null,
          used_by: usage[`email/${o.name}`] || [],
        }));
      return ok({ assets });
    }

    case 'checkTemplateShape': {        // S241 — pre-send local-vs-Meta divergence check
      // Three send-time incidents on 2026-07-28 were all local drift from Meta's approved
      // copy, each surfacing only as an opaque Meta code on live traffic. This answers
      // "will this actually send?" BEFORE anyone presses Send. Read-only (Graph GET).
      const id = url.searchParams.get('template_id');
      if (!id) return err('template_id_required', 400);
      const tr = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}&select=*&limit=1`, env);
      const tpl = (tr.ok && tr.data?.[0]) || null;
      if (!tpl) return err('template_not_found', 404);
      if (tpl.channel !== 'whatsapp') return ok({ checked: false, reason: 'not_whatsapp' });
      const r = await WATPL.waCheckTemplateShape(env, tpl);
      return r.ok ? ok(r) : err(r.error || 'shape_check_failed', 502);
    }

    case 'getTemplateVersions': {       // S241 — the per-version archive behind a template
      // `comms.messages.template_version` is stamped on every send; this is what resolves
      // it. Content is returned so "what exactly did this customer receive?" is answerable
      // and a bad edit can be read back verbatim. Newest first.
      const id = url.searchParams.get('template_id');
      if (!id) return err('template_id_required', 400);
      const r = await A.sbComms(
        `/rest/v1/template_versions?template_id=eq.${A.enc(id)}`
        + '&select=*&order=version.desc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    case 'getEventDefinitions': {      // THE registry behind every event picker (S233)
      // One set-based call: active definitions + their `category` (picker grouping) + live
      // usage, so an author can see an event has never fired before building a segment on
      // it — the exact trap the retired `email_clicked` was. Registering a new event is an
      // INSERT here with a category; it then shows up, grouped, in all three pickers with
      // no code change. Ordered by (category, name) server-side so groups stay contiguous.
      const r = await A.sbComms('/rest/v1/rpc/event_registry', env,
        { method: 'POST', body: JSON.stringify({ p_days: 30 }) });
      return r.ok ? ok(r.data || []) : err('db_error', 500);
    }

    case 'getEventPropertyOptions': { // S268 — narrow an event condition to ONE product
      // Which properties a given event actually carries, plus their live values, derived
      // from the events themselves. Deliberately NOT a hardcoded key list: that is exactly
      // how EVENT_SUGGEST rotted (S233). It also has to be a picker rather than a text box —
      // a mistyped property name resolves to NULL and matches NOBODY, silently, which is the
      // PATTERN-277 failure all over again. `coverage_pct` is the number that matters: on
      // product_viewed, `sku` is on ~60% of events and `product_handle` on 100%, so choosing
      // sku quietly drops 40% of the views.
      const ev = url.searchParams.get('event');
      if (!ev) return err('event_required', 400);
      const days = Number(url.searchParams.get('days')) || 90;
      const r = await A.sbComms('/rest/v1/rpc/event_property_options', env,
        { method: 'POST', body: JSON.stringify({ p_event: ev, p_days: days }) });
      return r.ok ? ok(r.data || []) : err('db_error', 500);
    }

    case 'getSegments': {              // M6 (+member_count S231)
      // Set-based RPC — segments PLUS the current comms.segment_members count
      // per segment (§9 read extension for the COMMAND list). For dynamic
      // segments the count is as-of-last-materialize (PATTERN-176) — the UI
      // labels it so. Additive: every previous field is unchanged.
      const r = await A.sbComms('/rest/v1/rpc/segments_list', env,
        { method: 'POST', body: JSON.stringify({}) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getSegment': {
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      // ⚠️ member_count comes from segments_list (count(*) SQL-side), NOT from reading the rows
      // and taking .length. That is what this did until 2026-08-14, and PostgREST caps EVERY
      // response at db-max-rows = 5,000 with no error and no header (CORE.md S275) — so any
      // segment over 5,000 reported exactly 5,000 and looked plausible. "T-90 purchasers" hit
      // 6,091 members the same day, which would have shown as 5,000 on the detail page while the
      // LIST showed the true figure, since the list already used this RPC. Two screens, two
      // numbers, neither flagged. segments_list returns ONE aggregated jsonb row, so no cap.
      // ⚠️ Explicit column list, NOT select=* — `materialized_def` (S282) is a full copy of the
      // rule and no caller needs it, only the `is_stale` verdict computed from it.
      const [s, list] = await Promise.all([
        A.sbComms(`/rest/v1/segments?id=eq.${A.enc(id)}&select=id,name,kind,definition,created_by,created_at,updated_at,entry_tracking_since,materialized_at&limit=1`, env),
        A.sbComms('/rest/v1/rpc/segments_list', env, { method: 'POST', body: JSON.stringify({}) }),
      ]);
      const row = Array.isArray(list.data) ? list.data.find((x) => String(x.id) === String(id)) : null;
      return ok({ segment: s.data?.[0] || null, member_count: Number(row?.member_count ?? 0), is_stale: !!row?.is_stale });
    }
    case 'getSegmentMembers': {        // S263 — who is actually in this segment
      // Same segment_manage gate as previewSegment: this returns addresses, so relay_view
      // alone must not turn it into a PII reader.
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const r = await A.sbComms('/rest/v1/rpc/segment_member_page', env, {
        method: 'POST',
        body: JSON.stringify({ p_segment_id: id,
          p_limit: Math.min(Number(url.searchParams.get('limit')) || 50, 200),
          p_offset: Math.max(Number(url.searchParams.get('offset')) || 0, 0) }),
      });
      return r.ok ? ok(r.data || { total: 0, rows: [] }) : err('db_error', 500);
    }
    case 'getCampaigns': {
      const r = await A.sbComms('/rest/v1/campaigns?select=*&order=updated_at.desc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getCampaign': {
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const c = await CAMP.getCampaign(env, id);
      return ok(c);
    }

    // ── M7: journeys ──
    case 'getJourneys':
      return ok(await J.listJourneys(env));
    case 'getJourney':
      return ok(await J.getJourney(env, url.searchParams.get('id')));

    // ── M8: analytics — thin RPC passthroughs (relay_view already gated blanket-wide
    //    in fetch() before handleGet). SQL-side aggregation only; no raw rows to client.
    case 'getSendsOverview': {
      // from/to (ISO timestamptz) → the range _v2 RPC (calendar presets: Today/MTD/Last mo/FY);
      // plain `days` keeps the original trailing-window RPC.
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      const r = (from && to && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to)))
        ? await A.sbComms('/rest/v1/rpc/sends_overview_v2', env,
            { method: 'POST', body: JSON.stringify({ p_from: from, p_to: to }) })
        : await A.sbComms('/rest/v1/rpc/sends_overview', env,
            { method: 'POST', body: JSON.stringify({ p_days: Number(url.searchParams.get('days')) || 30 }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getDeliverabilityHealth': {
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      const r = (from && to && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to)))
        ? await A.sbComms('/rest/v1/rpc/deliverability_health_v2', env,
            { method: 'POST', body: JSON.stringify({ p_from: from, p_to: to }) })
        : await A.sbComms('/rest/v1/rpc/deliverability_health', env,
            { method: 'POST', body: JSON.stringify({ p_days: Number(url.searchParams.get('days')) || 30 }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getCampaignsOverview': {   // broadcast analytics list (BiteSpeed parity, Phase 1)
      const lim = Math.min(Number(url.searchParams.get('limit') || 200), 500);
      const off = Number(url.searchParams.get('offset') || 0);
      // ONE set-based RPC for every campaign — never per-campaign getCampaignStats in a loop.
      const r = await A.sbComms('/rest/v1/rpc/campaign_stats_list', env,
        { method: 'POST', body: JSON.stringify({ p_limit: lim, p_offset: off }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    case 'getJourneysOverview': {    // journey analytics list — the campaigns-overview twin (S230)
      const lim = Math.min(Number(url.searchParams.get('limit') || 200), 500);
      const off = Number(url.searchParams.get('offset') || 0);
      // ONE set-based RPC for every journey — never per-journey funnel calls in a loop.
      const r = await A.sbComms('/rest/v1/rpc/journey_stats_list', env,
        { method: 'POST', body: JSON.stringify({ p_limit: lim, p_offset: off }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    case 'getCampaignStats': {
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const r = await A.sbComms('/rest/v1/rpc/campaign_stats', env,
        { method: 'POST', body: JSON.stringify({ p_campaign_id: id }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getCampaignAttribution': {
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const r = await A.sbComms('/rest/v1/rpc/campaign_attribution', env,
        { method: 'POST', body: JSON.stringify({ p_campaign_id: id }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getJourneyAttribution': {     // M8.5 — journey revenue/conversion (BiteSpeed parity)
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const v = url.searchParams.get('version');
      const r = await A.sbComms('/rest/v1/rpc/journey_attribution', env,
        { method: 'POST', body: JSON.stringify({ p_journey_id: id, p_version: v ? Number(v) : null }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    case 'getJourneyFunnel': {
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const v = url.searchParams.get('version');
      const r = await A.sbComms('/rest/v1/rpc/journey_funnel', env,
        { method: 'POST', body: JSON.stringify({ p_journey_id: id, p_version: v ? Number(v) : null }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    // ── S272: A/B testing ──
    case 'getCampaignVariants': {
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const [vr, er] = await Promise.all([
        A.sbComms(`/rest/v1/campaign_variants?campaign_id=eq.${A.enc(id)}`
          + `&select=*&order=sort_order.asc,label.asc`, env),
        A.sbComms(`/rest/v1/campaign_experiments?campaign_id=eq.${A.enc(id)}&select=*&limit=1`, env),
      ]);
      if (!vr.ok) return err('db_error', 500);
      return ok({ variants: vr.data || [], experiment: (er.ok && er.data?.[0]) || null });
    }
    // Today's marketing send budget, read-only. Two jobs: it lets the app say how much room is
    // left BEFORE anyone builds a campaign against a 90k audience, and it is the only way to
    // observe the pre-send guard's own data path from outside.
    //
    // ⚠️ That second job matters more than it looks. `sendBudget()` FAILS OPEN by design — an
    // unreadable status lets the send through rather than inventing a cap — so if this RPC were
    // invisible to PostgREST (the S239 schema-cache trap: a new object returns not-found with no
    // error anywhere) the budget block would silently never fire and nothing would say so. This
    // endpoint makes that condition observable instead of latent.
    case 'getSendBudget': {
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const b = await CAMP.sendBudget(env);
      if (b.unreadable) return err('budget_unreadable', 500);
      return ok(b);
    }
    // Roster reconciliation (roster Task 7): who did we INTEND to message and never attempt?
    // Exact, against the frozen denominator — this replaces the audience_snapshot−stats.sent
    // ESTIMATE the tail badge used, which conflated "not sent" with "never attempted".
    case 'getCampaignRecon': {
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const camp = await CAMP.getCampaign(env, id);
      if (!camp) return err('not_found', 404);
      if (!camp.roster_built_at) return ok({ no_roster: true });   // legacy / pre-roster campaign
      const r = await A.sbComms('/rest/v1/rpc/campaign_recon', env,
        { method: 'POST', body: JSON.stringify({ p_campaign_id: id }) });
      if (!r.ok) return err('recon_failed', 500);
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return ok({ roster_size: Number(row?.roster_size || 0), attempted: Number(row?.attempted || 0),
                  never_attempted: Number(row?.never_attempted || 0) });
    }
    // Top-up preview: how many people became eligible AFTER the roster froze (§9.5). Count only —
    // rows never reach the worker (§9.2). Shares §9.1's scan cost; a timeout fails loudly here.
    case 'getTopupPreview': {
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const camp = await CAMP.getCampaign(env, id);
      if (!camp) return err('not_found', 404);
      if (!camp.roster_built_at) return err('no_roster', 400);
      const r = await A.sbComms('/rest/v1/rpc/campaign_topup_preview', env,
        { method: 'POST', body: JSON.stringify({ p_campaign_id: id }) });
      if (!r.ok) return err('topup_preview_failed', 500);
      return ok({ addable: Number(r.data || 0) });
    }
    case 'getVariantStats': {
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const stats = await computeVariantStats(env, id);
      if (!stats) return err('db_error', 500);
      return ok(stats);
    }
    case 'getVariantPreflight': {      // blocking comparability checks before an A/B send
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const camp = await CAMP.getCampaign(env, id);
      if (!camp) return err('not_found', 404);

      const vr = await A.sbComms(`/rest/v1/campaign_variants?campaign_id=eq.${A.enc(id)}`
        + `&select=*&order=sort_order.asc,label.asc`, env);
      if (!vr.ok) return err('db_error', 500);
      const variants = Array.isArray(vr.data) ? vr.data : [];
      if (variants.length < 2) return ok({ checks: [] });   // no test to pre-flight yet

      const checks = [];
      const sendable = variants.filter((v) => v.template_id);  // holdout arms render nothing

      // Batch-fetch every referenced template in ONE call. ⚠️ id=in.() is a malformed
      // PostgREST filter — guard the empty-list case.
      const tplIds = [...new Set(sendable.map((v) => v.template_id))];
      let templatesReadOk = true;
      let tplById = new Map();
      if (tplIds.length) {
        const tr = await A.sbComms(
          `/rest/v1/templates?id=in.(${tplIds.map(A.enc).join(',')})`
          + `&select=id,name,channel,approval_status,variables`, env);
        if (!tr.ok) templatesReadOk = false;
        else tplById = new Map((tr.data || []).map((t) => [t.id, t]));
      }
      const missingTpl = sendable.filter((v) => !tplById.has(v.template_id));

      // ── variables_match — the one that actually matters ──────────────────────────
      // ⚠️ Deliberately NOT a `{{token}}` scan of `content`. Verified against render.js:
      // renderEmail/renderWhatsapp both resolve merge fields off the TOP-LEVEL `variables`
      // column (resolveVar/resolveDeclared) — `content` itself never carries a "{{token}}"
      // string. Email and WA-TEXT bodies use SINGLE-brace {token} (render.js applyTokens);
      // a WA-TEMPLATE body embeds Meta's own numeric {{1}},{{2}} placeholders, and the named
      // token feeding each one lives only in content.mapping[].token, never spelled out as
      // "{{tokenName}}" anywhere. A regex over JSON.stringify(content) for {{name}} would
      // silently return an EMPTY set for every real template here — i.e. always "pass"
      // because nothing was found, the exact failing-open outcome this check exists to
      // prevent. Precedent: the S265 OFD-redirect incident (systems/relay.md) found this
      // the hard way — a bad clone differed only in its `variables` column (a dropped
      // fallback + a changed `source`), invisible from body/buttons/mapping, only caught by
      // diffing `variables` directly. "Diff the variables column, not just body/mapping."
      const varsOf = (tpl) => new Set(
        (Array.isArray(tpl?.variables) ? tpl.variables : []).map((v) => `{{${v.token}}}`));

      if (!templatesReadOk) {
        checks.push({ key: 'variables_match', pass: false, blocking: true,
          detail: 'Could not read arm templates — merge-variable comparability is unknown.' });
      } else if (missingTpl.length) {
        checks.push({ key: 'variables_match', pass: false, blocking: true,
          detail: `Arm ${missingTpl.map((v) => v.label).join(', ')} references a template that `
            + `no longer exists — cannot compare merge variables.` });
      } else if (sendable.length < 2) {
        checks.push({ key: 'variables_match', pass: true, blocking: true,
          detail: 'Fewer than two arms send a template — nothing to compare.' });
      } else {
        const armSets = sendable.map((v) => ({ label: v.label, vars: varsOf(tplById.get(v.template_id)) }));
        const union = new Set(); armSets.forEach((a) => a.vars.forEach((x) => union.add(x)));
        const problems = [];
        for (const token of union) {
          const has = armSets.filter((a) => a.vars.has(token)).map((a) => a.label);
          const lacks = armSets.filter((a) => !a.vars.has(token)).map((a) => a.label);
          if (lacks.length) {
            problems.push(`Arm ${has.join('/')} uses ${token} which arm ${lacks.join('/')} does `
              + `not — it will fail to render for anyone missing that field.`);
          }
        }
        checks.push({ key: 'variables_match', pass: problems.length === 0, blocking: true,
          detail: problems.length
            ? problems.join(' ') + ' The two versions would be measured over different, '
              + 'non-random groups of people — a biased result, not just a smaller one.'
            : 'All arms use the same merge variables.' });
      }

      // ── templates_approved — blocking, WhatsApp only ──────────────────────────────
      // Same shape as the guard in campaigns.js startCampaign, including its "an all-holdout
      // arm set can never send" refusal (ids.length === 0 there → no_sendable_arm here).
      if (sendable.length === 0) {
        checks.push({ key: 'templates_approved', pass: false, blocking: true,
          detail: 'Every arm is a holdout (no template) — there is nothing to send. '
            + 'startCampaign refuses this campaign (no_sendable_arm).' });
      } else if (!templatesReadOk) {
        checks.push({ key: 'templates_approved', pass: false, blocking: true,
          detail: 'Could not read arm templates — approval status is unknown.' });
      } else {
        const fails = [];
        for (const v of sendable) {
          const t = tplById.get(v.template_id);
          if (!t) { fails.push(`Arm ${v.label}'s template no longer exists.`); continue; }
          if (camp.channel === 'whatsapp' && String(t.approval_status || '').toUpperCase() !== 'APPROVED') {
            fails.push(`Arm ${v.label}'s template "${t.name}" is not APPROVED on WhatsApp `
              + `(status: ${t.approval_status || 'none'}).`);
          }
        }
        checks.push({ key: 'templates_approved', pass: fails.length === 0, blocking: true,
          detail: fails.length ? fails.join(' ') : "Every arm's template exists and is send-ready." });
      }

      // ── same_channel_purpose — blocking ─────────────────────────────────────────
      if (!templatesReadOk) {
        checks.push({ key: 'same_channel_purpose', pass: false, blocking: true,
          detail: 'Could not read arm templates — channel consistency is unknown.' });
      } else {
        const fails = [];
        for (const v of sendable) {
          const t = tplById.get(v.template_id);
          if (!t) { fails.push(`Arm ${v.label}'s template no longer exists.`); continue; }
          if (String(t.channel || '').toLowerCase() !== String(camp.channel || '').toLowerCase()) {
            fails.push(`Arm ${v.label} uses a "${t.channel}" template but the campaign channel `
              + `is "${camp.channel}" — it would fail to send.`);
          }
        }
        checks.push({ key: 'same_channel_purpose', pass: fails.length === 0, blocking: true,
          detail: fails.length ? fails.join(' ')
            : (sendable.length ? "Every arm's template matches the campaign channel."
                                : 'No arm sends a template — nothing to check.') });
      }

      // ── quiet_hours_risk — WARNING, not blocking ────────────────────────────────
      // Audience: campaigns.audience_snapshot when set (populated at approval/send time);
      // before that it's null, so fall back to the segment's CURRENT member count via
      // segments_list, the same SQL-side count `getSegment` uses. Deliberately NOT
      // campaigns.js's reachableCount(), which calls materialize_segment — real work this
      // screen (re-checked on every arm edit) cannot afford to pay on every keystroke.
      //
      // ⚠️ This used to read the member ROWS and take .length, which PostgREST caps at
      // db-max-rows = 5,000 with no error and no header (CORE.md S275). "Winback 90 — Email"
      // has 25,100 members (re-verified 2026-08-14), so the quiet-hours warning understated
      // its risk 5×. Warning-only, so it misinformed rather than mis-sent — but it is the
      // same defect fixed in getSegment the same day, and the fix is the same one call.
      let audience = null;
      if (camp.audience_snapshot != null) {
        audience = Number(camp.audience_snapshot);
      } else if (camp.segment_id) {
        const list = await A.sbComms('/rest/v1/rpc/segments_list', env,
          { method: 'POST', body: JSON.stringify({}) });
        const row = Array.isArray(list.data)
          ? list.data.find((x) => String(x.id) === String(camp.segment_id)) : null;
        if (row) audience = Number(row.member_count ?? 0);
      }

      if (audience == null || !Number.isFinite(audience)) {
        checks.push({ key: 'quiet_hours_risk', pass: false, blocking: false,
          detail: 'Could not estimate audience size — quiet-hours risk is unknown.' });
      } else {
        // Reuse the SAME resolution the real send gate uses (gate.js resolveQuietWindow): a
        // per-channel row wins when enabled, an explicitly disabled row means NO quiet hours
        // for that channel (e.g. email today), and only an absent row falls back to the
        // global comms.settings pair. Using the global pair unconditionally would be wrong
        // for WhatsApp (live window is 22:00–08:00 IST, not the global default) and would
        // falsely warn on a channel that has no quiet hours at all.
        const cqh = await G.getChannelQuietHours(env);
        if (!cqh.ok) {
          checks.push({ key: 'quiet_hours_risk', pass: false, blocking: false,
            detail: 'Could not read quiet-hours settings — risk is unknown.' });
        } else {
          const settings = await G.getSettings(env);
          const window = G.resolveQuietWindow(cqh.rows, camp.channel, settings);
          const fmt = (m) => { const mm = ((m % 1440) + 1440) % 1440;
            return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`; };
          if (!window) {
            checks.push({ key: 'quiet_hours_risk', pass: true, blocking: false,
              detail: `${camp.channel} has no quiet-hours window configured — no risk.` });
          } else {
            const hours = audience / 1200;             // ~1,200 sends/hour, serial fan-out
            const nowMin = G.istMinutes();
            const alreadyIn = G.inQuietWindow(window.startMin, window.endMin, nowMin);
            const untilStart = alreadyIn ? 0
              : (window.startMin > nowMin ? window.startMin - nowMin : window.startMin + 1440 - nowMin);
            const risky = alreadyIn || (hours * 60) > untilStart;
            checks.push({ key: 'quiet_hours_risk', pass: !risky, blocking: false,
              detail: alreadyIn
                ? `~${hours.toFixed(1)}h at ~1,200 sends/hour for ${audience} recipients; it is `
                  + `already inside the quiet-hours window (${fmt(window.startMin)}–${fmt(window.endMin)} `
                  + `IST) — sending now risks the tail being cut.`
                : risky
                  ? `~${hours.toFixed(1)}h at ~1,200 sends/hour for ${audience} recipients; `
                    + `starting now risks still sending after quiet hours begin at `
                    + `${fmt(window.startMin)} IST — the tail would be cut.`
                  : `~${hours.toFixed(1)}h at ~1,200 sends/hour for ${audience} recipients; `
                    + `finishes before quiet hours begin at ${fmt(window.startMin)} IST.` });
          }
        }
      }

      return ok({ checks });
    }
    case 'listExperiments': {          // cross-campaign experiment log
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const er = await A.sbComms('/rest/v1/campaign_experiments?select=*&order=created_at.desc', env);
      if (!er.ok) return err('db_error', 500);
      const rows = Array.isArray(er.data) ? er.data : [];
      const ids = [...new Set(rows.map((r) => r.campaign_id).filter(Boolean))];
      // Batch via IN, never a per-row lookup loop.
      const cr = ids.length
        ? await A.sbComms(`/rest/v1/campaigns?id=in.(${ids.map(A.enc).join(',')})`
            + `&select=id,name,channel,purpose,status`, env)
        : { ok: true, data: [] };
      const campById = {}; (cr.ok ? cr.data : []).forEach((c) => { campById[c.id] = c; });
      const enriched = rows.map((r) => ({ ...r, campaign: campById[r.campaign_id] || null }));
      return ok(enriched);
    }

    default:
      return err(`unknown_action:${action}`, 404);
  }
}

// ── POST actions ─────────────────────────────────────────────────────────────
async function handlePost(body, auth, env) {
  switch (body.action) {
    // ── Links (S261) ────────────────────────────────────────────────────────────────────
    // Gated on `campaign_build`, reusing the relayops layer rather than minting a new key —
    // a link is a campaign asset. NB this is a REAL permission decision, not a formality:
    // `updateLink` can repoint a QR code already printed on packaging, so whoever holds
    // campaign_build can change where physical artwork sends customers. Every target change
    // is audited to comms.link_changes for exactly that reason.
    case 'createLink': {
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const r = await LINKS.createCampaignLink(env, {
        slug: body.slug, target: body.target_url, title: body.title,
        utm: body.utm, userId: auth.userId,
      });
      // Named errors, not a generic 400 — "that short name is taken" and "that is not a valid
      // URL" need different things from the person at the form.
      if (!r.ok) return err(r.error, r.error === 'slug_taken' ? 409 : 400);
      return ok(r.link);
    }

    case 'updateLink': {
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const r = await LINKS.updateCampaignLink(env, {
        code: body.code, target: body.target_url, title: body.title,
        utm: body.utm, active: body.active, reason: body.reason, userId: auth.userId,
      });
      if (!r.ok) return err(r.error, r.error === 'not_found' ? 404 : 400);
      return ok(r.link);
    }

    case 'saveRole': {                 // create/clone/edit a custom role (M2)
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      const { role_key, label, description, permissions } = body;
      if (!role_key || !label) return err('role_key_and_label_required', 400);
      const r = await A.sbStore('/rest/v1/relayops_roles', env, {
        method: 'POST',
        prefer: 'return=representation,resolution=merge-duplicates',
        body: JSON.stringify({
          role_key, label, description: description || null,
          permissions: permissions || {}, is_system: false, updated_at: nowIso(),
        }),
      });
      return r.ok ? ok(r.data?.[0]) : err('db_error:' + JSON.stringify(r.data), 500);
    }
    case 'assignUserRole': {
      if (!A.canAdmin(auth.permissions)) return err('forbidden', 403);
      const { user_id, role_key, active, full_name } = body;
      if (!user_id || !role_key) return err('user_id_and_role_key_required', 400);
      // Only a super admin may hand out a role that carries relay_super_admin — otherwise a
      // relay_admin self-escalates into saveRelaySettings/test_mode/PII backfill (review H9).
      const roleR = await A.sbStore(
        `/rest/v1/relayops_roles?role_key=eq.${A.enc(role_key)}&select=permissions&limit=1`, env);
      if (!roleR.ok || !roleR.data?.[0]) return err('unknown_role', 400);
      if (roleR.data[0].permissions?.relay_super_admin && !A.canSuperAdmin(auth.permissions))
        return err('super_admin_required_to_grant_super_admin', 403);
      // Ensure a users_profile row exists + is active — verifyJWT requires one,
      // so a granted user can actually sign in (mirrors odoops grantAccess).
      const profR = await A.sbStore(`/rest/v1/users_profile?id=eq.${A.enc(user_id)}&select=id&limit=1`, env);
      if (profR.ok && profR.data?.[0]) {
        await A.sbStore('/rest/v1/users_profile', env, {
          method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates',
          body: JSON.stringify({ id: user_id, active: true }),
        });
      } else {
        await A.sbStore('/rest/v1/users_profile', env, {
          method: 'POST', prefer: 'return=minimal',
          body: JSON.stringify({ id: user_id, full_name: full_name || user_id, role: 'staff', active: true }),
        });
      }
      const r = await A.sbStore('/rest/v1/relayops_user_roles', env, {
        method: 'POST',
        prefer: 'return=representation,resolution=merge-duplicates',
        body: JSON.stringify({
          user_id, role_key, active: active !== false,
          assigned_by: auth.userId, assigned_at: nowIso(),
        }),
      });
      return r.ok ? ok(r.data?.[0]) : err('db_error', 500);
    }
    case 'saveChannelQuietHours': {    // S268 — per-channel marketing quiet windows
      // Same super-admin gate as saveRelaySettings: this decides when customers can be
      // messaged, and getting SMS wrong is a compliance breach, not a UX preference.
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      const rows = Array.isArray(body.rows) ? body.rows : null;
      if (!rows) return err('rows_required', 400);
      const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
      const patch = [];
      for (const r of rows) {
        const ch = String(r?.channel || '').trim();
        if (!ch) return err('channel_required', 400);
        const enabled = !!r.enabled;
        // Validate the times even when the channel is disabled — they are retained so that
        // re-enabling restores the intended window, and a blank stored while disabled would
        // surface later as a silently-wrong window on the day someone flips it back on.
        const st = String(r.start_time || '').slice(0, 5), en = String(r.end_time || '').slice(0, 5);
        if (!HHMM.test(st) || !HHMM.test(en))
          return err(`invalid_time:${ch} — start/end must be HH:MM (24h)`, 422);
        // A zero-length window reads as "never quiet", which is almost certainly not what an
        // author who filled both fields meant. Make them use the enabled toggle instead.
        if (enabled && st === en)
          return err(`invalid_window:${ch} — start and end are identical; switch the channel off instead`, 422);
        patch.push({ channel: ch, enabled, start_time: st, end_time: en, note: r.note ?? null, updated_at: nowIso() });
      }
      const w = await A.sbComms('/rest/v1/channel_quiet_hours', env, {
        method: 'POST',
        headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify(patch),
      });
      return w.ok ? ok(w.data) : err('db_error:' + JSON.stringify(w.data), 500);
    }
    case 'saveRelaySettings': {        // approval thresholds, freq caps, quiet hours (M2)
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      // S243 added the last four. They existed as columns and were documented as operational
      // switches — the C2P go-live gate, its pricing ("settings, so a pricing change never needs
      // a deploy") and the wa_media_id revert path — but none were reachable from the UI, so all
      // of them were SQL-only and every change needed an engineer. Exposing a documented switch
      // is the difference between a runbook the team can follow and one that ends in "ask Claude".
      const allowed = ['approval_required_marketing', 'approval_audience_threshold',
        'frequency_cap_per_day', 'frequency_cap_window_hours', 'quiet_hours_start',
        'quiet_hours_end', 'attribution_window_days', 'test_mode', 'test_mode_allow',
        'daily_send_budget',
        'payment_links_enabled', 'c2p_cod_fee', 'c2p_prepaid_discount_pct', 'wa_media_id_enabled',
        // "Wrong number" redirect (S245) — read by csops on every relay-transported inbound.
        'wrong_number_redirect_enabled', 'wrong_number_redirect_phone_ids', 'wrong_number_redirect_text',
        // Account-wide utm_* floor, overridden per journey/campaign and per template.
        'utm_defaults',
        // S254 — the last three SQL-only operational switches. The backlog literally
        // instructs changing `courier_emit_from` to move a go-live date, yet it had no
        // control, so the act was a hand-written UPDATE on a live table whose blast radius
        // is customer WhatsApp messages. See the validation below: these are gated harder
        // than the rest precisely because moving a watermark BACKWARD releases a burst.
        'courier_emit_from', 'rto_stage_emit_from', 'segment_entry_max_per_tick'];
      const patch = { updated_at: nowIso() };
      for (const k of allowed) if (k in body) patch[k] = body[k];
      // Disabling test mode = unlocking real-customer sends. Make it a deliberate,
      // explicit act: only when the caller affirms it AND only ever to a boolean.
      if ('test_mode' in patch) patch.test_mode = (patch.test_mode === true);
      // Same posture for the two other switches that change what reaches a customer or a card:
      // coerce strictly, so a stray truthy string can never turn on real payment collection.
      if ('payment_links_enabled' in patch) patch.payment_links_enabled = (patch.payment_links_enabled === true);
      if ('wa_media_id_enabled' in patch) patch.wa_media_id_enabled = (patch.wa_media_id_enabled === true);
      // Normalized by the same helper the send path uses, so what is stored is what will be sent.
      if ('utm_defaults' in patch) patch.utm_defaults = J.sanitizeUtm(patch.utm_defaults);
      // C2P PRICING — validate to exactly the range journey-workflow's `c2p_prepaid` branch will
      // accept, so a bad value is refused HERE with a clear error rather than silently failing
      // every conversion later as `c2p_pricing_unavailable`. Mirrors that fail-closed check.
      if ('c2p_cod_fee' in patch) {
        const fee = Number(patch.c2p_cod_fee);
        if (!Number.isFinite(fee) || fee < 0) return err('c2p_cod_fee must be a number >= 0', 422);
        patch.c2p_cod_fee = fee;
      }
      if ('c2p_prepaid_discount_pct' in patch) {
        const pct = Number(patch.c2p_prepaid_discount_pct);
        if (!Number.isFinite(pct) || pct < 0 || pct >= 100) return err('c2p_prepaid_discount_pct must be a number >= 0 and < 100', 422);
        patch.c2p_prepaid_discount_pct = pct;
      }
      // EMIT WATERMARKS (S254). Both are fail-closed gates on real customer messaging:
      // shipment-events.js and rto-stages.js emit NOTHING when unset, and that property must
      // survive contact with a form. An empty string from a cleared date input would blank the
      // column and silently switch the feed off, so a blank is REFUSED rather than written —
      // turning a feed off is a decision, not a side effect of clearing a field.
      for (const k of ['courier_emit_from', 'rto_stage_emit_from']) {
        if (!(k in patch)) continue;
        const raw = patch[k];
        if (raw === null || raw === '' || raw === undefined)
          return err(`${k} cannot be blank — an unset watermark silently stops that feed`, 422);
        const t = Date.parse(raw);
        if (Number.isNaN(t)) return err(`${k} must be a valid date/time`, 422);
        // A watermark in the future is legitimate (that is how a go-live is scheduled), but a
        // far-future one is almost certainly a typo'd year, and it would mute the feed for
        // months without any error anywhere.
        if (t > Date.now() + 365 * 86400000)
          return err(`${k} is more than a year in the future — check the year`, 422);
        patch[k] = new Date(t).toISOString();
      }
      // Segment-entry cap. `> 0` matters: segment-entry.js only honours a positive number and
      // otherwise silently falls back to DEFAULT_CAP=500, so 0 or a negative would read as
      // "no enrolments" while actually meaning "500".
      if ('segment_entry_max_per_tick' in patch) {
        const n = Number(patch.segment_entry_max_per_tick);
        if (!Number.isInteger(n) || n < 1 || n > 20000)
          return err('segment_entry_max_per_tick must be a whole number between 1 and 20000', 422);
        patch.segment_entry_max_per_tick = n;
      }
      const r = await A.sbComms('/rest/v1/settings?id=eq.1', env, {
        method: 'PATCH', body: JSON.stringify(patch),
      });
      return r.ok ? ok(r.data?.[0]) : err('db_error', 500);
    }
    case 'saveSenderIdentity': {
      if (!A.canConnector(auth.permissions)) return err('forbidden', 403);
      const { id, channel, address, purpose, provider, status, credentials_ref, metadata } = body;
      const row = { channel, address, purpose, provider, status, credentials_ref, metadata: metadata || {} };
      const r = id
        ? await A.sbComms(`/rest/v1/sender_identities?id=eq.${A.enc(id)}`, env, { method: 'PATCH', body: JSON.stringify(row) })
        : await A.sbComms('/rest/v1/sender_identities', env, { method: 'POST', body: JSON.stringify(row) });
      return r.ok ? ok(r.data?.[0]) : err('db_error', 500);
    }

    case 'recordConsent': {            // manual consent admin write (M3)
      if (!A.canConsentAdmin(auth.permissions)) return err('forbidden', 403);
      const r = await recordConsent(env, body);
      return r.ok ? ok(r.data?.[0]) : err('db_error', 500);
    }

    case 'optOutProfile': {            // agent-actioned withdrawal — Meta "on or off WhatsApp"
      if (!A.canConsentAdmin(auth.permissions)) return err('forbidden', 403);
      if (!body.profile_id) return err('profile_id_required', 400);
      const channels = Array.isArray(body.channels) && body.channels.length
        ? body.channels : ['email', 'sms', 'whatsapp'];
      const state = body.state === 'opted_in' ? 'opted_in' : 'opted_out';
      // Attempt every channel, then report. applyOptOut has a mixed contract: it THROWS on
      // a failed consent write (→ 500, loud, correct for an authenticated admin) but
      // RETURNS {ok:false} on a validation failure. An unchecked push would send that
      // {ok:false} back inside a 200 — the agent would believe a customer's withdrawal was
      // recorded when nothing was written. That is the same silent-loss failure optout.js
      // throws to prevent, one layer up. Both validation branches are unreachable from this
      // call site today (profile_id is guarded above, state is a ternary) — but that is
      // unreachability by call site, not by contract, so check it anyway.
      //
      // Deliberately does NOT abort on first failure: a partial withdrawal is safe
      // (over-withdrawing never harms a customer) and attempting all channels tells the
      // agent exactly which ones need a retry. applyOptOut is idempotent-safe — the ledger
      // is append-only and latest-wins, so a retry costs a duplicate row, nothing more.
      const applied = [];
      for (const ch of channels) {
        const r = await OPTOUT.applyOptOut(env, {
          profile_id: body.profile_id,
          channel: ch,
          purpose: 'marketing',
          state,
          source: 'agent_actioned',
          evidence: {
            actioned_by: auth.email || auth.userId || 'unknown',
            reason: body.reason || null,
            requested_via: body.requested_via || null,
            actioned_at: new Date().toISOString(),
          },
        });
        applied.push({ channel: ch, ...r });
      }
      const failed = applied.filter((r) => !r.ok);
      if (failed.length) {
        return err(`optout_failed:${failed.map((f) => `${f.channel}:${f.error}`).join(',')}`, 500);
      }
      return ok({ applied });
    }

    case 'saveTemplate': {             // M5 — editing an active template publishes a new version
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const { id, channel, name, purpose, language, content, variables, status, utm } = body;
      if (!name) return err('name_required', 400);
      if (id) {
        const cur = await A.sbComms(
          `/rest/v1/templates?id=eq.${A.enc(id)}`
          + `&select=id,version,content,variables,channel,name,purpose,language,status,approval_status,provider_template_id&limit=1`, env);
        const v = (cur.ok && Number(cur.data?.[0]?.version)) || 1;
        // The UI rebuilds `content` from form state and historically DROPPED worker-owned /
        // UI-omitted keys (waba_id pin, header_handle, header_format, header_media_url) —
        // which silently re-routes sync/sends to the wrong WABA or collapses a media header
        // to TEXT (review C4/M8). Carry them over unless explicitly sent. `header` itself is
        // UI-emitted (WaEditor's Header input, apps/relay .../templates/page.js buildPayload)
        // so it is NOT in this list — an intentional clear must go through.
        const prev = (cur.ok && cur.data?.[0]?.content) || {};
        const mergedContent = { ...(content || {}) };
        for (const k of ['waba_id', 'header_handle', 'header_format', 'header_media_url']) {
          if (mergedContent[k] == null && prev[k] != null) mergedContent[k] = prev[k];
        }
        // Same class of protection for SMS (2026-08-03). The relay editor's buildPayload()
        // branches ONLY on channel==='whatsapp'; every other channel — now including sms —
        // falls into the EMAIL shape {subject, html_body, text_body, design_json}. So opening
        // an SMS template and pressing Save would post email content and drop every field the
        // SMS adapter needs, destroying the DLT body and the positional var_order mapping in
        // one click. The row would then fail closed on send (empty_sms_body), so the damage is
        // silent data loss rather than a bad customer message — which is exactly why it needs
        // a guard rather than a reader noticing. Remove these entries only when the editor can
        // genuinely author SMS.
        for (const k of ['body', 'var_order', 'dlt_var_count', 'dlt_template_id', 'template_type', 'needs_variable_authoring', 'source', 'provider_status']) {
          if (mergedContent[k] == null && prev[k] != null) mergedContent[k] = prev[k];
        }
        // ...but "carry it over when absent" is NOT enough for `waba_id`, because WaEditor always
        // SENDS one from client state — it keeps the value even while the select is `disabled`
        // (`locked = !!provider_template_id`). So the branch above never fired for it, and any tab
        // opened before a WABA flip wrote the OLD id back on its next Save. That is what reverted
        // the S240 flip within hours: `lot_order_placed_01` landed back on the BiteSpeed WABA and
        // every send failed `wa_200 (#200) … permissions … on behalf of this WhatsApp Business
        // Account`, which reads as a Meta permissions fault and is not — it is `pickSender`
        // correctly refusing a WABA we cannot send on.
        //
        // Once Meta has ever approved this template, the pin is WORKER-OWNED: it moves by the
        // migration-day UPDATE or by stage mode (`waSubmitTemplate({stageWabaId})`), never by a
        // form post. Take the stored value unconditionally — matching what the UI already claims
        // by greying the field out. A stale tab now cannot re-route a live template's sends.
        if (cur.data?.[0]?.provider_template_id && prev.waba_id != null) mergedContent.waba_id = prev.waba_id;
        // NO-OP ON NO CHANGES. `version` was bumped on EVERY save, so simply opening a
        // template and pressing Save inflated it — live rows had reached v5–v7 on a handful
        // of real edits, which makes the version meaningless exactly when you need it (which
        // save introduced a regression?). A save that changes nothing must not publish a
        // version. Compare on the MERGED content, so a carried-over worker-owned key
        // (waba_id/header_handle/…) does not read as a change.
        const prevRow = (cur.ok && cur.data?.[0]) || null;
        if (prevRow && stableJson(prevRow.content) === stableJson(mergedContent)
          && stableJson(prevRow.variables || []) === stableJson(variables || [])
          && (prevRow.channel || null) === (channel || null)
          && (prevRow.name || null) === (name || null)
          && (prevRow.purpose || null) === (purpose || null)
          && (prevRow.language || 'en') === (language || 'en')
          && (prevRow.status || 'active') === (status || 'active')
          // utm MUST be in this comparison: it is a real, savable field, and omitting it made a
          // utm-only edit return noop:true and silently never persist.
          && stableJson(prevRow.utm ?? null) === stableJson(utm !== undefined ? J.sanitizeUtm(utm) : (prevRow.utm ?? null))) {
          return ok({ ...prevRow, noop: true });
        }
        // Freezing the variant ROWS while leaving template CONTENT editable is a half-measure:
        // messages.template_version is stamped per send, so editing an arm's template mid-fan-out
        // splits that arm across two versions and the "arm" stops being one thing.
        const boundDirect = await A.sbComms(
          `/rest/v1/campaigns?template_id=eq.${A.enc(id)}`
          + `&status=in.(approved,scheduled,sending)&select=id,name&limit=1`, env);
        const boundVariant = await A.sbComms(
          `/rest/v1/campaign_variants?template_id=eq.${A.enc(id)}`
          + `&select=campaign_id,campaigns!inner(id,name,status)`
          + `&campaigns.status=in.(approved,scheduled,sending)&limit=1`, env);
        if ((boundDirect.ok && boundDirect.data?.[0]) || (boundVariant.ok && boundVariant.data?.[0]))
          return err('template_bound_to_live_campaign', 422);
        const r = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}`, env, {
          method: 'PATCH', body: JSON.stringify({
            channel, name, purpose, language: language || 'en', content: mergedContent,
            variables: variables || [], status: status || 'active', version: v + 1, updated_at: nowIso(),
            ...(utm !== undefined ? { utm: J.sanitizeUtm(utm) } : {}),
          }),
        });
        if (!r.ok) return err('db_error', 500);
        const archived = await archiveTemplateVersion(env, r.data?.[0], auth.userId);
        return ok({ ...r.data?.[0], archived });
      }
      const r = await A.sbComms('/rest/v1/templates', env, {
        method: 'POST', body: JSON.stringify({
          channel: channel || 'email', name, purpose: purpose || 'marketing',
          language: language || 'en', content: content || {}, variables: variables || [],
          status: status || 'active', created_by: auth.userId, utm: J.sanitizeUtm(utm),
        }),
      });
      if (!r.ok) return err('db_error:' + JSON.stringify(r.data), 500);
      const archived = await archiveTemplateVersion(env, r.data?.[0], auth.userId);
      return ok({ ...r.data?.[0], archived });
    }

    case 'createEmailAssetUploadUrl': {   // email authoring v1 — signed upload into the public relay-email-assets bucket
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const fileName = body.file_name;
      if (!fileName) return err('file_name_required', 400);
      const v = EA.validateAsset({ fileName, mimeType: body.mime_type });
      if (!v.ok) return err(v.error, 400);
      const bucket = 'relay-email-assets';
      const path = EA.assetPath(fileName, Date.now());
      const sr = await fetch(`${env.SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${enc2(path)}`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        // Storage is Fastify: declaring application/json with NO body is a hard 400
        // ("Body cannot be empty when content-type is set to 'application/json'").
        // storage-js posts an empty object here — match it. Every image upload 400'd
        // without this.
        body: JSON.stringify({}),
      });
      const st = await sr.text();
      let sd; try { sd = st ? JSON.parse(st) : null; } catch { sd = null; }
      if (!sr.ok || !sd?.url) return err(`sign_failed:${st}`, 502);
      return ok(EA.signToUrls(env, bucket, path, sd));
    }

    case 'addSuppression': {           // S253 — block an address by hand
      // The customer who phones and says "stop everything" currently has no path other than
      // SQL. This is that path. Deliberately gated on data_consent_admin, not template
      // perms: a suppression stops transactional mail too, so it is a privacy action.
      if (!A.canConsentAdmin(auth.permissions)) return err('forbidden', 403);
      const channel = String(body.channel || '').trim();
      const value = String(body.value || '').trim();
      if (!['email', 'sms', 'whatsapp'].includes(channel)) return err('bad_channel', 400);
      if (!value) return err('value_required', 400);
      // Normalise exactly as the writers do, or the gate will never match what we store:
      // gate.js compares `value=eq.<to>` against the address the send is going to.
      const norm = channel === 'email' ? value.toLowerCase() : value.replace(/[^\d+]/g, '');
      const r = await A.sbComms('/rest/v1/suppressions?on_conflict=channel,value', env, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          channel, value: norm, profile_id: body.profile_id || null,
          reason: String(body.reason || 'manual').slice(0, 60),
        }),
      });
      if (!r.ok) return err('db_error:' + JSON.stringify(r.data), 500);
      return ok(r.data?.[0] || { channel, value: norm });
    }

    case 'removeSuppression': {        // S253 — lift a block, with the compliance line held
      if (!A.canConsentAdmin(auth.permissions)) return err('forbidden', 403);
      const id = body.id;
      if (!id) return err('id_required', 400);
      const cur = await A.sbComms(`/rest/v1/suppressions?id=eq.${A.enc(id)}&select=*&limit=1`, env);
      const row = (cur.ok && cur.data?.[0]) || null;
      if (!row) return err('not_found', 404);
      // ⛔ A gdpr_redact suppression is a LEGAL ERASURE REQUEST (Shopify customers/redact).
      // Lifting it re-enables messaging to someone who asked to be forgotten — a DPDP/GDPR
      // violation, not a UX inconvenience. Refused outright, with no override in the UI or
      // the API. If one was created in error it has to be undone deliberately in SQL by
      // someone who has read this comment.
      if (row.reason === 'gdpr_redact') return err('gdpr_redact_cannot_be_lifted', 403);
      // Audit BEFORE the delete: the suppressions table is hard-delete, so once the row is
      // gone the reason is gone with it. Written first so a failed delete leaves a harmless
      // extra audit row rather than an unexplained missing block.
      await A.sbComms('/rest/v1/suppression_lifts', env, {
        method: 'POST',
        body: JSON.stringify({
          channel: row.channel, value: row.value, profile_id: row.profile_id,
          original_reason: row.reason, original_created_at: row.created_at,
          note: String(body.note || '').slice(0, 500) || null,
          lifted_by: auth.email || auth.userId || null,
        }),
      });
      const dr = await A.sbComms(`/rest/v1/suppressions?id=eq.${A.enc(id)}`, env, { method: 'DELETE' });
      if (!dr.ok) return err('db_error', 500);
      return ok({ lifted: id, channel: row.channel, value: row.value, was: row.reason });
    }

    case 'setTemplateArchived': {      // S252 — archive/unarchive, the SAFE way to retire one
      // ⚠️ Archiving is LOCAL ONLY and never touches Meta. Deliberate — see deleteTemplate
      // below for the full reasoning. Meta keeps its approved copy, so an archived template
      // can be un-archived and used again with no re-approval.
      //
      // `status='archived'` existed in the enum since M5 but NOTHING read it, so archiving
      // was cosmetic. It is now honoured: archived templates drop out of the library list
      // (behind a filter) and out of the journey/campaign pickers, so nobody can newly
      // wire one up.
      //
      // Sends are deliberately NOT blocked on archived. If a live journey still references
      // one, refusing the send would break a customer-facing flow silently — strictly worse
      // than letting it send. The guard is at the point of archiving instead: the caller is
      // told which live journeys use it and must confirm.
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const id = body.id;
      if (!id) return err('id_required', 400);
      const archived = body.archived !== false;
      const r = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}`, env, {
        method: 'PATCH',
        body: JSON.stringify({ status: archived ? 'archived' : 'draft', updated_at: nowIso() }),
      });
      if (!r.ok) return err('db_error', 500);
      return ok({ ...(r.data?.[0] || {}), archived });
    }

    case 'deleteTemplate': {           // S252 — hard delete, heavily fenced
      // ⛔ THIS NEVER DELETES FROM META, AND THAT IS THE WHOLE DESIGN. Checked against
      // Meta's current docs rather than assumed:
      //  · DELETE by `name` removes EVERY language version of the template at once.
      //  · The docs do NOT state whether a deleted name can be reused, or after how long.
      //    An undocumented constraint on recreating a name is itself a reason not to.
      //  · Meta already auto-archives templates inactive for 12 months and deletes them
      //    28 days later, so dead templates age out on Meta's side without our help.
      //  · Deleting on Meta while anything still references the name produces
      //    `(#132001) Template name does not exist in the translation` — not hypothetical,
      //    that exact failure is already recorded in comms.messages here.
      // So: a template that has EVER been submitted to Meta cannot be deleted from Relay at
      // all — archive it instead. Only a purely-local template (never submitted, so there is
      // no Meta copy to diverge from) can be removed, and only when nothing points at it.
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const id = body.id;
      if (!id) return err('id_required', 400);
      const cur = await A.sbComms(
        `/rest/v1/templates?id=eq.${A.enc(id)}&select=id,name,provider_template_id,approval_status&limit=1`, env);
      const row = (cur.ok && cur.data?.[0]) || null;
      if (!row) return err('template_not_found', 404);
      // Guard on EITHER signal of Meta contact, not just provider_template_id.
      // Found live 2026-07-31: `Shipment Update-Out for Delivery_WA` carries
      // approval_status='APPROVED' with provider_template_id NULL — Meta has seen it but we
      // no longer hold its id. Checking only the id would have let that be deleted here,
      // orphaning a template on Meta under a name we could then never cleanly recreate
      // (name-reuse rules are undocumented). Any evidence of Meta contact ⇒ archive only.
      if (row.provider_template_id || row.approval_status) {
        return err('on_meta_archive_instead', 409);
      }
      const ur = await A.sbComms('/rest/v1/rpc/template_usage', env, { method: 'POST', body: '{}' });
      if (!ur.ok) return err('usage_check_failed', 502);   // fail CLOSED, never delete blind
      const u = (ur.data && ur.data[String(id)]) || {};
      const blockers = [];
      if (u.journeys_other) blockers.push(`${u.journeys_other} journey(s)`);
      if (u.campaigns) blockers.push(`${u.campaigns} campaign(s)`);
      if (u.sent) blockers.push(`${u.sent} sent message(s)`);
      if (blockers.length) return err(`in_use:${blockers.join(', ')}`, 409);
      // Version archive first — it FKs nothing but is meaningless once the parent is gone.
      await A.sbComms(`/rest/v1/template_versions?template_id=eq.${A.enc(id)}`, env, { method: 'DELETE' });
      const dr = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}`, env, { method: 'DELETE' });
      if (!dr.ok) return err('db_error', 500);
      return ok({ deleted: id, name: row.name });
    }

    case 'renameMediaAsset': {         // S251c — make the library searchable by name
      // Storage has no rename: it is a MOVE, and the old public URL dies the instant it
      // completes. Afshaan's requirement — "renamed there too, so there is only one copy" —
      // is exactly that: move the single object, then repoint every stored reference.
      // Never copy-and-leave, which would double the bucket and reintroduce the duplicate
      // problem the library was built to expose.
      //
      // ⚠️ Known, accepted cost: an already-DELIVERED email hot-links the old URL, so its
      // image breaks in the recipient's inbox. Measured before building this: 56 email
      // sends, all on 2026-06-30, from one template (Relay email is still test-gated).
      // WhatsApp is unaffected — approved templates send by Meta media-id and Meta holds
      // its own copy of the asset. Small and bounded, but it is why the UI says so.
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const path = String(body.path || '');
      if (!path.startsWith('email/') || path.includes('..')) return err('bad_path', 400);

      const file = path.slice('email/'.length);
      // Keep the epoch-ms prefix: it is what guarantees uniqueness and preserves upload
      // order, and the UI strips it for display anyway. Only the human part is renamed.
      const m = file.match(/^(\d+_)?(.*?)(\.[a-z0-9]+)?$/i);
      const stamp = m?.[1] || `${Date.now()}_`;
      const ext = (m?.[3] || '').toLowerCase();
      // Same sanitiser as email-assets.js safeSeg, so a renamed file cannot acquire
      // characters the upload path would never have produced (and which encodeURIComponent
      // would then escape, making the stored URL and the displayed URL disagree).
      const desired = String(body.new_name || '')
        .replace(/\.[a-z0-9]+$/i, '')
        .toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!desired) return err('name_required', 400);
      const newFile = `${stamp}${desired}${ext}`;
      const newPath = `email/${newFile}`;
      if (newPath === path) return ok({ renamed: false, path, unchanged: true });

      // Reject a clash on the DISPLAY name (what the epoch prefix hides), so search stays
      // unambiguous — two tiles both reading "hero.png" is the confusion this feature exists
      // to remove.
      const lr2 = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/relay-email-assets`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefix: 'email/', limit: 500, offset: 0 }),
      });
      const lj = await lr2.json().catch(() => null);
      if (!lr2.ok || !Array.isArray(lj)) return err('list_failed', 502);
      const clash = lj.some((o) => o?.name && o.name !== file
        && o.name.replace(/^\d+_/, '') === `${desired}${ext}`);
      if (clash) return err(`name_taken:${desired}${ext}`, 409);

      // 1) MOVE first. If the reference rewrite then fails we can move back and end up
      //    exactly where we started; the reverse order would leave live templates
      //    pointing at a path that does not exist yet.
      const mv = await fetch(`${env.SUPABASE_URL}/storage/v1/object/move`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bucketId: 'relay-email-assets', sourceKey: path, destinationKey: newPath,
        }),
      });
      if (!mv.ok) return err(`move_failed:${(await mv.text()).slice(0, 200)}`, 502);

      // 2) Repoint every reference, in ONE transaction (templates + version archive +
      //    the Meta media cache).
      const rw = await A.sbComms('/rest/v1/rpc/rename_media_references', env, {
        method: 'POST',
        body: JSON.stringify({ p_old_path: path, p_new_path: newPath }),
      });
      if (!rw.ok) {
        // Compensate: put the object back so the rename is all-or-nothing from the
        // caller's point of view. If even THAT fails, say so loudly with both paths —
        // a silent half-rename is the one outcome nobody could diagnose later.
        const back = await fetch(`${env.SUPABASE_URL}/storage/v1/object/move`, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            bucketId: 'relay-email-assets', sourceKey: newPath, destinationKey: path,
          }),
        });
        return err(back.ok
          ? 'rename_rolled_back_references_unchanged'
          : `rename_INCONSISTENT_file_is_at:${newPath}_references_still_point_to:${path}`, 502);
      }
      return ok({ renamed: true, path: newPath, name: newFile, references: rw.data || {} });
    }

    case 'deleteMediaAsset': {         // S251 — library housekeeping, usage-guarded
      // Deleting a public asset is irreversible and immediately visible to customers: an
      // email template embeds the URL live, so removing the object breaks every future
      // send of that email. So this REFUSES any asset a template still references, and
      // says which ones — the caller cannot override it. (A WhatsApp header is safer,
      // since Meta keeps its own copy of an approved template's sample image, but the
      // saved row would still point at a dead URL and the next submit would fail.)
      //
      // The point of allowing deletion at all: the bucket already holds duplicates of the
      // same picture, created because the editor's asset panel was never seeded and
      // authors re-uploaded what was already there. 8 of 28 objects are unreferenced.
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const path = String(body.path || '');
      // Confine to the library's own prefix and refuse traversal — this is a delete taking
      // a caller-supplied path, so the shape of the path is a security boundary, not a nicety.
      if (!path.startsWith('email/') || path.includes('..')) return err('bad_path', 400);
      const ur = await A.sbComms('/rest/v1/rpc/media_usage', env, { method: 'POST', body: '{}' });
      if (!ur.ok) return err('usage_check_failed', 502);   // fail CLOSED — never delete blind
      const used = (ur.data && ur.data[path]) || [];
      if (used.length) {
        return err(`in_use:${used.map((t) => t.name).join(', ')}`.slice(0, 300), 409);
      }
      const dr = await fetch(`${env.SUPABASE_URL}/storage/v1/object/relay-email-assets/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'DELETE',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!dr.ok) return err(`delete_failed:${(await dr.text()).slice(0, 200)}`, 502);
      return ok({ deleted: path });
    }


    case 'sendTest': {                 // M5 — test-send: always allowed, no approval; isTest bypasses the marketing gates
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      if (!body.to) return err('to_required', 400);
      // sendTest is arbitrary-content by design — so its recipients are permanently
      // restricted to the TEST union (test_mode_allow ∪ test_allowlist), even after
      // test_mode goes OFF (review M3). A blocked recipient is self-serve fixable:
      // addTestAllowlist (builder perm) adds the exact address, then resend.
      if (!(await G.testRecipientAllowed(env, body.to)))
        return err('test_sends_are_internal_only', 403);
      const r = await send(env, {
        // Route with the template's REAL purpose: pickSender purpose-matches within the
        // template's WABA, so the old hardcoded 'transactional' could never route a
        // marketing-pinned template out the marketing number (surfaced S232 as a
        // misleading no_sender_on_waba on every UI test of a live marketing template).
        // Gating is unaffected — isTest already bypasses the marketing gates (gate.js
        // isMarketing = purpose==='marketing' && !isTest) and hard-locks recipients to
        // the test union either way.
        channel: body.channel || 'email',
        purpose: ['marketing', 'utility', 'transactional'].includes(body.purpose) ? body.purpose : 'transactional',
        isTest: true,
        to: body.to, templateId: body.templateId || null, template: body.template || null,
        profileId: body.profileId || null, constants: body.constants || {},
        // Test values double as the trigger-event context so EVENT-sourced variables
        // (the abandoned-cart templates' product/total/image/url slots) resolve in a
        // test send instead of always collapsing to their fallbacks.
        eventContext: body.event || body.constants || {},
        recipient: body.recipient || {}, source: 'test',
      });
      return ok(r);
    }
    case 'addTestAllowlist': {         // S230 — builder-managed TEST-send allowlist (exact addresses only)
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const entry = String(body.entry || '').trim();
      if (!entry) return err('entry_required', 400);
      // @domain patterns grant every address on the domain — that stays a super-admin
      // decision on test_mode_allow. Here: one exact email or one exact phone.
      if (entry.startsWith('@')) return err('domain_patterns_are_super_admin_only', 400);
      const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry);
      const digits = entry.replace(/[^\d]/g, '');
      const isPhone = !isEmail && digits.length >= 8 && digits.length <= 15;
      if (!isEmail && !isPhone) return err('entry_must_be_email_or_phone', 400);
      const norm = isEmail ? entry.toLowerCase() : entry;
      const st = await A.sbComms('/rest/v1/settings?id=eq.1&select=test_allowlist&limit=1', env);
      if (!st.ok) return err('db_error', 500);
      const cur = Array.isArray(st.data?.[0]?.test_allowlist) ? st.data[0].test_allowlist : [];
      if (!cur.includes(norm)) {
        const w = await A.sbComms('/rest/v1/settings?id=eq.1', env,
          { method: 'PATCH', body: JSON.stringify({ test_allowlist: [...cur, norm] }) });
        if (!w.ok) return err('db_error', 500);
      }
      G._clearSettingsCache();   // the 60s settings cache would otherwise still block the immediate resend
      return ok({ added: norm, test_allowlist: cur.includes(norm) ? cur : [...cur, norm] });
    }

    // ── M6: segments ──
    case 'saveSegment': {
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);
      const { id, name, kind, definition } = body;
      if (!name) return err('name_required', 400);
      // S268 — the server is the LAST line of defence, and it is not theoretical: the client
      // fix for the match-nobody consent leaf shipped at 12:35 IST and a browser still holding
      // the PRE-FIX bundle re-saved the broken shape over the corrected one at 13:01 IST,
      // silently returning a 4,193-person audience to 0. A static export is cached, so "we
      // deployed" never means "every open tab is fixed". Validate here, where staleness
      // cannot reach. Rejects LOUDLY rather than guessing: a consent leaf with no purpose is
      // not defaultable — we cannot know what was meant — and both silent directions are
      // harmful (see PATTERN-277).
      const bad = validateSegmentDef(definition);
      if (bad) return err('invalid_definition:' + bad, 422);
      const row = { name, kind: kind || 'dynamic', definition: normalizeSegmentDef(definition) || {}, updated_at: nowIso() };
      const r = id
        ? await A.sbComms(`/rest/v1/segments?id=eq.${A.enc(id)}`, env, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
        : await A.sbComms('/rest/v1/segments', env, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, created_by: auth.userId }) });
      return r.ok ? ok(r.data?.[0]) : err('db_error:' + JSON.stringify(r.data), 500);
    }
    case 'previewSegment': {           // size + reachable-on-(channel,purpose), no materialize
      // Without this, any relay_view holder is a PII count-oracle over arbitrary segment
      // definitions (review M9) — gate it like saveSegment/materializeSegment.
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);
      const { definition, channel, purpose } = body;
      const r = await A.sbComms('/rest/v1/rpc/preview_segment', env, {
        method: 'POST', body: JSON.stringify({ p_def: definition || {}, p_channel: channel || 'email', p_purpose: purpose || 'marketing' }),
      });
      if (!r.ok) return err('eval_error:' + JSON.stringify(r.data), 500);
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      // Eye-ball sample (S232): a few matching profiles alongside the counts, best-effort —
      // a sample failure must never break the counts the builder already relies on. Same
      // segment_manage gate; same PII class the Contacts page already exposes.
      let sample = [];
      if (body.sample !== false) {
        const s = await A.sbComms('/rest/v1/rpc/preview_segment_sample', env, {
          method: 'POST', body: JSON.stringify({ p_def: definition || {}, p_limit: Math.min(Number(body.sample_limit) || 8, 20) }),
        });
        if (s.ok && Array.isArray(s.data)) sample = s.data;
      }
      return ok({ ...(row || {}), sample });
    }
    // Audience size for a campaign's segment WITH its exclusion rules applied (S276).
    // Returns {total, reachable, excluded, sendable} from comms.campaign_reach — the same
    // predicate the fan-out uses, so the builder's number and the send agree.
    // ⚠️ Read-only by design: it does NOT materialize. This runs on every edit in the campaign
    // form, and materialize_segment on a 25k segment is real work no keystroke should pay for
    // (same reasoning as the pre-flight check's audience estimate). The authoritative counts
    // are taken at submit/send, where reachableCount DOES materialize first.
    case 'campaignReach': {
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);   // count-oracle, same gate as previewSegment
      if (!body.segment_id) return err('segment_id_required', 400);
      const hrs = Number(body.exclude_contacted_hours);
      const r = await A.sbComms('/rest/v1/rpc/campaign_reach', env, {
        method: 'POST',
        body: JSON.stringify({
          p_segment_id: body.segment_id,
          p_channel: body.channel || 'email',
          p_purpose: body.purpose || 'marketing',
          p_exclude_segments: Array.isArray(body.exclude_segment_ids) ? body.exclude_segment_ids : [],
          p_exclude_campaigns: Array.isArray(body.exclude_campaign_ids) ? body.exclude_campaign_ids : [],
          p_exclude_contacted_hours: Number.isFinite(hrs) && hrs > 0 ? Math.round(hrs) : null,
        }),
      });
      if (!r.ok) return err('reach_error:' + JSON.stringify(r.data), 500);
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return ok(row || { total: 0, reachable: 0, excluded: 0, sendable: 0 });
    }
    case 'materializeSegment': {
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);
      const r = await A.sbComms('/rest/v1/rpc/materialize_segment', env, { method: 'POST', body: JSON.stringify({ p_segment_id: body.id }) });
      return r.ok ? ok({ members: r.data }) : err('db_error', 500);
    }
    // Static-segment membership (S263). `kind='static'` has existed since M6 with nothing
    // able to fill it — materialize_segment no-ops on static by design, so a static segment
    // was creatable and permanently empty (Pruthvi 2026-08-05).
    case 'addSegmentMembers': {
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);
      const { id, values } = body;
      if (!id) return err('id_required', 400);
      const list = Array.isArray(values) ? values
        : String(values || '').split(/[\n,;]+/);                 // paste: newline / comma / semicolon
      const clean = list.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 5000);
      if (clean.length === 0) return err('no_values', 400);
      const r = await A.sbComms('/rest/v1/rpc/add_static_segment_members', env, {
        method: 'POST', body: JSON.stringify({ p_segment_id: id, p_values: clean }),
      });
      if (!r.ok) return err('db_error:' + JSON.stringify(r.data), 500);
      if (r.data?.error) return err(r.data.error, 400);          // not_static / segment_not_found
      return ok(r.data);
    }
    case 'removeSegmentMember': {
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);
      const { id, profile_id } = body;
      if (!id || !profile_id) return err('id_and_profile_id_required', 400);
      const r = await A.sbComms('/rest/v1/rpc/remove_static_segment_member', env, {
        method: 'POST', body: JSON.stringify({ p_segment_id: id, p_profile_id: profile_id }),
      });
      if (!r.ok) return err('db_error:' + JSON.stringify(r.data), 500);
      if (r.data?.error) return err(r.data.error, 400);
      return ok(r.data);
    }

    // ── M6: campaigns + approval lifecycle ──
    case 'saveCampaign': {
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const { id, name, channel, purpose, segment_id, template_id, vars, scheduled_at, utm,
        exclude_segment_ids, exclude_campaign_ids, exclude_contacted_hours, allow_partial } = body;
      if (!name) return err('name_required', 400);
      // Audience exclusions (S276). Coerced server-side: a non-array becomes [], blanks are
      // dropped, and the hours field is NULL unless it is a positive number — a 0 or a stray ''
      // must read as "rule off", never as "exclude anyone contacted in the last 0 hours".
      const uuidList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
      const hrs = Number(exclude_contacted_hours);
      const row = { name, channel: channel || 'email', purpose: purpose || 'marketing',
        segment_id: segment_id || null, template_id: template_id || null, vars: vars || {},
        exclude_segment_ids: uuidList(exclude_segment_ids),
        // A campaign must never exclude ITSELF — self-exclusion would make its own in-flight
        // 'queued' rows disqualify the rest of its audience and stall the fan-out at page 1.
        exclude_campaign_ids: uuidList(exclude_campaign_ids).filter((c) => c !== id),
        exclude_contacted_hours: Number.isFinite(hrs) && hrs > 0 ? Math.round(hrs) : null,
        // Normalized server-side by the same helper the send path uses: blanks dropped (blank
        // means inherit), non-utm_ keys discarded, all-blank collapsed to NULL.
        utm: J.sanitizeUtm(utm),
        // The operator's "send even if it cannot finish" decision, made at schedule time because
        // the cron cannot be asked one. Strict === true so an absent or junk value is never read
        // as consent to a partial send — the guards must keep their teeth by default.
        allow_partial: allow_partial === true,
        scheduled_at: scheduled_at || null, updated_at: nowIso() };
      // Setting a schedule ARMS the cron to send with no further human action — that is
      // activation, and requires send_activate (review H7: build → schedule → auto-approve →
      // cron = customer sends on campaign_build alone).
      if (row.scheduled_at && !A.canActivate(auth.permissions))
        return err('send_activate_required_to_schedule', 403);
      const r = id
        ? await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(id)}&status=eq.draft`, env,
            { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
        : await A.sbComms('/rest/v1/campaigns', env, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, status: 'draft', created_by: auth.userId }) });
      if (id && r.ok && Array.isArray(r.data) && r.data.length === 0)
        return err('not_editable_after_submit', 400);   // post-draft campaigns are immutable via save
      return r.ok ? ok(r.data?.[0]) : err('db_error:' + JSON.stringify(r.data), 500);
    }
    // Send the campaign's template to a few named addresses — no segment, no approval, no
    // fan-out. Recorded under source 'campaign_test:<id>' so it never lands in the campaign's
    // own stats, and it runs through the SAME send gate as a real broadcast (test_mode,
    // suppression, consent, quiet hours, freq cap) so the rehearsal is honest.
    case 'sendCampaignTest': {
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const r = await CAMP.sendCampaignTest(env, { id: body.id, to: body.to, draft: body.draft, variantId: body.variantId });
      return r.ok ? ok(r) : err(r.error, 400);
    }
    case 'submitCampaign': {           // draft → approved (auto) or pending_approval (threshold)
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const camp = await CAMP.getCampaign(env, body.id);
      if (!camp) return err('not_found', 404);
      if (!camp.segment_id || !camp.template_id) return err('segment_and_template_required', 400);
      // `sendable` = reachable MINUS the campaign's exclusion rules (S276) — the number that
      // will actually receive a message. The approval threshold and the snapshot are both
      // judged on it, so an approver is never shown an audience the send cannot produce.
      const { reachable, excluded, sendable } = await CAMP.reachableCount(env, camp);
      const mustApprove = await CAMP.needsApproval(env, camp, sendable);
      await CAMP.setStatus(env, body.id, { status: mustApprove ? 'pending_approval' : 'approved', audience_snapshot: sendable });
      return ok({ status: mustApprove ? 'pending_approval' : 'approved', reachable, excluded, sendable });
    }
    case 'approveCampaign': {
      if (!A.canApprove(auth.permissions)) return err('forbidden', 403);
      const camp = await CAMP.getCampaign(env, body.id);
      if (!camp || camp.status !== 'pending_approval') return err('not_pending', 400);
      await CAMP.setStatus(env, body.id, { status: 'approved', approved_by: auth.userId });
      return ok({ status: 'approved' });
    }
    case 'rejectCampaign': {
      if (!A.canApprove(auth.permissions)) return err('forbidden', 403);
      await CAMP.setStatus(env, body.id, { status: 'draft', reject_reason: body.reason || null });
      return ok({ status: 'draft' });
    }
    // Append the newly-eligible to a frozen roster (§9.5/§9.18). Gated HARD to non-running
    // statuses: chains walk each shard by ascending profile_id, so a row appended below a live
    // cursor is behind the sweep and would silently never be visited. Flow is top-up → resume.
    case 'applyTopup': {
      if (!A.canActivate(auth.permissions)) return err('forbidden', 403);
      if (!body.id) return err('id_required', 400);
      const camp = await CAMP.getCampaign(env, body.id);
      if (!camp) return err('not_found', 404);
      if (!camp.roster_built_at) return err('no_roster', 400);
      if (!['sent', 'stopped', 'stalled'].includes(camp.status))
        return err('topup_only_when_not_running', 400);
      // Approval re-check against the total the roster is about to become. A human-approved
      // campaign stands (same semantic as everywhere else); an auto-approved one that a top-up
      // would push over the threshold is refused rather than silently widened.
      const pv = await A.sbComms('/rest/v1/rpc/campaign_topup_preview', env,
        { method: 'POST', body: JSON.stringify({ p_campaign_id: body.id }) });
      if (!pv.ok) return err('topup_preview_failed', 500);
      const addable = Number(pv.data || 0);
      if (addable === 0) return ok({ added: 0, roster_size: Number(camp.roster_size || 0) });
      if (!camp.approved_by && await CAMP.needsApproval(env, camp, Number(camp.roster_size || 0) + addable))
        return err('topup_needs_approval', 400, { addable, wouldTotal: Number(camp.roster_size || 0) + addable });
      const r = await A.sbComms('/rest/v1/rpc/campaign_topup_apply', env,
        { method: 'POST', body: JSON.stringify({ p_campaign_id: body.id }) });
      if (!r.ok) return err('topup_apply_failed', 500);
      const fresh = await CAMP.getCampaign(env, body.id);
      return ok({ added: Number(r.data || 0), roster_size: Number(fresh?.roster_size || 0) });
    }
    case 'sendCampaign': {             // approved → sending (queued fan-out)
      if (!A.canActivate(auth.permissions)) return err('forbidden', 403);
      // `allowPartial` is the deliberate override for an audience larger than today's remaining
      // budget. The refusal below carries the numbers so the app can state them and offer it —
      // an error the user cannot act on is one they will route around.
      const r = await CAMP.startCampaign(env, body.id, auth.userId, { allowPartial: body.allowPartial === true });
      if (r.ok) return ok(r);
      if (r.error === 'audience_exceeds_budget')
        return err('audience_exceeds_budget', 400,
          { sendable: r.sendable, remaining: r.remaining, budget: r.budget, used: r.used });
      if (r.error === 'wont_finish_before_quiet_hours')
        return err('wont_finish_before_quiet_hours', 400,
          { sendable: r.sendable, needMinutes: r.needMinutes, minutesUntilQuiet: r.minutesUntilQuiet,
            reachableBeforeQuiet: r.reachableBeforeQuiet, throughputPerHour: r.throughputPerHour });
      return err(r.error, 400);
    }
    // EMERGENCY STOP for a broadcast already fanning out (S282). The mechanism always existed —
    // processQueueMessage re-reads the campaign at the top of EVERY page and returns early on any
    // status other than 'sending' — but nothing could set that status, so halting a live send
    // meant a hand-written DB PATCH. On 2026-08-14 a real campaign needed intervention and there
    // was no door; this is that door.
    //
    // Takes effect within ONE page (~15s at 5-concurrent), not instantly: the page in flight
    // finishes its recipients. That is deliberate — killing mid-page would strand messages
    // between the dedup reserve and the provider call, which is the one state send.js cannot
    // reason about later.
    //
    // Gated on canActivate, the same permission as starting a send: whoever can fire a broadcast
    // can stop one. Do NOT loosen this to canBuild on "emergencies should be open" grounds
    // without also handling resume — see the note in campaigns.js startCampaign.
    case 'stopCampaign': {
      if (!A.canActivate(auth.permissions)) return err('forbidden', 403);
      if (!body.id) return err('id_required', 400);
      // Conditional on status=eq.sending, so this is atomic against the fan-out and against a
      // second person pressing Stop: an empty representation means it was not sending.
      // Widened to building_roster (roster §9.16): a stop mid-build leaves build_cursor set and
      // roster_built_at NULL, so a later Send resumes the BUILD from the cursor, not the send.
      const r = await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(body.id)}&status=in.(sending,building_roster)`, env,
        { method: 'PATCH', body: JSON.stringify({ status: 'stopped', updated_at: nowIso() }) });
      if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return err('not_stoppable', 400);
      // Stopping a live customer send is exactly the class of event the alert channel exists for.
      await AL.alert(env, `🛑 *Relay — broadcast STOPPED*\n"${r.data[0]?.name || body.id}" was stopped mid-fan-out. The page in flight finishes; nothing further is queued. Press "Send now" to resume — already-sent recipients are deduped.`)
        .catch(() => { /* never let a failed alert turn a successful stop into an error */ });
      return ok({ status: 'stopped' });
    }
    case 'cancelSchedule': {           // clear a pending schedule (M9); leaves the campaign approved
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      if (!body.id) return err('id_required', 400);
      const r = await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(body.id)}&status=in.(approved,scheduled)`, env,
        { method: 'PATCH', body: JSON.stringify({ scheduled_at: null, status: 'approved', updated_at: nowIso() }) });
      if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return err('not_cancellable', 400);
      return ok({ status: 'approved' });
    }

    // ── M7: journeys ──
    case 'saveJourney': {
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      // H8 bypass: saveJourney's `status` field round-trips the journey's CURRENT status on
      // every edit (the UI resends status:'active' when a builder edits an already-active
      // journey's steps) — a blanket "status==='active' needs send_activate" check would break
      // that. Gate the TRANSITION instead: only require send_activate when this save would
      // actually flip a non-active (or brand-new) journey INTO active. A caller with only
      // campaign_build could otherwise call saveJourney directly to activate, skipping
      // setJourneyStatus's gate entirely.
      if (body.status === 'active' && !A.canActivate(auth.permissions)) {
        const cur = body.id
          ? await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(body.id)}&select=status&limit=1`, env)
          : null;
        const curStatus = (cur?.ok && cur.data?.[0]?.status) || null;
        if (curStatus !== 'active') return err('send_activate_required_to_activate', 403);
      }
      const r = await J.saveJourney(env, body, auth.userId);
      return r.ok ? ok(r) : err(r.error, 400); }
    case 'compileJourney':
      return ok(await J.compile(env, body.definition, body));
    case 'setJourneyStatus': {
      // Activating = live customer automation → send_activate, matching what the roles UI
      // has promised all along (review H8). Drafting/pausing stays campaign_build.
      const gate = body.status === 'active' ? A.canActivate : A.canBuild;
      if (!gate(auth.permissions)) return err('forbidden', 403);
      // stop_in_flight also ENDS enrolments already running (they otherwise keep sending —
      // flipping status only closes the door). Same campaign_build gate: it can only ever
      // stop customer messages, never cause one.
      const r = await J.setJourneyStatus(env, body.id, body.status, { stopInFlight: body.stop_in_flight === true });
      return r.ok ? ok(r) : err(r.error, 400); }

    // ── M4: Shopify sync ── (PII bulk import — super-admin only)
    case 'shopifyBackfill': {
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      try {
        if (body.mode === 'full') {
          await env.BROADCAST_QUEUE.send({ kind: 'shopify_backfill', after: null });
          return ok({ started: true });
        }
        const r = await SHOP.backfillSample(env, Math.min(Number(body.limit) || 5, 50));
        return ok(r);   // sample: writes a few + returns counts so we eyeball via SQL
      } catch (e) { return err(e?.message || 'shopify_error', 400); }
    }
    case 'shopifyRegisterWebhooks': {   // idempotent — create the topics we don't yet have
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      const cb = body.callbackUrl || `${env.PUBLIC_BASE_URL || 'https://commsops.afshaan.workers.dev'}/webhooks/shopify`;
      try { return ok(await SHOP.registerWebhooks(env, cb)); }
      catch (e) { return err(e?.message || 'shopify_error', 400); }
    }
    case 'shopifyListWebhooks': {        // visibility into registered subscriptions
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      try { return ok(await SHOP.listWebhooks(env)); }
      catch (e) { return err(e?.message || 'shopify_error', 400); }
    }
    case 'shopifyAccessScopes': {        // what the app can actually do (C2P draft-order readiness)
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      try { return ok(await SHOP.accessScopes(env)); }
      catch (e) { return err(e?.message || 'shopify_error', 400); }
    }

    case 'waSubmitTemplate': {           // M14 — submit a WA template to Meta for approval
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const r = await WATPL.waSubmitTemplate(env, body);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    case 'waSyncTemplateStatus': {        // M14 — poll Meta approval status → local mirror
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const r = await WATPL.waSyncTemplateStatus(env, body);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    case 'waUploadHeaderMedia': {          // media-header templates need a Meta upload handle
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const r = await WATPL.waUploadHeaderMedia(env, body);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    case 'cashfreeMintTestLink': {        // J3 — mint a Cashfree pay-link (sandbox bring-up proof)
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      const r = await CF.createPaymentLink(env, {
        amount: body.amount, phone: body.phone, email: body.email, name: body.name,
        purpose: body.purpose || 'Relay Cashfree test link',
        linkId: body.linkId || `relay-test-${Date.now()}`,
        notes: body.notes, notifyUrl: body.notifyUrl, returnUrl: body.returnUrl,
        notifySms: !!body.notifySms, notifyEmail: !!body.notifyEmail,
      });
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }

    // ── S272: A/B testing ──
    case 'saveCampaignVariant': {      // upsert one arm {campaignId, id?, label, templateId, weight}
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const { campaignId, id, label, templateId, weight } = body;
      if (!campaignId) return err('campaignId_required', 400);
      if (!label) return err('label_required', 400);
      const camp = await CAMP.getCampaign(env, campaignId);
      if (!camp) return err('not_found', 404);

      // Variants freeze at APPROVED, not at sending. Between approved and sending an arm could
      // otherwise be added that nobody approved — the approval was granted against arm A alone,
      // so without this the A/B feature is a way around the approval gate.
      // ⚠️ 'paused' belongs here too. A paused campaign is MID-FLIGHT — some recipients have
      // been sent to and some have not — so editing its arms now would mean the two halves of
      // the same send used different definitions, which is exactly what the freeze prevents.
      // (Reachable: wa-webhooks pauses a campaign when Meta blocks a template bound to it —
      // either as campaigns.template_id or via any campaign_variants arm.)
      if (['sending', 'sent', 'paused'].includes(camp.status)) return err('campaign_already_sending', 422);
      if (camp.status === 'approved' || camp.status === 'scheduled') {
        await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(campaignId)}`, env,
          { method: 'PATCH', body: JSON.stringify({ status: 'draft', approved_by: null }) });
      }

      let sortOrder = 0;
      if (!id) {
        const existing = await A.sbComms(
          `/rest/v1/campaign_variants?campaign_id=eq.${A.enc(campaignId)}`
          + `&select=id,sort_order&order=sort_order.desc&limit=1`, env);
        const rows = (existing.ok && Array.isArray(existing.data)) ? existing.data : [];
        if (rows.length === 0) {
          // First arm B added with no arm A yet: arm A always mirrors campaigns.template_id by
          // construction, and the experiment row is created at the same moment.
          await A.sbComms('/rest/v1/campaign_variants', env, { method: 'POST',
            body: JSON.stringify({ campaign_id: campaignId, label: 'A', template_id: camp.template_id,
              weight: 50, sort_order: 0, created_by: auth.userId }) });
          await A.sbComms('/rest/v1/campaign_experiments', env, { method: 'POST',
            body: JSON.stringify({ campaign_id: campaignId }) });
          sortOrder = 1;
        } else {
          sortOrder = Number(rows[0].sort_order || 0) + 1;
        }
      }

      const row = { campaign_id: campaignId, label, template_id: templateId || null,
        weight: Number(weight) || 50, updated_at: nowIso() };
      const r = id
        ? await A.sbComms(`/rest/v1/campaign_variants?id=eq.${A.enc(id)}&campaign_id=eq.${A.enc(campaignId)}`, env,
            { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
        : await A.sbComms('/rest/v1/campaign_variants', env, { method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ ...row, sort_order: sortOrder, created_by: auth.userId }) });
      return r.ok ? ok(r.data?.[0]) : err('db_error:' + JSON.stringify(r.data), 500);
    }
    case 'deleteCampaignVariant': {    // {campaignId, id}
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const { campaignId, id } = body;
      if (!campaignId || !id) return err('campaignId_and_id_required', 400);
      const camp = await CAMP.getCampaign(env, campaignId);
      if (!camp) return err('not_found', 404);

      // Variants freeze at APPROVED, not at sending — same reasoning as saveCampaignVariant.
      // ⚠️ 'paused' belongs here too. A paused campaign is MID-FLIGHT — some recipients have
      // been sent to and some have not — so editing its arms now would mean the two halves of
      // the same send used different definitions, which is exactly what the freeze prevents.
      // (Reachable: wa-webhooks pauses a campaign when Meta blocks a template bound to it —
      // either as campaigns.template_id or via any campaign_variants arm.)
      if (['sending', 'sent', 'paused'].includes(camp.status)) return err('campaign_already_sending', 422);
      if (camp.status === 'approved' || camp.status === 'scheduled') {
        await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(campaignId)}`, env,
          { method: 'PATCH', body: JSON.stringify({ status: 'draft', approved_by: null }) });
      }

      const r = await A.sbComms(
        `/rest/v1/campaign_variants?id=eq.${A.enc(id)}&campaign_id=eq.${A.enc(campaignId)}`, env,
        { method: 'DELETE' });
      return r.ok ? ok({ deleted: true }) : err('db_error', 500);
    }
    case 'recordExperimentLearning': {  // {campaignId, learning}
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const { campaignId, learning } = body;
      if (!campaignId) return err('campaignId_required', 400);
      // The snapshot is the point. The live verdict is otherwise recomputed on every page view
      // forever, so late-arriving reads (5% land after 39h) can flip it AFTER someone wrote down
      // "B won" and acted on it — leaving the log and the live screen permanently contradicting
      // each other with no way to tell which was ever true.
      const snap = await computeVariantStats(env, campaignId);
      if (!snap) return err('db_error', 500);
      const r = await A.sbComms(`/rest/v1/campaign_experiments?campaign_id=eq.${A.enc(campaignId)}`, env,
        { method: 'PATCH', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ learning: learning || null, decided_at: nowIso(),
            decided_by: auth.userId, verdict_snapshot: snap, updated_at: nowIso() }) });
      if (!r.ok) return err('db_error:' + JSON.stringify(r.data), 500);
      if (Array.isArray(r.data) && r.data.length === 0) return err('experiment_not_found', 404);
      return ok(r.data?.[0]);
    }
    case 'saveExperimentMeta': {        // {campaignId, hypothesis?, plannedReadAt?} — setup screen
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const { campaignId, hypothesis, plannedReadAt } = body;
      if (!campaignId) return err('campaignId_required', 400);
      const patch = { updated_at: nowIso() };
      if (hypothesis !== undefined) patch.hypothesis = hypothesis || null;
      if (plannedReadAt !== undefined) patch.planned_read_at = plannedReadAt || null;
      let r = await A.sbComms(`/rest/v1/campaign_experiments?campaign_id=eq.${A.enc(campaignId)}`, env,
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      if (r.ok && Array.isArray(r.data) && r.data.length === 0) {
        // Setup screen may be used before any arm B exists (saveCampaignVariant's auto-create
        // hasn't fired yet) — upsert so the hypothesis/read-time isn't lost waiting on that.
        r = await A.sbComms('/rest/v1/campaign_experiments', env, { method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ campaign_id: campaignId, ...patch }) });
      }
      return r.ok ? ok(r.data?.[0]) : err('db_error:' + JSON.stringify(r.data), 500);
    }

    default:
      return err(`unknown_action:${body.action}`, 404);
  }
}

// ── Cron body (M9) ────────────────────────────────────────────────────────────
// 1) fire any approved/scheduled campaign whose scheduled_at is now due (the atomic
//    claim in startCampaign guards against a concurrent manual send), and
// 2) watch recent real-send outcomes for a bounce/failure spike, alerting ≤1/hour.
async function runScheduled(env) {
  // Single-flight: crons can overlap when a tick runs long. Claim via conditional PATCH on a
  // lock column; a tick that can't claim exits (the work is all sweep-shaped — next tick catches up).
  const lockCutoff = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  const claim = await A.sbComms(
    `/rest/v1/settings?id=eq.1&or=(cron_lock_at.is.null,cron_lock_at.lt.${A.enc(lockCutoff)})`, env,
    { method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ cron_lock_at: new Date().toISOString() }) });
  if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0) {
    console.log('cron_skipped_overlap');
    return;
  }

  // 0. courier lifecycle → substrate events (delivered / RTO journey triggers). PULLED from
  // public.ecom_shipments, which odoops fills from Uniware. Best-effort: never break the
  // campaign scheduler below.
  try {
    const r = await SHIPEV.emitShipmentEvents(env, ingest);
    if (r?.sent) console.log('shipment_events', JSON.stringify(r));
  } catch (e) { console.log('shipment_events_error', e?.message || String(e)); }

  // 0b. RTO stages 2+3 (return leg). Driven off the courier SCAN CODE, not `lifecycle` — the
  // return leg has three customer-visible stages but only one lifecycle value, and widening
  // that enum would break Depot, which reads the same column. Separate watermark
  // (`rto_stage_emit_from`), fail-closed when unset. Same best-effort contract as above.
  try {
    const r = await RTOEV.emitRtoStageEvents(env, ingest);
    if (r?.sent) console.log('rto_stage_events', JSON.stringify(r));
  } catch (e) { console.log('rto_stage_events_error', e?.message || String(e)); }

  // 1. due scheduled campaigns
  try {
    const due = await A.sbComms(
      `/rest/v1/campaigns?status=in.(approved,scheduled)&scheduled_at=lte.${A.enc(nowIso())}&select=id,name`, env);
    for (const c of (due.ok && Array.isArray(due.data) ? due.data : [])) {
      const r = await CAMP.startCampaign(env, c.id, 'scheduler');
      if (r.ok) await AL.alert(env, r.building
        ? `📣 *Relay — scheduled campaign fired*\n"${c.name}" → building its roster (~${r.estimated} estimated); sends start when the build completes.`
        : `📣 *Relay — scheduled campaign fired*\n"${c.name}" → ${r.audience} recipients.`);
      // ⚠️ A budget refusal must ALERT, not just log. On this path there is no human at a button
      // to read the error, so the campaign simply stays scheduled and re-refuses on every sweep —
      // trading a silent partial send for a silently absent one, which is no better. This is the
      // only start error that is both expected and actionable, so it gets a voice.
      else if (r.error === 'audience_exceeds_budget')
        await AL.alert(env, `⛔ *Relay — scheduled campaign HELD*\n"${c.name}" needs ${r.sendable} sends, `
          + `only ${r.remaining} left of today's ${r.budget}. Nothing was sent. Raise the budget, `
          + `narrow the audience, or send it manually with the partial-send override.`);
      else if (r.error === 'wont_finish_before_quiet_hours')
        await AL.alert(env, `⛔ *Relay — scheduled campaign HELD*\n"${c.name}" needs about `
          + `${Math.round(r.needMinutes / 60)}h to send ${r.sendable}, but the channel `
          + `goes quiet in ${Math.round(r.minutesUntilQuiet / 60)}h. Only ~${r.reachableBeforeQuiet} would be `
          + `reached and the rest would be dropped for good, so nothing was sent. Send it earlier `
          + `tomorrow, narrow the audience, or use the partial-send override.`);
      else if (r.error !== 'already_claimed') console.log('scheduler_start_error', c.id, r.error);
    }
  } catch (e) { console.log('scheduler_sweep_error', e?.message || String(e)); }

  // 1b. stuck broadcasts — 30 min without a heartbeat while in flight means every chain (or the
  // roster build) is dead: fan-out pages PATCH updated_at every ~30s, build chunks every few
  // seconds. Widened to building_roster (roster Task 8 verification pass — the watchdog predated
  // the build phase and would have let a lost build message sit invisible forever), and upgraded
  // from alert-EVERY-sweep to STALL-once: the DLQ path (Task 5) catches chains that die loudly;
  // this catches the ones that vanish without a DLQ row. stallCampaign is conditional on the
  // in-flight statuses, so this cannot touch a campaign that finished in the race window — and
  // once stalled, the campaign no longer matches the filter, so the alert fires exactly once.
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stuck = await A.sbComms(
      `/rest/v1/campaigns?status=in.(sending,building_roster)&updated_at=lt.${A.enc(cutoff)}&select=id,name,status,updated_at`, env);
    for (const c of (stuck.ok && Array.isArray(stuck.data) ? stuck.data : [])) {
      const stalled = await CAMP.stallCampaign(env, c.id);
      if (stalled) await AL.alert(env, `⚠️ *Relay — broadcast STALLED by the watchdog*\n"${c.name}" had no `
        + `heartbeat for 30 min while '${c.status}' — its ${c.status === 'building_roster' ? 'roster build' : 'fan-out chains'} `
        + `died without dead-lettering. Press Resume on it to continue; nothing further sends until then.`);
    }
  } catch (e) { console.log('stall_sweep_error', e?.message || String(e)); }

  // 2. deliverability spike watch (≤1 alert/hour via settings.last_alert_at)
  try { await checkDeliverabilitySpike(env); }
  catch (e) { console.log('spike_check_error', e?.message || String(e)); }

  // 2a. WA sender quality pull (hourly, self-throttled off settings.wa_quality_pulled_at).
  // The quality webhook only fires on a TRANSITION, so a rating that has not moved is never
  // reported and the Deliverability panel reads "no signal yet" forever. Best-effort, same
  // contract as every other sweep here: a Graph outage must not break the campaign scheduler.
  try {
    const q = await WAQ.pullSenderQualityIfDue(env);
    if (q && !q.skipped) console.log('wa_quality_pull', JSON.stringify(q));
  } catch (e) { console.log('wa_quality_pull_error', e?.message || String(e)); }

  // 2b. segment-entry triggers — detect who newly entered a watched segment and enrol.
  // Self-contained + never throws; a segment scan must not break the sweeps above.
  try {
    const se = await SEG.runSegmentEntry(env);
    if (se.segments) console.log('segment_entry', JSON.stringify(se));
  } catch (e) { console.log('segment_entry_error', e?.message || String(e)); }

  // 2c. journey send-health watch — every non-send IS logged as a messages row, but
  // nobody sits on /journeys, so a journey that quietly starts failing (an unresolved
  // variable after a template edit, a sender mis-pin, an adapter outage) would burn its
  // audience invisibly. This closes the "we won't even know failures are happening" gap.
  try { await checkJourneySendHealth(env); }
  catch (e) { console.log('journey_health_error', e?.message || String(e)); }

  // (J1) Lifetime cap: auto-exit enrolments older than their journey's max_duration.
  // We signal the parked instance so it ends cleanly via #park → 'expired'.
  try {
    const jr = await A.sbComms('/rest/v1/journeys?select=id,max_duration', env);
    for (const j of ((jr.ok && jr.data) || [])) {
      const ms = require('./journey-graph.js').durationToMs(j.max_duration || '30 days') || 2592000000;
      const cutoff = new Date(Date.now() - ms).toISOString();
      const er = await A.sbComms(
        `/rest/v1/enrolments?journey_id=eq.${A.enc(j.id)}&status=eq.active&enrolled_at=lt.${A.enc(cutoff)}&select=id&limit=200`, env);
      const rows = (er.ok && er.data) || [];
      for (const e of rows) {
        try {
          const inst = await env.JOURNEY_WORKFLOW.get(String(e.id));
          await inst.sendEvent({ type: 'signal', payload: { kind: 'exit', outcome: 'expired', event: '__max_duration' } });
        } catch (_) { /* not parked / already gone — the PATCH below is the backstop */ }
      }
      // BACKSTOP (2026-08-03). Signalling alone LEAKS: if the Workflow instance is gone —
      // died, never started, or was torn down — `get`/`sendEvent` throws, the catch swallows
      // it, and the row stays `active` FOREVER. This sweep then re-finds it every 5 minutes
      // and re-fails on it, so the leak is permanent and silent. Found live: one enrolment
      // active 7.8 days on a journey whose max_duration is 3 days, `current_step` null, on a
      // journey since taken to draft — nothing would ever have cleared it.
      // Safe to write unconditionally: 'expired' is exactly the outcome the signal itself
      // resolves to, so a parked instance that ends a moment later writes the same value.
      if (rows.length) {
        await A.sbComms(`/rest/v1/enrolments?id=in.(${rows.map((r) => r.id).join(',')})`, env,
          { method: 'PATCH', body: JSON.stringify({ status: 'expired', ended_at: new Date().toISOString() }) });
      }
    }
  } catch (e) { console.log('j1_maxduration_sweep_error', e?.message || String(e)); }

  // (J1) Delete expired / orphaned wait-index rows (bounded write volume).
  try {
    await A.sbComms(`/rest/v1/enrolment_waits?expires_at=lt.${A.enc(new Date().toISOString())}`, env, { method: 'DELETE' });
  } catch (e) { console.log('j1_wait_sweep_error', e?.message || String(e)); }
}

async function checkDeliverabilitySpike(env) {
  const s = await A.sbComms('/rest/v1/settings?id=eq.1&select=last_alert_at&limit=1', env);
  const last = s.ok && s.data?.[0]?.last_alert_at ? new Date(s.data[0].last_alert_at).getTime() : 0;
  if (Date.now() - last < 3600 * 1000) return;   // rate-limit: once per hour

  // last 100 REAL send outcomes (exclude skipped/suppressed/queued — those aren't deliverability)
  const r = await A.sbComms(
    '/rest/v1/messages?channel=eq.email&status=in.(sent,delivered,opened,clicked,bounced,failed)' +
    '&order=queued_at.desc&limit=100&select=status,provider_status', env);
  const rows = (r.ok && Array.isArray(r.data)) ? r.data : [];
  if (rows.length < 20) return;   // too little signal
  const complaints = rows.filter((m) => m.provider_status === 'email.complained').length;
  const failed = rows.filter((m) => m.status === 'failed' || m.status === 'bounced').length;
  const rate = failed / rows.length;
  if (rate > 0.10 || complaints > 0) {
    await AL.alert(env,
      `⚠️ *Relay — deliverability alert*\n${failed}/${rows.length} of recent email sends failed/bounced (${Math.round(rate * 100)}%)` +
      `${complaints ? `, ${complaints} spam complaint(s)` : ''}. Check /analytics.`);
    await A.sbComms('/rest/v1/settings?id=eq.1', env,
      { method: 'PATCH', body: JSON.stringify({ last_alert_at: nowIso() }) });
  }
}

// Journey send-health watch (≤1 alert/hour via settings.journey_alert_at — its own
// rate-limit column, so an email-deliverability alert can't mask a journey one).
// Two triggers, both over journey-sourced messages from the last hour:
//   1. any DEFECT-class failure — alert even at volume 1: these reasons never self-heal
//      (a template edit or config fix is required, and every enrolment hits the same wall);
//   2. failed-rate > 20% on ≥10 real attempts — catches adapter/provider trouble.
// Gate-by-design outcomes (consent, freq cap, quiet hours, test mode, suppression) are the
// system WORKING and never alert here.
const JOURNEY_DEFECT_RE = /^(unresolved_variables|template_not_found|no_sender_on_waba|no_active_sender|media_header_missing_url|no_adapter)/;
async function checkJourneySendHealth(env) {
  const s = await A.sbComms('/rest/v1/settings?id=eq.1&select=journey_alert_at&limit=1', env);
  const last = s.ok && s.data?.[0]?.journey_alert_at ? new Date(s.data[0].journey_alert_at).getTime() : 0;
  if (Date.now() - last < 3600 * 1000) return;   // rate-limit: once per hour

  const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
  const r = await A.sbComms(
    `/rest/v1/messages?source=like.${A.enc('journey:')}*&queued_at=gte.${A.enc(cutoff)}` +
    '&select=status,reason&limit=1000', env);
  const rows = (r.ok && Array.isArray(r.data)) ? r.data : [];
  if (!rows.length) return;

  const attempts = rows.filter((m) => m.status === 'sent' || m.status === 'failed');
  const failed = attempts.filter((m) => m.status === 'failed');
  const defects = failed.filter((m) => JOURNEY_DEFECT_RE.test(m.reason || ''));
  // Meta per-RECIPIENT blocks are excluded from the RATE trigger (still counted + reported).
  // MEASURED 2026-07-27 over 14 days: `131049` ("not delivered to maintain healthy ecosystem
  // engagement") runs at a FLAT 25-37%/day with no trend, spread across distinct profiles, and
  // at the same rate for BiteSpeed-imported and organically-captured contacts alike. It is
  // Meta's cap on how much marketing a given person receives ACROSS ALL BUSINESSES — not our
  // frequency cap, not our sender reputation (quality stayed GREEN), and not configurable away.
  // Leaving it in the rate meant the 20% threshold tripped essentially every day, and on
  // 2026-07-27 a genuine defect (`unresolved_variables:cart_url_suffix`) landed in the same
  // stream as two alerts of pure background noise. Defect-class still alerts at volume 1, which
  // is the signal a human can actually act on.
  const RECIPIENT_BLOCK_RE = /^wa_(131049|130472)/;
  const actionable = failed.filter((m) => !RECIPIENT_BLOCK_RE.test(m.reason || ''));
  const blocked = failed.length - actionable.length;
  const rateBase = attempts.filter((m) => !RECIPIENT_BLOCK_RE.test(m.reason || ''));
  const rateTrip = rateBase.length >= 10 && (actionable.length / rateBase.length) > 0.20;
  if (!defects.length && !rateTrip) return;

  const reasons = {};
  for (const m of failed) { const k = m.reason || 'unknown'; reasons[k] = (reasons[k] || 0) + 1; }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => `${k} ×${n}`).join(' · ');
  await AL.alert(env,
    `🚨 *Relay — journey sends failing*\n${actionable.length}/${rateBase.length} actionable journey sends failed in the last hour` +
    `${defects.length ? ` (incl. ${defects.length} defect-class — these never self-heal)` : ''}.` +
    `${blocked ? `\n_(+${blocked} Meta per-recipient blocks excluded — structural, ~30% baseline, not actionable.)_` : ''}` +
    `\nTop reasons: ${top}.\nCheck /journeys funnel + comms.messages.`);
  await A.sbComms('/rest/v1/settings?id=eq.1', env,
    { method: 'PATCH', body: JSON.stringify({ journey_alert_at: nowIso() }) });
}

export default {
  // `ctx` is used by webhook routes that must ack 200 immediately and finish the work after
  // the response (ctx.waitUntil). It was absent until 2026-08-03 — the ctx.waitUntil further
  // down lives in scheduled(), a different handler — so a fetch route calling it would have
  // been a runtime ReferenceError behind a green build (the PATTERN-226 shape). Cloudflare
  // always passes it as the third argument, so widening the signature is additive.
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    // ── The short-link host is a REDIRECT host, not an API host ─────────────────────────
    // `lottoys.in` (env.LINK_HOST) exists only to serve /r/<code>. Everything else on it —
    // most obviously someone typing the bare domain after seeing it on a box — must land
    // somewhere sensible. Without this it falls through to the JWT block below and 401s,
    // which reads as "the link is broken" to a customer holding printed packaging.
    //
    // Scoped to LINK_HOST so the API host is untouched: a bad path on commsops.workers.dev
    // must still 401/404 rather than silently redirect, or a caller's typo looks like success.
    if (env.LINK_HOST && url.hostname === env.LINK_HOST && !url.pathname.startsWith('/r/')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://legendoftoys.com', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/health' || url.pathname === '/healthz')
      return ok({ service: 'commsops', time: nowIso() });

    // ── Internal ingestion seam (M3): token-authed, NOT a user JWT. Shopify, internal
    //    events, delivery receipts (later Pitstop) POST here. Matched before the user gate.
    if (url.pathname === '/ingest' && request.method === 'POST') {
      const hdr = request.headers.get('Authorization') || '';
      const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (request.headers.get('X-Ingest-Token') || '');
      // Accept the odoops service token alongside INGEST_TOKEN. A SECOND accepted token rather
      // than a rotation: INGEST_TOKEN is also held by csops, so rotating it to admit odoops would
      // mean coordinating three workers for no security gain. Scoped to /ingest only — odoops
      // feeds the substrate; it must never be able to reach /send or /campaign/send.
      if (!tok || !((env.INGEST_TOKEN && tok === env.INGEST_TOKEN)
                 || (env.ODOOPS_INGEST_TOKEN && tok === env.ODOOPS_INGEST_TOKEN)
                 || (env.CSOPS_INGEST_TOKEN && tok === env.CSOPS_INGEST_TOKEN))) return err('unauthorised', 401);
      const body = await request.json().catch(() => ({}));
      const r = await ingest(env, body);
      return r.ok ? ok(r) : err(r.error, 400);
    }

    // Internal send gateway (M5) — token-authed service-to-service (Pitstop re-points
    // here at WhatsApp cutover). Runs the full gate; never a user JWT.
    if (url.pathname === '/send' && request.method === 'POST') {
      const hdr = request.headers.get('Authorization') || '';
      const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (request.headers.get('X-Ingest-Token') || '');
      // Accept csops's own service token alongside INGEST_TOKEN — a SECOND accepted token
      // rather than a rotation, for the same reason ODOOPS_INGEST_TOKEN exists on /ingest:
      // INGEST_TOKEN may be held by callers we cannot enumerate, so rotating it to fix one
      // caller risks silently breaking event ingestion fleet-wide.
      // WHY (2026-07-30, support-number cutover): csops sends `Bearer env.INGEST_TOKEN` on
      // every agent reply and its value had drifted from commsops', so the moment
      // WA_TRANSPORT flipped to 'relay' EVERY agent reply 401'd — inbound arrived fine, the
      // inbox simply could not answer. Same shape as the S245 failure, one layer down.
      // Deliberately NOT extended to /campaign/send below: this token belongs to the support
      // inbox and must not be able to fire a marketing broadcast.
      if (!tok || !((env.INGEST_TOKEN && tok === env.INGEST_TOKEN)
                 || (env.CSOPS_INGEST_TOKEN && tok === env.CSOPS_INGEST_TOKEN))) return err('unauthorised', 401);
      const body = await request.json().catch(() => ({}));
      // The internal gateway must never GUESS intent: an omitted purpose used to default to
      // 'marketing', silently withholding support replies behind consent/quiet-hours (review M1).
      if (!body.purpose) return err('purpose_required', 400);
      const r = await send(env, body);
      return ok(r);
    }
    // Internal campaign trigger (M6) — token-authed; the seam a scheduler/automation
    // uses to fire an approved campaign's fan-out (same entry as the user sendCampaign).
    if (url.pathname === '/campaign/send' && request.method === 'POST') {
      const hdr = request.headers.get('Authorization') || '';
      const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (request.headers.get('X-Ingest-Token') || '');
      if (!env.INGEST_TOKEN || tok !== env.INGEST_TOKEN) return err('unauthorised', 401);
      const body = await request.json().catch(() => ({}));
      const r = await CAMP.startCampaign(env, body.campaignId, 'automation');
      return r.ok ? ok(r) : err(r.error, 400);
    }

    // Internal one-off: seed the last_order_at backfill (winback prerequisite). Token-gated
    // (INGEST_TOKEN), public so it's triggerable without a Google-login JWT — mirrors
    // /internal/wa-templates. Only seeds the queue; the pull runs in the queue consumer.
    if (url.pathname === '/internal/backfill-last-order' && request.method === 'POST') {
      const hdr = request.headers.get('Authorization') || '';
      const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (request.headers.get('X-Ingest-Token') || '');
      // Accept INGEST_TOKEN or WA_SYNC_TOKEN — both are internal service secrets; either
      // authorises this one-off admin backfill trigger.
      const okTok = tok && ((env.INGEST_TOKEN && tok === env.INGEST_TOKEN) || (env.WA_SYNC_TOKEN && tok === env.WA_SYNC_TOKEN));
      if (!okTok) return err('unauthorised', 401);
      const b = await request.json().catch(() => ({}));
      if (b.mode === 'sample') {   // run ONE page inline + return counts (dry-run before the full queue walk)
        const r = await SHOP.backfillLastOrderPage(env, b.after || null);
        return ok(r);
      }
      await env.BROADCAST_QUEUE.send({ kind: 'last_order_backfill', after: null });
      return ok({ started: true });
    }

    // Public unsubscribe (M5) — one-click List-Unsubscribe target, returns HTML.
    // ── Phase-B first-party redirect. PUBLIC by nature — a customer taps this from a WhatsApp
    //    button, so it must stay ABOVE the JWT block with the other public routes.
    //
    //    Three rules, all deliberate:
    //    1. NOTHING here 404s or throws at a customer. An unknown, expired or malformed code 302s
    //       to legendoftoys.com. Someone who tapped a real link must never meet a stack trace.
    //    2. The 302 goes out FIRST; click accounting runs on ctx.waitUntil and is never awaited.
    //       A failed analytics write must not cost the customer their click. (This is the exact
    //       opposite of the MINT-side rule in send.js, and the asymmetry is the point: a failed
    //       mint means there is no working link at all, so that one fails the send.)
    //    3. Counting is filtered (HEAD / bot UA / sub-second) but redirecting never is.
    if (url.pathname.startsWith('/r/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const code = url.pathname.slice(3);
      const row = await LINKS.resolveLink(env, code).catch(() => null);
      const target = LINKS.targetFor(row);
      if (row) {
        const counted = LINKS.countsAsClick({
          method: request.method,
          ua: request.headers.get('User-Agent') || '',
          // The link is minted immediately before the adapter send, so its own created_at is the
          // send time to within a few hundred ms — close enough for a 1s prefetch window, and it
          // costs no extra subrequest on the click path. Deliberately NOT a query param: anything
          // in the URL is caller-controllable, so a prefetcher could opt itself into being counted.
          sentAt: row.created_at || null,
        });
        if (counted) {
          // Request context for the per-click row (0042). Gathered HERE because none of it survives
          // into waitUntil otherwise — `request` is not safe to touch after the response is returned.
          //
          // ⚠️ `?s=` is read as a LABEL ONLY and is whitelisted downstream. It deliberately does not
          // reach countsAsClick: everything in a URL is caller-controllable, so letting it influence
          // counting would let a prefetcher opt itself in — the same reasoning that keeps `sentAt`
          // off the query string above.
          //
          // The IP is passed for hashing and is NEVER stored; see visitorKey.
          const meta = {
            ua: request.headers.get('User-Agent') || null,
            referer: request.headers.get('Referer') || null,
            country: request.cf?.country || null,
            source: url.searchParams.get('s'),
            ip: request.headers.get('CF-Connecting-IP') || null,
          };
          ctx.waitUntil(LINKS.recordClick(env, row, meta).catch(() => {}));
        }
      }
      // 302, not 301: a permanent redirect would be cached by the handset and every later tap
      // would skip us entirely — no click recorded, and the code could never be expired.
      return new Response(null, {
        status: 302,
        headers: { Location: target, 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      });
    }
    if (url.pathname === '/unsubscribe' && request.method === 'GET') {
      const r = await handleUnsubscribe(env, url.searchParams.get('token'), url.searchParams.get('all') === '1');
      return new Response(r.html, { status: r.status, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
    }
    // RFC 8058 one-click. adapters/email.js advertises `List-Unsubscribe-Post:
    // List-Unsubscribe=One-Click` on every marketing email, so Gmail/Yahoo hit this with a
    // POST, not a GET. Without this branch that POST fell through to the JWT block below
    // and 401'd — i.e. every native one-click unsubscribe silently failed while telling the
    // customer it worked. Must stay ABOVE the JWT block with the other public routes.
    //
    // Single-channel by design (`all=false`): one-click withdraws the list the customer was
    // actually mailed, which is what the button means. The all-channel option is a
    // deliberate human choice on the confirmation page, not something to infer from a
    // headless POST.
    //
    // No HTML: RFC 8058 says the response body is never shown to a human — the mail client
    // only reads the status code. Plain text keeps that honest.
    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      const r = await handleUnsubscribe(env, url.searchParams.get('token'), false);
      return new Response(r.status === 200 ? 'unsubscribed' : 'invalid', {
        status: r.status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    // Public Resend status webhook (M5) — svix-verified if RESEND_WEBHOOK_SECRET set.
    if (url.pathname === '/webhooks/resend' && request.method === 'POST') {
      const r = await handleResendWebhook(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }
    // Public Shopify webhook (M4) — HMAC-verified (raw body) against SHOPIFY_WEBHOOK_SECRET.
    // Keeps the substrate current: customers, orders, abandoned checkouts → /ingest.
    if (url.pathname === '/webhooks/shopify' && request.method === 'POST') {
      const r = await SHOPWH.handleShopifyWebhook(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }
    // Public storefront Web Pixel (M4) — low-trust PIXEL_TOKEN, add_to_cart / checkout_started
    // only. The source of checkout_started that fires the abandoned-cart journey.
    if (url.pathname === '/pixel' && request.method === 'POST') {
      const r = await SHOPWH.handlePixel(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }
    // Public mailing-list / "notify me" signup (S232) — website launch-list forms. Same
    // publishable-token trust tier as /pixel; writes event + explicit consent + list attr.
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const r = await SUB.handleSubscribe(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }
    // WhatsApp Cloud API webhook (M14). GET = Meta subscription verify (echo hub.challenge as
    // text/plain); POST = statuses + inbound + template/quality updates (HMAC X-Hub-Signature-256).
    if (url.pathname === '/webhooks/whatsapp' && request.method === 'GET') {
      const challenge = verifyWhatsappWebhook(env, url);
      return challenge === null
        ? err('forbidden', 403)
        : new Response(challenge, { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain' } });
    }
    if (url.pathname === '/webhooks/whatsapp' && request.method === 'POST') {
      const r = await handleWhatsappWebhook(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }
    // Shopflo Abandoned Cart Webhook (S211) — the checkout layer forwards abandonment /
    // order events carrying the Shop Pass identity (phone) + cart. Token-guarded (no HMAC
    // from Shopflo); inert 503 until SHOPFLO_WEBHOOK_TOKEN set. DISCOVERY: captures raw
    // payload to comms.webhook_captures until the mapper is written off a real sample.
    if (url.pathname === '/webhooks/shopflo' && request.method === 'POST') {
      const r = await SHOPFLO.handleShopfloWebhook(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }
    // TrustSignal SMS delivery receipts. There is NO signature on these callbacks, so the
    // shared secret is a bearer token configured in TrustSignal's own "Header (JSON)" field
    // on the webhook record. Reject anything without it — an unguessable path is not auth.
    if (url.pathname === '/webhooks/trustsignal/sms' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      if (!env.TRUSTSIGNAL_WEBHOOK_TOKEN || auth !== `Bearer ${env.TRUSTSIGNAL_WEBHOOK_TOKEN}`)
        return new Response('unauthorized', { status: 401 });
      const body = await request.json().catch(() => null);
      // Respond 200 immediately and process asynchronously — these retry and reorder.
      ctx.waitUntil(handleTrustsignalSms(env, body).catch((e) =>
        console.log('ts_sms_webhook_error', TSC.redact(String(e?.message || e)))));
      return new Response('ok', { status: 200 });
    }
    // TrustSignal RCS events (Delivery_status · Fallback · Click · User_response). Same
    // unsigned-callback posture as the SMS route above: bearer token from the Sigmo webhook
    // record's "Header (JSON)" field, 200 immediately, process async (retries + reordering).
    if (url.pathname === '/webhooks/trustsignal/rcs' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      if (!env.TRUSTSIGNAL_WEBHOOK_TOKEN || auth !== `Bearer ${env.TRUSTSIGNAL_WEBHOOK_TOKEN}`)
        return new Response('unauthorized', { status: 401 });
      const body = await request.json().catch(() => null);
      ctx.waitUntil(handleTrustsignalRcs(env, body).catch((e) =>
        console.log('ts_rcs_webhook_error', TSC.redact(String(e?.message || e)))));
      return new Response('ok', { status: 200 });
    }
    // Cashfree payment-link webhook (J3 COD→prepaid). HMAC-verified (x-webhook-signature
    // over x-webhook-timestamp + raw body, keyed on CASHFREE_CLIENT_SECRET). Maps a
    // PAID/EXPIRED/CANCELLED link → /ingest → the J1 wait_response matcher. Inert 503
    // until CASHFREE_CLIENT_ID/_SECRET set; discovery-captures unmapped shapes.
    if (url.pathname === '/webhook/cashfree' && request.method === 'POST') {
      const r = await CFWH.handleCashfreeWebhook(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }
    // Internal TrustSignal SMS template catalog pull (read-only GET) — same token gate and
    // same read-only posture as the WA pull below. Exists so Relay template rows can carry the
    // EXACT DLT-registered body text: the carrier matches delivered content against the
    // registration, so body copy we invented would be rejected. No writes to TrustSignal.
    if (url.pathname === '/internal/sms-templates' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      const r = await SMSTPL.tsListTemplates(env, b);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    // Internal WA template catalog pull (read-only Graph GET) — token-gated by WA_SYNC_TOKEN
    // (set transiently for a sync, deleted after → route inert). No sends, no customer data.
    if (url.pathname === '/internal/wa-templates' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      const r = await WATPL.waListTemplates(env, b.wabaIds || [], b);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    // Internal template submit/sync — the SAME waSubmitTemplate/waSyncTemplateStatus the
    // WABA account facts — chiefly `primary_funding_id`, i.e. WHO META BILLS. Same token gate
    // and same read-only posture as the template pull above. This is the pre-flight for leaving
    // a BSP: on a BSP credit line the funding id is theirs, and it must become ours before the
    // number is registered. Run it before and after attaching a payment method — the id CHANGING
    // is the proof, and it does not depend on reading a settings screen correctly.
    if (url.pathname === '/internal/wa-account-info' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      const r = await WATPL.waAccountInfo(env, b.wabaIds || []);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    // Force a WA quality pull now, bypassing the hourly throttle. The cron covers the steady
    // state; this exists so the pull can be exercised the moment it is deployed rather than
    // waiting out a tick, and so a suspected throttling event can be checked on demand.
    if (url.pathname === '/internal/wa-quality-pull' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      const r = await WAQ.pullSenderQuality(env);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    // What WA_TOKEN can do (scopes only — never the token). Distinguishes a missing
    // whatsapp_business_messaging scope from an app that is simply not subscribed to the WABA:
    // both surface as the same (#200) on send, and only one is fixed by subscribing.
    if (url.pathname === '/internal/wa-token-scopes' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      const r = await WATPL.waTokenScopes(env);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    // Which Shopify app do OUR creds belong to, and what can it do? (Read-only.) The
    // SHOPIFY_CLIENT_ID secret was set without recording which Dev-Dashboard app it came
    // from, and the J3 write_orders release+reinstall must target that exact app — this
    // answers both the identity and the current scope grant (the post-reinstall check).
    if (url.pathname === '/internal/shopify-app-info' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      try {
        const d = await SHOP.shopifyGraphQL(env,
          `{ currentAppInstallation { app { title handle apiKey } accessScopes { handle } } }`);
        const inst = d?.currentAppInstallation || {};
        return ok({ app: inst.app || null, scopes: (inst.accessScopes || []).map((s) => s.handle).sort() });
      } catch (e) { return err(String(e?.message || e), 400); }
    }
    // Subscribe this app to ONE named WABA. State-changing: it also turns on webhook delivery
    // for that WABA, so on an inbound-carrying number it can put two systems in the same
    // conversation. Deliberately one id per call.
    // Bulk staging loader for the BiteSpeed contact/consent export (2026-07-22 cutover).
    // Pass-through to PostgREST bulk insert on the staging table — rows arrive as JSON from
    // curl'd files so no interactive session carries the payload. Table name is FIXED (no
    // caller-controlled table). Same WA_SYNC_TOKEN gate as its /internal siblings.
    if (url.pathname === '/internal/bsp-import-load' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      if (!Array.isArray(b.rows) || !b.rows.length) return err('rows_required', 400);
      const rows = b.rows.map((r) => ({
        list_name: String(r.list_name || ''), full_name: r.full_name || null,
        phone: r.phone || null, email: r.email || null,
      }));
      const w = await A.sbComms('/rest/v1/bitespeed_import_2026_07_22', env,
        { method: 'POST', body: JSON.stringify(rows) });
      return w.ok ? ok({ inserted: rows.length }) : err(`load_failed:${w.status}`, 500);
    }
    if (url.pathname === '/internal/wa-subscribe-app' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      const r = await WATPL.waSubscribeApp(env, b.wabaId);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    // Shopify webhook subscriptions — list/register, same WA_SYNC_TOKEN gate as the /internal
    // WA siblings and for the same reason: a topic registration should not be gated on an
    // interactive Google-login session. `register` is IDEMPOTENT (it skips topics already bound
    // to the callback), and neither op can send anything or touch customer data.
    // NB a scope change (e.g. adding read_fulfillments for FULFILLMENTS_*) only takes effect on a
    // token minted AFTER the app is re-released — getShopifyToken caches for ~24h, so if register
    // returns an access-denied for a new topic, redeploy to reset the module-scope cache and retry.
    if (url.pathname === '/internal/shopify-webhooks' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      const cb = b.callbackUrl || `${env.PUBLIC_BASE_URL || 'https://commsops.afshaan.workers.dev'}/webhooks/shopify`;
      try {
        if (b.op === 'register') return ok(await SHOP.registerWebhooks(env, cb));
        return ok({ callbackUrl: cb, subscriptions: await SHOP.listWebhooks(env) });
      } catch (e) { return err(e?.message || 'shopify_error', 400); }
    }
    // BSP→own-WABA number migration — the 4-call cutover flow (start/request_code/verify/register).
    // Same WA_SYNC_TOKEN bearer gate. State-changing and irreversible past `start` — see the
    // waMigrateNumber header comment. Errors preserve Meta's code/details (not just err()'s
    // plain message) because a live migration needs the full error surface to diagnose.
    if (url.pathname === '/internal/wa-migrate-number' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      const r = await WATPL.waMigrateNumber(env, b);
      return r.ok ? ok(r) : json({ ok: false, error: r.error, code: r.code, details: r.details }, 400);
    }
    // `/templates` UI calls, reachable with the WA_SYNC_TOKEN instead of a Google-login JWT so
    // a bulk authoring run isn't gated on an interactive browser session. Writes only to
    // comms.templates + Meta's template catalog; it can send nothing.
    if (url.pathname === '/internal/wa-template-op' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      // shipmentEvents: drain the courier-lifecycle → substrate emission on demand (the same
      // pass the */5 cron runs) so bring-up doesn't wait on a tick.
      const ops = { submit: WATPL.waSubmitTemplate, edit: WATPL.waEditTemplate,
                    sync: WATPL.waSyncTemplateStatus,
                    upload: WATPL.waUploadHeaderMedia,
                    shipmentEvents: (e) => SHIPEV.emitShipmentEvents(e, ingest),
                    // rtoStages: drain the RTO stage-2/3 scan-code emission on demand, so
                    // bring-up + verification don't wait on a */5 tick.
                    rtoStages: (e) => RTOEV.emitRtoStageEvents(e, ingest),
                    // Cutover pre-flight: prove the csops binding resolves. A 401 from csops's
                    // own auth is a PASS — it means the request was delivered rather than 1042'd.
                    pingCsops: async (e) => {
                      if (!e.CSOPS?.fetch) return { ok: false, error: 'csops_binding_missing' };
                      const r = await e.CSOPS.fetch(new Request('https://internal/webhooks/relay-wa', { method: 'POST' }));
                      return { ok: true, bound: true, status: r.status };
                    } };
      const fn = ops[b.op];
      if (!fn) return err('unknown_op', 400);
      const r = await fn(env, b);
      // Pass `raw`/`hint` through on failure. err() keeps only the message, which threw away
      // Meta's own error payload — and Meta's `message` is very often the bare, useless
      // "Invalid parameter" while the reason sits in error_user_msg/error_subcode. This is a
      // token-gated internal debugging route; losing the provider's error here is the whole
      // reason a template rejection takes a session to diagnose.
      return r.ok ? ok(r) : json({ ok: false, error: r.error, raw: r.raw, hint: r.hint }, 400);
    }

    const auth = await A.verifyJWT(request.headers.get('Authorization'), env);
    if (!auth) return err('unauthorised', 401);
    if (!A.canView(auth.permissions)) return err('forbidden', 403);

    try {
      // await is REQUIRED — handleGet/handlePost are async; returning the promise
      // unawaited lets a rejection escape this synchronous catch, surfacing as a bare
      // Cloudflare 1101 (no JSON body, no CORS) instead of {ok:false,error} + CORS.
      if (request.method === 'GET') return await handleGet(url, auth, env);
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return await handlePost(body, auth, env);
      }
      return err('method_not_allowed', 405);
    } catch (e) {
      return err(e?.message || 'server_error', 500);
    }
  },

  // Cron (M9) — every 5 min. Fires due scheduled campaigns + watches deliverability.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },

  // Queue consumer — dispatch by message kind (enrol vs campaign fan-out).
  // The commsops-dlq queue lands here too (max_retries exhausted) — distinguished by
  // batch.queue — where we durably record the poison message + alert instead of losing it.
  async queue(batch, env) {
    if (batch.queue === 'commsops-dlq') {
      for (const msg of batch.messages) {
        const b = msg.body || {};
        try {
          await A.sbComms('/rest/v1/queue_failures', env, { method: 'POST',
            body: JSON.stringify({ kind: b.kind || 'campaign', body: b, error: 'max_retries_exhausted' }) });
          // A dead build chunk or fan-out page STALLS its campaign visibly (roster §9.15). This
          // closes the hole the 15 Aug send fell into: the chain died and the campaign read
          // `sending` for 41 minutes with no signal anywhere. Conditional inside stallCampaign on
          // the in-flight statuses, so a campaign that finished or was stopped meanwhile is left
          // alone. `stalled` is resumable from the app — build-resume or send-resume by roster state.
          let stalledNote = '';
          if (b.campaignId && (!b.kind || b.kind === 'build_roster')) {
            const stalled = await CAMP.stallCampaign(env, b.campaignId);
            if (stalled) stalledNote = `\n⛔ Campaign "${stalled.name || b.campaignId}" is now STALLED — `
              + `a ${b.kind === 'build_roster' ? 'roster-build chunk' : 'fan-out chain'} died after all retries. `
              + `Press "Resume" on it to continue; nothing further sends until then.`;
          }
          await AL.alert(env, `🪣 *Relay — queue message dead-lettered* (kind=${b.kind || 'campaign'})\nRecorded in comms.queue_failures for review.${stalledNote}`);
        } catch (e) { console.log('dlq_write_error', e?.message || String(e)); }
        msg.ack();   // DLQ is terminal — always ack so it can't loop
      }
      return;
    }
    for (const msg of batch.messages) {
      try {
        const b = msg.body || {};
        // Routing contract lives in queue-route.js (unit-tested). An unknown kind THROWS here —
        // retry → redeliver (a mid-deploy retry lands on a current isolate) → DLQ with a
        // queue_failures row + alert. The old else-is-campaign shape ACKED unknown kinds after
        // processQueueMessage early-returned on them: silently destroyed, nothing recorded
        // anywhere. Frozen-roster spec §9.11.
        const route = QR.queueRoute(b);
        if (route === 'enrol') {
          await J.enrol(env, { journeyId: b.journeyId, profileId: b.profileId, eventId: b.eventId });
        } else if (route === 'shopify_backfill') {
          try {
            const r = await SHOP.backfillPage(env, b.after || null);   // one page; continue while more
            console.log('shopify_backfill', JSON.stringify(r));
            if (r.hasNext && r.cursor) await env.BROADCAST_QUEUE.send({ kind: 'shopify_backfill', after: r.cursor });
          } catch (e) { console.log('shopify_backfill_error', e?.message || String(e)); throw e; }
        } else if (route === 'build_roster') {
          await CAMP.processBuildChunk(env, b);   // roster Task 4 — scan-bounded chunk, self-enqueues
        } else if (route === 'last_order_backfill') {
          try {
            const r = await SHOP.backfillLastOrderPage(env, b.after || null);   // patches last_order_at only
            console.log('last_order_backfill', JSON.stringify(r));
            if (r.hasNext && r.cursor) await env.BROADCAST_QUEUE.send({ kind: 'last_order_backfill', after: r.cursor });
          } catch (e) { console.log('last_order_backfill_error', e?.message || String(e)); throw e; }
        } else {
          await CAMP.processQueueMessage(env, b);   // route === 'campaign' — POSITIVELY matched on campaignId
        }
        msg.ack();
      } catch (e) {
        msg.retry();
      }
    }
  },
};
