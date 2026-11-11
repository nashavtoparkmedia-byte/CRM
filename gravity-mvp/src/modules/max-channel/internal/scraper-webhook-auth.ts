// The MAX webhook routes' name for max_channel's public scraper-callback
// check; the check itself lives in public/v1 so that routes owned outside
// max_channel reach it without importing an internal.
export {
    MAX_SCRAPER_WEBHOOK_SECRET_HEADER_V1,
    isAuthorizedMaxScraperCallbackV1 as isAuthorizedMaxScraperWebhookV1,
} from '../public/v1/scraper-callback-authorization'
