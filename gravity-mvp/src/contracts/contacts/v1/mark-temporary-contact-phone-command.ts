export const MARK_TEMPORARY_CONTACT_PHONE_COMMAND_V1 = 'contacts.MarkTemporaryContactPhoneCommand.v1' as const
export const MARK_TEMPORARY_CONTACT_PHONE_RESULT_V1 = 'contacts.MarkTemporaryContactPhoneResult.v1' as const
export interface MarkTemporaryContactPhoneCommandV1 { contract: typeof MARK_TEMPORARY_CONTACT_PHONE_COMMAND_V1; contactId: string; phone: string; expiresAt: Date; label: string }
export interface MarkTemporaryContactPhoneResultV1 { contract: typeof MARK_TEMPORARY_CONTACT_PHONE_RESULT_V1; updated: number }
export function parseMarkTemporaryContactPhoneCommandV1(input: unknown): MarkTemporaryContactPhoneCommandV1 {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('command must be an object')
    const value = input as Record<string, unknown>
    if (value.contract !== MARK_TEMPORARY_CONTACT_PHONE_COMMAND_V1) throw new Error(`contract must equal ${MARK_TEMPORARY_CONTACT_PHONE_COMMAND_V1}`)
    if (typeof value.contactId !== 'string' || typeof value.phone !== 'string' || typeof value.label !== 'string') throw new Error('contactId, phone and label are required')
    if (!(value.expiresAt instanceof Date) || Number.isNaN(value.expiresAt.getTime())) throw new Error('expiresAt must be a valid Date')
    return value as unknown as MarkTemporaryContactPhoneCommandV1
}
