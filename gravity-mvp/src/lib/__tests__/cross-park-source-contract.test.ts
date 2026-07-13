import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

describe('cross-park person ownership source contracts', () => {
  test('phone-only DriverProfile attachment is suggestion-only unless stable person key is present', () => {
    const source = read('src/lib/driver-profiles/multi-park.ts')
    expect(source).toContain("action: 'suggested_profiles'")
    expect(source).toContain('phone is not proof of cross-park person ownership')
    expect(source).toContain('personResolutionBasis')
    expect(source).toContain('STABLE_PROVIDER_PERSON_KEY')
    expect(source).toContain('externalPersonKey: personKeys[0]')
  })

  test('cross-park person resolver separates park identity from person ownership ambiguity', () => {
    const source = read('src/lib/driver-profiles/person-resolution.ts')
    expect(source).toContain('person_ownership_ambiguous')
    expect(source).toContain('MULTIPLE_CONTACTS_FOR_PERSON_KEY')
    expect(source).toContain('PHONE_ONLY_SUGGESTION')
    expect(source).not.toContain('PARK_IDENTITY_AMBIGUOUS')
  })
})
