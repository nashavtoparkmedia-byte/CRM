import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

describe('canonical Contact routing contract', () => {
  test('archived Contact API reports its canonical Contact explicitly', () => {
    const route = source('src/app/api/contacts/[id]/route.ts')
    const getRoute = route.split('export async function PATCH')[0]
    expect(getRoute).toContain('resolveCanonicalContactId(id)')
    expect(getRoute).toContain("status: 'merged_contact'")
    expect(getRoute).toContain("code: 'CONTACT_MERGED'")
    expect(getRoute).toContain('canonicalContactId: canonical.canonicalContactId')
    expect(getRoute).not.toContain("if (!contact || contact.isArchived)")
  })

  test('client follows only the explicit canonical redirect contract', () => {
    const hook = source('src/app/messages/hooks/useContact.ts')
    expect(hook).toContain("redirect.status === 'merged_contact'")
    expect(hook).toContain("redirect.code === 'CONTACT_MERGED'")
    expect(hook).toContain('fetchContactById(redirect.canonicalContactId')
    expect(hook).toContain('CONTACT_MERGE_REDIRECT_LOOP')
  })

  test('conversation hydration preserves Chat context while replacing merged Contact ids', () => {
    const route = source('src/app/api/messages/conversations/route.ts')
    expect(route).toContain('resolveCanonicalContactId(contactId)')
    expect(route).toContain('contactId: contact.id')
    expect(route).toContain('originalContactId:')
    expect(route).toContain('contactResolutionStatus:')
    expect(route).toContain('...contact.identities.map(identity => identity.channel)')
    expect(route).toContain('...(conversation.allChannels || [conversation.channel])')
    expect(route).not.toContain('contact.phones.length > 0')
    expect(route).not.toContain('where: { id: { in: contactIds }, isArchived: false }')
    expect(route).not.toContain('where: { displayName:')
  })
})
