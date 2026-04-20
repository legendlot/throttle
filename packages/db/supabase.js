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
