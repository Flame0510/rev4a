// Extra hostnames or IPs allowed to reach the dev server (`next dev` only — no effect on
// a production build), e.g. a LAN address when opening the dashboard from another device.
// Comma-separated, without scheme or port; none by default.
const extraDevOrigins = (process.env.REV4A_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig = {
  reactStrictMode: true,
  // Rev4a does not use next/image: disable the image optimizer endpoint, and with a zero disk
  // cache Next never scans or writes .next/cache/images for it.
  images: { unoptimized: true, maximumDiskCacheSize: 0 },
  serverExternalPackages: ['better-sqlite3'],
  allowedDevOrigins: ['127.0.0.1', 'localhost', ...extraDevOrigins],
  async headers() {
    return [{
      source: '/:path*',
      headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
    }];
  },
};

export default nextConfig;
