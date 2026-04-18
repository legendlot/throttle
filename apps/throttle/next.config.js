/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@throttle/auth', '@throttle/db', '@throttle/ui', '@throttle/domain'],
};

module.exports = nextConfig;
