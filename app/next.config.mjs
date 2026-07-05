/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.fallback = { fs: false, os: false, path: false };
    // `pino-pretty` is an optional dev dependency of walletconnect's logger;
    // it is never used in production. Stub it so the bundle resolves.
    config.resolve.alias = { ...config.resolve.alias, "pino-pretty": false };
    return config;
  },
};
export default nextConfig;
