import { describe, expect, it } from 'vitest'

import {
  CONTACT_PROFILE_FIELDS_KEY,
  readContactProfileFields,
  writeContactProfileFields,
} from '@/lib/contact-profile-fields'

describe('Contact Profile persisted fields', () => {
  it('hydrates defaults and preserves legacy values', () => {
    expect(readContactProfileFields({ city: 'Екатеринбург' })).toEqual([
      { id: 'city', label: 'Город', type: 'text', value: 'Екатеринбург' },
      { id: 'start_date', label: 'Дата начала', type: 'date', value: '' },
    ])
  })

  it('round-trips custom field configuration without dropping unrelated data', () => {
    const original = { integration: { keep: true } }
    const fields = [
      { id: 'city', label: 'Город', type: 'text' as const, value: 'Пермь' },
      {
        id: 'shift',
        label: 'Смена',
        type: 'select' as const,
        value: 'День',
        options: ['День', 'Ночь'],
      },
    ]

    const serialized = writeContactProfileFields(original, fields)

    expect(serialized.integration).toEqual({ keep: true })
    expect(serialized[CONTACT_PROFILE_FIELDS_KEY]).toEqual({ version: 1, fields })
    expect(readContactProfileFields(serialized)).toEqual([
      ...fields,
      { id: 'start_date', label: 'Дата начала', type: 'date', value: '' },
    ])
  })

  it('ignores malformed stored fields instead of rendering technical data', () => {
    const parsed = readContactProfileFields({
      [CONTACT_PROFILE_FIELDS_KEY]: {
        fields: [
          { id: '', label: 'Broken', type: 'text', value: 'x' },
          { id: 'valid', label: 'Комментарий', type: 'text', value: 'Ок' },
        ],
      },
    })

    expect(parsed.map(field => field.id)).toEqual(['valid', 'city', 'start_date'])
  })
})
