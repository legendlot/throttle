// lotmcp — LOT team MCP gateway. PHASE 0: sign-in shell only. The one tool, `whoami`, returns no
// business data. No data tool is added until every attack test passes live, /hostile-review +
// Codex are done, and Afshaan has seen the results (decisions §Team MCP gateway, 2026-11-09).
//
// Who gets in. Every layer is checked on the server and fails closed:
//   1. Google sign-in through LOT's own INTERNAL OAuth client (Google refuses non-Workspace
//      accounts), and the ID token's hd / email_verified / domain / nonce are checked here too.
//   2. A named grant in store.mcp_access (off by default).
//   3. users_profile.active, re-checked on EVERY call (store.mcp_gate).
//   4. A valid gateway token on every /mcp request, tools/list included (workers-oauth-provider).
//   5. /mcp, /token and /register only from Anthropic's published outbound IPs (extra layer only).
// Redirects are an exact allowlist (Claude's hosted callback). No write path exists in this worker.

import { OAuthProvider, OAuthError } from '@cloudflare/workers-oauth-provider';
import {
  parseCidrs, ipAllowed, parseList, redirectAllowed, registrationAllowed,
  decodeJwtPayload, checkGoogleClaims, gateDecision, originAllowed, hmacHex, timingSafeEqualHex, esc, refusalText, refusalResponse, RPC_REFUSED,
} from './checks.js';

const SCOPES = ['mcp:read'];
const SERVER_INFO = { name: 'lot-data', version: '0.1.0-phase0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const IP_GATED_PREFIXES = ['/mcp', '/token', '/register'];

// ---------------------------------------------------------------- Supabase (service role, store schema)
async function rpc(env, fn, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json', 'Content-Profile': 'store', 'Accept-Profile': 'store',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}`);
  return res.json();
}
async function audit(env, row) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/mcp_audit`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Content-Profile': 'store', Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) { console.error('[audit] insert failed', res.status); return false; }
    return true;
  } catch (e) { console.error('[audit] threw', e.message); return false; }
}

// ---------------------------------------------------------------- Slack (best effort, never blocks)
// The Claude Slack app has no users:read.email, so Slack IDs come from the grant row
// (store.mcp_access.slack_user_id) and ADMIN_SLACK_ID — never looked up by email.
async function slackDm(env, slackUserId, text) {
  if (!env.SLACK_BOT_TOKEN || !/^U[A-Z0-9]{6,15}$/.test(slackUserId || '')) return false;
  try {
    const m = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: slackUserId, text, unfurl_links: false, unfurl_media: false }),
    }).then(r => r.json());
    if (!m.ok) console.error('[slack] post', m.error);
    return !!m.ok;
  } catch (e) { console.error('[slack] threw', e.message); return false; }
}
// One alert per key per hour (KV is eventually consistent: a duplicate is possible, a miss is not).
async function alertOnce(env, key, text) {
  const k = `alert:${key}:${Math.floor(Date.now() / 3600000)}`;
  if (await env.OAUTH_KV.get(k)) return;
  await env.OAUTH_KV.put(k, '1', { expirationTtl: 3700 });
  await slackDm(env, env.ADMIN_SLACK_ID, text);
}
// Denied-attempt burst counter per hour; alerts Afshaan once at the threshold.
async function countDenied(env, ctx, kind, ip) {
  const k = `denied:${Math.floor(Date.now() / 3600000)}`;
  const n = Number(await env.OAUTH_KV.get(k) || 0) + 1;
  ctx.waitUntil(env.OAUTH_KV.put(k, String(n), { expirationTtl: 3700 }));
  if (n === Number(env.DENIED_ALERT_AT || 20)) {
    ctx.waitUntil(alertOnce(env, 'denied-burst', `⚠️ LOT MCP gateway: ${n} refused requests this hour (latest: ${kind} from ${ip}). Audit: store.mcp_audit.`));
  }
}

// Every secret/var the sign-in path needs. Missing any → refuse BEFORE a grant exists (fail closed).
function configMissing(env) {
  const miss = [];
  if (!env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID === 'PENDING') miss.push('GOOGLE_CLIENT_ID');
  if (!env.GOOGLE_CLIENT_SECRET) miss.push('GOOGLE_CLIENT_SECRET');
  if (!env.SUPABASE_SERVICE_KEY) miss.push('SUPABASE_SERVICE_KEY');
  if (!env.SLACK_BOT_TOKEN) miss.push('SLACK_BOT_TOKEN');
  if (!env.REVOKE_SECRET || env.REVOKE_SECRET.length < 32) miss.push('REVOKE_SECRET');
  if (!/^U[A-Z0-9]{6,15}$/.test(env.ADMIN_SLACK_ID || '')) miss.push('ADMIN_SLACK_ID');
  return miss;
}

// ---------------------------------------------------------------- HTML
function page(title, body, status = 200, headers = new Headers()) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com https://claude.ai https://claude.com; frame-ancestors 'none'");
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1a1a1a;background:#fafaf7;line-height:1.5}
.box{background:#fff;border:1px solid #ddd;border-radius:10px;padding:20px 22px}
.warn{background:#fff4e5;border:1px solid #f0b46a;border-radius:8px;padding:12px 14px;margin:14px 0}
button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#fff;cursor:pointer;margin-right:8px}
button.secondary{background:#fff;color:#1a1a1a}
code{background:#f1f1ee;padding:1px 5px;border-radius:4px}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}.box{background:#1e1e1e;border-color:#333}.warn{background:#3a2a12;border-color:#8a5a20}code{background:#2a2a2a}button.secondary{background:#1e1e1e;color:#eee;border-color:#777}}
</style></head><body><div class="box">${body}</div></body></html>`, { status, headers });
}
const refusePage = (msg, status = 403) =>
  page('Not allowed', `<h2>Not allowed</h2><p>${esc(msg)}</p><p>If you think you should have access, ask Afshaan.</p>`, status);

// ---------------------------------------------------------------- /authorize (consent → Google)
async function authorize(request, env) {
  const helpers = env.OAUTH_PROVIDER;
  const allowedRedirects = parseList(env.ALLOWED_REDIRECTS);

  const miss = configMissing(env);
  if (miss.length) { console.error('[config] missing', miss.join(',')); return refusePage('The LOT data connector is not switched on yet.', 503); }

  if (request.method === 'GET') {
    let authReq;
    try { authReq = await helpers.parseAuthRequest(request); }
    catch (e) { return refusePage('This sign-in link is not valid.', 400); }
    // PKCE S256 for EVERY client: the library only requires it for public clients.
    if (!authReq.codeChallenge || authReq.codeChallengeMethod !== 'S256') return refusePage('This sign-in link is not valid.', 400);
    if (!redirectAllowed(authReq.redirectUri, allowedRedirects)) {
      return refusePage('This sign-in link does not come from Claude.', 400);
    }
    const d = await helpers.describeConsent(authReq);
    if (d.clientDomain && !parseList(env.ALLOWED_CLIENT_DOMAINS).includes(d.clientDomain)) {
      return refusePage('This sign-in link does not come from Claude.', 400);
    }
    const tx = await helpers.beginConsent(authReq);
    return page('Connect Claude to LOT data', `
<h2>Connect a Claude account to LOT data</h2>
<p>An app calling itself <b>${esc(d.clientName)}</b>${d.clientDomain ? ` (verified domain <code>${esc(d.clientDomain)}</code>)` : ''}
wants read-only access to LOT systems as <b>you</b>. Answers go back to <code>${esc(d.redirectHost)}</code>.</p>
<div class="warn"><b>Only continue if you clicked “Connect” in your own Claude, just now.</b><br>
If someone sent you this link, press Cancel. Whoever started it would get your access.</div>
<p>You will sign in with your <b>@legendoftoys.com</b> Google account next. You and Afshaan get a Slack message for every new connection.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(tx.handle)}">
<button name="action" value="approve">I started this. Continue</button>
<button name="action" value="deny" class="secondary">Cancel</button>
</form>`, 200, tx.headers);
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    const handle = String(form.get('handle') || '');
    if (form.get('action') !== 'approve') {
      try {
        const denied = await helpers.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      } catch { return refusePage('Cancelled.', 400); }
    }
    let approved;
    try { approved = await helpers.approveConsent(request, handle, { scope: SCOPES }); }
    catch { return refusePage('This sign-in expired or was already used. Start again from Claude.', 400); }
    // Defence in depth: re-check the redirect after consent too.
    if (!redirectAllowed(approved.request.redirectUri, allowedRedirects)) return refusePage('This sign-in link does not come from Claude.', 400);
    if (!approved.request.codeChallenge || approved.request.codeChallengeMethod !== 'S256') return refusePage('This sign-in link is not valid.', 400);

    const nonce = crypto.randomUUID();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const up = await helpers.beginUpstream(approved.request, { data: { nonce, verifier }, headers: approved.headers });
    const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    g.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${env.PUBLIC_URL}/callback`, response_type: 'code',
      scope: 'openid email profile', state: up.state, nonce, hd: 'legendoftoys.com',
      prompt: 'select_account consent', code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    const h = new Headers(up.headers);
    h.set('Location', g.toString());
    return new Response(null, { status: 302, headers: h });
  }
  return new Response('Method not allowed', { status: 405 });
}
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- /callback (Google → grant)
async function callback(request, env, ctx) {
  const helpers = env.OAUTH_PROVIDER;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (configMissing(env).length) return refusePage('The LOT data connector is not switched on yet.', 503);
  let resumed;
  try { resumed = await helpers.finishUpstream(request); }
  catch { return refusePage('This sign-in expired or was already used. Start again from Claude.', 400); }
  const url = new URL(request.url);
  const deny = async (reason, email = null, userId = null) => {
    ctx.waitUntil(audit(env, { event: 'signin_denied', email, user_id: userId, ip, status: 403, detail: reason }));
    ctx.waitUntil(countDenied(env, ctx, 'signin', ip));
    return refusePage(`Sign-in refused: ${reason}.`);
  };
  if (url.searchParams.get('error')) return deny(`Google said ${url.searchParams.get('error')}`);
  const code = url.searchParams.get('code');
  if (!code) return deny('no code from Google');

  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.PUBLIC_URL}/callback`, grant_type: 'authorization_code', code_verifier: resumed.data.verifier,
    }),
  }).then(r => r.json()).catch(() => null);
  if (!tok || !tok.id_token) return deny('Google sign-in failed');

  let claims;
  try { claims = decodeJwtPayload(tok.id_token); } catch { return deny('bad Google token'); }
  const c = checkGoogleClaims(claims, { clientId: env.GOOGLE_CLIENT_ID, nonce: resumed.data.nonce, nowSec: Math.floor(Date.now() / 1000) });
  if (!c.ok) return deny(c.reason, claims && claims.email ? String(claims.email) : null);

  let gate;
  try { gate = await rpc(env, 'mcp_gate_by_email', { p_email: c.email }); }
  catch { return refusePage('LOT systems are not reachable right now. Try again shortly.', 503); }
  if (!gate) return deny('no LOT app account for this email', c.email);
  const d = gateDecision(gate);
  if (!d.ok) return deny(d.reason, c.email, gate.user_id);
  if (!gate.slack_user_id) return deny('your grant has no Slack ID, so you could not be told about this connection', c.email, gate.user_id);

  // The consent-hijack defence: the person AND Afshaan are told BEFORE the grant exists.
  // If the person's DM cannot be delivered, no connection is created.
  const revoke = await revokeUrl(env, gate.user_id);
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const told = await slackDm(env, gate.slack_user_id, `🔐 A Claude account is being connected to LOT data as *${c.email}* (${when} IST).\n` +
    `If this was not you, open this link and press Revoke: ${revoke}`);
  if (!told) return deny('could not send your Slack confirmation', c.email, gate.user_id);
  if (gate.slack_user_id !== env.ADMIN_SLACK_ID) {
    const ok = await slackDm(env, env.ADMIN_SLACK_ID, `🔐 New LOT MCP connection: ${c.email} at ${when} IST. Revoke all of their connections: ${revoke}`);
    if (!ok) console.error('[slack] admin DM failed for', c.email);
  }
  if (!(await audit(env, { event: 'connect', email: c.email, user_id: gate.user_id, ip, status: 200, detail: `client ${resumed.request.clientId}` }))) {
    return refusePage('LOT systems are not reachable right now. Try again shortly.', 503);
  }

  const { redirectTo } = await helpers.completeAuthorization({
    request: resumed.request,
    userId: gate.user_id,
    scope: SCOPES,
    metadata: { email: c.email, connectedAt: new Date().toISOString() },
    props: { userId: gate.user_id, email: c.email },
  });

  const h = new Headers(resumed.headers);
  h.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: h });
}

// ---------------------------------------------------------------- /revoke (signed link; GET shows, POST acts)
async function revokeUrl(env, userId) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const sig = await hmacHex(env.REVOKE_SECRET, `revoke|${userId}|${exp}`);
  return `${env.PUBLIC_URL}/revoke?u=${encodeURIComponent(userId)}&e=${exp}&s=${sig}`;
}
async function revoke(request, env, ctx) {
  const src = request.method === 'POST' ? await request.formData() : new URL(request.url).searchParams;
  const u = String(src.get('u') || ''), e = Number(src.get('e') || 0), s = String(src.get('s') || '');
  if (!u || !e || e < Date.now() / 1000) return refusePage('This revoke link has expired. Ask Afshaan to revoke.', 400);
  const want = await hmacHex(env.REVOKE_SECRET, `revoke|${u}|${e}`);
  if (!timingSafeEqualHex(want, s)) return refusePage('This revoke link is not valid.', 400);
  // GET never acts: Slack and mail scanners prefetch links.
  if (request.method !== 'POST') {
    return page('Revoke Claude connections', `<h2>Revoke Claude connections</h2>
<p>This disconnects <b>every</b> Claude account currently connected to LOT data as this person and switches off their access. Afshaan has to grant it again before they can reconnect.</p>
<form method="post" action="/revoke"><input type="hidden" name="u" value="${esc(u)}"><input type="hidden" name="e" value="${esc(e)}"><input type="hidden" name="s" value="${esc(s)}">
<button>Revoke</button></form>`);
  }
  // 1) DB first: the per-call gate refuses from this moment, whatever happens in KV (refresh races).
  const off = await fetch(`${env.SUPABASE_URL}/rest/v1/mcp_access?user_id=eq.${encodeURIComponent(u)}&active=eq.true`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json', 'Content-Profile': 'store', Prefer: 'return=minimal',
    },
    body: JSON.stringify({ active: false, revoked_at: new Date().toISOString(), note: 'revoked via Slack revoke link' }),
  }).catch(() => null);
  if (!off || !off.ok) return refusePage('Revoke failed. Tell Afshaan now, so it is done by hand.', 503);
  // 2) Then the OAuth connections.
  let n = 0, cursor;
  do {
    const list = await env.OAUTH_PROVIDER.listUserGrants(u, { cursor });
    for (const g of list.items) { await env.OAUTH_PROVIDER.revokeGrant(g.id, u); n++; }
    cursor = list.cursor;
  } while (cursor);
  ctx.waitUntil(audit(env, { event: 'revoke', user_id: u, ip: request.headers.get('CF-Connecting-IP') || '', status: 200, detail: `${n} grant(s) revoked via link` }));
  ctx.waitUntil(slackDm(env, env.ADMIN_SLACK_ID, `🔒 LOT MCP: ${n} connection(s) revoked via the revoke link for user ${u}.`));
  return page('Revoked', `<h2>Revoked</h2><p>Access switched off and ${n} connection(s) removed. Any Claude that was connected as this person can no longer reach LOT data.</p>`);
}

// ---------------------------------------------------------------- /mcp (JSON-RPC over Streamable HTTP, stateless)
const TOOLS = [{
  name: 'whoami',
  title: 'Who am I connected as',
  description: 'Shows which LOT account this Claude is connected as and which LOT systems that account has been granted. Returns no business data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
}];

const rpcResult = (id, result, status = 200) => Response.json({ jsonrpc: '2.0', id, result }, { status });
const rpcError = (id, code, message, status = 200) => Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });
// A refusal the person should read (shape: checks.js refusalResponse, tested).
const refuse = (msg, r) => {
  const { status, body } = refusalResponse(msg, r);
  return body === null ? new Response(null, { status }) : Response.json(body, { status });
};

const mcpHandler = {
  async fetch(request, env, ctx) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (!originAllowed(request.headers.get('Origin'), parseList(env.ALLOWED_ORIGINS))) {
      return rpcError(null, -32600, 'Origin not allowed', 403);
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });

    const userId = ctx.props && ctx.props.userId;
    if (!ctx.auth || !SCOPES.every(s => ctx.auth.scope.includes(s)) || !userId) {
      return rpcError(null, RPC_REFUSED, 'Not authorised', 403);
    }

    let msg;
    try { msg = await request.json(); } catch { return rpcError(null, -32700, 'Parse error', 400); }
    if (Array.isArray(msg) || !msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, -32600, 'Invalid request', 400);
    }

    // Live gate on EVERY request, tools/list included: kill switch, domain, active profile, grant, rate.
    let gate;
    try { gate = await rpc(env, 'mcp_gate', { p_user: userId }); }
    catch {
      ctx.waitUntil(alertOnce(env, 'gate-down', '🚨 LOT MCP: the mcp_gate call to Supabase is failing; every Claude request is being refused.'));
      return refuse(msg, refusalText('unreachable'));
    }
    const d = gateDecision(gate);
    if (!d.ok) {
      ctx.waitUntil(audit(env, { event: 'call_denied', user_id: userId, email: gate && gate.email, tool: msg.method, ip, status: d.status, detail: d.reason }));
      ctx.waitUntil(countDenied(env, ctx, 'call', ip));
      return refuse(msg, refusalText(d.reason));
    }

    const id = msg.id;
    if (id === undefined) return new Response(null, { status: 202 }); // notification
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'LOT internal data, read-only. Phase 0: only `whoami` exists.',
        });
      }
      case 'ping': return rpcResult(id, {});
      case 'tools/list': return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const name = msg.params && msg.params.name;
        const tool = TOOLS.find(t => t.name === name);
        if (!tool) return rpcError(id, -32602, 'Unknown tool');
        if (d.overLimit) {
          ctx.waitUntil(audit(env, { event: 'rate_limited', user_id: userId, email: gate.email, tool: name, ip, status: 429 }));
          ctx.waitUntil(alertOnce(env, `rate:${userId}`, `⚠️ LOT MCP: ${gate.email} hit the ${gate.calls_per_hour}/hour call limit.`));
          return refuse(msg, refusalText('rate limited', { callsPerHour: gate.calls_per_hour }));
        }
        // The audit row IS the rate-limit counter: no row, no call (fail closed).
        if (!(await audit(env, { event: 'call', user_id: userId, email: gate.email, tool: name, params: (msg.params && msg.params.arguments) || {}, row_count: 1, ip, status: 200 }))) {
          ctx.waitUntil(alertOnce(env, 'audit-down', '🚨 LOT MCP: audit writes are failing; every tool call is being refused (fail closed).'));
          return refuse(msg, refusalText('unreachable'));
        }
        const out = { connected_as: gate.email, name: gate.full_name, systems_granted: gate.systems, note: 'Phase 0: no data tools yet.' };
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out });
      }
      default: return rpcError(id, -32601, 'Method not found');
    }
  },
};

// ---------------------------------------------------------------- default (non-API) routes
const defaultHandler = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize') return authorize(request, env);
    if (pathname === '/callback') return callback(request, env, ctx);
    if (pathname === '/revoke') return revoke(request, env, ctx);
    if (pathname === '/') return new Response('LOT internal. Nothing here.', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    return new Response('Not found', { status: 404 });
  },
};

function buildProvider(env) {
  const allowed = parseList(env.ALLOWED_REDIRECTS);
  return new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86400, // fixed: forced re-sign-in every 30 days, however active
    clientRegistrationTTL: 30 * 86400,
    scopesSupported: SCOPES,
    requiredScopes: SCOPES,
    clientIdMetadataDocumentEnabled: true,
    // Every code exchange and refresh re-runs the live gate. Throwing invalid_grant makes the library
    // revoke the grant and its tokens (dist callTokenExchangeCallback); transient errors fail closed as 503.
    tokenExchangeCallback: async ({ userId, env: e }) => {
      let g;
      try { g = await rpc(e, 'mcp_gate', { p_user: userId }); }
      catch { throw new OAuthError('temporarily_unavailable', { description: 'try again later', statusCode: 503 }); }
      const dd = gateDecision(g);
      if (!dd.ok) {
        await audit(e, { event: 'call_denied', user_id: userId, email: g && g.email, tool: 'token', status: 400, detail: `token refused: ${dd.reason}` });
        throw new OAuthError('invalid_grant', { description: 'access no longer allowed' });
      }
    },
    clientRegistrationCallback: ({ clientMetadata }) => {
      if (!registrationAllowed(clientMetadata, allowed)) {
        return { code: 'invalid_redirect_uri', description: 'Only Claude can register with this server.', status: 400 };
      }
    },
    resourceMetadata: {
      resource: `${env.PUBLIC_URL}/mcp`,
      authorization_servers: [env.PUBLIC_URL],
      resource_name: 'LOT internal data (read-only)',
    },
  });
}

let provider, cidrs;
export default {
  async fetch(request, env, ctx) {
    provider ||= buildProvider(env);
    cidrs ||= parseCidrs(env.ALLOWED_CIDRS);
    const { pathname } = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || '';

    // Plain case-insensitive prefix: a strict superset of the library's apiRoute match (/mcp, /mcp/…).
    if (IP_GATED_PREFIXES.some(p => pathname.toLowerCase().startsWith(p)) && !ipAllowed(ip, cidrs)) {
      ctx.waitUntil(audit(env, { event: 'ip_blocked', ip, status: 403, detail: `${request.method} ${pathname}` }));
      ctx.waitUntil(countDenied(env, ctx, 'ip', ip));
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const res = await provider.fetch(request, env, ctx);
    if (pathname.startsWith('/mcp') && res.status === 401 && request.headers.get('Authorization')) {
      ctx.waitUntil(audit(env, { event: 'bad_token', ip, status: 401 }));
      ctx.waitUntil(countDenied(env, ctx, 'token', ip));
    }
    if (pathname === '/register' && res.status === 400) {
      ctx.waitUntil(audit(env, { event: 'register_denied', ip, status: 400 }));
    }
    return res;
  },
  // Daily KV clean-up of expired grants/tokens.
  async scheduled(_event, env, ctx) {
    provider ||= buildProvider(env);
    ctx.waitUntil(provider.purgeExpiredData(env));
  },
};
