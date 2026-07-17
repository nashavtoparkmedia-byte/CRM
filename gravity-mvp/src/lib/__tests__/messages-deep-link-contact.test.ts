import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

describe('/messages phone deep link', () => {
  test('resolves Contact and identity before creating a Chat', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/app/messages/page.tsx'), 'utf8')
    expect(source).toContain('ContactService.resolveContact')
    expect(source).toContain('contactId: contactResult.contact.id')
    expect(source).toContain('contactIdentityId: contactResult.identity.id')
    expect(source).not.toContain('driverId: typeof resolvedParams.driver')
  })
})
