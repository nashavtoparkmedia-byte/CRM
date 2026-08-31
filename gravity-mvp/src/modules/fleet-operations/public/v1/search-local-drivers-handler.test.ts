import { describe, expect, it, vi } from 'vitest'

import {
  canonicalDriverNameKeyV1,
  createSearchLocalDriversHandlerV1,
  normalizeDriverPhoneDigitsV1,
  normalizeDriverSearchQueryV1,
  type SearchLocalDriversPersistencePortV1,
} from './search-local-drivers-handler'

function setup() {
  const port: SearchLocalDriversPersistencePortV1 = { search: vi.fn() }
  const search = vi.mocked(port.search)
  search.mockResolvedValue([])
  return { search, handler: createSearchLocalDriversHandlerV1(port) }
}

describe('Fleet-owned local driver search', () => {
  it('normalizes 8 and +7 phone representations to the same identity', () => {
    expect(normalizeDriverPhoneDigitsV1('8 (999) 123-45-67')).toBe('79991234567')
    expect(normalizeDriverPhoneDigitsV1('+7 999 123-45-67')).toBe('79991234567')
  })

  it('canonicalizes full names independently of token order', () => {
    expect(canonicalDriverNameKeyV1('Иван Иванов')).toBe(canonicalDriverNameKeyV1('Иванов   Иван'))
  })

  it('shares the same validation result with provider search callers', () => {
    expect(normalizeDriverSearchQueryV1('я'.repeat(121))).toEqual({ status: 'invalid' })
    expect(normalizeDriverSearchQueryV1('Терехин Владимир Евгеньевич')).toMatchObject({
      status: 'ok',
      query: 'Терехин Владимир Евгеньевич',
      nameTokens: ['Терехин', 'Владимир', 'Евгеньевич'],
    })
  })

  it.each([
    null,
    'а о',
    'один два три четыре пять шесть семь',
    'я'.repeat(121),
  ])('rejects underspecified or oversized query %s', async query => {
    const { search, handler } = setup()

    await expect(handler(query)).resolves.toEqual({ status: 'invalid', drivers: [] })
    expect(search).not.toHaveBeenCalled()
  })

  it('passes every full-name token independently with a fixed result bound', async () => {
    const { search, handler } = setup()

    await expect(handler('  Владимир Терехин Евгеньевич  ')).resolves.toEqual({
      status: 'ok',
      query: 'Владимир Терехин Евгеньевич',
      drivers: [],
    })
    expect(search).toHaveBeenCalledWith({
      phoneDigits: null,
      nameTokens: ['Владимир', 'Терехин', 'Евгеньевич'],
      take: 10,
    })
  })

  it('uses normalized digits without producing name predicates for a phone query', async () => {
    const { search, handler } = setup()

    await expect(handler('+7 (977) 994-71-34')).resolves.toMatchObject({ status: 'ok' })
    expect(search).toHaveBeenCalledWith({
      phoneDigits: '79779947134',
      nameTokens: [],
      take: 10,
    })
  })
})
