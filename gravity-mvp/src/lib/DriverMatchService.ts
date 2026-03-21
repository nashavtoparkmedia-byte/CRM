import { prisma } from '@/lib/prisma'

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
     * Attempts to find a driver by their Telegram ID or Phone number or Name.
     * Returns the driver ID if found, otherwise null.
     */
    static async findDriverId(params: { telegramId?: string | bigint, phone?: string, name?: string }): Promise<string | null> {
        // 1. Try by Telegram ID first (most precise)
        if (params.telegramId) {
            try {
                const driverTgList = await prisma.$queryRaw<{driverId: string}[]>`SELECT "driverId" FROM "DriverTelegram" WHERE "telegramId" = ${BigInt(params.telegramId)} LIMIT 1`
                if (driverTgList.length > 0 && driverTgList[0].driverId) {
                    console.log(`[DriverMatch] FOUND by telegramId=${params.telegramId} -> driver=${driverTgList[0].driverId}`)
                    return driverTgList[0].driverId
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

                const drivers = await prisma.$queryRaw<{id: string}[]>`
                    SELECT id FROM "Driver" 
                    WHERE phone = ${formatted} 
                       OR phone = ${withPlus7}
                       OR phone = ${raw11}
                       OR phone = ${with8}
                       OR phone LIKE ${'%' + searchSuffix}
                    LIMIT 1
                `;
                if (drivers.length > 0 && drivers[0].id) {
                    console.log(`[DriverMatch] FOUND by phone -> driver=${drivers[0].id}`)
                    return drivers[0].id
                } else {
                    console.log(`[DriverMatch] No driver found by phone variants`)
                }
            }
        }

        // 3. Try by Name (fuzzy) - fallback for MAX/other scrapers
        if (params.name) {
            const searchName = params.name.trim();
            console.log(`[DriverMatch] Name search: "${searchName}"`)
            
            if (searchName.length < 3) {
                console.log(`[DriverMatch] Name too short (${searchName.length}). Requirements exact match only.`);
                const exactDrivers = await (prisma.driver as any).findMany({
                    where: {
                        OR: [
                            { fullName: { equals: searchName, mode: 'insensitive' } },
                            { fullName: { startsWith: searchName + ' ', mode: 'insensitive' } } // e.g. "Н" matches "Н ..."
                        ]
                    },
                    take: 10
                });
                
                if (exactDrivers.length === 1) {
                    console.log(`[DriverMatch] FOUND short name exact: ${exactDrivers[0].fullName} -> driver=${exactDrivers[0].id}`);
                    return exactDrivers[0].id;
                }
                return null;
            }

            const drivers = await (prisma.driver as any).findMany({
                where: { 
                    fullName: { contains: searchName, mode: 'insensitive' }
                },
                take: 10
            })
            
            console.log(`[DriverMatch] Found ${drivers.length} candidates for name "${searchName}"`)
            
            if (drivers.length === 1) {
                console.log(`[DriverMatch] FOUND by name (single match): ${drivers[0].fullName} -> driver=${drivers[0].id}`)
                return drivers[0].id
            } else if (drivers.length > 1) {
                const exactMatch = drivers.find((d: any) => 
                    d.fullName.toLowerCase() === searchName.toLowerCase() || 
                    d.name?.toLowerCase() === searchName.toLowerCase()
                );
                
                if (exactMatch) {
                    console.log(`[DriverMatch] FOUND by name (exact among ${drivers.length}): ${exactMatch.fullName} -> driver=${exactMatch.id}`)
                    return exactMatch.id;
                }
                
                console.log(`[DriverMatch] Ambiguous name match for "${searchName}" (${drivers.length} candidates), skipping auto-link.`)
            }
        }

        console.log(`[DriverMatch] NO MATCH for telegramId=${params.telegramId || 'none'}, phone=${params.phone || 'none'}, name=${params.name || 'none'}`)
        return null
    }

    /**
     * Links a Chat to a driver if not already linked.
     * Returns true if successfully linked.
     */
    static async linkChatToDriver(chatId: string, params: { telegramId?: string | bigint, phone?: string, name?: string }): Promise<boolean> {
        const driverId = await this.findDriverId(params)
        if (driverId) {
            await (prisma.chat as any).update({
                where: { id: chatId },
                data: { driverId }
            })
            console.log(`[DriverMatch] LINKED chat=${chatId} -> driver=${driverId}`)
            return true
        }
        return false
    }
}
