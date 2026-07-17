export const CONTACT_PROFILE_FIELDS_KEY = 'messagesProfileFields'

export type ContactProfileFieldType = 'text' | 'select' | 'multi-select' | 'date'

export interface ContactProfileField {
  id: string
  label: string
  type: ContactProfileFieldType
  value: string | string[]
  options?: string[]
}

const DEFAULT_FIELDS: ContactProfileField[] = [
  { id: 'city', label: 'Город', type: 'text', value: '' },
  { id: 'start_date', label: 'Дата начала', type: 'date', value: '' },
]

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function normalizeField(value: unknown): ContactProfileField | null {
  const field = asRecord(value)
  const id = typeof field.id === 'string' ? field.id.trim() : ''
  const label = typeof field.label === 'string' ? field.label.trim() : ''
  const type = field.type
  if (!id || !label || !['text', 'select', 'multi-select', 'date'].includes(String(type))) {
    return null
  }

  const normalizedValue = Array.isArray(field.value)
    ? field.value.filter((item): item is string => typeof item === 'string')
    : typeof field.value === 'string'
      ? field.value
      : ''
  const options = Array.isArray(field.options)
    ? field.options.filter((item): item is string => typeof item === 'string')
    : undefined

  return {
    id,
    label,
    type: type as ContactProfileFieldType,
    value: normalizedValue,
    ...(options ? { options } : {}),
  }
}

export function readContactProfileFields(customFields: unknown): ContactProfileField[] {
  const root = asRecord(customFields)
  const stored = asRecord(root[CONTACT_PROFILE_FIELDS_KEY])
  const parsed = Array.isArray(stored.fields)
    ? stored.fields.map(normalizeField).filter((field): field is ContactProfileField => Boolean(field))
    : []
  const fieldsById = new Map(parsed.map(field => [field.id, field]))

  for (const defaultField of DEFAULT_FIELDS) {
    if (fieldsById.has(defaultField.id)) continue
    const legacyValue = typeof root[defaultField.id] === 'string' ? root[defaultField.id] as string : ''
    fieldsById.set(defaultField.id, { ...defaultField, value: legacyValue })
  }

  return Array.from(fieldsById.values())
}

export function writeContactProfileFields(
  customFields: unknown,
  fields: ContactProfileField[],
): Record<string, unknown> {
  const root = asRecord(customFields)
  return {
    ...root,
    [CONTACT_PROFILE_FIELDS_KEY]: {
      version: 1,
      fields: fields.map(field => ({
        id: field.id,
        label: field.label,
        type: field.type,
        value: field.value,
        ...(field.options ? { options: field.options } : {}),
      })),
    },
  }
}
