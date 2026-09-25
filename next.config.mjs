// Extra origins allowed to reach the dev server (`next dev` only — no effect on a
// production build), e.g. a LAN address when opening the dashboard from another device.
// Comma-separated; none by default.
const extraDevOrigins = (process.env.REV4A_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['better-sqlite3'],
  allowedDevOrigins: ['127.0.0.1', 'localhost', ...extraDevOrigins],
};

export default nextConfig;
