import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
