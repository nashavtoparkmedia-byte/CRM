export type UnifiedWhatsAppMessageType =
    | 'text'
    | 'image'
    | 'audio'
    | 'video'
    | 'sticker'
    | 'voice'
    | 'document'
    | 'system'

export function canonicalWhatsAppExternalChatId(rawJid: string): string {
    if (!rawJid) return rawJid
    if (rawJid.endsWith('@g.us')) return rawJid
    if (rawJid.endsWith('@lid')) return rawJid
    if (rawJid.endsWith('@c.us')) {
        const digits = rawJid.split('@')[0].replace(/\D/g, '')
        if (digits.length >= 10) return `whatsapp:7${digits.slice(-10)}`
    }
    return rawJid
}

export function isPrivateWhatsAppPhoneJid(rawJid: string): boolean {
    return /^\d{10,15}@c\.us$/.test(rawJid)
}

export function isOpaqueWhatsAppLid(rawJid: string): boolean {
    return rawJid.endsWith('@lid')
}

export function isWhatsAppGroupJid(rawJid: string): boolean {
    return rawJid.endsWith('@g.us')
}

export function mapWhatsAppMessageType(type: string): UnifiedWhatsAppMessageType {
    const map: Record<string, UnifiedWhatsAppMessageType> = {
        chat: 'text',
        image: 'image',
        audio: 'audio',
        video: 'video',
        sticker: 'sticker',
        voice: 'voice',
        ptt: 'voice',
        document: 'document',
    }
    return map[type] || 'text'
}

export function whatsAppContentWithFallback(body: string | undefined, type: string): string {
    if (body) return body
    const fallbacks: Record<string, string> = {
        image: '[Фото]',
        video: '[Видео]',
        voice: '[Голосовое]',
        audio: '[Аудио]',
        document: '[Документ]',
        sticker: '[Стикер]',
        ptt: '[Голосовое]',
        vcard: '[Контакт]',
    }
    return fallbacks[type] || ''
}

export async function resolveWhatsAppQuotedMessageId(message: {
    hasQuotedMsg?: boolean
    getQuotedMessage?: () => Promise<{ id?: { _serialized?: string } } | null>
    _data?: {
        quotedMsg?: { id?: { _serialized?: string } }
        quotedStanzaID?: string
    }
}): Promise<string | null> {
    const embedded = message._data?.quotedMsg?.id?._serialized
        || message._data?.quotedStanzaID
    if (embedded) return String(embedded)
    if (!message.hasQuotedMsg || !message.getQuotedMessage) return null

    try {
        const quoted = await message.getQuotedMessage()
        return quoted?.id?._serialized || null
    } catch {
        return null
    }
}
