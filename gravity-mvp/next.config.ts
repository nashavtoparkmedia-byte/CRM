import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Server-only packages that Turbopack must NOT try to bundle. These either:
   *  - load native binaries at runtime via dynamic require (ffmpeg installer,
   *    esl uses node net), or
   *  - target Node.js APIs (fs, child_process, dgram) that Webpack/Turbopack
   *    bundling can't rewrite for the browser anyway.
   * Without this list, builds fail with "Module not found" pointing at
   * server-relative paths inside platform-specific subdirectories.
   */
  serverExternalPackages: [
    '@ffmpeg-installer/ffmpeg',
    'fluent-ffmpeg',
    'esl',
    'modesl',
    '@prisma/client',
    'prisma',
  ],

  /**
   * Legacy URL redirects.
   *
   * Раздел /avito был расщеплён на две части:
   *   - Отклики (лиды) → переехали в унифицированный /leads/new
   *   - Профили Avito (инфра) → переехали в Settings → Integrations
   *
   * Эти редиректы сохраняют deep-link'и из старых места (Telegram-бот
   * нотификации, закладки операторов) рабочими.
   *
   * permanent: false — на случай если решим вернуть /avito как live URL.
   */
  async redirects() {
    return [
      {
        source: '/avito',
        destination: '/leads/new?source=avito',
        permanent: false,
      },
      {
        source: '/avito/accounts',
        destination: '/settings/integrations/avito',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
