import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), 'src', relativePath), 'utf8')
}

describe('active Contact resolution source boundaries', () => {
  test('ContactService primary resolve paths do not select a first phone owner', () => {
    const contactService = source('lib/ContactService.ts')
    const primaryPaths = contactService.split('static async addPhoneToContact')[0]
    expect(primaryPaths).not.toContain('contactPhone.findFirst')
    expect(primaryPaths).toContain('SafeContactResolutionExecutor.fromPrisma().execute')
  })

  test('call ingress has no independent first phone/driver fallback', () => {
    const calls = source('lib/freeswitch/EslClient.ts')
    expect(calls).not.toContain('contactPhone.findFirst')
    expect(calls).not.toContain('driver.findFirst')
    expect(calls).toContain('isResolvedChannelContactResultV1(resolved)')
  })

  test('MAX ingress has no phone/freshness chat identity fallback', () => {
    const route = source('app/api/webhooks/max/route.ts')
    expect(route).not.toContain('existingByPhone')
    expect(route).not.toContain('prisma.chat.findFirst')
    expect(route).toContain('selectUniqueExactMaxSenderCandidate')
    expect(route).toContain('chatKind: maxChatKind')
  })

  test('WhatsApp live Contact recovery does not select first phone owner', () => {
    const whatsapp = source('lib/whatsapp/WhatsAppService.ts')
    expect(whatsapp).not.toContain('prisma.contactPhone.findFirst')
    expect(whatsapp).toContain('if (!isResolvedChannelContactResultV1(contactResult) || !contactResult.identity)')
  })

  test('manual conversation setup never fabricates a provider identity from phone digits', () => {
    const adapter = source('modules/contacts/public/v1/legacy-prisma-contact-conversation-adapter.ts')
    const startChat = source('app/api/messages/start-chat/route.ts')
    const orchestrator = source('modules/platform-shell/internal/contact-conversation-orchestrator.ts')
    const manualLink = source('app/messages/link-chat-actions.ts')
    expect(adapter).not.toContain("externalId: phone.phone.replace")
    expect(adapter).not.toContain('contactIdentity.create')
    expect(startChat).not.toContain("driver?.phone?.replace(/\\D/g, '')")
    expect(startChat).toContain('A stable provider identity is required')
    expect(orchestrator).not.toContain("normalizedPhone.replace('+', '')")
    expect(orchestrator).toContain("status: 'provider_identity_required'")
    expect(manualLink).not.toContain('phoneDigits,')
    expect(manualLink).toContain('chat.contactIdentityId')
  })

  test('ambiguity metadata suppresses loading a persisted selected Contact in the drawer', () => {
    const drawer = source('app/messages/components/ContactProfileDrawer.tsx')
    expect(drawer).toContain('ambiguityCandidateCount === null ? chat?.contactId : undefined')
    expect(drawer).toContain('<ContactResolutionAmbiguityBanner')
  })
})
