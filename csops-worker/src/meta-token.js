// ── Instagram (IGAA) access-token lifecycle ──────────────────────────────────
//
// The problem this solves (BACKLOG, S305→S311): nothing refreshed META_IG_TOKEN, so it
// was always going to die at 60 days — and it did. Instagram replies failed for four
// days (20–24 Aug 2026) and surfaced only as a Slack message from Pruthvi. The token
// minted on 24 Aug hard-dies ~23 Oct 2026.
//
// ⚠️ 60 days is the CEILING for an Instagram-Login (IGAA) token and there is NO
// "never expires" option on this token type. The memory of a permanent token is
// META_PAGE_TOKEN — a different credential, on a different route (graph.facebook.com).
// Do not go looking for a permanent IGAA token; it does not exist.
//
// Why the token lives in the DB rather than a secret: refreshing is a one-line GET, but
// the RESULT has to be kept, and a Worker cannot write its own secret (`wrangler secret
// put` is manual). So `store.cs_meta_token_config` holds the live token and the worker
// reads from there, falling back to the secret. Same posture as cs_softphone_config.
//
// ⚠️ THE FAILURE MODE THIS FILE IS WRITTEN AGAINST, stated in the backlog item before a
// line of it existed: "Do not ship a refresh cron that discards the new token — it would
// look like it worked and change nothing." Everything below treats PERSISTING the new
// token as the operation; calling Meta is the easy half.

const IG_GRAPH = 'https://graph.instagram.com';

// Refresh this far ahead of expiry. Generous on purpose: Meta refuses to refresh a token
// that has already expired, so the cost of being early is nothing and the cost of being
// late is a dead channel and a manual re-mint through the Meta UI.
export const REFRESH_BEFORE_DAYS = 14;

// Don't hammer Meta from a */2 cron. One attempt per 6h is ~56 attempts inside the
// 14-day window — enough that a run of failures still leaves weeks of runway.
export const MIN_ATTEMPT_GAP_MS = 6 * 60 * 60 * 1000;

// Meta requires a token to be at least 24h old before it can be refreshed.
const MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

const CONFIG_PATH = '/rest/v1/cs_meta_token_config?id=eq.1';

/**
 * The token the worker should USE right now: the stored one, else the secret.
 *
 * Cached per isolate for a minute so a send does not pay a DB read. A refresh landing
 * elsewhere can leave this up to a minute stale, which is harmless — Meta keeps the
 * previous token valid until its own expiry, so a stale-but-unexpired token still sends.
 */
let cache = null;   // { token, at }
const CACHE_TTL_MS = 60 * 1000;

export function _resetTokenCache() { cache = null; }   // tests only

export async function igAccessToken(env, sb) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.token;
  try {
    const r = await sb(`${CONFIG_PATH}&select=ig_access_token`, env);
    const stored = r?.ok ? (r.data?.[0]?.ig_access_token || null) : null;
    if (stored) { cache = { token: stored, at: now }; return stored; }
  } catch { /* fall through — a DB blip must never stop a reply going out */ }
  return env.META_IG_TOKEN || env.META_PAGE_TOKEN || null;
}

/**
 * Decide whether to call Meta at all. Pure, so the policy is testable without a network
 * or a database — which is the only way to be sure a cron that runs every 2 minutes is
 * not quietly calling Meta every 2 minutes.
 *
 * @returns {{ act: boolean, reason: string }}
 */
export function refreshDecision(row, now = Date.now()) {
  if (!row) return { act: false, reason: 'no config row' };

  const lastAttempt = row.ig_last_attempt_at ? Date.parse(row.ig_last_attempt_at) : 0;
  if (lastAttempt && now - lastAttempt < MIN_ATTEMPT_GAP_MS) {
    return { act: false, reason: 'attempted recently' };
  }
  // No stored token yet → adopt the secret and let the caller refresh from it. This is
  // how the row gets populated without anyone pasting a credential anywhere.
  if (!row.ig_access_token) return { act: true, reason: 'bootstrap' };

  const expiresAt = row.ig_token_expires_at ? Date.parse(row.ig_token_expires_at) : null;
  // Expiry unknown (e.g. straight after a bootstrap): refresh, and Meta's own response
  // tells us the truth. Guessing an expiry would be worse than asking.
  if (!expiresAt) return { act: true, reason: 'expiry unknown' };

  if (expiresAt <= now) {
    // Past the ceiling. Meta will refuse, so calling is pointless — but say so loudly,
    // because this is the state that needs a human and a manual re-mint.
    return { act: false, reason: 'EXPIRED — needs a manual re-mint in the Meta UI' };
  }
  const daysLeft = (expiresAt - now) / 86400000;
  if (daysLeft > REFRESH_BEFORE_DAYS) {
    return { act: false, reason: `healthy, ${Math.round(daysLeft)}d left` };
  }
  const age = row.ig_refreshed_at ? now - Date.parse(row.ig_refreshed_at) : Infinity;
  if (age < MIN_TOKEN_AGE_MS) return { act: false, reason: 'token under 24h old' };

  return { act: true, reason: `${Math.round(daysLeft)}d left` };
}

/**
 * Run one refresh cycle. Safe to call on every cron tick — refreshDecision() gates it.
 */
export async function refreshIgToken(env, sb, { fetchImpl = fetch, now = Date.now() } = {}) {
  const r = await sb(`${CONFIG_PATH}&select=*`, env);
  if (!r?.ok || !r.data?.[0]) return { ok: false, skipped: 'config row missing' };
  const row = r.data[0];

  const decision = refreshDecision(row, now);
  if (!decision.act) return { ok: true, skipped: decision.reason };

  // Bootstrap: adopt the secret as the stored token, then refresh FROM it on this same
  // tick so Meta's response supplies a real expiry rather than one we invented.
  let current = row.ig_access_token;
  let bootstrapped = false;
  if (!current) {
    current = env.META_IG_TOKEN || null;
    if (!current) return { ok: false, skipped: 'no token in DB and no META_IG_TOKEN set' };
    bootstrapped = true;
  }

  let res, body;
  try {
    res = await fetchImpl(`${IG_GRAPH}/refresh_access_token`
      + `?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`);
    body = await res.json().catch(() => ({}));
  } catch (e) {
    await sb(CONFIG_PATH, env, { method: 'PATCH', body: JSON.stringify({
      ig_last_error: `network: ${e?.message || e}`.slice(0, 500),
      ig_last_attempt_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    }) }).catch(() => {});
    return { ok: false, error: 'network' };
  }

  const newToken = body?.access_token;
  const expiresIn = Number(body?.expires_in);
  if (!res.ok || !newToken) {
    // ⚠️ The existing token is deliberately LEFT IN PLACE. A failed refresh does not
    // invalidate it, and clearing it here would turn a recoverable warning into the
    // outage this whole file exists to prevent.
    const patch = {
      ig_last_error: JSON.stringify(body?.error || body || { status: res.status }).slice(0, 500),
      ig_last_attempt_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
    // Still adopt the secret if we were bootstrapping — having it stored is strictly
    // better than not, even if this particular refresh failed.
    if (bootstrapped) patch.ig_access_token = current;
    await sb(CONFIG_PATH, env, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});
    return { ok: false, error: patch.ig_last_error, bootstrapped };
  }

  // ⭐ The whole point: PERSIST it. A cron that refreshes and drops the result looks
  // healthy in the logs and changes nothing.
  const expiresAt = new Date(now + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 60 * 86400000));
  const w = await sb(CONFIG_PATH, env, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: JSON.stringify({
      ig_access_token: newToken,
      ig_token_expires_at: expiresAt.toISOString(),
      ig_refreshed_at: new Date(now).toISOString(),
      ig_last_attempt_at: new Date(now).toISOString(),
      ig_refresh_count: (Number(row.ig_refresh_count) || 0) + 1,
      ig_last_error: null,
      updated_at: new Date(now).toISOString(),
    }),
  });
  // Verify the write landed rather than trusting it — the one outcome that must never be
  // reported as success is "refreshed, didn't save".
  const saved = w?.ok && Array.isArray(w.data) && w.data[0]?.ig_access_token === newToken;
  if (!saved) return { ok: false, error: 'refreshed but FAILED TO SAVE — token not persisted' };

  cache = null;   // force the next read to pick up the new token
  return { ok: true, refreshed: true, bootstrapped, expires_at: expiresAt.toISOString() };
}
