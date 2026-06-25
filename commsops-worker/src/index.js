const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const { recordConsent } = require('./consent.js');
const { send } = require('./send.js');
const { handleResendWebhook, handleUnsubscribe } = require('./webhooks.js');

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
    case 'getUserRoles': {             // assigned relay roles (M2)
      if (!A.canAdmin(auth.permissions)) return err('forbidden', 403);
      const r = await A.sbStore('/rest/v1/relayops_user_roles?select=*&order=assigned_at.desc', env);
      return r.ok ? ok(r.data) : err('db_error', 500);
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
      const { user_id, role_key, active } = body;
      if (!user_id || !role_key) return err('user_id_and_role_key_required', 400);
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
        'quiet_hours_end', 'attribution_window_days'];
      const patch = { updated_at: nowIso() };
      for (const k of allowed) if (k in body) patch[k] = body[k];
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

    case 'saveTemplate': {             // M5 — editing an active template publishes a new version
      if (!A.canTemplate(auth.permissions)) return err('forbidden', 403);
      const { id, channel, name, purpose, language, content, variables, status } = body;
      if (!name) return err('name_required', 400);
      if (id) {
        const cur = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}&select=version&limit=1`, env);
        const v = (cur.ok && Number(cur.data?.[0]?.version)) || 1;
        const r = await A.sbComms(`/rest/v1/templates?id=eq.${A.enc(id)}`, env, {
          method: 'PATCH', body: JSON.stringify({
            channel, name, purpose, language: language || 'en', content: content || {},
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

    // M6: campaigns · M7: journeys — wired per milestone
    default:
      return err(`unknown_action:${body.action}`, 404);
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
      if (!env.INGEST_TOKEN || tok !== env.INGEST_TOKEN) return err('unauthorised', 401);
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
      const r = await send(env, body);
      return ok(r);
    }

    // Public unsubscribe (M5) — one-click List-Unsubscribe target, returns HTML.
    if (url.pathname === '/unsubscribe' && request.method === 'GET') {
      const r = await handleUnsubscribe(env, url.searchParams.get('token'));
      return new Response(r.html, { status: r.status, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
    }
    // Public Resend status webhook (M5) — svix-verified if RESEND_WEBHOOK_SECRET set.
    if (url.pathname === '/webhooks/resend' && request.method === 'POST') {
      const r = await handleResendWebhook(env, request);
      return r.ok ? ok(r) : err(r.error, r.status || 400);
    }
    // Other public endpoints in later milestones: /webhooks/shopify (M4).

    const auth = await A.verifyJWT(request.headers.get('Authorization'), env);
    if (!auth) return err('unauthorised', 401);
    if (!A.canView(auth.permissions)) return err('forbidden', 403);

    try {
      if (request.method === 'GET') return handleGet(url, auth, env);
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return handlePost(body, auth, env);
      }
      return err('method_not_allowed', 405);
    } catch (e) {
      return err(e?.message || 'server_error', 500);
    }
  },
};
