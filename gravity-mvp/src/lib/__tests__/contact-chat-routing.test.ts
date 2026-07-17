import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

describe('Contact-first chat routing', () => {
  test('start-conversation only reuses history through the canonical main profile', () => {
    const route = source('src/app/api/contacts/start-conversation/route.ts')
    expect(route).toContain('select: { mainDriverId: true }')
    expect(route).toContain('driverId: contactProfile.mainDriverId')
    expect(route).toContain("OR: [{ contactId: null }, { contactId: contact.id }]")
    expect(route).not.toContain('prisma.driver.findFirst({ where: { phone: normalized } })')
    expect(route).toContain('CHAT_CONTACT_CONFLICT')
  })

  test('Contact channel creation accepts only an attached explicit profile or the Contact main profile', () => {
    const route = source('src/app/api/contacts/[id]/chats/route.ts')
    expect(route).toContain('let selectedProfileId = contact.mainDriverId')
    expect(route).toContain('selectedProfile.contactId !== id')
    expect(route).toContain('PROFILE_CONTACT_CONFLICT')
    expect(route).not.toContain('prisma.driver.findFirst({ where: { phone: phone.phone } })')
    expect(route).toContain('CHAT_CONTACT_CONFLICT')
  })
})
