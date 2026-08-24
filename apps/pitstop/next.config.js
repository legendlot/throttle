/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@throttle/auth', '@throttle/db', '@throttle/ui', '@throttle/domain'],
  // The Exotel WebRTC SDK (Phase 6 softphone) imports .wav ringtones; webpack needs
  // an asset rule for them or the build fails on "Unexpected character '@'".
  webpack: (config) => {
    config.module.rules.push({ test: /\.wav$/, type: 'asset/resource' });
    return config;
  },
};

module.exports = nextConfig;
