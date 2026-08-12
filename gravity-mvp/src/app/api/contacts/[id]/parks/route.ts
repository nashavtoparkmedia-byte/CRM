import { NextRequest, NextResponse } from 'next/server'
import { getContactParkCheckContextV1, persistContactParkCheckResultV1 } from '@/modules/contacts/public/v1'
import {
    getParkLinkedDriverPhoneV1,
    normalizeParkPhoneDigitsV1,
    searchYandexParksByPhonesV1,
    upsertParkMatchedDriverV1,
} from '@/modules/fleet-operations/public/v1'
import { linkParkDriverToContactV1 } from '@/modules/platform-shell/internal/contact-park-merge-orchestrator'

type DriverLinkResult = {
    status: 'not_found' | 'ambiguous' | 'linked' | 'already_linked' | 'merged' | 'error'
    contactId: string | null
    driverId: string | null
    displayName: string | null
    message: string | null
}

/** Check exact active contact phones across configured Fleet parks. */
export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params
    const context = await getContactParkCheckContextV1(id)
    if (!context) {
        return NextResponse.json({ error: 'CONTACT_NOT_FOUND', message: 'Контакт не найден' }, { status: 404 })
    }

    const linkedDriverPhone = await getParkLinkedDriverPhoneV1(context.yandexDriverId)
    const normalizedPhones = [...new Set([...context.activePhones, linkedDriverPhone || '']
        .map(normalizeParkPhoneDigitsV1)
        .filter(value => value.length >= 10))]
    const phones = normalizedPhones.map(value => `+${value}`)
    if (phones.length === 0) {
        return NextResponse.json({ error: 'PHONE_REQUIRED', message: 'В профиле нет телефона для проверки' }, { status: 422 })
    }

    const search = await searchYandexParksByPhonesV1(phones)
    if (search.checkedParks === 0) {
        return NextResponse.json({ error: 'NO_PARKS', message: 'Не настроены подключения к паркам' }, { status: 503 })
    }

    const uniqueProfiles = new Map<string, typeof search.results[number]['profiles'][number]>()
    for (const park of search.results) {
        for (const profile of park.profiles) uniqueProfiles.set(profile.id, profile)
    }

    let driverLink: DriverLinkResult
    if (uniqueProfiles.size === 0) {
        driverLink = { status: 'not_found', contactId: id, driverId: null, displayName: null, message: null }
    } else if (uniqueProfiles.size > 1) {
        driverLink = {
            status: 'ambiguous',
            contactId: id,
            driverId: null,
            displayName: null,
            message: 'По телефонам найдены разные водители. Автоматическая привязка отменена.',
        }
    } else {
        const profile = uniqueProfiles.values().next().value!
        const matchedPhone = profile.matchedPhones[0] || profile.phones[0] || null
        try {
            const driver = await upsertParkMatchedDriverV1({
                yandexDriverId: profile.id,
                fullName: profile.fullName,
                phone: matchedPhone ? `+${normalizeParkPhoneDigitsV1(matchedPhone)}` : null,
            })
            const merge = await linkParkDriverToContactV1(id, driver.id)
            if (merge.status !== 'linked' && merge.status !== 'already_linked' && merge.status !== 'merged') {
                throw new Error(`Unexpected driver merge status: ${merge.status}`)
            }
            driverLink = {
                status: merge.status,
                contactId: merge.status === 'merged' ? merge.survivorId : merge.contactId,
                driverId: driver.id,
                displayName: driver.fullName,
                message: null,
            }
        } catch (error) {
            console.error('[contact-parks] Driver link failed:', error)
            driverLink = {
                status: 'error',
                contactId: id,
                driverId: null,
                displayName: profile.fullName,
                message: 'Водитель найден, но карточку не удалось сделать водительской',
            }
        }
    }

    const parkCheckResult = {
        checkedAt: new Date().toISOString(),
        checkedPhones: phones,
        checkedParks: search.checkedParks,
        foundProfiles: search.results.reduce((total, park) => total + park.profiles.length, 0),
        results: search.results,
        errors: search.errors,
        driverLink,
    }
    await persistContactParkCheckResultV1(driverLink.contactId || id, parkCheckResult)
        .catch(error => console.error('[contact-parks] Failed to persist park check result:', error))

    return NextResponse.json(parkCheckResult)
}
