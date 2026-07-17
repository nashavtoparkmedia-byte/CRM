import { Prisma } from '@prisma/client'

type MergePhone = { id: string; isPrimary: boolean }

type MergeContactStateInput = {
  id: string
  mainDriverId: string | null
  mainDriverSelection: string
  primaryPhoneId: string | null
  profileIds: string[]
  phones: MergePhone[]
  tags: string[]
  notes: string | null
  customFields: Prisma.JsonValue | null
}

function isJsonObject(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeCustomFields(
  target: Prisma.JsonValue | null,
  source: Prisma.JsonValue | null,
): Prisma.InputJsonValue | undefined {
  if (target === null && source === null) return undefined
  if (!isJsonObject(target)) return source === null ? undefined : source as Prisma.InputJsonValue
  if (!isJsonObject(source)) return target as Prisma.InputJsonValue
  // The survivor wins on conflicts; the source value remains in the immutable merge snapshot.
  return { ...source, ...target } as Prisma.InputJsonValue
}

function mergeNotes(target: string | null, source: string | null, sourceId: string): string | null {
  if (!source || source === target) return target
  if (!target) return source
  return `${target}\n\n[Объединено из Contact ${sourceId}]\n${source}`
}

function validMain(contact: MergeContactStateInput): string | null {
  return contact.mainDriverId && contact.profileIds.includes(contact.mainDriverId)
    ? contact.mainDriverId
    : null
}

export function planMergedContactState(input: {
  source: MergeContactStateInput
  target: MergeContactStateInput
}) {
  const targetMain = validMain(input.target)
  const sourceMain = validMain(input.source)
  const primaryPhoneId = input.target.primaryPhoneId && input.target.phones.some(phone => phone.id === input.target.primaryPhoneId)
    ? input.target.primaryPhoneId
    : input.target.phones.find(phone => phone.isPrimary)?.id
      || (input.source.primaryPhoneId && input.source.phones.some(phone => phone.id === input.source.primaryPhoneId)
        ? input.source.primaryPhoneId
        : input.source.phones.find(phone => phone.isPrimary)?.id)
      || null

  return {
    mainDriverId: targetMain || sourceMain,
    mainDriverSelection: targetMain
      ? input.target.mainDriverSelection
      : sourceMain
        ? input.source.mainDriverSelection
        : 'auto',
    primaryPhoneId,
    clearSourcePrimary: Boolean(targetMain || input.target.phones.some(phone => phone.isPrimary)),
    tags: Array.from(new Set([...input.target.tags, ...input.source.tags])).sort((a, b) => a.localeCompare(b)),
    notes: mergeNotes(input.target.notes, input.source.notes, input.source.id),
    customFields: mergeCustomFields(input.target.customFields, input.source.customFields),
  }
}
