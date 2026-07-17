import { describe, expect, it } from 'vitest'
import { classifyProviderPhoneOwners } from '@/lib/ContactService'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('ContactService provider phone ownership', () => {
  it('returns not_found for zero owners', () => {
    expect(classifyProviderPhoneOwners([])).toEqual({ kind: 'not_found' })
  })

  it('returns the sole owner for one Contact', () => {
    expect(classifyProviderPhoneOwners([{ contactId: 'contact-a' }])).toEqual({
      kind: 'matched',
      contactId: 'contact-a',
    })
  })

  it('deduplicates several phone rows owned by the same Contact', () => {
    expect(classifyProviderPhoneOwners([
      { contactId: 'contact-a' },
      { contactId: 'contact-a' },
    ])).toEqual({
      kind: 'matched',
      contactId: 'contact-a',
    })
  })

  it('never selects a random owner when two Contacts own the phone', () => {
    expect(classifyProviderPhoneOwners([
      { contactId: 'contact-b' },
      { contactId: 'contact-a' },
      { contactId: 'contact-b' },
    ])).toEqual({
      kind: 'ambiguous',
      contactIds: ['contact-a', 'contact-b'],
    })
  })

  it('blocks automatic ownership when the only raw owner is archived', () => {
    expect(classifyProviderPhoneOwners([
      { contactId: 'archived-contact', isArchived: true },
    ])).toEqual({
      kind: 'ambiguous',
      contactIds: ['archived-contact'],
    })
  })

  it('is deterministic regardless of database row order', () => {
    const left = classifyProviderPhoneOwners([
      { contactId: 'contact-c' },
      { contactId: 'contact-a' },
    ])
    const right = classifyProviderPhoneOwners([
      { contactId: 'contact-a' },
      { contactId: 'contact-c' },
    ])
    expect(left).toEqual(right)
  })

  it('serializes provider and call phone ownership decisions with the shared advisory lock', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/ContactService.ts'), 'utf8')
    expect(source).toContain('pg_advisory_xact_lock')
    expect(source).toContain('contact-phone:${normalized}')
    expect(source).toContain('const existing = await tx.contactPhone.findMany')
    expect(source).toContain('Call phone ownership is ambiguous')
  })

  it('does not let the call listener select the first Contact or Driver by phone', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/freeswitch/EslClient.ts'), 'utf8')
    expect(source).toContain('const phoneRecords = await prisma.contactPhone.findMany')
    expect(source).toContain("'call_contact_phone_ambiguous'")
    expect(source).toContain("'call_driver_phone_ambiguous'")
    expect(source).toContain("phoneOwnership.kind !== 'ambiguous'")
    expect(source).not.toContain('prisma.contactPhone.findFirst')
    expect(source).not.toContain('prisma.driver.findFirst')
  })

  it('routes a newly linked channel chat through the canonical main DriverProfile first', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/ContactService.ts'), 'utf8')
    expect(source).toContain('select: { mainDriverId: true, yandexDriverId: true }')
    expect(source).toContain('where: { id: contact.mainDriverId }')
    expect(source.indexOf('contact?.mainDriverId')).toBeLessThan(source.indexOf('contact?.yandexDriverId'))
  })

  it('creates a manual provider identity only for the explicitly selected Contact', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/ContactService.ts'), 'utf8')
    expect(source).toContain('static async ensureIdentityForContact')
    expect(source).toContain('CONTACT_IDENTITY_CONFLICT')
    expect(source).toContain('where: { channel_externalId: { channel, externalId } }')
    expect(source).not.toContain('findFirst({ where: { fullName')
  })
})
