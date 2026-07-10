import { prisma } from '@/lib/prisma'

type DriverCandidate = {
    id: string
    fullName?: string | null
    phone?: string | null
    dismissedAt?: Date | null
    lastOrderAt?: Date | null
}

export type DriverMatchResult =
    | { status: 'not_found'; candidates: [] }
    | { status: 'matched'; driver: DriverCandidate }
    | { status: 'ambiguous'; candidates: DriverCandidate[] }

function sortCandidatesForDiagnostics(candidates: DriverCandidate[]): DriverCandidate[] {
    return [...candidates].sort((a, b) => {
        const aActive = a.dismissedAt == null ? 0 : 1
        const bActive = b.dismissedAt == null ? 0 : 1
        if (aActive !== bActive) return aActive - bActive
        const aOrder = a.lastOrderAt ? new Date(a.lastOrderAt).getTime() : 0
        const bOrder = b.lastOrderAt ? new Date(b.lastOrderAt).getTime() : 0
        return bOrder - aOrder
    })
}

function logDriverMatchAmbiguous(reason: string, candidates: DriverCandidate[], context: Record<string, unknown>) {
    console.warn(JSON.stringify({
        level: 'warn',
        event: 'driver_match_ambiguous',
        reason,
        candidateCount: candidates.length,
        candidates: candidates.map(candidate => ({
            id: candidate.id,
            yandexDriverId: (candidate as any).yandexDriverId ?? null,
            dismissedAt: candidate.dismissedAt ?? null,
            lastOrderAt: candidate.lastOrderAt ?? null,
        })),
        ...context,
    }))
}

export class DriverMatchService {
    /**
     * Normalizes any phone number to a canonical 11-digit format: 79XXXXXXXXX
     * Handles: +7..., 8..., 9..., raw digits, formatted strings.
     */
    static normalizePhone(phone: string): string {
        const digits = phone.replace(/\D/g, '')
        if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
            return '7' + digits.slice(1)
        }
        if (digits.length === 10) {
            return '7' + digits
        }
        if (digits.length > 11) {
            // International: take last 10 digits and prepend 7
            return '7' + digits.slice(-10)
        }
        return digits // Return as-is if shorter
    }

    /**
     * Normalizes a phone number to exactly 10 digits (without country code)
     * for fuzzy matching against driver records.
     */
    static normalizeForSearch(phone: string): string {
        const digits = phone.replace(/\D/g, '')
        if (digits.length >= 10) {
            return digits.slice(-10)
        }
        return digits
    }

    /**
     * Attempts to match a driver by strict identifiers only.
     *
     * Telegram ID is a verified mapping. Phone is accepted only when it produces
     * exactly one driver candidate. Name is diagnostic-only and never links.
     */
    static async matchDriver(params: { telegramId?: string | bigint | null, phone?: string | null, name?: string | null }): Promise<DriverMatchResult> {
        // 1. Try by Telegram ID first (most precise)
        if (params.telegramId) {
            try {
                const driverTgList = await prisma.$queryRaw<{driverId: string}[]>`SELECT "driverId" FROM "DriverTelegram" WHERE "telegramId" = ${BigInt(params.telegramId)}`
                const uniqueDriverIds = [...new Set(driverTgList.map(row => row.driverId).filter(Boolean))]
                if (uniqueDriverIds.length === 1) {
                    const driver = await prisma.driver.findUnique({
                        where: { id: uniqueDriverIds[0] },
                        select: { id: true, fullName: true, phone: true, dismissedAt: true, lastOrderAt: true },
                    })
                    if (driver) {
                        console.log(`[DriverMatch] MATCHED by telegramId=${params.telegramId} -> driver=${driver.id}`)
                        return { status: 'matched', driver }
                    }
                } else if (uniqueDriverIds.length > 1) {
                    const candidates = sortCandidatesForDiagnostics(await prisma.driver.findMany({
                        where: { id: { in: uniqueDriverIds } },
                        select: { id: true, fullName: true, phone: true, dismissedAt: true, lastOrderAt: true },
                    }))
                    logDriverMatchAmbiguous('telegram_id_multiple_mappings', candidates, { telegramId: String(params.telegramId) })
                    return { status: 'ambiguous', candidates }
                }
            } catch (e: any) {
                console.log(`[DriverMatch] telegramId lookup failed: ${e.message}`)
            }
        }

        // 2. Try by Phone number using multiple formats
        if (params.phone) {
            const phoneDigits = params.phone.replace(/\D/g, '')
            if (phoneDigits.length >= 10) {
                const searchSuffix = this.normalizeForSearch(params.phone)
                const normalized = this.normalizePhone(params.phone)

                // Build multiple format variants for matching
                const formatted = `+7 ${searchSuffix.slice(0, 3)} ${searchSuffix.slice(3, 6)}-${searchSuffix.slice(6, 8)}-${searchSuffix.slice(8, 10)}`
                const withPlus7 = `+${normalized}`
                const raw11 = normalized
                const raw10 = searchSuffix
                const with8 = '8' + searchSuffix

                console.log(`[DriverMatch] Phone search: formatted="${formatted}", +7="${withPlus7}", raw11="${raw11}", suffix="${raw10}"`)

                const drivers = await prisma.$queryRaw<DriverCandidate[]>`
                    SELECT id, "fullName", phone, "dismissedAt", "lastOrderAt" FROM "Driver"
                    WHERE phone = ${formatted}
                       OR phone = ${withPlus7}
                       OR phone = ${raw11}
                       OR phone = ${with8}
                       OR phone LIKE ${'%' + searchSuffix}
                `;
                const uniqueById = Array.from(new Map(drivers.filter(d => d.id).map(d => [d.id, d])).values())
                if (uniqueById.length === 1) {
                    console.log(`[DriverMatch] MATCHED by phone -> driver=${uniqueById[0].id}`)
                    return { status: 'matched', driver: uniqueById[0] }
                } else if (uniqueById.length > 1) {
                    const candidates = sortCandidatesForDiagnostics(uniqueById)
                    logDriverMatchAmbiguous('phone_multiple_drivers', candidates, { phoneSuffix: searchSuffix })
                    return { status: 'ambiguous', candidates }
                } else {
                    console.log(`[DriverMatch] No driver found by phone variants`)
                }
            }
        }

        // 3. Name is diagnostic-only. It is not proof of identity and must not
        // auto-link a chat/contact to a driver.
        if (params.name) {
            const searchName = params.name.trim();
            console.log(`[DriverMatch] Name search diagnostic only: "${searchName}"`)

            if (searchName.length >= 2) {
                const candidates = await (prisma.driver as any).findMany({
                    where: {
                        OR: [
                            { fullName: { equals: searchName, mode: 'insensitive' } },
                            { fullName: { startsWith: searchName + ' ', mode: 'insensitive' } },
                            ...(searchName.length >= 3 ? [{ fullName: { contains: searchName, mode: 'insensitive' } }] : []),
                        ]
                    },
                    select: { id: true, fullName: true, phone: true, dismissedAt: true, lastOrderAt: true },
                    take: 10,
                });
                if (candidates.length > 0) {
                    console.log(JSON.stringify({
                        level: 'info',
                        event: 'driver_match_name_candidates_diagnostic',
                        queryLength: searchName.length,
                        candidateCount: candidates.length,
                        candidates: candidates.map((candidate: DriverCandidate) => ({
                            id: candidate.id,
                            dismissedAt: candidate.dismissedAt ?? null,
                            lastOrderAt: candidate.lastOrderAt ?? null,
                        })),
                    }))
                }
            }
        }

        console.log(`[DriverMatch] NO MATCH for telegramId=${params.telegramId || 'none'}, phone=${params.phone || 'none'}, name=${params.name || 'none'}`)
        return { status: 'not_found', candidates: [] }
    }

    /**
     * Backward-compatible helper for existing call sites. Only a strict
     * `matched` result is returned as a driver id; ambiguous/name-only matches
     * remain non-links.
     */
    static async findDriverId(params: { telegramId?: string | bigint | null, phone?: string | null, name?: string | null }): Promise<string | null> {
        const result = await this.matchDriver(params)
        return result.status === 'matched' ? result.driver.id : null
    }

    /**
     * Links a Chat to a driver if not already linked.
     * Returns true if successfully linked.
     */
    static async linkChatToDriver(chatId: string, params: { telegramId?: string | bigint | null, phone?: string | null, name?: string | null }): Promise<boolean> {
        const result = await this.matchDriver(params)
        if (result.status === 'matched') {
            const chat = await (prisma.chat as any).findUnique({
                where: { id: chatId },
                select: { driverId: true },
            })
            if (chat?.driverId && chat.driverId !== result.driver.id) {
                console.warn(JSON.stringify({
                    level: 'warn',
                    event: 'driver_match_existing_chat_link_conflict',
                    chatId,
                    existingDriverId: chat.driverId,
                    matchedDriverId: result.driver.id,
                }))
                return false
            }
            if (!chat?.driverId) {
                await (prisma.chat as any).update({
                    where: { id: chatId },
                    data: { driverId: result.driver.id }
                })
            }
            console.log(`[DriverMatch] LINKED chat=${chatId} -> driver=${result.driver.id}`)
            return true
        }
        if (result.status === 'ambiguous') {
            logDriverMatchAmbiguous('link_chat_to_driver_blocked', result.candidates, { chatId })
        }
        return false
    }
}
