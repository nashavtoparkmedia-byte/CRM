import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const root = path.resolve(process.cwd(), '..')
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8')

describe('MAX trusted phone source contract', () => {
  test('canonical webhook carries provenance into planner, ContactService, and chat metadata', () => {
    const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
    expect(route).toContain('resolveMaxPhoneEvidence')
    expect(route).toContain('trustedSenderPhone')
    expect(route).toContain('source: maxPhoneEvidence.sourceKind')
    expect(route).toContain('observedAt: maxPhoneEvidence.observedAt')
    expect(route).toContain('phoneEvidence: maxPhoneEvidence')
  })

  test('canonical webhook does not route a chat or driver by an untrusted phone fallback', () => {
    const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
    expect(route).not.toContain('const existingByPhone')
    expect(route).not.toContain("{ driver: { phone: { contains: last10 } }")
    expect(route).toContain('!chat.driverId && trustedSenderPhone')
    expect(route).not.toContain('phone: effectiveSenderPhone || undefined')
  })

  test('deprecated route gates phone migration and driver linking on explicit trust', () => {
    const route = read('gravity-mvp/src/app/api/webhook/max/route.ts')
    expect(route).toContain('resolveMaxPhoneEvidence')
    expect(route).toContain('&& trustedPhone')
    expect(route).toContain('const linked = trustedPhone')
    expect(route).not.toContain('name: driverName || phone')
  })

  test('scraper labels provider contact data and leaves cache-derived mappings untrusted', () => {
    const store = read('max-web-scraper/contacts/ContactStore.js')
    const live = read('max-web-scraper/index.js')
    const history = read('max-web-scraper/sync/InitialHistorySync.js')
    expect(store).toContain("sourceKind: 'provider_profile'")
    expect(store).toContain('getPhoneEvidence(userId)')
    expect(live).toContain('phoneEvidence')
    expect(live).toContain("sourceKind: 'unknown'")
    expect(history).toContain('getPhoneEvidence(payload.senderId)')
  })
})
