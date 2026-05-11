import { createClient } from '@supabase/supabase-js';

// Build-safe fallbacks: createClient rejects empty strings. Real NEXT_PUBLIC_*
// env vars are required for any actual Supabase call to succeed — placeholders
// just keep the module loadable during static export prerender.
const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL      || 'https://missing-env.invalid';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'missing-env';

// Single Supabase client for the whole app. A second createClient() call with
// the same storageKey spawns a second GoTrueClient — that triggers the
// "Multiple GoTrueClient instances detected" warning and, on mobile browsers,
// causes session race conditions where getMe sees a stale/missing token.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'throttle-auth',
  },
});

// Brand-schema query interface. Shares the single client's auth/session —
// does NOT instantiate a second GoTrueClient. Exposes the subset of the
// SupabaseClient surface the app actually uses: .from, .rpc, and .auth.
const brandRest = supabase.schema('brand');
export const supabaseBrand = {
  from:    brandRest.from.bind(brandRest),
  rpc:     brandRest.rpc.bind(brandRest),
  auth:    supabase.auth,
  channel: supabase.channel.bind(supabase),
};

let _sessionCache = null;
let _sessionFetchedAt = 0;
const SESSION_CACHE_TTL = 30_000;

// Registered once at module level — never inside getValidSession().
// Registering inside getValidSession() accumulates unbounded subscriptions
// (one per stale-cache call), causing a flood of onAuthStateChange callbacks
// across tabs that freezes the UI.
// Also handles TOKEN_REFRESHED so the cache stays current across tabs —
// without this, a token refreshed in Tab B leaves Tab A serving a stale
// access_token for up to 30 s, causing 401s on every Worker request.
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    _sessionCache = null;
    _sessionFetchedAt = 0;
  } else if (event === 'TOKEN_REFRESHED' && session) {
    _sessionCache = session;
    _sessionFetchedAt = Date.now();
  }
});

export async function getValidSession() {
  const now = Date.now();
  if (_sessionCache && (now - _sessionFetchedAt) < SESSION_CACHE_TTL) {
    return _sessionCache;
  }
  const { data } = await supabase.auth.getSession();
  _sessionCache = data.session;
  _sessionFetchedAt = now;
  return _sessionCache;
}
