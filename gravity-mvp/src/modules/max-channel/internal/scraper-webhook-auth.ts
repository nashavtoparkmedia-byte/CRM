import 'server-only'

import { timingSafeEqual } from 'node:crypto'

export const MAX_SCRAPER_WEBHOOK_SECRET_HEADER_V1 = 'x-max-scraper-webhook-secret'

/** Fail closed when the shared secret is absent, blank, or does not match. */
export function isAuthorizedMaxScraperWebhookV1(request: Request): boolean {
    const expected = process.env.MAX_SCRAPER_WEBHOOK_SECRET?.trim()
    const supplied = request.headers.get(MAX_SCRAPER_WEBHOOK_SECRET_HEADER_V1)
    if (!expected || !expected.trim() || !supplied) return false

    const expectedBytes = Buffer.from(expected, 'utf8')
    const suppliedBytes = Buffer.from(supplied, 'utf8')
    return expectedBytes.length === suppliedBytes.length
        && timingSafeEqual(expectedBytes, suppliedBytes)
}
