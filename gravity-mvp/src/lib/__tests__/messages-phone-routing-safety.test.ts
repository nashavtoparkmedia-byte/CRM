import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (file: string) => readFileSync(path.join(process.cwd(), 'src', file), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const absolute = path.join(directory, entry)
    return statSync(absolute).isDirectory()
      ? sourceFiles(absolute)
      : absolute.endsWith('.ts') || absolute.endsWith('.tsx') ? [absolute] : []
  })
}

describe('messages phone routing safety guard', () => {
  test('GET /messages is read-only and uses strict canonical phone ownership', () => {
    const page = source('app/messages/page.tsx')
    expect(page).toContain('resolveStrictPhoneOwnership')
    expect(page).toContain("ownership.kind === 'matched'")
    expect(page).not.toContain('ContactService.resolveContact')
    expect(page).not.toMatch(/prisma\.[a-zA-Z]+\.(create|update|upsert|delete|deleteMany|updateMany)\(/)
    expect(page).not.toContain('externalChatId: { contains:')
    expect(page).not.toContain('driver: { phone: { contains:')
    expect(page).not.toContain('prisma.contact.findFirst')
  })

  test('operator start routes reject ambiguous ownership before creating a chat', () => {
    const startConversation = source('app/api/contacts/start-conversation/route.ts')
    const startChat = source('app/api/messages/start-chat/route.ts')
    expect(startConversation).toContain('resolveStrictPhoneOwnership')
    expect(startConversation).toContain('PHONE_OWNERSHIP_AMBIGUOUS')
    expect(startConversation).toContain("ambiguousPhone: 'reject'")
    expect(startChat).toContain("ambiguousPhone: 'reject'")
    expect(startChat).toContain('PHONE_IDENTITY_CONFLICT')
  })

  test('ContactService records trust metadata and never uses findFirst for phone ownership', () => {
    const service = source('lib/ContactService.ts')
    expect(service).toContain('trustedForAutomaticResolution')
    expect(service).toContain('sourceKind')
    expect(service).toContain('providerIdentity')
    expect(service).toContain('observedAt')
    expect(service).toContain('resolveStrictPhoneOwnership')
    expect(service).not.toContain('db.contactPhone.findFirst')
  })

  test('all automatic phone-owner decisions flow through the canonical planner', () => {
    const strict = source('lib/contacts/strict-phone-ownership.ts')
    const planner = source('lib/contacts/ContactResolutionService.ts')
    expect(strict).toContain('ContactResolutionService.fromDb')
    expect(planner).toContain('createPrismaContactResolutionRepository')
    expect(planner).toContain('resolveCanonicalContact')
  })

  test('repository guard rejects phone-owner findFirst outside explicitly contact-scoped reads', () => {
    const srcRoot = path.join(process.cwd(), 'src')
    const allowedContactScopedReads = new Set([
      'app/api/contacts/[id]/chats/route.ts',
      'app/api/contacts/[id]/phones/[phoneId]/route.ts',
      'app/api/contacts/[id]/route.ts',
    ])
    const offenders = sourceFiles(srcRoot)
      .filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter(file => /\b(?:prisma|tx|db)\.contactPhone\.findFirst\s*\(/.test(readFileSync(file, 'utf8')))
      .map(file => path.relative(srcRoot, file).split(path.sep).join('/'))
      .filter(file => !allowedContactScopedReads.has(file))

    expect(offenders).toEqual([])
    for (const file of allowedContactScopedReads) {
      const scopedRead = source(file)
      expect(scopedRead).toContain('contactId')
    }
  })

  test.each([
    'lib/ContactService.ts',
    'lib/contacts/yandex-link.ts',
    'lib/driver-profiles/multi-park.ts',
    'app/api/monitoring/sync/route.ts',
    'lib/freeswitch/EslClient.ts',
    'lib/whatsapp/WhatsAppService.ts',
  ])('%s uses strict canonical ownership for automatic phone routing', file => {
    expect(source(file)).toContain('resolveStrictPhoneOwnership')
  })
})
