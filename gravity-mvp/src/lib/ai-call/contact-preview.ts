export type ContactPreviewStatus = 'INVALID' | 'NOT_FOUND' | 'MATCHED' | 'AMBIGUOUS'

export interface ContactPreviewResult {
    status: ContactPreviewStatus
    normalizedPhone: string | null
    contactId: string | null
    displayName: string | null
    candidateCount: number
    productionWriteAllowed: false
}

const CONTACTS = [
    { id: 'contact-preview-001', name: 'Анна Соколова', phone: '+79990000001' },
    { id: 'contact-preview-002', name: 'Иван Петров', phone: '+79990000002' },
    { id: 'contact-preview-003', name: 'Иван Петров (дубль)', phone: '+79990000002' },
]

export function normalizePreviewPhone(raw: string): string | null {
    const digits = raw.replace(/\D/g, '')
    if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
        return `+7${digits.slice(1)}`
    }
    if (digits.length === 10) return `+7${digits}`
    return null
}

export function resolvePreviewContact(phone: string): ContactPreviewResult {
    const normalizedPhone = normalizePreviewPhone(phone)
    if (!normalizedPhone) {
        return {
            status: 'INVALID',
            normalizedPhone: null,
            contactId: null,
            displayName: null,
            candidateCount: 0,
            productionWriteAllowed: false,
        }
    }
    const matches = CONTACTS.filter((contact) => contact.phone === normalizedPhone)
    if (matches.length === 0) {
        return {
            status: 'NOT_FOUND',
            normalizedPhone,
            contactId: null,
            displayName: null,
            candidateCount: 0,
            productionWriteAllowed: false,
        }
    }
    if (matches.length > 1) {
        return {
            status: 'AMBIGUOUS',
            normalizedPhone,
            contactId: null,
            displayName: null,
            candidateCount: matches.length,
            productionWriteAllowed: false,
        }
    }
    return {
        status: 'MATCHED',
        normalizedPhone,
        contactId: matches[0].id,
        displayName: matches[0].name,
        candidateCount: 1,
        productionWriteAllowed: false,
    }
}
