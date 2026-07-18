import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

describe('/messages phone deep link', () => {
  test('resolves strict canonical ownership read-only and never creates CRM records', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/app/messages/page.tsx'), 'utf8')
    expect(source).toContain('resolveStrictPhoneOwnership')
    expect(source).toContain("ownership.kind === 'matched'")
    expect(source).toContain('where: { contactId: ownership.contactId }')
    expect(source).not.toContain('ContactService.resolveContact')
    expect(source).not.toContain('contact.create')
    expect(source).not.toContain('contactIdentity.create')
    expect(source).not.toContain('chat.create')
    expect(source).not.toContain('driverId: typeof resolvedParams.driver')
  })
})
