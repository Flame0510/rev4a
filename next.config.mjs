const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['better-sqlite3'],
  allowedDevOrigins: ['203.0.113.10', '127.0.0.1', 'localhost'],
  generateBuildId: async () => {
    // Use timestamp + git hash to force unique build ids every time
    return `b${Date.now()}`;
  },
};

export default nextConfig;
