// commsops auth — mirrors docketops verifyJWT, reads store.relayops_* perm layer.

// PostgREST silently truncates any read that would return more rows than `db-max-rows`.
//
// ⚠️ MEASURED, not inherited — 2026-08-16, against the live REST endpoint:
//     GET /rest/v1/units?select=upc   with no limit
//     → 5,000 rows, `content-range: 0-4999/159092`
// So the cap is exactly 5,000, and PostgREST DOES tell the truth — in a `content-range` header
// this helper throws away. That discard is the whole defect class: the caller gets a plain array
// of 5,000 rows, no error, no status, nothing to notice. Three read sites have been bitten
// (getSegment's member count, the pre-flight quiet_hours_risk estimate, the S275 export) and
// every one was found by a user reporting a wrong number or by someone tripping over it — never
// by looking, because from the outside a truncated read is indistinguishable from a correct one.
//
// So: detect it HERE, at the single shared helper, rather than paging 41 call sites that do not
// currently overflow. Same reasoning as checkWrite below, and the same PATTERN-218 lesson the
// serialiser's allow-list records — one enforcement point beats N sites that must each be
// remembered. A site that starts overflowing next year now says so on the day it does.
//
// Logs rather than throws: these run inside live send paths and webhooks, and turning a
// too-large read into a thrown error would convert a reporting bug into an outage.
// `wrangler tail | grep db_max_rows` is the intended way to see them.
const DB_MAX_ROWS = 5000;

function sbProfile(profile) {
  return async function (path, env, opts = {}) {
    const res = await fetch(`${env.SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Accept-Profile': profile,
        'Content-Profile': profile,
        Prefer: opts.prefer || 'return=representation',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    // Exactly db-max-rows back from a query that asked for no limit means PostgREST almost
    // certainly had more to give. `limit=`/`Range` callers are excluded — they asked for a
    // bounded page and getting it is not a truncation. A table holding exactly 5,000 rows logs a
    // harmless false positive; that is the right side to err on for a fault this quiet.
    if (Array.isArray(data) && data.length === DB_MAX_ROWS
        && !/[?&]limit=/.test(path) && !(opts.headers || {}).Range) {
      console.log('db_max_rows_truncated', JSON.stringify({
        profile, rows: data.length, path: String(path).slice(0, 300),
      }));
    }
    return { ok: res.ok, status: res.status, data };
  };
}
const sbComms = sbProfile('comms');
const sbStore = sbProfile('store');
const enc = encodeURIComponent;

// Make a fire-and-forget write OBSERVABLE without changing control flow.
//
// sbProfile never throws on an HTTP error — it returns `{ok:false}` — so a bare
// `await A.sbComms(...)` discards a failed write in complete silence. In the webhook paths
// that is not cosmetic: a dropped status PATCH leaves a message reading `sent` forever, a
// dropped engagement insert loses delivered/read/clicked analytics, and a dropped
// `wa_windows` upsert loses the 24h service window, which decides whether the next reply is
// even allowed to be free-text.
//
// It LOGS rather than throws on purpose: webhooks must return 200 or Meta/Resend redeliver,
// and one unwritable row must not turn into a redelivery storm. `wrangler tail | grep _failed`
// is the intended way to see these. Same shape as the pre-existing `suppression_write_failed`
// (S261), generalised so the whole class is covered rather than one site.
function checkWrite(marker, res, context) {
  if (!res || res.ok !== true) {
    try {
      console.log(marker, JSON.stringify({
        status: res?.status ?? null, detail: res?.data ?? null, ...(context || {}),
      }));
    } catch { console.log(marker, 'unserialisable context'); }
  }
  return res;
}

async function verifyJWT(authHeader, env) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;

  const profRes = await sbStore(
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`, env);
  const profile = (profRes.ok && profRes.data?.[0]) || null;
  if (!profile || !profile.active) return null;

  // order=assigned_at.desc — a user with two active role grants gets the NEWEST one
  // deterministically, instead of whatever order Postgres happened to return (review M7).
  const urRes = await sbStore(
    `/rest/v1/relayops_user_roles?user_id=eq.${user.id}&active=eq.true` +
    `&select=role_key&order=assigned_at.desc&limit=1`, env);
  const roleKey = (urRes.ok && urRes.data?.[0]?.role_key) || null;
  // No auto-login from the legendoftoys.com domain: a valid Google/Supabase
  // session is NOT enough — access requires an explicit, active Relay role
  // (mirrors odoops). Anyone not provisioned on the access list is denied.
  if (!roleKey) return null;
  const rRes = await sbStore(
    `/rest/v1/relayops_roles?role_key=eq.${enc(roleKey)}&select=permissions&limit=1`, env);
  const permissions = (rRes.ok && rRes.data?.[0]?.permissions) || {};
  return {
    userId: user.id, email: user.email, role: profile.role,
    fullName: profile.full_name, relayRole: roleKey, permissions,
  };
}

// Permission gates (PRD §10 keys)
const can = (p, key) => !!(p && p[key]);
const canView         = p => can(p, 'relay_view');
const canSegment      = p => can(p, 'segment_manage');
const canTemplate     = p => can(p, 'template_manage');
const canBuild        = p => can(p, 'campaign_build');
const canActivate     = p => can(p, 'send_activate');
const canApprove      = p => can(p, 'approve');
const canConsentAdmin = p => can(p, 'data_consent_admin');
const canConnector    = p => can(p, 'connector_channel_manage');
const canAdmin        = p => can(p, 'relay_admin');
const canSuperAdmin   = p => can(p, 'relay_super_admin');

module.exports = {
  sbProfile, sbComms, sbStore, enc, verifyJWT, checkWrite, DB_MAX_ROWS,
  canView, canSegment, canTemplate, canBuild, canActivate, canApprove,
  canConsentAdmin, canConnector, canAdmin, canSuperAdmin,
};
