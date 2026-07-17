import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

describe('explicit DriverProfile start-chat route', () => {
  test('uses an existing profile Contact or a manual attachment, never a phone-first Driver lookup', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/app/api/messages/start-chat/route.ts'), 'utf8')
    expect(source).toContain('ContactService.ensureIdentityForContact(driver.contactId')
    expect(source).toContain('attachDriverProfilesToContactManually')
    expect(source).toContain('CHAT_CONTACT_CONFLICT')
    expect(source).toContain('CHAT_DRIVER_CONFLICT')
    expect(source).not.toContain('prisma.driver.findFirst')
    expect(source).not.toContain('(prisma.chat as any).upsert')
  })
})
