import { createClient } from '@supabase/supabase-js';

// Build-safe fallbacks: createClient rejects empty strings. Real NEXT_PUBLIC_*
// env vars are required for any actual Supabase call to succeed — placeholders
// just keep the module loadable during static export prerender.
const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL      || 'https://missing-env.invalid';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'missing-env';

const authOptions = {
  persistSession: true,
  autoRefreshToken: true,
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: authOptions,
});

export const supabaseBrand = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: authOptions,
  db: { schema: 'brand' },
});
