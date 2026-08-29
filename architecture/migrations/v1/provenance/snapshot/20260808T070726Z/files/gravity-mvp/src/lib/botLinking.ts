export function buildBotApiEndpoint(baseUrl: string, path: string) {
    const base = baseUrl.replace(/\/+$/, '')
    const apiBase = base.endsWith('/api/bot') ? base : `${base}/api/bot`
    return `${apiBase}/${path.replace(/^\/+/, '')}`
}

export function normalizeDriverPhone(value?: string | null) {
    const digits = String(value || '').replace(/\D/g, '')
    if (digits.length === 10) return `7${digits}`
    if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
    return digits
}

export function canonicalDriverPhone(value?: string | null) {
    const normalized = normalizeDriverPhone(value)
    return normalized ? `+${normalized}` : null
}

export function sameDriverPhone(left?: string | null, right?: string | null) {
    const a = normalizeDriverPhone(left)
    const b = normalizeDriverPhone(right)
    return Boolean(a && b && a === b)
}

export type SelectedYandexDriverProfile = {
    driver_profile: {
        id: string
        first_name?: unknown
        last_name?: unknown
        phones: unknown[]
        work_status?: unknown
    }
}

export function selectUniqueWorkingPhoneProfile(
    profiles: unknown,
    phone: string,
): SelectedYandexDriverProfile | null {
    if (!Array.isArray(profiles)) return null
    const matches = profiles.filter((item): item is SelectedYandexDriverProfile => {
        if (!item || typeof item !== 'object') return false
        const profile = (item as { driver_profile?: Record<string, unknown> }).driver_profile
        if (!profile?.id || !Array.isArray(profile.phones)) return false
        return profile.phones.some(candidate => sameDriverPhone(String(candidate), phone))
    })
    const working = matches.filter(item => item.driver_profile.work_status !== 'fired')
    return working.length === 1 ? working[0] : null
}

export function telegramExternalChatIds(telegramId: string | number | bigint) {
    const raw = String(telegramId).replace(/^telegram:/, '')
    return [raw, `telegram:${raw}`]
}

export function driverPhoneVariants(value?: string | null) {
    const normalized = normalizeDriverPhone(value)
    if (!normalized) return []
    return [...new Set([
        normalized,
        `+${normalized}`,
        normalized.startsWith('7') ? `8${normalized.slice(1)}` : normalized,
    ])]
}

export function looksLikeYandexDriverId(value?: string | null) {
    return /^[a-f0-9]{24,}$/i.test(String(value || ''))
}

const CYRILLIC_PLATE_TO_LATIN: Record<string, string> = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H',
    'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X',
}

export function normalizeVehiclePlate(value?: string | null) {
    return String(value || '')
        .toUpperCase()
        .split('')
        .map(char => CYRILLIC_PLATE_TO_LATIN[char] || char)
        .join('')
        .replace(/[^A-Z0-9]/g, '')
}

export function hasMoreFleetCarPages(input: {
    pageIndex: number
    pageSize: number
    returned: number
    total?: number | null
}) {
    if (input.returned === 0) return false
    if (typeof input.total === 'number') {
        return input.pageIndex * input.pageSize + input.returned < input.total
    }
    return input.returned >= input.pageSize
}
