// commsops auth — mirrors docketops verifyJWT, reads store.relayops_* perm layer.

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
    return { ok: res.ok, status: res.status, data };
  };
}
const sbComms = sbProfile('comms');
const sbStore = sbProfile('store');
const enc = encodeURIComponent;

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

  const urRes = await sbStore(
    `/rest/v1/relayops_user_roles?user_id=eq.${user.id}&active=eq.true&select=role_key&limit=1`, env);
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
  sbProfile, sbComms, sbStore, enc, verifyJWT,
  canView, canSegment, canTemplate, canBuild, canActivate, canApprove,
  canConsentAdmin, canConnector, canAdmin, canSuperAdmin,
};
