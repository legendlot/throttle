const A = require('./auth.js');
// Workflow class must be a named export of the entry module (wrangler class_name).
export { JourneyWorkflow } from './journey-workflow.js';
const { ingest } = require('./ingest.js');
const { recordConsent } = require('./consent.js');
const { send } = require('./send.js');
const { handleResendWebhook, handleUnsubscribe } = require('./webhooks.js');
const { handleWhatsappWebhook, verifyWhatsappWebhook } = require('./wa-webhooks.js');
const WATPL = require('./wa-templates.js');
const SEG = require('./segment-entry.js');
const CAMP = require('./campaigns.js');
const J = require('./journeys.js');
const SHOP = require('./shopify.js');
const SHOPWH = require('./shopify-webhooks.js');
const SHOPFLO = require('./shopflo-webhooks.js');
const CF = require('./cashfree.js');
const CFWH = require('./cashfree-webhooks.js');
const AL = require('./alerts.js');
const EA = require('./email-assets.js');
const OPTOUT = require('./optout.js');
const SHIPEV = require('./shipment-events.js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ok  = (data) => json({ ok: true, data });
const err = (msg, status = 400) => json({ ok: false, error: msg }, status);
const nowIso = () => new Date().toISOString();
const enc2 = (p) => String(p).split('/').map(encodeURIComponent).join('/');

// ── GET actions ──────────────────────────────────────────────────────────────
async function handleGet(url, auth, env) {
  const action = url.searchParams.get('action');
  switch (action) {
    case 'getMe':
      return ok({ userId: auth.userId, email: auth.email, fullName: auth.fullName,
                  relayRole: auth.relayRole, permissions: auth.permissions });

    case 'getRoles': {                 // role builder — list (M2)
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
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
    case 'getSenderIdentities': {
      const r = await A.sbComms('/rest/v1/sender_identities?select=*&order=channel.asc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    case 'getProfiles': {              // contacts list (M3)
      const limit = url.searchParams.get('limit') || '100';
      const r = await A.sbComms(
        `/rest/v1/profiles?select=id,display_name,locale,city,attributes,created_at` +
        `&order=created_at.desc&limit=${A.enc(limit)}`, env);
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

    case 'getTemplates': {             // M5
      const r = await A.sbComms('/rest/v1/templates?select=*&order=updated_at.desc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    case 'getEventDefinitions': {      // the registry that backs the journey trigger picker
      const r = await A.sbComms(
        '/rest/v1/event_definitions?is_active=is.true&select=name,description&order=name.asc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }

    case 'getSegments': {              // M6
      const r = await A.sbComms('/rest/v1/segments?select=*&order=updated_at.desc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getSegment': {
      const id = url.searchParams.get('id'); if (!id) return err('id_required', 400);
      const [s, mc] = await Promise.all([
        A.sbComms(`/rest/v1/segments?id=eq.${A.enc(id)}&select=*&limit=1`, env),
        A.sbComms(`/rest/v1/segment_members?segment_id=eq.${A.enc(id)}&select=profile_id`, env),
      ]);
      return ok({ segment: s.data?.[0] || null, member_count: Array.isArray(mc.data) ? mc.data.length : 0 });
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
      const days = Number(url.searchParams.get('days')) || 30;
      const r = await A.sbComms('/rest/v1/rpc/sends_overview', env,
        { method: 'POST', body: JSON.stringify({ p_days: days }) });
      return r.ok ? ok(r.data) : err('db_error', 500);
    }
    case 'getDeliverabilityHealth': {
      const days = Number(url.searchParams.get('days')) || 30;
      const r = await A.sbComms('/rest/v1/rpc/deliverability_health', env,
        { method: 'POST', body: JSON.stringify({ p_days: days }) });
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
    default:
      return err(`unknown_action:${action}`, 404);
  }
}

// ── POST actions ─────────────────────────────────────────────────────────────
async function handlePost(body, auth, env) {
  switch (body.action) {
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
    case 'saveRelaySettings': {        // approval thresholds, freq caps, quiet hours (M2)
      if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
      const allowed = ['approval_required_marketing', 'approval_audience_threshold',
        'frequency_cap_per_day', 'frequency_cap_window_hours', 'quiet_hours_start',
        'quiet_hours_end', 'attribution_window_days', 'test_mode', 'test_mode_allow',
        'daily_send_budget'];
      const patch = { updated_at: nowIso() };
      for (const k of allowed) if (k in body) patch[k] = body[k];
      // Disabling test mode = unlocking real-customer sends. Make it a deliberate,
      // explicit act: only when the caller affirms it AND only ever to a boolean.
      if ('test_mode' in patch) patch.test_mode = (patch.test_mode === true);
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
      const { id, channel, name, purpose, language, content, variables, status } = body;
      if (!name) return err('name_required', 400);
      if (id) {
        const cur = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}&select=version,content&limit=1`, env);
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
        const r = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}`, env, {
          method: 'PATCH', body: JSON.stringify({
            channel, name, purpose, language: language || 'en', content: mergedContent,
            variables: variables || [], status: status || 'active', version: v + 1, updated_at: nowIso(),
          }),
        });
        return r.ok ? ok(r.data?.[0]) : err('db_error', 500);
      }
      const r = await A.sbComms('/rest/v1/templates', env, {
        method: 'POST', body: JSON.stringify({
          channel: channel || 'email', name, purpose: purpose || 'marketing',
          language: language || 'en', content: content || {}, variables: variables || [],
          status: status || 'active', created_by: auth.userId,
        }),
      });
      return r.ok ? ok(r.data?.[0]) : err('db_error:' + JSON.stringify(r.data), 500);
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

    case 'sendTest': {                 // M5 — test-send: always allowed, no approval; transactional bypasses marketing gate
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      if (!body.to) return err('to_required', 400);
      const r = await send(env, {
        channel: body.channel || 'email', purpose: 'transactional',
        to: body.to, templateId: body.templateId || null, template: body.template || null,
        profileId: body.profileId || null, constants: body.constants || {},
        recipient: body.recipient || {}, source: 'test',
      });
      return ok(r);
    }

    // ── M6: segments ──
    case 'saveSegment': {
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);
      const { id, name, kind, definition } = body;
      if (!name) return err('name_required', 400);
      const row = { name, kind: kind || 'dynamic', definition: definition || {}, updated_at: nowIso() };
      const r = id
        ? await A.sbComms(`/rest/v1/segments?id=eq.${A.enc(id)}`, env, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
        : await A.sbComms('/rest/v1/segments', env, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, created_by: auth.userId }) });
      return r.ok ? ok(r.data?.[0]) : err('db_error:' + JSON.stringify(r.data), 500);
    }
    case 'previewSegment': {           // size + reachable-on-(channel,purpose), no materialize
      const { definition, channel, purpose } = body;
      const r = await A.sbComms('/rest/v1/rpc/preview_segment', env, {
        method: 'POST', body: JSON.stringify({ p_def: definition || {}, p_channel: channel || 'email', p_purpose: purpose || 'marketing' }),
      });
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return r.ok ? ok(row) : err('eval_error:' + JSON.stringify(r.data), 500);
    }
    case 'materializeSegment': {
      if (!A.canSegment(auth.permissions)) return err('forbidden', 403);
      const r = await A.sbComms('/rest/v1/rpc/materialize_segment', env, { method: 'POST', body: JSON.stringify({ p_segment_id: body.id }) });
      return r.ok ? ok({ members: r.data }) : err('db_error', 500);
    }

    // ── M6: campaigns + approval lifecycle ──
    case 'saveCampaign': {
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const { id, name, channel, purpose, segment_id, template_id, vars, scheduled_at } = body;
      if (!name) return err('name_required', 400);
      const row = { name, channel: channel || 'email', purpose: purpose || 'marketing',
        segment_id: segment_id || null, template_id: template_id || null, vars: vars || {},
        scheduled_at: scheduled_at || null, updated_at: nowIso() };
      const r = id
        ? await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(id)}`, env, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
        : await A.sbComms('/rest/v1/campaigns', env, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, status: 'draft', created_by: auth.userId }) });
      return r.ok ? ok(r.data?.[0]) : err('db_error:' + JSON.stringify(r.data), 500);
    }
    // Send the campaign's template to a few named addresses — no segment, no approval, no
    // fan-out. Recorded under source 'campaign_test:<id>' so it never lands in the campaign's
    // own stats, and it runs through the SAME send gate as a real broadcast (test_mode,
    // suppression, consent, quiet hours, freq cap) so the rehearsal is honest.
    case 'sendCampaignTest': {
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const r = await CAMP.sendCampaignTest(env, { id: body.id, to: body.to, draft: body.draft });
      return r.ok ? ok(r) : err(r.error, 400);
    }
    case 'submitCampaign': {           // draft → approved (auto) or pending_approval (threshold)
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const camp = await CAMP.getCampaign(env, body.id);
      if (!camp) return err('not_found', 404);
      if (!camp.segment_id || !camp.template_id) return err('segment_and_template_required', 400);
      const { reachable } = await CAMP.reachableCount(env, camp.segment_id, camp.channel, camp.purpose);
      const mustApprove = await CAMP.needsApproval(env, camp, reachable);
      await CAMP.setStatus(env, body.id, { status: mustApprove ? 'pending_approval' : 'approved', audience_snapshot: reachable });
      return ok({ status: mustApprove ? 'pending_approval' : 'approved', reachable });
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
    case 'sendCampaign': {             // approved → sending (queued fan-out)
      if (!A.canActivate(auth.permissions)) return err('forbidden', 403);
      const r = await CAMP.startCampaign(env, body.id, auth.userId);
      return r.ok ? ok(r) : err(r.error, 400);
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
    case 'saveJourney': { if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const r = await J.saveJourney(env, body, auth.userId);
      return r.ok ? ok(r) : err(r.error, 400); }
    case 'compileJourney':
      return ok(await J.compile(env, body.definition, body));
    case 'setJourneyStatus': { if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const r = await J.setJourneyStatus(env, body.id, body.status);
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

    default:
      return err(`unknown_action:${body.action}`, 404);
  }
}

// ── Cron body (M9) ────────────────────────────────────────────────────────────
// 1) fire any approved/scheduled campaign whose scheduled_at is now due (the atomic
//    claim in startCampaign guards against a concurrent manual send), and
// 2) watch recent real-send outcomes for a bounce/failure spike, alerting ≤1/hour.
async function runScheduled(env) {
  // 0. courier lifecycle → substrate events (delivered / RTO journey triggers). PULLED from
  // public.ecom_shipments, which odoops fills from Uniware. Best-effort: never break the
  // campaign scheduler below.
  try {
    const r = await SHIPEV.emitShipmentEvents(env, ingest);
    if (r?.sent) console.log('shipment_events', JSON.stringify(r));
  } catch (e) { console.log('shipment_events_error', e?.message || String(e)); }

  // 1. due scheduled campaigns
  try {
    const due = await A.sbComms(
      `/rest/v1/campaigns?status=in.(approved,scheduled)&scheduled_at=lte.${A.enc(nowIso())}&select=id,name`, env);
    for (const c of (due.ok && Array.isArray(due.data) ? due.data : [])) {
      const r = await CAMP.startCampaign(env, c.id, 'scheduler');
      if (r.ok) await AL.alert(env, `📣 *Relay — scheduled campaign fired*\n"${c.name}" → ${r.audience} recipients.`);
      else if (r.error !== 'already_claimed') console.log('scheduler_start_error', c.id, r.error);
    }
  } catch (e) { console.log('scheduler_sweep_error', e?.message || String(e)); }

  // 1b. stalled broadcasts — a campaign stuck 'sending' for >30 min means its continuation
  // chain died (DLQ'd page / worker eviction). Alert-only: resuming needs a human decision.
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stuck = await A.sbComms(
      `/rest/v1/campaigns?status=eq.sending&updated_at=lt.${A.enc(cutoff)}&select=id,name,updated_at`, env);
    for (const c of (stuck.ok && Array.isArray(stuck.data) ? stuck.data : [])) {
      await AL.alert(env, `⚠️ *Relay — broadcast stalled*\n"${c.name}" has been 'sending' since ${c.updated_at}. Fan-out chain likely died — check comms.queue_failures.`);
    }
  } catch (e) { console.log('stall_sweep_error', e?.message || String(e)); }

  // 2. deliverability spike watch (≤1 alert/hour via settings.last_alert_at)
  try { await checkDeliverabilitySpike(env); }
  catch (e) { console.log('spike_check_error', e?.message || String(e)); }

  // 2b. segment-entry triggers — detect who newly entered a watched segment and enrol.
  // Self-contained + never throws; a segment scan must not break the sweeps above.
  try {
    const se = await SEG.runSegmentEntry(env);
    if (se.segments) console.log('segment_entry', JSON.stringify(se));
  } catch (e) { console.log('segment_entry_error', e?.message || String(e)); }

  // (J1) Lifetime cap: auto-exit enrolments older than their journey's max_duration.
  // We signal the parked instance so it ends cleanly via #park → 'expired'.
  try {
    const jr = await A.sbComms('/rest/v1/journeys?select=id,max_duration', env);
    for (const j of ((jr.ok && jr.data) || [])) {
      const ms = require('./journey-graph.js').durationToMs(j.max_duration || '30 days') || 2592000000;
      const cutoff = new Date(Date.now() - ms).toISOString();
      const er = await A.sbComms(
        `/rest/v1/enrolments?journey_id=eq.${A.enc(j.id)}&status=eq.active&enrolled_at=lt.${A.enc(cutoff)}&select=id&limit=200`, env);
      for (const e of ((er.ok && er.data) || [])) {
        try {
          const inst = await env.JOURNEY_WORKFLOW.get(String(e.id));
          await inst.sendEvent({ type: 'signal', payload: { kind: 'exit', outcome: 'expired', event: '__max_duration' } });
        } catch (_) { /* not parked / already gone */ }
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
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
                 || (env.ODOOPS_INGEST_TOKEN && tok === env.ODOOPS_INGEST_TOKEN))) return err('unauthorised', 401);
      const body = await request.json().catch(() => ({}));
      const r = await ingest(env, body);
      return r.ok ? ok(r) : err(r.error, 400);
    }

    // Internal send gateway (M5) — token-authed service-to-service (Pitstop re-points
    // here at WhatsApp cutover). Runs the full gate; never a user JWT.
    if (url.pathname === '/send' && request.method === 'POST') {
      const hdr = request.headers.get('Authorization') || '';
      const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (request.headers.get('X-Ingest-Token') || '');
      if (!env.INGEST_TOKEN || tok !== env.INGEST_TOKEN) return err('unauthorised', 401);
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
    // Cashfree payment-link webhook (J3 COD→prepaid). HMAC-verified (x-webhook-signature
    // over x-webhook-timestamp + raw body, keyed on CASHFREE_CLIENT_SECRET). Maps a
    // PAID/EXPIRED/CANCELLED link → /ingest → the J1 wait_response matcher. Inert 503
    // until CASHFREE_CLIENT_ID/_SECRET set; discovery-captures unmapped shapes.
    if (url.pathname === '/webhook/cashfree' && request.method === 'POST') {
      const r = await CFWH.handleCashfreeWebhook(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
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
    // Subscribe this app to ONE named WABA. State-changing: it also turns on webhook delivery
    // for that WABA, so on an inbound-carrying number it can put two systems in the same
    // conversation. Deliberately one id per call.
    if (url.pathname === '/internal/wa-subscribe-app' && request.method === 'POST') {
      const want = env.WA_SYNC_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      let b = {}; try { b = await request.json(); } catch {}
      const r = await WATPL.waSubscribeApp(env, b.wabaId);
      return r.ok ? ok(r) : err(r.error, 400);
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
      const ops = { submit: WATPL.waSubmitTemplate, sync: WATPL.waSyncTemplateStatus,
                    upload: WATPL.waUploadHeaderMedia,
                    shipmentEvents: (e) => SHIPEV.emitShipmentEvents(e, ingest),
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
      return r.ok ? ok(r) : err(r.error, 400);
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
          await AL.alert(env, `🪣 *Relay — queue message dead-lettered* (kind=${b.kind || 'campaign'})\nRecorded in comms.queue_failures for review.`);
        } catch (e) { console.log('dlq_write_error', e?.message || String(e)); }
        msg.ack();   // DLQ is terminal — always ack so it can't loop
      }
      return;
    }
    for (const msg of batch.messages) {
      try {
        const b = msg.body || {};
        if (b.kind === 'enrol') {
          await J.enrol(env, { journeyId: b.journeyId, profileId: b.profileId, eventId: b.eventId });
        } else if (b.kind === 'shopify_backfill') {
          try {
            const r = await SHOP.backfillPage(env, b.after || null);   // one page; continue while more
            console.log('shopify_backfill', JSON.stringify(r));
            if (r.hasNext && r.cursor) await env.BROADCAST_QUEUE.send({ kind: 'shopify_backfill', after: r.cursor });
          } catch (e) { console.log('shopify_backfill_error', e?.message || String(e)); throw e; }
        } else if (b.kind === 'last_order_backfill') {
          try {
            const r = await SHOP.backfillLastOrderPage(env, b.after || null);   // patches last_order_at only
            console.log('last_order_backfill', JSON.stringify(r));
            if (r.hasNext && r.cursor) await env.BROADCAST_QUEUE.send({ kind: 'last_order_backfill', after: r.cursor });
          } catch (e) { console.log('last_order_backfill_error', e?.message || String(e)); throw e; }
        } else {
          await CAMP.processQueueMessage(env, b);   // campaign fan-out (default, back-compat)
        }
        msg.ack();
      } catch (e) {
        msg.retry();
      }
    }
  },
};
