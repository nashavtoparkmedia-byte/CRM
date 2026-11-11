import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { staffExtensionDirectoryV1, staffExtensionForV1 } from './staff-extension-directory'

// The authoritative user → extension assignment sits next to the softphone passwords in
// lib/sip/extensions.ts. It is read here as text, never imported, so the manual call path stays
// free of any SIP credential while the two lists cannot drift apart.
const source = readFileSync(path.resolve(__dirname, '../../../../lib/sip/extensions.ts'), 'utf8')
const authoritative = Object.fromEntries(
  [...source.matchAll(/^\s*(u\d+):\s*\{\s*extension:\s*'(\d+)'/gmu)].map(match => [match[1], match[2]]),
)

describe('staff extension directory', () => {
  it('equals the assignment in lib/sip/extensions.ts exactly', () => {
    expect(Object.keys(authoritative).length).toBeGreaterThan(0)
    expect(staffExtensionDirectoryV1()).toEqual(authoritative)
  })

  it('carries no credential', () => {
    const own = readFileSync(path.resolve(__dirname, 'staff-extension-directory.ts'), 'utf8')
    expect(own).not.toMatch(/PASSWORD|password:|process\.env/u)
    expect(own).not.toMatch(/from '@\/lib\/sip/u)
  })

  it('answers only assigned employees', () => {
    expect(staffExtensionForV1('u1')).toBe('101')
    expect(staffExtensionForV1('u999')).toBeNull()
    expect(staffExtensionForV1('__proto__')).toBeNull()
    expect(staffExtensionForV1('constructor')).toBeNull()
  })
})
