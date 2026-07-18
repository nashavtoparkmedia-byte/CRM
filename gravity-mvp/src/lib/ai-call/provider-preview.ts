export type PreviewProviderStatus = 'configured' | 'missing' | 'invalid' | 'temporary_error'

export interface PreviewProviderState {
    id: 'openai' | 'speechkit'
    name: string
    status: PreviewProviderStatus
    maskedValue: string | null
    message: string
}

export function maskPreviewSecret(value: string): string {
    const clean = value.trim()
    if (!clean) return ''
    return `•••• ${clean.slice(-4)}`
}

export function previewProviderState(
    id: PreviewProviderState['id'],
    status: PreviewProviderStatus,
): PreviewProviderState {
    const name = id === 'openai' ? 'OpenAI' : 'Yandex SpeechKit'
    const suffix = id === 'openai' ? 'KOIA' : 'vIyL'
    const messages: Record<PreviewProviderStatus, string> = {
        configured: 'Соединение проверено в безопасном preview.',
        missing: 'Ключ не настроен.',
        invalid: 'Ключ отклонён провайдером.',
        temporary_error: 'Временная сетевая ошибка. Повторите позже.',
    }
    return {
        id,
        name,
        status,
        maskedValue: status === 'missing' ? null : maskPreviewSecret(`preview-only-${suffix}`),
        message: messages[status],
    }
}

export function sanitizeProviderDiagnostic(input: {
    provider: string
    status: PreviewProviderStatus
    secret?: string
    error?: string
}) {
    return {
        provider: input.provider,
        status: input.status,
        secret: input.secret ? maskPreviewSecret(input.secret) : undefined,
        error: input.error?.replace(/(api[-_ ]?key|token|secret)=\S+/gi, '$1=[redacted]'),
    }
}
