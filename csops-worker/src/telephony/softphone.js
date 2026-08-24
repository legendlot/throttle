// ── Exotel browser softphone (Phase 6, S305) ─────────────────────────────────
//
// The integrations platform (icore) is a SEPARATE surface from the Voice v1 REST API
// in exotel-client.js: its own base URL, its own credential chain, its own token.
//
//   customer Id/Secret (EXOTEL_CLIENT_ID / EXOTEL_CLIENT_SECRET — issued by Exotel
//   tech support, received 2026-08-24)
//     └─ POST /token {Entity:'customer'}  → customer token (90-day)
//          └─ POST /app                   → the ONE app {AppID, AppSecret}
//               └─ POST /token {Entity:'app'} → app token (90-day)
//                    └─ everything else: /usermapping, and the browser SDK itself
//                       (ExotelCRMWebSDK sends it as the Authorization header).
//
// The app credential pair + cached app token live in store.cs_softphone_config
// (single row, service_role-only) because a worker cannot write its own secrets —
// the same constraint that killed META_IG_TOKEN. Everything here is idempotent and
// re-runnable from Pitstop Admin → Telephony.
//
// ⚠️ The SDK's userId is the agent's EMAIL (Exotel support article: "The email ID of
// the user should be used as the user id for the app"), which is also AppUserId in
// the usermapping we create. cs_telephony_agents is the roster of record.

const ICORE = 'https://integrationscore.mum1.exotel.com/v2/integrations';

// Docs: "token generated will get expired after 90 days". Refresh with headroom so a
// token can never expire mid-shift between mint and use.
const TOKEN_TTL_MS = 85 * 24 * 60 * 60 * 1000;

async function icore(path, { method = 'GET', token = null, body = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = token;           // raw token, no Bearer — icore's shape
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${ICORE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { httpOk: res.ok, status: res.status, code: data?.Code, error: data?.Error, data: data?.Data };
}

async function mintToken(id, secret, entity) {
  const r = await icore('/token', { method: 'POST', body: { Id: id, Secret: secret, Entity: entity } });
  if (!r.httpOk || !r.data) throw new Error(`icore token mint failed (${entity}): ${r.status} ${JSON.stringify(r.error)}`);
  return String(r.data);
}

export function makeSoftphone({ env, sb, ok, err }) {
  async function getConfig() {
    const r = await sb('/rest/v1/cs_softphone_config?id=eq.1&select=*&limit=1', env);
    return r.data?.[0] || null;
  }

  async function patchConfig(patch) {
    await sb('/rest/v1/cs_softphone_config?id=eq.1', env, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
  }

  // App token, cached in the config row; minted on demand from the stored app pair.
  async function appToken(cfg) {
    if (cfg.app_token && cfg.app_token_expires_at && new Date(cfg.app_token_expires_at) > new Date()) {
      return cfg.app_token;
    }
    if (!cfg.app_id || !cfg.app_secret) throw new Error('softphone app not created yet — run Softphone Setup');
    const tok = await mintToken(cfg.app_id, cfg.app_secret, 'app');
    await patchConfig({ app_token: tok, app_token_expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString() });
    return tok;
  }

  // ── POST softphoneSetup (admin) — idempotent: app + usermappings ──────────
  // Creates the icore app if the config row has none, then upserts a usermapping per
  // active SIP agent. Per-user results are reported, never summarised away: Exotel
  // validates ExotelUserName as "FirstName LastName, both > 3 chars", so names like
  // "Sunitha B" may bounce — that is a data fix for the roster, not a retry.
  async function softphoneSetup(_body, _auth) {
    if (!env.EXOTEL_CLIENT_ID || !env.EXOTEL_CLIENT_SECRET) return err('EXOTEL_CLIENT_ID / EXOTEL_CLIENT_SECRET not set on csops', 503);
    if (!env.EXOTEL_API_KEY || !env.EXOTEL_API_TOKEN) return err('EXOTEL_API_KEY / EXOTEL_API_TOKEN not set on csops', 503);

    let cfg = await getConfig();
    if (!cfg) return err('cs_softphone_config row missing (migration not applied?)', 500);
    const summary = { app: 'existing', mappings: [] };

    // 1) Ensure the app.
    if (!cfg.app_id || !cfg.app_secret) {
      const custToken = await mintToken(env.EXOTEL_CLIENT_ID, env.EXOTEL_CLIENT_SECRET, 'customer');
      const r = await icore('/app', {
        method: 'POST', token: custToken,
        body: {
          AppName: 'Pitstop',
          ExotelAccountSid: env.EXOTEL_ACCOUNT_SID || 'legendoftoys1m',
          ExotelApiKey: env.EXOTEL_API_KEY,
          ExotelApiToken: env.EXOTEL_API_TOKEN,
          ExotelDomain: 'Mumbai',
          IsActive: true,
        },
      });
      if (!r.httpOk || !r.data?.AppID) return err(`app create failed: ${r.status} ${JSON.stringify(r.error)}`, 502);
      await patchConfig({ app_id: r.data.AppID, app_secret: r.data.AppSecret, app_token: null, app_token_expires_at: null });
      cfg = await getConfig();
      summary.app = 'created';
    }
    summary.app_id = cfg.app_id;

    const tok = await appToken(cfg);

    // 2) Ensure at least one app_setting EXISTS. The SDK's loadSettings() hard-fails on a
    // 404 here (its own TODO admits the setting should be optional), which left every agent
    // "Softphone offline" until this was found on 2026-08-24 — the missing setting was the
    // whole Phase 6 launch bug. record=true also matches Phase 3's recording player.
    const setGet = await icore('/app_setting', { token: tok });
    if (setGet.status === 404) {
      const setPost = await icore('/app_setting', { method: 'POST', token: tok, body: { Key: 'record', Value: 'true' } });
      summary.app_setting = setPost.httpOk ? 'created (record=true)' : `create failed: ${setPost.status}`;
    } else {
      summary.app_setting = 'existing';
    }

    // 3) Roster → usermappings. AppUserId = email (the SDK userId).
    const agentsRes = await sb('/rest/v1/cs_telephony_agents?is_active=eq.true&sip_id=not.is.null&select=user_id,sip_id,agent_phone', env);
    const agents = agentsRes.data || [];
    const ids = agents.map((a) => `"${a.user_id}"`).join(',');
    const profRes = ids ? await sb(`/rest/v1/users_profile?id=in.(${ids})&select=id,full_name`, env) : { data: [] };
    const names = Object.fromEntries((profRes.data || []).map((p) => [p.id, p.full_name]));

    for (const a of agents) {
      // Sequential by design: N ≤ 6, and per-user attribution of vendor errors matters
      // more here than the milliseconds a Promise.all would save.
      const email = await resolveEmail(a.user_id);
      if (!email) { summary.mappings.push({ user_id: a.user_id, ok: false, error: 'no auth email' }); continue; }
      const name = names[a.user_id] || email.split('@')[0];
      const existing = await icore(`/usermapping?user_id=${encodeURIComponent(email)}`, { token: tok });
      if (existing.httpOk && existing.data) { summary.mappings.push({ email, ok: true, existing: true }); continue; }
      const r = await icore('/usermapping', {
        method: 'POST', token: tok,
        body: [{
          AppUserId: email,
          AppUsername: name,
          Email: email,
          ExotelAccountSid: env.EXOTEL_ACCOUNT_SID || 'legendoftoys1m',
          ExotelUserName: name,
          AgentNumber: a.agent_phone || undefined,
          VirtualNumber: cfg.exophone,
        }],
      });
      summary.mappings.push({ email, ok: !!r.httpOk, ...(r.httpOk ? {} : { error: `${r.status} ${JSON.stringify(r.error)}` }) });
    }

    await patchConfig({ last_setup_at: new Date().toISOString(), last_setup_summary: summary });
    return ok(summary);
  }

  async function resolveEmail(userId) {
    // GoTrue admin lookup — same route resolveAgentByEmail uses, in reverse.
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    return u?.email || null;
  }

  // ── GET getSoftphoneToken — the browser CallBar's bootstrap ───────────────
  // Returns {token, user_id} for the SDK, or a 404/409 the UI reads as "no softphone
  // for this user" (tel-preference agents and non-CS users render nothing).
  async function getSoftphoneToken(_params, auth) {
    const aRes = await sb(`/rest/v1/cs_telephony_agents?user_id=eq.${auth.userId}&is_active=eq.true&select=sip_id,device_preference`, env);
    const agent = aRes.data?.[0];
    if (!agent || !agent.sip_id || agent.device_preference !== 'sip') return err('no softphone for this user', 404);
    const cfg = await getConfig();
    if (!cfg?.app_id) return err('softphone not set up yet', 409);
    const email = await resolveEmail(auth.userId);
    if (!email) return err('no auth email', 500);
    const tok = await appToken(cfg);
    return ok({ token: tok, user_id: email, exophone: cfg.exophone });
  }

  return { softphoneSetup, getSoftphoneToken };
}
