import { prisma } from '@/lib/prisma'
import { driverPhoneVariants, looksLikeYandexDriverId, normalizeDriverPhone } from '@/lib/botLinking'

export async function ensureCrmDriverForYandexProfile(input: {
    yandexDriverId: string
    fullName?: string | null
    phone?: string | null
}) {
    const exact = await prisma.driver.findUnique({ where: { yandexDriverId: input.yandexDriverId } })
    if (exact) return exact

    const variants = driverPhoneVariants(input.phone)
    const byPhone = variants.length
        ? await prisma.driver.findFirst({ where: { OR: variants.map(phone => ({ phone })) } })
        : null
    if (byPhone) return byPhone

    return prisma.driver.create({
        data: {
            yandexDriverId: input.yandexDriverId,
            fullName: input.fullName?.trim() || `Водитель ${input.yandexDriverId.slice(0, 8)}`,
            phone: normalizeDriverPhone(input.phone) || null,
        },
    })
}

export async function resolveMappedDriver(mapping: any) {
    if (!mapping?.driverId) return null

    const existing = await prisma.driver.findFirst({
        where: { OR: [{ id: mapping.driverId }, { yandexDriverId: mapping.driverId }] },
    })
    if (existing?.yandexDriverId) {
        if (existing.id !== mapping.driverId) {
            await prisma.driverTelegram.update({ where: { id: mapping.id }, data: { driverId: existing.id } }).catch((e: any) => {
                console.warn(`[resolveMappedDriver] could not normalize mapping ${mapping.id}: ${e.message}`)
            })
        }
        return existing
    }

    if (!looksLikeYandexDriverId(mapping.driverId) || !mapping.activeParkId) return null
    const connection = await prisma.apiConnection.findFirst({ where: { parkId: mapping.activeParkId } })
    if (!connection) return null

    const response = await fetch(
        `https://fleet-api.taxi.yandex.net/v2/parks/contractors/driver-profile?contractor_profile_id=${mapping.driverId}`,
        {
            method: 'GET',
            headers: {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'X-Park-ID': connection.parkId,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json',
            },
        },
    )
    if (!response.ok) {
        console.warn(`[resolveMappedDriver] v2 repair failed mapping=${mapping.id} status=${response.status}`)
        return null
    }

    const profile: any = await response.json()
    const fullNameParts = profile.person?.full_name || {}
    const fullName = [fullNameParts.last_name, fullNameParts.first_name, fullNameParts.middle_name].filter(Boolean).join(' ')
    const phone = profile.person?.contact_info?.phone
        || profile.person?.phone
        || profile.phone
        || (Array.isArray(profile.person?.phones) ? profile.person.phones[0] : null)
    const driver = await ensureCrmDriverForYandexProfile({
        yandexDriverId: mapping.driverId,
        fullName,
        phone,
    })
    await prisma.driverTelegram.update({
        where: { id: mapping.id },
        data: { driverId: driver.id },
    }).catch((e: any) => {
        console.warn(`[resolveMappedDriver] mapping repair conflict ${mapping.id}: ${e.message}`)
    })
    console.log(`[resolveMappedDriver] repaired TG ${mapping.telegramId} → driver ${driver.id} yandex=${driver.yandexDriverId}`)
    return driver
}
