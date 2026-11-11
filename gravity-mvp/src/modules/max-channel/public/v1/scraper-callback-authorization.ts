import 'server-only'

import { timingSafeEqual } from 'node:crypto'

export const MAX_SCRAPER_WEBHOOK_SECRET_HEADER_V1 = 'x-max-scraper-webhook-secret'

/**
 * Admits a machine callback from the MAX scraper: the MAX webhook routes and
 * the CRM routes owned outside max_channel (for example the history-import job
 * callback). Fail closed when the shared secret is absent, blank, or does not
 * match; the comparison is constant-time.
 */
export function isAuthorizedMaxScraperCallbackV1(request: Request): boolean {
    const expected = process.env.MAX_SCRAPER_WEBHOOK_SECRET?.trim()
    const supplied = request.headers.get(MAX_SCRAPER_WEBHOOK_SECRET_HEADER_V1)
    if (!expected || !expected.trim() || !supplied) return false

    const expectedBytes = Buffer.from(expected, 'utf8')
    const suppliedBytes = Buffer.from(supplied, 'utf8')
    return expectedBytes.length === suppliedBytes.length
        && timingSafeEqual(expectedBytes, suppliedBytes)
}
