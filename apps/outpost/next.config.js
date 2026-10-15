/** @type {import('next').NextConfig} */
// Outpost is the VENDOR app: it may use @throttle/ui only. Never @throttle/auth or @throttle/db (they carry the
// Supabase client and LOT's login); scripts/check-isolation.mjs fails the build if any Supabase reference ships.
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@throttle/ui'],
};

module.exports = nextConfig;
