/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const botApiUrl = process.env.TG_BOT_API_URL || 'http://localhost:3001'
    return [
      {
        source: '/api/admin/:path*',
        destination: `${botApiUrl}/api/admin/:path*`,
      },
      {
        source: '/api/telegram/:path*',
        destination: `${botApiUrl}/api/telegram/:path*`,
      },
    ]
  },
};

export default nextConfig;
