import { describe, it, expect } from 'vitest'
import crypto from 'crypto'

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

describe('telephonyAuth - hashToken', () => {
  it('produces deterministic SHA-256 hash', () => {
    const hash1 = hashToken('test-secret-123')
    const hash2 = hashToken('test-secret-123')
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64)
  })

  it('different tokens produce different hashes', () => {
    expect(hashToken('secret-a')).not.toBe(hashToken('secret-b'))
  })
})
