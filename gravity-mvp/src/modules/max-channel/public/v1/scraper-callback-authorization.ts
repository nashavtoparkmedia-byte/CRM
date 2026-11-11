import 'server-only'

import { isAuthorizedMaxScraperWebhookV1 as matchesScraperWebhookSecret } from '../../internal/scraper-webhook-auth'

/**
 * Admits a machine callback from the MAX scraper into a CRM route owned
 * outside max_channel (for example the history-import job callback). It is
 * the same check the MAX webhook routes use: the scraper's shared webhook
 * secret, compared in constant time, refused when the secret is unset or blank.
 */
export function isAuthorizedMaxScraperCallbackV1(request: Request): boolean {
    return matchesScraperWebhookSecret(request)
}
