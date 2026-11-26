/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The admin is embedded by the CRM on its apex origin. Keeping a dedicated
  // base path prevents its assets and API routes from colliding with CRM
  // routes while preserving the HttpOnly session boundary.
  basePath: '/bot-admin',
};

export default nextConfig;
