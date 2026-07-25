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

  test('scraper trusts only phone data bound to the exact provider identity and route', () => {
    const store = read('max-web-scraper/contacts/ContactStore.js')
    const live = read('max-web-scraper/index.js')
    const evidence = read('max-web-scraper/contacts/MaxPhoneEvidence.js')
    expect(store).toContain("sourceKind: 'provider_profile'")
    expect(store).toContain('getPhoneEvidence(userId)')
    expect(live).toContain('createMaxProviderProfileEvidence')
    expect(live).toContain('cachedPhoneEvidenceForChatId')
    expect(evidence).toContain('providerIdentityId')
    expect(evidence).toContain('protocolChatId')
    expect(evidence).toContain('uiRouteId')
  })

  test('live DOM reply enrichment updates the existing provider message without creating a duplicate', () => {
    const route = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
    const replyStorage = read('gravity-mvp/src/lib/max-reply-storage.ts')
    const duplicateStart = route.indexOf('if (isTextProviderEvent && externalIdString) {')
    const duplicateEnd = route.indexOf('const rawExternalChatId', duplicateStart)
    const duplicateBlock = route.slice(duplicateStart, duplicateEnd)

    expect(duplicateStart).toBeGreaterThan(-1)
    expect(duplicateEnd).toBeGreaterThan(duplicateStart)
    expect(duplicateBlock).toContain("source === 'live_dom_reply_enrichment'")
    expect(duplicateBlock).toContain('resolveMaxReplyStorage')
    expect(duplicateBlock).toContain('content: replyStorage.content')
    expect(duplicateBlock).toContain('...replyStorage.metadata')
    expect(duplicateBlock).toContain('await prisma.message.update')
    expect(duplicateBlock).toContain('deduped: true')
    expect(duplicateBlock).not.toContain('prisma.message.create')

    expect(route).toContain('externalId: params.replyToExternalId')
    expect(route).toContain('content: params.replyQuoteText')
    expect(route).toContain('take: 2')
    expect(replyStorage).toContain('targets.length === 1')
    expect(replyStorage).toContain('metadata.quotedMsgId = uniqueTarget.id')
  })
})
